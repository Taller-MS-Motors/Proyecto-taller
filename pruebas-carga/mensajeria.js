// Prueba de MENSAJERÍA — cuánto aguanta el chat interno.
//
//   k6 run -e BASE=http://localhost:3000 pruebas-carga/mensajeria.js
//
// El chat es el módulo que quedó sin medir en el informe y el que más se parece al
// caso de las promociones (hallazgo 2): el hilo devuelve los últimos 200 mensajes
// CON su foto embebida en base64.
//
// Lo que hace distinto a este módulo es que el frontend NO espera a que el usuario
// haga algo: `chat-hilo` refresca el hilo cada 12 s y `chat-contactos` recarga la
// lista cada 15 s, mientras la pantalla esté abierta. O sea, el costo no depende de
// cuánto se chatea sino de cuánta gente tiene el chat abierto.
//
// Por eso este escenario NO simula "personas escribiendo": simula personas con el
// chat ABIERTO, que es el patrón real y el que genera el tráfico.

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { SLO } from './slo.js';

const BASE = __ENV.BASE || 'http://localhost:3000';
const EMAIL = __ENV.EMAIL || 'admin@taller.com';
const PASS = __ENV.PASS || 'Prueba.Carga.2026';

// Cuántas personas con el chat abierto a la vez.
const ABIERTOS = Number(__ENV.ABIERTOS || 10);

// Estas dos métricas son el corazón de la prueba: el tiempo dice poco si no se ve
// cuántos bytes mueve cada refresco.
const pesoHilo = new Trend('peso_hilo_kb');
const pesoContactos = new Trend('peso_contactos_kb');
const bytesTotales = new Counter('bytes_chat_total');

export const options = {
  scenarios: {
    // Refresco del hilo abierto: cada 12 s, como hace el componente real.
    hilo_abierto: {
      executor: 'constant-vus', vus: ABIERTOS, duration: '2m', exec: 'hilo',
    },
    // Refresco de la lista de contactos: cada 15 s.
    lista_contactos: {
      executor: 'constant-vus', vus: ABIERTOS, duration: '2m', exec: 'contactos', startTime: '3s',
    },
  },
  thresholds: {
    'http_req_duration{op:hilo}': [`p(95)<${SLO.p95}`],
    'http_req_duration{op:contactos}': [`p(95)<${SLO.p95}`],
    http_req_failed: [`rate<${SLO.errorMax}`],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASS }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200) throw new Error(`Login falló (${r.status}): ${r.body}`);
  const token = r.json('data.token');

  // Con quién chatear: cualquier otro miembro del personal.
  const c = http.get(`${BASE}/api/mensajeria/contactos`, { headers: { Authorization: `Bearer ${token}` } });
  const contactos = (c.json('data.contactos') || []).map((x) => x.id);
  if (!contactos.length) throw new Error('No hay otro empleado activo para chatear: creá al menos dos');
  return { token, contactos };
}

const cab = (t, op) => ({ headers: { Authorization: `Bearer ${t}` }, tags: { op } });

// Persona con una conversación abierta: el componente la refresca cada 12 s.
export function hilo(d) {
  const otro = d.contactos[Math.floor(Math.random() * d.contactos.length)];
  const r = http.get(`${BASE}/api/mensajeria/conversacion/${otro}`, cab(d.token, 'hilo'));
  check(r, { 'hilo 200': (x) => x.status === 200 });
  const kb = r.body ? r.body.length / 1024 : 0;
  pesoHilo.add(kb);
  bytesTotales.add(r.body ? r.body.length : 0);
  sleep(12);
}

// Persona en la pantalla de mensajes: la lista se recarga cada 15 s.
export function contactos(d) {
  const r = http.get(`${BASE}/api/mensajeria/contactos`, cab(d.token, 'contactos'));
  check(r, { 'contactos 200': (x) => x.status === 200 });
  pesoContactos.add(r.body ? r.body.length / 1024 : 0);
  bytesTotales.add(r.body ? r.body.length : 0);
  sleep(15);
}
