import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { RecepcionService } from '../../services/recepcion.service';
import { abrirWhatsApp, mensajeCita } from '../../shared/whatsapp.util';
import { hoyCR } from '../../utils/fecha-cita';

// Celda del calendario mensual. `fecha` vacía = celda de relleno (fuera del mes).
interface DiaCal {
  fecha: string;        // YYYY-MM-DD
  dia: number | null;
  hoy: boolean;
  total: number;
  flujo: '' | 'bajo' | 'medio' | 'alto';
}

// Calendario de citas: vista mensual + panel del día seleccionado con las citas reales.
// Reusa el lenguaje del calendario admin pero operativo para el mostrador (filtro de
// sede, WhatsApp y "Agendar en este día" enganchado al flujo de Recibir cliente).
@Component({
  standalone: false,
  selector: 'app-recepcion-agenda',
  templateUrl: './recepcion-agenda.page.html',
  styleUrls: ['./recepcion-agenda.page.scss'],
})
export class RecepcionAgendaPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  readonly dows = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
  readonly diasLargos = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  readonly meses = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];

  readonly estadoLabel: Record<string, string> = {
    agendado: 'Agendado', en_revision: 'En revisión', en_mantenimiento: 'En mantenimiento',
    listo: 'Listo', entregado: 'Entregado',
  };
  readonly estadoPill: Record<string, string> = {
    agendado: 'indigo', en_revision: 'amber', en_mantenimiento: 'rose', listo: 'green', entregado: 'gris',
  };

  anio = new Date().getFullYear();
  mes = new Date().getMonth() + 1; // 1-12
  cargando = true;

  citasMes: any[] = [];
  sucursales: { id: number; nombre: string }[] = [];
  sucursalFiltro: number | '' = '';

  semanas: DiaCal[][] = [];
  diaSel: DiaCal | null = null;

  constructor(private rec: RecepcionService, private router: Router, private toast: ToastController) {}

  ngOnInit() { this.cargar(); }
  ionViewWillEnter() { this.cargar(); }

  get tituloMes(): string { return `${this.meses[this.mes - 1]} ${this.anio}`; }

  cambiarMes(dir: number) {
    if (dir === 0) {
      this.anio = new Date().getFullYear();
      this.mes = new Date().getMonth() + 1;
    } else {
      this.mes += dir;
      if (this.mes > 12) { this.mes = 1; this.anio++; }
      if (this.mes < 1) { this.mes = 12; this.anio--; }
    }
    this.cargar();
  }

  private pad(n: number): string { return String(n).padStart(2, '0'); }
  private hoyStr(): string { return hoyCR(); }

  cargar(ev?: any) {
    this.cargando = true;
    const finDia = new Date(Date.UTC(this.anio, this.mes, 0)).getUTCDate();
    const desde = `${this.anio}-${this.pad(this.mes)}-01`;
    const hasta = `${this.anio}-${this.pad(this.mes)}-${this.pad(finDia)}`;
    this.rec.getAgenda(desde, hasta).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.citasMes = r.data || [];
        this.sucursales = this.sucursalesDe(this.citasMes);
        if (this.sucursalFiltro && !this.sucursales.some(s => s.id === this.sucursalFiltro)) this.sucursalFiltro = '';
        this.construir();
        this.cargando = false;
        if (ev) ev.target.complete();
      },
      error: () => { this.citasMes = []; this.semanas = []; this.cargando = false; if (ev) ev.target.complete(); },
    });
  }

  private sucursalesDe(citas: any[]): { id: number; nombre: string }[] {
    const map = new Map<number, string>();
    for (const c of citas) {
      if (c.sucursal_id && c.sucursal_nombre && !map.has(c.sucursal_id)) map.set(c.sucursal_id, c.sucursal_nombre);
    }
    return [...map].map(([id, nombre]) => ({ id, nombre })).sort((a, b) => a.nombre.localeCompare(b.nombre));
  }

  get citasFiltradas(): any[] {
    return this.sucursalFiltro ? this.citasMes.filter(c => c.sucursal_id === this.sucursalFiltro) : this.citasMes;
  }
  setSucursalFiltro(id: number) { this.sucursalFiltro = this.sucursalFiltro === id ? '' : id; this.construir(); }

  private construir() {
    const porDia = new Map<string, number>();
    for (const c of this.citasFiltradas) porDia.set(c.fecha, (porDia.get(c.fecha) || 0) + 1);

    const hoyStr = this.hoyStr();
    const primerDow = new Date(Date.UTC(this.anio, this.mes - 1, 1)).getUTCDay(); // 0=Dom
    const offset = primerDow === 0 ? 6 : primerDow - 1; // la semana arranca lunes
    const diasMes = new Date(Date.UTC(this.anio, this.mes, 0)).getUTCDate();

    const vacio = (): DiaCal => ({ fecha: '', dia: null, hoy: false, total: 0, flujo: '' });
    const dias: DiaCal[] = [];
    for (let i = 0; i < offset; i++) dias.push(vacio());

    let diaHoy: DiaCal | null = null;
    let primerConCitas: DiaCal | null = null;
    for (let d = 1; d <= diasMes; d++) {
      const fecha = `${this.anio}-${this.pad(this.mes)}-${this.pad(d)}`;
      const total = porDia.get(fecha) || 0;
      const flujo = total === 0 ? '' : total <= 2 ? 'bajo' : total <= 5 ? 'medio' : 'alto';
      const cel: DiaCal = { fecha, dia: d, hoy: fecha === hoyStr, total, flujo };
      if (cel.hoy) diaHoy = cel;
      if (total > 0 && !primerConCitas) primerConCitas = cel;
      dias.push(cel);
    }
    while (dias.length % 7 !== 0) dias.push(vacio());

    this.semanas = [];
    for (let i = 0; i < dias.length; i += 7) this.semanas.push(dias.slice(i, i + 7));

    // Conserva el día elegido si sigue en el mes; si no, hoy → primer día con citas → día 1.
    const prev = this.diaSel?.fecha;
    this.diaSel = (prev && dias.find(c => c.fecha === prev)) || diaHoy || primerConCitas || dias.find(c => c.dia) || null;
  }

  selDia(c: DiaCal) { if (c.dia) this.diaSel = c; }

  // Citas del día seleccionado (ya filtradas por sede), ordenadas por hora.
  get citasDia(): any[] {
    if (!this.diaSel) return [];
    return this.citasFiltradas.filter(c => c.fecha === this.diaSel!.fecha);
  }

  detalleTitulo(): string {
    if (!this.diaSel?.dia) return '';
    const d = new Date(Date.UTC(this.anio, this.mes - 1, this.diaSel.dia));
    return `${this.diasLargos[d.getUTCDay()]} ${this.diaSel.dia} de ${this.meses[this.mes - 1]}`;
  }

  // Badges del cliente en la fila de cita.
  llego(c: any): boolean { return c.estado === 'agendado' && !!c.hora_llegada; }
  sinConfirmar(c: any): boolean { return c.estado === 'agendado' && !c.confirmada_cliente && !c.hora_llegada; }
  // El job diario marca no_show las citas vencidas que nunca tuvieron check-in.
  noShow(c: any): boolean { return c.estado === 'agendado' && !!c.no_show; }

  // Tap en una cita: abre su orden si la tiene, si no la ficha del cliente.
  abrirCita(c: any) {
    if (c.orden_id) this.router.navigate(['/detalle-orden', c.orden_id]);
    else this.router.navigate(['/cliente-detalle', c.cliente_id]);
  }

  // Agendar en el día seleccionado: abre Recibir cliente en modo agendar con la fecha lista.
  agendarEnDia() {
    if (!this.diaSel?.fecha) return;
    this.router.navigate(['/recepcion/recibir'], { queryParams: { modo: 'agendar', fecha: this.diaSel.fecha } });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  async whatsapp(c: any) {
    if (!abrirWhatsApp(c.cliente_telefono, mensajeCita(c))) {
      const t = await this.toast.create({ message: 'Este cliente no tiene teléfono cargado', duration: 2200, color: 'warning' });
      await t.present();
    }
  }
}
