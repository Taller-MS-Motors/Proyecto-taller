const router = require('express').Router();
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const requireRol = require('../middleware/roles');
const { soloRoles } = require('../middleware/roles');
const { notificarCambioEstado, notificarMecanico } = require('../utils/notificaciones');
const { TRANSICIONES_CITA, transicionPermitida } = require('../utils/transiciones');
const { sucursalValida, tecnicoEnSucursal } = require('../utils/sucursales');
const { textoDentroDeLimite } = require('../utils/validar');

const ESTADOS = ['agendado', 'en_revision', 'en_mantenimiento', 'listo', 'entregado', 'cancelado'];
const MAX_MOTIVO = 1000;

// Quién gestiona la agenda (crear/editar citas): mostrador y administración, NO el técnico.
// El técnico solo mueve el estado de SUS citas (más abajo y en /api/mecanico).
const GESTIONA_AGENDA = ['recepcion', 'admin'];

// Piso de rol: recepción o superior. Sin esto, cualquier token válido (incluido el
// de un cliente del portal) podía leer la agenda y cambiar el estado de cualquier cita.
router.use(auth, requireRol('recepcion'));

router.get('/', async (req, res) => {
  try {
    const { fecha, estado, tecnico_id, sucursal_id, q } = req.query;
    let sql = `SELECT ci.*, c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono,
                      m.marca, m.modelo, m.placa,
                      u.nombre AS usuario_nombre,
                      t.nombre AS tecnico_nombre,
                      s.nombre AS sucursal_nombre
               FROM citas ci
               JOIN clientes c ON ci.cliente_id = c.id
               LEFT JOIN motos m ON ci.moto_id = m.id
               LEFT JOIN usuarios u ON ci.usuario_id = u.id
               LEFT JOIN usuarios t ON ci.tecnico_id = t.id
               LEFT JOIN sucursales s ON s.id = ci.sucursal_id
               WHERE 1=1`;
    const params = [];
    if (fecha) { sql += ' AND ci.fecha = ?'; params.push(fecha); }
    if (estado) { sql += ' AND ci.estado = ?'; params.push(estado); }
    if (tecnico_id) { sql += ' AND ci.tecnico_id = ?'; params.push(tecnico_id); }
    if (sucursal_id) { sql += ' AND ci.sucursal_id = ?'; params.push(sucursal_id); }
    if (q) {
      sql += ' AND (c.nombre LIKE ? OR c.apellido LIKE ? OR CONCAT(c.nombre, " ", c.apellido) LIKE ? OR m.placa LIKE ?)';
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY ci.fecha ASC, ci.hora ASC';
    const [rows] = await pool.query(sql, params);
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/', soloRoles(...GESTIONA_AGENDA), async (req, res) => {
  try {
    const { cliente_id, moto_id, fecha, hora, tipo_servicio, tecnico_id } = req.body;
    const motivo = String(req.body.motivo || '').trim();
    if (!cliente_id || !fecha || !hora || !motivo) {
      return res.status(400).json({ error: 'cliente_id, fecha, hora y motivo son requeridos' });
    }
    if (!textoDentroDeLimite(motivo, MAX_MOTIVO)) {
      return res.status(400).json({ error: `motivo no puede exceder ${MAX_MOTIVO} caracteres` });
    }
    const sucursal_id = (await sucursalValida(req.body.sucursal_id)) ? Number(req.body.sucursal_id) : null;
    if (!(await tecnicoEnSucursal(tecnico_id, sucursal_id))) {
      return res.status(400).json({ error: 'El mecánico no atiende en esa sucursal' });
    }
    const [result] = await pool.query(
      'INSERT INTO citas (cliente_id, moto_id, usuario_id, tecnico_id, sucursal_id, fecha, hora, motivo, tipo_servicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [cliente_id, moto_id || null, req.usuario.id, tecnico_id || null, sucursal_id, fecha, hora, motivo, tipo_servicio || null]
    );
    const [[nueva]] = await pool.query('SELECT * FROM citas WHERE id = ?', [result.insertId]);
    if (tecnico_id) {
      await notificarMecanico(tecnico_id, `Nueva cita asignada: ${tipo_servicio || motivo} el ${fecha} a las ${hora}`, req.usuario.id);
    }
    res.status(201).json({ data: nueva, message: 'Cita creada' });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const [[cita]] = await pool.query(
      `SELECT ci.*, c.nombre AS cliente_nombre, c.apellido AS cliente_apellido, c.telefono AS cliente_telefono,
              m.marca, m.modelo, m.placa
       FROM citas ci
       JOIN clientes c ON ci.cliente_id = c.id
       LEFT JOIN motos m ON ci.moto_id = m.id
       WHERE ci.id = ?`,
      [req.params.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    res.json({ data: cita });
  } catch (err) {
    fail(res, err);
  }
});

router.put('/:id', soloRoles(...GESTIONA_AGENDA), async (req, res) => {
  try {
    const { cliente_id, moto_id, fecha, hora, tipo_servicio, tecnico_id } = req.body;
    const motivo = String(req.body.motivo || '').trim();
    if (!textoDentroDeLimite(motivo, MAX_MOTIVO)) {
      return res.status(400).json({ error: `motivo no puede exceder ${MAX_MOTIVO} caracteres` });
    }
    // Solo cambia la sucursal si llega una válida (no la borra al editar otros campos).
    const sucursalNueva = (await sucursalValida(req.body.sucursal_id)) ? Number(req.body.sucursal_id) : null;
    await pool.query(
      `UPDATE citas SET cliente_id=?, moto_id=?, tecnico_id=?, fecha=?, hora=?, motivo=?, tipo_servicio=?,
         sucursal_id = COALESCE(?, sucursal_id) WHERE id=?`,
      [cliente_id, moto_id || null, tecnico_id || null, fecha, hora, motivo, tipo_servicio || null, sucursalNueva, req.params.id]
    );
    const [[actualizada]] = await pool.query('SELECT * FROM citas WHERE id = ?', [req.params.id]);
    res.json({ data: actualizada, message: 'Cita actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

router.patch('/:id/estado', async (req, res) => {
  try {
    const { estado } = req.body;
    if (!ESTADOS.includes(estado)) return res.status(400).json({ error: 'Estado inválido' });

    const [[cita]] = await pool.query('SELECT id, tecnico_id, estado FROM citas WHERE id = ?', [req.params.id]);
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });

    // Un técnico solo puede mover SUS citas; admin (y recepción) pueden cualquiera.
    if (req.usuario.rol === 'tecnico' && cita.tecnico_id !== req.usuario.id) {
      return res.status(403).json({ error: 'Solo podés cambiar el estado de tus citas asignadas' });
    }

    // Solo transiciones válidas del flujo de la cita.
    if (!transicionPermitida(TRANSICIONES_CITA, cita.estado, estado)) {
      return res.status(400).json({ error: `Transición no permitida: ${cita.estado} → ${estado}` });
    }

    await pool.query('UPDATE citas SET estado = ? WHERE id = ?', [estado, req.params.id]);
    await notificarCambioEstado(req.params.id, estado);
    res.json({ message: 'Estado de cita actualizado' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/citas/:id/asignar — el admin asigna la cita a un técnico
router.patch('/:id/asignar', requireRol('admin'), async (req, res) => {
  try {
    const { tecnico_id } = req.body;
    await pool.query('UPDATE citas SET tecnico_id = ? WHERE id = ?', [tecnico_id || null, req.params.id]);
    if (tecnico_id) {
      const [[cita]] = await pool.query("SELECT DATE_FORMAT(fecha,'%Y-%m-%d') AS fecha, TIME_FORMAT(hora,'%H:%i') AS hora, tipo_servicio, motivo FROM citas WHERE id = ?", [req.params.id]);
      if (cita) await notificarMecanico(tecnico_id, `Te asignaron una cita: ${cita.tipo_servicio || cita.motivo} el ${cita.fecha} a las ${cita.hora}`, req.usuario.id);
    }
    res.json({ message: tecnico_id ? 'Técnico asignado' : 'Asignación quitada' });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
