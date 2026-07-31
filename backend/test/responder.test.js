const { test } = require('node:test');
const assert = require('node:assert');
const { fail } = require('../src/utils/responder');

// res falso que captura status() y json()
function fakeRes() {
  return {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

// Silencia el console.error que fail() emite a propósito.
function silenciandoErrores(fn) {
  const orig = console.error;
  console.error = () => {};
  try { fn(); } finally { console.error = orig; }
}

test('responde 500 genérico por defecto y no filtra el mensaje interno', () => {
  silenciandoErrores(() => {
    const res = fakeRes();
    fail(res, new Error('detalle interno con SQL secreto'));
    assert.equal(res._status, 500);
    assert.deepEqual(res._body, { error: 'Error interno del servidor' });
    assert.ok(!JSON.stringify(res._body).includes('SQL secreto'), 'no debe filtrar el detalle');
  });
});

test('acepta un status personalizado', () => {
  silenciandoErrores(() => {
    const res = fakeRes();
    fail(res, new Error('x'), 503);
    assert.equal(res._status, 503);
  });
});

// Errores de MySQL que describen un dato inválido del cliente, no una falla del
// servidor. Devolverlos como 500 hacía que un formulario mal llenado se viera igual
// que una caída real, tanto para el cliente como en el monitoreo.
test('los errores de dato inválido salen como 400, no 500', () => {
  for (const code of ['ER_NO_REFERENCED_ROW_2', 'ER_DUP_ENTRY', 'ER_DATA_TOO_LONG', 'ER_BAD_NULL_ERROR']) {
    const res = fakeRes();
    const origWarn = console.warn; console.warn = () => {};
    try { fail(res, { code, message: 'x', sqlMessage: 'x' }); } finally { console.warn = origWarn; }
    assert.equal(res._status, 400, `${code} debería ser 400`);
    assert.ok(res._body.error && res._body.error !== 'Error interno del servidor',
      `${code} debería explicar qué pasó`);
  }
});

test('un error inesperado sigue siendo 500 y no filtra el detalle', () => {
  const res = fakeRes();
  const origError = console.error; console.error = () => {};
  try { fail(res, new Error('SELECT secreto FROM interna')); } finally { console.error = origError; }
  assert.equal(res._status, 500);
  assert.equal(res._body.error, 'Error interno del servidor');
});
