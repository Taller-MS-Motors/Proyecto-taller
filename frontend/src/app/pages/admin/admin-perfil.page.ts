import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AdminService } from '../../services/admin.service';
import { DashboardService } from '../../services/dashboard.service';
import { AuthService } from '../../services/auth.service';
import { AccesibilidadService } from '../../services/accesibilidad.service';
import { comprimirImagen } from '../../shared/image.util';

@Component({
  standalone: false,
  selector: 'app-admin-perfil',
  templateUrl: './admin-perfil.page.html',
  styleUrls: ['./admin-perfil.page.scss'],
})
export class AdminPerfilPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  perfil: any = null;
  resumen: any = null;
  cuenta = { nombre: '', email: '' };
  pass = { actual: '', nueva: '' };
  cargando = true;
  guardando = false;
  guardandoPass = false;
  subiendoFoto = false;
  verActual = false;
  verNueva = false;

  readonly nivelesTexto = [
    { i: 0, etiqueta: 'A', nombre: 'Normal' },
    { i: 1, etiqueta: 'A', nombre: 'Grande' },
    { i: 2, etiqueta: 'A', nombre: 'Muy grande' },
  ];

  constructor(
    private admin: AdminService,
    private dash: DashboardService,
    private auth: AuthService,
    public a11y: AccesibilidadService,
    private router: Router,
    private toast: ToastController,
  ) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  cargar() {
    this.cargando = true;
    const u = this.auth.getUsuario();
    this.perfil = { ...u, foto: (u as any)?.foto || null };
    this.cuenta = { nombre: u?.nombre || '', email: u?.email || '' };
    this.cargando = false;

    this.admin.getResumen().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => this.resumen = r.data,
    });
    this.dash.getResumen().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => this.resumen = { ...this.resumen, ...r.data },
    });
  }

  get iniciales(): string {
    const p = (this.cuenta.nombre || 'A').trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || 'A';
  }

  get miembroDesde(): string {
    if (!this.perfil?.created_at) return '—';
    return new Date(this.perfil.created_at).toLocaleDateString('es-CR', { month: 'long', year: 'numeric' });
  }

  setTexto(i: number) { this.a11y.setNivel(i); }

  pedirFoto(input: HTMLInputElement) { if (!this.subiendoFoto) input.click(); }

  async onFoto(ev: Event) {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.subiendoFoto = true;
    try {
      const dataUrl = await comprimirImagen(file, 400, 0.8);
      this.admin.updateFoto(dataUrl).pipe(takeUntil(this.destroy$)).subscribe({
        next: r => {
          this.perfil = { ...this.perfil, foto: r.data.foto };
          this.sincronizarSesion({ foto: r.data.foto });
          this.subiendoFoto = false;
          this.aviso('Foto actualizada');
        },
        error: e => { this.subiendoFoto = false; this.aviso(e.error?.error || 'No se pudo subir la foto', 'danger'); },
      });
    } catch {
      this.subiendoFoto = false;
      this.aviso('No se pudo procesar la imagen', 'danger');
    }
  }

  quitarFoto() {
    if (this.subiendoFoto) return;
    this.subiendoFoto = true;
    this.admin.updateFoto(null).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.perfil = { ...this.perfil, foto: null };
        this.sincronizarSesion({ foto: null });
        this.subiendoFoto = false;
        this.aviso('Foto eliminada');
      },
      error: () => { this.subiendoFoto = false; this.aviso('No se pudo quitar', 'danger'); },
    });
  }

  guardarCuenta() {
    if (!this.cuenta.nombre.trim() || !this.cuenta.email.trim()) { this.aviso('Nombre y correo son requeridos', 'warning'); return; }
    this.guardando = true;
    this.admin.updateCuenta({ nombre: this.cuenta.nombre.trim(), email: this.cuenta.email.trim() }).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.sincronizarSesion({ nombre: this.cuenta.nombre.trim(), email: this.cuenta.email.trim() });
        this.guardando = false;
        this.aviso('Cuenta actualizada');
      },
      error: e => { this.guardando = false; this.aviso(e.error?.error || 'No se pudo guardar', 'danger'); },
    });
  }

  cambiarPassword() {
    if (!this.pass.actual || !this.pass.nueva) { this.aviso('Completá ambas contraseñas', 'warning'); return; }
    if (this.pass.nueva.length < 8) { this.aviso('Mínimo 8 caracteres', 'warning'); return; }
    this.guardandoPass = true;
    this.admin.updatePassword(this.pass).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => { this.guardandoPass = false; this.pass = { actual: '', nueva: '' }; this.aviso('Contraseña actualizada'); },
      error: e => { this.guardandoPass = false; this.aviso(e.error?.error || 'No se pudo cambiar', 'danger'); },
    });
  }

  private sincronizarSesion(parcial: { nombre?: string; email?: string; foto?: string | null }) {
    const u = this.auth.getUsuario();
    const token = this.auth.getToken();
    if (u && token) this.auth.aplicarSesionStaff(token, { ...u, ...parcial });
  }

  logout() {
    this.auth.logout();
    this.router.navigate(['/login'], { replaceUrl: true });
  }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 1800, color });
    await t.present();
  }
}
