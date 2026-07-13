// Helpers de fecha para los jobs programados.
// Railway corre el servidor en UTC; el taller vive en otra zona (por defecto CR, -6).
// Estas funciones dan la fecha/hora "de pared" del taller sin depender del TZ del proceso.

// Fecha local del taller en 'YYYY-MM-DD'. Se desplaza el reloj UTC por el offset
// (en horas) y se leen las partes UTC del resultado: eso equivale a la fecha local.
// `masDias` suma días naturales (1 = mañana, -1 = ayer).
function fechaLocalISO(offsetHoras = -6, masDias = 0, ahora = Date.now()) {
  const ms = ahora + (Number(offsetHoras) || 0) * 3600000 + masDias * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Hora local del taller 'HH:mm' (útil para logs/plantillas). Mismo principio que arriba.
function horaLocal(offsetHoras = -6, ahora = Date.now()) {
  const ms = ahora + (Number(offsetHoras) || 0) * 3600000;
  return new Date(ms).toISOString().slice(11, 16);
}

module.exports = { fechaLocalISO, horaLocal };
