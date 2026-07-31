import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LoadingController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { PortalService } from '../../services/portal.service';
import { HORAS } from '../../utils/servicios';
import { ahoraTaller } from '../../utils/fecha-cita';

@Component({
  standalone: false,
  selector: 'app-portal-agendar',
  templateUrl: './portal-agendar.page.html',
  styleUrls: ['./portal-agendar.page.scss'],
})
export class PortalAgendarPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  servicios: string[] = [];
  readonly horas = HORAS;
  motos: any[] = [];
  sucursales: any[] = [];
  hoy = new Date().toISOString().slice(0, 10);

  form = { sucursal_id: null as number | null, moto_id: null as number | null, tipo_servicio: '', fecha: '', hora: '', descripcion: '' };
  ocupacion: Record<string, number> = {};
  maxPorHora = 2;
  enviando = false;
  sugiriendo = false;
  msgHora = '';   // aviso transitorio al tocar una hora no disponible (llena o pasada)
  editId: number | null = null;   // si está seteado, la pantalla edita esa cita

  constructor(
    private portal: PortalService,
    private route: ActivatedRoute,
    private router: Router,
    private loading: LoadingController,
    private toast: ToastController
  ) {}

  // Prefill desde "Mi Garaje" (?moto=&servicio=): se aplica una sola vez al cargar motos.
  private prefill: { moto?: number; servicio?: string } | null = null;

  ngOnInit() {
    this.cargarMotos();
    this.cargarServicios();
    this.cargarSucursales();
    const id = this.route.snapshot.paramMap.get('id');
    if (id) { this.cargarParaEditar(+id); return; }
    const qp = this.route.snapshot.queryParamMap;
    const motoQ = qp.get('moto');
    const servQ = qp.get('servicio');
    if (motoQ || servQ) this.prefill = { moto: motoQ ? +motoQ : undefined, servicio: servQ || undefined };
  }
  ionViewWillEnter() { this.cargarMotos(); }

  // Las dos cargas son asíncronas y el prefill necesita ambas, así que cada una avisa
  // al llegar y el prefill se aplica cuando ya están las dos. Sin esto, si las motos
  // llegaban antes que los servicios, el servicio sugerido se perdía en silencio.
  private motosListas = false;
  private serviciosListos = false;

  cargarMotos() {
    this.portal.getMotos().pipe(takeUntil(this.destroy$)).subscribe(r => {
      this.motos = r.data;
      this.motosListas = true;
      this.aplicarPrefill();
    });
  }

  cargarServicios() {
    this.portal.getServicios().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.servicios = r.data || []; this.serviciosListos = true; this.aplicarPrefill(); },
      error: () => { this.serviciosListos = true; this.aplicarPrefill(); },
    });
  }

  // Precarga moto + servicio sugeridos (validados contra los datos reales), una sola vez.
  private aplicarPrefill() {
    if (!this.prefill || this.editId) return;
    if (!this.motosListas || !this.serviciosListos) return;
    if (this.prefill.moto && this.motos.some(m => m.id === this.prefill!.moto)) this.form.moto_id = this.prefill.moto;
    if (this.prefill.servicio && this.servicios.includes(this.prefill.servicio)) this.form.tipo_servicio = this.prefill.servicio;
    this.prefill = null;
  }

  // Carga las sucursales activas. Si solo hay una, la preselecciona (no hay que elegir).
  cargarSucursales() {
    this.portal.getSucursales().pipe(takeUntil(this.destroy$)).subscribe(r => {
      this.sucursales = r.data || [];
      if (!this.form.sucursal_id && this.sucursales.length === 1) {
        this.form.sucursal_id = this.sucursales[0].id;
      }
    });
  }

  // Al cambiar de sucursal, el cupo es otro: se descarta la hora y se recargan los horarios.
  onSucursal() {
    this.form.hora = '';
    this.ocupacion = {};
    if (this.form.fecha) this.onFecha();
  }

  // Modo edición: precarga la cita y la disponibilidad de su fecha (sin borrar la hora).
  private cargarParaEditar(id: number) {
    this.portal.getCita(id).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        const c = r.data;
        if (c.estado !== 'agendado' || c.orden_id) {
          this.toastMsg('Esta cita ya no se puede editar', 'warning');
          this.router.navigate(['/portal/cita', id], { replaceUrl: true });
          return;
        }
        this.editId = id;
        this.form = {
          sucursal_id: c.sucursal_id ?? null,
          moto_id: c.moto_id ?? null,
          tipo_servicio: c.tipo_servicio || '',
          fecha: String(c.fecha).slice(0, 10),
          hora: String(c.hora || '').slice(0, 5),
          descripcion: (c.motivo && c.motivo !== c.tipo_servicio) ? c.motivo : '',
        };
        if (this.form.fecha && this.form.sucursal_id) {
          this.portal.getDisponibilidad(this.form.fecha, this.form.sucursal_id).pipe(takeUntil(this.destroy$)).subscribe(d => {
            this.ocupacion = d.data.ocupacion || {};
            this.maxPorHora = d.data.max || 2;
          });
        }
      },
      error: () => { this.toastMsg('No se pudo cargar la cita', 'danger'); this.router.navigate(['/portal/mis-citas']); },
    });
  }

  // Al elegir fecha, consulta cupos (de esa sucursal) para deshabilitar horas llenas.
  onFecha() {
    this.form.hora = '';
    if (!this.form.fecha || !this.form.sucursal_id) return;
    this.portal.getDisponibilidad(this.form.fecha, this.form.sucursal_id).pipe(takeUntil(this.destroy$)).subscribe(r => {
      this.ocupacion = r.data.ocupacion || {};
      this.maxPorHora = r.data.max || 2;
    });
  }

  horaLlena(h: string): boolean {
    return (this.ocupacion[h] || 0) >= this.maxPorHora;
  }

  horaPasada(h: string): boolean {
    const ahora = ahoraTaller();
    const hoy = ahora.toISOString().slice(0, 10);
    if (this.form.fecha !== hoy) return false;
    return h <= ahora.toISOString().slice(11, 16);
  }

  // Sugiere el próximo horario libre (en la sucursal elegida): precarga fecha + hora.
  sugerir() {
    if (this.sugiriendo) return;
    if (!this.form.sucursal_id) { this.toastMsg('Elegí primero una sucursal', 'warning'); return; }
    this.sugiriendo = true;
    this.portal.getProximoLibre(this.form.sucursal_id).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        if (!r.data) {
          this.sugiriendo = false;
          this.toastMsg('No hay horarios libres en los próximos días', 'warning');
          return;
        }
        const { fecha, hora } = r.data;
        this.form.fecha = fecha;
        // Carga la disponibilidad de ese día y deja la hora seleccionada.
        this.portal.getDisponibilidad(fecha, this.form.sucursal_id!).pipe(takeUntil(this.destroy$)).subscribe({
          next: d => {
            this.ocupacion = d.data.ocupacion || {};
            this.maxPorHora = d.data.max || 2;
            this.form.hora = hora;
            this.sugiriendo = false;
            this.toastMsg('Listo: te sugerimos el próximo horario libre');
          },
          error: () => { this.sugiriendo = false; this.form.hora = hora; },
        });
      },
      error: () => { this.sugiriendo = false; this.toastMsg('No se pudo sugerir un horario', 'danger'); },
    });
  }

  // Selección desde la grilla de horas: ignora las pasadas/llenas y avisa brevemente.
  seleccionarHora(h: string) {
    if (this.horaPasada(h)) return this.flashHora('Esa hora ya pasó. Elegí un horario más tarde.');
    if (this.horaLlena(h)) return this.flashHora('Esa hora ya tiene el máximo de citas. Elegí otra.');
    this.form.hora = h;
  }

  private flashHora(m: string) {
    this.msgHora = m;
    setTimeout(() => (this.msgHora = ''), 2500);
  }

  // Moto seleccionada (para el preview con foto bajo el selector).
  get motoSel(): any { return this.motos.find(m => m.id === this.form.moto_id) || null; }

  // Dirección de la sucursal elegida (para mostrarla bajo el selector).
  get sucursalSelDir(): string | null {
    return this.sucursales.find(s => s.id === this.form.sucursal_id)?.direccion || null;
  }
  irAMotos() { this.router.navigate(['/portal/motos']); }

  get valido(): boolean {
    return !!(this.form.sucursal_id && this.form.moto_id && this.form.tipo_servicio && this.form.fecha && this.form.hora);
  }

  // ¿Hay algo cargado en el formulario? (para mostrar "Limpiar" solo cuando aplica)
  get hayDatos(): boolean {
    return !!(this.form.sucursal_id || this.form.moto_id || this.form.tipo_servicio || this.form.fecha || this.form.hora || this.form.descripcion.trim());
  }

  // Limpia el formulario (solo al crear). Guarda el estado previo —incluida la
  // disponibilidad ya cargada— y ofrece "Deshacer" unos segundos, para que limpiar
  // sin querer no obligue a rehacer todo a mano.
  async limpiar() {
    const previo = { form: { ...this.form }, ocupacion: { ...this.ocupacion }, maxPorHora: this.maxPorHora };
    // Si solo hay una sucursal, se conserva preseleccionada al limpiar.
    const sucursalDefault = this.sucursales.length === 1 ? this.sucursales[0].id : null;
    this.form = { sucursal_id: sucursalDefault, moto_id: null, tipo_servicio: '', fecha: '', hora: '', descripcion: '' };
    this.ocupacion = {};
    this.maxPorHora = 2;
    this.msgHora = '';
    const t = await this.toast.create({
      message: 'Formulario limpiado',
      duration: 5000,
      color: 'dark',
      buttons: [{
        text: 'Deshacer',
        handler: () => {
          this.form = previo.form;
          this.ocupacion = previo.ocupacion;
          this.maxPorHora = previo.maxPorHora;
        },
      }],
    });
    await t.present();
  }

  async agendar() {
    if (!this.valido) return this.toastMsg('Completá moto, servicio, fecha y hora', 'warning');
    if (this.horaPasada(this.form.hora)) return this.toastMsg('Esa hora ya pasó. Elegí un horario más tarde.', 'warning');
    if (this.horaLlena(this.form.hora)) return this.toastMsg('Esa hora ya no está disponible', 'warning');
    const editando = this.editId;
    const l = await this.loading.create({ message: editando ? 'Guardando...' : 'Agendando...', cssClass: 'portal-loading', spinner: 'crescent' });
    await l.present();
    this.enviando = true;
    const datos = {
      sucursal_id: this.form.sucursal_id!,
      moto_id: this.form.moto_id!,
      tipo_servicio: this.form.tipo_servicio,
      fecha: this.form.fecha,
      hora: this.form.hora,
      descripcion: this.form.descripcion.trim() || undefined,
    };
    const op = editando ? this.portal.editarCita(editando, datos) : this.portal.crearCita(datos);
    op.pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        await l.dismiss(); this.enviando = false;
        this.toastMsg(editando ? 'Cita actualizada' : '¡Cita agendada!');
        this.form = { sucursal_id: null, moto_id: null, tipo_servicio: '', fecha: '', hora: '', descripcion: '' };
        this.editId = null;
        this.router.navigate(editando ? ['/portal/cita', editando] : ['/portal/mis-citas']);
      },
      error: async (err) => {
        await l.dismiss(); this.enviando = false;
        this.toastMsg(err.error?.error || (editando ? 'No se pudo actualizar' : 'No se pudo agendar'), 'danger');
        if (this.form.fecha) this.onFecha(); // refresca cupos
      },
    });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private async toastMsg(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 2600, color });
    await t.present();
  }
}
