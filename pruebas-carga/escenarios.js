// Escenarios E1–E6 — los seis flujos del informe, cada uno con su rol.
//
//   k6 run -e BASE=http://localhost:3000 pruebas-carga/escenarios.js
//
// `carga.js` mide UN flujo mixto de personal para sacar el número de carga sostenida.
// Este archivo es el complemento: recorre los seis escenarios funcionales que pide el
// informe, cada uno con el rol que lo ejecuta en la vida real, y etiqueta las métricas
// por escenario para poder leer cuál pesa más.
//
// Los seis corren en paralelo con pocos usuarios cada uno: el objetivo acá no es
// saturar (para eso está estres.js) sino comprobar que cada flujo completo responde
// dentro del SLO cuando el sistema está en uso normal.
//
// Requisitos: base sembrada con seed-carga.js y el backend con los límites de tasa
// elevados (ver "Cómo reproducir" en INFORME.md).

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SLO } from './slo.js';

const BASE = __ENV.BASE || 'http://localhost:3000';

// Personal. Un usuario por rol; el token se toma una vez en setup() (ver la nota
// sobre el limitador de login en carga.js).
const ADMIN = { email: __ENV.EMAIL || 'admin@taller.com', pass: __ENV.PASS || 'Prueba.Carga.2026' };
const RECEP = { email: __ENV.EMAIL_RECEP || 'recepcion@taller.com', pass: __ENV.PASS_RECEP || ADMIN.pass };
const TECNI = { email: __ENV.EMAIL_TECNICO || 'mecanico@taller.com', pass: __ENV.PASS_TECNICO || ADMIN.pass };
// Cliente del portal. seed-carga.js siembra este con contraseña conocida.
const CLIENTE = { email: __ENV.EMAIL_CLIENTE || 'cliente.carga@ejemplo.test', pass: __ENV.PASS_CLIENTE || 'Prueba.Carga.2026' };

const pausa = () => sleep(Math.random() * 2 + 1);
const hoy = () => new Date().toISOString().slice(0, 10);
const enDias = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);

// Cada escenario con pocos usuarios: se busca recorrer el flujo, no saturar.
const vus = Number(__ENV.VUS_ESCENARIO || 5);
const duracion = __ENV.DURACION || '2m';
const escenario = (exec, arranque) => ({
  executor: 'constant-vus', vus, duration: duracion, exec,
  startTime: arranque, tags: { escenario: exec },
});

