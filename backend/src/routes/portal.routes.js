const router = require('express').Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const authCliente = require('../middleware/auth-cliente');
const { emailValido, fotoValida } = require('../utils/validar');
const { consumir } = require('../utils/rate-limit');
const { enviarCodigoReset, enviarCodigoLogin } = require('../services/mailer');
const { antibot } = require('../utils/antibot');
const { SERVICIOS } = require('../utils/servicios');
const { getConfig, horasDisponibles } = require('../utils/configuracion');
const { getSucursales, sucursalValida, sucursalPorDefecto } = require('../utils/sucursales');
const { avanzarEstadoOrden, estadoTrasAprobacion } = require('../utils/ordenes');
const { recompensas } = require('../utils/recompensas');

// Fecha de hoy en zona del taller (offset configurable, por defecto UTC-6).
// Evita rechazar/permitir un día de más cuando el server corre en UTC.
async function hoyCR() {
  const config = await getConfig();
  const offset = Number(config.zona_horaria_offset) || -6;
  return new Date(Date.now() + offset * 60 * 60 * 1000).toISOString().slice(0, 10);
}

// fotoValida (validación de imagen: tipo + tope ~4MB) vive en utils/validar.js,
// compartida por todo el backend. El cliente ya comprime antes de enviar; el tope
// solo evita abusos.
// Normaliza el valor recibido a lo que se guarda en la BD (string o NULL).
function fotoParaGuardar(foto) {
  return foto && String(foto).length ? foto : null;
}

// Horas (decimal) que faltan para el inicio de una cita; fecha 'YYYY-MM-DD' + hora
// 'HH:MM'. Ancla en zona de Costa Rica (UTC-6). Negativo si la cita ya pasó.
function horasHastaCita(fecha, hora) {
  const hhmm = String(hora || '00:00').slice(0, 5);
  const inicio = new Date(`${fecha}T${hhmm}:00-06:00`);
  return (inicio.getTime() - Date.now()) / 3600000;
}

// Firma el JWT del cliente y arma el payload estándar.
function tokenCliente(cliente) {
  const payload = { id: cliente.id, tipo: 'cliente', nombre: cliente.nombre, apellido: cliente.apellido };
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  return { payload, token };
}

// POST /api/portal/login — login del cliente con email + contraseña
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    const [[cliente]] = await pool.query(
      'SELECT * FROM clientes WHERE email = ? AND activo = 1',
      [email]
    );
    if (!cliente || !cliente.password_hash) {
      return res.status(401).json({ error: 'Credenciales incorrectas o portal no habilitado' });
    }
    const ok = await bcrypt.compare(password, cliente.password_hash);
    if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

    const { payload, token } = tokenCliente(cliente);
    // La foto va en la respuesta (para el avatar del header) pero NO en el JWT.
    res.json({ data: { token, cliente: { ...payload, foto: cliente.foto || null } } });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/registro — auto-registro del cliente (público)
