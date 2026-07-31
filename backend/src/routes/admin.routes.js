const router = require('express').Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const requireRol = require('../middleware/roles');
const { getConfig, clearCache } = require('../utils/configuracion');
const { getSucursales, clearCache: clearSucursalesCache } = require('../utils/sucursales');
const { fotoValida, textoDentroDeLimite } = require('../utils/validar');

// Panel del administrador: métricas ejecutivas. Solo admin.
router.use(auth, requireRol('admin'));

// GET /api/admin/resumen — KPIs del mes + distribución de citas + ingresos por servicio.
router.get('/resumen', async (req, res) => {
  try {
    const [[{ total_citas }]] = await pool.query(
      'SELECT COUNT(*) AS total_citas FROM citas WHERE MONTH(fecha) = MONTH(CURDATE()) AND YEAR(fecha) = YEAR(CURDATE())'
    );
    const [[{ citas_pendientes }]] = await pool.query(
      "SELECT COUNT(*) AS citas_pendientes FROM citas WHERE estado NOT IN ('entregado','cancelado')"
    );
    // Ingresos del mes unificados (mismo criterio del #3: sin doble conteo de la cita y su orden).
    const [[{ ingresos_mes }]] = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(monto),0) FROM citas
            WHERE estado='entregado' AND MONTH(fecha_fin)=MONTH(CURDATE()) AND YEAR(fecha_fin)=YEAR(CURDATE()))
       + (SELECT COALESCE(SUM(costo_mano_obra+costo_repuestos-descuento),0) FROM ordenes_trabajo
            WHERE estado='entregada' AND MONTH(fecha_entrega_real)=MONTH(CURDATE()) AND YEAR(fecha_entrega_real)=YEAR(CURDATE())
              AND id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)) AS ingresos_mes`
    );
    // Tasa de éxito del mes: entregadas / (entregadas + canceladas).
    const [[exito]] = await pool.query(
      `SELECT COALESCE(SUM(estado='entregado'),0) AS entregadas, COALESCE(SUM(estado='cancelado'),0) AS canceladas
       FROM citas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE())`
    );
    const cerradas = Number(exito.entregadas) + Number(exito.canceladas);
    const tasa_exito = cerradas ? Math.round((Number(exito.entregadas) / cerradas) * 100) : 0;

    const [top_servicios] = await pool.query(
      `SELECT COALESCE(tipo_servicio,'Sin especificar') AS servicio, COUNT(*) AS total
       FROM citas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE())
       GROUP BY servicio ORDER BY total DESC LIMIT 5`
    );

    const [[estado_citas]] = await pool.query(
      `SELECT
         COALESCE(SUM(estado='agendado'),0) AS agendadas,
         COALESCE(SUM(estado IN ('en_revision','en_mantenimiento','listo')),0) AS en_proceso,
         COALESCE(SUM(estado='entregado'),0) AS completadas,
         COALESCE(SUM(estado='cancelado'),0) AS canceladas,
         COUNT(*) AS total
       FROM citas WHERE MONTH(fecha)=MONTH(CURDATE()) AND YEAR(fecha)=YEAR(CURDATE())`
    );

    const [ingresos_por_servicio] = await pool.query(
      `SELECT COALESCE(tipo_servicio,'Sin especificar') AS servicio,
              COUNT(*) AS citas, COALESCE(SUM(monto),0) AS ingreso, COALESCE(AVG(monto),0) AS promedio
       FROM citas
       WHERE estado='entregado' AND MONTH(fecha_fin)=MONTH(CURDATE()) AND YEAR(fecha_fin)=YEAR(CURDATE())
       GROUP BY servicio ORDER BY ingreso DESC`
    );

    res.json({
      data: { total_citas, ingresos_mes, citas_pendientes, tasa_exito, top_servicios, estado_citas, ingresos_por_servicio },
    });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/admin/opiniones?estrellas=&empleado=&limit= — calificaciones REALES del cliente.
// Une citas + órdenes sin doble conteo (mismo criterio de ingresos: una orden ligada
// a una cita cuenta solo por la cita). Filtros opcionales por estrellas y mecánico.
// Sin filtros (dashboard) devuelve las últimas 40 + resumen global.
router.get('/opiniones', async (req, res) => {
  try {
    const estRaw = Number(req.query.estrellas);
    const estrellas = Number.isInteger(estRaw) && estRaw >= 1 && estRaw <= 5 ? estRaw : null;
    const empRaw = Number(req.query.empleado);
    const empleado = Number.isInteger(empRaw) && empRaw > 0 ? empRaw : null;
    const limRaw = Number(req.query.limit);
    const limit = Number.isInteger(limRaw) && limRaw > 0 ? Math.min(limRaw, 300) : 40;

    // Subconsulta base (una orden ligada a cita solo cuenta por la cita).
    const UNION = `
      SELECT c.id AS ref_id, 'cita' AS origen, c.orden_id, o.numero_orden,
             c.calificacion, c.comentario_satisfaccion AS comentario,
             COALESCE(c.fecha_fin, c.fecha) AS fecha,
             cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido,
             m.marca, m.modelo, m.placa,
             c.tecnico_id, u.nombre AS tecnico_nombre
      FROM citas c
        JOIN clientes cl ON cl.id = c.cliente_id
        LEFT JOIN motos m ON m.id = c.moto_id
        LEFT JOIN usuarios u ON u.id = c.tecnico_id
        LEFT JOIN ordenes_trabajo o ON o.id = c.orden_id
      WHERE c.calificacion IS NOT NULL AND c.calificacion > 0
      UNION ALL
      SELECT o.id AS ref_id, 'orden' AS origen, o.id AS orden_id, o.numero_orden,
             o.calificacion, o.comentario_satisfaccion AS comentario,
             COALESCE(o.fecha_entrega_real, o.fecha_ingreso) AS fecha,
             cl.nombre AS cliente_nombre, cl.apellido AS cliente_apellido,
             m.marca, m.modelo, m.placa,
             o.tecnico_id, u.nombre AS tecnico_nombre
      FROM ordenes_trabajo o
        JOIN clientes cl ON cl.id = o.cliente_id
        LEFT JOIN motos m ON m.id = o.moto_id
        LEFT JOIN usuarios u ON u.id = o.tecnico_id
      WHERE o.calificacion IS NOT NULL AND o.calificacion > 0
        AND o.id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)`;

    // Cláusula de filtro (aplica igual a la lista y al resumen).
    let filtro = '';
    const params = [];
    if (estrellas) { filtro += ' AND t.calificacion = ?'; params.push(estrellas); }
    if (empleado)  { filtro += ' AND t.tecnico_id = ?'; params.push(empleado); }

    const [opiniones] = await pool.query(
      `SELECT * FROM (${UNION}) t WHERE 1=1${filtro} ORDER BY t.fecha DESC LIMIT ?`,
      [...params, limit]
    );
    // Resumen con los mismos filtros aplicados.
    const [[agg]] = await pool.query(
      `SELECT COUNT(*) AS total, COALESCE(AVG(t.calificacion),0) AS promedio,
              COALESCE(SUM(t.calificacion <= 2),0) AS bajas
       FROM (${UNION}) t WHERE 1=1${filtro}`,
      params
    );
    // Mecánicos activos para el filtro (siempre completo, no depende de los filtros).
    const [tecnicos] = await pool.query(
      "SELECT id, nombre FROM usuarios WHERE rol = 'tecnico' AND activo = 1 ORDER BY nombre"
    );
    res.json({
      data: {
        opiniones,
        tecnicos,
        resumen: {
          total: Number(agg.total),
          promedio: Number(Number(agg.promedio).toFixed(1)),
          bajas: Number(agg.bajas),
        },
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/admin/reportes?periodo=mes|mes_pasado|anio&empleado=<tecnico_id>
// Analítica por período: KPIs, serie temporal, ingresos por servicio,
// rendimiento por mecánico y cotizaciones por recepción.
router.get('/reportes', async (req, res) => {
  try {
    const periodos = { mes: 'Este mes', mes_pasado: 'Mes pasado', anio: 'Este año' };
    const periodo = periodos[req.query.periodo] ? req.query.periodo : 'mes';
    const empRaw = Number(req.query.empleado);
    const empleado = Number.isInteger(empRaw) && empRaw > 0 ? empRaw : null;

    const COLUMNAS_RANGO = ['c.fecha', 'c.fecha_fin', 'o.fecha_entrega_real', 'o.fecha_ingreso'];
    const rango = (col) => {
      if (!COLUMNAS_RANGO.includes(col)) throw new Error(`Columna no permitida en rango: ${col}`);
      if (periodo === 'mes_pasado')
        return `${col} >= DATE_FORMAT(CURDATE() - INTERVAL 1 MONTH, '%Y-%m-01') AND ${col} < DATE_FORMAT(CURDATE(), '%Y-%m-01')`;
      if (periodo === 'anio') return `YEAR(${col}) = YEAR(CURDATE())`;
      return `MONTH(${col}) = MONTH(CURDATE()) AND YEAR(${col}) = YEAR(CURDATE())`;
    };
    // Filtro opcional por mecánico (aplica a métricas basadas en citas).
    const empCita = empleado ? ' AND c.tecnico_id = ?' : '';
    const pEmp = empleado ? [empleado] : [];

    // KPIs del período.
    const [[k]] = await pool.query(
      `SELECT COUNT(*) AS total_citas,
              COALESCE(SUM(estado='entregado'),0) AS entregadas,
              COALESCE(SUM(estado='cancelado'),0) AS canceladas,
              COALESCE(AVG(NULLIF(calificacion,0)),0) AS calificacion_promedio
       FROM citas c WHERE ${rango('c.fecha')}${empCita}`, pEmp
    );
    const cerradas = Number(k.entregadas) + Number(k.canceladas);
    const tasa_exito = cerradas ? Math.round((Number(k.entregadas) / cerradas) * 100) : 0;

    // Ticket promedio y total cobrado en citas entregadas (por fecha de entrega).
    const [[tk]] = await pool.query(
      `SELECT COALESCE(AVG(NULLIF(monto,0)),0) AS ticket_promedio
       FROM citas c WHERE estado='entregado' AND ${rango('c.fecha_fin')}${empCita}`, pEmp
    );

    // Ingresos unificados del período (mismo criterio del #3, sin doble conteo).
    const [[ing]] = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(monto),0) FROM citas c
            WHERE estado='entregado' AND ${rango('c.fecha_fin')}${empCita})
       + (SELECT COALESCE(SUM(costo_mano_obra+costo_repuestos-descuento),0) FROM ordenes_trabajo o
            WHERE estado='entregada' AND ${rango('o.fecha_entrega_real')}
              ${empleado ? 'AND o.tecnico_id = ?' : ''}
              AND o.id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)) AS ingresos`,
      empleado ? [empleado, empleado] : []
    );

    // Serie temporal: citas e ingreso por día (mes) o por mes (año), con huecos en cero.
    const bucket = periodo === 'anio' ? 'MONTH(c.fecha)' : 'DAY(c.fecha)';
    const [serieRows] = await pool.query(
      `SELECT ${bucket} AS b, COUNT(*) AS citas,
              COALESCE(SUM(CASE WHEN estado='entregado' THEN monto ELSE 0 END),0) AS ingreso
       FROM citas c WHERE ${rango('c.fecha')}${empCita}
       GROUP BY b ORDER BY b`, pEmp
    );
    const mapSerie = {};
    serieRows.forEach(r => { mapSerie[Number(r.b)] = r; });
    let serie;
    if (periodo === 'anio') {
      const meses = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
      serie = meses.map((m, i) => {
        const r = mapSerie[i + 1];
        return { label: m, citas: r ? Number(r.citas) : 0, ingreso: r ? Number(r.ingreso) : 0 };
      });
    } else {
      const [[{ dias }]] = await pool.query(
        periodo === 'mes_pasado'
          ? 'SELECT DAYOFMONTH(LAST_DAY(CURDATE() - INTERVAL 1 MONTH)) AS dias'
          : 'SELECT DAYOFMONTH(LAST_DAY(CURDATE())) AS dias'
      );
      serie = Array.from({ length: Number(dias) }, (_, i) => {
        const r = mapSerie[i + 1];
        return { label: String(i + 1), citas: r ? Number(r.citas) : 0, ingreso: r ? Number(r.ingreso) : 0 };
      });
    }

    // Ingresos por servicio (citas entregadas en el período).
    const [ingresos_por_servicio] = await pool.query(
      `SELECT COALESCE(tipo_servicio,'Sin especificar') AS servicio,
              COUNT(*) AS citas, COALESCE(SUM(monto),0) AS ingreso, COALESCE(AVG(monto),0) AS promedio
       FROM citas c WHERE estado='entregado' AND ${rango('c.fecha_fin')}${empCita}
       GROUP BY servicio ORDER BY ingreso DESC`, pEmp
    );

    // Rendimiento por mecánico: citas, entregas, ingresos, tiempo y calificación.
    const [rendimiento] = await pool.query(
      `SELECT u.id AS tecnico_id, u.nombre,
              COUNT(*) AS citas,
              COALESCE(SUM(c.estado='entregado'),0) AS entregadas,
              COALESCE(SUM(c.estado='cancelado'),0) AS canceladas,
              COALESCE(SUM(CASE WHEN c.estado='entregado' THEN c.monto ELSE 0 END),0) AS ingresos,
              AVG(CASE WHEN c.estado='entregado' AND c.fecha_inicio IS NOT NULL AND (c.fecha_listo IS NOT NULL OR c.fecha_fin IS NOT NULL)
                       THEN TIMESTAMPDIFF(MINUTE, c.fecha_inicio, COALESCE(c.fecha_listo, c.fecha_fin)) END) AS tiempo_prom_min,
              AVG(CASE WHEN c.estado='entregado' AND c.fecha_listo IS NOT NULL AND c.fecha_fin IS NOT NULL
                       THEN TIMESTAMPDIFF(MINUTE, c.fecha_listo, c.fecha_fin) END) AS tiempo_entrega_min,
              AVG(NULLIF(c.calificacion,0)) AS calificacion
       FROM citas c JOIN usuarios u ON u.id = c.tecnico_id
       WHERE ${rango('c.fecha')}${empCita}
       GROUP BY u.id, u.nombre
       ORDER BY ingresos DESC, citas DESC`, pEmp
    );

    // Cotizaciones por recepción (órdenes creadas y su aprobación por el cliente).
    const [recepcion] = await pool.query(
      `SELECT u.id, u.nombre,
              COUNT(*) AS ordenes,
              COALESCE(SUM(o.aprobacion_cliente='aprobado'),0) AS aprobadas,
              COALESCE(SUM(o.aprobacion_cliente='rechazado'),0) AS rechazadas
       FROM ordenes_trabajo o JOIN usuarios u ON u.id = o.recepcionista_id
       WHERE ${rango('o.fecha_ingreso')}
       GROUP BY u.id, u.nombre ORDER BY ordenes DESC`
    );

    res.json({
      data: {
        periodo: { clave: periodo, label: periodos[periodo] },
        kpis: {
          total_citas: Number(k.total_citas),
          entregadas: Number(k.entregadas),
          canceladas: Number(k.canceladas),
          tasa_exito,
          ingresos: Number(ing.ingresos),
          ticket_promedio: Math.round(Number(tk.ticket_promedio)),
          calificacion_promedio: Number(Number(k.calificacion_promedio).toFixed(1)),
        },
        serie,
        ingresos_por_servicio,
        rendimiento,
        recepcion,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Asignar tareas a los mecánicos (Fase C)
// ───────────────────────────────────────────────────────────
const PRIORIDADES = ['baja', 'normal', 'alta', 'urgente'];
// Topes de la tabla (titulo VARCHAR(150), detalle VARCHAR(300)). Sin comprobarlos,
// un texto más largo no se recorta: MySQL en modo estricto corta la petición con un
// 500 en vez de decir qué pasó.
const MAX_TITULO = 150;
const MAX_DETALLE = 300;

// Validación común de alta y edición de tareas. Devuelve el mensaje de error, o null.
function validarTarea({ titulo, detalle, tecnico_id }) {
  if (!tecnico_id) return 'Elegí un mecánico';
  if (!titulo || !titulo.trim()) return 'El título es requerido';
  if (!textoDentroDeLimite(titulo, MAX_TITULO)) return `El título no puede pasar de ${MAX_TITULO} caracteres`;
  if (!textoDentroDeLimite(detalle, MAX_DETALLE)) return `El detalle no puede pasar de ${MAX_DETALLE} caracteres`;
  return null;
}

// GET /api/admin/tareas?empleado= — tareas asignadas por el admin (monitoreo).
router.get('/tareas', async (req, res) => {
  try {
    const empRaw = Number(req.query.empleado);
    const empleado = Number.isInteger(empRaw) && empRaw > 0 ? empRaw : null;
    let sql =
      `SELECT t.id, t.tecnico_id, t.titulo, t.detalle, t.prioridad, t.hecha, t.vence, t.created_at,
              u.nombre AS tecnico_nombre, a.nombre AS asignado_por_nombre
       FROM tareas_mecanico t
       JOIN usuarios u ON u.id = t.tecnico_id
       LEFT JOIN usuarios a ON a.id = t.asignado_por
       WHERE t.asignado_por IS NOT NULL`;
    const params = [];
    if (empleado) { sql += ' AND t.tecnico_id = ?'; params.push(empleado); }
    sql += ` ORDER BY t.hecha ASC, FIELD(t.prioridad,'urgente','alta','normal','baja'),
             (t.vence IS NULL), t.vence ASC, t.created_at DESC`;
    const [rows] = await pool.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/admin/tareas — asignar una tarea a un mecánico.
router.post('/tareas', async (req, res) => {
  try {
    const { tecnico_id, titulo, detalle, prioridad, vence } = req.body;
    const error = validarTarea({ titulo, detalle, tecnico_id });
    if (error) return res.status(400).json({ error });
    const [[tec]] = await pool.query(
      "SELECT id FROM usuarios WHERE id = ? AND rol = 'tecnico' AND activo = 1", [tecnico_id]
    );
    if (!tec) return res.status(400).json({ error: 'Mecánico no válido' });
    const prio = PRIORIDADES.includes(prioridad) ? prioridad : 'normal';
    const [r] = await pool.query(
      'INSERT INTO tareas_mecanico (tecnico_id, titulo, detalle, prioridad, vence, asignado_por) VALUES (?, ?, ?, ?, ?, ?)',
      [tecnico_id, titulo.trim(), (detalle || '').trim() || null, prio, vence || null, req.usuario.id]
    );
    const [[nueva]] = await pool.query('SELECT * FROM tareas_mecanico WHERE id = ?', [r.insertId]);
    res.status(201).json({ data: nueva, message: 'Tarea asignada' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/admin/tareas/:id — corregir una tarea ya asignada (se puso mal el mecánico,
// cambió la prioridad, se movió la fecha). Mismas validaciones que al crearla.
// El estado `hecha` no se toca acá a propósito: eso lo marca el mecánico desde su panel.
router.put('/tareas/:id', async (req, res) => {
  try {
    const { tecnico_id, titulo, detalle, prioridad, vence } = req.body;
    const error = validarTarea({ titulo, detalle, tecnico_id });
    if (error) return res.status(400).json({ error });

    // Igual que el DELETE: el admin solo administra lo que él asignó. Las tareas que
    // el técnico se crea a sí mismo (asignado_por NULL) son suyas y no se tocan.
    const [[existente]] = await pool.query(
      'SELECT id FROM tareas_mecanico WHERE id = ? AND asignado_por IS NOT NULL', [req.params.id]
    );
    if (!existente) return res.status(404).json({ error: 'Tarea no encontrada' });

    const [[tec]] = await pool.query(
      "SELECT id FROM usuarios WHERE id = ? AND rol = 'tecnico' AND activo = 1", [tecnico_id]
    );
    if (!tec) return res.status(400).json({ error: 'Mecánico no válido' });

    const prio = PRIORIDADES.includes(prioridad) ? prioridad : 'normal';
    await pool.query(
      'UPDATE tareas_mecanico SET tecnico_id = ?, titulo = ?, detalle = ?, prioridad = ?, vence = ? WHERE id = ?',
      [tecnico_id, titulo.trim(), (detalle || '').trim() || null, prio, vence || null, req.params.id]
    );
    const [[actualizada]] = await pool.query('SELECT * FROM tareas_mecanico WHERE id = ?', [req.params.id]);
    res.json({ data: actualizada, message: 'Tarea actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/admin/tareas/:id — cancelar una tarea asignada (solo asignadas, no las propias del técnico).
router.delete('/tareas/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM tareas_mecanico WHERE id = ? AND asignado_por IS NOT NULL', [req.params.id]);
    res.json({ message: 'Tarea eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Calendario: citas del mes agrupadas por día y por mecánico.
// ───────────────────────────────────────────────────────────
// GET /api/admin/calendario?anio=&mes=  (mes 1-12)
router.get('/calendario', async (req, res) => {
  try {
    const anio = parseInt(req.query.anio, 10) || new Date().getFullYear();
    const mes = Math.min(12, Math.max(1, parseInt(req.query.mes, 10) || (new Date().getMonth() + 1)));
    const [celdas] = await pool.query(
      `SELECT DAY(ci.fecha) AS dia, ci.tecnico_id, t.nombre AS tecnico_nombre, COUNT(*) AS n
       FROM citas ci
       LEFT JOIN usuarios t ON t.id = ci.tecnico_id
       WHERE YEAR(ci.fecha) = ? AND MONTH(ci.fecha) = ? AND ci.estado != 'cancelado'
       GROUP BY dia, ci.tecnico_id, t.nombre
       ORDER BY dia`,
      [anio, mes]
    );
    const [tecnicos] = await pool.query(
      "SELECT id, nombre FROM usuarios WHERE rol = 'tecnico' AND activo = 1 ORDER BY nombre"
    );
    res.json({ data: { anio, mes, celdas, tecnicos } });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Configuración del taller (fila única).
// ───────────────────────────────────────────────────────────
// GET /api/admin/configuracion
router.get('/configuracion', async (req, res) => {
  try {
    res.json({ data: await getConfig() });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/admin/configuracion — datos del taller, horarios, capacidad y notificaciones.
router.put('/configuracion', async (req, res) => {
  try {
    const b = req.body || {};
    const num = (v, def) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n > 0 ? n : def;
    };
    // Igual que num pero admite 0 (p. ej. "sin límite" de horas para cancelar).
    const numNoNeg = (v, def) => {
      const n = parseInt(v, 10);
      return Number.isFinite(n) && n >= 0 ? n : def;
    };
    const bit = (v) => (v ? 1 : 0);
    // Normaliza horarios: solo los 7 días válidos con campos saneados.
    const horarios = Array.isArray(b.horarios)
      ? b.horarios
          .filter((h) => Number.isInteger(Number(h?.dia)) && Number(h.dia) >= 0 && Number(h.dia) <= 6)
          .map((h) => ({
            dia: Number(h.dia),
            abre: String(h.abre || '08:00').slice(0, 5),
            cierra: String(h.cierra || '17:00').slice(0, 5),
            activo: bit(h.activo),
          }))
      : null;

    await pool.query(
      `UPDATE configuracion SET
         nombre_taller = ?, telefono = ?, email = ?, direccion = ?, logo = ?,
         max_citas_hora = ?, dias_anticipacion = ?, duracion_cita_min = ?, cancelacion_horas_min = ?,
         ${horarios ? 'horarios = ?,' : ''}
         notif_estado = ?, notif_recordatorio = ?, notif_cotizacion = ?, notif_email_entrega = ?
       WHERE id = 1`,
      [
        (b.nombre_taller || '').trim() || 'MS Motos',
        (b.telefono || '').trim() || null,
        (b.email || '').trim() || null,
        (b.direccion || '').trim() || null,
        b.logo || null,
        num(b.max_citas_hora, 2),
        num(b.dias_anticipacion, 30),
        num(b.duracion_cita_min, 90),
        numNoNeg(b.cancelacion_horas_min, 2),
        ...(horarios ? [JSON.stringify(horarios)] : []),
        bit(b.notif_estado),
        bit(b.notif_recordatorio),
        bit(b.notif_cotizacion),
        bit(b.notif_email_entrega),
      ]
    );
    clearCache();
    res.json({ data: await getConfig(), message: 'Configuración guardada' });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Cuenta del administrador logueado.
// ───────────────────────────────────────────────────────────
// PUT /api/admin/cuenta — nombre y correo del propio admin.
router.put('/cuenta', async (req, res) => {
  try {
    const { nombre, email } = req.body;
    if (!nombre || !nombre.trim() || !email || !email.trim()) {
      return res.status(400).json({ error: 'Nombre y correo son requeridos' });
    }
    await pool.query('UPDATE usuarios SET nombre = ?, email = ? WHERE id = ?', [nombre.trim(), email.trim(), req.usuario.id]);
    const [[u]] = await pool.query('SELECT id, nombre, email, rol FROM usuarios WHERE id = ?', [req.usuario.id]);
    res.json({ data: u, message: 'Cuenta actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/admin/cuenta/password — cambia la contraseña verificando la actual.
router.put('/cuenta/password', async (req, res) => {
  try {
    const { actual, nueva } = req.body;
    if (!actual || !nueva) return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas' });
    if (String(nueva).length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    const [[u]] = await pool.query('SELECT password_hash FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const ok = await bcrypt.compare(String(actual), u.password_hash);
    if (!ok) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    const hash = await bcrypt.hash(String(nueva), 10);
    await pool.query('UPDATE usuarios SET password_hash = ? WHERE id = ?', [hash, req.usuario.id]);
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/cuenta/foto', async (req, res) => {
  try {
    const { foto } = req.body;
    if (!fotoValida(foto)) return res.status(400).json({ error: 'Imagen inválida' });
    await pool.query('UPDATE usuarios SET foto = ? WHERE id = ?', [foto || null, req.usuario.id]);
    res.json({ data: { foto: foto || null }, message: foto ? 'Foto actualizada' : 'Foto eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Sucursales (locales del taller). El admin las administra desde Configuración.
// ───────────────────────────────────────────────────────────
// GET /api/admin/sucursales — todas (incluidas las inactivas).
router.get('/sucursales', async (req, res) => {
  try {
    res.json({ data: await getSucursales() });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/admin/sucursales — alta de una sucursal nueva.
router.post('/sucursales', async (req, res) => {
  try {
    const nombre = (req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre de la sucursal es requerido' });
    const [[{ orden }]] = await pool.query('SELECT COALESCE(MAX(orden), 0) + 1 AS orden FROM sucursales');
    const [result] = await pool.query(
      'INSERT INTO sucursales (nombre, direccion, telefono, orden) VALUES (?, ?, ?, ?)',
      [nombre, (req.body.direccion || '').trim() || null, (req.body.telefono || '').trim() || null, orden]
    );
    clearSucursalesCache();
    const [[nueva]] = await pool.query('SELECT id, nombre, direccion, telefono, activa, orden FROM sucursales WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: nueva, message: 'Sucursal creada' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/admin/sucursales/:id — edita nombre/dirección/teléfono.
router.put('/sucursales/:id', async (req, res) => {
  try {
    const nombre = (req.body.nombre || '').trim();
    if (!nombre) return res.status(400).json({ error: 'El nombre de la sucursal es requerido' });
    const [result] = await pool.query(
      'UPDATE sucursales SET nombre = ?, direccion = ?, telefono = ? WHERE id = ?',
      [nombre, (req.body.direccion || '').trim() || null, (req.body.telefono || '').trim() || null, req.params.id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: 'Sucursal no encontrada' });
    clearSucursalesCache();
    const [[actualizada]] = await pool.query('SELECT id, nombre, direccion, telefono, activa, orden FROM sucursales WHERE id = ?', [req.params.id]);
    res.json({ data: actualizada, message: 'Sucursal actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/admin/sucursales/:id/activa — activa/desactiva (no deja cero activas).
router.patch('/sucursales/:id/activa', async (req, res) => {
  try {
    const activa = req.body.activa ? 1 : 0;
    if (!activa) {
      const [[{ activas }]] = await pool.query('SELECT COUNT(*) AS activas FROM sucursales WHERE activa = 1 AND id <> ?', [req.params.id]);
      if (!activas) return res.status(400).json({ error: 'Debe quedar al menos una sucursal activa' });
    }
    const [result] = await pool.query('UPDATE sucursales SET activa = ? WHERE id = ?', [activa, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Sucursal no encontrada' });
    clearSucursalesCache();
    res.json({ message: activa ? 'Sucursal activada' : 'Sucursal desactivada' });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
