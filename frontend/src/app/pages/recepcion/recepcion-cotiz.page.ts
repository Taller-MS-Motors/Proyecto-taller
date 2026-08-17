import { Component, OnInit, OnDestroy } from '@angular/core';
import { ToastController, AlertController } from '@ionic/angular';
import { forkJoin, Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { RecepcionService } from '../../services/recepcion.service';
import { abrirWhatsApp } from '../../shared/whatsapp.util';

interface PiezaNueva { nombre: string; monto: number | null; }

// Los tres campos del formulario que se eligen de una lista. Comparten un solo
// selector: lo que cambia es de dónde salen las opciones y cómo se rotulan.
type CampoPicker = 'cliente' | 'orden' | 'tecnico';

@Component({
  standalone: false,
  selector: 'app-recepcion-cotiz',
  templateUrl: './recepcion-cotiz.page.html',
  styleUrls: ['./recepcion-cotiz.page.scss'],
})
export class RecepcionCotizPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  vista: 'pendiente' | 'enviada' = 'pendiente';
  cotizaciones: any[] = [];
  repuestos: Record<number, any[]> = {};
  cargando = true;

  // Buscador y filtro de la lista. Como en el selector, la lista mostrada es un campo
  // y no un getter: dentro de un *ngFor, un getter devuelve un arreglo nuevo en cada
  // ciclo de detección de cambios y Angular vuelve a diferenciar todo en cada tecla.
  busqueda = '';
  filtroAprob: 'todas' | 'aprobado' | 'rechazado' = 'todas';
  cotizacionesFiltradas: any[] = [];

  // --- Formulario de nueva cotización ---
  mostrarForm = false;
  clientes: any[] = [];
  // Selector compartido: qué campo está abierto, qué se escribió y qué queda visible.
  picker: CampoPicker | null = null;
  busquedaPicker = '';
  opcionesFiltradas: any[] = [];
  ordenesCliente: any[] = [];
  tecnicos: any[] = [];
  guardando = false;
  form: { cliente_id: number | null; orden_id: number | null; tecnico_id: number | null; piezas: PiezaNueva[]; mano_obra: number | null } = {
    cliente_id: null, orden_id: null, tecnico_id: null, piezas: [{ nombre: '', monto: null }], mano_obra: null,
  };

  // Edición de costos por orden (mano de obra + descuento).
  editandoCostos: number | null = null;
  costosEdit: { costo_mano_obra: number | null; descuento: number | null } = { costo_mano_obra: null, descuento: null };

  readonly aprobLabel: Record<string, string> = { pendiente: 'Pendiente', aprobado: 'Aprobado', rechazado: 'Rechazado' };
  readonly aprobPill: Record<string, string> = { pendiente: 'amber', aprobado: 'green', rechazado: 'rose' };

  // Los textos del selector, juntos: son lo único que cambia entre los tres campos.
  private readonly TEXTOS: Record<CampoPicker, { titulo: string; placeholder: string; vacio: string }> = {
    cliente: { titulo: 'Elegí un cliente', placeholder: 'Nombre, teléfono o correo', vacio: 'Ningún cliente coincide con la búsqueda.' },
    orden:   { titulo: 'Elegí la orden', placeholder: 'Número de orden, moto o placa', vacio: 'Ninguna orden coincide con la búsqueda.' },
    tecnico: { titulo: 'Asignar mecánico', placeholder: 'Nombre del mecánico', vacio: 'Ningún mecánico coincide con la búsqueda.' },
  };

  constructor(private rec: RecepcionService, private toast: ToastController, private alert: AlertController) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.editandoCostos = null;
    this.rec.getCotizaciones(this.vista).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.cotizaciones = r.data;
        this.aplicarFiltros();
        this.repuestos = {};
        if (r.data.length) {
          const calls = r.data.map(o => this.rec.getRepuestos(o.id));
          forkJoin(calls).pipe(takeUntil(this.destroy$)).subscribe({
            next: results => { r.data.forEach((o, i) => this.repuestos[o.id] = results[i].data); this.cargando = false; if (ev) ev.target.complete(); },
            error: () => { this.cargando = false; if (ev) ev.target.complete(); },
          });
        } else {
          this.cargando = false; if (ev) ev.target.complete();
        }
      },
      error: () => { this.cargando = false; if (ev) ev.target.complete(); },
    });
  }

  totalCotiz(o: any): number {
    return Number(o.costo_mano_obra || 0) + Number(o.costo_repuestos || 0) - Number(o.descuento || 0);
  }

  // ───── Formulario nueva cotización ─────
  abrirForm() {
    this.mostrarForm = true;
    this.form = { cliente_id: null, orden_id: null, tecnico_id: null, piezas: [{ nombre: '', monto: null }], mano_obra: null };
    this.ordenesCliente = [];
    if (!this.clientes.length) {
      this.rec.getClientes().pipe(takeUntil(this.destroy$)).subscribe({
        // Si llegan con el selector ya abierto, se refleja sin tener que cerrarlo.
        next: r => { this.clientes = r.data; if (this.picker === 'cliente') this.opcionesFiltradas = r.data; },
      });
    }
    this.cargarTecnicos();
  }
  cerrarForm() { this.mostrarForm = false; }

  // ───── Selector compartido (cliente, orden, mecánico) ─────
  get clienteElegido(): any | null { return this.clientes.find(c => c.id === this.form.cliente_id) || null; }
  get ordenElegida(): any | null { return this.ordenesCliente.find(o => o.id === this.form.orden_id) || null; }
  get tecnicoElegido(): any | null { return this.tecnicos.find(t => t.id === this.form.tecnico_id) || null; }

  get pickerTitulo(): string { return this.picker ? this.TEXTOS[this.picker].titulo : ''; }
  get pickerPlaceholder(): string { return this.picker ? this.TEXTOS[this.picker].placeholder : ''; }
  get pickerVacio(): string { return this.picker ? this.TEXTOS[this.picker].vacio : ''; }

  // De dónde salen las opciones de cada campo.
  private opcionesDe(campo: CampoPicker): any[] {
    if (campo === 'cliente') return this.clientes;
    if (campo === 'orden') return this.ordenesCliente;
    // El mecánico es opcional, así que tiene que poder dejarse sin asignar: con el
    // action-sheet, una vez elegido uno no había forma de volver atrás.
    return [{ id: null, nombre: 'Sin asignar' }, ...this.tecnicos];
  }

  abrirPicker(campo: CampoPicker) {
    // Sin cliente no hay órdenes que mostrar; el botón ya viene deshabilitado, esto
    // cubre el caso de que se lo llame igual.
    if (campo === 'orden' && !this.form.cliente_id) return;
    // Se abre siempre con la lista completa: la búsqueda anterior ya no aplica.
    this.picker = campo;
    this.busquedaPicker = '';
    this.opcionesFiltradas = this.opcionesDe(campo);
  }

  cerrarPicker() { this.picker = null; }

  filtrarPicker(ev: any) {
    // Se guarda el texto tal cual se escribió (el input lo refleja con [value]) y se
    // normaliza aparte: asignar la versión en minúsculas reescribiría lo tecleado.
    const raw: string = ev?.target?.value ?? '';
    this.busquedaPicker = raw;
    if (!this.picker) return;
    const q = raw.trim().toLowerCase();
    const todas = this.opcionesDe(this.picker);
    this.opcionesFiltradas = !q ? todas : todas.filter(o => this.textoDe(o).toLowerCase().includes(q));
  }

  // Lo que se compara al buscar: los mismos datos que se ven en la fila, más los que
  // uno tiene a mano para buscar (la placa de la moto, el correo del cliente).
  private textoDe(o: any): string {
    if (this.picker === 'cliente') return `${o.nombre || ''} ${o.apellido || ''} ${o.telefono || ''} ${o.email || ''}`;
    if (this.picker === 'orden') return `${o.numero_orden || ''} ${o.marca || ''} ${o.modelo || ''} ${o.placa || ''}`;
    return `${o.nombre || ''}`;
  }

  tituloOpcion(o: any): string {
    if (this.picker === 'cliente') return `${o.nombre} ${o.apellido}`;
    if (this.picker === 'orden') return o.numero_orden;
    return o.nombre;
  }

  subtituloOpcion(o: any): string {
    if (this.picker === 'cliente') return o.telefono || o.email || 'Sin contacto';
    if (this.picker === 'orden') return [`${o.marca || ''} ${o.modelo || ''}`.trim(), o.placa].filter(Boolean).join(' · ');
    return o.id === null ? 'La cotización queda sin mecánico' : '';
  }

  esElegida(o: any): boolean {
    if (this.picker === 'cliente') return o.id === this.form.cliente_id;
    if (this.picker === 'orden') return o.id === this.form.orden_id;
    return o.id === this.form.tecnico_id;
  }

  elegirOpcion(o: any) {
    const campo = this.picker;
    this.picker = null;
    if (campo === 'cliente') { this.form.cliente_id = o.id; this.onClienteChange(); }
    else if (campo === 'orden') { this.form.orden_id = o.id; this.onOrdenChange(); }
    else if (campo === 'tecnico') { this.form.tecnico_id = o.id; }
  }

  // Sirve para las opciones del selector y para las tarjetas de la lista: en ambos
  // casos la identidad es el id. La opción "Sin asignar" no tiene, de ahí el -1.
  trackId(_i: number, x: any) { return x?.id ?? -1; }

  // ───── Buscador y filtro de la lista ─────
  cambiarVista(v: 'pendiente' | 'enviada') {
    if (this.vista === v) return;
    this.vista = v;
    // Se limpian al cambiar de pestaña: un filtro heredado de la otra vista deja la
    // lista vacía sin motivo aparente.
    this.limpiarFiltros(false);
    this.cargar();
  }

  buscar(ev: any) {
    this.busqueda = ev?.target?.value ?? '';
    this.aplicarFiltros();
  }

  setFiltro(f: 'todas' | 'aprobado' | 'rechazado') {
    this.filtroAprob = f;
    this.aplicarFiltros();
  }

  limpiarFiltros(aplicar = true) {
    this.busqueda = '';
    this.filtroAprob = 'todas';
    if (aplicar) this.aplicarFiltros();
  }

  private aplicarFiltros() {
    const q = this.busqueda.trim().toLowerCase();
    this.cotizacionesFiltradas = this.cotizaciones.filter(o => {
      // El filtro por aprobación solo tiene sentido en Enviadas: en Pendientes todas
      // están sin responder y no habría nada que separar.
      if (this.vista === 'enviada' && this.filtroAprob !== 'todas' && o.aprobacion_cliente !== this.filtroAprob) return false;
      if (!q) return true;
      return `${o.cliente_nombre || ''} ${o.cliente_apellido || ''} ${o.numero_orden || ''} ${o.marca || ''} ${o.modelo || ''} ${o.placa || ''} ${o.tecnico_nombre || ''}`
        .toLowerCase().includes(q);
    });
  }

  onClienteChange() {
    this.form.orden_id = null;
    this.ordenesCliente = [];
    this.cargarTecnicos();
    if (this.form.cliente_id) {
      this.rec.getOrdenesCliente(this.form.cliente_id).pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.ordenesCliente = r.data });
    }
  }

  // Al elegir la orden, los mecánicos se acotan a la sede de esa orden (+ "ambas").
  onOrdenChange() {
    const o = this.ordenesCliente.find(x => x.id === this.form.orden_id);
    this.cargarTecnicos(o?.sucursal_id ?? null);
  }

  private cargarTecnicos(sucursalId?: number | null) {
    this.rec.getTecnicos(sucursalId).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.tecnicos = r.data;
        if (this.form.tecnico_id && !this.tecnicos.some((t: any) => t.id === this.form.tecnico_id)) this.form.tecnico_id = null;
      },
    });
  }

  agregarPieza() { this.form.piezas.push({ nombre: '', monto: null }); }
  quitarPieza(i: number) { this.form.piezas.splice(i, 1); if (!this.form.piezas.length) this.agregarPieza(); }

  get totalForm(): number {
    const piezas = this.form.piezas.reduce((s, p) => s + (Number(p.monto) || 0), 0);
    return piezas + (Number(this.form.mano_obra) || 0);
  }

  get formValido(): boolean {
    return !!this.form.orden_id && this.form.piezas.some(p => p.nombre.trim() && Number(p.monto) > 0);
  }

  guardarCotizacion() {
    if (!this.formValido) { this.aviso('Elegí una orden y al menos una pieza con monto', 'warning'); return; }
    this.guardando = true;
    const piezas = this.form.piezas
      .filter(p => p.nombre.trim() && Number(p.monto) > 0)
      .map(p => ({ nombre: p.nombre.trim(), cantidad: 1, costo_unitario: Number(p.monto) || 0 }));
    // Una sola llamada transaccional: si algo falla, no queda nada a medias.
    this.rec.armarCotizacion(this.form.orden_id!, {
      tecnico_id: this.form.tecnico_id,
      piezas,
      costo_mano_obra: Number(this.form.mano_obra) || 0,
      descuento: 0,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.guardando = false;
        this.mostrarForm = false;
        this.aviso('Cotización guardada', 'success');
        this.cargar();
      },
      error: () => {
        this.guardando = false;
        this.aviso('No se pudo guardar la cotización', 'danger');
      },
    });
  }

  // ───── Edición de piezas existentes ─────
  async editarPieza(o: any, pieza: any) {
    const al = await this.alert.create({
      header: 'Editar pieza',
      inputs: [
        { name: 'nombre', type: 'text', value: pieza.nombre, placeholder: 'Nombre' },
        { name: 'costo_unitario', type: 'number', value: pieza.costo_unitario, placeholder: 'Monto (₡)' },
      ],
      buttons: [
        { text: 'Eliminar', role: 'destructive', handler: () => this.eliminarPieza(o, pieza) },
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Guardar', handler: (d) => this.guardarPieza(o, pieza, d) },
      ],
    });
    await al.present();
  }

  private guardarPieza(o: any, pieza: any, d: any) {
    this.rec.updateRepuesto(o.id, pieza.id, { nombre: d.nombre, cantidad: pieza.cantidad || 1, costo_unitario: Number(d.costo_unitario) || 0 })
      .pipe(takeUntil(this.destroy$)).subscribe({ next: () => { this.aviso('Pieza actualizada', 'success'); this.cargar(); }, error: () => this.aviso('No se pudo actualizar', 'danger') });
  }

  private eliminarPieza(o: any, pieza: any) {
    this.rec.deleteRepuesto(o.id, pieza.id).pipe(takeUntil(this.destroy$)).subscribe({ next: () => { this.aviso('Pieza eliminada', 'success'); this.cargar(); }, error: () => this.aviso('No se pudo eliminar', 'danger') });
  }

  // ───── Edición de costos (mano de obra + descuento) ─────
  toggleEditCostos(o: any) {
    if (this.editandoCostos === o.id) { this.editandoCostos = null; return; }
    this.editandoCostos = o.id;
    this.costosEdit = { costo_mano_obra: Number(o.costo_mano_obra) || 0, descuento: Number(o.descuento) || 0 };
  }
  guardarCostos(o: any) {
    this.rec.updateCostos(o.id, { costo_mano_obra: Number(this.costosEdit.costo_mano_obra) || 0, descuento: Number(this.costosEdit.descuento) || 0 })
      .pipe(takeUntil(this.destroy$)).subscribe({ next: () => { this.editandoCostos = null; this.aviso('Costos actualizados', 'success'); this.cargar(); }, error: () => this.aviso('No se pudo actualizar', 'danger') });
  }

  // ───── Acciones de la cotización ─────
  enviar(o: any) {
    this.rec.enviarCotizacion(o.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        const total = this.totalCotiz(o);
        const link = `${window.location.origin}/portal`;
        const msg = `Hola ${o.cliente_nombre}, el presupuesto de tu ${o.marca} ${o.modelo} (orden ${o.numero_orden}) está listo${total ? ` por ₡${total.toLocaleString('es-CR')}` : ''}. Podés revisarlo y aprobarlo desde el portal: ${link}`;
        abrirWhatsApp(o.cliente_telefono, msg);
        this.aviso('Cotización enviada', 'success');
        this.cargar();
      },
      error: () => this.aviso('No se pudo enviar (revisá el estado de la orden)', 'danger'),
    });
  }

  aprobar(o: any) {
    this.rec.aprobarCotizacion(o.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => { this.aviso('Marcada como aprobada', 'success'); this.cargar(); },
      error: () => this.aviso('No se pudo aprobar', 'danger'),
    });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private async aviso(message: string, color: string) {
    const t = await this.toast.create({ message, duration: 1800, color });
    await t.present();
  }
}
