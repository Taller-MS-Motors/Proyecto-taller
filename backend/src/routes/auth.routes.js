const router = require('express').Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const { emailValido } = require('../utils/validar');
const { consumir } = require('../utils/rate-limit');
const totp = require('../utils/totp');

function firmar(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

// Token PARCIAL de 2FA: se emite cuando la contraseña fue correcta pero falta el
// segundo factor. NO lleva `rol`, así que `middleware/auth` (que exige rol y rechaza
// `pend2fa`) lo bloquea en todas las rutas del sistema: solo sirve para canjearlo en
// /auth/2fa/verificar, y vive 5 minutos.
function firmarParcial(usuarioId) {
  return jwt.sign({ id: usuarioId, pend2fa: true }, process.env.JWT_SECRET, { expiresIn: '5m' });
}

// Hash señuelo (bcrypt válido) para igualar el tiempo de respuesta cuando el correo
// no existe: sin esto, un login a un correo inexistente respondería más rápido (no
// corre bcrypt), revelando qué cuentas existen. Se calcula una sola vez al cargar.
const DUMMY_HASH = bcrypt.hashSync('timing-equalizer', 10);

// Login unificado: el mismo formulario sirve para personal y para clientes.
// Busca primero en usuarios (personal) y, si no, en clientes con acceso al portal.
// La respuesta incluye `tipo` ('staff' | 'cliente') para que el front sepa a dónde mandar.
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email y contraseña requeridos' });
    }
    if (!emailValido(email)) {
      return res.status(400).json({ error: 'El correo no tiene un formato válido' });
    }

    // Anti fuerza-bruta: limita intentos por correo (10/min, 60/hora).
    const limite = consumir(`login:${String(email).trim().toLowerCase()}`, { porMinuto: 10, porHora: 60 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Demasiados intentos. Esperá ${limite.retryAfter}s e intentá de nuevo.` });
    }

    // 1) Personal del taller (usuarios)
    const [[usuario]] = await pool.query(
      'SELECT * FROM usuarios WHERE email = ? AND activo = 1',
      [email]
    );
    if (usuario && (await bcrypt.compare(password, usuario.password_hash))) {
      // Con verificación en dos pasos activa, la contraseña sola no abre sesión:
      // se devuelve un token parcial que solo sirve para canjear el código.
      if (usuario.totp_activado) {
        return res.json({ data: { requiere_2fa: true, tipo: 'staff', token_parcial: firmarParcial(usuario.id) } });
      }
      const payload = { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol };
      return res.json({ data: { token: firmar(payload), tipo: 'staff', usuario: payload } });
    }

    // 2) Cliente del portal (clientes con contraseña definida)
    const [[cliente]] = await pool.query(
      'SELECT * FROM clientes WHERE email = ? AND activo = 1 AND password_hash IS NOT NULL',
      [email]
    );
    if (cliente && (await bcrypt.compare(password, cliente.password_hash))) {
      const payload = { id: cliente.id, tipo: 'cliente', nombre: cliente.nombre, apellido: cliente.apellido };
      // La foto va en la respuesta (para el header), NO en el token (lo mantiene liviano).
      return res.json({ data: { token: firmar(payload), tipo: 'cliente', cliente: { ...payload, foto: cliente.foto || null } } });
    }

    // Anti-enumeración: si el correo no existía en ninguna tabla, no se ejecutó
    // ningún bcrypt.compare; corré uno señuelo para no delatar la cuenta por timing.
    if (!usuario && !cliente) {
      await bcrypt.compare(password, DUMMY_HASH);
    }
    return res.status(401).json({ error: 'Credenciales incorrectas' });
  } catch (err) {
    fail(res, err);
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    const [[usuario]] = await pool.query(
      'SELECT id, nombre, email, rol, activo, created_at FROM usuarios WHERE id = ?',
      [req.usuario.id]
    );
    if (!usuario) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ data: usuario });
  } catch (err) {
    fail(res, err);
  }
});

// ───────────────────────────────────────────────────────────
// Verificación en dos pasos (TOTP) — personal del taller
// Opt-in por cuenta. La contraseña deja de ser suficiente: hay que presentar
// además un código de 6 dígitos de la app de autenticación (o uno de respaldo).
// ───────────────────────────────────────────────────────────

// Canjea el token parcial del login por una sesión real, presentando el código.
// Público (el usuario todavía no tiene sesión), pero exige el token parcial.
router.post('/2fa/verificar', async (req, res) => {
  try {
    const { token_parcial, codigo } = req.body;
    if (!token_parcial || !codigo) return res.status(400).json({ error: 'Código requerido' });

    let datos;
    try {
      datos = jwt.verify(token_parcial, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'La sesión de ingreso venció. Iniciá sesión de nuevo.' });
    }
    if (!datos.pend2fa || !datos.id) return res.status(401).json({ error: 'Token no válido' });

    // Fuerza bruta: 6 dígitos son un millón de combinaciones, pero sin tope se
    // agotan rápido. Se limita por cuenta, no por IP (que el atacante puede rotar).
    const limite = consumir(`2fa:${datos.id}`, { porMinuto: 5, porHora: 20 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Demasiados intentos. Esperá ${limite.retryAfter}s e intentá de nuevo.` });
    }

    const [[usuario]] = await pool.query(
      'SELECT id, nombre, email, rol, totp_secret, totp_activado, totp_backup, totp_ultimo_contador FROM usuarios WHERE id = ? AND activo = 1',
      [datos.id]
    );
    if (!usuario || !usuario.totp_activado) return res.status(401).json({ error: 'Token no válido' });

    const ERR = 'Código incorrecto';
    const contador = totp.verificar(usuario.totp_secret, codigo, { ultimoContador: usuario.totp_ultimo_contador });

    if (contador) {
      // Guarda el período consumido: ese mismo código ya no se puede reusar.
      await pool.query('UPDATE usuarios SET totp_ultimo_contador = ? WHERE id = ?', [contador, usuario.id]);
    } else {
      // ¿Será un código de respaldo? (un solo uso: si acierta, se elimina)
      const usado = await consumirCodigoRespaldo(usuario, codigo);
      if (!usado) return res.status(401).json({ error: ERR });
    }

    const payload = { id: usuario.id, nombre: usuario.nombre, email: usuario.email, rol: usuario.rol };
    res.json({ data: { token: firmar(payload), tipo: 'staff', usuario: payload } });
  } catch (err) {
    fail(res, err);
  }
});

