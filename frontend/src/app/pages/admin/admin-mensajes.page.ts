import { Component, OnInit, OnDestroy } from '@angular/core';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { RecepcionService } from '../../services/recepcion.service';
import { ChatContacto } from '../../services/mensajeria.service';

// Mensajes del admin. Tabs: chat interno 1:1 con el equipo (componentes
// compartidos app-chat-*), avances de mecánicos y notificaciones a clientes.
@Component({
  standalone: false,
  selector: 'app-admin-mensajes',
  templateUrl: './admin-mensajes.page.html',
  styleUrls: ['./admin-mensajes.page.scss'],
})
export class AdminMensajesPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();

  vista: 'mecanicos' | 'clientes' | 'taller' = 'taller';
  avances: any[] = [];
  notificaciones: any[] = [];
  cargando = true;

  clientes: any[] = [];
  form: { cliente_id: number | null; titulo: string; mensaje: string } = { cliente_id: null, titulo: '', mensaje: '' };
  enviando = false;

  // Chat interno (la lógica vive en los componentes compartidos).
  chatAbierto: ChatContacto | null = null;
  verAvisos = false;

  constructor(private rec: RecepcionService, private toast: ToastController) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  cargar(ev?: any) {
    this.cargando = true;
    let pendientes = 2;
    const listo = () => { if (--pendientes <= 0) this.cargando = false; if (ev) ev.target.complete(); };
    this.rec.getAvances().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.avances = r.data; listo(); }, error: listo });
    this.rec.getNotificaciones().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.notificaciones = r.data; listo(); }, error: listo });
    if (!this.clientes.length) this.rec.getClientes().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.clientes = r.data });
  }

  abrirChat(c: ChatContacto) { this.chatAbierto = c; this.verAvisos = false; }
  cerrarChat() { this.chatAbierto = null; this.verAvisos = false; }

  enviarNotificacion() {
    if (!this.form.cliente_id || !this.form.titulo.trim() || !this.form.mensaje.trim()) {
      this.aviso('Completá cliente, título y mensaje', 'warning'); return;
    }
    this.enviando = true;
    this.rec.notificar({ cliente_id: this.form.cliente_id!, titulo: this.form.titulo.trim(), mensaje: this.form.mensaje.trim() })
      .pipe(takeUntil(this.destroy$)).subscribe({
        next: () => {
          this.enviando = false;
          this.form = { cliente_id: null, titulo: '', mensaje: '' };
          this.aviso('Notificación enviada', 'success');
          this.cargar();
        },
        error: () => { this.enviando = false; this.aviso('No se pudo enviar', 'danger'); },
      });
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

  private async aviso(message: string, color: string) {
    const t = await this.toast.create({ message, duration: 1700, color });
    await t.present();
  }
}
