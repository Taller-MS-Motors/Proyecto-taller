import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Capacitor } from '@capacitor/core';
import { BehaviorSubject, Observable, of, tap, catchError, throwError } from 'rxjs';
import { environment } from '../../environments/environment';
import { secureGet, secureSet, secureRemove } from '../shared/secure-store.util';

export interface ClientePortal {
  id: number;
  tipo: 'cliente';
  nombre: string;
  apellido: string;
  foto?: string | null;
}

// Campos anti-bot que acompañan a los formularios públicos: honeypot (website, debe
// ir vacío) y token del captcha Turnstile. Ambos opcionales (degradación segura).
export interface AntiBot {
  website?: string;
  turnstileToken?: string;
}

const TOKEN_KEY = 'tallerms_portal_token';
const CLIENTE_KEY = 'tallerms_portal_cliente';
const nativo = Capacitor.isNativePlatform();

@Injectable({ providedIn: 'root' })
export class PortalService {
  private url = `${environment.apiUrl}/portal`;
  // En nativo el token vive en el Keychain/Keystore (ver secure-store.util); acá solo
  // se cachea en memoria para lecturas síncronas (interceptor, guards). En web sigue
  // siendo localStorage de punta a punta, igual que antes.
  private tokenCache: string | null = nativo ? null : localStorage.getItem(TOKEN_KEY);
  private clienteSubject = new BehaviorSubject<ClientePortal | null>(nativo ? null : this.getClienteGuardado());
  cliente$ = this.clienteSubject.asObservable();
  // Contador de notificaciones no leídas (alimenta el badge de la campana).
  private noLeidasSubject = new BehaviorSubject<number>(0);
  noLeidas$ = this.noLeidasSubject.asObservable();

  constructor(private http: HttpClient) {}

  // Hidrata la sesión desde el Keychain/Keystore en plataforma nativa. Se llama desde
  // un APP_INITIALIZER (app.module.ts) para que termine ANTES de que arranquen los
  // guards de ruta; en web no hace nada (ya se hidrató en el constructor).
  async init(): Promise<void> {
    if (!nativo) return;
    const [token, clienteRaw] = await Promise.all([secureGet(TOKEN_KEY), secureGet(CLIENTE_KEY)]);
    this.tokenCache = token;
    if (clienteRaw) {
      try { this.clienteSubject.next(JSON.parse(clienteRaw)); } catch { /* sesión corrupta: queda deslogueado */ }
    }
  }

  login(email: string, password: string): Observable<{ data: { token: string; cliente: ClientePortal } }> {
    return this.http.post<{ data: { token: string; cliente: ClientePortal } }>(`${this.url}/login`, { email, password }).pipe(
      tap(res => this.guardarSesion(res.data.token, res.data.cliente))
    );
  }

  // Ya NO abre sesión: crea la cuenta sin verificar y manda un código al correo.
  // El llamador sigue a verificarRegistro() para completar el ingreso.
  registro(data: { nombre: string; apellido: string; telefono: string; email: string; cedula?: string; password: string; website?: string; turnstileToken?: string }): Observable<{ data: { requiere_verificacion: boolean; email: string }; message: string }> {
    return this.http.post<{ data: { requiere_verificacion: boolean; email: string }; message: string }>(`${this.url}/registro`, data);
  }

  // Paso 2 del registro: confirma el código de 6 dígitos y recién ahí entra (auto-login).
  verificarRegistro(email: string, codigo: string): Observable<{ data: { token: string; cliente: ClientePortal } }> {
    return this.http.post<{ data: { token: string; cliente: ClientePortal } }>(`${this.url}/registro/verificar`, { email, codigo }).pipe(
      tap(res => this.guardarSesion(res.data.token, res.data.cliente))
    );
  }

