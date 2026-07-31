// Limitadores de tasa por IP. Protegen el pool de conexiones y la CPU del proceso
// (sobre todo bcrypt en login) ante abuso o picos. Store en memoria: suficiente
// para una sola instancia; al escalar a varias, mover el store a Redis (ver SCALING.md).
const rateLimit = require('express-rate-limit');

// El store es por proceso. Con varios workers, una misma IP puede caer en cualquiera,
// así que el cupo efectivo sería el configurado MULTIPLICADO por la cantidad de
// workers — y el freno a la fuerza bruta del login se aflojaría en la misma
// proporción. Se reparte para que el límite visto desde afuera no cambie.
// (Es una aproximación: el reparto entre workers no es perfectamente parejo. La
// solución exacta es un store compartido en Redis — ver SCALING.md.)
const WORKERS = Math.max(1, Number(process.env.WEB_CONCURRENCY) || 1);
const porProceso = (total) => Math.max(1, Math.floor(total / WORKERS));

// General: toda la API. Generoso para no afectar el uso normal del SPA, pero
// frena un cliente que dispare miles de requests y sature la base.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minuto
  max: porProceso(600),       // 600 req/min por IP en total (~10/seg)
  standardHeaders: true,      // expone RateLimit-* headers
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Esperá un momento e intentá de nuevo.' },
});

// Autenticación: login/registro/recuperar. Estricto porque son el blanco de
// fuerza bruta y cada intento corre bcrypt (caro en CPU).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutos
  max: porProceso(30),        // 30 intentos por IP en la ventana, en total
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.' },
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: porProceso(120),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes al panel admin. Esperá un momento.' },
});

module.exports = { apiLimiter, authLimiter, adminLimiter };