router.post('/registro', antibot(), async (req, res) => {
  try {
    const { nombre, apellido, telefono, email, cedula, password } = req.body;
    if (!nombre || !apellido || !telefono || !email || !cedula || !password) {
      return res.status(400).json({ error: 'Nombre, apellido, teléfono, correo, cédula y contraseña son requeridos' });
    }
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    // Rate-limit por correo: frena el sondeo de cuentas existentes vía el 409 de abajo.
    const limite = consumir(`registro:${String(email).trim().toLowerCase()}`, { porMinuto: 3, porHora: 20 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Demasiados intentos. Esperá ${limite.retryAfter}s e intentá de nuevo.` });
    }

    const [[existente]] = await pool.query('SELECT id, password_hash FROM clientes WHERE email = ? AND activo = 1', [email]);
    const hash = await bcrypt.hash(password, 10);
    let clienteId;

    if (existente) {
      if (existente.password_hash) {
        return res.status(409).json({ error: 'Ese correo ya tiene una cuenta. Iniciá sesión.' });
      }
      // El taller ya tenía registrado al cliente: "reclama" la cuenta definiendo su contraseña
      await pool.query(
        'UPDATE clientes SET password_hash = ?, cedula = COALESCE(cedula, ?) WHERE id = ?',
        [hash, cedula || null, existente.id]
      );
      clienteId = existente.id;
    } else {
      const [result] = await pool.query(
        'INSERT INTO clientes (nombre, apellido, telefono, email, cedula, password_hash) VALUES (?, ?, ?, ?, ?, ?)',
        [nombre, apellido, telefono, email, cedula || null, hash]
      );
      clienteId = result.insertId;
    }

    const [[cliente]] = await pool.query('SELECT id, nombre, apellido FROM clientes WHERE id = ?', [clienteId]);
    const { payload, token } = tokenCliente(cliente);
    res.status(201).json({ data: { token, cliente: payload } });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/recuperar/solicitar — envía un código de 6 dígitos al correo (público)
// Respuesta genérica siempre (anti-enumeración de cuentas).
const MSG_GENERICO = 'Si la cuenta existe, te enviamos un código a tu correo.';
router.post('/recuperar/solicitar', antibot(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });

    const clave = String(email).trim().toLowerCase();
    const limite = consumir(`reset:${clave}`, { porMinuto: 1, porHora: 5 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Esperá ${limite.retryAfter}s antes de pedir otro código.` });
    }

    const [[cliente]] = await pool.query(
      'SELECT id, nombre, apellido FROM clientes WHERE email = ? AND activo = 1 AND password_hash IS NOT NULL',
      [email]
    );

    if (cliente) {
      const codigo = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
      const codeHash = await bcrypt.hash(codigo, 10);
      // Invalida códigos previos y guarda el nuevo (vence en 10 min).
      await pool.query('UPDATE password_reset_codes SET used = 1 WHERE cliente_id = ? AND used = 0', [cliente.id]);
      await pool.query(
        'INSERT INTO password_reset_codes (cliente_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
        [cliente.id, codeHash]
      );
      await enviarCodigoReset(email, cliente.nombre, codigo);
    }

    res.json({ message: MSG_GENERICO });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/recuperar/confirmar — valida el código y define la nueva contraseña (público)
router.post('/recuperar/confirmar', async (req, res) => {
  try {
    const { email, codigo, password } = req.body;
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    if (!codigo || !password) return res.status(400).json({ error: 'Código y nueva contraseña son requeridos' });
    if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });

    const [[cliente]] = await pool.query(
      'SELECT id, nombre, apellido FROM clientes WHERE email = ? AND activo = 1 AND password_hash IS NOT NULL',
      [email]
    );
    const ERR_CODIGO = 'Código inválido o expirado';
    if (!cliente) return res.status(400).json({ error: ERR_CODIGO });

    const [[reg]] = await pool.query(
      `SELECT id, code_hash, attempts FROM password_reset_codes
       WHERE cliente_id = ? AND used = 0 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cliente.id]
    );
    if (!reg || reg.attempts >= 5) return res.status(400).json({ error: ERR_CODIGO });

    const ok = await bcrypt.compare(String(codigo).trim(), reg.code_hash);
    if (!ok) {
      await pool.query('UPDATE password_reset_codes SET attempts = attempts + 1 WHERE id = ?', [reg.id]);
      return res.status(400).json({ error: ERR_CODIGO });
    }

    const hash = await bcrypt.hash(password, 10);
    await pool.query('UPDATE clientes SET password_hash = ? WHERE id = ?', [hash, cliente.id]);
    await pool.query('UPDATE password_reset_codes SET used = 1 WHERE id = ?', [reg.id]);

    const { payload, token } = tokenCliente(cliente);
    res.json({ data: { token, cliente: payload } });
  } catch (err) {
    fail(res, err);
  }
});

// ── Ingreso sin contraseña (OTP por correo) ──────────────────────────────
// A diferencia del reset, NO exige password_hash: sirve para que cualquier cliente
// que el taller ya tenga registrado entre con un código enviado a su correo, sin
// haberse creado nunca una contraseña. Mismas garantías: hash, expiración 10 min,
// máx 5 intentos, un solo uso, respuesta genérica (anti-enumeración) y rate limit.
const MSG_OTP_GENERICO = 'Si tu correo está registrado, te enviamos un código de ingreso.';
router.post('/otp/solicitar', antibot(), async (req, res) => {
  try {
    const { email } = req.body;
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });

    const clave = String(email).trim().toLowerCase();
    const limite = consumir(`otp:${clave}`, { porMinuto: 1, porHora: 5 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Esperá ${limite.retryAfter}s antes de pedir otro código.` });
    }

    const [[cliente]] = await pool.query(
      'SELECT id, nombre FROM clientes WHERE email = ? AND activo = 1',
      [email]
    );
    if (cliente) {
      const codigo = String(Math.floor(100000 + Math.random() * 900000)); // 6 dígitos
      const codeHash = await bcrypt.hash(codigo, 10);
      // Invalida códigos previos y guarda el nuevo (vence en 10 min).
      await pool.query('UPDATE login_codes SET used = 1 WHERE cliente_id = ? AND used = 0', [cliente.id]);
      await pool.query(
        'INSERT INTO login_codes (cliente_id, code_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
        [cliente.id, codeHash]
      );
      await enviarCodigoLogin(email, cliente.nombre, codigo);
    }

    res.json({ message: MSG_OTP_GENERICO });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/otp/verificar — valida el código y entra (auto-login). Público.
router.post('/otp/verificar', async (req, res) => {
  try {
    const { email, codigo } = req.body;
    if (!emailValido(email)) return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    if (!codigo) return res.status(400).json({ error: 'El código es requerido' });

    const [[cliente]] = await pool.query(
      'SELECT id, nombre, apellido, foto FROM clientes WHERE email = ? AND activo = 1',
      [email]
    );
    const ERR_CODIGO = 'Código inválido o expirado';
    if (!cliente) return res.status(400).json({ error: ERR_CODIGO });

    const [[reg]] = await pool.query(
      `SELECT id, code_hash, attempts FROM login_codes
       WHERE cliente_id = ? AND used = 0 AND expires_at > NOW()
       ORDER BY created_at DESC LIMIT 1`,
      [cliente.id]
    );
    if (!reg || reg.attempts >= 5) return res.status(400).json({ error: ERR_CODIGO });

    const ok = await bcrypt.compare(String(codigo).trim(), reg.code_hash);
    if (!ok) {
      await pool.query('UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?', [reg.id]);
      return res.status(400).json({ error: ERR_CODIGO });
    }

    await pool.query('UPDATE login_codes SET used = 1 WHERE id = ?', [reg.id]);
    const { payload, token } = tokenCliente(cliente);
    res.json({ data: { token, cliente: { ...payload, foto: cliente.foto || null } } });
  } catch (err) {
    fail(res, err);
  }
});

// Todo lo de abajo requiere token de cliente
router.use(authCliente);

// GET /api/portal/resumen — métricas del inicio del cliente
router.get('/resumen', async (req, res) => {
  try {
    const id = req.cliente.id;
    // "Citas totales" del cliente = pendientes + completadas (NO cuenta las canceladas,
    // que para el cliente quedan eliminadas de su vista).
    const [[{ citas_totales }]] = await pool.query(
      "SELECT COUNT(*) AS citas_totales FROM citas WHERE cliente_id = ? AND estado <> 'cancelado'",
      [id]
    );
    const [[{ citas_pendientes }]] = await pool.query(
      "SELECT COUNT(*) AS citas_pendientes FROM citas WHERE cliente_id = ? AND estado NOT IN ('entregado','cancelado')",
      [id]
    );
    const [[{ motos_registradas }]] = await pool.query('SELECT COUNT(*) AS motos_registradas FROM motos WHERE cliente_id = ? AND activa = 1', [id]);
    // Total pagado y visitas completadas: una sola fuente que cruza los dos mundos
    // sin doble conteo. Cuenta citas entregadas (su monto ya = total de la orden
    // vinculada al entregar) + órdenes entregadas SIN cita (visitas sin agenda previa).
    const [[{ total_pagado }]] = await pool.query(
      `SELECT
         (SELECT COALESCE(SUM(monto), 0) FROM citas WHERE cliente_id = ? AND estado = 'entregado')
       + (SELECT COALESCE(SUM(costo_mano_obra + costo_repuestos - descuento), 0)
            FROM ordenes_trabajo
            WHERE cliente_id = ? AND estado = 'entregada'
              AND id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)) AS total_pagado`,
      [id, id]
    );
    const [[{ completadas }]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM citas WHERE cliente_id = ? AND estado = 'entregado')
       + (SELECT COUNT(*) FROM ordenes_trabajo
            WHERE cliente_id = ? AND estado = 'entregada'
              AND id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)) AS completadas`,
      [id, id]
    );
    // Cita destacada del inicio. Antes se tomaba la cita no-terminal más antigua,
    // lo que mostraba citas ya vencidas (o en curso) bajo el título "Próxima cita".
    // Ahora clasificamos y elegimos por prioridad:
    //   1) en_curso  → la moto ya está en el taller (estado != 'agendado').
    //   2) proxima   → agendada para hoy o más adelante.
    //   3) vencida   → agendada pero la fecha ya pasó y nunca se inició.
    const hoy = await hoyCR();
    const [citasAbiertas] = await pool.query(
      `SELECT ci.id, DATE_FORMAT(ci.fecha,'%Y-%m-%d') AS fecha, TIME_FORMAT(ci.hora,'%H:%i') AS hora,
              ci.tipo_servicio, ci.estado,
              m.marca, m.modelo, m.placa, t.nombre AS tecnico_nombre
       FROM citas ci
       LEFT JOIN motos m ON m.id = ci.moto_id
       LEFT JOIN usuarios t ON t.id = ci.tecnico_id
       WHERE ci.cliente_id = ? AND ci.estado NOT IN ('entregado','cancelado')
       ORDER BY ci.fecha ASC, ci.hora ASC`,
      [id]
    );

    const enCurso = citasAbiertas.filter(c => c.estado !== 'agendado');
    const futuras = citasAbiertas.filter(c => c.estado === 'agendado' && c.fecha >= hoy);
    const vencidas = citasAbiertas.filter(c => c.estado === 'agendado' && c.fecha < hoy);

    let proxima_cita = null;
    if (enCurso.length) {
      // La que entró más recientemente al taller (última por fecha/hora).
      proxima_cita = { ...enCurso[enCurso.length - 1], tipo: 'en_curso' };
    } else if (futuras.length) {
      proxima_cita = { ...futuras[0], tipo: 'proxima' };
    } else if (vencidas.length) {
      // La vencida más reciente, para invitar a reagendar.
      proxima_cita = { ...vencidas[vencidas.length - 1], tipo: 'vencida' };
    }

    res.json({
      data: {
        citas_totales, citas_pendientes, motos_registradas, total_pagado,
        recompensas: recompensas(completadas),
        proxima_cita,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// Días que se conserva una notificación ya leída antes de auto-purgarse.
const NOTIF_RETENCION_DIAS = 7;

// GET /api/portal/notificaciones — feed de avances del cliente.
// Antes de devolver, purga las que ya fueron leídas hace más de N días (la
// info real vive en el detalle de la cita; el feed no debe crecer sin límite).
router.get('/notificaciones', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM notificaciones WHERE cliente_id = ? AND leida = 1 AND created_at < (NOW() - INTERVAL ? DAY)',
      [req.cliente.id, NOTIF_RETENCION_DIAS]
    );
    const [rows] = await pool.query(
      'SELECT id, cita_id, titulo, mensaje, tipo, leida, created_at FROM notificaciones WHERE cliente_id = ? ORDER BY created_at DESC LIMIT 50',
      [req.cliente.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/notificaciones/contador — solo el # de no leídas (para el badge).
router.get('/notificaciones/contador', async (req, res) => {
  try {
    const [[{ no_leidas }]] = await pool.query(
      'SELECT COUNT(*) AS no_leidas FROM notificaciones WHERE cliente_id = ? AND leida = 0',
      [req.cliente.id]
    );
    res.json({ data: { no_leidas } });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/notificaciones/leer — marca todas como leídas
router.post('/notificaciones/leer', async (req, res) => {
  try {
    await pool.query('UPDATE notificaciones SET leida = 1 WHERE cliente_id = ? AND leida = 0', [req.cliente.id]);
    res.json({ message: 'Notificaciones leídas' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/portal/notificaciones/:id/leer — marca UNA como leída.
router.patch('/notificaciones/:id/leer', async (req, res) => {
  try {
    await pool.query(
      'UPDATE notificaciones SET leida = 1 WHERE id = ? AND cliente_id = ?',
      [req.params.id, req.cliente.id]
    );
    res.json({ message: 'Notificación leída' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/portal/notificaciones/leidas — borra todas las leídas (limpiar feed).
router.delete('/notificaciones/leidas', async (req, res) => {
  try {
    await pool.query('DELETE FROM notificaciones WHERE cliente_id = ? AND leida = 1', [req.cliente.id]);
    res.json({ message: 'Notificaciones leídas eliminadas' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/portal/notificaciones/:id — borra UNA (deslizar para eliminar).
router.delete('/notificaciones/:id', async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM notificaciones WHERE id = ? AND cliente_id = ?',
      [req.params.id, req.cliente.id]
    );
    res.json({ message: 'Notificación eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// ——— Perfil del cliente (Mi cuenta + Seguridad) ———

// GET /api/portal/perfil — datos de la cuenta del cliente autenticado
router.get('/perfil', async (req, res) => {
  try {
    const [[c]] = await pool.query(
      'SELECT id, nombre, apellido, email, telefono, cedula, foto, notif_avances, notif_recordatorios FROM clientes WHERE id = ? AND activo = 1',
      [req.cliente.id]
    );
    if (!c) return res.status(404).json({ error: 'Cuenta no encontrada' });
    res.json({ data: c });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/portal/perfil — el cliente edita sus datos de contacto
router.put('/perfil', async (req, res) => {
  try {
    const { nombre, apellido, telefono, email } = req.body;
    if (!nombre || !nombre.trim() || !apellido || !apellido.trim()) {
      return res.status(400).json({ error: 'Nombre y apellido son requeridos' });
    }
    if (!email || !emailValido(email)) {
      return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    }
    // El correo es la llave de login: no permitir chocar con otra cuenta.
    const [[dup]] = await pool.query(
      'SELECT id FROM clientes WHERE email = ? AND id <> ? AND activo = 1',
      [email.trim(), req.cliente.id]
    );
    if (dup) return res.status(409).json({ error: 'Ese correo ya está en uso por otra cuenta' });

    await pool.query(
      'UPDATE clientes SET nombre = ?, apellido = ?, telefono = ?, email = ? WHERE id = ?',
      [nombre.trim(), apellido.trim(), (telefono || '').trim() || null, email.trim(), req.cliente.id]
    );
    const [[c]] = await pool.query(
      'SELECT id, nombre, apellido, email, telefono, cedula FROM clientes WHERE id = ?',
      [req.cliente.id]
    );
    res.json({ data: c, message: 'Perfil actualizado' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/portal/perfil/notificaciones — preferencias de notificación del cliente.
router.put('/perfil/notificaciones', async (req, res) => {
  try {
    const avances = req.body.notif_avances ? 1 : 0;
    const recordatorios = req.body.notif_recordatorios ? 1 : 0;
    await pool.query(
      'UPDATE clientes SET notif_avances = ?, notif_recordatorios = ? WHERE id = ?',
      [avances, recordatorios, req.cliente.id]
    );
    res.json({ data: { notif_avances: avances, notif_recordatorios: recordatorios }, message: 'Preferencias actualizadas' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/portal/perfil/password — cambia la contraseña verificando la actual
router.put('/perfil/password', async (req, res) => {
  try {
    const { actual, nueva } = req.body;
    if (!actual || !nueva) return res.status(400).json({ error: 'Contraseña actual y nueva son requeridas' });
    if (String(nueva).length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
    const [[c]] = await pool.query('SELECT password_hash FROM clientes WHERE id = ? AND activo = 1', [req.cliente.id]);
    if (!c || !c.password_hash) return res.status(404).json({ error: 'Cuenta no encontrada' });
    const ok = await bcrypt.compare(String(actual), c.password_hash);
    if (!ok) return res.status(400).json({ error: 'La contraseña actual no es correcta' });
    const hash = await bcrypt.hash(String(nueva), 10);
    await pool.query('UPDATE clientes SET password_hash = ? WHERE id = ?', [hash, req.cliente.id]);
    res.json({ message: 'Contraseña actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/portal/perfil/foto — el cliente sube/cambia/quita su foto de perfil.
// Se envía aparte de los datos de contacto para no reenviar la imagen en cada
// edición de nombre/teléfono. `foto` = data URL base64 (o null/'' para quitarla).
router.put('/perfil/foto', async (req, res) => {
  try {
    const { foto } = req.body;
    if (!fotoValida(foto)) {
      return res.status(400).json({ error: 'La imagen no es válida o es demasiado grande.' });
    }
    const val = fotoParaGuardar(foto);
    await pool.query('UPDATE clientes SET foto = ? WHERE id = ?', [val, req.cliente.id]);
    res.json({ data: { foto: val }, message: val ? 'Foto actualizada' : 'Foto eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/portal/perfil — el cliente da de baja su propia cuenta.
// Soft-delete: NO se borran sus datos históricos (órdenes/citas) por integridad
// del taller; se desactiva el acceso al portal (activo=0 + sin contraseña).
router.delete('/perfil', async (req, res) => {
  try {
    await pool.query('UPDATE clientes SET activo = 0, password_hash = NULL WHERE id = ?', [req.cliente.id]);
    res.json({ message: 'Cuenta eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/sucursales — locales activos para el selector del formulario de citas.
router.get('/sucursales', async (req, res) => {
  try {
    const activas = await getSucursales({ soloActivas: true });
    res.json({ data: activas.map((s) => ({ id: s.id, nombre: s.nombre, direccion: s.direccion })) });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/disponibilidad?fecha=&sucursal_id= — conteo de citas por hora ese día
// y sucursal. El horario es compartido (config), pero el cupo se cuenta POR sucursal:
// una cita en un local no ocupa el cupo del otro.
router.get('/disponibilidad', async (req, res) => {
  try {
    const { fecha } = req.query;
    if (!fecha) return res.status(400).json({ error: 'Fecha requerida' });
    // Sucursal: la pedida (si es válida) o la primera activa por compatibilidad.
    let sucursalId = Number(req.query.sucursal_id);
    if (!(await sucursalValida(sucursalId))) sucursalId = await sucursalPorDefecto();
    const config = await getConfig();
    const horas = horasDisponibles(fecha, config);
    const [rows] = await pool.query(
      `SELECT TIME_FORMAT(hora, '%H:%i') AS hora, COUNT(*) AS n
       FROM citas WHERE fecha = ? AND sucursal_id = ? AND estado != 'cancelado' GROUP BY 1`,
      [fecha, sucursalId]
    );
    const ocupacion = {};
    for (const r of rows) ocupacion[r.hora] = r.n;
    res.json({ data: { horas, max: config.max_citas_hora, ocupacion, sucursal_id: sucursalId } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/proximo-libre — primer horario con cupo (para "sugerir próximo horario").
// Recorre día por día desde hoy hasta dias_anticipacion, según horarios y cupo configurados.
router.get('/proximo-libre', async (req, res) => {
  try {
    // El cupo es por sucursal: la sugerencia se calcula para la sucursal pedida.
    let sucursalId = Number(req.query.sucursal_id);
    if (!(await sucursalValida(sucursalId))) sucursalId = await sucursalPorDefecto();
    const config = await getConfig();
    const max = Number(config.max_citas_hora) || 1;
    const dias = Number(config.dias_anticipacion) || 30;
    const hoy = await hoyCR();
    const fin = new Date(`${hoy}T00:00:00Z`);
    fin.setUTCDate(fin.getUTCDate() + dias);
    const finStr = fin.toISOString().slice(0, 10);

    // Ocupación de todo el rango en una sola consulta (fecha+hora → cantidad), por sucursal.
    const [filas] = await pool.query(
      `SELECT DATE_FORMAT(fecha, '%Y-%m-%d') AS f, TIME_FORMAT(hora, '%H:%i') AS h, COUNT(*) AS n
       FROM citas WHERE fecha BETWEEN ? AND ? AND sucursal_id = ? AND estado <> 'cancelado' GROUP BY f, h`,
      [hoy, finStr, sucursalId]
    );
    const ocup = {};
    for (const r of filas) { (ocup[r.f] || (ocup[r.f] = {}))[r.h] = Number(r.n); }

    // Primer slot con cupo y que aún no haya pasado.
    const cursor = new Date(`${hoy}T00:00:00Z`);
    for (let i = 0; i <= dias; i++) {
      const fecha = cursor.toISOString().slice(0, 10);
      for (const hora of horasDisponibles(fecha, config)) {
        const usados = (ocup[fecha] || {})[hora] || 0;
        if (usados < max && horasHastaCita(fecha, hora) > 0) {
          return res.json({ data: { fecha, hora, sucursal_id: sucursalId } });
        }
      }
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    res.json({ data: null }); // no hay horarios libres en la ventana
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/ordenes — órdenes del cliente autenticado
router.get('/ordenes', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT o.id, o.numero_orden, o.estado, o.problema_reportado, o.aprobacion_cliente,
              o.fecha_ingreso, o.fecha_estimada_entrega,
              m.marca, m.modelo, m.placa
       FROM ordenes_trabajo o
       JOIN motos m ON m.id = o.moto_id
       WHERE o.cliente_id = ?
       ORDER BY o.fecha_ingreso DESC`,
      [req.cliente.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/ordenes/:id — detalle de una orden propia
router.get('/ordenes/:id', async (req, res) => {
  try {
    const [[orden]] = await pool.query(
      `SELECT o.id, o.numero_orden, o.estado, o.problema_reportado, o.diagnostico,
              o.costo_mano_obra, o.costo_repuestos, o.descuento,
              (o.costo_mano_obra + o.costo_repuestos - o.descuento) AS total,
              o.aprobacion_cliente, o.motivo_rechazo, o.tiempo_estimado_horas,
              o.fecha_ingreso, o.fecha_estimada_entrega, o.fecha_entrega_real,
              o.metodo_pago, o.garantia_dias, o.calificacion, o.comentario_satisfaccion,
              m.marca, m.modelo, m.placa, m.anio,
              u.nombre AS tecnico_nombre
       FROM ordenes_trabajo o
       JOIN motos m ON m.id = o.moto_id
       LEFT JOIN usuarios u ON u.id = o.tecnico_id
       WHERE o.id = ? AND o.cliente_id = ?`,
      [req.params.id, req.cliente.id]
    );
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada' });

    const [avances] = await pool.query(
      `SELECT a.descripcion, a.created_at, u.nombre AS usuario_nombre
       FROM orden_avances a LEFT JOIN usuarios u ON u.id = a.usuario_id
       WHERE a.orden_id = ? ORDER BY a.created_at ASC`,
      [req.params.id]
    );
    const [repuestos] = await pool.query(
      'SELECT nombre, cantidad, costo_unitario, estado FROM orden_repuestos WHERE orden_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    const [fotos] = await pool.query(
      'SELECT url, tipo, descripcion FROM orden_fotos WHERE orden_id = ? ORDER BY created_at ASC',
      [req.params.id]
    );
    res.json({ data: { ...orden, avances, repuestos, fotos } });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/ordenes/:id/aprobar — el cliente aprueba el presupuesto
router.post('/ordenes/:id/aprobar', async (req, res) => {
  try {
    const ok = await actualizarAprobacion(req.params.id, req.cliente.id, 'aprobado', null);
    if (!ok) return res.status(400).json({ error: 'La orden no está esperando aprobación' });
    res.json({ message: 'Presupuesto aprobado' });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/ordenes/:id/rechazar — el cliente rechaza el presupuesto
router.post('/ordenes/:id/rechazar', async (req, res) => {
  try {
    const ok = await actualizarAprobacion(req.params.id, req.cliente.id, 'rechazado', req.body.motivo || null);
    if (!ok) return res.status(400).json({ error: 'La orden no está esperando aprobación' });
    res.json({ message: 'Presupuesto rechazado' });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/ordenes/:id/encuesta — calificación de satisfacción (1-5)
router.post('/ordenes/:id/encuesta', async (req, res) => {
  try {
    const calificacion = Number(req.body.calificacion);
    if (!(calificacion >= 1 && calificacion <= 5)) {
      return res.status(400).json({ error: 'La calificación debe ser de 1 a 5' });
    }
    const [[orden]] = await pool.query(
      "SELECT id, calificacion FROM ordenes_trabajo WHERE id = ? AND cliente_id = ? AND estado = 'entregada'",
      [req.params.id, req.cliente.id]
    );
    if (!orden) return res.status(404).json({ error: 'Orden no encontrada o no entregada' });
    if (orden.calificacion) return res.status(400).json({ error: 'Ya calificaste esta orden' });

    await pool.query(
      'UPDATE ordenes_trabajo SET calificacion = ?, comentario_satisfaccion = ? WHERE id = ?',
      [calificacion, req.body.comentario || null, req.params.id]
    );
    res.json({ message: '¡Gracias por tu opinión!' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/fidelidad — estado de fidelización del cliente.
// Misma fuente de verdad que /resumen: citas entregadas (no el viejo contador
// por órdenes), para que ambas pantallas siempre coincidan.
router.get('/fidelidad', async (req, res) => {
  try {
    const [[{ completadas }]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM citas WHERE cliente_id = ? AND estado = 'entregado')
       + (SELECT COUNT(*) FROM ordenes_trabajo
            WHERE cliente_id = ? AND estado = 'entregada'
              AND id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)) AS completadas`,
      [req.cliente.id, req.cliente.id]
    );
    const r = recompensas(completadas);
    res.json({
      data: { visitas: r.completadas, cortesia_disponible: r.cortesia_disponible, meta: r.meta, faltan: r.faltan },
    });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/recompensas — historial de cortesías canjeadas del cliente.
router.get('/recompensas', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT rc.id, DATE_FORMAT(rc.created_at, '%Y-%m-%d') AS fecha, rc.descripcion, o.numero_orden
       FROM recompensas_canjeadas rc
       LEFT JOIN ordenes_trabajo o ON o.id = rc.orden_id
       WHERE rc.cliente_id = ?
       ORDER BY rc.created_at DESC`,
      [req.cliente.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/promos — promociones activas (sin imagen pesada para carga rápida)
router.get('/promos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, titulo, descripcion, descuento, precio_final,
              CASE WHEN imagen IS NOT NULL THEN 1 ELSE 0 END AS tiene_imagen
       FROM promos WHERE activa = 1 ORDER BY created_at DESC`
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/promos/:id/imagen — imagen individual (lazy load)
router.get('/promos/:id/imagen', async (req, res) => {
  try {
    const [[row]] = await pool.query('SELECT imagen FROM promos WHERE id = ? AND activa = 1', [req.params.id]);
    if (!row || !row.imagen) return res.status(404).json({ error: 'Sin imagen' });
    res.json({ data: row.imagen });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/motos — motos del cliente (para asociar a una cita)
router.get('/motos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT m.id, m.marca, m.modelo, m.placa, m.anio, m.color, m.kilometraje_actual, m.foto,
              (SELECT DATE_FORMAT(MAX(COALESCE(c.fecha_fin, c.fecha)), '%Y-%m-%d')
               FROM citas c WHERE c.moto_id = m.id AND c.estado = 'entregado') AS ultimo_servicio
       FROM motos m WHERE m.cliente_id = ? AND m.activa = 1 ORDER BY m.created_at DESC`,
      [req.cliente.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/portal/motos — el cliente registra una moto propia
// Obligatorios: marca, modelo, placa. Evita placas duplicadas.
router.post('/motos', async (req, res) => {
  try {
    const { marca, modelo, placa, anio, color, kilometraje_actual, foto } = req.body;
    if (!marca || !modelo || !placa) {
      return res.status(400).json({ error: 'Marca, modelo y placa son requeridos' });
    }
    if (!fotoValida(foto)) return res.status(400).json({ error: 'La foto de la moto no es válida o es demasiado grande.' });
    // Bloquea placas ya registradas (normaliza espacios y guiones).
    const [[existe]] = await pool.query(
      `SELECT id FROM motos WHERE activa = 1
         AND UPPER(REPLACE(REPLACE(placa, ' ', ''), '-', '')) = UPPER(REPLACE(REPLACE(?, ' ', ''), '-', ''))`,
      [placa]
    );
    if (existe) return res.status(409).json({ error: 'Esa placa ya está registrada en el taller' });

    const [result] = await pool.query(
      'INSERT INTO motos (cliente_id, marca, modelo, placa, anio, color, kilometraje_actual, foto) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [req.cliente.id, marca, modelo, placa, anio || null, color || null, kilometraje_actual || 0, fotoParaGuardar(foto)]
    );
    const [[nueva]] = await pool.query(
      'SELECT id, marca, modelo, placa, anio, color, kilometraje_actual, foto FROM motos WHERE id = ?',
      [result.insertId]
    );
    res.status(201).json({ data: nueva, message: 'Moto registrada' });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/portal/motos/:id — el cliente edita su propia moto
router.put('/motos/:id', async (req, res) => {
  try {
    const { marca, modelo, placa, anio, color, kilometraje_actual, foto } = req.body;
    if (!marca || !modelo || !placa) {
      return res.status(400).json({ error: 'Marca, modelo y placa son requeridos' });
    }
    if (!fotoValida(foto)) return res.status(400).json({ error: 'La foto de la moto no es válida o es demasiado grande.' });
    // La moto debe ser del cliente
    const [[moto]] = await pool.query('SELECT id FROM motos WHERE id = ? AND cliente_id = ? AND activa = 1', [req.params.id, req.cliente.id]);
    if (!moto) return res.status(404).json({ error: 'Moto no encontrada' });
    // Placa duplicada (excluyendo la propia)
    const [[dup]] = await pool.query(
      `SELECT id FROM motos WHERE activa = 1 AND id <> ?
         AND UPPER(REPLACE(REPLACE(placa, ' ', ''), '-', '')) = UPPER(REPLACE(REPLACE(?, ' ', ''), '-', ''))`,
      [req.params.id, placa]
    );
    if (dup) return res.status(409).json({ error: 'Esa placa ya está registrada en el taller' });

    await pool.query(
      'UPDATE motos SET marca = ?, modelo = ?, placa = ?, anio = ?, color = ?, kilometraje_actual = ?, foto = ? WHERE id = ?',
      [marca, modelo, placa, anio || null, color || null, kilometraje_actual || 0, fotoParaGuardar(foto), req.params.id]
    );
    const [[actualizada]] = await pool.query(
      'SELECT id, marca, modelo, placa, anio, color, kilometraje_actual, foto FROM motos WHERE id = ?',
      [req.params.id]
    );
    res.json({ data: actualizada, message: 'Moto actualizada' });
  } catch (err) {
    fail(res, err);
  }
});

// DELETE /api/portal/motos/:id — el cliente da de baja una moto propia (soft-delete).
// No se borra la fila (preserva el historial de citas/órdenes); deja de aparecer en su lista.
router.delete('/motos/:id', async (req, res) => {
  try {
    const [[moto]] = await pool.query('SELECT id FROM motos WHERE id = ? AND cliente_id = ? AND activa = 1', [req.params.id, req.cliente.id]);
    if (!moto) return res.status(404).json({ error: 'Moto no encontrada' });
    await pool.query('UPDATE motos SET activa = 0 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Moto eliminada' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/motos/:id/historial — línea de tiempo de servicios de una moto.
// Devuelve la moto + sus citas entregadas (qué se le hizo y cuándo). No filtra por
// activa=1: el historial sobrevive aunque el cliente haya eliminado la moto de su lista.
router.get('/motos/:id/historial', async (req, res) => {
  try {
    const [[moto]] = await pool.query(
      'SELECT id, marca, modelo, placa, anio, color, kilometraje_actual, foto FROM motos WHERE id = ? AND cliente_id = ?',
      [req.params.id, req.cliente.id]
    );
    if (!moto) return res.status(404).json({ error: 'Moto no encontrada' });

    const [servicios] = await pool.query(
      `SELECT ci.id, DATE_FORMAT(COALESCE(ci.fecha_fin, ci.fecha), '%Y-%m-%d') AS fecha,
              ci.tipo_servicio, ci.motivo, ci.monto, ci.calificacion,
              ci.orden_id, o.numero_orden, o.diagnostico,
              t.nombre AS tecnico_nombre
       FROM citas ci
       LEFT JOIN ordenes_trabajo o ON o.id = ci.orden_id
       LEFT JOIN usuarios t ON t.id = ci.tecnico_id
       WHERE ci.moto_id = ? AND ci.cliente_id = ? AND ci.estado = 'entregado'
       ORDER BY COALESCE(ci.fecha_fin, ci.fecha) DESC, ci.hora DESC`,
      [req.params.id, req.cliente.id]
    );
    res.json({ data: { moto, servicios } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/citas — citas del cliente
router.get('/citas', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ci.id, DATE_FORMAT(ci.fecha,'%Y-%m-%d') AS fecha, TIME_FORMAT(ci.hora,'%H:%i') AS hora,
              ci.motivo, ci.tipo_servicio, ci.estado,
              ci.monto, ci.calificacion, ci.confirmada_cliente,
              ci.orden_id, o.numero_orden, o.estado AS orden_estado, o.aprobacion_cliente,
              m.marca, m.modelo, m.placa,
              t.nombre AS tecnico_nombre,
              ci.sucursal_id, s.nombre AS sucursal_nombre
       FROM citas ci
       LEFT JOIN motos m ON m.id = ci.moto_id
       LEFT JOIN usuarios t ON t.id = ci.tecnico_id
       LEFT JOIN ordenes_trabajo o ON o.id = ci.orden_id
       LEFT JOIN sucursales s ON s.id = ci.sucursal_id
       WHERE ci.cliente_id = ? AND ci.estado <> 'cancelado'
       ORDER BY ci.fecha DESC, ci.hora DESC`,
      [req.cliente.id]
    );
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/portal/citas/:id — detalle de una cita propia (para la pantalla de detalle)
router.get('/citas/:id', async (req, res) => {
  try {
    const [[cita]] = await pool.query(
      `SELECT ci.id, DATE_FORMAT(ci.fecha, '%Y-%m-%d') AS fecha, TIME_FORMAT(ci.hora, '%H:%i') AS hora,
              ci.motivo, ci.tipo_servicio, ci.estado, ci.moto_id,
              ci.monto, ci.calificacion, ci.comentario_satisfaccion, ci.fecha_inicio, ci.fecha_fin,
              ci.confirmada_cliente,
              ci.orden_id, o.numero_orden, o.estado AS orden_estado, o.aprobacion_cliente,
              m.marca, m.modelo, m.placa, m.foto AS moto_foto,
              t.nombre AS tecnico_nombre,
              ci.sucursal_id, s.nombre AS sucursal_nombre, s.direccion AS sucursal_direccion
       FROM citas ci
       LEFT JOIN motos m ON m.id = ci.moto_id
       LEFT JOIN usuarios t ON t.id = ci.tecnico_id
       LEFT JOIN ordenes_trabajo o ON o.id = ci.orden_id
       LEFT JOIN sucursales s ON s.id = ci.sucursal_id
       WHERE ci.id = ? AND ci.cliente_id = ?`,
      [req.params.id, req.cliente.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    res.json({ data: cita });
  } catch (err) {
    fail(res, err);
  }
});

// PUT /api/portal/citas/:id — el cliente reprograma/edita su cita.
// Solo mientras está 'agendado', sin orden iniciada y respetando la ventana mínima.
// Revalida la NUEVA fecha/hora con las mismas reglas que agendar (cupo atómico).
router.put('/citas/:id', async (req, res) => {
  try {
    const { moto_id, fecha, hora, tipo_servicio, descripcion } = req.body;
    if (!moto_id || !fecha || !hora || !tipo_servicio) {
      return res.status(400).json({ error: 'Moto, servicio, fecha y hora son requeridos' });
    }
    if (!SERVICIOS.includes(tipo_servicio)) {
      return res.status(400).json({ error: 'Servicio no válido' });
    }
    // Sucursal: la pedida (si es válida) o se conserva la actual de la cita más abajo.
    const sucursalPedida = (await sucursalValida(req.body.sucursal_id)) ? Number(req.body.sucursal_id) : null;

    const [[cita]] = await pool.query(
      "SELECT id, estado, orden_id, sucursal_id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, TIME_FORMAT(hora, '%H:%i') AS hora FROM citas WHERE id = ? AND cliente_id = ?",
      [req.params.id, req.cliente.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    if (cita.estado !== 'agendado' || cita.orden_id) {
      return res.status(400).json({ error: 'Esta cita ya no se puede modificar. Comunicate con el taller.' });
    }

    const config = await getConfig();
    const minH = Number(config.cancelacion_horas_min || 0);
    // Ventana mínima sobre la cita ACTUAL (no reprogramar a último momento).
    if (minH > 0 && horasHastaCita(cita.fecha, cita.hora) < minH) {
      return res.status(400).json({ error: `No se puede modificar con menos de ${minH} h de anticipación. Comunicate con el taller.` });
    }

    // Validaciones de la NUEVA fecha/hora (mismas reglas que agendar).
    const horas = horasDisponibles(fecha, config);
    if (!horas.includes(hora)) {
      return res.status(400).json({ error: 'Ese día/hora no está disponible para agendar' });
    }
    const hoy = await hoyCR();
    if (fecha < hoy) return res.status(400).json({ error: 'La fecha no puede ser en el pasado' });
    if (fecha === hoy && horasHastaCita(fecha, hora) <= 0) {
      return res.status(400).json({ error: 'Esa hora ya pasó. Elegí un horario más tarde.' });
    }
    const limiteFecha = new Date(`${hoy}T12:00:00Z`);
    limiteFecha.setUTCDate(limiteFecha.getUTCDate() + Number(config.dias_anticipacion || 30));
    if (fecha > limiteFecha.toISOString().slice(0, 10)) {
      return res.status(400).json({ error: `Solo se puede agendar hasta ${config.dias_anticipacion} días por adelantado` });
    }

    const [[moto]] = await pool.query('SELECT id FROM motos WHERE id = ? AND cliente_id = ?', [moto_id, req.cliente.id]);
    if (!moto) return res.status(400).json({ error: 'Moto no válida' });

    const motivo = (descripcion || '').trim() || tipo_servicio;
    // Sucursal efectiva: la nueva pedida, o la que ya tenía la cita (fallback al default).
    const sucursalId = sucursalPedida || cita.sucursal_id || (await sucursalPorDefecto());

    // Cupo atómico de la NUEVA franja (por sucursal), excluyendo esta misma cita.
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ ocupadas }]] = await conn.query(
        "SELECT COUNT(*) AS ocupadas FROM citas WHERE fecha = ? AND hora = ? AND sucursal_id = ? AND estado != 'cancelado' AND id != ? FOR UPDATE",
        [fecha, hora, sucursalId, req.params.id]
      );
      if (ocupadas >= config.max_citas_hora) {
        await conn.rollback();
        return res.status(400).json({ error: 'Esa hora ya no está disponible, elegí otra.' });
      }
      await conn.query(
        'UPDATE citas SET moto_id = ?, fecha = ?, hora = ?, tipo_servicio = ?, motivo = ?, sucursal_id = ? WHERE id = ?',
        [moto_id, fecha, hora, tipo_servicio, motivo, sucursalId, req.params.id]
      );
      const [[actualizada]] = await conn.query(
        `SELECT ci.id, ci.fecha, ci.hora, ci.motivo, ci.tipo_servicio, ci.estado, m.marca, m.modelo, m.placa
         FROM citas ci LEFT JOIN motos m ON m.id = ci.moto_id WHERE ci.id = ?`,
        [req.params.id]
      );
      await conn.commit();
      res.json({ data: actualizada, message: 'Cita actualizada' });
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

// POST /api/portal/citas — el cliente solicita una cita (queda pendiente de confirmar)
router.post('/citas', async (req, res) => {
  try {
    const { moto_id, fecha, hora, tipo_servicio, descripcion } = req.body;
    if (!moto_id || !fecha || !hora || !tipo_servicio) {
      return res.status(400).json({ error: 'Moto, servicio, fecha y hora son requeridos' });
    }
    if (!SERVICIOS.includes(tipo_servicio)) {
      return res.status(400).json({ error: 'Servicio no válido' });
    }
    // Sucursal obligatoria y válida (activa). El cupo se controla por sucursal.
    const sucursalId = (await sucursalValida(req.body.sucursal_id)) ? Number(req.body.sucursal_id) : null;
    if (!sucursalId) return res.status(400).json({ error: 'Elegí una sucursal válida' });
    const config = await getConfig();
    const horas = horasDisponibles(fecha, config);
    if (!horas.includes(hora)) {
      return res.status(400).json({ error: 'Ese día/hora no está disponible para agendar' });
    }
    const hoy = await hoyCR();
    if (fecha < hoy) {
      return res.status(400).json({ error: 'La fecha no puede ser en el pasado' });
    }
    // Si es hoy, no permitir horas que ya pasaron (el slot debe iniciar en el futuro).
    if (fecha === hoy && horasHastaCita(fecha, hora) <= 0) {
      return res.status(400).json({ error: 'Esa hora ya pasó. Elegí un horario más tarde.' });
    }
    // Tope de anticipación configurable: no se agenda más allá de N días.
    const limiteFecha = new Date(`${hoy}T12:00:00Z`);
    limiteFecha.setUTCDate(limiteFecha.getUTCDate() + Number(config.dias_anticipacion || 30));
    if (fecha > limiteFecha.toISOString().slice(0, 10)) {
      return res.status(400).json({ error: `Solo se puede agendar hasta ${config.dias_anticipacion} días por adelantado` });
    }

    // Anti-spam: limita cuántas citas pide un mismo cliente.
    const limite = consumir(`cita:${req.cliente.id}`, { porMinuto: 3, porHora: 15 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Estás agendando muy seguido. Esperá ${limite.retryAfter}s.` });
    }

    // La moto debe ser del cliente
    const [[moto]] = await pool.query('SELECT id FROM motos WHERE id = ? AND cliente_id = ?', [moto_id, req.cliente.id]);
    if (!moto) return res.status(400).json({ error: 'Moto no válida' });

    const motivo = (descripcion || '').trim() || tipo_servicio;

    // Cupo atómico: una transacción bloquea el rango (fecha,hora) con FOR UPDATE,
    // cuenta y recién ahí inserta. Dos solicitudes simultáneas se serializan, así
    // nunca se superan las MAX_POR_HORA citas por franja (evita la carrera del COUNT+INSERT).
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [[{ ocupadas }]] = await conn.query(
        "SELECT COUNT(*) AS ocupadas FROM citas WHERE fecha = ? AND hora = ? AND sucursal_id = ? AND estado != 'cancelado' FOR UPDATE",
        [fecha, hora, sucursalId]
      );
      if (ocupadas >= config.max_citas_hora) {
        await conn.rollback();
        return res.status(400).json({ error: 'Esa hora ya no está disponible, elegí otra.' });
      }
      const [result] = await conn.query(
        "INSERT INTO citas (cliente_id, moto_id, sucursal_id, fecha, hora, motivo, tipo_servicio, estado) VALUES (?, ?, ?, ?, ?, ?, ?, 'agendado')",
        [req.cliente.id, moto_id, sucursalId, fecha, hora, motivo, tipo_servicio]
      );
      const [[nueva]] = await conn.query(
        `SELECT ci.id, ci.fecha, ci.hora, ci.motivo, ci.tipo_servicio, ci.estado, m.marca, m.modelo, m.placa
         FROM citas ci LEFT JOIN motos m ON m.id = ci.moto_id WHERE ci.id = ?`,
        [result.insertId]
      );
      await conn.commit();
      res.status(201).json({ data: nueva, message: 'Solicitud de cita enviada' });
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

// POST /api/portal/citas/:id/calificar — el cliente puntúa su cita ya entregada (1-5)
router.post('/citas/:id/calificar', async (req, res) => {
  try {
    const calificacion = Number(req.body.calificacion);
    if (!(calificacion >= 1 && calificacion <= 5)) {
      return res.status(400).json({ error: 'La calificación debe ser de 1 a 5' });
    }
    const [[cita]] = await pool.query(
      "SELECT id, calificacion FROM citas WHERE id = ? AND cliente_id = ? AND estado = 'entregado'",
      [req.params.id, req.cliente.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada o no entregada' });
    if (cita.calificacion) return res.status(400).json({ error: 'Ya calificaste esta cita' });

    await pool.query(
      'UPDATE citas SET calificacion = ?, comentario_satisfaccion = ? WHERE id = ?',
      [calificacion, req.body.comentario || null, req.params.id]
    );
    res.json({ message: '¡Gracias por tu opinión!' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/portal/citas/:id/cancelar — el cliente cancela su propia cita.
// Solo se permite mientras está 'agendado' y sin orden de trabajo iniciada
// (después la gestiona el taller). Libera el cupo de la franja.
router.patch('/citas/:id/cancelar', async (req, res) => {
  try {
    const [[cita]] = await pool.query(
      "SELECT id, estado, orden_id, DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha, TIME_FORMAT(hora, '%H:%i') AS hora FROM citas WHERE id = ? AND cliente_id = ?",
      [req.params.id, req.cliente.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    if (cita.estado !== 'agendado' || cita.orden_id) {
      return res.status(400).json({ error: 'Esta cita ya no se puede cancelar. Comunicate con el taller.' });
    }
    const config = await getConfig();
    const minH = Number(config.cancelacion_horas_min || 0);
    if (minH > 0 && horasHastaCita(cita.fecha, cita.hora) < minH) {
      return res.status(400).json({ error: `No se puede cancelar con menos de ${minH} h de anticipación. Comunicate con el taller.` });
    }
    await pool.query("UPDATE citas SET estado = 'cancelado' WHERE id = ?", [req.params.id]);
    res.json({ message: 'Cita cancelada' });
  } catch (err) {
    fail(res, err);
  }
});

// PATCH /api/portal/citas/:id/confirmar — el cliente confirma que asistirá.
// Marca confirmada_cliente=1 (el taller lo usa como señal de presencia / no-show).
router.patch('/citas/:id/confirmar', async (req, res) => {
  try {
    const [[cita]] = await pool.query(
      'SELECT id, estado FROM citas WHERE id = ? AND cliente_id = ?',
      [req.params.id, req.cliente.id]
    );
    if (!cita) return res.status(404).json({ error: 'Cita no encontrada' });
    if (cita.estado !== 'agendado') {
      return res.status(400).json({ error: 'Solo se puede confirmar una cita agendada.' });
    }
    await pool.query('UPDATE citas SET confirmada_cliente = 1 WHERE id = ?', [req.params.id]);
    res.json({ message: 'Asistencia confirmada' });
  } catch (err) {
    fail(res, err);
  }
});

// Solo permite aprobar/rechazar si la orden es del cliente y está esperando aprobación.
async function actualizarAprobacion(ordenId, clienteId, decision, motivo) {
  const [[orden]] = await pool.query(
    "SELECT id FROM ordenes_trabajo WHERE id = ? AND cliente_id = ? AND estado = 'esperando_aprobacion'",
    [ordenId, clienteId]
  );
  if (!orden) return false;
  await pool.query(
    `UPDATE ordenes_trabajo
       SET aprobacion_cliente = ?, motivo_rechazo = ?,
           aprobado_por_cliente = ?, fecha_aprobacion = NOW()
     WHERE id = ?`,
    [decision, motivo, decision === 'aprobado' ? 1 : 0, ordenId]
  );
  // La orden no debe quedar "esperando aprobación" después de la decisión:
  // aprobado → a trabajar (o esperar repuestos); rechazado → vuelve a diagnóstico.
  if (decision === 'aprobado') {
    await avanzarEstadoOrden(ordenId, await estadoTrasAprobacion(ordenId));
  } else if (decision === 'rechazado') {
    await avanzarEstadoOrden(ordenId, 'diagnostico');
  }
  return true;
}

module.exports = router;
