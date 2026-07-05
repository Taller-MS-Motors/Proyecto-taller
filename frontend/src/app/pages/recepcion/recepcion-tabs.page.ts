import { Component, OnInit, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { Subject, interval } from 'rxjs';
import { takeUntil } from 'rxjs/operators';
import { AuthService } from '../../services/auth.service';
import { MensajeriaService } from '../../services/mensajeria.service';

@Component({
  standalone: false,
  selector: 'app-recepcion-tabs',
  templateUrl: './recepcion-tabs.page.html',
})
export class RecepcionTabsPage implements OnInit, OnDestroy {
  noLeidos = 0;
  private destroy$ = new Subject<void>();

  constructor(private auth: AuthService, private router: Router, private msj: MensajeriaService) {}

  ngOnInit() {
    this.consultarNoLeidos();
    interval(20000).pipe(takeUntil(this.destroy$)).subscribe(() => this.consultarNoLeidos());
  }

  private consultarNoLeidos() {
    this.msj.getNoLeidos().pipe(takeUntil(this.destroy$)).subscribe({
      next: r => this.noLeidos = r.data.count,
    });
  }

  get nombre(): string { return this.auth.getUsuario()?.nombre || 'Recepción'; }
  get foto(): string | null { return this.auth.getUsuario()?.foto || null; }
  get rolLabel(): string { return 'Recepción'; }
  get iniciales(): string {
    const p = this.nombre.trim().split(/\s+/);
    return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase() || 'R';
  }

  logout() {
    this.auth.logout();
    this.router.navigate(['/portal/login'], { replaceUrl: true });
  }

  ngOnDestroy() { this.destroy$.next(); this.destroy$.complete(); }
}
