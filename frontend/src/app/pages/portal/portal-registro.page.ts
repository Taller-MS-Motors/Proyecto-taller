import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild } from '@angular/core';
import { Router } from '@angular/router';
import { LoadingController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { PortalService } from '../../services/portal.service';
import { emailValido } from '../../utils/validar';
import { montarTurnstile, turnstileHabilitado, TurnstileWidget } from '../../shared/turnstile.util';

@Component({
  standalone: false,
  selector: 'app-portal-registro',
  templateUrl: './portal-registro.page.html',
  styleUrls: ['./portal-login.page.scss'],
})
export class PortalRegistroPage implements AfterViewInit, OnDestroy {
  private destroy$ = new Subject<void>();
  nombre = '';
  apellido = '';
  telefono = '';
  email = '';
  cedula = '';
  password = '';
  confirmar = '';
  verPass = false;
  verConfirmar = false;

  // Anti-bot: honeypot (debe quedar vacío) + captcha Turnstile.
  website = '';
  mostrarCaptcha = turnstileHabilitado();
  @ViewChild('tsBox') tsBox?: ElementRef<HTMLElement>;
  private ts?: TurnstileWidget;

  constructor(
    private portal: PortalService,
    private router: Router,
    private loading: LoadingController,
    private toast: ToastController
  ) {}

  async ngAfterViewInit() {
    if (this.tsBox) this.ts = await montarTurnstile(this.tsBox.nativeElement);
  }

  get valido(): boolean {
    return !!(this.nombre.trim() && this.apellido.trim() && this.telefono.trim() && this.cedula.trim() &&
      emailValido(this.email) && this.password.length >= 8 && this.password === this.confirmar);
  }

  async registrar() {
    if (!this.valido) {
      if (this.email.trim() && !emailValido(this.email)) return this.mostrar('Ingresá un correo válido', 'warning');
      if (!this.cedula.trim()) return this.mostrar('La cédula es requerida', 'warning');
      if (this.password && this.password.length < 8) return this.mostrar('La contraseña debe tener al menos 8 caracteres', 'warning');
      if (this.password !== this.confirmar) return this.mostrar('Las contraseñas no coinciden', 'warning');
      return;
    }
    const l = await this.loading.create({ message: 'Creando tu cuenta...', cssClass: 'portal-loading', spinner: 'crescent' });
    await l.present();
    this.portal.registro({
      nombre: this.nombre.trim(), apellido: this.apellido.trim(), telefono: this.telefono.trim(),
      email: this.email.trim(), cedula: this.cedula.trim(), password: this.password,
      website: this.website, turnstileToken: this.ts?.token() || '',
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        await l.dismiss();
        this.mostrar('¡Cuenta creada!');
        this.router.navigate(['/portal'], { replaceUrl: true });
      },
      error: async (err) => {
        await l.dismiss();
        this.ts?.reset();   // token de un solo uso: pedir uno nuevo para el próximo intento
        this.mostrar(err.error?.error || 'No se pudo crear la cuenta', 'danger');
      },
    });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); this.ts?.destroy(); }

  irLogin() {
    this.router.navigate(['/portal/login']);
  }

  private async mostrar(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 2500, color });
    await t.present();
  }
}
