import { Component, OnDestroy } from '@angular/core';
import { Router, NavigationEnd } from '@angular/router';
import { Subject, filter, takeUntil } from 'rxjs';

@Component({
  standalone: false,
  selector: 'app-admin-actions',
  template: `
    <span class="adm-date">{{ fecha }}</span>
    <!-- En pantallas angostas el texto se oculta por CSS y queda solo el "+",
         para no comerle el espacio al título. El aria-label mantiene el sentido. -->
    <ion-button *ngIf="mostrarNuevaCita" class="adm-nueva" size="small" [routerLink]="['/cita-form']"
                title="Nueva cita" aria-label="Nueva cita">
      <ion-icon name="add" aria-hidden="true"></ion-icon>
      <span class="adm-nueva-txt">Nueva cita</span>
    </ion-button>
  `,
})
export class AdminActionsComponent implements OnDestroy {
  fecha = this.hoyStr();
  mostrarNuevaCita = false;
  private destroy$ = new Subject<void>();
  private readonly rutasConCita = ['/admin/resumen', '/admin/citas', '/admin/calendario'];

  constructor(private router: Router) {
    this.evaluar(this.router.url);
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      takeUntil(this.destroy$),
    ).subscribe(e => this.evaluar(e.urlAfterRedirects));
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }

  private evaluar(url: string) {
    this.mostrarNuevaCita = this.rutasConCita.some(r => url.startsWith(r));
  }

  private hoyStr(): string {
    const d = new Date();
    const dows = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];
    const meses = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
    return `${dows[d.getDay()]} ${d.getDate()} ${meses[d.getMonth()]} ${d.getFullYear()}`;
  }
}
