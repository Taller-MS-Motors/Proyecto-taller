import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

export interface Promo {
  id?: number;
  titulo: string;
  descripcion: string;
  descuento?: number;
  precio_final?: number | null;
  imagen?: string | null;
  // El listado ya no trae la imagen (pesaba ~100 KB por promo): solo si la hay.
  tiene_imagen?: number;
  activa?: number;
  created_at?: string;
}

@Injectable({ providedIn: 'root' })
export class PromosService {
  private url = `${environment.apiUrl}/promos`;
  constructor(private http: HttpClient) {}

  // La imagen se pide por separado: la ruta exige sesion y un <img src> no puede
  // mandar la cabecera de autorizacion, asi que viaja como data URL en JSON.
  getImagen(id: number): Observable<{ data: string }> {
    return this.http.get<{ data: string }>(`${this.url}/${id}/imagen`);
  }

  getAll(): Observable<{ data: Promo[] }> {
    return this.http.get<{ data: Promo[] }>(this.url);
  }

  create(promo: Promo): Observable<{ data: Promo }> {
    return this.http.post<{ data: Promo }>(this.url, promo);
  }

  update(id: number, promo: Promo): Observable<{ data: Promo }> {
    return this.http.put<{ data: Promo }>(`${this.url}/${id}`, promo);
  }

  toggle(id: number): Observable<{ data: Promo }> {
    return this.http.patch<{ data: Promo }>(`${this.url}/${id}/toggle`, {});
  }

  delete(id: number): Observable<any> {
    return this.http.delete(`${this.url}/${id}`);
  }
}
