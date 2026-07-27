const { test } = require('node:test');
const assert = require('node:assert');
const jwt = require('jsonwebtoken');

// El middleware lee process.env.JWT_SECRET al verificar: lo fijamos antes de importarlo.
process.env.JWT_SECRET = 'test-secret';
const auth = require('../src/middleware/auth');

// res falso que captura status() y json().
function fakeRes() {
  return {
    _status: null, _body: null,
    status(c) { this._status = c; return this; },
    json(b) { this._body = b; return this; },
  };
}
function reqCon(token) {
  return { headers: token ? { authorization: `Bearer ${token}` } : {} };
}

test('rechaza (401) si falta el header Authorization', () => {
  const res = fakeRes(); let llamado = false;
  auth(reqCon(null), res, () => { llamado = true; });
  assert.equal(res._status, 401);
  assert.equal(llamado, false);
});

test('rechaza (401) un token inválido', () => {
  const res = fakeRes(); let llamado = false;
  auth(reqCon('no-es-un-jwt'), res, () => { llamado = true; });
  assert.equal(res._status, 401);
  assert.equal(llamado, false);
});

// Núcleo del fix CRÍTICO #1: un token del portal (tipo:'cliente') NO sirve en staff.
test('rechaza (403) un token de cliente del portal', () => {
  const token = jwt.sign({ id: 9, tipo: 'cliente', nombre: 'Marco' }, process.env.JWT_SECRET);
  const res = fakeRes(); let llamado = false;
  auth(reqCon(token), res, () => { llamado = true; });
  assert.equal(res._status, 403);
  assert.equal(llamado, false, 'no debe continuar a la ruta de staff');
});

test('rechaza (403) un token sin rol', () => {
  const token = jwt.sign({ id: 1, nombre: 'X' }, process.env.JWT_SECRET);
  const res = fakeRes(); let llamado = false;
  auth(reqCon(token), res, () => { llamado = true; });
  assert.equal(res._status, 403);
  assert.equal(llamado, false);
});

// 2FA: el token parcial (contraseña ok, falta el código) no es una sesión válida.
test('rechaza (403) un token parcial de 2FA aunque traiga rol', () => {
  const token = jwt.sign({ id: 3, rol: 'admin', pend2fa: true }, process.env.JWT_SECRET);
  const res = fakeRes(); let llamado = false;
  auth(reqCon(token), res, () => { llamado = true; });
  assert.equal(res._status, 403);
  assert.equal(llamado, false, 'un login a medias no debe abrir sesión');
});

test('acepta un token de staff y expone req.usuario', () => {
  const token = jwt.sign({ id: 5, rol: 'recepcion', nombre: 'Ana' }, process.env.JWT_SECRET);
  const req = reqCon(token); const res = fakeRes(); let llamado = false;
  auth(req, res, () => { llamado = true; });
  assert.equal(llamado, true);
  assert.equal(res._status, null, 'no debe responder error');
  assert.equal(req.usuario.rol, 'recepcion');
  assert.equal(req.usuario.id, 5);
});
