const router = require('express').Router();
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const requireRol = require('../middleware/roles');
const { soloRoles } = require('../middleware/roles');
const { LEIDO_POR_MI, VISTO_POR_OTRO, marcarLeidos } = require('../utils/mensajes');
const { fotoValida } = require('../utils/validar');

// Mensajería interna 1:1 entre TODO el personal (estilo WhatsApp).
// A diferencia de los buzones por rol viejos (/api/mecanico/mensajes y
// /api/recepcion/mensajes-internos), acá cada conversación es privada entre
// dos personas: se llavea por el par (remitente_id, destino_id). Los tres
// roles usan exactamente estos endpoints (piso recepcion = entran todos).
router.use(auth, requireRol('recepcion'));

// LEIDO_POR_MI trae un `?` (mi id): va SIEMPRE como primer parámetro del query.
//
// La foto NO viaja en el listado, solo si la hay: es MEDIUMTEXT con la imagen en
// base64 (~100 KB) y el hilo devuelve 200 mensajes, que el frontend además refresca
// cada 12 s. Se pedía la misma imagen cinco veces por minuto. Se sirve aparte por
// GET /mensaje/:id/foto y el cliente la cachea por id (un mensaje no cambia nunca).
// Mismo patrón que ya usaba el listado de promociones.
const SELECT_MSG = `
  SELECT m.id, m.mensaje, (m.foto IS NOT NULL) AS tiene_foto, m.orden_id, m.tipo, m.created_at,
         m.remitente_id, m.destino_id,
         ru.nombre AS remitente_nombre, ru.rol AS remitente_rol,
         o.numero_orden,
         ${LEIDO_POR_MI}, ${VISTO_POR_OTRO}
  FROM mensajes_internos m
  JOIN usuarios ru ON ru.id = m.remitente_id
  LEFT JOIN ordenes_trabajo o ON o.id = m.orden_id`;

// Valida que :usuarioId sea otra persona del personal, existente y activa.
// Devuelve la fila del usuario o null (el llamador responde el error).
async function contactoValido(req) {
  const otro = Number(req.params.usuarioId);
  if (!Number.isInteger(otro) || otro <= 0 || otro === req.usuario.id) return null;
  const [[u]] = await pool.query(
    // Sin el avatar: lo devuelve el hilo en cada refresco (cada 12 s) y es base64.
    // Se pide aparte por /contacto/:id/foto y el cliente lo cachea.
    'SELECT id, nombre, rol, (foto IS NOT NULL) AS tiene_foto, telefono FROM usuarios WHERE id = ? AND activo = 1',
    [otro]
  );
  return u || null;
}

