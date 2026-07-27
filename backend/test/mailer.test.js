const { test } = require('node:test');
const assert = require('node:assert');

// Modo degradado: sin RESEND_API_KEY no debe llamar a la red ni lanzar,
// solo loguear el código y devolver true (para que el flujo siga en desarrollo).
test('enviarCodigoReset sin API key devuelve true y no usa fetch', async () => {
  const prevKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  const fetchOriginal = global.fetch;
  let fetchLlamado = false;
  global.fetch = async () => { fetchLlamado = true; return { ok: true }; };

  const origLog = console.log;
  console.log = () => {};

  try {
    const { enviarCodigoReset } = require('../src/services/mailer');
    const ok = await enviarCodigoReset('user@correo.com', 'Ana', '123456');
    assert.equal(ok, true);
    assert.equal(fetchLlamado, false, 'no debe contactar a Resend sin API key');
  } finally {
    global.fetch = fetchOriginal;
    console.log = origLog;
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
  }
});

// Las plantillas nuevas (recordatorio de cita, aviso de estado) comparten el mismo
// núcleo de envío: en modo dev también degradan sin lanzar ni contactar la red.
test('enviarRecordatorioCita y enviarAvisoEstado degradan sin API key', async () => {
  const prevKey = process.env.RESEND_API_KEY;
  delete process.env.RESEND_API_KEY;

  const fetchOriginal = global.fetch;
  let fetchLlamado = false;
  global.fetch = async () => { fetchLlamado = true; return { ok: true }; };

  const origLog = console.log;
  console.log = () => {};

  try {
    const { enviarRecordatorioCita, enviarAvisoEstado } = require('../src/services/mailer');
    const ok1 = await enviarRecordatorioCita('cliente@correo.com', {
      nombre: 'Ana', hora: '10:00', servicio: 'Cambio de aceite', moto: 'Honda CB', sucursal: 'Liberia', taller: 'MS Motos',
    });
    const ok2 = await enviarAvisoEstado('cliente@correo.com', {
      nombre: 'Ana', titulo: 'Tu moto está lista', mensaje: 'Honda CB ya está lista.', taller: 'MS Motos',
    });
    assert.equal(ok1, true);
    assert.equal(ok2, true);
    assert.equal(fetchLlamado, false, 'no debe contactar a Resend sin API key');
  } finally {
    global.fetch = fetchOriginal;
    console.log = origLog;
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey;
  }
});

// Sin destinatario no se intenta enviar (guarda contra correos vacíos).
test('enviarCorreo sin destinatario devuelve false', async () => {
  const { enviarCorreo } = require('../src/services/mailer');
  const ok = await enviarCorreo({ to: '', subject: 'x', html: '<p>x</p>' });
  assert.equal(ok, false);
});

// Cambio de correo: el código va a la dirección NUEVA (recibirlo es la prueba de que
// existe) y el aviso a la ANTERIOR (para que el dueño real se entere si le robaron la
// sesión). Confundir los destinatarios rompería justamente la protección.
test('el codigo de cambio va al correo nuevo y el aviso al viejo', async () => {
  const prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'fake';
  process.env.RAILWAY_PUBLIC_DOMAIN = 'ejemplo.test';

  const fetchOriginal = global.fetch;
  const enviados = [];
  global.fetch = async (_url, opts) => { enviados.push(JSON.parse(opts.body)); return { ok: true }; };

  const origWarn = console.warn;
  console.warn = () => {};

  try {
    const { enviarCodigoCambioCorreo, enviarAvisoCambioCorreo } = require('../src/services/mailer');
    await enviarCodigoCambioCorreo('nuevo@correo.com', 'Ana', '482913');
    await enviarAvisoCambioCorreo('viejo@correo.com', 'Ana', 'nuevo@correo.com');

    const [codigo, aviso] = enviados;
    assert.deepEqual(codigo.to, ['nuevo@correo.com']);
    assert.ok(codigo.html.includes('482913'), 'el correo nuevo debe llevar el codigo');

    assert.deepEqual(aviso.to, ['viejo@correo.com']);
    assert.ok(!aviso.html.includes('482913'), 'el aviso al correo viejo NO debe llevar el codigo');
    assert.ok(aviso.html.includes('nuevo@correo.com'), 'el aviso debe decir a que direccion se muda');
  } finally {
    global.fetch = fetchOriginal;
    console.warn = origWarn;
    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey; else delete process.env.RESEND_API_KEY;
  }
});

// El logo se enlaza desde el dominio publico; sin dominio no se pone <img> para no
// dejar un hueco roto en la cabecera.
test('la cabecera usa el logo solo si hay dominio publico', async () => {
  const prevKey = process.env.RESEND_API_KEY;
  process.env.RESEND_API_KEY = 'fake';
  const fetchOriginal = global.fetch;
  let ultimo;
  global.fetch = async (_url, opts) => { ultimo = JSON.parse(opts.body); return { ok: true }; };
  const origWarn = console.warn;
  console.warn = () => {};

  try {
    const { enviarCodigoLogin } = require('../src/services/mailer');

    delete process.env.RAILWAY_PUBLIC_DOMAIN;
    delete process.env.APP_URL;
    await enviarCodigoLogin('a@b.com', 'Ana', '111111');
    assert.ok(!ultimo.html.includes('<img'), 'sin dominio publico no debe haber <img>');
    assert.ok(ultimo.html.includes('MS Motos') || ultimo.html.includes('Taller MS'));

    process.env.APP_URL = 'https://ejemplo.test/';
    await enviarCodigoLogin('a@b.com', 'Ana', '111111');
    assert.ok(ultimo.html.includes('<img'), 'con dominio publico debe llevar el logo');
    assert.ok(ultimo.html.includes('https://ejemplo.test/assets/logo/'), 'sin barra doble en la URL');
  } finally {
    global.fetch = fetchOriginal;
    console.warn = origWarn;
    delete process.env.APP_URL;
    if (prevKey !== undefined) process.env.RESEND_API_KEY = prevKey; else delete process.env.RESEND_API_KEY;
  }
});
