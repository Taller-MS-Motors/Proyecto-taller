require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const { testConnection } = require('./db/pool');
const { ensureSchema } = require('./db/auto-migrate');
const { iniciarJobs } = require('./jobs/scheduler');
const { apiLimiter, authLimiter, adminLimiter } = require('./middleware/rate-limit');

const app = express();
const frontendDist = path.join(__dirname, '../../frontend/www');
const hasFrontend = fs.existsSync(path.join(frontendDist, 'index.html'));
const esProduccion = process.env.NODE_ENV === 'production' || hasFrontend;

// JWT_SECRET es obligatorio: sin él, firmar/verificar tokens es inseguro o rompe.
// En producción abortamos con un mensaje claro; en dev usamos un secreto efímero
// con aviso ruidoso para no frenar el trabajo local.
if (!process.env.JWT_SECRET) {
  if (esProduccion) {
    console.error('❌ Falta JWT_SECRET. Definí la variable de entorno antes de arrancar.');
    process.exit(1);
  }
  process.env.JWT_SECRET = 'dev-inseguro-no-usar-en-produccion';
  console.warn('⚠️  JWT_SECRET no definido: usando secreto de desarrollo (NO usar en producción).');
}

if (esProduccion) {
  if (!process.env.CORS_ORIGIN && !hasFrontend) {
    console.warn('⚠️  CORS_ORIGIN no definido en producción. Usando default restrictivo.');
  }
  if (!process.env.DB_HOST || !process.env.DB_NAME) {
    console.warn('⚠️  Variables de DB incompletas (DB_HOST, DB_NAME). Verificá la configuración.');
  }
}

// En producción la app va detrás del proxy de Railway: confiar en el primer hop
// para que req.ip sea la IP real del cliente (necesario para el rate limiting).
if (esProduccion) app.set('trust proxy', 1);

// No revelar el framework (Express manda "X-Powered-By" por defecto): menos pistas
// para un atacante que busca vulnerabilidades conocidas del stack.
app.disable('x-powered-by');

// Compresión gzip/brotli de las respuestas (JSON y estáticos). Recorta el ancho
// de banda de forma notable, sobre todo en listados.
app.use(compression());

// Headers de seguridad (sin dependencias externas).
// CSP: endurecido pero compatible con el SPA de Angular/Ionic. Se permite
// 'unsafe-inline' en script/style porque Ionic inyecta estilos inline y las
// ventanas de impresión (comprobantes/PDF, abiertas con window.open + document.write)
// usan un <script>window.print()</script> inline que heredaría este CSP. Aun así se
// bloquea lo más peligroso: orígenes externos de script, <object>/<embed>, secuestro
// de <base>, envío de formularios a terceros y el enmarcado del sitio (anti-clickjacking).
// Nota: solo afecta a la web servida por este server; la app nativa (Capacitor) carga
// sus propios assets y no recibe estas cabeceras.
// Google Fonts: index.html carga la hoja de estilos desde fonts.googleapis.com y
// las tipografías desde fonts.gstatic.com — se permiten explícitamente en style/font.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Content-Security-Policy', CSP);
  // Aísla el contexto de navegación pero deja funcionar los popups (impresión de comprobantes).
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  // El sitio web no usa cámara/micrófono/ubicación: se niegan por completo.
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (esProduccion) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

// CORS: la app nativa (Capacitor) llama a la API desde un origen distinto
// (capacitor://localhost en iOS, https://localhost o http://localhost en Android),
// así que los headers CORS deben enviarse SIEMPRE — antes solo se aplicaban sin
// frontend embebido y la app instalada quedaba bloqueada por el WebView.
// La web servida por este mismo server es same-origin y no se ve afectada.
// CORS_ORIGIN admite orígenes extra separados por coma.
const ORIGENES_PERMITIDOS = new Set([
  'capacitor://localhost',  // iOS (WebView de Capacitor)
  'https://localhost',      // Android (androidScheme https, default de Capacitor)
  'http://localhost',       // Android (androidScheme http)
  'http://localhost:8100',  // ionic serve en desarrollo
  ...(process.env.CORS_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean),
]);
app.use(cors({
  // Sin header Origin (same-origin, curl, healthcheck) se permite sin emitir CORS.
  origin: (origin, cb) => cb(null, !origin || ORIGENES_PERMITIDOS.has(origin)),
}));

app.use(express.json({ limit: '10mb' }));

// Health check exento del rate limiting (lo sondea la plataforma con frecuencia).
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// Rate limiting: estricto en autenticación (fuerza bruta + bcrypt), general en el resto.
app.use(['/api/auth/login', '/api/portal/login', '/api/portal/registro', '/api/portal/recuperar', '/api/portal/otp'], authLimiter);
app.use('/api', apiLimiter);
app.use('/api/admin', adminLimiter);

app.use('/api/auth',      require('./routes/auth.routes'));
app.use('/api/clientes',  require('./routes/clientes.routes'));
app.use('/api/motos',     require('./routes/motos.routes'));
app.use('/api/ordenes',   require('./routes/ordenes.routes'));
app.use('/api/citas',     require('./routes/citas.routes'));
app.use('/api/usuarios',  require('./routes/usuarios.routes'));
app.use('/api/dashboard', require('./routes/dashboard.routes'));
app.use('/api/garantias', require('./routes/garantias.routes'));
app.use('/api/portal',    require('./routes/portal.routes'));
app.use('/api/promos',    require('./routes/promos.routes'));
app.use('/api/mecanico',  require('./routes/mecanico.routes'));
app.use('/api/recepcion', require('./routes/recepcion.routes'));
app.use('/api/mensajeria', require('./routes/mensajeria.routes'));
app.use('/api/admin',     require('./routes/admin.routes'));

app.use('/api', (err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});

if (hasFrontend) {
  app.use(express.static(frontendDist));
  app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(frontendDist, 'index.html'));
  });
  console.log('🌐 Sirviendo frontend desde', frontendDist);
} else {
  console.log('⚡ Modo desarrollo: frontend en http://localhost:8100');
}

const PORT = process.env.PORT || 3000;
// Corre la auto-migración ANTES de aceptar requests, así no hay una ventana
// donde la base esté a medio migrar mientras el server ya responde.
(async () => {
  await testConnection();
  await ensureSchema();
  // Tareas de fondo (recordatorios de cita, no-show). Después de migrar, para que
  // las columnas que usan (recordatorio_enviado, no_show) ya existan.
  iniciarJobs();
  app.listen(PORT, () => console.log(`🚀 Servidor en http://localhost:${PORT}`));
})();
