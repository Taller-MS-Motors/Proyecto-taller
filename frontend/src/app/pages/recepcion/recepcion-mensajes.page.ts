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

  // Buscador y filtro. Las listas visibles son campos y no getters: dentro de un
  // *ngFor, un getter devuelve un arreglo nuevo en cada ciclo de detección de cambios
  // y Angular vuelve a diferenciar la lista entera con cada tecla.
  busqueda = '';
  filtroAvances: 'todos' | 'hoy' | '7d' | '30d' | 'fotos' = 'todos';
  filtroNotis: 'todas' | 'no_leidas' | 'leidas' = 'todas';
  avancesFiltrados: any[] = [];
  notificacionesFiltradas: any[] = [];

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
    this.rec.getAvances().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.avances = r.data; this.aplicarFiltros(); listo(); }, error: listo,
    });
    this.rec.getNotificaciones().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.notificaciones = r.data; this.aplicarFiltros(); listo(); }, error: listo,
    });
  }

  // ───── Buscador y filtro ─────
  get hayDatos(): boolean {
    return this.vista === 'mecanicos' ? !!this.avances.length : !!this.notificaciones.length;
  }

  get placeholderBusqueda(): string {
    return this.vista === 'mecanicos' ? 'Mecánico, orden, cliente, moto o texto' : 'Cliente, asunto o texto';
  }

  cambiarVista(v: 'mecanicos' | 'clientes' | 'taller') {
    if (this.vista === v) return;
    this.vista = v;
    // Se limpia al cambiar de pestaña: lo escrito para una lista casi nunca aplica a
    // la otra, y heredarlo la dejaría vacía sin motivo aparente.
    this.limpiarFiltros();
  }

  buscar(ev: any) {
    this.busqueda = ev?.target?.value ?? '';
    this.aplicarFiltros();
  }

  setFiltroAvances(f: 'todos' | 'hoy' | '7d' | '30d' | 'fotos') { this.filtroAvances = f; this.aplicarFiltros(); }
  setFiltroNotis(f: 'todas' | 'no_leidas' | 'leidas') { this.filtroNotis = f; this.aplicarFiltros(); }

  limpiarFiltros() {
    this.busqueda = '';
    this.filtroAvances = 'todos';
    this.filtroNotis = 'todas';
    this.aplicarFiltros();
  }

  // Recién en el día de hoy (calendario local), o dentro de los últimos N días.
  private reciente(fecha: string, filtro: 'hoy' | '7d' | '30d'): boolean {
    const t = new Date(fecha).getTime();
    if (!fecha || isNaN(t)) return false;
    if (filtro === 'hoy') return new Date(fecha).toDateString() === new Date().toDateString();
    const dias = filtro === '7d' ? 7 : 30;
    return t >= Date.now() - dias * 86400000;
  }

  private aplicarFiltros() {
    const q = this.busqueda.trim().toLowerCase();
    const coincide = (texto: string) => !q || texto.toLowerCase().includes(q);

    this.avancesFiltrados = this.avances.filter(a => {
      if (this.filtroAvances === 'fotos' && !(a.total_fotos > 0)) return false;
      if (this.filtroAvances !== 'todos' && this.filtroAvances !== 'fotos'
          && !this.reciente(a.created_at, this.filtroAvances)) return false;
      // Se busca también dentro del texto del avance: muchas veces se recuerda lo que
      // dijo el mecánico ("cambio de balineras") y no de qué orden era.
      return coincide(`${a.tecnico_nombre || ''} ${a.numero_orden || ''} ${a.cliente_nombre || ''} ${a.cliente_apellido || ''} ${a.marca || ''} ${a.modelo || ''} ${a.placa || ''} ${a.descripcion || ''}`);
    });

    this.notificacionesFiltradas = this.notificaciones.filter(n => {
      if (this.filtroNotis === 'no_leidas' && n.leida) return false;
      if (this.filtroNotis === 'leidas' && !n.leida) return false;
      return coincide(`${n.cliente_nombre || ''} ${n.cliente_apellido || ''} ${n.titulo || ''} ${n.mensaje || ''}`);
    });
  }

  trackId(_i: number, x: any) { return x?.id ?? -1; }

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
