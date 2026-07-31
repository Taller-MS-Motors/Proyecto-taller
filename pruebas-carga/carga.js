// Prueba de CARGA — comportamiento bajo la carga esperada, sostenida.
//
//   k6 run -e BASE=http://localhost:3000 pruebas-carga/carga.js
//
// Recorre flujos reales del personal, no `GET /`:
//   login (una vez) → listar órdenes → listar clientes → ver promociones → crear cita
//
// El login va en setup() y el token se comparte entre todos los usuarios virtuales.
// No es por comodidad: el limitador permite 30 intentos de login por IP cada 15
// minutos, así que loguearse en cada iteración mediría el limitador, no la app. Y de
// paso refleja la realidad — una persona entra una vez y trabaja toda la mañana.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { SLO, umbrales } from './slo.js';

const BASE = __ENV.BASE || 'http://localhost:3000';
const EMAIL = __ENV.EMAIL || 'admin@taller.com';
const PASS = __ENV.PASS || 'Prueba.Carga.2026';

// Tamaño de respuesta: hace visible el costo de mandar imágenes en base64 dentro de
// los listados, que en el tiempo de respuesta solo se ve de refilón.
const pesoPromos = new Trend('peso_promos_kb');

export const options = {
  stages: [
    { duration: '30s', target: SLO.concurrentes },  // subida gradual
    { duration: '2m',  target: SLO.concurrentes },  // meseta: la carga sostenida
    { duration: '20s', target: 0 },                 // bajada
  ],
  thresholds: umbrales,
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const r = http.post(`${BASE}/api/auth/login`, JSON.stringify({ email: EMAIL, password: PASS }), {
    headers: { 'Content-Type': 'application/json' },
  });
  if (r.status !== 200) throw new Error(`Login falló (${r.status}): ${r.body}`);
  const token = r.json('data.token');

  // Se toman ids de clientes REALES de la base. Inventarlos hacía que cada alta
  // fallara por clave foránea, y la prueba terminaba midiendo el camino de error
  // en vez del de éxito.
  const cs = http.get(`${BASE}/api/clientes`, { headers: { Authorization: `Bearer ${token}` } });
  const ids = (cs.json('data') || []).map((c) => c.id).slice(0, 200);
  if (!ids.length) throw new Error('No hay clientes en la base de pruebas: sembrá con seed-carga.js');
  return { token, ids };
}

export default function (datos) {
  const params = (operacion) => ({
    headers: { Authorization: `Bearer ${datos.token}`, 'Content-Type': 'application/json' },
    tags: { operacion },
  });

  group('consultar', () => {
    const ordenes = http.get(`${BASE}/api/ordenes`, params('listar_ordenes'));
    check(ordenes, { 'órdenes 200': (r) => r.status === 200 });

    const clientes = http.get(`${BASE}/api/clientes`, params('listar_clientes'));
    check(clientes, { 'clientes 200': (r) => r.status === 200 });

    const promos = http.get(`${BASE}/api/promos`, params('listar_promos'));
    check(promos, { 'promos 200': (r) => r.status === 200 });
    pesoPromos.add(promos.body ? promos.body.length / 1024 : 0);
  });

  // Pausa entre acciones: una persona no dispara peticiones sin parar. Sin esto la
  // prueba mide un bombardeo que nunca va a ocurrir y el resultado no sirve.
  sleep(Math.random() * 2 + 1);

  // Solo una parte de las iteraciones escribe: en un taller se consulta mucho más de
  // lo que se agenda.
  if (Math.random() < 0.2) {
    group('agendar', () => {
      const dentroDe = new Date(Date.now() + (2 + Math.floor(Math.random() * 20)) * 86400000);
      const cita = http.post(`${BASE}/api/citas`, JSON.stringify({
        cliente_id: datos.ids[Math.floor(Math.random() * datos.ids.length)],
        fecha: dentroDe.toISOString().slice(0, 10),
        hora: `${String(8 + Math.floor(Math.random() * 8)).padStart(2, '0')}:00`,
        motivo: 'Prueba de carga',
        tipo_servicio: 'Cambio de aceite y filtros',
      }), params('crear_cita'));
      // 201 crea; 400/409 son respuestas legítimas (cupo lleno, datos inválidos).
      // Lo que no se acepta es 5xx: eso es la aplicación rompiéndose.
      check(cita, { 'cita sin error de servidor': (r) => r.status < 500 });
    });
    sleep(1);
  }
}
