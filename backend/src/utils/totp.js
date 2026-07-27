// TOTP (RFC 6238) — códigos de 6 dígitos que cambian cada 30 s, compatibles con
// Google Authenticator, Authy, 1Password, etc. Implementado sobre `crypto` de Node:
// es HMAC-SHA1 sobre un contador de tiempo, no amerita una dependencia externa.
const crypto = require('crypto');

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; // Base32, RFC 4648
const PERIODO = 30;  // segundos que dura cada código
const DIGITOS = 6;

// ── Base32 (el formato que usan las apps de autenticación para la clave) ──
function base32Encode(buf) {
  let bits = 0, valor = 0, salida = '';
  for (const byte of buf) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO[(valor >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO[(valor << (5 - bits)) & 31];
  return salida;
}

function base32Decode(str) {
  let bits = 0, valor = 0;
  const bytes = [];
  for (const c of String(str || '').toUpperCase().replace(/[\s=-]/g, '')) {
    const i = ALFABETO.indexOf(c);
    if (i < 0) continue; // ignora caracteres que no son del alfabeto
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// Secreto nuevo: 20 bytes aleatorios (160 bits, lo que recomienda la RFC) en base32.
function generarSecreto() {
  return base32Encode(crypto.randomBytes(20));
}

// Código de 6 dígitos para un contador de tiempo dado.
function codigoPara(secreto, contador) {
  const clave = base32Decode(secreto);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(contador));
  const hmac = crypto.createHmac('sha1', clave).update(msg).digest();
  // "Truncamiento dinámico" de la RFC: el último nibble dice dónde leer 4 bytes.
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITOS).padStart(DIGITOS, '0');
}

// Comparación en tiempo constante: no delata cuántos dígitos acertó por el timing.
function igualSeguro(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// Verifica un código. Devuelve el contador con el que coincidió (para guardarlo y
// evitar que el MISMO código se reuse dentro de su ventana), o null si no coincide.
//   ventana: cuántos períodos de 30 s se toleran hacia atrás/adelante por desfase
//            de reloj entre el teléfono y el servidor (1 = ±30 s, lo habitual).
//   ultimoContador: el último contador ya consumido por este usuario (anti-replay).
function verificar(secreto, codigo, { ventana = 1, ultimoContador = 0 } = {}) {
  if (!secreto) return null;
  const limpio = String(codigo || '').replace(/\D/g, '');
  if (limpio.length !== DIGITOS) return null;
  const ahora = Math.floor(Date.now() / 1000 / PERIODO);
  for (let d = -ventana; d <= ventana; d++) {
    const contador = ahora + d;
    if (contador <= Number(ultimoContador || 0)) continue; // ya se usó: no se repite
    if (igualSeguro(codigoPara(secreto, contador), limpio)) return contador;
  }
  return null;
}

// URI otpauth:// — al abrirla desde el teléfono, la app de autenticación se
// configura sola; en escritorio sirve para generar un QR o copiar la clave.
function uriOtpauth(secreto, cuenta, emisor = 'MS Motos') {
  const etiqueta = encodeURIComponent(`${emisor}:${cuenta}`);
  const params = new URLSearchParams({
    secret: secreto,
    issuer: emisor,
    algorithm: 'SHA1',
    digits: String(DIGITOS),
    period: String(PERIODO),
  });
  return `otpauth://totp/${etiqueta}?${params.toString()}`;
}

// Códigos de respaldo: si se pierde el teléfono, son la única forma de entrar.
// Se muestran UNA sola vez al activar; en la base solo quedan sus hashes.
function generarCodigosRespaldo(cantidad = 8) {
  const codigos = [];
  for (let i = 0; i < cantidad; i++) {
    // 8 caracteres hex en dos grupos ("A1B2-C3D4"): fáciles de anotar y teclear.
    const bruto = crypto.randomBytes(4).toString('hex').toUpperCase();
    codigos.push(`${bruto.slice(0, 4)}-${bruto.slice(4)}`);
  }
  return codigos;
}

// Normaliza un código de respaldo tecleado (sin guiones ni espacios, en mayúsculas)
// para poder compararlo contra el hash sin importar cómo lo hayan escrito.
function normalizarRespaldo(codigo) {
  return String(codigo || '').toUpperCase().replace(/[\s-]/g, '');
}

// Formatea el secreto en grupos de 4 para copiarlo a mano sin equivocarse.
function secretoLegible(secreto) {
  return String(secreto || '').replace(/(.{4})/g, '$1 ').trim();
}

module.exports = {
  PERIODO,
  DIGITOS,
  generarSecreto,
  codigoPara,
  verificar,
  uriOtpauth,
  generarCodigosRespaldo,
  normalizarRespaldo,
  secretoLegible,
  base32Encode,
  base32Decode,
};
