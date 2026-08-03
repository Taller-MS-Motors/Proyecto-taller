import { Component, EventEmitter, OnDestroy, OnInit, Output } from '@angular/core';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { MensajeriaService, ChatContacto } from '../../services/mensajeria.service';
import { AuthService } from '../../services/auth.service';

// Lista de contactos estilo WhatsApp: todo el personal activo con preview del
// último mensaje y no-leídos por conversación. La usan los 3 roles.
@Component({
  standalone: false,
  selector: 'app-chat-contactos',
  templateUrl: './chat-contactos.component.html',
  styleUrls: ['./chat-contactos.component.scss'],
})
export class ChatContactosComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  @Output() abrir = new EventEmitter<ChatContacto>();
  @Output() abrirAvisos = new EventEmitter<void>();

  contactos: ChatContacto[] = [];
  avisosNoLeidos = 0;
  cargando = true;
  q = '';
  miId = this.auth.getUsuario()?.id;

  readonly rolLabel: Record<string, string> = {
    tecnico: 'Mecánico', recepcion: 'Recepción', admin: 'Dueño / Admin',
  };

  constructor(private msj: MensajeriaService, private auth: AuthService) {}

  ngOnInit() {
    this.cargar();
    interval(15000).pipe(takeUntil(this.destroy$)).subscribe(() => this.cargar(true));
  }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  cargar(silencioso = false) {
    if (!silencioso) this.cargando = true;
    this.msj.getContactos().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.contactos = r.data.contactos || [];
        this.avisosNoLeidos = r.data.avisos_no_leidos || 0;
        this.cargando = false;
      },
      error: () => { this.cargando = false; },
    });
  }

  get filtrados(): ChatContacto[] {
    const q = this.q.trim().toLowerCase();
    if (!q) return this.contactos;
    return this.contactos.filter(c =>
      c.nombre.toLowerCase().includes(q) || (this.rolLabel[c.rol] || c.rol).toLowerCase().includes(q));
  }

  preview(c: ChatContacto): string {
    if (!c.ultima_fecha) return 'Sin mensajes aún — escribile 👋';
    const prefijo = c.ultimo_remitente_id === this.miId ? 'Vos: ' : '';
    if (c.ultimo_mensaje) return prefijo + c.ultimo_mensaje;
    return prefijo + (c.ultimo_es_foto ? '📷 Foto' : '');
  }

  // Avatar del compañero. La caché vive en el servicio: se comparte con la cabecera
  // del hilo y se pide una sola vez por sesión, aunque la lista se refresque cada 15 s.
  avatar(c: ChatContacto): string | null {
    return c?.tiene_foto ? this.msj.avatar(c.id) : null;
  }

  iniciales(nombre: string): string {
    const p = (nombre || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase();
  }

  // Hora estilo WhatsApp: hoy → hora, ayer → "Ayer", si no → dd/mm.
  horaLista(fecha: string | null): string {
    if (!fecha) return '';
    const hoy = new Date().toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d = fecha.slice(0, 10);
    if (d === hoy) return new Date(fecha).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: true });
    if (d === ayer) return 'Ayer';
    return new Date(fecha).toLocaleDateString('es-CR', { day: '2-digit', month: '2-digit' });
  }
}
