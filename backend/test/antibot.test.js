const { test } = require('node:test');
const assert = require('node:assert');
const { honeypotLleno, turnstileOk } = require('../src/utils/antibot');

test('honeypot: campo lleno = bot; vacío o ausente = humano', () => {
  assert.equal(honeypotLleno({ website: 'http://spam' }), true);
  assert.equal(honeypotLleno({ website: '  algo ' }), true);
  assert.equal(honeypotLleno({ website: '' }), false);
  assert.equal(honeypotLleno({ website: '   ' }), false);
  assert.equal(honeypotLleno({}), false);
  assert.equal(honeypotLleno(null), false);
});

test('turnstile: sin TURNSTILE_SECRET la verificación se omite (degradación segura)', async () => {
  const prev = process.env.TURNSTILE_SECRET;
  delete process.env.TURNSTILE_SECRET;
  try {
    // Sin secret configurado, pasa siempre (aunque no haya token) y NO usa la red.
    const fetchOriginal = global.fetch;
    let fetchLlamado = false;
    global.fetch = async () => { fetchLlamado = true; return { ok: true, json: async () => ({}) }; };
    try {
      assert.equal(await turnstileOk(undefined), true);
      assert.equal(await turnstileOk('cualquier-token'), true);
      assert.equal(fetchLlamado, false, 'no debe contactar a Cloudflare sin secret');
    } finally {
      global.fetch = fetchOriginal;
    }
  } finally {
    if (prev !== undefined) process.env.TURNSTILE_SECRET = prev;
  }
});

test('turnstile: con secret pero sin token = bloquea (no llama a la red)', async () => {
  const prev = process.env.TURNSTILE_SECRET;
  process.env.TURNSTILE_SECRET = 'test-secret';
  const fetchOriginal = global.fetch;
  let fetchLlamado = false;
  global.fetch = async () => { fetchLlamado = true; return { ok: true, json: async () => ({ success: true }) }; };
  try {
    assert.equal(await turnstileOk(''), false);
    assert.equal(fetchLlamado, false, 'sin token no hace falta contactar a Cloudflare');
  } finally {
    global.fetch = fetchOriginal;
    if (prev !== undefined) process.env.TURNSTILE_SECRET = prev; else delete process.env.TURNSTILE_SECRET;
  }
});

test('turnstile: con secret + token válido según Cloudflare = pasa', async () => {
  const prev = process.env.TURNSTILE_SECRET;
  process.env.TURNSTILE_SECRET = 'test-secret';
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: true }) });
  try {
    assert.equal(await turnstileOk('token-ok', '1.2.3.4'), true);
  } finally {
    global.fetch = fetchOriginal;
    if (prev !== undefined) process.env.TURNSTILE_SECRET = prev; else delete process.env.TURNSTILE_SECRET;
  }
});

test('turnstile: rechazo explícito de Cloudflare = bloquea', async () => {
  const prev = process.env.TURNSTILE_SECRET;
  process.env.TURNSTILE_SECRET = 'test-secret';
  const fetchOriginal = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ success: false, 'error-codes': ['invalid-input-response'] }) });
  try {
    assert.equal(await turnstileOk('token-malo'), false);
  } finally {
    global.fetch = fetchOriginal;
    if (prev !== undefined) process.env.TURNSTILE_SECRET = prev; else delete process.env.TURNSTILE_SECRET;
  }
});

test('turnstile: error de red = falla-abierto (no bloquea)', async () => {
  const prev = process.env.TURNSTILE_SECRET;
  process.env.TURNSTILE_SECRET = 'test-secret';
  const fetchOriginal = global.fetch;
  const origErr = console.error;
  console.error = () => {};
  global.fetch = async () => { throw new Error('red caída'); };
  try {
    assert.equal(await turnstileOk('token'), true);
  } finally {
    global.fetch = fetchOriginal;
    console.error = origErr;
    if (prev !== undefined) process.env.TURNSTILE_SECRET = prev; else delete process.env.TURNSTILE_SECRET;
  }
});
