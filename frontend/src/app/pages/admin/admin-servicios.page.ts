import { Component, OnInit, OnDestroy } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AdminService } from '../../services/admin.service';

interface Servicio { id: number; nombre: string; activo: number; orden: number; }

@Component({
  standalone: false,
  selector: 'app-admin-servicios',
  templateUrl: './admin-servicios.page.html',
  styleUrls: ['./admin-servicios.page.scss'],
})
export class AdminServiciosPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  servicios: Servicio[] = [];
  cargando = true;
  guardando = false;
  busqueda = '';

  modalAbierto = false;
  editandoId: number | null = null;
  nombre = '';

  constructor(
    private admin: AdminService,
    private toast: ToastController,
    private alert: AlertController,
  ) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.admin.getServicios().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.servicios = r.data || []; this.cargando = false; if (ev) ev.target.complete(); },
      error: () => { this.cargando = false; if (ev) ev.target.complete(); this.aviso('No se pudieron cargar', 'danger'); },
    });
  }

  get filtrados(): Servicio[] {
    const q = this.busqueda.trim().toLowerCase();
    return q ? this.servicios.filter(s => s.nombre.toLowerCase().includes(q)) : this.servicios;
  }
  get activos(): number { return this.servicios.filter(s => s.activo).length; }
  get filtrando(): boolean { return !!this.busqueda.trim(); }

  abrirModal() { this.editandoId = null; this.nombre = ''; this.modalAbierto = true; }
  abrirEdicion(s: Servicio) { this.editandoId = s.id; this.nombre = s.nombre; this.modalAbierto = true; }
  cerrarModal() { this.modalAbierto = false; this.editandoId = null; this.nombre = ''; }

  guardar() {
    const nombre = this.nombre.trim();
    if (!nombre) { this.aviso('Escribí el nombre del servicio', 'warning'); return; }
    const editando = this.editandoId;
    this.guardando = true;
    const req$ = editando ? this.admin.editarServicio(editando, nombre) : this.admin.crearServicio(nombre);
    req$.pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.guardando = false;
        this.cerrarModal();
        this.cargar();
        this.aviso(editando ? 'Servicio actualizado' : 'Servicio creado');
      },
      error: e => { this.guardando = false; this.aviso(e.error?.error || 'No se pudo guardar', 'danger'); },
    });
  }

  // Desactivar es lo habitual: deja de ofrecerse al agendar, pero las citas que ya
  // lo usaron siguen mostrándose bien (guardan el nombre, no un id).
  toggle(s: Servicio) {
    this.admin.toggleServicio(s.id, !s.activo).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { s.activo = r.data.activo; this.aviso(s.activo ? 'Se vuelve a ofrecer' : 'Ya no se ofrece al agendar'); },
      error: e => this.aviso(e.error?.error || 'No se pudo cambiar', 'danger'),
    });
  }

  async borrar(s: Servicio) {
    const al = await this.alert.create({
      cssClass: 'alert-light',
      header: 'Eliminar servicio',
      message: `¿Eliminar "${s.nombre}"? Si alguna cita lo usó, el sistema no te va a dejar borrarlo y vas a poder desactivarlo.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Eliminar', role: 'destructive', handler: () => this.confirmarBorrar(s) },
      ],
    });
    await al.present();
  }

  private confirmarBorrar(s: Servicio) {
    this.admin.borrarServicio(s.id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => { this.servicios = this.servicios.filter(x => x.id !== s.id); this.aviso('Servicio eliminado'); },
      // El backend devuelve 409 con el conteo cuando ya se usó: se ofrece la salida.
      error: e => this.aviso(e.error?.error || 'No se pudo eliminar', 'warning'),
    });
  }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 2200, color });
    await t.present();
  }
}
