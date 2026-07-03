import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';
import { Orden, OrdenAvance, OrdenRepuesto, OrdenFoto, EstadoOrden } from '../models/orden.model';

@Injectable({ providedIn: 'root' })
export class OrdenesService {
  private url = `${environment.apiUrl}/ordenes`;
  constructor(private http: HttpClient) {}

  getAll(params?: { estado?: string; tecnico_id?: number; fecha_desde?: string; fecha_hasta?: string }): Observable<{ data: Orden[] }> {
    return this.http.get<{ data: Orden[] }>(this.url, { params: params as any });
  }

  getById(id: number): Observable<{ data: Orden }> {
    return this.http.get<{ data: Orden }>(`${this.url}/${id}`);
  }

  create(orden: Partial<Orden>): Observable<{ data: Orden }> {
    return this.http.post<{ data: Orden }>(this.url, orden);
  }

  update(id: number, data: Partial<Orden>): Observable<{ data: Orden }> {
    return this.http.put<{ data: Orden }>(`${this.url}/${id}`, data);
  }

  cambiarEstado(id: number, estado: EstadoOrden): Observable<any> {
    return this.http.patch(`${this.url}/${id}/estado`, { estado });
  }

  asignarTecnico(id: number, tecnico_id: number | null): Observable<any> {
    return this.http.patch(`${this.url}/${id}/tecnico`, { tecnico_id });
  }

  getAvances(id: number): Observable<{ data: OrdenAvance[] }> {
    return this.http.get<{ data: OrdenAvance[] }>(`${this.url}/${id}/avances`);
  }

  addAvance(id: number, descripcion: string): Observable<{ data: OrdenAvance }> {
    return this.http.post<{ data: OrdenAvance }>(`${this.url}/${id}/avances`, { descripcion });
  }

  getRepuestos(id: number): Observable<{ data: OrdenRepuesto[] }> {
    return this.http.get<{ data: OrdenRepuesto[] }>(`${this.url}/${id}/repuestos`);
  }

  addRepuesto(id: number, repuesto: OrdenRepuesto): Observable<{ data: OrdenRepuesto }> {
    return this.http.post<{ data: OrdenRepuesto }>(`${this.url}/${id}/repuestos`, repuesto);
  }

  updateRepuesto(ordenId: number, repuestoId: number, data: OrdenRepuesto): Observable<any> {
    return this.http.put(`${this.url}/${ordenId}/repuestos/${repuestoId}`, data);
  }

  deleteRepuesto(ordenId: number, repuestoId: number): Observable<any> {
    return this.http.delete(`${this.url}/${ordenId}/repuestos/${repuestoId}`);
  }

  getTiempos(id: number): Observable<{ data: { etapa: string; inicio: string; fin: string | null }[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/${id}/tiempos`);
  }

  getChecklist(id: number): Observable<{ data: any }> {
    return this.http.get<{ data: any }>(`${this.url}/${id}/checklist`);
  }

  saveChecklist(id: number, checklist: any): Observable<any> {
    return this.http.post(`${this.url}/${id}/checklist`, checklist);
  }

  cerrar(id: number, data: { metodo_pago: string; garantia_dias: number; observaciones_finales?: string }): Observable<any> {
    return this.http.patch(`${this.url}/${id}/cerrar`, data);
  }

  getFotos(id: number): Observable<{ data: OrdenFoto[] }> {
    return this.http.get<{ data: OrdenFoto[] }>(`${this.url}/${id}/fotos`);
  }

  addFoto(id: number, foto: { url: string; tipo: string; descripcion?: string }): Observable<{ data: OrdenFoto }> {
    return this.http.post<{ data: OrdenFoto }>(`${this.url}/${id}/fotos`, foto);
  }

  deleteFoto(ordenId: number, fotoId: number): Observable<any> {
    return this.http.delete(`${this.url}/${ordenId}/fotos/${fotoId}`);
  }

  // Mensajes internos vinculados a la orden (contexto de orden).
  getMensajes(id: number): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/${id}/mensajes`);
  }

  enviarMensaje(id: number, mensaje: string, foto?: string | null): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/${id}/mensajes`, { mensaje, foto: foto || null });
  }
}
