import { Component, OnDestroy, OnInit } from '@angular/core';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AuthService } from '../../services/auth.service';

// Panel de verificación en dos pasos (TOTP) del personal. Se embebe en el perfil de
// admin, recepción y mecánico — una sola implementación en vez de tres copias.
@Component({
  standalone: false,
  selector: 'app-dosfa',
  templateUrl: './dosfa.component.html',
  styleUrls: ['./dosfa.component.scss'],
})
export class DosFaComponent implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();

  estado = { activado: false, backup_restantes: 0 };
  alta: { secreto: string; secreto_legible: string; uri: string } | null = null;
  codigo = '';
  passBaja = '';
  procesando = false;
  codigosRespaldo: string[] = [];   // solo en memoria: se muestran una única vez

  constructor(private auth: AuthService, private toast: ToastController) {}

  ngOnInit() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private cargar() {
    this.auth.estado2FA().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => this.estado = r.data,
      error: () => {},
    });
  }

  // Paso 1: pide la clave y muestra las instrucciones para la app de autenticación.
  iniciar() {
    this.procesando = true;
    this.codigo = '';
    this.auth.setup2FA().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.alta = r.data; this.procesando = false; },
      error: e => { this.procesando = false; this.aviso(e.error?.error || 'No se pudo iniciar', 'danger'); },
    });
  }

  cancelar() { this.alta = null; this.codigo = ''; }

  // Paso 2: confirma con un código real y activa. Devuelve los códigos de respaldo.
  confirmar() {
    const codigo = this.codigo.trim();
    if (!codigo || this.procesando) return;
    this.procesando = true;
    this.auth.activar2FA(codigo).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.procesando = false;
        this.alta = null;
        this.codigo = '';
        this.codigosRespaldo = r.data.codigos_respaldo;
        this.cargar();
        this.aviso('Verificación en dos pasos activada');
      },
      error: e => { this.procesando = false; this.aviso(e.error?.error || 'No se pudo activar', 'danger'); },
    });
  }

  desactivar() {
    if (!this.passBaja || this.procesando) return;
    this.procesando = true;
    this.auth.desactivar2FA(this.passBaja).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.procesando = false;
        this.passBaja = '';
        this.cargar();
        this.aviso('Verificación en dos pasos desactivada');
      },
      error: e => { this.procesando = false; this.aviso(e.error?.error || 'No se pudo desactivar', 'danger'); },
    });
  }

  async copiarRespaldo() {
    try {
      await navigator.clipboard.writeText(this.codigosRespaldo.join('\n'));
      this.aviso('Códigos copiados');
    } catch {
      this.aviso('No se pudo copiar. Anotalos a mano.', 'warning');
    }
  }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 2000, color });
    await t.present();
  }
}
