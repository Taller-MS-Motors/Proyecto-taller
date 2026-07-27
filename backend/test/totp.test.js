const { test } = require('node:test');
const assert = require('node:assert');
const totp = require('../src/utils/totp');

// Secreto de los vectores oficiales del RFC 6238 (ASCII '12345678901234567890').
const SECRETO_RFC = totp.base32Encode(Buffer.from('12345678901234567890'));

test('base32: ida y vuelta conserva los bytes', () => {
  assert.equal(totp.base32Decode(SECRETO_RFC).toString(), '12345678901234567890');
  assert.equal(SECRETO_RFC, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
});

// Si esto pasa, los códigos coinciden con Google Authenticator / Authy / 1Password.
test('genera los códigos de los vectores oficiales del RFC 6238', () => {
  const casos = [
    [1, '287082'],
    [37037036, '081804'],
    [37037037, '050471'],
    [41152263, '005924'],
    [66666666, '279037'],
    [666666666, '353130'],
  ];
  for (const [contador, esperado] of casos) {
    assert.equal(totp.codigoPara(SECRETO_RFC, contador), esperado, `contador ${contador}`);
  }
});

test('el secreto generado es base32 de 160 bits', () => {
  const s = totp.generarSecreto();
  assert.match(s, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Decode(s).length, 20);
});

test('acepta el código del momento actual', () => {
  const s = totp.generarSecreto();
  const ahora = Math.floor(Date.now() / 1000 / totp.PERIODO);
  assert.ok(totp.verificar(s, totp.codigoPara(s, ahora)));
});

test('tolera ±1 período por desfase de reloj, pero no ±2', () => {
  const s = totp.generarSecreto();
  const ahora = Math.floor(Date.now() / 1000 / totp.PERIODO);
  assert.ok(totp.verificar(s, totp.codigoPara(s, ahora - 1)), 'reloj atrasado 30s');
  assert.ok(totp.verificar(s, totp.codigoPara(s, ahora + 1)), 'reloj adelantado 30s');
  assert.equal(totp.verificar(s, totp.codigoPara(s, ahora + 5)), null, 'muy fuera de ventana');
});

test('rechaza códigos mal formados y de otro secreto', () => {
  const s = totp.generarSecreto();
  const otro = totp.generarSecreto();
  const ahora = Math.floor(Date.now() / 1000 / totp.PERIODO);
  assert.equal(totp.verificar(s, ''), null);
  assert.equal(totp.verificar(s, '12345'), null, 'menos de 6 dígitos');
  assert.equal(totp.verificar(s, 'abcdef'), null, 'no numérico');
  assert.equal(totp.verificar(s, totp.codigoPara(otro, ahora)), null, 'código de otra cuenta');
  assert.equal(totp.verificar(null, '123456'), null, 'sin secreto');
});

// Anti-replay: el mismo código no debe servir dos veces dentro de su ventana.
test('no acepta un código ya consumido (anti-replay)', () => {
  const s = totp.generarSecreto();
  const ahora = Math.floor(Date.now() / 1000 / totp.PERIODO);
  const codigo = totp.codigoPara(s, ahora);
  const contador = totp.verificar(s, codigo);
  assert.equal(contador, ahora);
  assert.equal(
    totp.verificar(s, codigo, { ultimoContador: contador }), null,
    'reusar el mismo código debe fallar'
  );
});

test('la URI otpauth lleva la clave y el emisor', () => {
  const s = totp.generarSecreto();
  const uri = totp.uriOtpauth(s, 'admin@taller.com');
  assert.ok(uri.startsWith('otpauth://totp/'));
  assert.ok(uri.includes(`secret=${s}`));
  assert.ok(uri.includes('issuer=MS+Motos'));
});

test('los códigos de respaldo son únicos y se normalizan al comparar', () => {
  const codigos = totp.generarCodigosRespaldo();
  assert.equal(codigos.length, 8);
  assert.equal(new Set(codigos).size, 8, 'no se repiten');
  for (const c of codigos) assert.match(c, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  // Da igual si lo teclean con guion, sin guion, en minúscula o con espacios.
  const c = codigos[0];
  const esperado = c.replace('-', '');
  assert.equal(totp.normalizarRespaldo(c), esperado);
  assert.equal(totp.normalizarRespaldo(c.toLowerCase()), esperado);
  assert.equal(totp.normalizarRespaldo(` ${esperado} `), esperado);
});
