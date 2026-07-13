import { Component, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { PortalService } from '../../services/portal.service';

// Apariencia (icono + color) según el evento que generó la notificación.
const META_TIPO: Record<string, { icon: string; tono: string }> = {
  agendado:         { icon: 'calendar-outline',          tono: 'azul' },
  estado:           { icon: 'sync-outline',              tono: 'azul' },
  en_revision:      { icon: 'search-outline',            tono: 'azul' },
  en_mantenimiento: { icon: 'construct-outline',         tono: 'ambar' },
  listo:            { icon: 'checkmark-circle-outline',  tono: 'verde' },
  entregado:        { icon: 'checkmark-done-outline',    tono: 'verde' },
  cancelado:        { icon: 'close-circle-outline',      tono: 'rojo' },
  recordatorio:     { icon: 'alarm-outline',             tono: 'azul' },
  presupuesto:      { icon: 'receipt-outline',           tono: 'ambar' },
  cortesia:         { icon: 'gift-outline',              tono: 'rosa' },
  mensaje:          { icon: 'chatbubble-ellipses-outline', tono: 'azul' },
};

@Component({
  standalone: false,
  selector: 'app-portal-notificaciones',
  templateUrl: './portal-notificaciones.page.html',
  styleUrls: ['./portal-notificaciones.page.scss'],
})
export class PortalNotificacionesPage implements OnDestroy {
  private destroy$ = new Subject<void>();
  notificaciones: any[] = [];
  cargando = true;

  constructor(
    private portal: PortalService,
    private router: Router,
    private toast: ToastController,
  ) {}

  ionViewWillEnter() { this.cargar(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.portal.getNotificaciones().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.notificaciones = r.data;
        this.cargando = false;
        this.sincronizarContador();
        if (ev) ev.target.complete();
      },
      error: () => { this.cargando = false; if (ev) ev.target.complete(); },
    });
  }

  get hayLeidas(): boolean { return this.notificaciones.some(n => n.leida); }
  get hayNoLeidas(): boolean { return this.notificaciones.some(n => !n.leida); }

  // Mantiene el badge de la campana en sintonía con lo que se ve en el feed.
  private sincronizarContador() {
    this.portal.fijarContador(this.notificaciones.filter(n => !n.leida).length);
  }

  icono(n: any): string { return (META_TIPO[n?.tipo] || META_TIPO['estado']).icon; }
  tono(n: any): string { return (META_TIPO[n?.tipo] || META_TIPO['estado']).tono; }

  // Tiempo relativo legible ("Hace 2 h").
  hace(fecha: string): string {
    if (!fecha) return '';
    const min = Math.round((Date.now() - new Date(fecha).getTime()) / 60000);
    if (min < 1) return 'Recién';
    if (min < 60) return `Hace ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `Hace ${h} h`;
    return `Hace ${Math.round(h / 24)} d`;
  }

  // Al tocar: marca esa sola como leída y abre el detalle de la cita ligada (si hay).
  abrir(n: any) {
    if (!n.leida) {
      n.leida = 1;
      this.sincronizarContador();
      this.portal.leerNotificacion(n.id).pipe(takeUntil(this.destroy$)).subscribe();
    }
    if (n?.cita_id) this.router.navigate(['/portal/cita', n.cita_id]);
    else this.router.navigate(['/portal/mis-citas']);
  }

  // Marca todas como leídas (sin salir del feed).
  leerTodas() {
    this.notificaciones.forEach(n => (n.leida = 1));
    this.portal.leerNotificaciones().pipe(takeUntil(this.destroy$)).subscribe();
  }

  // Deslizar para eliminar una notificación.
  eliminar(n: any, sliding?: any) {
    sliding?.close();
    const idx = this.notificaciones.indexOf(n);
    if (idx > -1) this.notificaciones.splice(idx, 1);
    this.sincronizarContador();
    this.portal.eliminarNotificacion(n.id).pipe(takeUntil(this.destroy$)).subscribe({ error: () => this.cargar() });
  }

  // Borra todas las leídas (limpia el feed; deja las pendientes).
  async limpiarLeidas() {
    this.notificaciones = this.notificaciones.filter(n => !n.leida);
    this.portal.limpiarNotificacionesLeidas().pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        const t = await this.toast.create({ message: 'Notificaciones leídas eliminadas', duration: 1500, color: 'medium' });
        await t.present();
      },
      error: () => this.cargar(),
    });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
}