export const options = {
  scenarios: {
    E1_cliente_agenda:   escenario('e1', '0s'),
    E2_cliente_sigue:    escenario('e2', '2s'),
    E3_recepcion_agenda: escenario('e3', '4s'),
    E4_admin_ordenes:    escenario('e4', '6s'),
    E5_mecanico_avance:  escenario('e5', '8s'),
    E6_admin_reportes:   escenario('e6', '10s'),
  },
  thresholds: {
    // Umbral por escenario: así se ve cuál incumple, no solo el promedio de todos.
    'http_req_duration{escenario:e1}': [`p(95)<${SLO.p95Escritura}`],
    'http_req_duration{escenario:e2}': [`p(95)<${SLO.p95}`],
    'http_req_duration{escenario:e3}': [`p(95)<${SLO.p95Escritura}`],
    'http_req_duration{escenario:e4}': [`p(95)<${SLO.p95}`],
    'http_req_duration{escenario:e5}': [`p(95)<${SLO.p95}`],
    'http_req_duration{escenario:e6}': [`p(95)<${SLO.p95}`],
    http_req_failed: [`rate<${SLO.errorMax}`],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

// ── setup: un login por rol, no por iteración ──────────────────────────────
function login(ruta, email, password) {
  const r = http.post(`${BASE}${ruta}`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
  });
  return r.status === 200 ? r.json('data.token') : null;
}

export function setup() {
  const admin = login('/api/auth/login', ADMIN.email, ADMIN.pass);
  if (!admin) throw new Error('No se pudo entrar como admin: revisá EMAIL/PASS');

  const cab = { headers: { Authorization: `Bearer ${admin}` } };
  const clientes = (http.get(`${BASE}/api/clientes`, cab).json('data') || []).map((c) => c.id).slice(0, 200);
  const ordenes = (http.get(`${BASE}/api/ordenes`, cab).json('data') || []).map((o) => o.id).slice(0, 200);
  if (!clientes.length) throw new Error('Base sin clientes: sembrá con seed-carga.js');

  // Los roles secundarios son opcionales: si el taller de pruebas no los tiene,
  // el escenario se salta en vez de romper toda la corrida.
  return {
    admin,
    recepcion: login('/api/auth/login', RECEP.email, RECEP.pass),
    tecnico: login('/api/auth/login', TECNI.email, TECNI.pass),
    cliente: login('/api/portal/login', CLIENTE.email, CLIENTE.pass),
    clientes, ordenes,
  };
}

const cab = (token, operacion) => ({
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  tags: { operacion },
});
const alAzar = (a) => a[Math.floor(Math.random() * a.length)];

// ── E1 · Cliente: entra → inicio → agenda una cita ─────────────────────────
export function e1(d) {
  if (!d.cliente) return;
  group('E1 cliente agenda', () => {
    check(http.get(`${BASE}/api/portal/resumen`, cab(d.cliente, 'portal_resumen')), { 'resumen 200': (r) => r.status === 200 });
    pausa();
    const motos = http.get(`${BASE}/api/portal/motos`, cab(d.cliente, 'portal_motos'));
    check(motos, { 'motos 200': (r) => r.status === 200 });
    const moto = (motos.json('data') || [])[0];
    if (!moto) return;
    pausa();
    // 400 es legítimo (cupo lleno, fuera de horario); 5xx no.
    const cita = http.post(`${BASE}/api/portal/citas`, JSON.stringify({
      moto_id: moto.id, fecha: enDias(3 + Math.floor(Math.random() * 15)),
      hora: `${String(8 + Math.floor(Math.random() * 8)).padStart(2, '0')}:00`,
      tipo_servicio: 'Cambio de aceite y filtros', descripcion: 'Prueba E1',
    }), cab(d.cliente, 'portal_crear_cita'));
    check(cita, { 'cita sin error de servidor': (r) => r.status < 500 });
  });
  pausa();
}

// ── E2 · Cliente: entra → mis citas → sigue una ────────────────────────────
export function e2(d) {
  if (!d.cliente) return;
  group('E2 cliente sigue', () => {
    const citas = http.get(`${BASE}/api/portal/citas`, cab(d.cliente, 'portal_citas'));
    check(citas, { 'citas 200': (r) => r.status === 200 });
    const lista = citas.json('data') || [];
    if (!lista.length) return;
    pausa();
    const una = alAzar(lista);
    check(http.get(`${BASE}/api/portal/citas/${una.id}`, cab(d.cliente, 'portal_detalle_cita')), {
      'detalle 200': (r) => r.status === 200,
    });
  });
  pausa();
}

// ── E3 · Recepción: recibe cliente → lo busca → agenda ─────────────────────
export function e3(d) {
  const token = d.recepcion || d.admin;
  group('E3 recepcion agenda', () => {
    check(http.get(`${BASE}/api/recepcion/citas-hoy`, cab(token, 'recepcion_hoy')), { 'hoy 200': (r) => r.status === 200 });
    pausa();
    // Búsqueda por nombre parcial: es lo que hace el mostrador con el cliente delante.
    check(http.get(`${BASE}/api/recepcion/clientes?q=a`, cab(token, 'recepcion_buscar')), {
      'buscar 200': (r) => r.status === 200,
    });
    pausa();
    const cita = http.post(`${BASE}/api/citas`, JSON.stringify({
      cliente_id: alAzar(d.clientes), fecha: enDias(2 + Math.floor(Math.random() * 20)),
      hora: `${String(8 + Math.floor(Math.random() * 8)).padStart(2, '0')}:00`,
      motivo: 'Prueba E3', tipo_servicio: 'Mantenimiento preventivo',
    }), cab(token, 'recepcion_crear_cita'));
    check(cita, { 'cita sin error de servidor': (r) => r.status < 500 });
  });
  pausa();
}

// ── E4 · Admin: órdenes → filtra → abre una → cambia estado ────────────────
export function e4(d) {
  group('E4 admin ordenes', () => {
    check(http.get(`${BASE}/api/ordenes`, cab(d.admin, 'admin_ordenes')), { 'ordenes 200': (r) => r.status === 200 });
    pausa();
    check(http.get(`${BASE}/api/ordenes?estado=diagnostico`, cab(d.admin, 'admin_ordenes_filtro')), {
      'filtro 200': (r) => r.status === 200,
    });
    if (!d.ordenes.length) return;
    pausa();
    check(http.get(`${BASE}/api/ordenes/${alAzar(d.ordenes)}`, cab(d.admin, 'admin_detalle_orden')), {
      'detalle 200': (r) => r.status === 200,
    });
    // El cambio de estado se deja fuera a propósito: las transiciones son válidas solo
    // desde ciertos estados, así que en una prueba masiva la mayoría daría 400 y se
    // mediría el camino de rechazo, no el trabajo real. Se cubre en las pruebas de API.
  });
  pausa();
}

// ── E5 · Mecánico: agenda del día → su cita → avance ───────────────────────
export function e5(d) {
  if (!d.tecnico) return;
  group('E5 mecanico avance', () => {
    check(http.get(`${BASE}/api/mecanico/resumen`, cab(d.tecnico, 'mecanico_resumen')), { 'resumen 200': (r) => r.status === 200 });
    pausa();
    check(http.get(`${BASE}/api/mecanico/agenda?desde=${hoy()}&hasta=${enDias(7)}`, cab(d.tecnico, 'mecanico_agenda')), {
      'agenda 200': (r) => r.status === 200,
    });
    pausa();
    check(http.get(`${BASE}/api/mecanico/citas`, cab(d.tecnico, 'mecanico_citas')), { 'citas 200': (r) => r.status === 200 });
  });
  pausa();
}

// ── E6 · Admin: reportes del mes ───────────────────────────────────────────
export function e6(d) {
  group('E6 admin reportes', () => {
    check(http.get(`${BASE}/api/admin/resumen`, cab(d.admin, 'admin_resumen')), { 'resumen 200': (r) => r.status === 200 });
    pausa();
    // Es la consulta más pesada del sistema: agrega facturación, rendimiento por
    // mecánico y cotizaciones sobre todo el periodo.
    check(http.get(`${BASE}/api/admin/reportes?periodo=mes`, cab(d.admin, 'admin_reportes_mes')), {
      'reportes mes 200': (r) => r.status === 200,
    });
    pausa();
    check(http.get(`${BASE}/api/admin/reportes?periodo=anio`, cab(d.admin, 'admin_reportes_anio')), {
      'reportes año 200': (r) => r.status === 200,
    });
  });
  pausa();
}
