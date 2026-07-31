import { Component, OnInit, OnDestroy } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { Location } from '@angular/common';
import { Subject } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { OrdenesService } from '../../services/ordenes.service';
import { Orden, OrdenRepuesto } from '../../models/orden.model';
import { MarcaService, Marca } from '../../services/marca.service';

@Component({
  standalone: false,
  selector: 'app-factura',
  templateUrl: './factura.page.html',
  styleUrls: ['./factura.page.scss'],
})
export class FacturaPage implements OnInit, OnDestroy {
  private destroy$ = new Subject<void>();
  orden: Orden | null = null;
  repuestos: OrdenRepuesto[] = [];
  cargando = true;
  // Identidad del taller: el logo y el nombre salen de la configuracion, no del
  // archivo que viene con la app. Sin esto, subir un logo nuevo no cambiaba la factura.
  marca: Marca | null = null;

  constructor(
    private route: ActivatedRoute,
    private location: Location,
    private ordenSvc: OrdenesService,
    private marcaSvc: MarcaService
  ) {}

  ngOnInit() {
    this.marcaSvc.get().pipe(takeUntil(this.destroy$)).subscribe(m => this.marca = m);
    const id = +(this.route.snapshot.paramMap.get('id') || 0);
    this.ordenSvc.getById(id).pipe(takeUntil(this.destroy$)).subscribe(res => { this.orden = res.data; this.cargando = false; });
    this.ordenSvc.getRepuestos(id).pipe(takeUntil(this.destroy$)).subscribe(res => this.repuestos = res.data);
  }

  get totalRepuestos(): number {
    return this.repuestos.reduce((s, r) => s + r.cantidad * r.costo_unitario, 0);
  }

  get total(): number {
    if (!this.orden) return 0;
    return (this.orden.costo_mano_obra || 0) + this.totalRepuestos - (this.orden.descuento || 0);
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  imprimir() { window.print(); }
  volver() { this.location.back(); }

  get logo(): string { return this.marcaSvc.logoParaDocumento(this.marca); }
  get nombreTaller(): string { return this.marca?.nombre_taller || 'MS Motos'; }
}
