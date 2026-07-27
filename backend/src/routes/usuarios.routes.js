const router = require('express').Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const requireRol = require('../middleware/roles');
const { emailValido } = require('../utils/validar');
const { sucursalValida } = require('../utils/sucursales');

router.use(auth, requireRol('admin'));

// Normaliza el sucursal_id del body: id válido (activo) o null = "atiende ambas".
async function sucursalDelBody(valor) {
  return (await sucursalValida(valor)) ? Number(valor) : null;
}

// Roles válidos del personal (debe coincidir con el ENUM de la tabla usuarios).
const ROLES = ['recepcion', 'tecnico', 'admin'];

router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.nombre, u.email, u.telefono, u.rol, u.activo, u.created_at,
              u.sucursal_id, s.nombre AS sucursal_nombre
       FROM usuarios u
       LEFT JOIN sucursales s ON s.id = u.sucursal_id
       ORDER BY u.nombre`
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

router.post('/', async (req, res) => {
  try {
    const { nombre, email, password, rol, telefono } = req.body;
    if (!nombre || !email || !password || !rol) {
      return res.status(400).json({ error: 'nombre, email, contraseña y rol son requeridos' });
    }
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    // Piso de contraseña (igual que el portal): frena contraseñas triviales del personal.
    if (String(password).length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
    if (!ROLES.includes(rol)) return res.status(400).json({ error: 'Rol no válido' });
    const hash = await bcrypt.hash(password, 10);
    const sucursal_id = await sucursalDelBody(req.body.sucursal_id);
    const [result] = await pool.query(
      'INSERT INTO usuarios (nombre, email, password_hash, rol, telefono, sucursal_id) VALUES (?, ?, ?, ?, ?, ?)',
      [nombre, email, hash, rol, telefono || null, sucursal_id]
    );
    const [[nuevo]] = await pool.query(
      'SELECT id, nombre, email, telefono, rol, activo, created_at, sucursal_id FROM usuarios WHERE id = ?',
      [result.insertId]
    );
    res.status(201).json({ data: nuevo, message: 'Usuario creado' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'El email ya está registrado' });
    fail(res, err);
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { nombre, email, rol, telefono } = req.body;
    if (!nombre || !nombre.trim() || !email || !rol) {
      return res.status(400).json({ error: 'nombre, email y rol son requeridos' });
    }
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    if (!ROLES.includes(rol)) return res.status(400).json({ error: 'Rol no válido' });
    // Anti-lockout: el admin logueado no puede quitarse a sí mismo el rol admin.
    if (Number(req.params.id) === req.usuario.id && rol !== 'admin') {
      return res.status(400).json({ error: 'No podés cambiar tu propio rol de administrador' });
    }
    const sucursal_id = await sucursalDelBody(req.body.sucursal_id);
    await pool.query(
      'UPDATE usuarios SET nombre=?, email=?, rol=?, telefono=?, sucursal_id=? WHERE id=?',
      [nombre, email, rol, telefono ?? null, sucursal_id, req.params.id]
    );
    const [[actualizado]] = await pool.query(
      'SELECT id, nombre, email, telefono, rol, activo, created_at, sucursal_id FROM usuarios WHERE id = ?',
      [req.params.id]
    );
    res.json({ data: actualizado, message: 'Usuario actualizado' });
  } catch (err) {
    fail(res, err);
  }
});

router.patch('/:id/activo', async (req, res) => {
  try {
    const { activo } = req.body;
    // Anti-lockout: el admin logueado no puede desactivarse a sí mismo.
    if (Number(req.params.id) === req.usuario.id && !activo) {
      return res.status(400).json({ error: 'No podés desactivar tu propia cuenta' });
    }
    await pool.query('UPDATE usuarios SET activo = ? WHERE id = ?', [activo ? 1 : 0, req.params.id]);
    res.json({ message: activo ? 'Usuario activado' : 'Usuario desactivado' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /:id/sucursal — cambia el local de un empleado desde la lista (null = Ambas).
router.patch('/:id/sucursal', async (req, res) => {
  try {
    const sucursal_id = await sucursalDelBody(req.body.sucursal_id);
    const [result] = await pool.query('UPDATE usuarios SET sucursal_id = ? WHERE id = ?', [sucursal_id, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ data: { sucursal_id }, message: 'Sucursal actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /:id — elimina un empleado DEFINITIVAMENTE, tenga historial o no.
//
// `usuarios` está referenciado por 10 claves foráneas, así que un DELETE pelado
// fallaría. Se limpia en una transacción, distinguiendo dos casos:
//
//   • Rastro PERSONAL del empleado (columnas NOT NULL, no se pueden desvincular):
//     sus avances escritos, sus tareas y sus mensajes internos → se BORRAN.
//   • Trabajo del TALLER (columnas que aceptan NULL): citas, órdenes, garantías,
//     tareas que él asignó y cortesías aplicadas → se DESVINCULAN (quedan sin
//     responsable). No se borran: son el historial del negocio y la facturación
//     del cliente; eliminarlos destruiría datos contables ajenos al empleado.
router.delete('/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const id = Number(req.params.id);
    // Anti-lockout: nadie se borra a sí mismo (quedaría sin acceso al sistema).
    if (id === req.usuario.id) {
      conn.release();
      return res.status(400).json({ error: 'No podés eliminar tu propia cuenta' });
    }
    const [[usuario]] = await conn.query('SELECT id FROM usuarios WHERE id = ?', [id]);
    if (!usuario) {
      conn.release();
      return res.status(404).json({ error: 'Usuario no encontrado' });
    }

    await conn.beginTransaction();

    // 1) Rastro personal (NOT NULL → hay que borrar la fila).
    await conn.query('DELETE FROM orden_avances WHERE usuario_id = ?', [id]);
    await conn.query('DELETE FROM tareas_mecanico WHERE tecnico_id = ?', [id]);
    await conn.query('DELETE FROM mensaje_lecturas WHERE usuario_id = ?', [id]);
    await conn.query('DELETE FROM mensajes_internos WHERE remitente_id = ? OR destino_id = ?', [id, id]);

    // 2) Trabajo del taller: se conserva, sin responsable.
    await conn.query('UPDATE citas SET usuario_id = NULL WHERE usuario_id = ?', [id]);
    await conn.query('UPDATE citas SET tecnico_id = NULL WHERE tecnico_id = ?', [id]);
    await conn.query('UPDATE ordenes_trabajo SET recepcionista_id = NULL WHERE recepcionista_id = ?', [id]);
    await conn.query('UPDATE ordenes_trabajo SET tecnico_id = NULL WHERE tecnico_id = ?', [id]);
    await conn.query('UPDATE garantias SET creado_por = NULL WHERE creado_por = ?', [id]);
    await conn.query('UPDATE tareas_mecanico SET asignado_por = NULL WHERE asignado_por = ?', [id]);
    await conn.query('UPDATE recompensas_canjeadas SET aplicado_por = NULL WHERE aplicado_por = ?', [id]);

    await conn.query('DELETE FROM usuarios WHERE id = ?', [id]);
    await conn.commit();
    res.json({ message: 'Empleado eliminado' });
  } catch (err) {
    await conn.rollback().catch(() => {});
    // Si quedó alguna referencia sin contemplar, el mensaje explica qué pasó
    // (y nada se borró a medias: la transacción se revirtió entera).
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.status(409).json({ error: 'No se pudo eliminar: al empleado le quedan registros asociados. Avisá para revisarlo.' });
    }
    fail(res, err);
  } finally {
    conn.release();
  }
});

module.exports = router;
