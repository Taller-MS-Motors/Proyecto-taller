import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Contacto de la lista de chats (personal activo + metadata del último mensaje).
export interface ChatContacto {
  id: number;
  nombre: string;
  rol: string;
  foto: string | null;
  telefono: string | null;
  ultimo_mensaje: string | null;
  ultimo_es_foto: number | null;
  ultimo_remitente_id: number | null;
  ultima_fecha: string | null;
  no_leidos: number;
}

// Mensajería interna 1:1 del personal (los 3 roles usan el mismo servicio).
@Injectable({ providedIn: 'root' })
export class MensajeriaService {
  private url = `${environment.apiUrl}/mensajeria`;
  constructor(private http: HttpClient) {}

  getContactos(): Observable<{ data: { contactos: ChatContacto[]; avisos_no_leidos: number } }> {
    return this.http.get<{ data: any }>(`${this.url}/contactos`);
  }

  getConversacion(usuarioId: number): Observable<{ data: any[]; contacto: any }> {
    return this.http.get<{ data: any[]; contacto: any }>(`${this.url}/conversacion/${usuarioId}`);
  }

  enviar(usuarioId: number, mensaje: string, foto?: string | null): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/conversacion/${usuarioId}`, { mensaje, foto: foto || null });
  }

  // La foto de un mensaje, aparte del listado (que ya no la trae: pesaba ~100 KB y
  // se repetía en cada refresco de 12 s). La ruta exige sesión, así que no sirve un
  // <img src> directo: se pide por HTTP y llega la data URL.
  getFotoMensaje(mensajeId: number): Observable<{ data: string }> {
    return this.http.get<{ data: string }>(`${this.url}/mensaje/${mensajeId}/foto`);
  }

  getNoLeidos(): Observable<{ data: { count: number } }> {
    return this.http.get<{ data: { count: number } }>(`${this.url}/no-leidos`);
  }

  getAvisos(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/avisos`);
  }

  enviarAviso(mensaje: string, foto?: string | null): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/avisos`, { mensaje, foto: foto || null });
  }
}