// Busca el código entre los de respaldo del usuario. Si coincide, lo quema
// (lo saca de la lista) para que no sirva una segunda vez.
async function consumirCodigoRespaldo(usuario, codigo) {
  let hashes;
  try {
    hashes = JSON.parse(usuario.totp_backup || '[]');
  } catch {
    return false;
  }
  if (!Array.isArray(hashes) || !hashes.length) return false;
  const limpio = totp.normalizarRespaldo(codigo);
  if (!limpio) return false;
  for (let i = 0; i < hashes.length; i++) {
    if (await bcrypt.compare(limpio, hashes[i])) {
      hashes.splice(i, 1);
      await pool.query('UPDATE usuarios SET totp_backup = ? WHERE id = ?', [JSON.stringify(hashes), usuario.id]);
      return true;
    }
  }
  return false;
}

// Estado del 2FA de mi cuenta (para pintar el panel del perfil).
router.get('/2fa/estado', auth, async (req, res) => {
  try {
    const [[u]] = await pool.query('SELECT totp_activado, totp_backup FROM usuarios WHERE id = ?', [req.usuario.id]);
    let restantes = 0;
    try { restantes = (JSON.parse(u?.totp_backup || '[]') || []).length; } catch { restantes = 0; }
    res.json({ data: { activado: !!u?.totp_activado, backup_restantes: restantes } });
  } catch (err) {
    fail(res, err);
  }
});

// Paso 1 del alta: genera la clave y la devuelve para configurar la app.
// Queda guardada pero INACTIVA hasta que se confirme con un código válido.
router.post('/2fa/setup', auth, async (req, res) => {
  try {
    const [[u]] = await pool.query('SELECT email, totp_activado FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (u?.totp_activado) return res.status(400).json({ error: 'La verificación en dos pasos ya está activa' });

    const secreto = totp.generarSecreto();
    await pool.query(
      'UPDATE usuarios SET totp_secret = ?, totp_activado = 0, totp_ultimo_contador = NULL WHERE id = ?',
      [secreto, req.usuario.id]
    );
    res.json({
      data: {
        secreto,
        secreto_legible: totp.secretoLegible(secreto),
        uri: totp.uriOtpauth(secreto, u.email || `usuario-${req.usuario.id}`),
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

// Paso 2 del alta: confirma que la app quedó bien configurada y activa el 2FA.
// Devuelve los códigos de respaldo — es la ÚNICA vez que se ven en texto plano.
router.post('/2fa/activar', auth, async (req, res) => {
  try {
    const { codigo } = req.body;
    if (!codigo) return res.status(400).json({ error: 'Código requerido' });

    const limite = consumir(`2fa-alta:${req.usuario.id}`, { porMinuto: 5, porHora: 30 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Demasiados intentos. Esperá ${limite.retryAfter}s e intentá de nuevo.` });
    }

    const [[u]] = await pool.query(
      'SELECT totp_secret, totp_activado FROM usuarios WHERE id = ?', [req.usuario.id]
    );
    if (u?.totp_activado) return res.status(400).json({ error: 'La verificación en dos pasos ya está activa' });
    if (!u?.totp_secret) return res.status(400).json({ error: 'Primero generá la clave' });

    const contador = totp.verificar(u.totp_secret, codigo);
    if (!contador) return res.status(400).json({ error: 'El código no coincide. Revisá la hora del teléfono e intentá de nuevo.' });

    const codigos = totp.generarCodigosRespaldo();
    const hashes = await Promise.all(codigos.map(c => bcrypt.hash(totp.normalizarRespaldo(c), 10)));
    await pool.query(
      'UPDATE usuarios SET totp_activado = 1, totp_backup = ?, totp_ultimo_contador = ? WHERE id = ?',
      [JSON.stringify(hashes), contador, req.usuario.id]
    );

    res.json({ data: { codigos_respaldo: codigos }, message: 'Verificación en dos pasos activada' });
  } catch (err) {
    fail(res, err);
  }
});

// Baja del 2FA. Debilita la cuenta, así que se exige la contraseña de nuevo
// (que quien tenga la sesión abierta en un equipo prestado no pueda apagarlo).
router.post('/2fa/desactivar', auth, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Ingresá tu contraseña para desactivar' });

    const limite = consumir(`2fa-baja:${req.usuario.id}`, { porMinuto: 5, porHora: 20 });
    if (!limite.ok) {
      return res.status(429).json({ error: `Demasiados intentos. Esperá ${limite.retryAfter}s e intentá de nuevo.` });
    }

    const [[u]] = await pool.query('SELECT password_hash FROM usuarios WHERE id = ?', [req.usuario.id]);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (!(await bcrypt.compare(String(password), u.password_hash))) {
      return res.status(400).json({ error: 'La contraseña no es correcta' });
    }

    await pool.query(
      'UPDATE usuarios SET totp_activado = 0, totp_secret = NULL, totp_backup = NULL, totp_ultimo_contador = NULL WHERE id = ?',
      [req.usuario.id]
    );
    res.json({ message: 'Verificación en dos pasos desactivada' });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
