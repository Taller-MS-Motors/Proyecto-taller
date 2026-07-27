// Defensas anti-bot para endpoints públicos (registro, OTP, recuperación).
// Dos capas: honeypot (campo oculto) + Cloudflare Turnstile (captcha invisible).
// Degradación segura: sin TURNSTILE_SECRET, la verificación se OMITE (no rompe dev
// ni producción hasta que se configuren las llaves). El honeypot siempre aplica.

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Honeypot: un campo (`website`) que el formulario deja oculto. Un humano nunca lo
// llena; un bot que completa todo, sí. Si viene con contenido, es un bot.
function honeypotLleno(body) {
  const v = body && body.website;
  return typeof v === 'string' ? v.trim().length > 0 : !!v;
}

// Verifica el token de Cloudflare Turnstile contra el endpoint oficial.
// - Sin TURNSTILE_SECRET → devuelve true (función desactivada, degradación segura).
// - Con secret pero sin token → false (bloquea: falta el captcha).
// - Rechazo explícito de Cloudflare → false. Error de red/servicio → true
//   (falla-abierto: no dejamos afuera a usuarios legítimos si Cloudflare no responde).
async function turnstileOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  try {
    const params = new URLSearchParams({ secret, response: String(token) });
    if (ip) params.append('remoteip', String(ip));
    const resp = await fetch(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    if (!resp.ok) return true; // el servicio falló: no bloquear
    const data = await resp.json().catch(() => null);
    return !!(data && data.success);
  } catch (err) {
    console.error('⚠️  Turnstile no verificable:', err.message);
    return true; // error de red: falla-abierto
  }
}

// Middleware de Express: corre las dos capas antes del handler. El front manda el
// captcha en `turnstileToken` y el honeypot en `website`.
function antibot() {
  return async (req, res, next) => {
    try {
      if (honeypotLleno(req.body)) {
        // Respuesta genérica: no le confirmamos al bot que lo detectamos.
        return res.status(400).json({ error: 'No se pudo procesar la solicitud' });
      }
      const token = req.body && (req.body.turnstileToken || req.body.captcha);
      if (!(await turnstileOk(token, req.ip))) {
        return res.status(400).json({ error: 'Verificación de seguridad fallida. Recargá la página e intentá de nuevo.' });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { antibot, honeypotLleno, turnstileOk };
