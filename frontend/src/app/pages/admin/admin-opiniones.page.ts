import { Component, OnDestroy, OnInit } from '@angular/core';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AdminService } from '../../services/admin.service';
import { fechaCorta } from '../../shared/csv.util';

@Component({
  standalone: false,
  selector: 'app-admin-opiniones',
  templateUrl: './admin-opiniones.page.html',
  styleUrls: ['./admin-opiniones.page.scss'],
})
export class AdminOpinionesPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  opiniones: any[] = [];
  tecnicos: { id: number; nombre: string }[] = [];
  resumen: { total: number; promedio: number; bajas: number } | null = null;
  cargando = true;

  readonly estrellas = [1, 2, 3, 4, 5];
  // Filtros: estrella (null = todas) y mecánico (null = todos).
  filtroEstrella: number | null = null;
  filtroEmpleado: number | null = null;

  constructor(private admin: AdminService, private router: Router) {}

  ngOnInit() { this.cargar(); }
  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
  ionViewWillEnter() { this.cargar(); }

  cargar(ev?: any) {
    this.cargando = true;
    this.admin.getOpiniones({ estrellas: this.filtroEstrella, empleado: this.filtroEmpleado, limit: 200 })
      .pipe(takeUntil(this.destroy$))
      .subscribe({
        next: r => {
          this.opiniones = r.data.opiniones || [];
          // La lista de mecánicos no depende de los filtros; la fijamos una vez.
          if (r.data.tecnicos?.length) this.tecnicos = r.data.tecnicos;
          this.resumen = r.data.resumen || null;
          this.cargando = false;
          if (ev) ev.target.complete();
        },
        error: () => { this.cargando = false; if (ev) ev.target.complete(); },
      });
  }

  setEstrella(n: number | null) {
    this.filtroEstrella = this.filtroEstrella === n ? null : n;
    this.cargar();
  }
  onEmpleado() { this.cargar(); }
  limpiar() {
    this.filtroEstrella = null;
    this.filtroEmpleado = null;
    this.cargar();
  }
  get hayFiltro(): boolean { return this.filtroEstrella !== null || this.filtroEmpleado !== null; }

  esBaja(cal: any): boolean { return Number(cal) <= 2; }
  abrirOpinion(o: any) { if (o?.orden_id) this.router.navigate(['/detalle-orden', o.orden_id]); }
  fechaCortaOp(f: any): string { return fechaCorta(f); }
}
