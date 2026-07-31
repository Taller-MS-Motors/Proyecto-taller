// Identidad del taller: lo que necesitan la factura, el PDF y los correos.
//
// Existe aparte de /api/admin/configuracion porque eso es solo para el admin, y estos
// datos los precisa cualquiera del personal (la factura la imprime recepción) e incluso
// un cliente de correo, que no manda ninguna sesión.
const router = require('express').Router();
const { getConfig } = require('../utils/configuracion');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');

// El logo se guarda como data URL en base64. Sirve para pintarlo en pantalla, pero NO
// dentro de un correo: Gmail y compañía descartan las imágenes `data:`. Por eso hace
// falta este endpoint, que lo devuelve como un archivo de imagen de verdad.
const LOGO_POR_DEFECTO = '/assets/logo/ms-logo-white.png';
const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/;

// Convierte el logo guardado (data URL) en bytes servibles. Devuelve null si no hay
// logo o si el valor no es una imagen en base64 que sepamos interpretar — el llamador
// cae entonces al archivo que trae la app.
// Va aparte para poder probarla: es la parte con lógica real de todo el módulo.
function logoDesdeDataUrl(logo) {
  const m = typeof logo === 'string' ? logo.match(DATA_URL_RE) : null;
  if (!m) return null;
  const buffer = Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  if (!buffer.length) return null;
  return { contentType: m[1], buffer };
}

// GET /api/marca/logo — imagen del taller. Público a propósito: lo pide el cliente de
// correo del destinatario, que no manda cabeceras de sesión.
router.get('/logo', async (req, res) => {
  try {
    const { logo } = await getConfig();
    const img = logoDesdeDataUrl(logo);
    if (!img) {
      // Sin logo cargado (o con un valor que no sabemos interpretar): se cae al que
      // viene con la app, para que nunca quede un hueco roto en el correo.
      return res.redirect(302, LOGO_POR_DEFECTO);
    }
    const { contentType, buffer } = img;
    res.set({
      'Content-Type': contentType,
      'Content-Length': buffer.length,
      // Corto a propósito: si cambian el logo, los correos siguientes lo toman enseguida.
      'Cache-Control': 'public, max-age=300',
    });
    res.send(buffer);
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/marca — datos del taller para encabezar documentos. Requiere sesión de
// personal: no expone nada sensible, pero tampoco hace falta que sea público.
router.get('/', auth, async (req, res) => {
  try {
    const c = await getConfig();
    res.json({
      data: {
        nombre_taller: c.nombre_taller,
        telefono: c.telefono,
        email: c.email,
        direccion: c.direccion,
        logo: c.logo || null,
        garantia_dias: c.garantia_dias,
        metodos_pago: c.metodos_pago,
      },
    });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
module.exports.logoDesdeDataUrl = logoDesdeDataUrl;
