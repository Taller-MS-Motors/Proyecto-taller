// Prueba de ESTRÉS — hasta dónde aguanta y cómo se comporta al pasarse.
//
//   k6 run -e BASE=http://localhost:3000 pruebas-carga/estres.js
//
// A diferencia de carga.js, acá NO hay umbrales que deban cumplirse: la prueba no
// "falla", su resultado es el punto donde el sistema se degrada. Se sube en escalones
// para poder señalar en cuál se rompe, y se termina con un tramo de carga baja para
// ver si se recupera solo o queda tocado (que es la diferencia entre saturarse y
// caerse).
//
// Solo lectura: el objetivo es encontrar el techo de servicio, no llenar la base con
// decenas de miles de citas basura que después ensucien las mediciones.

import http from 'k6/http';
import { check } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE = __ENV.BASE || 'http://localhost:3000';
const EMAIL = __ENV.EMAIL || 'admin@taller.com';
const PASS = __ENV.PASS || 'Prueba.Carga.2026';

// Métricas por escalón: sin esto el resumen promedia todo y el punto de quiebre
// desaparece dentro de la media.
const errores = new Rate('errores_por_escalon');
const latencia = new Trend('latencia_por_escalon');

export const options = {
  stages: [
    { duration: '30s', target: 50 },
    { duration: '30s', target: 100 },
    { duration: '30s', target: 200 },
    { duration: '30s', target: 400 },
    { duration: '30s', target: 800 },
    { duration: '45s', target: 25 },   // ¿se recupera al bajar la carga?
    { duration: '15s', target: 0 },
  ],
  // Sin thresholds a propósito (ver arriba). Solo se corta si algo se va de madre.
  thresholds: {
    'http_req_duration': [{ threshold: 'p(99)<30000', abortOnFail: true, delayAbortEval: '30s' }],
  },
  summaryTrendStats: ['avg', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASS }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200) throw new Error(`Login falló (${r.status}): ${r.body}`);
  return { token: r.json('data.token') };
}

export default function (datos) {
  // El escalón se deduce de cuántos usuarios virtuales hay activos, y se guarda como
  // etiqueta para poder leer el resultado escalón por escalón.
  const vus = __ENV.K6_VUS || `${execVUs()}`;
  const params = {
    headers: { Authorization: `Bearer ${datos.token}` },
    tags: { escalon: escalonDe(Number(vus)) },
  };

  const r = http.get(`${BASE}/api/ordenes`, params);
  const ok = check(r, { 'sin error de servidor': (x) => x.status > 0 && x.status < 500 });
  errores.add(!ok, { escalon: params.tags.escalon });
  latencia.add(r.timings.duration, { escalon: params.tags.escalon });
}

// k6 no expone los VUs activos dentro de la iteración; se aproxima por el id del VU,
// que basta para agrupar en escalones.
function execVUs() {
  return __VU;
}
function escalonDe(n) {
  if (n <= 50) return '050';
  if (n <= 100) return '100';
  if (n <= 200) return '200';
  if (n <= 400) return '400';
  return '800';
}
