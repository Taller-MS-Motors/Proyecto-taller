const { test } = require('node:test');
const assert = require('node:assert');
const { fechaLocalISO, horaLocal } = require('../src/utils/fecha');

// Timestamp fijo: 15 de enero de 2026, 02:00 UTC.
// En CR (offset -6) son las 20:00 del 14 de enero → la fecha local es un día antes.
const AHORA = Date.parse('2026-01-15T02:00:00Z');

test('fechaLocalISO ancla la fecha a la zona del taller (offset -6)', () => {
  assert.equal(fechaLocalISO(-6, 0, AHORA), '2026-01-14');
});

test('fechaLocalISO con masDias suma días naturales', () => {
  assert.equal(fechaLocalISO(-6, 1, AHORA), '2026-01-15'); // "mañana" local
  assert.equal(fechaLocalISO(-6, -1, AHORA), '2026-01-13'); // "ayer" local
});

test('fechaLocalISO con offset 0 usa la fecha UTC', () => {
  assert.equal(fechaLocalISO(0, 0, AHORA), '2026-01-15');
});

test('horaLocal desplaza la hora por el offset', () => {
  assert.equal(horaLocal(-6, AHORA), '20:00');
  assert.equal(horaLocal(0, AHORA), '02:00');
});
