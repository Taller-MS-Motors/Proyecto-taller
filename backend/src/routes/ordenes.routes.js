const router = require('express').Router();
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const requireRol = require('../middleware/roles');
const { generarNumeroOrden, sincronizarCitaDesdeOrden, cerrarOrden } = require('../utils/ordenes');
const { TRANSICIONES_ORDEN, transicionPermitida } = require('../utils/transiciones');
const { sucursalValida } = require('../utils/sucursales');
const { LEIDO_POR_MI, VISTO_POR_OTRO, marcarLeidos } = require('../utils/mensajes');
const { fotoValida } = require('../utils/validar');

// Piso de rol: recepción o superior (recepción crea órdenes, el técnico las trabaja).
// Sin esto, cualquier token válido podía leer/alterar órdenes ajenas y sus costos.
router.use(auth, requireRol('recepcion'));

// GET /api/ordenes
router.get('/', async (req, res) => {
  try {
    const { estado, tecnico_id, fecha_desde, fecha_hasta } = req.query;
    let sql = `
      SELECT ot.id, ot.numero_orden, ot.estado, ot.prioridad, ot.categoria, ot.problema_reportado,
             ot.fecha_ingreso, ot.fecha_estimada_entrega,
             ot.costo_mano_obra, ot.costo_repuestos, ot.descuento,
             (ot.costo_mano_obra + ot.costo_repuestos - ot.descuento) AS total,
             c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono,
             m.marca, m.modelo, m.placa, m.color,
             u.nombre AS tecnico_nombre
      FROM ordenes_trabajo ot
      JOIN clientes c ON ot.cliente_id = c.id
      JOIN motos m ON ot.moto_id = m.id
      LEFT JOIN usuarios u ON ot.tecnico_id = u.id
      WHERE 1=1`;
    const params = [];
    if (estado) { sql += ' AND ot.estado = ?'; params.push(estado); }
    if (tecnico_id) { sql += ' AND ot.tecnico_id = ?'; params.push(tecnico_id); }
    if (fecha_desde) { sql += ' AND DATE(ot.fecha_ingreso) >= ?'; params.push(fecha_desde); }
    if (fecha_hasta) { sql += ' AND DATE(ot.fecha_ingreso) <= ?'; params.push(fecha_hasta); }
    sql += ' ORDER BY ot.fecha_ingreso DESC';
    const [rows] = await pool.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/ordenes
router.post('/', async (req, res) => {
  try {
    const {
      moto_id, cliente_id, problema_reportado, kilometraje_ingreso,
      nivel_combustible, accesorios_entregados, estado_fisico,
      prioridad, categoria, fecha_estimada_entrega,
    } = req.body;

    if (!moto_id || !cliente_id || !problema_reportado) {
      return res.status(400).json({ error: 'moto_id, cliente_id y problema_reportado son requeridos' });
    }

    const PRIORIDADES_VALIDAS = ['baja', 'normal', 'alta', 'urgente'];
    const CATEGORIAS_VALIDAS = ['diagnostico', 'mantenimiento', 'reparacion', 'electrica', 'carroceria'];
    const COMBUSTIBLE_VALIDO = ['vacio', 'cuarto', 'medio', 'tres_cuartos', 'lleno'];
    if (prioridad && !PRIORIDADES_VALIDAS.includes(prioridad)) {
      return res.status(400).json({ error: 'Prioridad no válida' });
    }
    if (categoria && !CATEGORIAS_VALIDAS.includes(categoria)) {
      return res.status(400).json({ error: 'Categoría no válida' });
    }
    if (nivel_combustible && !COMBUSTIBLE_VALIDO.includes(nivel_combustible)) {
      return res.status(400).json({ error: 'Nivel de combustible no válido' });
    }

    const sucursal_id = (await sucursalValida(req.body.sucursal_id)) ? Number(req.body.sucursal_id) : null;

    const numero_orden = await generarNumeroOrden();

    // Orden + su tiempo inicial en una sola transacción: si algo falla, no queda
    // una orden sin etapa de recepción registrada.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query(
        `INSERT INTO ordenes_trabajo
          (numero_orden, moto_id, cliente_id, sucursal_id, recepcionista_id, problema_reportado,
           kilometraje_ingreso, nivel_combustible, accesorios_entregados, estado_fisico,
           prioridad, categoria, fecha_estimada_entrega)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          numero_orden, moto_id, cliente_id, sucursal_id, req.usuario.id, problema_reportado,
          kilometraje_ingreso || null, nivel_combustible || 'cuarto',
          accesorios_entregados || null, estado_fisico || null,
          prioridad || 'normal', categoria || 'diagnostico',
          fecha_estimada_entrega || null,
        ]
      );
      await conn.query('INSERT INTO orden_tiempos (orden_id, etapa) VALUES (?, ?)', [result.insertId, 'recepcion']);
      const [[nueva]] = await conn.query('SELECT * FROM ordenes_trabajo WHERE id = ?', [result.insertId]);
      await conn.commit();
      res.status(201).json({ data: nueva, message: 'Orden creada' });
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/ordenes/:id
router.get('/:id', async (req, res) => {
  try {
    const [[orden]] = await pool.query(
      `SELECT ot.*,
              c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono, c.email AS cliente_email,
              m.marca, m.modelo, m.placa, m.color, m.anio, m.kilometraje_actual,
              u.nombre AS tecnico_nombre,
              r.nombre AS recepcionista_nombre,
              s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion, s.telefono AS sucursal_telefono,
              (ot.costo_mano_obra + ot.costo_repuestos - ot.descuento) AS total
       FROM ordenes_trabajo ot
       JOIN clientes c ON ot.cliente_id = c.id
       JOIN motos m ON ot.moto_id = m.id
       LEFT JOIN usuarios u ON ot.tecnico_id = u.id
       LEFT JOIN usuarios r ON ot.recepcionista_id = r.id
       LEFT JOIN sucursales s ON s.id = ot.sucursal_id
       WHERE ot.id = ?`,
      [req.params.id]
    );
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json({ data: orden });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/ordenes/:id — edita diagnóstico y costos (mano de obra, repuestos, descuento).
// Toca plata: lo limita a técnico o superior (recepción no edita montos).
router.put('/:id', requireRol('tecnico'), async (req, res) => {
  try {
    const {
      diagnostico, tiempo_estimado_horas, costo_mano_obra, costo_repuestos, descuento,
      fecha_estimada_entrega, prioridad, categoria, accesorios_entregados, estado_fisico,
    } = req.body;
    await pool.query(
      `UPDATE ordenes_trabajo SET
        diagnostico=?, tiempo_estimado_horas=?, costo_mano_obra=?, costo_repuestos=?,
        descuento=?, fecha_estimada_entrega=?, prioridad=?, categoria=?,
        accesorios_entregados=?, estado_fisico=?
       WHERE id=?`,
      [
        diagnostico || null, tiempo_estimado_horas || null,
        costo_mano_obra || 0, costo_repuestos || 0, descuento || 0,
        fecha_estimada_entrega || null, prioridad || 'normal', categoria || 'diagnostico',
        accesorios_entregados || null, estado_fisico || null,
        req.params.id,
      ]
    );
    const [[actualizada]] = await pool.query('SELECT * FROM ordenes_trabajo WHERE id = ?', [req.params.id]);
    res.json({ data: actualizada, message: 'Orden actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/ordenes/:id/estado
const ESTADOS_VALIDOS = ['recepcion','diagnostico','esperando_aprobacion','esperando_repuestos','en_reparacion','lista_entrega','entregada','cancelada'];
const ETAPAS_TIEMPO = ['recepcion','diagnostico','esperando_aprobacion','esperando_repuestos','en_reparacion','lista_entrega'];

router.patch('/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body;
    if (!ESTADOS_VALIDOS.includes(estado)) {
      return res.status(400).json({ error: 'Estado inválido' });
    }

    // Solo admin puede cancelar
    if (estado === 'cancelada' && req.usuario.rol !== 'admin') {
      return res.status(403).json({ error: 'Solo admin puede cancelar una orden' });
    }

    const [[orden]] = await pool.query('SELECT estado FROM ordenes_trabajo WHERE id = ?', [req.params.id]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    // Solo transiciones válidas (evita saltos ilógicos, p. ej. entregada→diagnostico).
    if (!transicionPermitida(TRANSICIONES_ORDEN, orden.estado, estado)) {
      return res.status(400).json({ error: `Transición no permitida: ${orden.estado} → ${estado}` });
    }

    // Cerrar tiempo de etapa anterior
    if (ETAPAS_TIEMPO.includes(orden.estado)) {
      await pool.query(
        'UPDATE orden_tiempos SET fin = NOW() WHERE orden_id = ? AND etapa = ? AND fin IS NULL',
        [req.params.id, orden.estado]
      );
    }

    await pool.query('UPDATE ordenes_trabajo SET estado = ? WHERE id = ?', [estado, req.params.id]);

    // Abrir nuevo tiempo
    if (ETAPAS_TIEMPO.includes(estado)) {
      await pool.query('INSERT INTO orden_tiempos (orden_id, etapa) VALUES (?, ?)', [req.params.id, estado]);
    }

    // Refleja el avance en la cita vinculada (si la hay) → portal del cliente + mecánico.
    await sincronizarCitaDesdeOrden(req.params.id, estado);

    res.json({ data: { estado }, message: 'Estado actualizado' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/ordenes/:id/tecnico
router.patch('/:id/tecnico', requireRol('admin'), async (req, res) => {
  try {
    const { tecnico_id } = req.body;
    const [[orden]] = await pool.query('SELECT id FROM ordenes_trabajo WHERE id = ?', [req.params.id]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });
    if (tecnico_id) {
      const [[tec]] = await pool.query("SELECT id FROM usuarios WHERE id = ? AND rol = 'tecnico' AND activo = 1", [tecnico_id]);
      if (!tec) return res.status(400).json({ error: 'El técnico no existe o está inactivo' });
    }
    await pool.query('UPDATE ordenes_trabajo SET tecnico_id = ? WHERE id = ?', [tecnico_id || null, req.params.id]);
    res.json({ message: 'Técnico asignado' });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/ordenes/:id/avances
router.post('/:id/avances', async (req, res) => {
  try {
    const { descripcion } = req.body;
    if (!descripcion) return res.status(400).json({ error: 'Descripción requerida' });
    const [result] = await pool.query(
      'INSERT INTO orden_avances (orden_id, usuario_id, descripcion) VALUES (?, ?, ?)',
      [req.params.id, req.usuario.id, descripcion]
    );
    const [[nuevo]] = await pool.query('SELECT * FROM orden_avances WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: nuevo, message: 'Avance registrado' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/ordenes/:id/avances
router.get('/:id/avances', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT oa.*, u.nombre AS usuario_nombre, u.rol AS usuario_rol
       FROM orden_avances oa JOIN usuarios u ON oa.usuario_id = u.id
       WHERE oa.orden_id = ? ORDER BY oa.created_at ASC`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/ordenes/:id/repuestos
router.post('/:id/repuestos', async (req, res) => {
  try {
    const { nombre, cantidad, costo_unitario, estado } = req.body;
    if (!nombre) return res.status(400).json({ error: 'Nombre del repuesto requerido' });
    const [result] = await pool.query(
      'INSERT INTO orden_repuestos (orden_id, nombre, cantidad, costo_unitario, estado) VALUES (?, ?, ?, ?, ?)',
      [req.params.id, nombre, cantidad || 1, costo_unitario || 0, estado || 'pendiente']
    );
    // Actualizar costo_repuestos en la orden
    await pool.query(
      'UPDATE ordenes_trabajo SET costo_repuestos = (SELECT COALESCE(SUM(cantidad * costo_unitario), 0) FROM orden_repuestos WHERE orden_id = ?) WHERE id = ?',
      [req.params.id, req.params.id]
    );
    const [[nuevo]] = await pool.query('SELECT * FROM orden_repuestos WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: nuevo, message: 'Repuesto agregado' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/ordenes/:id/tiempos — línea de tiempo de la orden (fecha/hora de cada fase)
router.get('/:id/tiempos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT etapa, inicio, fin FROM orden_tiempos WHERE orden_id = ? ORDER BY inicio ASC',
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/ordenes/:id/repuestos
router.get('/:id/repuestos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM orden_repuestos WHERE orden_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/ordenes/:id/repuestos/:rid
router.put('/:id/repuestos/:rid', async (req, res) => {
  try {
    const { nombre, cantidad, costo_unitario, estado } = req.body;
    const [[existe]] = await pool.query('SELECT id FROM orden_repuestos WHERE id = ? AND orden_id = ?', [req.params.rid, req.params.id]);
    if (!existe) return res.status(404).json({ error: 'Repuesto no encontrado' });
    await pool.query(
      'UPDATE orden_repuestos SET nombre=?, cantidad=?, costo_unitario=?, estado=? WHERE id=? AND orden_id=?',
      [nombre, cantidad || 1, costo_unitario || 0, estado || 'pendiente', req.params.rid, req.params.id]
    );
    await pool.query(
      'UPDATE ordenes_trabajo SET costo_repuestos = (SELECT COALESCE(SUM(cantidad * costo_unitario), 0) FROM orden_repuestos WHERE orden_id = ?) WHERE id = ?',
      [req.params.id, req.params.id]
    );
    const [[actualizado]] = await pool.query('SELECT * FROM orden_repuestos WHERE id = ?', [req.params.rid]);
    res.json({ data: actualizado, message: 'Repuesto actualizado' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/ordenes/:id/repuestos/:rid
router.delete('/:id/repuestos/:rid', requireRol('admin'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM orden_repuestos WHERE id=? AND orden_id=?', [req.params.rid, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Repuesto no encontrado' });
    await pool.query(
      'UPDATE ordenes_trabajo SET costo_repuestos = (SELECT COALESCE(SUM(cantidad * costo_unitario), 0) FROM orden_repuestos WHERE orden_id = ?) WHERE id = ?',
      [req.params.id, req.params.id]
    );
    res.json({ message: 'Repuesto eliminado' });
  } catch (err) {
    fail(res, err);
  }
});

// Nota: la aprobación del presupuesto la hace el cliente desde el portal
// (POST /api/portal/ordenes/:id/aprobar|rechazar), que actualiza el ENUM
// `aprobacion_cliente` — única fuente de verdad que muestra toda la UI.

// POST /GET /api/ordenes/:id/checklist
router.post('/:id/checklist', async (req, res) => {
  try {
    const { prueba_realizada, lavado, calidad_revisada, facturacion_lista, cliente_notificado, observaciones } = req.body;
    await pool.query(
      `INSERT INTO orden_checklist (orden_id, prueba_realizada, lavado, calidad_revisada, facturacion_lista, cliente_notificado, observaciones)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE prueba_realizada=VALUES(prueba_realizada), lavado=VALUES(lavado),
         calidad_revisada=VALUES(calidad_revisada), facturacion_lista=VALUES(facturacion_lista),
         cliente_notificado=VALUES(cliente_notificado), observaciones=VALUES(observaciones)`,
      [req.params.id, prueba_realizada ? 1 : 0, lavado ? 1 : 0, calidad_revisada ? 1 : 0, facturacion_lista ? 1 : 0, cliente_notificado ? 1 : 0, observaciones || null]
    );
    res.json({ message: 'Checklist guardado' });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/:id/checklist', async (req, res) => {
  try {
    const [[checklist]] = await pool.query('SELECT * FROM orden_checklist WHERE orden_id = ?', [req.params.id]);
    res.json({ data: checklist || null });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/ordenes/:id/cerrar — cierre + fidelización (lógica compartida en utils).
router.patch('/:id/cerrar', requireRol('admin'), async (req, res) => {
  try {
    const { metodo_pago, garantia_dias, observaciones_finales } = req.body;
    const r = await cerrarOrden(req.params.id, { metodo_pago, garantia_dias, observaciones_finales });
    if (r.notFound) return res.status(404).json({ error: 'Orden no encontrada' });
    res.json({ message: 'Orden cerrada y entregada', cortesia_ganada: r.cortesiaGanada });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/ordenes/:id/fotos — guarda una foto (data URL base64) como evidencia
router.post('/:id/fotos', async (req, res) => {
  try {
    const { url, tipo, descripcion } = req.body;
    if (!url) return res.status(400).json({ error: 'Imagen requerida' });
    if (!fotoValida(url)) return res.status(400).json({ error: 'Imagen inválida' });
    const tiposValidos = ['ingreso', 'diagnostico', 'avance', 'entrega'];
    const tipoFinal = tiposValidos.includes(tipo) ? tipo : 'ingreso';
    const [result] = await pool.query(
      'INSERT INTO orden_fotos (orden_id, url, tipo, descripcion) VALUES (?, ?, ?, ?)',
      [req.params.id, url, tipoFinal, descripcion || null]
    );
    const [[nueva]] = await pool.query('SELECT * FROM orden_fotos WHERE id = ?', [result.insertId]);
    res.status(201).json({ data: nueva, message: 'Foto agregada' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/ordenes/:id/fotos
router.get('/:id/fotos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM orden_fotos WHERE orden_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/ordenes/:id/fotos/:fid
router.delete('/:id/fotos/:fid', requireRol('admin'), async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM orden_fotos WHERE id = ? AND orden_id = ?', [req.params.fid, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Foto no encontrada' });
    res.json({ message: 'Foto eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Mensajes internos vinculados a ESTA orden (contexto de orden).
// Recepción/admin ↔ el mecánico asignado hablan sobre la orden desde su detalle.
// ───────────────────────────────────────────────────────────
const SELECT_MSG_ORDEN = `
  SELECT m.id, m.mensaje, m.foto, m.orden_id, m.tipo, m.created_at,
         m.remitente_id, m.destino_rol, m.destino_id,
         ru.nombre AS remitente_nombre, ru.rol AS remitente_rol,
         du.nombre AS destino_nombre,
         ${LEIDO_POR_MI}, ${VISTO_POR_OTRO}
  FROM mensajes_internos m
  JOIN usuarios ru ON ru.id = m.remitente_id
  LEFT JOIN usuarios du ON du.id = m.destino_id`;

// GET /api/ordenes/:id/mensajes — hilo de la orden (marca leídos los míos).
router.get('/:id/mensajes', async (req, res) => {
  try {
    const yo = req.usuario.id;
    const [rows] = await pool.query(
      `${SELECT_MSG_ORDEN} WHERE m.orden_id = ? ORDER BY m.created_at ASC LIMIT 100`,
      [yo, req.params.id]
    );
    await marcarLeidos(yo, rows);
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/ordenes/:id/mensajes — enviar un mensaje sobre la orden.
// Mecánico → recepción; recepción/admin → el mecánico asignado.
router.post('/:id/mensajes', async (req, res) => {
  try {
    const { mensaje, foto } = req.body;
    if ((!mensaje || !mensaje.trim()) && !foto) return res.status(400).json({ error: 'El mensaje o una foto es requerido' });
    const [[orden]] = await pool.query('SELECT id, tecnico_id, sucursal_id FROM ordenes_trabajo WHERE id = ?', [req.params.id]);
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    let destino_rol = null, destino_id = null;
    if (req.usuario.rol === 'tecnico') {
      destino_rol = 'recepcion';
    } else if (orden.tecnico_id) {
      destino_id = orden.tecnico_id;
    } else {
      return res.status(400).json({ error: 'Asigná un mecánico a la orden para enviarle un mensaje' });
    }
    const [r] = await pool.query(
      `INSERT INTO mensajes_internos (remitente_id, destino_rol, destino_id, mensaje, foto, orden_id, sucursal_id, tipo)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'directo')`,
      [req.usuario.id, destino_rol, destino_id, (mensaje || '').trim(), foto || null, orden.id, orden.sucursal_id || null]
    );
    const [[nuevo]] = await pool.query(`${SELECT_MSG_ORDEN} WHERE m.id = ?`, [req.usuario.id, r.insertId]);
    res.status(201).json({ data: nuevo, message: 'Mensaje enviado' });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
