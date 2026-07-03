import { Component, OnInit, OnDestroy, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, IonContent, ToastController } from '@ionic/angular';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { RecepcionService } from '../../services/recepcion.service';
import { abrirWhatsApp } from '../../shared/whatsapp.util';

@Component({
  standalone: false,
  selector: 'app-recepcion-mensajes',
  templateUrl: './recepcion-mensajes.page.html',
  styleUrls: ['./recepcion-mensajes.page.scss'],
})
export class RecepcionMensajesPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  @ViewChild(IonContent) content?: IonContent;

  vista: 'mecanicos' | 'clientes' | 'taller' = 'mecanicos';
  avances: any[] = [];
  notificaciones: any[] = [];
  internos: any[] = [];
  cargando = true;

  tecnicos: any[] = [];
  chatAbierto: { id: number; nombre: string } | null = null;
  borrador = '';
  enviandoChat = false;
  fotoPreview: string | null = null;
  broadcastTexto = '';
  enviandoBroadcast = false;
  sucursalFiltro: number | '' = '';
  sucursales: { id: number; nombre: string }[] = [];

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
    if (!this.tecnicos.length) this.rec.getTecnicos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => { this.tecnicos = r.data; this.extraerSucursales(); }, error: () => {} });
  }

  private refrescarInternos() {
    if (this.vista !== 'taller') return;
    this.rec.getMensajesInternos().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.internos = r.data; },
    });
  }

  private extraerSucursales() {
    const map = new Map<number, string>();
    for (const t of this.tecnicos) {
      if (t.sucursal_id && t.sucursal_nombre) map.set(t.sucursal_id, t.sucursal_nombre);
    }
    this.sucursales = [...map].map(([id, nombre]) => ({ id, nombre }));
  }

  private mecDe(m: any): { id: number; nombre: string; sucursalId?: number; sucursalNombre?: string } | null {
    const esRecep = m.remitente_rol === 'recepcion';
    const id = esRecep ? m.destino_id : m.remitente_id;
    const nombre = esRecep ? (m.destino_nombre || 'Mecánico') : (m.remitente_nombre || 'Mecánico');
    const sucursalId = esRecep ? m.destino_sucursal_id : m.remitente_sucursal_id;
    const sucursalNombre = m.sucursal_nombre;
    return id ? { id, nombre, sucursalId, sucursalNombre } : null;
  }

  get conversaciones(): any[] {
    const map = new Map<number, any>();
    for (const m of this.internos) {
      if (m.tipo === 'broadcast') continue;
      const mec = this.mecDe(m);
      if (!mec) continue;
      if (!map.has(mec.id)) map.set(mec.id, { id: mec.id, nombre: mec.nombre, sucursalId: mec.sucursalId, sucursalNombre: mec.sucursalNombre, ultimo: m, noLeidos: 0 });
      if (m.remitente_rol !== 'recepcion' && !m.leido) map.get(mec.id).noLeidos++;
    }
    let result = [...map.values()];
    if (this.sucursalFiltro) result = result.filter(c => c.sucursalId === this.sucursalFiltro);
    return result;
  }

  get broadcasts(): any[] {
    return this.internos.filter(m => m.tipo === 'broadcast').slice().reverse();
  }

  get hilo(): any[] {
    if (!this.chatAbierto) return [];
    const id = this.chatAbierto.id;
    return this.internos.filter(m => { const mec = this.mecDe(m); return !!mec && mec.id === id; }).slice().reverse();
  }

  esMio(m: any): boolean { return m.remitente_rol === 'recepcion'; }

  abrirChat(c: any) { this.chatAbierto = { id: c.id, nombre: c.nombre }; this.scrollHilo(); }
  cerrarChat() { this.chatAbierto = null; this.borrador = ''; this.fotoPreview = null; }

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
    const foto = this.fotoPreview;
    if ((!txt && !foto) || !this.chatAbierto || this.enviandoChat) return;
    this.enviandoChat = true;
    this.rec.responderInterno(this.chatAbierto.id, txt, foto).pipe(takeUntil(this.destroy$)).subscribe({
      next: (r: any) => {
        if (r?.data) this.internos.unshift(r.data);
        this.borrador = '';
        this.fotoPreview = null;
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

  adjuntarFoto() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 4 * 1024 * 1024) {
        this.aviso('Imagen muy grande (máx 4 MB)', 'warning');
        return;
      }
      const reader = new FileReader();
      reader.onload = () => { this.fotoPreview = reader.result as string; };
      reader.readAsDataURL(file);
    };
    input.click();
  }

  quitarFoto() { this.fotoPreview = null; }

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

  reenviar(a: any) {
    const msg = `Hola ${a.cliente_nombre}, novedad de tu ${a.marca} ${a.modelo} (orden ${a.numero_orden}): ${a.descripcion}`;
    abrirWhatsApp(a.cliente_telefono, msg);
  }

  responder(n: any) {
    abrirWhatsApp(n.cliente_telefono, `Hola ${n.cliente_nombre}, `);
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private async aviso(message: string, color: string) {
    const t = await this.toast.create({ message, duration: 1700, color });
    await t.present();
  }
}