// GET /api/mensajeria/contactos — lista estilo WhatsApp: todo el personal activo
// (menos yo) con el último mensaje del par, y no-leídos por conversación.
// Los mensajes 'sistema' (asignaciones) cuentan igual que los directos: son parte
// del hilo con quien asignó. Los broadcast van aparte (avisos_no_leidos).
router.get('/contactos', async (req, res) => {
  try {
    const yo = req.usuario.id;
    // Antes esto eran cinco subconsultas correlacionadas POR CONTACTO: cuatro para
    // sacar el mismo último mensaje (texto, si era foto, remitente y fecha) más un
    // COUNT con un NOT EXISTS anidado. Con N empleados eran 5N recorridos de la tabla,
    // y encima ordenaba por una columna calculada. Ahora son dos recorridos fijos:
    //   · el último mensaje de cada par, con ROW_NUMBER sobre MIS mensajes (una pasada);
    //   · los no leídos agrupados por remitente (una pasada).
    // `u.foto` tampoco viaja: es el avatar en base64 y esta lista se refresca cada 15 s.
    const [contactos] = await pool.query(
      `SELECT u.id, u.nombre, u.rol, u.telefono,
              (u.foto IS NOT NULL) AS tiene_foto,
              ult.mensaje       AS ultimo_mensaje,
              ult.es_foto       AS ultimo_es_foto,
              ult.remitente_id  AS ultimo_remitente_id,
              ult.created_at    AS ultima_fecha,
              COALESCE(nl.n, 0) AS no_leidos
       FROM usuarios u
       LEFT JOIN (
         SELECT otro, mensaje, es_foto, remitente_id, created_at FROM (
           SELECT IF(m.remitente_id = ?, m.destino_id, m.remitente_id) AS otro,
                  m.mensaje, (m.foto IS NOT NULL) AS es_foto, m.remitente_id, m.created_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY IF(m.remitente_id = ?, m.destino_id, m.remitente_id)
                    ORDER BY m.created_at DESC, m.id DESC
                  ) AS rn
           FROM mensajes_internos m
           WHERE m.tipo IN ('directo','sistema') AND (m.remitente_id = ? OR m.destino_id = ?)
         ) x WHERE x.rn = 1
       ) ult ON ult.otro = u.id
       LEFT JOIN (
         SELECT m.remitente_id, COUNT(*) AS n
         FROM mensajes_internos m
         WHERE m.tipo IN ('directo','sistema') AND m.destino_id = ?
           AND NOT EXISTS(SELECT 1 FROM mensaje_lecturas ml WHERE ml.mensaje_id = m.id AND ml.usuario_id = ?)
         GROUP BY m.remitente_id
       ) nl ON nl.remitente_id = u.id
       WHERE u.activo = 1 AND u.id <> ?
       ORDER BY (ult.created_at IS NULL), ult.created_at DESC, u.nombre`,
      [yo, yo, yo, yo, yo, yo, yo]
    );
    // Avisos (broadcast a mecánicos) sin leer: solo aplican al rol tecnico.
    let avisos_no_leidos = 0;
    if (req.usuario.rol === 'tecnico') {
      const [[a]] = await pool.query(
        `SELECT COUNT(*) AS n FROM mensajes_internos m
         WHERE m.tipo = 'broadcast' AND m.destino_rol = 'tecnico' AND m.remitente_id <> ?
           AND NOT EXISTS(SELECT 1 FROM mensaje_lecturas ml WHERE ml.mensaje_id = m.id AND ml.usuario_id = ?)`,
        [req.usuario.id, req.usuario.id]
      );
      avisos_no_leidos = Number(a.n);
    }
    res.json({ data: { contactos, avisos_no_leidos } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/mensajeria/conversacion/:usuarioId — hilo privado 1:1 (últimos 200).
// La privacidad la impone el WHERE: mi id va en ambos lados del par, así que es
// imposible leer un hilo del que no soy parte, sin importar qué id manden.
router.get('/conversacion/:usuarioId', async (req, res) => {
  try {
    const yo = req.usuario.id;
    const otro = await contactoValido(req);
    if (!otro) return res.status(404).json({ error: 'Contacto no válido' });
    const [rows] = await pool.query(
      `${SELECT_MSG}
       WHERE m.tipo IN ('directo','sistema')
         AND ((m.remitente_id = ? AND m.destino_id = ?) OR (m.remitente_id = ? AND m.destino_id = ?))
       ORDER BY m.created_at DESC LIMIT 200`,
      [yo, yo, otro.id, otro.id, yo]
    );
    rows.reverse(); // cronológico ascendente para pintar el chat
    await marcarLeidos(yo, rows);
    res.json({ data: rows, contacto: otro });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/mensajeria/conversacion/:usuarioId — enviar un DM. Nunca se acepta
// destino_rol del cliente: el chat privado siempre va a una persona concreta.
router.post('/conversacion/:usuarioId', async (req, res) => {
  try {
    const yo = req.usuario.id;
    const otro = await contactoValido(req);
    if (!otro) return res.status(404).json({ error: 'Contacto no válido' });
    const { mensaje, foto } = req.body;
    const texto = (mensaje || '').trim().slice(0, 500);
    if (!texto && !foto) return res.status(400).json({ error: 'El mensaje o una foto es requerido' });
    if (!fotoValida(foto)) return res.status(400).json({ error: 'Imagen inválida' });
    // La sede del mensaje = la del destinatario (mismo criterio que el modelo viejo).
    const [r] = await pool.query(
      `INSERT INTO mensajes_internos (remitente_id, destino_id, destino_rol, mensaje, foto, tipo, sucursal_id)
       VALUES (?, ?, NULL, ?, ?, 'directo', (SELECT sucursal_id FROM usuarios WHERE id = ?))`,
      [yo, otro.id, texto, foto || null, otro.id]
    );
    const [[nuevo]] = await pool.query(`${SELECT_MSG} WHERE m.id = ?`, [yo, r.insertId]);
    res.status(201).json({ data: nuevo, message: 'Mensaje enviado' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/mensajeria/no-leidos — total global para el badge del nav:
// DMs+sistema dirigidos a mí + broadcasts a mi rol, sin fila de lectura mía.
router.get('/no-leidos', async (req, res) => {
  try {
    const yo = req.usuario.id;
    const [[{ count }]] = await pool.query(
      `SELECT COUNT(*) AS count FROM mensajes_internos m
       WHERE m.remitente_id <> ?
         AND ( (m.destino_id = ? AND m.tipo IN ('directo','sistema'))
            OR (m.tipo = 'broadcast' AND m.destino_rol = ?) )
         AND NOT EXISTS(SELECT 1 FROM mensaje_lecturas ml WHERE ml.mensaje_id = m.id AND ml.usuario_id = ?)`,
      [yo, yo, req.usuario.rol, yo]
    );
    res.json({ data: { count } });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/mensajeria/avisos — feed de broadcasts (megáfono), separado de los 1:1.
router.get('/avisos', async (req, res) => {
  try {
    const yo = req.usuario.id;
    const [rows] = await pool.query(
      `${SELECT_MSG} WHERE m.tipo = 'broadcast' ORDER BY m.created_at DESC LIMIT 50`,
      [yo]
    );
    rows.reverse();
    await marcarLeidos(yo, rows);
    res.json({ data: rows });
  } catch (err) {
    fail(res, err);
  }
});

// POST /api/mensajeria/avisos — aviso a todos los mecánicos (solo oficina).
router.post('/avisos', soloRoles('recepcion', 'admin'), async (req, res) => {
  try {
    const { mensaje, foto } = req.body;
    const texto = (mensaje || '').trim().slice(0, 500);
    if (!texto && !foto) return res.status(400).json({ error: 'El mensaje o una foto es requerido' });
    if (!fotoValida(foto)) return res.status(400).json({ error: 'Imagen inválida' });
    const [r] = await pool.query(
      "INSERT INTO mensajes_internos (remitente_id, destino_rol, tipo, mensaje, foto) VALUES (?, 'tecnico', 'broadcast', ?, ?)",
      [req.usuario.id, texto, foto || null]
    );
    const [[nuevo]] = await pool.query(`${SELECT_MSG} WHERE m.id = ?`, [req.usuario.id, r.insertId]);
    res.status(201).json({ data: nuevo, message: 'Aviso enviado a todos los mecánicos' });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/mensajeria/mensaje/:id/foto — la imagen de un mensaje, fuera del listado.
//
// El control de acceso es el mismo que el del hilo, pero explícito: un id de mensaje
// es un número correlativo, así que sin esto cualquiera del personal podría recorrer
// ids y leer las fotos de conversaciones ajenas. Se permite si soy parte del par, o
// si es un broadcast (que es para todo el personal por definición).
router.get('/mensaje/:id/foto', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id inválido' });
    const yo = req.usuario.id;
    const [[m]] = await pool.query(
      'SELECT foto, tipo, remitente_id, destino_id FROM mensajes_internos WHERE id = ?',
      [id]
    );
    if (!m || !m.foto) return res.status(404).json({ error: 'Sin imagen' });

    const esMia = m.remitente_id === yo || m.destino_id === yo;
    if (m.tipo !== 'broadcast' && !esMia) {
      // 404 y no 403: un 403 confirmaría que ese mensaje existe.
      return res.status(404).json({ error: 'Sin imagen' });
    }
    res.json({ data: m.foto });
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/mensajeria/contacto/:id/foto — el avatar de un compañero, fuera del listado.
// Acá no hace falta el control del par: el avatar de una persona del personal lo ve
// todo el personal (ya salía en la lista de contactos para todos). Solo se exige que
// sea alguien activo, igual que el resto del módulo.
router.get('/contacto/:id/foto', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'Id inválido' });
    const [[u]] = await pool.query('SELECT foto FROM usuarios WHERE id = ? AND activo = 1', [id]);
    if (!u || !u.foto) return res.status(404).json({ error: 'Sin imagen' });
    res.json({ data: u.foto });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
