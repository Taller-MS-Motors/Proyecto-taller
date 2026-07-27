const { pool } = require('../db/pool');
const { getConfig } = require('./configuracion');
const { recompensas } = require('./recompensas');
const { enviarAvisoEstado } = require('../services/mailer');

// Hitos del servicio que además del aviso in-app disparan un correo al cliente.
const ESTADOS_EMAIL = {
  listo:     { titulo: 'Tu moto está lista', mensaje: (moto) => `${moto} ya está lista para entrega. Podés pasar a retirarla.` },
  entregado: { titulo: 'Servicio entregado', mensaje: (moto) => `${moto} fue entregada. ¡Gracias por tu visita!` },
};

const ESTADO_LEGIBLE = {
  agendado: 'Agendada',
  en_revision: 'En revisión',
  en_mantenimiento: 'En mantenimiento',
  listo: 'Lista para entrega',
  entregado: 'Entregada',
  cancelado: 'Cancelada',
};

// Inserta una notificación para el cliente. `tipo` define el icono/color en el
// portal (estado | listo | entregado | presupuesto | cortesia | mensaje | ...).
// Nunca lanza: si falla, lo loguea y sigue (no debe romper la operación que la dispara).
async function crearNotificacion({ cliente_id, cita_id = null, titulo, mensaje, tipo = 'estado' }) {
  try {
    await pool.query(
      'INSERT INTO notificaciones (cliente_id, cita_id, titulo, mensaje, tipo) VALUES (?, ?, ?, ?, ?)',
      [cliente_id, cita_id, titulo, mensaje, tipo]
    );
  } catch (err) {
    console.error('⚠️  No se pudo crear notificación:', err.message);
  }
}

// Avisa al cliente cuando cambia el estado de su cita. El `tipo` = estado, para
// que el portal pueda resaltar (ej. "listo" en verde, "cancelado" en rojo).
async function notificarCambioEstado(citaId, estado) {
  try {
    // Preferencia del taller: si está apagado, no se avisa al cliente por cambio de estado.
    const config = await getConfig();
    if (!config.notif_estado) return;
    const [[cita]] = await pool.query(
      `SELECT ci.cliente_id, cl.notif_avances, cl.nombre AS cliente_nombre, cl.email AS cliente_email,
              m.marca, m.modelo
       FROM citas ci
       LEFT JOIN motos m ON m.id = ci.moto_id
       LEFT JOIN clientes cl ON cl.id = ci.cliente_id
       WHERE ci.id = ?`,
      [citaId]
    );
    if (!cita) return;
    // Preferencia del cliente: si desactivó los avisos de avance, no se le notifica.
    if (cita.notif_avances === 0) return;
    const moto = [cita.marca, cita.modelo].filter(Boolean).join(' ') || 'tu moto';
    const legible = ESTADO_LEGIBLE[estado] || estado;
    await crearNotificacion({
      cliente_id: cita.cliente_id,
      cita_id: citaId,
      titulo: `${moto}: ${legible}`,
      mensaje: `El estado de tu cita cambió a "${legible}".`,
      tipo: estado,
    });
    // Hitos (listo/entregado): además del feed, un correo si el cliente tiene email.
    // El feed ya pasó el consentimiento (notif_estado + notif_avances); el email además
    // exige el toggle del taller `notif_email_entrega` (el admin decide si manda correos).
    const email = ESTADOS_EMAIL[estado];
    if (email && cita.cliente_email && config.notif_email_entrega) {
      await enviarAvisoEstado(cita.cliente_email, {
        nombre: cita.cliente_nombre,
        titulo: email.titulo,
        mensaje: email.mensaje(moto),
        taller: config.nombre_taller,
      });
    }
    // Al entregar, si el cliente acaba de desbloquear su cortesía, avisarle.
    if (estado === 'entregado') await notificarCortesia(cita.cliente_id);
  } catch (err) {
    console.error('⚠️  No se pudo crear notificación:', err.message);
  }
}

