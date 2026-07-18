import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { AlertController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { PortalService } from '../../services/portal.service';
import { ESTADO_CITA_LABEL } from '../../utils/servicios';
import { badgeProximidad, BadgeProximidad } from '../../utils/fecha-cita';

@Component({
  standalone: false,
  selector: 'app-portal-inicio',
  templateUrl: './portal-inicio.page.html',
  styleUrls: ['./portal-inicio.page.scss'],
})
export class PortalInicioPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  resumen: any = null;
  presupuestos: any[] = [];      // órdenes esperando la aprobación del cliente
  detalle: Record<number, any> = {};
  expandido: number | null = null;
  procesando = false;
  cargando = true;
  readonly estadoLabel = ESTADO_CITA_LABEL;
  readonly fechaHoy = new Date().toLocaleDateString('es-CR', { weekday: 'short', day: 'numeric', month: 'short' });

  constructor(
    public portal: PortalService,
    private router: Router,
    private alert: AlertController,
    private toast: ToastController
  ) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }

  cargar() {
    this.cargando = true;
    this.portal.getResumen().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.resumen = r.data; this.cargando = false; },
      error: () => { this.cargando = false; },
    });
    this.cargarPresupuestos();
  }

  // Solo los presupuestos que esperan una decisión del cliente.
  cargarPresupuestos() {
    this.portal.getOrdenes().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.presupuestos = r.data.filter(
          (o: any) => o.estado === 'esperando_aprobacion' && o.aprobacion_cliente === 'pendiente'
        );
      },
      error: () => { this.presupuestos = []; },
    });
  }

  // Bloques de recompensa: 6 normales + 1 cortesía (la 7ª).
  get bloques(): boolean[] {
    const ciclo = this.resumen?.recompensas?.ciclo ?? 0;
    return Array.from({ length: this.resumen?.recompensas?.meta || 7 }, (_, i) => i < ciclo);
  }

  // Abre/cierra el desglose de un presupuesto (carga el detalle la primera vez).
  toggle(o: any) {
    if (this.expandido === o.id) { this.expandido = null; return; }
    this.expandido = o.id;
    if (!this.detalle[o.id]) {
      this.portal.getOrden(o.id).pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.detalle[o.id] = r.data });
    }
  }

  async aprobar(o: any) {
    const al = await this.alert.create({
      cssClass: 'portal-alert',
      header: 'Aprobar presupuesto',
      message: `¿Aprobás el presupuesto de la orden ${o.numero_orden}? El taller comenzará la reparación.`,
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Aprobar', cssClass: 'portal-alert-confirm', handler: () => this.enviarDecision(o, 'aprobar') },
      ],
    });
    await al.present();
  }

  async rechazar(o: any) {
    const al = await this.alert.create({
      cssClass: 'portal-alert',
      header: 'Rechazar presupuesto',
      message: `Contanos por qué rechazás el presupuesto de la orden ${o.numero_orden} (opcional).`,
      inputs: [{ name: 'motivo', type: 'textarea', placeholder: 'Motivo (opcional)' }],
      buttons: [
        { text: 'Cancelar', role: 'cancel' },
        { text: 'Rechazar', role: 'destructive', cssClass: 'portal-alert-danger', handler: (d) => this.enviarDecision(o, 'rechazar', d?.motivo) },
      ],
    });
    await al.present();
  }

  private enviarDecision(o: any, decision: 'aprobar' | 'rechazar', motivo?: string) {
    if (this.procesando) return;
    this.procesando = true;
    const req = decision === 'aprobar' ? this.portal.aprobar(o.id) : this.portal.rechazar(o.id, motivo || '');
    req.pipe(takeUntil(this.destroy$)).subscribe({
      next: async () => {
        this.procesando = false;
        this.expandido = null;
        const t = await this.toast.create({
          message: decision === 'aprobar' ? 'Presupuesto aprobado ✓' : 'Presupuesto rechazado',
          duration: 1800,
          color: decision === 'aprobar' ? 'success' : 'medium',
        });
        await t.present();
        this.cargarPresupuestos();
      },
      error: async () => {
        this.procesando = false;
        const t = await this.toast.create({ message: 'No se pudo procesar, intentá de nuevo', duration: 2200, color: 'danger' });
        await t.present();
      },
    });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  irAgendar() { this.router.navigate(['/portal/agendar']); }
  irCitas() { this.router.navigate(['/portal/mis-citas']); }
  verCita(p: any) {
    if (!p?.id) return;
    window.location.href = `/portal/cita/${p.id}`;
  }

  // Título de la tarjeta destacada según el tipo de cita resuelto en el backend.
  tituloCita(tipo?: string): string {
    if (tipo === 'en_curso') return 'En el taller';
    if (tipo === 'vencida') return 'Cita vencida';
    return 'Próxima cita';
  }
  // Etiqueta de la fila de fecha: "Ingreso" si ya está en el taller, etc.
  labelFecha(tipo?: string): string {
    if (tipo === 'en_curso') return 'Ingreso';
    if (tipo === 'vencida') return 'Fecha agendada';
    return 'Fecha y hora';
  }
  // Badge "Hoy/Mañana/En N días" solo para la próxima cita agendada.
  badgeCita(p: any): BadgeProximidad | null {
    return p?.tipo === 'proxima' ? badgeProximidad(p.fecha) : null;
  }

  logout() {
    this.portal.logout();
    this.router.navigate(['/portal/login'], { replaceUrl: true });
  }
}
