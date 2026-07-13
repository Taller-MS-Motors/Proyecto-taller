// Job: marcar no-show las citas vencidas.
// Corre una vez al día. Una cita agendada cuya fecha ya pasó y que nunca tuvo
// check-in en mostrador (hora_llegada NULL) se marca no_show = 1. No la cancela
// ni la borra: solo levanta la bandera para que recepción la revise y no ensucie
// la agenda ni las métricas. Idempotente (solo toca las que aún tienen no_show = 0).

const { pool } = require('../db/pool');
const { getConfig } = require('../utils/configuracion');
const { fechaLocalISO } = require('../utils/fecha');

async function marcarNoShows() {
  const config = await getConfig();
  const hoy = fechaLocalISO(config.zona_horaria_offset, 0);

  const [r] = await pool.query(
    `UPDATE citas SET no_show = 1
     WHERE fecha < ? AND estado = 'agendado' AND hora_llegada IS NULL AND no_show = 0`,
    [hoy]
  );

  return { total: r.affectedRows, hasta: hoy };
}

module.exports = { marcarNoShows };
