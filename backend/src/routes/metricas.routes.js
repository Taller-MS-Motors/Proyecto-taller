const router = require('express').Router();
const { pool } = require('../db/pool');
const { fail } = require('../utils/responder');
const auth = require('../middleware/auth');
const requireRol = require('../middleware/roles');

// Core Web Vitals medidos en los navegadores de la gente que usa la app.
//
// Por qué hace falta: Lighthouse mide en laboratorio y no interactúa con la página,
// así que no puede reportar INP —que es, justamente, el tiempo que tarda la interfaz
// en responder a un toque—. La única forma de tener ese número es que lo mida el
// navegador real y lo mande.

const METRICAS = ['LCP', 'CLS', 'INP', 'FCP', 'TTFB'];

// POST /api/metricas/web-vitals — lo llama el navegador, sin sesión.
//
// Es público a propósito: las métricas más valiosas son las del login y el registro,
// que ocurren antes de que exista un token. A cambio se valida con dureza y solo se
// guardan los cinco nombres conocidos: es un endpoint de escritura abierto, así que
// no puede aceptar nada que venga en el cuerpo.
router.post('/web-vitals', async (req, res) => {
  try {
    const { metrica, valor, calificacion, ruta, movil } = req.body || {};
    if (!METRICAS.includes(metrica)) return res.status(400).json({ error: 'Métrica no válida' });

    const n = Number(valor);
    // Un valor negativo o absurdo solo puede venir de un cliente manipulado; el tope
    // de 10 min descarta además pestañas que estuvieron en segundo plano.
    if (!Number.isFinite(n) || n < 0 || n > 600000) return res.status(400).json({ error: 'Valor no válido' });

    // Solo la ruta, recortada: sin querystring (puede traer datos) y sin dominio.
    const rutaLimpia = String(ruta || '/').split('?')[0].slice(0, 200);

    await pool.query(
      'INSERT INTO web_vitals (metrica, valor, calificacion, ruta, movil) VALUES (?, ?, ?, ?, ?)',
      [metrica, n, String(calificacion || '').slice(0, 20) || null, rutaLimpia, movil ? 1 : 0]
    );
    // 204: el navegador manda esto con sendBeacon al cerrar la pestaña y no espera cuerpo.
    res.status(204).end();
  } catch (err) {
    fail(res, err);
  }
});

// GET /api/metricas/web-vitals — resumen para el informe y el panel. Solo admin.
//
// Se reporta el percentil 75, que es el criterio de Google: una métrica "cumple" si
// el 75 % de las visitas la cumple. El promedio escondería justo la cola lenta.
router.get('/web-vitals', auth, requireRol('admin'), async (req, res) => {
  try {
    const dias = Math.min(Math.max(Number(req.query.dias) || 30, 1), 365);
    const [filas] = await pool.query(
      `SELECT metrica, valor FROM web_vitals
       WHERE created_at >= NOW() - INTERVAL ? DAY
       ORDER BY metrica, valor`,
      [dias]
    );

    // El p75 se calcula acá y no en SQL: MySQL no tiene percentiles nativos y la
    // alternativa (variables de sesión) es frágil y difícil de leer.
    const porMetrica = {};
    for (const f of filas) (porMetrica[f.metrica] = porMetrica[f.metrica] || []).push(f.valor);

    const UMBRAL = { LCP: 2500, CLS: 0.1, INP: 200, FCP: 1800, TTFB: 800 };
    const data = METRICAS.map((m) => {
      const xs = porMetrica[m] || [];
      if (!xs.length) return { metrica: m, muestras: 0, p75: null, umbral: UMBRAL[m], cumple: null };
      const p75 = xs[Math.min(Math.floor(xs.length * 0.75), xs.length - 1)];
      return { metrica: m, muestras: xs.length, p75, umbral: UMBRAL[m], cumple: p75 <= UMBRAL[m] };
    });

    res.json({ data, dias });
  } catch (err) {
    fail(res, err);
  }
});

module.exports = router;
