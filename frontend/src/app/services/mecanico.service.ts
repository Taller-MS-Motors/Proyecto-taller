import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface ResumenMecanico {
  citas_hoy: number;
  completadas_hoy: number;
  en_proceso: number;
  monto_promedio: number;
  generado_hoy: number;
  tiempo_promedio_min: number;
  calificacion_promedio: number | null;
  calificacion_total: number;
}

@Injectable({ providedIn: 'root' })
export class MecanicoService {
  private url = `${environment.apiUrl}/mecanico`;
  constructor(private http: HttpClient) {}

  getResumen(): Observable<{ data: ResumenMecanico }> {
    return this.http.get<{ data: ResumenMecanico }>(`${this.url}/resumen`);
  }

  getCitas(params?: { fecha?: string; estado?: string }): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/citas`, { params: params as any });
  }

  getAgenda(desde: string, hasta: string): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/agenda`, { params: { desde, hasta } as any });
  }

  cambiarEstado(id: number, estado: string, monto?: number | null): Observable<any> {
    return this.http.patch(`${this.url}/citas/${id}/estado`, { estado, monto });
  }

  // Tareas
  getTareas(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/tareas`);
  }
  addTarea(data: { titulo: string; detalle?: string; prioridad?: string }): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/tareas`, data);
  }
  toggleTarea(id: number, hecha?: boolean): Observable<any> {
    return this.http.patch(`${this.url}/tareas/${id}`, hecha === undefined ? {} : { hecha });
  }
  deleteTarea(id: number): Observable<any> {
    return this.http.delete(`${this.url}/tareas/${id}`);
  }

  // Mensajería con recepción
  getMensajes(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/mensajes`);
  }
  getNoLeidos(): Observable<{ data: { count: number } }> {
    return this.http.get<{ data: { count: number } }>(`${this.url}/mensajes/no-leidos`);
  }
  // destino: 'recepcion' (default) o 'admin' — el mecánico elige a quién le escribe.
  enviarMensaje(mensaje: string, foto?: string | null, orden_id?: number | null, destino: 'recepcion' | 'admin' = 'recepcion'): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/mensajes`, { mensaje, foto: foto || null, orden_id: orden_id || null, destino });
  }
  getRecepcionContacto(): Observable<{ data: { nombre: string; telefono: string } | null }> {
    return this.http.get<{ data: any }>(`${this.url}/recepcion-contacto`);
  }

  // Alertas
  getAlertas(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/alertas`);
  }

  // Solicitar repuestos (sin precio)
  solicitarRepuesto(ordenId: number, nombre: string, cantidad: number): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/ordenes/${ordenId}/repuestos`, { nombre, cantidad });
  }

  // Perfil
  getPerfil(): Observable<{ data: any }> {
    return this.http.get<{ data: any }>(`${this.url}/perfil`);
  }
  updateFoto(foto: string | null): Observable<{ data: { foto: string | null }; message: string }> {
    return this.http.put<{ data: { foto: string | null }; message: string }>(`${this.url}/perfil/foto`, { foto });
  }
  actualizarPerfil(data: { telefono?: string; especialidades?: string; horario?: string }): Observable<any> {
    return this.http.patch(`${this.url}/perfil`, data);
  }
  cambiarPassword(data: { actual: string; nueva: string }): Observable<{ message: string }> {
    return this.http.put<{ message: string }>(`${this.url}/perfil/password`, data);
  }
}
