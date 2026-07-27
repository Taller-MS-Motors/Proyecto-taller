import { AfterViewInit, Component, ElementRef, OnDestroy, OnInit, ViewChild } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
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
export class PortalRegistroPage implements OnInit, AfterViewInit, OnDestroy {
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

  // Paso 2: confirmar el correo con el código de 6 dígitos que se manda al crear la cuenta.
  paso: 1 | 2 = 1;
  codigo = '';
  verificando = false;
  reenviando = false;
  cooldown = 0;
  private timer?: any;

  constructor(
    private portal: PortalService,
    private router: Router,
    private route: ActivatedRoute,
    private loading: LoadingController,
    private toast: ToastController
  ) {}

  // Si venís del login porque tu cuenta existe pero no está verificada
  // (?verificar=1&email=...), saltamos directo al paso 2 con un código fresco.
  ngOnInit() {
    const qp = this.route.snapshot.queryParamMap;
    if (qp.get('verificar') === '1' && qp.get('email')) {
      this.email = qp.get('email')!;
      this.paso = 2;
      this.reenviar();
    }
  }

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
        this.paso = 2;
        this.iniciarCooldown();
        this.mostrar('Te enviamos un código para confirmar tu correo');
      },
      error: async (err) => {
        await l.dismiss();
        this.ts?.reset();   // token de un solo uso: pedir uno nuevo para el próximo intento
        this.mostrar(err.error?.error || 'No se pudo crear la cuenta', 'danger');
      },
    });
  }

  // Confirma el código y entra (el backend ya guarda la sesión vía guardarSesion).
  async verificar() {
    if (!this.codigo || this.codigo.trim().length < 4 || this.verificando) return;
    this.verificando = true;
    this.portal.verificarRegistro(this.email.trim(), this.codigo.trim()).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        this.verificando = false;
        this.mostrar('¡Cuenta confirmada!');
        this.router.navigate(['/portal'], { replaceUrl: true });
      },
      error: async (err) => {
        this.verificando = false;
        this.codigo = '';
        this.mostrar(err.error?.error || 'Código inválido o expirado', 'danger');
      },
    });
  }

  reenviar() {
    if (this.cooldown > 0 || this.reenviando) return;
    this.reenviando = true;
    this.portal.reenviarVerificacion(this.email.trim()).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => { this.reenviando = false; this.iniciarCooldown(); this.mostrar('Te enviamos un código nuevo'); },
      error: async (err) => { this.reenviando = false; this.mostrar(err.error?.error || 'No se pudo reenviar', 'danger'); },
    });
  }

  private iniciarCooldown() {
    this.cooldown = 30;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.cooldown--;
      if (this.cooldown <= 0) clearInterval(this.timer);
    }, 1000);
  }

  ngOnDestroy() {
    this.destroy$.next(); this.destroy$.complete(); this.ts?.destroy();
    if (this.timer) clearInterval(this.timer);
  }

  irLogin() {
    this.router.navigate(['/portal/login']);
  }

  private async mostrar(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 2500, color });
    await t.present();
  }
}
