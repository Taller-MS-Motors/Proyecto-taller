export type EstadoOrden =
  | 'recepcion' | 'diagnostico' | 'esperando_aprobacion'
  | 'esperando_repuestos' | 'en_reparacion' | 'lista_entrega'
  | 'entregada' | 'cancelada';

export interface Orden {
  id?: number;
  numero_orden?: string;
  moto_id: number;
  cliente_id: number;
  recepcionista_id?: number;
  tecnico_id?: number | null;
  estado?: EstadoOrden;
  problema_reportado: string;
  kilometraje_ingreso?: number | null;
  nivel_combustible?: string;
  accesorios_entregados?: string | null;
  estado_fisico?: string | null;
  prioridad?: string;
  categoria?: string;
  diagnostico?: string | null;
  tiempo_estimado_horas?: number | null;
  costo_mano_obra?: number;
  costo_repuestos?: number;
  descuento?: number;
  total?: number;
  aprobado_por_cliente?: number;
  aprobacion_cliente?: 'pendiente' | 'aprobado' | 'rechazado';
  motivo_rechazo?: string | null;
  fecha_aprobacion?: string | null;
  fecha_ingreso?: string;
  fecha_estimada_entrega?: string | null;
  fecha_entrega_real?: string | null;
  metodo_pago?: string | null;
  garantia_dias?: number;
  observaciones_finales?: string | null;
  calificacion?: number | null;
  comentario_satisfaccion?: string | null;
  sucursal_id?: number | null;
  // Campos enriquecidos del JOIN
  anio?: number | null;
  sucursal_nombre?: string | null;
  sucursal_direccion?: string | null;
  sucursal_telefono?: string | null;
  cliente_nombre?: string;
  cliente_apellido?: string;
  cliente_telefono?: string;
  marca?: string;
  modelo?: string;
  placa?: string;
  color?: string;
  tecnico_nombre?: string;
  recepcionista_nombre?: string;
}

export interface OrdenAvance {
  id?: number;
  orden_id: number;
  usuario_id?: number;
  descripcion: string;
  created_at?: string;
  usuario_nombre?: string;
  usuario_rol?: string;
}

export interface OrdenRepuesto {
  id?: number;
  orden_id?: number;
  nombre: string;
  cantidad: number;
  costo_unitario: number;
  estado?: string;
}

export interface OrdenFoto {
  id?: number;
  orden_id?: number;
  url: string;          // data URL base64
  tipo: 'ingreso' | 'diagnostico' | 'avance' | 'entrega';
  descripcion?: string | null;
  created_at?: string;
}

export interface OrdenChecklist {
  prueba_realizada: boolean;
  lavado: boolean;
  calidad_revisada: boolean;
  facturacion_lista: boolean;
  cliente_notificado: boolean;
  observaciones?: string;
}

export const ESTADO_CONFIG: Record<EstadoOrden, { label: string; color: string }> = {
  recepcion:             { label: 'Recepción',            color: 'primary' },
  diagnostico:           { label: 'Diagnóstico',          color: 'warning' },
  esperando_aprobacion:  { label: 'Esperando aprobación', color: 'tertiary' },
  esperando_repuestos:   { label: 'Esperando repuestos',  color: 'medium' },
  en_reparacion:         { label: 'En reparación',        color: 'secondary' },
  lista_entrega:         { label: 'Lista para entrega',   color: 'success' },
  entregada:             { label: 'Entregada',            color: 'light' },
  cancelada:             { label: 'Cancelada',            color: 'danger' },
};
