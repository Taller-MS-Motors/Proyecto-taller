import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

// Contacto de la lista de chats (personal activo + metadata del último mensaje).
export interface ChatContacto {
  id: number;
  nombre: string;
  rol: string;
  // El avatar ya no viaja en la lista (es base64 y esto se refresca cada 15 s):
  // solo si lo tiene. La imagen se pide aparte y se cachea (ver avatar()).
  tiene_foto: number;
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

  // Avatares del personal, cacheados acá y no en cada componente: los comparten la
  // lista de contactos y la cabecera del hilo, y una persona tiene un solo avatar.
  // Se pide una vez por sesión; el resto son lecturas de memoria.
  private avatares = new Map<number, string>();

  avatar(usuarioId: number): string | null {
    if (!this.avatares.has(usuarioId)) {
      // Se reserva el lugar antes de pedir: esto lo llama la plantilla en cada
      // ciclo de detección de cambios, y sin la marca dispararía peticiones en serie.
      this.avatares.set(usuarioId, '');
      this.http.get<{ data: string }>(`${this.url}/contacto/${usuarioId}/foto`).subscribe({
        next: r => this.avatares.set(usuarioId, r.data),
        error: () => this.avatares.delete(usuarioId),
      });
    }
    return this.avatares.get(usuarioId) || null;
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
