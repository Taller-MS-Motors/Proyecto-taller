// Render de los eventos del taller que ve la recepción (campana del header +
// tarjeta "Alertas recientes" del inicio). Única fuente de verdad para icono /
// color / texto, así ambas vistas se mantienen iguales.

export function alertaIcono(a: any): string {
  switch (a?.tipo) {
    case 'foto': return 'camera-outline';
    case 'lista': return 'checkmark-done-outline';
    case 'aprobacion': return a.decision === 'rechazado' ? 'close-circle-outline' : 'thumbs-up-outline';
    case 'cita_nueva': return 'calendar-outline';
    case 'cita_cancelada': return 'calendar-clear-outline';
    case 'repuesto': return 'cube-outline';
    default: return 'notifications-outline';
  }
}

export function alertaColor(a: any): string {
  switch (a?.tipo) {
    case 'foto': return 'rose';
    case 'lista': return 'green';
    case 'aprobacion': return a.decision === 'rechazado' ? 'amber' : 'green';
    case 'cita_nueva': return 'indigo';
    case 'cita_cancelada': return 'rose';
    case 'repuesto': return 'amber';
    default: return 'amber';
  }
}

export function alertaTexto(a: any): string {
  const cliente = `${a?.cliente_nombre || ''} ${a?.cliente_apellido || ''}`.trim();
  const moto = [a?.marca, a?.modelo].filter(Boolean).join(' ') || 'la moto';
  switch (a?.tipo) {
    case 'foto':
      return `${a.tecnico_nombre || 'El mecánico'} subió evidencia · ${moto}`;
    case 'lista':
      return `${a.numero_orden} lista para entrega · ${cliente}`;
    case 'aprobacion':
      return `${cliente} ${a.decision === 'rechazado' ? 'rechazó' : 'aprobó'} el presupuesto`;
    case 'cita_nueva':
      return `Cita nueva: ${cliente} — ${a.fecha_corta || ''} ${a.hora || ''}`.trim();
    case 'cita_cancelada':
      return `Cita cancelada por ${cliente || 'el cliente'} — ${a.fecha_corta || ''} ${a.hora || ''}`.trim();
    case 'repuesto':
      return `${a.tecnico_nombre || 'Mecánico'} solicita: ${a.repuesto_nombre} ×${a.repuesto_cantidad || 1} · ${moto}`;
    default:
      return a?.mensaje || '';
  }
}

// Timestamp relativo: "Recién", "Hace 10 min", "Hace 2 h", "Hace 3 d".
export function haceTexto(fecha: string): string {
  if (!fecha) return '';
  const min = Math.round((Date.now() - new Date(fecha).getTime()) / 60000);
  if (min < 1) return 'Recién';
  if (min < 60) return `Hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `Hace ${h} h`;
  return `Hace ${Math.round(h / 24)} d`;
}
