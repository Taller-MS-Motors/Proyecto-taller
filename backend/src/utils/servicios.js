// Catálogo de servicios y cupos de agenda (compartido por el portal y recepción).
//
// El catálogo vive en la tabla `servicios` y se administra desde el panel. La lista de
// abajo queda solo como respaldo: es lo que se usa si la tabla todavía no existe (BD sin
// migrar) para que el portal no se quede sin nada que ofrecer.
const { pool } = require('../db/pool');

const SERVICIOS_DEFECTO = [
  'Cambio de aceite y filtros',
  'Revisión completa',
  'Cambio de pastillas de freno',
  'Kit de transmisión (cadena y piñones)',
  'Diagnóstico electrónico',
  'Cambio de neumáticos',
];

// Horas agendables: de 8:00 a 16:00, una por hora.
const HORAS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];

// Máximo de citas por franja horaria.
const MAX_POR_HORA = 2;

// Caché en memoria con el mismo criterio que utils/configuracion.js: el catálogo se
// consulta en cada carga del formulario de agendar y cambia muy de vez en cuando.
let cache = null;
let cacheAt = 0;
const TTL_MS = 30 * 1000;

// Filas completas (id, nombre, activo, orden) — para administrarlas.
async function getServiciosFilas() {
  if (cache && Date.now() - cacheAt < TTL_MS) return cache;
  let filas;
  try {
    const [rows] = await pool.query('SELECT id, nombre, activo, orden FROM servicios ORDER BY orden, nombre');
    filas = rows;
  } catch (_) {
    // Tabla aún no migrada: se responde con el respaldo para no romper el agendado.
    filas = SERVICIOS_DEFECTO.map((nombre, i) => ({ id: null, nombre, activo: 1, orden: i + 1 }));
  }
  cache = filas;
  cacheAt = Date.now();
  return filas;
}

// Solo los nombres activos: es lo que se ofrece al agendar y contra lo que se valida.
async function getServicios() {
  const filas = await getServiciosFilas();
  return filas.filter((s) => s.activo).map((s) => s.nombre);
}

// ¿Se puede agendar este servicio? Un servicio desactivado deja de ofrecerse, pero las
// citas viejas que lo usaron siguen mostrándose bien porque guardan el texto.
async function servicioValido(nombre) {
  const activos = await getServicios();
  return activos.includes(nombre);
}

function clearCache() {
  cache = null;
  cacheAt = 0;
}

module.exports = {
  SERVICIOS_DEFECTO, HORAS, MAX_POR_HORA,
  getServicios, getServiciosFilas, servicioValido, clearCache,
};