// Si con la última visita entregada el cliente llegó al servicio de cortesía,
// se lo notifica. Se dispara una sola vez por ciclo (justo al alcanzar la meta).
async function notificarCortesia(clienteId) {
  try {
    const [[{ completadas }]] = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM citas WHERE cliente_id = ? AND estado = 'entregado')
       + (SELECT COUNT(*) FROM ordenes_trabajo
            WHERE cliente_id = ? AND estado = 'entregada'
              AND id NOT IN (SELECT orden_id FROM citas WHERE orden_id IS NOT NULL)) AS completadas`,
      [clienteId, clienteId]
    );
    const r = recompensas(completadas);
    if (!r.cortesia_disponible) return;
    await crearNotificacion({
      cliente_id: clienteId,
      titulo: '🎉 ¡Desbloqueaste tu servicio de cortesía!',
      mensaje: 'Tu próxima cita es de cortesía. Agendala desde el portal para aprovecharla.',
      tipo: 'cortesia',
    });
  } catch (err) {
    console.error('⚠️  No se pudo crear notificación de cortesía:', err.message);
  }
}

// Avisa al cliente que el taller le agendó una cita desde el mostrador. Hasta ahora
// al crear una cita solo se notificaba al mecánico asignado: el cliente no recibía
// nada en su campana. (Cuando la agenda él mismo desde el portal no hace falta.)
async function notificarCitaAgendada(citaId) {
  try {
    const config = await getConfig();
    if (!config.notif_estado) return;
    const [[cita]] = await pool.query(
      `SELECT ci.cliente_id, DATE_FORMAT(ci.fecha, '%d/%m') AS fecha,
              TIME_FORMAT(ci.hora, '%H:%i') AS hora, ci.tipo_servicio, ci.motivo,
              cl.notif_avances, m.marca, m.modelo
       FROM citas ci
       LEFT JOIN clientes cl ON cl.id = ci.cliente_id
       LEFT JOIN motos m ON m.id = ci.moto_id
       WHERE ci.id = ?`,
      [citaId]
    );
    if (!cita || !cita.cliente_id) return;
    // Preferencia del cliente: si desactivó los avisos, no se le notifica.
    if (cita.notif_avances === 0) return;
    const moto = [cita.marca, cita.modelo].filter(Boolean).join(' ') || 'tu moto';
    const servicio = cita.tipo_servicio || cita.motivo || 'tu servicio';
    await crearNotificacion({
      cliente_id: cita.cliente_id,
      cita_id: citaId,
      titulo: `Cita agendada: ${cita.fecha} a las ${cita.hora}`,
      mensaje: `El taller te agendó una cita para ${servicio} (${moto}) el ${cita.fecha} a las ${cita.hora}.`,
      tipo: 'agendado',
    });
  } catch (err) {
    console.error('⚠️  No se pudo notificar la cita agendada:', err.message);
  }
}

async function notificarMecanico(tecnicoId, mensaje, remitenteId) {
  try {
    if (!tecnicoId) return;
    await pool.query(
      "INSERT INTO mensajes_internos (remitente_id, destino_id, mensaje, tipo) VALUES (?, ?, ?, 'sistema')",
      [remitenteId || tecnicoId, tecnicoId, mensaje]
    );
  } catch (err) {
    console.error('⚠️  No se pudo notificar al mecánico:', err.message);
  }
}

// Avisa al cliente que su presupuesto/cotización está listo para aprobar. Se dispara
// cuando la orden entra en 'esperando_aprobacion', por CUALQUIER vía (recepción con el
// botón "Enviar cotización", o un cambio de estado desde el detalle de la orden).
// Va contra el cliente de la ORDEN (no depende de que haya una cita ligada) y respeta
// la preferencia del taller notif_cotizacion.
async function notificarPresupuestoListo(ordenId) {
  try {
    const config = await getConfig();
    if (!config.notif_cotizacion) return;
    const [[orden]] = await pool.query(
      `SELECT ot.cliente_id, ot.numero_orden, m.marca, m.modelo,
              (SELECT id FROM citas WHERE orden_id = ot.id LIMIT 1) AS cita_id
       FROM ordenes_trabajo ot
       LEFT JOIN motos m ON m.id = ot.moto_id
       WHERE ot.id = ?`,
      [ordenId]
    );
    if (!orden || !orden.cliente_id) return;
    const moto = [orden.marca, orden.modelo].filter(Boolean).join(' ') || 'tu moto';
    await crearNotificacion({
      cliente_id: orden.cliente_id,
      cita_id: orden.cita_id || null,
      titulo: `Presupuesto listo: ${moto}`,
      mensaje: `Tu presupuesto (orden ${orden.numero_orden}) está listo. Revisalo y aprobalo desde el portal.`,
      tipo: 'presupuesto',
    });
  } catch (err) {
    console.error('⚠️  No se pudo notificar el presupuesto:', err.message);
  }
}

module.exports = { notificarCambioEstado, crearNotificacion, notificarMecanico, notificarPresupuestoListo, notificarCitaAgendada, ESTADO_LEGIBLE };
