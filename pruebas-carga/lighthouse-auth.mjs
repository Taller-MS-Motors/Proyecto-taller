// Lighthouse en pantallas que exigen sesión.
//
//   node pruebas-carga/lighthouse-auth.mjs
//
// Por qué hace falta: Lighthouse no sabe iniciar sesión. Si se le pide
// /portal/inicio, el guard de Angular lo manda a /portal/login y termina midiendo
// la pantalla equivocada — con el agravante de que el informe igual muestra un
// número, así que el error pasa desapercibido. (Comprobado: pidiendo /portal/inicio,
// `finalDisplayedUrl` era /portal/login.)
//
// Lo que hace este script: entra por la API, mete el token en localStorage —que es
// donde el portal guarda la sesión en web— y recién ahí lanza Lighthouse sobre el
// mismo navegador, con `disableStorageReset` para que no borre lo que acabamos de poner.
//
// Credenciales: por variables de entorno, nunca escritas acá.
//   PORTAL_EMAIL=cliente@correo.com PORTAL_PASS=... node pruebas-carga/lighthouse-auth.mjs
//
// Para el personal (admin/recepción/mecánico) usar LOGIN_STAFF=1: cambia el endpoint
// de login y las claves de sesión, que son distintas a las del portal del cliente.

import { createRequire } from 'module';
import { pathToFileURL } from 'url';
import { writeFileSync, mkdirSync } from 'fs';

// puppeteer-core y lighthouse ya vienen con la instalación de lighthouse por npx;
// se resuelven desde ahí para no sumar dependencias al proyecto.
const CACHE_NPX = process.env.NPX_CACHE ||
  'C:/Users/Menfi/AppData/Local/npm-cache/_npx/0f94ee7615faf582/';
const req = createRequire(CACHE_NPX);
const puppeteer = req('puppeteer-core');
const lighthouse = (await import(pathToFileURL(req.resolve('lighthouse')).href)).default;

const BASE = process.env.BASE || 'https://proyecto-taller-production-0e4b.up.railway.app';
const EDGE = process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ES_STAFF = process.env.LOGIN_STAFF === '1';

const EMAIL = process.env.PORTAL_EMAIL || process.env.EMAIL;
const PASS = process.env.PORTAL_PASS || process.env.PASS;
if (!EMAIL || !PASS) {
  console.error('Faltan credenciales. Ejemplo:\n' +
    '  PORTAL_EMAIL=cliente@correo.com PORTAL_PASS=... node pruebas-carga/lighthouse-auth.mjs');
  process.exit(1);
}

// Claves de sesión: las mismas que usan portal.service.ts y auth.service.ts.
const CLAVES = ES_STAFF
  ? { ruta: '/api/auth/login', token: 'tallerms_token', datos: 'tallerms_usuario', campo: 'usuario' }
  : { ruta: '/api/portal/login', token: 'tallerms_portal_token', datos: 'tallerms_portal_cliente', campo: 'cliente' };

// Pantallas a medir. Las del personal solo aplican con LOGIN_STAFF=1.
const PANTALLAS = (process.env.RUTAS || (ES_STAFF
  ? '/tabs/dashboard,/admin/resumen,/admin/citas,/recepcion,/mecanico'
  : '/portal/inicio,/portal/mis-citas,/portal/ofertas,/portal/motos')).split(',');

// 3 corridas y mediana, como pide la metodología del informe: una sola corrida
// mezcla el ruido de red con la medición.
const CORRIDAS = Number(process.env.CORRIDAS || 3);
const mediana = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

const salida = 'pruebas-carga/lighthouse';
mkdirSync(salida, { recursive: true });

console.log(`Entrando como ${ES_STAFF ? 'personal' : 'cliente'} en ${BASE} …`);
const r = await fetch(`${BASE}${CLAVES.ruta}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
});
if (!r.ok) {
  console.error(`Login falló (${r.status}). Revisá las credenciales.`);
  process.exit(1);
}
const cuerpo = await r.json();
const token = cuerpo?.data?.token;
const datos = cuerpo?.data?.[CLAVES.campo];
if (!token) {
  // Con 2FA activo el login devuelve un token parcial: no sirve para navegar.
  console.error('El login no devolvió token. ¿La cuenta tiene verificación en dos pasos?');
  process.exit(1);
}

const navegador = await puppeteer.launch({
  executablePath: EDGE,
  headless: 'new',
  args: ['--no-sandbox', '--disable-gpu'],
});
const puerto = Number(new URL(navegador.wsEndpoint()).port);

try {
  for (const ruta of PANTALLAS) {
    const url = `${BASE}${ruta}`;
    const nombre = ruta.replace(/\//g, '-').replace(/^-/, '');
    const puntajes = [];

    for (let i = 1; i <= CORRIDAS; i++) {
      // La sesión se siembra ANTES de cada corrida: Lighthouse abre pestaña propia y
      // el localStorage es por origen, así que basta con dejarlo puesto en el perfil.
      const pagina = await navegador.newPage();
      await pagina.goto(`${BASE}/portal/login`, { waitUntil: 'domcontentloaded' });
      await pagina.evaluate((k, t, kd, d) => {
        localStorage.setItem(k, t);
        if (d) localStorage.setItem(kd, JSON.stringify(d));
      }, CLAVES.token, token, CLAVES.datos, datos);
      await pagina.close();

      const res = await lighthouse(url, {
        port: puerto,
        output: 'json',
        logLevel: 'error',
        // Sin esto Lighthouse limpia el almacenamiento y se lleva la sesión puesta.
        disableStorageReset: true,
        screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1 },
        formFactor: 'desktop',
        throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1 },
      });

      const lhr = res.lhr;
      if (i === 1 && !lhr.finalDisplayedUrl.includes(ruta)) {
        console.warn(`  ⚠️  ${ruta} terminó en ${lhr.finalDisplayedUrl} — la sesión no se aplicó`);
      }
      puntajes.push({
        perf: Math.round(lhr.categories.performance.score * 100),
        a11y: Math.round(lhr.categories.accessibility.score * 100),
        lcp: lhr.audits['largest-contentful-paint'].numericValue,
        cls: lhr.audits['cumulative-layout-shift'].numericValue,
        tbt: lhr.audits['total-blocking-time'].numericValue,
      });
      if (i === CORRIDAS) writeFileSync(`${salida}/${nombre}.json`, JSON.stringify(lhr));
    }

    const m = (c) => mediana(puntajes.map((p) => p[c]));
    console.log(
      `${ruta.padEnd(22)} perf ${String(m('perf')).padStart(3)} | a11y ${m('a11y')} | ` +
      `LCP ${(m('lcp') / 1000).toFixed(1)}s | CLS ${m('cls').toFixed(3)} | TBT ${Math.round(m('tbt'))}ms`
    );
  }
} finally {
  await navegador.close();
}
