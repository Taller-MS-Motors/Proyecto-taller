import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AdminService } from '../../services/admin.service';
import { DashboardService } from '../../services/dashboard.service';
import { OrdenesService } from '../../services/ordenes.service';
import { ESTADO_CONFIG, EstadoOrden } from '../../models/orden.model';
import { descargarCSV, fechaCorta } from '../../shared/csv.util';
import { generarPDF, formatMoneda, formatPct } from '../../shared/pdf.util';

type Sem = 'rojo' | 'amarillo' | 'verde' | 'gris';

@Component({
  standalone: false,
  selector: 'app-admin-resumen',
  templateUrl: './admin-resumen.page.html',
  styleUrls: ['./admin-resumen.page.scss'],
})
export class AdminResumenPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  data: any = null;        // /api/admin/resumen (citas)
  op: any = null;          // /api/dashboard/resumen (órdenes/operativo)
  tiempos: any[] = [];     // tiempo por etapa
  tecnicos: any[] = [];    // productividad por técnico
  atrasos: any[] = [];     // semáforo de entregas
  opiniones: any[] = [];   // feed de calificaciones reales del cliente
  opResumen: { total: number; promedio: number; bajas: number } | null = null;
  cargando = true;
  exportando = false;

  readonly estrellas = [1, 2, 3, 4, 5];

  filtroSemaforo: Sem = 'rojo';

  // Estado del taller (órdenes) → etiqueta + color del punto + clase de badge.
  readonly estadoMap: Record<string, { label: string; dot: string; bg: string }> = {
    recepcion:            { label: 'Recepción',            dot: '#FB7185', bg: 'bg-cr' },
    diagnostico:          { label: 'Diagnóstico',          dot: '#FBB834', bg: 'bg-am' },
    esperando_aprobacion: { label: 'Esperando aprobación', dot: '#818CF8', bg: 'bg-in' },
    esperando_repuestos:  { label: 'Esperando repuestos',  dot: '#A3A3A3', bg: 'bg-n' },
    en_reparacion:        { label: 'En reparación',        dot: '#38BDF8', bg: 'bg-in' },
    lista_entrega:        { label: 'Lista para entrega',   dot: '#4ADE80', bg: 'bg-em' },
  };
  readonly etapaLabel: Record<string, string> = {
    recepcion: 'Recepción', diagnostico: 'Diagnóstico', esperando_aprobacion: 'Esperando aprobación',
    esperando_repuestos: 'Esperando repuestos', en_reparacion: 'En reparación', lista_entrega: 'Lista para entrega',
  };

  constructor(
    private admin: AdminService,
    private dash: DashboardService,
    private ordenes: OrdenesService,
    private toast: ToastController,
    private router: Router,
  ) {}

  ngOnInit() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
  ionViewWillEnter() { this.cargar(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.admin.getResumen().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.data = r.data; this.cargando = false; if (ev) ev.target.complete(); },
      error: () => { this.cargando = false; if (ev) ev.target.complete(); },
    });
    this.dash.getResumen().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.op = r.data, error: () => {} });
    this.dash.getTiempos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.tiempos = r.data, error: () => {} });
    this.dash.getTecnicos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.tecnicos = r.data, error: () => {} });
    this.dash.getAtrasos().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.atrasos = r.data, error: () => {} });
    this.admin.getOpiniones().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.opiniones = r.data.opiniones || []; this.opResumen = r.data.resumen || null; },
      error: () => {},
    });
  }

  // ── Opiniones (reseñas del cliente) ──
  // Baja = 1-2★: pide atención (se resalta arriba).
  esBaja(cal: any): boolean { return Number(cal) <= 2; }
  // Reseñas con las bajas (1-2★) primero para que el dueño actúe; el backend ya las trae por fecha desc.
  get opinionesOrdenadas(): any[] {
    return [...this.opiniones].sort((a, b) => (this.esBaja(a.calificacion) ? 0 : 1) - (this.esBaja(b.calificacion) ? 0 : 1));
  }
  abrirOpinion(o: any) { if (o?.orden_id) this.router.navigate(['/detalle-orden', o.orden_id]); }
  fechaCortaOp(f: any): string { return fechaCorta(f); }

  // ── Citas (mes) ──
  get maxServicio(): number {
    return Math.max(1, ...(this.data?.top_servicios || []).map((s: any) => Number(s.total) || 0));
  }
  get totalIngreso(): number {
    return (this.data?.ingresos_por_servicio || []).reduce((s: number, r: any) => s + (Number(r.ingreso) || 0), 0);
  }
  pct(parte: any, total: any): number {
    const t = Number(total) || 0;
    return t ? Math.round(((Number(parte) || 0) / t) * 100) : 0;
  }

  // ── Tiempo por etapa ──
  get maxTiempo(): number {
    return Math.max(1, ...this.tiempos.map(t => Number(t.horas_promedio) || 0));
  }

  // ── Semáforo de entregas ──
  semaforo(dias: number | null): Sem {
    if (dias === null || dias === undefined) return 'gris';
    if (dias < 0) return 'rojo';
    if (dias <= 1) return 'amarillo';
    return 'verde';
  }
  semaforoTexto(dias: number | null): string {
    if (dias === null || dias === undefined) return 'Sin fecha';
    if (dias < 0) return `Atrasada ${Math.abs(dias)}d`;
    if (dias === 0) return 'Vence hoy';
    if (dias === 1) return 'Vence mañana';
    return `${dias}d`;
  }
  readonly semBadge: Record<Sem, string> = { rojo: 'bg-rd', amarillo: 'bg-am', verde: 'bg-em', gris: 'bg-n' };
  get atrasosFiltrados(): any[] { return this.atrasos.filter(a => this.semaforo(a.dias_restantes) === this.filtroSemaforo); }
  get countRojo(): number { return this.atrasos.filter(a => this.semaforo(a.dias_restantes) === 'rojo').length; }
  get countAmarillo(): number { return this.atrasos.filter(a => this.semaforo(a.dias_restantes) === 'amarillo').length; }
  get countVerde(): number { return this.atrasos.filter(a => this.semaforo(a.dias_restantes) === 'verde').length; }

  iniciales(nombre: string): string { return (nombre || '?').trim().charAt(0).toUpperCase(); }
  abrirOrden(id: number) { this.router.navigate(['/detalle-orden', id]); }

  // ── Exportación CSV (Excel) ──
  private hoy() { return new Date().toISOString().slice(0, 10); }
  private estadoTexto(e?: string) { return ESTADO_CONFIG[e as EstadoOrden]?.label ?? e ?? ''; }

  exportarOrdenes() {
    this.exportando = true;
    this.ordenes.getAll().pipe(takeUntil(this.destroy$)).subscribe({
      next: res => {
        const filas = res.data.map((o: any) => ({
          numero_orden: o.numero_orden, estado: this.estadoTexto(o.estado),
          cliente: `${o.cliente_nombre || ''} ${o.cliente_apellido || ''}`.trim(),
          moto: `${o.marca || ''} ${o.modelo || ''}`.trim(), placa: o.placa || '',
          tecnico: o.tecnico_nombre || '', ingreso: fechaCorta(o.fecha_ingreso),
          total: (o.costo_mano_obra || 0) + (o.costo_repuestos || 0) - (o.descuento || 0),
        }));
        descargarCSV(`ordenes_${this.hoy()}`, [
          { key: 'numero_orden', label: 'Orden' }, { key: 'estado', label: 'Estado' },
          { key: 'cliente', label: 'Cliente' }, { key: 'moto', label: 'Moto' }, { key: 'placa', label: 'Placa' },
          { key: 'tecnico', label: 'Técnico' }, { key: 'ingreso', label: 'Ingreso' }, { key: 'total', label: 'Total' },
        ], filas);
        this.exportando = false; this.aviso(`${filas.length} órdenes exportadas`);
      },
      error: () => { this.exportando = false; this.aviso('No se pudo exportar', 'danger'); },
    });
  }

  exportarFacturacion() {
    this.exportando = true;
    this.ordenes.getAll({ estado: 'entregada' }).pipe(takeUntil(this.destroy$)).subscribe({
      next: res => {
        const filas = res.data.map((o: any) => ({
          numero_orden: o.numero_orden, cliente: `${o.cliente_nombre || ''} ${o.cliente_apellido || ''}`.trim(),
          moto: `${o.marca || ''} ${o.modelo || ''}`.trim(), entrega: fechaCorta(o.fecha_entrega_real),
          metodo_pago: o.metodo_pago || '',
          total: (o.costo_mano_obra || 0) + (o.costo_repuestos || 0) - (o.descuento || 0),
        }));
        descargarCSV(`facturacion_${this.hoy()}`, [
          { key: 'numero_orden', label: 'Orden' }, { key: 'cliente', label: 'Cliente' }, { key: 'moto', label: 'Moto' },
          { key: 'entrega', label: 'Entrega' }, { key: 'metodo_pago', label: 'Método de pago' }, { key: 'total', label: 'Total' },
        ], filas);
        this.exportando = false; this.aviso(`${filas.length} facturas exportadas`);
      },
      error: () => { this.exportando = false; this.aviso('No se pudo exportar', 'danger'); },
    });
  }

  exportarProductividad() {
    if (!this.tecnicos.length) { this.aviso('Sin datos de técnicos', 'warning'); return; }
    descargarCSV(`productividad_${this.hoy()}`, [
      { key: 'nombre', label: 'Técnico' }, { key: 'ordenes_completadas', label: 'Órdenes completadas' }, { key: 'horas_promedio', label: 'Horas promedio' },
    ], this.tecnicos.map(t => ({ nombre: t.nombre, ordenes_completadas: t.ordenes_completadas || 0, horas_promedio: t.horas_promedio || 0 })));
    this.aviso('Productividad exportada');
  }

  exportarPDF() {
    const d = this.data;
    const o = this.op;
    if (!d) { this.aviso('Esperá a que carguen los datos', 'warning'); return; }

    const ec = d.estado_citas || {};
    const kpis = `
      <div class="kpi-grid">
        <div class="kpi"><div class="num">${d.total_citas || 0}</div><div class="label">Citas del mes</div></div>
        <div class="kpi green"><div class="num">${formatMoneda(d.ingresos_mes || 0)}</div><div class="label">Ingresos del mes</div></div>
        <div class="kpi amber"><div class="num">${d.citas_pendientes || 0}</div><div class="label">Pendientes</div></div>
        <div class="kpi green"><div class="num">${d.tasa_exito || 0}%</div><div class="label">Tasa de éxito</div></div>
      </div>`;

    const estadoCitas = `
      <div class="section">
        <div class="section-title">Estado de citas del mes</div>
        <table>
          <tr><th>Estado</th><th class="right">Cantidad</th><th class="right">%</th></tr>
          <tr><td>Agendadas</td><td class="right mono">${ec.agendadas || 0}</td><td class="right">${formatPct(ec.agendadas, ec.total)}</td></tr>
          <tr><td>En proceso</td><td class="right mono">${ec.en_proceso || 0}</td><td class="right">${formatPct(ec.en_proceso, ec.total)}</td></tr>
          <tr><td>Completadas</td><td class="right mono">${ec.completadas || 0}</td><td class="right">${formatPct(ec.completadas, ec.total)}</td></tr>
          <tr><td>Canceladas</td><td class="right mono">${ec.canceladas || 0}</td><td class="right">${formatPct(ec.canceladas, ec.total)}</td></tr>
          <tr class="bold"><td>Total</td><td class="right mono">${ec.total || 0}</td><td class="right">100%</td></tr>
        </table>
      </div>`;

    const topServicios = (d.top_servicios || []).length ? `
      <div class="section">
        <div class="section-title">Top servicios del mes</div>
        ${(d.top_servicios || []).map((s: any) => `
          <div class="bar-wrap">
            <span class="bar-label">${s.servicio}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${this.pct(s.total, this.maxServicio)}%"></div></div>
            <span class="bar-val">${s.total}</span>
          </div>`).join('')}
      </div>` : '';

    const ingresosPorServicio = (d.ingresos_por_servicio || []).length ? `
      <div class="section">
        <div class="section-title">Ingresos por servicio</div>
        <table>
          <tr><th>Servicio</th><th class="right">Citas</th><th class="right">Ingreso</th><th class="right">Promedio</th></tr>
          ${(d.ingresos_por_servicio || []).map((r: any) => `
            <tr>
              <td>${r.servicio}</td>
              <td class="right mono">${r.citas}</td>
              <td class="right mono">${formatMoneda(r.ingreso)}</td>
              <td class="right mono">${formatMoneda(r.promedio)}</td>
            </tr>`).join('')}
          <tr class="bold"><td>Total</td><td></td><td class="right mono">${formatMoneda(this.totalIngreso)}</td><td></td></tr>
        </table>
      </div>` : '';

    const tecnicosHTML = this.tecnicos.length ? `
      <div class="section">
        <div class="section-title">Productividad por mecánico</div>
        <table>
          <tr><th>Mecánico</th><th class="right">Órdenes</th><th class="right">Horas prom.</th></tr>
          ${this.tecnicos.map(t => `
            <tr>
              <td>${t.nombre}</td>
              <td class="right mono">${t.ordenes_completadas || 0}</td>
              <td class="right mono">${t.horas_promedio || '—'}</td>
            </tr>`).join('')}
        </table>
      </div>` : '';

    const operativo = o ? `
      <div class="section">
        <div class="section-title">Operativo</div>
        <div class="kpi-grid">
          <div class="kpi"><div class="num">${formatMoneda(o.facturacion_hoy || 0)}</div><div class="label">Facturado hoy</div></div>
          <div class="kpi"><div class="num">${formatMoneda(o.facturacion_mes || 0)}</div><div class="label">Facturado mes</div></div>
          <div class="kpi"><div class="num">${formatMoneda(o.ticket_promedio || 0)}</div><div class="label">Ticket promedio</div></div>
          <div class="kpi amber"><div class="num">${o.tiempo_promedio_horas || '—'}h</div><div class="label">Tiempo prom. reparación</div></div>
        </div>
      </div>` : '';

    generarPDF('Resumen Ejecutivo', kpis + operativo + estadoCitas + topServicios + ingresosPorServicio + tecnicosHTML)
      .then(() => this.aviso('PDF generado'));
  }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 1800, color });
    await t.present();
  }
}
