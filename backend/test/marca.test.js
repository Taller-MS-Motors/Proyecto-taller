const { test } = require('node:test');
const assert = require('node:assert');
const { logoDesdeDataUrl } = require('../src/routes/marca.routes');

// PNG de 1x1 transparente, en base64. Sirve para comprobar que lo que sale del
// endpoint son bytes de imagen de verdad y no el texto de la data URL.
const PNG_1x1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('decodifica una data URL a bytes de imagen', () => {
  const img = logoDesdeDataUrl(`data:image/png;base64,${PNG_1x1}`);
  assert.ok(img, 'debe reconocer la data URL');
  assert.equal(img.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(img.buffer));
  // Firma PNG: sin esto podríamos estar sirviendo cualquier cosa con el tipo correcto.
  assert.deepEqual([...img.buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test('acepta otros formatos de imagen', () => {
  assert.equal(logoDesdeDataUrl(`data:image/jpeg;base64,${PNG_1x1}`)?.contentType, 'image/jpeg');
  assert.equal(logoDesdeDataUrl(`data:image/svg+xml;base64,${PNG_1x1}`)?.contentType, 'image/svg+xml');
  assert.equal(logoDesdeDataUrl(`data:image/webp;base64,${PNG_1x1}`)?.contentType, 'image/webp');
});

// Los saltos de línea aparecen cuando el base64 viaja por ciertos clientes o se
// guarda a mano; sin limpiarlos, el decodificado sale corrupto.
test('tolera espacios y saltos de línea en el base64', () => {
  const conSaltos = `data:image/png;base64,${PNG_1x1.slice(0, 20)}\n  ${PNG_1x1.slice(20)}`;
  const img = logoDesdeDataUrl(conSaltos);
  assert.ok(img);
  assert.deepEqual([...img.buffer.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

// Todo lo que no sepamos interpretar debe devolver null para que el endpoint caiga al
// logo de la app, en vez de responder un archivo roto.
test('rechaza lo que no es una imagen en base64', () => {
  const invalidos = [
    null, undefined, '', 123, {},
    'https://ejemplo.com/logo.png',           // una URL, no una data URL
    'data:text/html;base64,PHNjcmlwdD4=',      // no es imagen: no se sirve
    'data:application/pdf;base64,JVBERi0=',    // idem
    'data:image/png,sin-base64',               // sin el marcador base64
    'data:image/png;base64,',                  // vacío
  ];
  for (const v of invalidos) {
    assert.equal(logoDesdeDataUrl(v), null, `deberia rechazar: ${JSON.stringify(v)}`);
  }
});
