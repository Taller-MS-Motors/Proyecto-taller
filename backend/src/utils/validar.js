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

module.exports = { emailValido, fotoValida };
