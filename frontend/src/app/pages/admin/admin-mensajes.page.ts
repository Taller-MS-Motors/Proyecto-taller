import { Component, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, IonContent, ToastController } from '@ionic/angular';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { RecepcionService } from '../../services/recepcion.service';

@Component({
  standalone: false,
  selector: 'app-admin-mensajes',
  templateUrl: './admin-mensajes.page.html',
  styleUrls: ['./admin-mensajes.page.scss'],
})
export class AdminMensajesPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  @ViewChild(IonContent) content?: IonContent;

  vista: 'mecanicos' | 'clientes' | 'taller' = 'taller';
  avances: any[] = [];
  notificaciones: any[] = [];
  internos: any[] = [];
  cargando = true;

  clientes: any[] = [];
  form: { cliente_id: number | null; titulo: string; mensaje: string } = { cliente_id: null, titulo: '', mensaje: '' };
  enviando = false;

  tecnicos: any[] = [];
  chatAbierto: { id: number; nombre: string } | null = null;
  borrador = '';
  enviandoChat = false;
  broadcastTexto = '';
  enviandoBroadcast = false;

  constructor(private rec: RecepcionService, private toast: ToastController, private alert: AlertController, private router: Router) {}

  abrirOrden(ordenId: number) { if (ordenId) this.router.navigate(['/detalle-orden', ordenId]); }

  ngOnInit() {
    this.cargar();
    interval(15000).pipe(takeUntil(this.destroy$)).subscribe(() => this.refrescarInternos());
  }

  ionViewWillEnter() { this.cargar(); }

  cargar(ev?: any) {
    this.cargando = true;
    let pendientes = 3;
    const listo = () => { if (--pendientes <= 0) this.cargando = false; if (ev) ev.target.complete(); };
    this.rec.getAvances().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.avances = r.data; listo(); }, error: listo });
    this.rec.getNotificaciones().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.notificaciones = r.data; listo(); }, error: listo });
    this.rec.getMensajesInternos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.internos = r.data; listo(); }, error: listo });
    if (!this.clientes.length) this.rec.getClientes().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.clientes = r.data });
    if (!this.tecnicos.length) this.rec.getTecnicos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.tecnicos = r.data, error: () => {} });
  }

  private refrescarInternos() {
    if (this.vista !== 'taller') return;
    this.rec.getMensajesInternos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.internos = r.data; } });
  }

  private mecDe(m: any): { id: number; nombre: string } | null {
    const esAdmin = m.remitente_rol === 'recepcion' || m.remitente_rol === 'admin';
    const id = esAdmin ? m.destino_id : m.remitente_id;
    const nombre = esAdmin ? (m.destino_nombre || 'Mecánico') : (m.remitente_nombre || 'Mecánico');
    return id ? { id, nombre } : null;
  }

  get conversaciones(): any[] {
    const map = new Map<number, any>();
    for (const m of this.internos) {
      if (m.tipo === 'broadcast') continue;
      const mec = this.mecDe(m);
      if (!mec) continue;
      if (!map.has(mec.id)) map.set(mec.id, { id: mec.id, nombre: mec.nombre, ultimo: m, noLeidos: 0 });
      if (m.remitente_rol !== 'recepcion' && m.remitente_rol !== 'admin' && !m.leido) map.get(mec.id).noLeidos++;
    }
    return [...map.values()];
  }

  get broadcasts(): any[] {
    return this.internos.filter(m => m.tipo === 'broadcast').slice().reverse();
  }

  get hilo(): any[] {
    if (!this.chatAbierto) return [];
    const id = this.chatAbierto.id;
    return this.internos.filter(m => { const mec = this.mecDe(m); return !!mec && mec.id === id; }).slice().reverse();
  }

  esMio(m: any): boolean { return m.remitente_rol === 'recepcion' || m.remitente_rol === 'admin'; }

  abrirChat(c: any) { this.chatAbierto = { id: c.id, nombre: c.nombre }; this.scrollHilo(); }
  cerrarChat() { this.chatAbierto = null; this.borrador = ''; }

  async nuevoChat() {
    if (!this.tecnicos.length) { this.aviso('No hay mecánicos disponibles', 'warning'); return; }
    const al = await this.alert.create({
      header: 'Nuevo mensaje',
      cssClass: 'alert-light',
      inputs: this.tecnicos.map(t => ({ type: 'radio' as const, label: t.nombre, value: { id: t.id, nombre: t.nombre } })),
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Abrir', handler: (v) => { if (v) this.abrirChat(v); } },
      ],
    });
    await al.present();
  }

  enviarChat() {
    const txt = this.borrador.trim();
    if (!txt || !this.chatAbierto || this.enviandoChat) return;
    this.enviandoChat = true;
    this.rec.responderInterno(this.chatAbierto.id, txt).pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => {
        if (r?.data) this.internos.unshift(r.data);
        this.borrador = '';
        this.enviandoChat = false;
        this.scrollHilo();
      },
      error: () => { this.enviandoChat = false; this.aviso('No se pudo enviar', 'danger'); },
    });
  }

  enviarBroadcast() {
    const txt = this.broadcastTexto.trim();
    if (!txt || this.enviandoBroadcast) return;
    this.enviandoBroadcast = true;
    this.rec.broadcastMecanicos(txt).pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => {
        if (r?.data) this.internos.unshift(r.data);
        this.broadcastTexto = '';
        this.enviandoBroadcast = false;
        this.aviso('Mensaje enviado a todos', 'success');
      },
      error: () => { this.enviandoBroadcast = false; this.aviso('No se pudo enviar', 'danger'); },
    });
  }

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

  private scrollHilo() { setTimeout(() => this.content?.scrollToBottom(150), 60); }

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

  horaExacta(fecha: string): string {
    if (!fecha) return '';
    return new Date(fecha).toLocaleTimeString('es-CR', { hour: '2-digit', minute: '2-digit', hour12: true });
  }

  mostrarSeparador(arr: any[], i: number): boolean {
    if (i === 0) return true;
    return (arr[i].created_at || '').slice(0, 10) !== (arr[i - 1].created_at || '').slice(0, 10);
  }

  etiquetaDia(fecha: string): string {
    if (!fecha) return '';
    const hoy = new Date().toISOString().slice(0, 10);
    const ayer = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const d = fecha.slice(0, 10);
    if (d === hoy) return 'Hoy';
    if (d === ayer) return 'Ayer';
    return new Date(fecha).toLocaleDateString('es-CR', { day: 'numeric', month: 'short' });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private async aviso(message: string, color: string) {
    const t = await this.toast.create({ message, duration: 1700, color });
    await t.present();
  }
}
