import { Component, OnInit, OnDestroy } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AdminService } from '../../services/admin.service';
import { UsuariosService } from '../../services/usuarios.service';
import { Usuario } from '../../models/usuario.model';

@Component({
  standalone: false,
  selector: 'app-admin-tareas',
  templateUrl: './admin-tareas.page.html',
  styleUrls: ['./admin-tareas.page.scss'],
})
export class AdminTareasPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  tareas: any[] = [];
  tecnicos: Usuario[] = [];
  cargando = true;
  guardando = false;
  empleado: number | null = null; // filtro de la lista
  modalAbierto = false;
  // null = estamos creando; con id = estamos corrigiendo esa tarea.
  editandoId: number | null = null;

  // Filtros de la lista (todos del lado del cliente: las tareas ya vienen cargadas).
  busqueda = '';
  // Las tareas hechas no se archivan nunca, así que por defecto se ocultan: la
  // pantalla se abre para ver lo que falta, no el historial.
  verHechas = false;
  form: { tecnico_id: number | null; titulo: string; detalle: string; prioridad: string; vence: string } =
    { tecnico_id: null, titulo: '', detalle: '', prioridad: 'normal', vence: '' };

  readonly prioridades = [
    { v: 'baja', l: 'Baja' }, { v: 'normal', l: 'Normal' }, { v: 'alta', l: 'Alta' }, { v: 'urgente', l: 'Urgente' },
  ];
  readonly prioBadge: Record<string, string> = { baja: 'bg-n', normal: 'bg-in', alta: 'bg-am', urgente: 'bg-rd' };

  constructor(
    private admin: AdminService, private usuarios: UsuariosService,
    private toast: ToastController, private alert: AlertController,
  ) {}

  ngOnInit() {
    this.usuarios.getAll().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.tecnicos = (r.data || []).filter(u => u.rol === 'tecnico' && u.activo); },
    });
    this.cargar();
  }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
  ionViewWillEnter() { this.cargar(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.admin.getTareas(this.empleado).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.tareas = r.data; this.cargando = false; if (ev) ev.target.complete(); },
      error: () => { this.cargando = false; if (ev) ev.target.complete(); },
    });
  }

  // El progreso cuenta SIEMPRE sobre el total, no sobre lo filtrado: si dijera
  // "0/0 completadas" al ocultar las hechas, el número perdería sentido.
  get total(): number { return this.tareas.length; }
  get hechas(): number { return this.tareas.filter(t => t.hecha).length; }

  get tareasFiltradas(): any[] {
    const q = this.busqueda.trim().toLowerCase();
    return this.tareas.filter(t => {
      if (!this.verHechas && t.hecha) return false;
      if (!q) return true;
      return [t.titulo, t.detalle, t.tecnico_nombre].some(c => (c || '').toLowerCase().includes(q));
    });
  }

  // Para distinguir "no hay nada" de "la búsqueda no encontró nada".
  get filtrando(): boolean { return !!this.busqueda.trim(); }

  abrirModal() {
    this.editandoId = null;
    this.form = { tecnico_id: this.form.tecnico_id, titulo: '', detalle: '', prioridad: 'normal', vence: '' };
    this.modalAbierto = true;
  }

  abrirEdicion(t: any) {
    this.editandoId = t.id;
    this.form = {
      tecnico_id: t.tecnico_id,
      titulo: t.titulo || '',
      detalle: t.detalle || '',
      prioridad: t.prioridad || 'normal',
      // La fecha llega como Date o como ISO según la capa; con los 10 primeros
      // caracteres alcanza para input[type=date] y se evita el corrimiento de un
      // día que produce convertir a Date y volver (la zona del taller es UTC-6).
      vence: t.vence ? String(t.vence).slice(0, 10) : '',
    };
    this.modalAbierto = true;
  }

  cerrarModal() { this.modalAbierto = false; this.editandoId = null; }

  guardar() {
    if (!this.form.tecnico_id) { this.aviso('Elegí un mecánico', 'warning'); return; }
    if (!this.form.titulo.trim()) { this.aviso('Escribí un título', 'warning'); return; }

    const datos = {
      tecnico_id: this.form.tecnico_id,
      titulo: this.form.titulo.trim(),
      detalle: this.form.detalle.trim() || undefined,
      prioridad: this.form.prioridad,
      vence: this.form.vence || null,
    };
    const editando = this.editandoId;
    this.guardando = true;

    const req$ = editando ? this.admin.editarTarea(editando, datos) : this.admin.crearTarea(datos);
    req$.pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.guardando = false;
        this.cargar();
        if (editando) {
          // Corregir una tarea es puntual: se cierra y listo.
          this.cerrarModal();
          this.aviso('Tarea actualizada');
        } else {
          // Al asignar, el modal queda abierto y conserva el mecánico: así se le
          // cargan varias seguidas sin reabrirlo ni volver a elegirlo en cada una.
          this.form = { tecnico_id: this.form.tecnico_id, titulo: '', detalle: '', prioridad: 'normal', vence: '' };
          this.aviso('Tarea asignada');
        }
      },
      error: (err) => {
        this.guardando = false;
        this.aviso(err.error?.error || (editando ? 'No se pudo actualizar' : 'No se pudo asignar'), 'danger');
      },
    });
  }

  async borrar(t: any) {
    const al = await this.alert.create({
      cssClass: 'alert-light',
      header: 'Eliminar tarea',
      message: `¿Eliminar "${t.titulo}"? No se puede deshacer.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Eliminar', role: 'destructive', handler: () => {
            this.admin.borrarTarea(t.id).pipe(takeUntil(this.destroy$)).subscribe({
              next: () => { this.tareas = this.tareas.filter(x => x.id !== t.id); this.aviso('Tarea eliminada'); },
              error: () => this.aviso('No se pudo eliminar', 'danger'),
            });
          } },
      ],
    });
    await al.present();
  }

  prioLabel(p: string): string { return (this.prioridades.find(x => x.v === p) || { l: p }).l; }
  vencida(t: any): boolean { return !t.hecha && !!t.vence && new Date(t.vence) < new Date(); }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 1800, color });
    await t.present();
  }
}
