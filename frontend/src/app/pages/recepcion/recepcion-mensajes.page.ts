import { Component, OnInit, OnDestroy } from '@angular/core';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { RecepcionService } from '../../services/recepcion.service';
import { ChatContacto } from '../../services/mensajeria.service';
import { abrirWhatsApp } from '../../shared/whatsapp.util';

// Mensajes de recepción. Tabs: avances de mecánicos, notificaciones a clientes,
// y "Equipo" = chat interno 1:1 (componentes compartidos app-chat-*).
@Component({
  standalone: false,
  selector: 'app-recepcion-mensajes',
  templateUrl: './recepcion-mensajes.page.html',
  styleUrls: ['./recepcion-mensajes.page.scss'],
})
export class RecepcionMensajesPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();

  vista: 'mecanicos' | 'clientes' | 'taller' = 'mecanicos';
  avances: any[] = [];
  notificaciones: any[] = [];
  cargando = true;

  // Chat interno (la lógica vive en los componentes compartidos).
  chatAbierto: ChatContacto | null = null;
  verAvisos = false;

  constructor(private rec: RecepcionService) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  cargar(ev?: any) {
    this.cargando = true;
    let pendientes = 2;
    const listo = () => { if (--pendientes <= 0) this.cargando = false; if (ev) ev.target.complete(); };
    this.rec.getAvances().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.avances = r.data; listo(); }, error: listo });
    this.rec.getNotificaciones().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.notificaciones = r.data; listo(); }, error: listo });
  }

  abrirChat(c: ChatContacto) { this.chatAbierto = c; this.verAvisos = false; }
  cerrarChat() { this.chatAbierto = null; this.verAvisos = false; }

  iniciales(nombre?: string, apellido?: string): string {
    return `${(nombre || '?').charAt(0)}${(apellido || '').charAt(0)}`.toUpperCase();
  }

  hace(fecha: string): string {
    if (!fecha) return '';
    const min = Math.round((Date.now() - new Date(fecha).getTime()) / 60000);
    if (min < 1) return 'Recién';
    if (min < 60) return `Hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `Hace ${h} h`;
    return `Hace ${Math.round(h / 24)} d`;
  }

  reenviar(a: any) {
    const msg = `Hola ${a.cliente_nombre}, novedad de tu ${a.marca} ${a.modelo} (orden ${a.numero_orden}): ${a.descripcion}`;
    abrirWhatsApp(a.cliente_telefono, msg);
  }

  responder(n: any) {
    abrirWhatsApp(n.cliente_telefono, `Hola ${n.cliente_nombre}, `);
  }
}
