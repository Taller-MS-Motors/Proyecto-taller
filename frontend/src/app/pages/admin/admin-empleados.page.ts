import { Component, OnInit, OnDestroy } from '@angular/core';
import { AlertController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { UsuariosService } from '../../services/usuarios.service';
import { AdminService } from '../../services/admin.service';
import { Usuario } from '../../models/usuario.model';

@Component({
  standalone: false,
  selector: 'app-admin-empleados',
  templateUrl: './admin-empleados.page.html',
})
export class AdminEmpleadosPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  usuarios: Usuario[] = [];
  sucursales: any[] = [];
  cargando = true;
  creando = false;
  verPass = false;
  nuevo = { nombre: '', email: '', password: '', password2: '', rol: 'tecnico', telefono: '', sucursal_id: null as number | null };

  readonly rolLabel: Record<string, string> = {
    tecnico: 'Mecánico', recepcion: 'Recepcionista', admin: 'Administración',
  };

  eliminando: number | null = null;

  constructor(
    private svc: UsuariosService,
    private admin: AdminService,
    private toast: ToastController,
    private alert: AlertController,
  ) {}

  ngOnInit() { this.cargar(); this.cargarSucursales(); }
  ionViewWillEnter() { this.cargar(); }

  cargar() {
    this.cargando = true;
    this.svc.getAll().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.usuarios = r.data; this.cargando = false; },
      error: () => { this.cargando = false; },
    });
  }

  cargarSucursales() {
    this.admin.getSucursales().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.sucursales = (r.data || []).filter((s: any) => s.activa) });
  }

  // Cambia el local de un empleado desde la lista (null = atiende ambas).
  cambiarSucursal(u: Usuario, valor: any) {
    const sucursal_id = valor === '' || valor == null ? null : Number(valor);
    this.svc.setSucursal(u.id!, sucursal_id).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        u.sucursal_id = sucursal_id;
        u.sucursal_nombre = this.sucursales.find(s => s.id === sucursal_id)?.nombre || null;
        this.aviso('Sucursal actualizada');
      },
      error: (e) => this.aviso(e.error?.error || 'No se pudo cambiar', 'danger'),
    });
  }

  // ¿Las dos contraseñas coinciden? (solo relevante si ya escribió la confirmación)
  get passCoincide(): boolean {
    return this.nuevo.password === this.nuevo.password2;
  }

  get valido(): boolean {
    return !!(this.nuevo.nombre.trim() && this.nuevo.email.trim() &&
      this.nuevo.password && this.nuevo.password2 && this.passCoincide && this.nuevo.rol);
  }

  crear() {
    if (this.nuevo.password && !this.passCoincide) { this.aviso('Las contraseñas no coinciden', 'warning'); return; }
    if (!this.valido) { this.aviso('Completá nombre, email, contraseña y rol', 'warning'); return; }
    this.creando = true;
    this.svc.create({
      nombre: this.nuevo.nombre.trim(),
      email: this.nuevo.email.trim(),
      password: this.nuevo.password,
      rol: this.nuevo.rol,
      telefono: this.nuevo.telefono.trim() || undefined,
      sucursal_id: this.nuevo.sucursal_id,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.creando = false;
        this.nuevo = { nombre: '', email: '', password: '', password2: '', rol: 'tecnico', telefono: '', sucursal_id: null };
        this.cargar();
        this.aviso('Empleado creado');
      },
      error: (err) => { this.creando = false; this.aviso(err.error?.error || 'No se pudo crear', 'danger'); },
    });
  }

  // Borrado definitivo (pide confirmación). Se van sus tareas, avances y mensajes;
  // las citas y órdenes del taller quedan, pero sin él como responsable.
  async eliminar(u: Usuario) {
    const al = await this.alert.create({
      header: 'Eliminar empleado',
      message: `¿Eliminar a ${u.nombre} definitivamente? Se borrarán sus tareas, avances y mensajes. Sus citas y órdenes se conservan, pero quedarán sin responsable asignado. Esta acción no se puede deshacer.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Eliminar', role: 'destructive', handler: () => this.confirmarEliminar(u) },
      ],
    });
    await al.present();
  }

  private confirmarEliminar(u: Usuario) {
    this.eliminando = u.id!;
    this.svc.eliminar(u.id!).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        this.eliminando = null;
        this.usuarios = this.usuarios.filter(x => x.id !== u.id);
        const t = await this.toast.create({ message: 'Empleado eliminado', duration: 2000, color: 'success' });
        await t.present();
      },
      error: async (err) => {
        this.eliminando = null;
        const t = await this.toast.create({
          message: err.error?.error || 'No se pudo eliminar',
          duration: 5000,
          color: 'warning',
        });
        await t.present();
      },
    });
  }

  toggle(u: Usuario) {
    this.svc.toggleActivo(u.id!, !u.activo).pipe(takeUntil(this.destroy$)).subscribe({ next: () => { u.activo = u.activo ? 0 : 1; } });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  iniciales(n?: string): string {
    const p = (n || '?').trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase();
  }
  avatarColor(rol?: string): string { return rol === 'recepcion' ? 'am' : (rol === 'tecnico' ? 'in' : ''); }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 1800, color });
    await t.present();
  }
}
