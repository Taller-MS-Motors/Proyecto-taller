import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ActionSheetController, AlertController, LoadingController, ToastController } from '@ionic/angular';
import { OrdenesService } from '../../services/ordenes.service';
import { UsuariosService } from '../../services/usuarios.service';
import { RecepcionService } from '../../services/recepcion.service';
import { GarantiasService } from '../../services/garantias.service';
import { MarcaService } from '../../services/marca.service';
import { AuthService } from '../../services/auth.service';
import { MecanicoService } from '../../services/mecanico.service';
import { Orden, OrdenAvance, OrdenRepuesto, OrdenChecklist, OrdenFoto, EstadoOrden, ESTADO_CONFIG } from '../../models/orden.model';
import { Garantia, EstadoGarantia, ESTADO_GARANTIA_CONFIG } from '../../models/garantia.model';
import { Usuario } from '../../models/usuario.model';
import { comprimirImagen } from '../../shared/image.util';
import { WA_MENSAJES, mensajeSugerido, abrirWhatsApp, WaContexto } from '../../shared/whatsapp.util';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';

@Component({ standalone: false,
  selector: 'app-detalle-orden',
  templateUrl: './detalle-orden.page.html',
  styleUrls: ['./detalle-orden.page.scss'],
})
export class DetalleOrdenPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  orden: Orden | null = null;
  avances: OrdenAvance[] = [];
  repuestos: OrdenRepuesto[] = [];
  fotos: OrdenFoto[] = [];
  tecnicos: Usuario[] = [];
  cargando = true;

  tipoFoto: OrdenFoto['tipo'] = 'ingreso';
  subiendoFoto = false;

  readonly tiposFoto: { valor: OrdenFoto['tipo']; label: string }[] = [
    { valor: 'ingreso', label: 'Ingreso' },
    { valor: 'diagnostico', label: 'Diagnóstico' },
    { valor: 'avance', label: 'Avance' },
    { valor: 'entrega', label: 'Entrega' },
  ];

  nuevoAvance = '';
  nuevoRepuesto: OrdenRepuesto = { nombre: '', cantidad: 1, costo_unitario: 0 };
  mostrarFormRepuesto = false;
  mostrarFormSolicitud = false;
  listaSolicitud: { nombre: string; cantidad: number }[] = [];
  enviandoSolicitud = false;

  tiempos: { etapa: string; inicio: string; fin: string | null }[] = [];
  // === Stepper de progreso ===
  readonly flujoOrden = ['recepcion', 'diagnostico', 'esperando_aprobacion', 'esperando_repuestos', 'en_reparacion', 'lista_entrega', 'entregada'];
  readonly flujoLabel: Record<string, string> = {
    recepcion: 'Recepcion', diagnostico: 'Diagnostico', esperando_aprobacion: 'Aprobacion',
    esperando_repuestos: 'Repuestos', en_reparacion: 'Reparacion', lista_entrega: 'Lista', entregada: 'Entregada'
  };
  readonly flujoPorcentaje: Record<string, number> = {
    recepcion: 10, diagnostico: 25, esperando_aprobacion: 40,
    esperando_repuestos: 55, en_reparacion: 70, lista_entrega: 85, entregada: 100
  };

  readonly estrellas = [1, 2, 3, 4, 5];

  get pasoActual(): number {
    return this.flujoOrden.indexOf(this.orden?.estado || 'recepcion');
  }

  get porcentajeProgreso(): number {
    return this.flujoPorcentaje[this.orden?.estado || 'recepcion'] || 0;
  }

  readonly etapaLabel: Record<string, string> = {
    recepcion: 'Recepción', diagnostico: 'Diagnóstico', esperando_aprobacion: 'Esperando aprobación',
    esperando_repuestos: 'Esperando repuestos', en_reparacion: 'En reparación', lista_entrega: 'Lista para entrega',
  };
  readonly etapaIcono: Record<string, string> = {
    recepcion: 'log-in-outline', diagnostico: 'search-outline', esperando_aprobacion: 'time-outline',
    esperando_repuestos: 'cube-outline', en_reparacion: 'construct-outline', lista_entrega: 'checkmark-circle-outline',
  };

  checklist: OrdenChecklist = {
    prueba_realizada: false,
    lavado: false,
    calidad_revisada: false,
    facturacion_lista: false,
    cliente_notificado: false,
    observaciones: '',
  };

  // La garantia y las formas de pago salen de la configuracion del taller; estos
  // valores solo cubren el instante previo a que llegue la respuesta.
  cierre = { metodo_pago: 'efectivo', garantia_dias: 30, observaciones_finales: '' };
  metodosPago: { valor: string; etiqueta: string }[] = [];

  readonly estadosSiguientes: Record<EstadoOrden, EstadoOrden[]> = {
    recepcion:            ['diagnostico', 'cancelada'],
    diagnostico:          ['esperando_aprobacion', 'en_reparacion', 'cancelada'],
    esperando_aprobacion: ['esperando_repuestos', 'en_reparacion', 'cancelada'],
    esperando_repuestos:  ['en_reparacion', 'cancelada'],
    en_reparacion:        ['lista_entrega', 'cancelada'],
    // La entrega NO se hace por cambio de estado, sino por la card "Facturar y
    // entregar" (PATCH /cerrar: registra pago, garantía y suma la visita de fidelidad).
    lista_entrega:        [],
    entregada:            [],
    cancelada:            [],
  };

  garantias: Garantia[] = [];
  mostrarFormReclamo = false;
  nuevoReclamo = { descripcion_problema: '', cubre_repuestos: false, cubre_mano_obra: false };

  // Mensajes internos sobre esta orden (contexto de orden).
  mensajes: any[] = [];
  nuevoMensaje = '';
  enviandoMensaje = false;
  miId = this.auth.getUsuario()?.id ?? null;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private ordenSvc: OrdenesService,
    private usuarioSvc: UsuariosService,
    private rec: RecepcionService,
    private garantiaSvc: GarantiasService,
    private marcaSvc: MarcaService,
    public auth: AuthService,
    private mecSvc: MecanicoService,
    private alert: AlertController,
    private loading: LoadingController,
    private toast: ToastController,
    private actionSheet: ActionSheetController
  ) {}

  ngOnInit() {
    // Precarga la garantía y las formas de pago que definió el taller. Antes la
    // garantía estaba fija en 30 acá y había que reescribirla en cada entrega.
    this.marcaSvc.get().pipe(takeUntil(this.destroy$)).subscribe(m => {
      this.metodosPago = m.metodos_pago;
      this.cierre.garantia_dias = m.garantia_dias;
      // Si la forma de pago por defecto ya no está en la lista configurada, se toma
      // la primera: es preferible a dejar el campo apuntando a una opción inexistente.
      if (!this.metodosPago.some(x => x.valor === this.cierre.metodo_pago)) {
        this.cierre.metodo_pago = this.metodosPago[0]?.valor || '';
      }
    });
    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.cargar(+id);
  }

  cargar(id: number) {
    this.cargando = true;
    this.ordenSvc.getById(id).pipe(takeUntil(this.destroy$)).subscribe(res => {
      this.orden = res.data;
      this.cargando = false;
      this.cargarTecnicos();
    });
    this.ordenSvc.getAvances(id).pipe(takeUntil(this.destroy$)).subscribe(res => this.avances = res.data);
    this.ordenSvc.getRepuestos(id).pipe(takeUntil(this.destroy$)).subscribe(res => this.repuestos = res.data);
    this.ordenSvc.getFotos(id).pipe(takeUntil(this.destroy$)).subscribe(res => this.fotos = res.data);
    if (!this.auth.tieneRol('tecnico')) {
      this.ordenSvc.getTiempos(id).pipe(takeUntil(this.destroy$)).subscribe(res => this.tiempos = res.data || []);
    }
    this.garantiaSvc.getAll({ orden_id: id }).pipe(takeUntil(this.destroy$)).subscribe(res => this.garantias = res.data);
    this.cargarMensajes(id);
    this.ordenSvc.getChecklist(id).pipe(takeUntil(this.destroy$)).subscribe(res => {
      if (res.data) {
        this.checklist = {
          prueba_realizada: !!res.data.prueba_realizada,
          lavado: !!res.data.lavado,
          calidad_revisada: !!res.data.calidad_revisada,
          facturacion_lista: !!res.data.facturacion_lista,
          cliente_notificado: !!res.data.cliente_notificado,
          observaciones: res.data.observaciones || '',
        };
      }
    });
  }

  // Asignación de técnico: la hacen admin y recepción, cada uno por su endpoint
  // permitido (/api/usuarios es admin; recepción tiene /api/recepcion/tecnicos).
  // Recepción ve solo los mecánicos de la sede de la orden (+ "ambas"); admin, todos.
  private cargarTecnicos() {
    if (this.auth.tieneRol('admin')) {
      this.usuarioSvc.getAll().pipe(takeUntil(this.destroy$)).subscribe(res => {
        this.tecnicos = res.data.filter(u => u.rol === 'tecnico' && u.activo);
      });
    } else if (this.auth.tieneRol('recepcion')) {
      this.rec.getTecnicos(this.orden?.sucursal_id).pipe(takeUntil(this.destroy$)).subscribe(res => { this.tecnicos = res.data; });
    }
  }

  // ── Mensajes de la orden (contexto de orden) ──
  cargarMensajes(id: number) {
    this.ordenSvc.getMensajes(id).pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.mensajes = r.data || [], error: () => {} });
  }
  esMensajeMio(m: any): boolean { return m.remitente_id === this.miId; }
  async enviarMensaje() {
    const txt = this.nuevoMensaje.trim();
    if (!txt || !this.orden?.id || this.enviandoMensaje) return;
    this.enviandoMensaje = true;
    this.ordenSvc.enviarMensaje(this.orden.id, txt).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { if (r?.data) this.mensajes.push(r.data); this.nuevoMensaje = ''; this.enviandoMensaje = false; },
      error: async (e) => {
        this.enviandoMensaje = false;
        const t = await this.toast.create({ message: e?.error?.error || 'No se pudo enviar', duration: 2200, color: 'danger' });
        await t.present();
      },
    });
  }

  estadoLabel(e: string) { return ESTADO_CONFIG[e as EstadoOrden]?.label ?? e; }
  estadoColor(e: string) { return ESTADO_CONFIG[e as EstadoOrden]?.color ?? 'medium'; }

  get siguientes(): EstadoOrden[] {
    if (!this.orden?.estado) return [];
    const lista = this.estadosSiguientes[this.orden.estado] || [];
    if (!this.auth.tieneRol('admin')) {
      return lista.filter(e => e !== 'cancelada');
    }
    return lista;
  }

  async cambiarEstado(estado: EstadoOrden) {
    const conf = await this.alert.create({
      header: 'Cambiar estado',
      message: `¿Cambiar a "${this.estadoLabel(estado)}"?`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Confirmar', handler: () => this.ejecutarCambioEstado(estado) },
      ],
    });
    await conf.present();
  }

  private async ejecutarCambioEstado(estado: EstadoOrden) {
    const l = await this.loading.create({ message: 'Cambiando estado...' });
    await l.present();
    this.ordenSvc.cambiarEstado(this.orden!.id!, estado).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        await l.dismiss();
        this.cargar(this.orden!.id!);
        this.mostrarToast('Estado actualizado');
      },
      error: async (err) => {
        await l.dismiss();
        this.mostrarAlertError(err.error?.error);
      },
    });
  }

  async asignarTecnico(tecnico_id: number) {
    // Cada rol usa el endpoint que tiene permitido (admin → /ordenes, recepción → /recepcion).
    const op = this.auth.tieneRol('admin')
      ? this.ordenSvc.asignarTecnico(this.orden!.id!, tecnico_id)
      : this.rec.asignarTecnico(this.orden!.id!, tecnico_id);
    op.pipe(takeUntil(this.destroy$)).subscribe({
      next: () => { this.cargar(this.orden!.id!); this.mostrarToast('Mecánico asignado'); },
      error: () => this.mostrarToast('No se pudo asignar el mecánico'),
    });
  }

  agregarAvance() {
    if (!this.nuevoAvance.trim()) return;
    this.ordenSvc.addAvance(this.orden!.id!, this.nuevoAvance).pipe(takeUntil(this.destroy$)).subscribe({
      next: res => {
        this.avances.push(res.data);
        this.nuevoAvance = '';
        this.mostrarToast('Avance registrado');
      },
    });
  }

  agregarRepuesto() {
    if (!this.nuevoRepuesto.nombre.trim()) return;
    this.ordenSvc.addRepuesto(this.orden!.id!, this.nuevoRepuesto).pipe(takeUntil(this.destroy$)).subscribe({
      next: res => {
        this.repuestos.push(res.data);
        this.nuevoRepuesto = { nombre: '', cantidad: 1, costo_unitario: 0 };
        this.mostrarFormRepuesto = false;
        this.cargar(this.orden!.id!);
        this.mostrarToast('Repuesto agregado');
      },
    });
  }

  agregarALista() {
    if (!this.nuevoRepuesto.nombre.trim()) return;
    this.listaSolicitud.push({ nombre: this.nuevoRepuesto.nombre.trim(), cantidad: this.nuevoRepuesto.cantidad || 1 });
    this.nuevoRepuesto = { nombre: '', cantidad: 1, costo_unitario: 0 };
  }

  quitarDeLista(i: number) { this.listaSolicitud.splice(i, 1); }

  enviarSolicitudes() {
    if (!this.listaSolicitud.length || this.enviandoSolicitud) return;
    this.enviandoSolicitud = true;
    let pendientes = this.listaSolicitud.length;
    const items = [...this.listaSolicitud];
    for (const p of items) {
      this.mecSvc.solicitarRepuesto(this.orden!.id!, p.nombre, p.cantidad)
        .pipe(takeUntil(this.destroy$)).subscribe({
          next: res => {
            this.repuestos.push(res.data);
            if (--pendientes <= 0) {
              this.listaSolicitud = [];
              this.enviandoSolicitud = false;
              this.mostrarFormSolicitud = false;
              this.mostrarToast(`${items.length} repuesto${items.length > 1 ? 's' : ''} solicitado${items.length > 1 ? 's' : ''}`);
            }
          },
          error: () => { this.enviandoSolicitud = false; },
        });
    }
  }

  async editarRepuesto(r: OrdenRepuesto) {
    const al = await this.alert.create({
      header: `Cotizar: ${r.nombre}`,
      inputs: [
        { name: 'costo_unitario', type: 'number', placeholder: 'Precio unitario (₡)', min: 0, value: r.costo_unitario || '' },
        { name: 'cantidad', type: 'number', placeholder: 'Cantidad', min: 1, value: r.cantidad },
        { name: 'estado', type: 'text', placeholder: 'Estado (disponible, pendiente, pedido_especial)', value: 'disponible' },
      ],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Guardar',
          handler: (v) => {
            const precio = parseFloat(v.costo_unitario) || 0;
            const cant = parseInt(v.cantidad, 10) || r.cantidad;
            const estado = ['disponible', 'pendiente', 'pedido_especial'].includes(v.estado) ? v.estado : 'disponible';
            this.ordenSvc.updateRepuesto(this.orden!.id!, r.id!, { nombre: r.nombre, cantidad: cant, costo_unitario: precio, estado })
              .pipe(takeUntil(this.destroy$)).subscribe({
                next: res => {
                  Object.assign(r, res.data);
                  this.cargar(this.orden!.id!);
                  this.mostrarToast('Repuesto actualizado');
                },
              });
          },
        },
      ],
    });
    await al.present();
  }

  async eliminarRepuesto(r: OrdenRepuesto) {
    const conf = await this.alert.create({
      header: 'Eliminar repuesto',
      message: `¿Eliminar "${r.nombre}"?`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Eliminar',
          handler: () => {
            this.ordenSvc.deleteRepuesto(this.orden!.id!, r.id!).pipe(takeUntil(this.destroy$)).subscribe({
              next: () => {
                this.repuestos = this.repuestos.filter(x => x.id !== r.id);
                this.cargar(this.orden!.id!);
              },
            });
          },
        },
      ],
    });
    await conf.present();
  }

  get totalRepuestos() {
    return this.repuestos.reduce((s, r) => s + r.cantidad * r.costo_unitario, 0);
  }

  get totalOrden() {
    if (!this.orden) return 0;
    return (this.orden.costo_mano_obra || 0) + this.totalRepuestos - (this.orden.descuento || 0);
  }

  guardarChecklist() {
    this.ordenSvc.saveChecklist(this.orden!.id!, this.checklist).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => this.mostrarToast('Checklist guardado'),
      error: (err) => this.mostrarAlertError(err.error?.error),
    });
  }

  get checklistCompleto(): boolean {
    const c = this.checklist;
    return c.prueba_realizada && c.lavado && c.calidad_revisada && c.facturacion_lista;
  }

  get puedeEntregar(): boolean {
    return this.orden?.estado === 'lista_entrega' && this.auth.tieneRol('admin');
  }

  async facturarYEntregar() {
    if (!this.checklistCompleto) {
      const a = await this.alert.create({
        header: 'Checklist incompleto',
        message: 'Completá prueba, lavado, calidad y facturación antes de entregar.',
        buttons: ['OK'],
      });
      await a.present();
      return;
    }

    const conf = await this.alert.create({
      header: 'Confirmar entrega',
      message: `Total a cobrar: ₡${this.totalOrden.toLocaleString('es-CR')}. ¿Cerrar la orden y marcarla como entregada?`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Entregar', handler: () => this.ejecutarCierre() },
      ],
    });
    await conf.present();
  }

  private async ejecutarCierre() {
    const l = await this.loading.create({ message: 'Cerrando orden...' });
    await l.present();
    // Persistir checklist primero, luego cerrar
    this.ordenSvc.saveChecklist(this.orden!.id!, this.checklist).pipe(takeUntil(this.destroy$)).subscribe(() => {
      this.ordenSvc.cerrar(this.orden!.id!, this.cierre).pipe(takeUntil(this.destroy$)).subscribe({
        next: async () => {
          await l.dismiss();
          this.cargar(this.orden!.id!);
          this.mostrarToast('Orden entregada y facturada');
        },
        error: async (err) => {
          await l.dismiss();
          this.mostrarAlertError(err.error?.error);
        },
      });
    });
  }

  // ===== Fotos de evidencia =====
  get fotosPorTipo(): { tipo: string; label: string; fotos: OrdenFoto[] }[] {
    return this.tiposFoto
      .map(t => ({ tipo: t.valor, label: t.label, fotos: this.fotos.filter(f => f.tipo === t.valor) }))
      .filter(g => g.fotos.length > 0);
  }

  async onArchivoSeleccionado(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      this.mostrarAlertError('El archivo debe ser una imagen');
      input.value = '';
      return;
    }

    this.subiendoFoto = true;
    try {
      const dataUrl = await comprimirImagen(file);
      this.ordenSvc.addFoto(this.orden!.id!, { url: dataUrl, tipo: this.tipoFoto }).pipe(takeUntil(this.destroy$)).subscribe({
        next: res => {
          this.fotos.push(res.data);
          this.subiendoFoto = false;
          this.mostrarToast('Foto agregada');
        },
        error: err => {
          this.subiendoFoto = false;
          this.mostrarAlertError(err.error?.error || 'No se pudo subir la foto');
        },
      });
    } catch {
      this.subiendoFoto = false;
      this.mostrarAlertError('No se pudo procesar la imagen');
    }
    input.value = '';
  }

  async verFoto(foto: OrdenFoto) {
    const a = await this.alert.create({
      cssClass: 'foto-preview-alert',
      message: `<img src="${foto.url}" style="width:100%;border-radius:8px" />`,
      buttons: ['Cerrar'],
    });
    await a.present();
  }

  async eliminarFoto(foto: OrdenFoto) {
    const conf = await this.alert.create({
      header: 'Eliminar foto',
      message: '¿Eliminar esta evidencia?',
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        {
          text: 'Eliminar',
          role: 'destructive',
          handler: () => {
            this.ordenSvc.deleteFoto(this.orden!.id!, foto.id!).pipe(takeUntil(this.destroy$)).subscribe({
              next: () => {
                this.fotos = this.fotos.filter(f => f.id !== foto.id);
                this.mostrarToast('Foto eliminada');
              },
            });
          },
        },
      ],
    });
    await conf.present();
  }

  formatFecha(f: string): string {
    if (!f) return '—';
    return new Date(f).toLocaleString('es-CR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit', hour12: true });
  }

  duracion(inicio: string, fin: string | null): string {
    if (!inicio) return '';
    const end = fin ? new Date(fin).getTime() : Date.now();
    const min = Math.round((end - new Date(inicio).getTime()) / 60000);
    if (min < 1) return '< 1 min';
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h < 24) return m ? `${h}h ${m}min` : `${h}h`;
    const d = Math.floor(h / 24);
    const rh = h % 24;
    return rh ? `${d}d ${rh}h` : `${d}d`;
  }

  get duracionTotal(): string {
    if (!this.tiempos.length) return '—';
    const inicio = this.tiempos[0].inicio;
    const ultimo = this.tiempos[this.tiempos.length - 1];
    return this.duracion(inicio, ultimo.fin);
  }

  private async mostrarToast(msg: string) {
    const t = await this.toast.create({ message: msg, duration: 2000, color: 'success' });
    await t.present();
  }

  private async mostrarAlertError(msg?: string) {
    const a = await this.alert.create({ header: 'Error', message: msg || 'Ocurrió un error', buttons: ['OK'] });
    await a.present();
  }

  // ===== Garantía =====
  estadoGarantiaLabel(e: EstadoGarantia) { return ESTADO_GARANTIA_CONFIG[e]?.label ?? e; }
  estadoGarantiaColor(e: EstadoGarantia) { return ESTADO_GARANTIA_CONFIG[e]?.color ?? 'medium'; }

  // Días restantes de cobertura desde la fecha de entrega real
  get diasGarantiaRestantes(): number | null {
    if (!this.orden?.fecha_entrega_real || !this.orden?.garantia_dias) return null;
    const entrega = new Date(this.orden.fecha_entrega_real);
    const vence = new Date(entrega.getTime() + this.orden.garantia_dias * 86400000);
    return Math.ceil((vence.getTime() - Date.now()) / 86400000);
  }

  get garantiaVigente(): boolean {
    const d = this.diasGarantiaRestantes;
    return d !== null && d >= 0;
  }

  registrarReclamo() {
    if (!this.nuevoReclamo.descripcion_problema.trim()) return;
    this.garantiaSvc.create({ orden_id: this.orden!.id!, ...this.nuevoReclamo }).pipe(takeUntil(this.destroy$)).subscribe({
      next: res => {
        this.garantias.unshift(res.data);
        this.nuevoReclamo = { descripcion_problema: '', cubre_repuestos: false, cubre_mano_obra: false };
        this.mostrarFormReclamo = false;
        this.mostrarToast('Reclamo de garantía registrado');
      },
      error: err => this.mostrarAlertError(err.error?.error),
    });
  }

  // ===== Notificar al cliente por WhatsApp (click-to-send) =====
  async notificarWhatsApp() {
    if (!this.orden?.cliente_telefono) {
      this.mostrarAlertError('El cliente no tiene teléfono registrado');
      return;
    }
    const ctx: WaContexto = {
      nombre: this.orden.cliente_nombre || '',
      marca: this.orden.marca,
      modelo: this.orden.modelo,
      numero_orden: this.orden.numero_orden,
      total: this.totalOrden,
      portalLink: `${location.origin}/portal/login`,
    };
    const sugerido = mensajeSugerido(this.orden.estado);

    const buttons = WA_MENSAJES.map(m => ({
      text: m.key === sugerido ? `${m.label}  ·  sugerido` : m.label,
      icon: 'logo-whatsapp',
      handler: () => abrirWhatsApp(this.orden!.cliente_telefono!, m.build(ctx)),
    }));
    buttons.push({ text: 'Cancelar', icon: 'close', role: 'cancel' } as any);

    const sheet = await this.actionSheet.create({ header: 'Notificar al cliente', buttons });
    await sheet.present();
  }

  irAGarantias() { this.router.navigate(['/garantias']); }

  verFactura() { this.router.navigate(['/factura', this.orden!.id]); }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  volver() { this.router.navigate(['/tabs/ordenes']); }
}
