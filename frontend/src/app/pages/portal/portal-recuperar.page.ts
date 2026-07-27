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
  selector: 'app-portal-recuperar',
  templateUrl: './portal-recuperar.page.html',
  styleUrls: ['./portal-login.page.scss'],
})
export class PortalRecuperarPage implements AfterViewInit, OnDestroy {
  private destroy$ = new Subject<void>();
  paso: 1 | 2 = 1;
  email = '';
  codigo = '';
  password = '';
  confirmar = '';

  verPass = false;
  verConfirmar = false;

  cooldown = 0;
  private timer?: any;

  // Anti-bot para el pedido de código: honeypot + captcha Turnstile.
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

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
    if (this.timer) clearInterval(this.timer);
    this.ts?.destroy();
  }

  get emailOk(): boolean {
    return emailValido(this.email);
  }

  get validoPaso2(): boolean {
    return !!(this.codigo.trim().length === 6 &&
      this.password.length >= 6 && this.password === this.confirmar);
  }

  async solicitar() {
    if (!this.emailOk) return this.mostrar('Ingresá un correo válido', 'warning');
    const l = await this.loading.create({ message: 'Enviando código...', cssClass: 'portal-loading', spinner: 'crescent' });
    await l.present();
    this.portal.solicitarCodigo(this.email.trim(), { website: this.website, turnstileToken: this.ts?.token() || '' })
      .pipe(takeUntil(this.destroy$)).subscribe({
      next: async (res) => {
        await l.dismiss();
        this.paso = 2;
        this.ts?.reset();   // deja un token fresco listo por si el usuario reenvía
        this.iniciarCooldown();
        this.mostrar(res.message || 'Si la cuenta existe, te enviamos un código');
      },
      error: async (err) => {
        await l.dismiss();
        this.ts?.reset();
        this.mostrar(err.error?.error || 'No se pudo enviar el código', 'danger');
      },
    });
  }

  async reenviar() {
    if (this.cooldown > 0) return;
    await this.solicitar();
  }

  async confirmar_() {
    if (!this.validoPaso2) {
      if (this.codigo.trim().length !== 6) return this.mostrar('El código tiene 6 dígitos', 'warning');
      if (this.password.length < 6) return this.mostrar('La contraseña debe tener al menos 6 caracteres', 'warning');
      if (this.password !== this.confirmar) return this.mostrar('Las contraseñas no coinciden', 'warning');
      return;
    }
    const l = await this.loading.create({ message: 'Verificando...', cssClass: 'portal-loading', spinner: 'crescent' });
    await l.present();
    this.portal.confirmarRecuperacion({ email: this.email.trim(), codigo: this.codigo.trim(), password: this.password }).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        await l.dismiss();
        this.mostrar('Contraseña actualizada');
        this.router.navigate(['/portal'], { replaceUrl: true });
      },
      error: async (err) => {
        await l.dismiss();
        this.mostrar(err.error?.error || 'No se pudo restablecer la contraseña', 'danger');
      },
    });
  }

  irLogin() {
    this.router.navigate(['/portal/login']);
  }

  private iniciarCooldown() {
    this.cooldown = 60;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.cooldown--;
      if (this.cooldown <= 0) clearInterval(this.timer);
    }, 1000);
  }

  private async mostrar(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 2600, color });
    await t.present();
  }
}
