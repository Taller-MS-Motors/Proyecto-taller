// Heurística de mantenimiento (portal del cliente).
// La recomendación es POR TIEMPO: la BD no guarda el km de cada servicio, así que se
// estima a partir de la fecha del último servicio de cada tipo. El km de la moto se
// muestra como dato, no se usa para calcular.

// Meses recomendados entre servicios del mismo tipo. Las claves son nombres del
// catálogo (hoy editable desde el panel): un servicio que no figure acá simplemente no
// genera recomendación — se lo saltea más abajo y, si no queda ninguno, cae al base.
// Se prefiere no sugerir nada antes que inventar un intervalo.
export const INTERVALOS_MESES: Record<string, number> = {
  'Cambio de aceite y filtros': 4,
  'Revisión completa': 12,
  'Cambio de pastillas de freno': 12,
  'Kit de transmisión (cadena y piñones)': 18,
  'Diagnóstico electrónico': 12,
  'Cambio de neumáticos': 24,
};

// Servicio base sugerido cuando la moto aún no tiene historial.
const SERVICIO_BASE = 'Cambio de aceite y filtros';

export type EstadoServicio = 'vencido' | 'pronto' | 'al_dia';

export interface ProximoServicio {
  servicio: string;          // tipo recomendado
  estado: EstadoServicio;    // urgencia
  meses: number;             // meses desde el último de ese tipo (0 si nunca se hizo)
  fechaUltimo: string | null;
  sinHistorial: boolean;
}

// Meses transcurridos desde una fecha 'YYYY-MM-DD' (o null). 0 si no hay fecha.
export function mesesDesde(fecha?: string | null): number {
  if (!fecha) return 0;
  const d = new Date(`${String(fecha).slice(0, 10)}T00:00:00`);
  if (isNaN(d.getTime())) return 0;
  const ahora = new Date();
  const meses = (ahora.getFullYear() - d.getFullYear()) * 12 + (ahora.getMonth() - d.getMonth());
  return Math.max(0, meses);
}

// Servicio más urgente a recomendar, a partir del historial de la moto.
// `servicios` = lista de citas entregadas con { tipo_servicio, fecha }.
export function proximoServicio(servicios: { tipo_servicio?: string; motivo?: string; fecha?: string }[]): ProximoServicio {
  if (!servicios || !servicios.length) {
    return { servicio: SERVICIO_BASE, estado: 'pronto', meses: 0, fechaUltimo: null, sinHistorial: true };
  }

  // Última fecha por tipo de servicio conocido.
  const ultimaPorTipo = new Map<string, string>();
  for (const s of servicios) {
    const tipo = s.tipo_servicio || '';
    if (!INTERVALOS_MESES[tipo] || !s.fecha) continue;
    const prev = ultimaPorTipo.get(tipo);
    if (!prev || String(s.fecha) > prev) ultimaPorTipo.set(tipo, String(s.fecha).slice(0, 10));
  }

  // Candidatos: cada tipo con su "vencimiento relativo" (meses transcurridos − intervalo).
  // Cuanto mayor el excedente, más urgente. Para tipos nunca hechos no inferimos nada.
  let mejor: ProximoServicio | null = null;
  for (const [tipo, fecha] of ultimaPorTipo) {
    const intervalo = INTERVALOS_MESES[tipo];
    const meses = mesesDesde(fecha);
    const excedente = meses - intervalo; // >0 vencido, cerca de 0 pronto
    const estado: EstadoServicio = excedente >= 0 ? 'vencido' : excedente >= -1 ? 'pronto' : 'al_dia';
    const cand: ProximoServicio = { servicio: tipo, estado, meses, fechaUltimo: fecha, sinHistorial: false };
    if (!mejor || excedente > (mejor.meses - INTERVALOS_MESES[mejor.servicio])) mejor = cand;
  }

  // Si solo hubo servicios de tipos sin intervalo definido, cae al base.
  if (!mejor) {
    const ultima = servicios[0]?.fecha ? String(servicios[0].fecha).slice(0, 10) : null;
    return { servicio: SERVICIO_BASE, estado: 'pronto', meses: mesesDesde(ultima), fechaUltimo: ultima, sinHistorial: false };
  }
  return mejor;
}
