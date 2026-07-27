import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { LoadingController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { PortalService } from '../../services/portal.service';
import { AuthService } from '../../services/auth.service';
import { BiometriaService } from '../../services/biometria.service';
import { emailValido } from '../../utils/validar';

@Component({
  standalone: false,
  selector: 'app-portal-login',
  templateUrl: './portal-login.page.html',
  styleUrls: ['./portal-login.page.scss'],
})
export class PortalLoginPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  email = '';
  password = '';
  verPass = false;
  bioActivado = false;   // hay credenciales guardadas → mostrar botón de huella

  // Ingreso sin contraseña (OTP por correo). Solo para clientes.
  modo: 'clave' | 'codigo' = 'clave';
  codigo = '';
  codigoEnviado = false;   // ya se pidió el código → mostrar el campo para escribirlo
  procesandoCodigo = false;

  // Verificación en dos pasos del personal: la contraseña fue correcta pero falta
  // el código de la app de autenticación. Guardamos el token parcial para canjearlo.
  paso2fa = false;
  tokenParcial = '';
  codigo2fa = '';
  verificando2fa = false;

  constructor(
    private portal: PortalService,
    private auth: AuthService,
    private bio: BiometriaService,
    private router: Router,
    private loading: LoadingController,
    private toast: ToastController
  ) {}

  ngOnInit() {
    // Si ya hay una sesión activa, mandamos a la zona que corresponde.
    if (this.portal.isLoggedIn()) this.router.navigate(['/portal'], { replaceUrl: true });
    else if (this.auth.isLoggedIn()) this.router.navigate([this.rutaStaff()], { replaceUrl: true });
    // ¿Está activado el ingreso biométrico en este dispositivo? (solo nativo)
    this.bio.activado().then(v => (this.bioActivado = v));
  }

  // Login con huella / Face ID: pide biometría, recupera credenciales y entra.
  async ingresarConBiometria() {
    try {
      const cred = await this.bio.obtener();
      if (!cred) return;
      this.email = cred.email;
      this.password = cred.password;
      await this.ingresar();
    } catch {
      /* el usuario canceló o falló la biometría: no hacemos nada */
    }
  }

  // Tras un login exitoso en nativo, ofrece guardar el acceso para la próxima vez.
  private async ofrecerBiometria(email: string, password: string) {
    if (this.bioActivado) return;
    if (!(await this.bio.disponible())) return;
    const t = await this.toast.create({
      message: '¿Activar ingreso con huella/Face ID para la próxima vez?',
      buttons: [
        { text: 'No', role: 'cancel' },
        { text: 'Activar', handler: async () => { try { await this.bio.activar(email, password); } catch {} } },
      ],
      duration: 6000,
      color: 'dark',
    });
    await t.present();
  }

  // Cada rol arranca en su panel: técnico y recepción tienen el suyo; el resto, el dashboard.
  private rutaStaff(): string {
    const rol = this.auth.getUsuario()?.rol;
    if (rol === 'tecnico') return '/mecanico';
    if (rol === 'recepcion') return '/recepcion';
    return '/tabs';
  }

  async ingresar() {
    if (!this.email || !this.password) return;
    if (!emailValido(this.email)) {
      const t = await this.toast.create({ message: 'Ingresá un correo válido', duration: 2500, color: 'warning' });
      return await t.present();
    }
    const l = await this.loading.create({ message: 'Ingresando...', cssClass: 'portal-loading', spinner: 'crescent' });
    await l.present();
    this.auth.loginUnificado(this.email.trim(), this.password).pipe(takeUntil(this.destroy$)).subscribe({
      next: async (res) => {
        await l.dismiss();
        const cred = { email: this.email.trim(), password: this.password };
        // Personal con verificación en dos pasos: todavía no hay sesión, falta el código.
        if (res.data.requiere_2fa && res.data.token_parcial) {
          this.tokenParcial = res.data.token_parcial;
          this.paso2fa = true;
          this.codigo2fa = '';
          return;
        }
        if (res.data.tipo === 'staff' && res.data.usuario && res.data.token) {
          this.auth.aplicarSesionStaff(res.data.token, res.data.usuario);
          await this.ofrecerBiometria(cred.email, cred.password);
          this.router.navigate([this.rutaStaff()], { replaceUrl: true });
        } else if (res.data.cliente && res.data.token) {
          this.portal.aplicarSesion(res.data.token, res.data.cliente);
          await this.ofrecerBiometria(cred.email, cred.password);
          this.router.navigate(['/portal'], { replaceUrl: true });
        }
      },
      error: async (err) => {
        await l.dismiss();
        const t = await this.toast.create({
          message: err.error?.error || 'No se pudo iniciar sesión',
          duration: 2500,
          color: 'danger',
        });
        await t.present();
      },
    });
  }

  // Canjea el código de la app de autenticación (o uno de respaldo) por la sesión.
  async verificar2fa() {
    const codigo = this.codigo2fa.trim();
    if (!codigo || this.verificando2fa) return;
    this.verificando2fa = true;
    this.auth.verificar2FA(this.tokenParcial, codigo).pipe(takeUntil(this.destroy$)).subscribe({
      next: async (res) => {
        this.verificando2fa = false;
        this.auth.aplicarSesionStaff(res.data.token, res.data.usuario);
        this.router.navigate([this.rutaStaff()], { replaceUrl: true });
      },
      error: async (err) => {
        this.verificando2fa = false;
        this.codigo2fa = '';
        // Si venció el token parcial (5 min), hay que empezar el login de nuevo.
        if (err.status === 401) this.cancelar2fa();
        const t = await this.toast.create({
          message: err.error?.error || 'Código incorrecto',
          duration: 2800, color: 'danger',
        });
        await t.present();
      },
    });
  }

  // Vuelve al formulario de contraseña (descarta el intento a medias).
  cancelar2fa() {
    this.paso2fa = false;
    this.tokenParcial = '';
    this.codigo2fa = '';
    this.password = '';
  }

  // Cambia entre "contraseña" y "código al correo".
  usarCodigo() { this.modo = 'codigo'; this.codigoEnviado = false; this.codigo = ''; }
  usarClave() { this.modo = 'clave'; }

  // Paso 1 del OTP: pide el código al correo. Respuesta genérica (no revela si la cuenta existe).
  async enviarCodigo() {
    if (!emailValido(this.email)) {
      const t = await this.toast.create({ message: 'Ingresá un correo válido', duration: 2500, color: 'warning' });
      return await t.present();
    }
    this.procesandoCodigo = true;
    this.portal.solicitarCodigoLogin(this.email.trim()).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        this.procesandoCodigo = false;
        this.codigoEnviado = true;
        const t = await this.toast.create({ message: 'Si tu correo está registrado, te enviamos un código', duration: 3000, color: 'success' });
        await t.present();
      },
      error: async (err) => {
        this.procesandoCodigo = false;
        const t = await this.toast.create({ message: err.error?.error || 'No se pudo enviar el código', duration: 2500, color: 'danger' });
        await t.present();
      },
    });
  }

  // Paso 2 del OTP: valida el código y entra al portal.
  async ingresarConCodigo() {
    if (!this.codigo || this.codigo.trim().length < 4) return;
    const l = await this.loading.create({ message: 'Ingresando...', cssClass: 'portal-loading', spinner: 'crescent' });
    await l.present();
    this.portal.verificarCodigoLogin(this.email.trim(), this.codigo.trim()).pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        await l.dismiss();
        this.router.navigate(['/portal'], { replaceUrl: true });
      },
      error: async (err) => {
        await l.dismiss();
        const t = await this.toast.create({ message: err.error?.error || 'Código inválido o expirado', duration: 2500, color: 'danger' });
        await t.present();
      },
    });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
}
