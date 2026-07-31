// Estados de cita y horas de agenda (frontend).
//
// El catálogo de servicios ya NO vive acá: se administra desde el panel (Servicios) y
// se pide al servidor. Tenerlo duplicado hacía que el frontend ofreciera una lista y
// el backend validara contra otra, y encima el formulario de recepción tenía una
// tercera con nombres distintos.

export const HORAS = ['08:00', '09:00', '10:00', '11:00', '12:00', '13:00', '14:00', '15:00', '16:00'];

// Flujo de estados de la cita (para la barra de progreso del cliente).
export const FLUJO_CITA = ['agendado', 'en_revision', 'en_mantenimiento', 'listo', 'entregado'];

export const ESTADO_CITA_LABEL: Record<string, string> = {
  agendado: 'Agendado',
  en_revision: 'En revisión',
  en_mantenimiento: 'En mantenimiento',
  listo: 'Listo',
  entregado: 'Entregado',
  cancelado: 'Cancelado',
};