  // Pide un código de verificación nuevo (no llegó / venció). Respuesta genérica.
  reenviarVerificacion(email: string, antibot: AntiBot = {}): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.url}/registro/reenviar`, { email, ...antibot });
  }

  // Paso 1: pide que envíen un código de recuperación al correo (respuesta genérica).
  solicitarCodigo(email: string, antibot: AntiBot = {}): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.url}/recuperar/solicitar`, { email, ...antibot });
  }

  // Paso 2: valida el código y define la nueva contraseña (auto-login).
  confirmarRecuperacion(data: { email: string; codigo: string; password: string }): Observable<{ data: { token: string; cliente: ClientePortal } }> {
    return this.http.post<{ data: { token: string; cliente: ClientePortal } }>(`${this.url}/recuperar/confirmar`, data).pipe(
      tap(res => this.guardarSesion(res.data.token, res.data.cliente))
    );
  }

  // Ingreso sin contraseña (OTP). Paso 1: pide el código al correo (respuesta genérica).
  solicitarCodigoLogin(email: string, antibot: AntiBot = {}): Observable<{ message: string }> {
    return this.http.post<{ message: string }>(`${this.url}/otp/solicitar`, { email, ...antibot });
  }

  // Paso 2: valida el código y entra (auto-login, guarda la sesión).
  verificarCodigoLogin(email: string, codigo: string): Observable<{ data: { token: string; cliente: ClientePortal } }> {
    return this.http.post<{ data: { token: string; cliente: ClientePortal } }>(`${this.url}/otp/verificar`, { email, codigo }).pipe(
      tap(res => this.guardarSesion(res.data.token, res.data.cliente))
    );
  }

  // Guarda la sesión del cliente (la usa el login unificado cuando tipo === 'cliente').
  aplicarSesion(token: string, cliente: ClientePortal) {
    this.guardarSesion(token, cliente);
  }

  private guardarSesion(token: string, cliente: ClientePortal) {
    // La caché en memoria se actualiza YA (lecturas síncronas inmediatas); la
    // escritura persistente es fire-and-forget y no bloquea el login.
    this.tokenCache = token;
    this.clienteSubject.next(cliente);
    secureSet(TOKEN_KEY, token);
    secureSet(CLIENTE_KEY, JSON.stringify(cliente));
  }

  logout() {
    this.tokenCache = null;
    secureRemove(TOKEN_KEY);
    secureRemove(CLIENTE_KEY);
    // Limpia el cache offline para no mostrar datos de otra cuenta tras cerrar sesión.
    ['citas', 'resumen', 'motos'].forEach(n => localStorage.removeItem(`tallerms_cache_${n}`));
    this.clienteSubject.next(null);
    this.noLeidasSubject.next(0);
  }

  getToken(): string | null { return this.tokenCache; }
  getCliente(): ClientePortal | null { return this.clienteSubject.value; }
  isLoggedIn(): boolean { return !!this.getToken(); }

  isTokenExpired(): boolean {
    const token = this.getToken();
    if (!token) return true;
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 < Date.now();
    } catch {
      return true;
    }
  }

  // Presupuestos del cliente: aprobar/rechazar una orden enviada por recepción.
  // Los endpoints existen en el backend; la pantalla del portal está pendiente (auditoría #2).
  getOrdenes(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/ordenes`);
  }

  getOrden(id: number): Observable<{ data: any }> {
    return this.http.get<{ data: any }>(`${this.url}/ordenes/${id}`);
  }

  aprobar(id: number): Observable<any> {
    return this.http.post(`${this.url}/ordenes/${id}/aprobar`, {});
  }

  rechazar(id: number, motivo: string): Observable<any> {
    return this.http.post(`${this.url}/ordenes/${id}/rechazar`, { motivo });
  }

  getMotos(): Observable<{ data: any[] }> {
    return this.conCache('motos', this.http.get<{ data: any[] }>(`${this.url}/motos`));
  }

  crearMoto(data: { marca: string; modelo: string; placa: string; anio?: number | null; color?: string; kilometraje_actual?: number | null; foto?: string | null }): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/motos`, data);
  }

  editarMoto(id: number, data: { marca: string; modelo: string; placa: string; anio?: number | null; color?: string; kilometraje_actual?: number | null; foto?: string | null }): Observable<{ data: any }> {
    return this.http.put<{ data: any }>(`${this.url}/motos/${id}`, data);
  }

  eliminarMoto(id: number): Observable<any> {
    return this.http.delete(`${this.url}/motos/${id}`);
  }

  // Cache offline "suave": guarda la última respuesta buena en localStorage y, si la
  // red falla, devuelve esa copia (para ver citas/motos/inicio sin conexión).
  private conCache<T>(nombre: string, fuente: Observable<T>): Observable<T> {
    const key = `tallerms_cache_${nombre}`;
    return fuente.pipe(
      tap(res => { try { localStorage.setItem(key, JSON.stringify(res)); } catch {} }),
      catchError(err => {
        const raw = localStorage.getItem(key);
        if (raw) { try { return of(JSON.parse(raw) as T); } catch {} }
        return throwError(() => err);
      })
    );
  }

  getCitas(): Observable<{ data: any[] }> {
    return this.conCache('citas', this.http.get<{ data: any[] }>(`${this.url}/citas`));
  }

  getCita(id: number): Observable<{ data: any }> {
    return this.http.get<{ data: any }>(`${this.url}/citas/${id}`);
  }

  cancelarCita(id: number): Observable<any> {
    return this.http.patch(`${this.url}/citas/${id}/cancelar`, {});
  }

  // El cliente confirma que asistirá a su cita agendada.
  confirmarCita(id: number): Observable<any> {
    return this.http.patch(`${this.url}/citas/${id}/confirmar`, {});
  }

  crearCita(data: { moto_id: number; sucursal_id: number; fecha: string; hora: string; tipo_servicio: string; descripcion?: string }): Observable<{ data: any }> {
    return this.http.post<{ data: any }>(`${this.url}/citas`, data);
  }

  editarCita(id: number, data: { moto_id: number; sucursal_id: number; fecha: string; hora: string; tipo_servicio: string; descripcion?: string }): Observable<{ data: any }> {
    return this.http.put<{ data: any }>(`${this.url}/citas/${id}`, data);
  }

  // Sucursales (locales) activas para el selector del formulario de citas.
  getSucursales(): Observable<{ data: { id: number; nombre: string; direccion: string | null }[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/sucursales`);
  }

  getResumen(): Observable<{ data: any }> {
    return this.conCache('resumen', this.http.get<{ data: any }>(`${this.url}/resumen`));
  }

  getNotificaciones(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/notificaciones`);
  }

  // Marca TODAS como leídas (al abrir el feed) y pone el badge en 0.
  leerNotificaciones(): Observable<any> {
    return this.http.post(`${this.url}/notificaciones/leer`, {}).pipe(
      tap(() => this.noLeidasSubject.next(0))
    );
  }

  // Marca UNA como leída (el feed actualiza el badge tras esto).
  leerNotificacion(id: number): Observable<any> {
    return this.http.patch(`${this.url}/notificaciones/${id}/leer`, {});
  }

  // Borra UNA (deslizar para eliminar).
  eliminarNotificacion(id: number): Observable<any> {
    return this.http.delete(`${this.url}/notificaciones/${id}`);
  }

  // Borra todas las leídas (limpiar feed).
  limpiarNotificacionesLeidas(): Observable<any> {
    return this.http.delete(`${this.url}/notificaciones/leidas`);
  }

  // Refresca el contador del badge desde el backend (liviano).
  refrescarContador(): void {
    if (!this.isLoggedIn()) { this.noLeidasSubject.next(0); return; }
    this.http.get<{ data: { no_leidas: number } }>(`${this.url}/notificaciones/contador`).subscribe({
      next: r => this.noLeidasSubject.next(r.data?.no_leidas || 0),
      error: () => {},
    });
  }

  // Ajusta el contador local sin pegar al backend (tras leer/borrar en el feed).
  fijarContador(n: number): void { this.noLeidasSubject.next(Math.max(0, n)); }

  getDisponibilidad(fecha: string, sucursalId: number): Observable<{ data: { horas: string[]; max: number; ocupacion: Record<string, number>; sucursal_id: number } }> {
    return this.http.get<{ data: any }>(`${this.url}/disponibilidad`, { params: { fecha, sucursal_id: sucursalId } as any });
  }

  // Primer horario con cupo en esa sucursal (botón "Sugerir próximo horario libre"). data = null si no hay.
  getProximoLibre(sucursalId: number): Observable<{ data: { fecha: string; hora: string; sucursal_id: number } | null }> {
    return this.http.get<{ data: any }>(`${this.url}/proximo-libre`, { params: { sucursal_id: sucursalId } as any });
  }

  // Línea de tiempo de servicios de una moto (citas entregadas).
  getMotoHistorial(id: number): Observable<{ data: { moto: any; servicios: any[] } }> {
    return this.http.get<{ data: any }>(`${this.url}/motos/${id}/historial`);
  }

  calificarCita(id: number, calificacion: number, comentario?: string): Observable<any> {
    return this.http.post(`${this.url}/citas/${id}/calificar`, { calificacion, comentario });
  }

  getPromos(): Observable<{ data: any[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/promos`);
  }
  getPromoImagen(id: number): Observable<{ data: string }> {
    return this.http.get<{ data: string }>(`${this.url}/promos/${id}/imagen`);
  }

  // Estado de fidelidad: visitas completadas, meta y si la cortesía está disponible.
  getFidelidad(): Observable<{ data: { visitas: number; cortesia_disponible: boolean; meta: number; faltan: number } }> {
    return this.http.get<{ data: any }>(`${this.url}/fidelidad`);
  }

  // Historial de cortesías canjeadas del cliente.
  getRecompensas(): Observable<{ data: { id: number; fecha: string; descripcion: string; numero_orden: string | null }[] }> {
    return this.http.get<{ data: any[] }>(`${this.url}/recompensas`);
  }

  // —— Perfil (Mi cuenta + Seguridad) ——
  getMiPerfil(): Observable<{ data: any }> {
    return this.http.get<{ data: any }>(`${this.url}/perfil`);
  }

  updateMiPerfil(data: { nombre: string; apellido: string; telefono: string; email: string }): Observable<{ data: any }> {
    return this.http.put<{ data: any }>(`${this.url}/perfil`, data);
  }

  // Preferencias de notificación del cliente (avisos de avance / recordatorios).
  updatePreferenciasNotif(data: { notif_avances: boolean; notif_recordatorios: boolean }): Observable<{ data: any }> {
    return this.http.put<{ data: any }>(`${this.url}/perfil/notificaciones`, data);
  }

  updateMiPassword(data: { actual: string; nueva: string }): Observable<any> {
    return this.http.put(`${this.url}/perfil/password`, data);
  }

  // Sube/cambia/quita la foto de perfil (foto = data URL base64, o null para quitarla).
  actualizarFotoPerfil(foto: string | null): Observable<{ data: { foto: string | null } }> {
    return this.http.put<{ data: { foto: string | null } }>(`${this.url}/perfil/foto`, { foto });
  }

  eliminarCuenta(): Observable<any> {
    return this.http.delete(`${this.url}/perfil`);
  }

  // Refresca el nombre/apellido guardados (saludo del inicio) tras editar el perfil,
  // sin necesidad de un token nuevo.
  actualizarClienteLocal(parcial: Partial<ClientePortal>) {
    const actual = this.clienteSubject.value;
    if (!actual) return;
    const merge = { ...actual, ...parcial };
    localStorage.setItem(CLIENTE_KEY, JSON.stringify(merge));
    this.clienteSubject.next(merge);
  }

  private getClienteGuardado(): ClientePortal | null {
    try {
      const raw = localStorage.getItem(CLIENTE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
}
