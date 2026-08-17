// Medición de INP con interacción real.
//
//   PORTAL_EMAIL=... PORTAL_PASS=... node pruebas-carga/medir-inp.mjs
//
// INP (Interaction to Next Paint) mide cuánto tarda la interfaz en pintar la
// respuesta a un toque. Por definición **no existe sin interacción**, y por eso
// Lighthouse —que carga la página y la mide sin tocarla— nunca lo reporta.
//
// Este script abre un navegador de verdad, inicia sesión, hace clics reales sobre
// los elementos de cada pantalla y lee el INP que informa la librería oficial de
// Google. No es lo mismo que datos de campo de muchos usuarios, pero es una
// medición real del tiempo de respuesta de la interfaz, no una estimación.

import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { rutaNpx } from './npx-cache.mjs';

// El navegador lo maneja puppeteer-core, que ya viene con la instalación de Lighthouse
// por npx. La carpeta lleva un hash distinto en cada equipo: se busca (ver npx-cache.mjs).
const puppeteer = createRequire(rutaNpx(['puppeteer-core']))('puppeteer-core');

const BASE = process.env.BASE || 'https://proyecto-taller-production-0e4b.up.railway.app';
const EDGE = process.env.CHROME_PATH ||
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ES_STAFF = process.env.LOGIN_STAFF === '1';
const EMAIL = process.env.PORTAL_EMAIL || process.env.EMAIL;
const PASS = process.env.PORTAL_PASS || process.env.PASS;

const CLAVES = ES_STAFF
  ? { ruta: '/api/auth/login', token: 'tallerms_token', datos: 'tallerms_usuario', campo: 'usuario' }
  : { ruta: '/api/portal/login', token: 'tallerms_portal_token', datos: 'tallerms_portal_cliente', campo: 'cliente' };

const RUTAS = (process.env.RUTAS || '/portal/inicio,/portal/mis-citas,/portal/motos').split(',');
// La librería se inyecta en la página: así mide dentro del navegador, igual que
// lo haría en producción.
const LIB = readFileSync('frontend/node_modules/web-vitals/dist/web-vitals.iife.js', 'utf8');

if (!EMAIL || !PASS) { console.error('Faltan credenciales'); process.exit(1); }

const r = await fetch(`${BASE}${CLAVES.ruta}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
});
if (!r.ok) { console.error(`Login falló (${r.status})`); process.exit(1); }
const cuerpo = await r.json();
const token = cuerpo?.data?.token;
const datos = cuerpo?.data?.[CLAVES.campo];
if (!token) { console.error('Sin token (¿2FA activo?)'); process.exit(1); }

const navegador = await puppeteer.launch({
  executablePath: EDGE, headless: 'new', args: ['--no-sandbox', '--disable-gpu'],
});

console.log(`INP con interacción real · ${BASE}\n`);
try {
  for (const ruta of RUTAS) {
    const pagina = await navegador.newPage();
    await pagina.setViewport({ width: 1350, height: 940 });

    // Sesión primero, en el origen correcto.
    await pagina.goto(`${BASE}/portal/login`, { waitUntil: 'domcontentloaded' });
    await pagina.evaluate((k, t, kd, d) => {
      localStorage.setItem(k, t);
      if (d) localStorage.setItem(kd, JSON.stringify(d));
    }, CLAVES.token, token, CLAVES.datos, datos);

    // La librería se inyecta ANTES de navegar, para que observe desde el arranque.
    await pagina.evaluateOnNewDocument(`${LIB};
      window.__inp = [];
      webVitals.onINP((m) => window.__inp.push(Math.round(m.value)), { reportAllChanges: true });
    `);

    await pagina.goto(`${BASE}${ruta}`, { waitUntil: 'networkidle2' });
    await new Promise((s) => setTimeout(s, 1500));

    // Interacciones reales: se hace clic sobre elementos que la persona tocaría.
    // Cada clic genera una interacción medible; INP se queda con la peor.
    const clicables = await pagina.$$('ion-button, button, ion-item, ion-tab-button, .card, ion-card');
    let hechos = 0;
    for (const el of clicables.slice(0, 8)) {
      try {
        await el.click({ delay: 30 });
        hechos++;
        await new Promise((s) => setTimeout(s, 400));
      } catch { /* elemento tapado o que navegó: se sigue con el resto */ }
    }

    // INP se consolida al ocultarse la página; se fuerza ese evento.
    await pagina.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await new Promise((s) => setTimeout(s, 600));
    const medidas = await pagina.evaluate(() => window.__inp || []);
    await pagina.close();

    const inp = medidas.length ? Math.max(...medidas) : null;
    const estado = inp == null ? '' : inp <= 200 ? ' ✅' : inp <= 500 ? ' ⚠️' : ' ❌';
    console.log(
      `${ruta.padEnd(22)} INP ${inp == null ? 'sin dato' : inp + ' ms'}${estado}` +
      `   (${hechos} interacciones)`
    );
  }
} finally {
  await navegador.close();
}
