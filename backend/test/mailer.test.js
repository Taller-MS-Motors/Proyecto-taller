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
