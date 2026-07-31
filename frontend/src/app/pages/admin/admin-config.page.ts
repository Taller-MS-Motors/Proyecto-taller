import { Component, OnInit, OnDestroy } from '@angular/core';
import { ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AdminService } from '../../services/admin.service';
import { MarcaService } from '../../services/marca.service';

interface HorarioVista { dia: number; label: string; abre: string; cierra: string; activo: boolean; }

@Component({
  standalone: false,
  selector: 'app-admin-config',
  templateUrl: './admin-config.page.html',
  styleUrls: ['./admin-config.page.scss'],
})
export class AdminConfigPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  config: any = null;
  cargando = true;
  guardando = false;
  horariosVista: HorarioVista[] = [];

  // Sucursales (locales del taller).
  sucursales: any[] = [];
  nuevaSucursal = { nombre: '', direccion: '', telefono: '' };
  guardandoSucursal = false;

  // Orden de presentación: lunes → domingo.
  private readonly diasOrden = [
    { dia: 1, l: 'Lunes' }, { dia: 2, l: 'Martes' }, { dia: 3, l: 'Miércoles' },
    { dia: 4, l: 'Jueves' }, { dia: 5, l: 'Viernes' }, { dia: 6, l: 'Sábado' }, { dia: 0, l: 'Domingo' },
  ];

  constructor(
    private admin: AdminService, private toast: ToastController,
    private marcaSvc: MarcaService,
  ) {}

  ngOnInit() {
    this.cargar();
    this.cargarSucursales();
  }

  cargar() {
    this.cargando = true;
    this.admin.getConfig().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => { this.config = r.data; this.normalizarHorarios(); this.normalizarMetodos(); this.cargando = false; },
      error: () => { this.cargando = false; this.aviso('No se pudo cargar la configuración', 'danger'); },
    });
  }

  cargarSucursales() {
    this.admin.getSucursales().pipe(takeUntil(this.destroy$)).subscribe({ next: r => this.sucursales = r.data || [] });
  }

  agregarSucursal() {
    const nombre = this.nuevaSucursal.nombre.trim();
    if (!nombre) { this.aviso('Escribí el nombre de la sucursal', 'warning'); return; }
    this.guardandoSucursal = true;
    this.admin.createSucursal({
      nombre,
      direccion: this.nuevaSucursal.direccion.trim() || undefined,
      telefono: this.nuevaSucursal.telefono.trim() || undefined,
    }).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => {
        this.guardandoSucursal = false;
        this.nuevaSucursal = { nombre: '', direccion: '', telefono: '' };
        this.cargarSucursales();
        this.aviso('Sucursal creada');
      },
      error: (e) => { this.guardandoSucursal = false; this.aviso(e.error?.error || 'No se pudo crear', 'danger'); },
    });
  }

  guardarSucursal(s: any) {
    if (!s.nombre?.trim()) { this.aviso('La sucursal necesita un nombre', 'warning'); return; }
    this.admin.updateSucursal(s.id, { nombre: s.nombre.trim(), direccion: s.direccion?.trim() || undefined, telefono: s.telefono?.trim() || undefined }).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => this.aviso('Sucursal actualizada'),
      error: (e) => this.aviso(e.error?.error || 'No se pudo guardar', 'danger'),
    });
  }

  toggleSucursal(s: any) {
    const activa = !Number(s.activa);
    this.admin.toggleSucursal(s.id, activa).pipe(takeUntil(this.destroy$)).subscribe({
      next: () => { s.activa = activa ? 1 : 0; },
      error: (e) => this.aviso(e.error?.error || 'No se pudo cambiar', 'danger'),
    });
  }

  private normalizarHorarios() {
    const src: any[] = Array.isArray(this.config?.horarios) ? this.config.horarios : [];
    this.horariosVista = this.diasOrden.map(d => {
      const h = src.find(x => Number(x.dia) === d.dia);
      return {
        dia: d.dia, label: d.l,
        abre: h?.abre || '08:00',
        cierra: h?.cierra || '17:00',
        activo: h ? !!Number(h.activo) : d.dia !== 0,
      };
    });
  }

  onLogoFile(ev: any) {
    const file = ev.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { this.config.logo = reader.result as string; };
    reader.readAsDataURL(file);
  }
  quitarLogo() { this.config.logo = null; }

  guardarConfig() {
    this.guardando = true;
    const payload = {
      ...this.config,
      horarios: this.horariosVista.map(h => ({ dia: h.dia, abre: h.abre, cierra: h.cierra, activo: h.activo ? 1 : 0 })),
    };
    this.admin.updateConfig(payload).pipe(takeUntil(this.destroy$)).subscribe({
      next: r => {
        this.config = r.data;
        this.normalizarHorarios();
        this.normalizarMetodos();
        // El logo y el nombre viajan a la factura y al PDF por MarcaService, que cachea:
        // sin esto habria que recargar la app para ver el cambio.
        this.marcaSvc.invalidar();
        this.guardando = false;
        this.aviso('Configuración guardada');
      },
      error: (e) => { this.guardando = false; this.aviso(e.error?.error || 'No se pudo guardar', 'danger'); },
    });
  }

  // Siempre al menos una forma de pago: sin ninguna, el cierre de orden se queda sin
  // opciones y no se puede entregar nada.
  private normalizarMetodos() {
    if (!Array.isArray(this.config?.metodos_pago) || !this.config.metodos_pago.length) {
      this.config.metodos_pago = [{ valor: 'efectivo', etiqueta: 'Efectivo' }];
    }
  }

  agregarMetodoPago() {
    this.config.metodos_pago = [...(this.config.metodos_pago || []), { valor: '', etiqueta: '' }];
  }

  // El identificador interno de los existentes NO se toca: es lo que quedó escrito en
  // las órdenes ya cobradas. Para los nuevos lo deriva el backend de la etiqueta.
  quitarMetodoPago(i: number) {
    if (this.config.metodos_pago.length <= 1) return;
    this.config.metodos_pago = this.config.metodos_pago.filter((_: any, x: number) => x !== i);
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private async aviso(message: string, color = 'success') {
    const t = await this.toast.create({ message, duration: 1800, color });
    await t.present();
  }
}
