// Job: recordatorio de la cita del día siguiente.
// Corre una vez al día. Por cada cita agendada para mañana crea una notificación
// in-app (feed del portal) y, si el cliente tiene correo, un email vía Resend.
// Idempotente: marca recordatorio_enviado = 1, así aunque el job corra de nuevo
// (o dos instancias) no se duplica el aviso.

const { pool } = require('../db/pool');
const { getConfig } = require('../utils/configuracion');
const { crearNotificacion } = require('../utils/notificaciones');
const { enviarRecordatorioCita } = require('../services/mailer');
const { fechaLocalISO } = require('../utils/fecha');

async function enviarRecordatorios() {
  const config = await getConfig();
  // Preferencia del taller: si apagó los recordatorios, no se hace nada.
  if (!config.notif_recordatorio) return { total: 0, motivo: 'desactivado' };

  const manana = fechaLocalISO(config.zona_horaria_offset, 1);

  const [citas] = await pool.query(
    `SELECT ci.id, ci.cliente_id, TIME_FORMAT(ci.hora, '%H:%i') AS hora,
            ci.tipo_servicio, ci.motivo,
            cl.nombre, cl.email, cl.notif_recordatorios,
            m.marca, m.modelo,
            s.nombre AS sucursal
     FROM citas ci
     JOIN clientes cl ON cl.id = ci.cliente_id
     LEFT JOIN motos m ON m.id = ci.moto_id
     LEFT JOIN sucursales s ON s.id = ci.sucursal_id
     WHERE ci.fecha = ? AND ci.estado = 'agendado' AND ci.recordatorio_enviado = 0`,
    [manana]
  );

  let inApp = 0, emails = 0;
  for (const c of citas) {
    // Marca primero: la idempotencia no debe depender de que el envío tenga éxito.
    await pool.query('UPDATE citas SET recordatorio_enviado = 1 WHERE id = ?', [c.id]);

    // El cliente pudo desactivar sus recordatorios: se respeta.
    if (c.notif_recordatorios === 0) continue;

    const moto = [c.marca, c.modelo].filter(Boolean).join(' ') || 'tu moto';
    const servicio = c.tipo_servicio || c.motivo || 'tu servicio';

    await crearNotificacion({
      cliente_id: c.cliente_id,
      cita_id: c.id,
      titulo: `Recordatorio: cita mañana a las ${c.hora}`,
      mensaje: `Te esperamos mañana a las ${c.hora} para ${servicio} (${moto}).`,
      tipo: 'recordatorio',
    });
    inApp++;

    if (c.email) {
      const ok = await enviarRecordatorioCita(c.email, {
        nombre: c.nombre, hora: c.hora, servicio, moto,
        sucursal: c.sucursal, taller: config.nombre_taller,
      });
      if (ok) emails++;
    }
  }

  return { total: citas.length, inApp, emails, fecha: manana };
}

module.exports = { enviarRecordatorios };
