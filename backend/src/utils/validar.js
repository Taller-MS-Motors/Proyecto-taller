// Validaciones compartidas del backend.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Verifica que el string tenga forma de correo válido.
const emailValido = (e) => EMAIL_RE.test(String(e || '').trim());

// Valida una imagen recibida como data URL base64 (foto de perfil, evidencia, logo...).
// Acepta:
//   - null / '' / undefined  → el llamador la guarda como NULL (se permite "quitar foto").
//   - data URL de imagen (png/jpeg/webp/gif) de hasta ~6 MB de string base64.
// No valida los bytes reales (magic number) — solo el prefijo declarado y el tamaño;
// el resto del sistema confía en que Angular sanea cualquier binding [src]/[href].
const FOTO_MAX_LEN = 4 * 1024 * 1024; // ~4 MB de string base64 (mismo tope que el portal; el front ya comprime antes de subir)
const FOTO_RE = /^data:image\/(png|jpe?g|webp|gif);base64,/i;
function fotoValida(foto) {
  if (foto === null || foto === undefined || foto === '') return true;
  return typeof foto === 'string' && FOTO_RE.test(foto) && foto.length <= FOTO_MAX_LEN;
}

// Verifica que un texto libre (ya trimeado) no exceda el tope de la app.
// Tolera null/undefined/'' (la obligatoriedad se revisa aparte, en el llamador).
function textoDentroDeLimite(str, max) {
  if (str === null || str === undefined || str === '') return true;
  return String(str).trim().length <= max;
}

// Cédula costarricense: física (9 dígitos), jurídica (10) o DIMEX/extranjero (11-12).
// Acepta guiones/espacios como separadores, se comparan solo los dígitos.
// Tolera vacío: la obligatoriedad se revisa aparte, en el llamador.
const CEDULA_RE = /^\d{9,12}$/;
function cedulaValida(cedula) {
  if (cedula === null || cedula === undefined || cedula === '') return true;
  const soloDigitos = String(cedula).replace(/[\s-]/g, '');
  return CEDULA_RE.test(soloDigitos);
}

// Teléfono costarricense: 8 dígitos, con o sin indicativo +506.
// Acepta guiones/espacios como separadores, se comparan solo los dígitos.
// Tolera vacío: la obligatoriedad se revisa aparte, en el llamador.
const TELEFONO_RE = /^(\+?506)?\d{8}$/;
function telefonoValido(telefono) {
  if (telefono === null || telefono === undefined || telefono === '') return true;
  const soloDigitos = String(telefono).replace(/[\s-]/g, '');
  return TELEFONO_RE.test(soloDigitos);
}

// Año de fabricación de la moto: entero entre 1980 y el año próximo (permite modelos "del año siguiente").
// Tolera vacío: el campo es opcional en las rutas actuales.
const ANIO_MINIMO = 1980;
function anioValido(anio) {
  if (anio === null || anio === undefined || anio === '') return true;
  const n = Number(anio);
  const anioMaximo = new Date().getFullYear() + 1;
  return Number.isInteger(n) && n >= ANIO_MINIMO && n <= anioMaximo;
}

// Placa de moto: alfanumérica, entre 4 y 10 caracteres una vez quitados espacios/guiones
// (mismo criterio de normalización que utils/placa.js). Tolera vacío: la obligatoriedad
// se revisa aparte, en el llamador.
const PLACA_RE = /^[A-Z0-9]{4,10}$/;
function placaValida(placa) {
  if (placa === null || placa === undefined || placa === '') return true;
  const normalizada = String(placa).toUpperCase().replace(/[\s-]/g, '');
  return PLACA_RE.test(normalizada);
}

module.exports = {
  emailValido,
  fotoValida,
  textoDentroDeLimite,
  cedulaValida,
  telefonoValido,
  anioValido,
  placaValida,
};
