import { Injectable } from '@angular/core';
import { PreloadingStrategy, Route } from '@angular/router';
import { Observable, of, timer } from 'rxjs';
import { mergeMap } from 'rxjs/operators';

// Estrategia de precarga por rol.
//
// Antes se usaba `PreloadAllModules`, que descarga los 83 chunks de la aplicación
// apenas arranca. Para el personal tiene sentido —entra a la mañana y navega todo el
// día, así que conviene pagar una vez—, pero para el cliente del portal no: entra
// desde el teléfono, mira su cita y se va, y estaba bajando también el panel de
// administración, la recepción y el módulo del mecánico, que nunca va a poder abrir.
//
// Lighthouse lo reportaba como **825 KiB de JavaScript sin usar**, y ese tráfico
// compite por el ancho de banda justo mientras la página intenta pintar (afecta a
// FCP, LCP y Speed Index).
//
// Acá se precarga solo lo que ese usuario puede llegar a abrir, y recién después de
// un respiro para no competir con el renderizado inicial.

// Módulos que tiene sentido precargar según quién esté conectado.
const POR_ROL: Record<string, string[]> = {
  admin:    ['admin', 'tabs', 'recepcion', 'mecanico', 'garantias', 'promociones', 'nueva-orden', 'cita-form'],
  recepcion:['recepcion', 'tabs', 'nueva-orden', 'cita-form', 'cliente-form', 'moto-form'],
  tecnico:  ['mecanico', 'tabs'],
  cliente:  ['portal'],
};

// Las claves de sesión son las mismas que usan auth.service y portal.service. Se leen
// directo de localStorage y no por inyección para evitar una dependencia circular:
// el enrutador se construye antes que los servicios.
function rolActual(): string | null {
  try {
    const staff = localStorage.getItem('tallerms_usuario');
    if (staff) return JSON.parse(staff)?.rol || null;
    if (localStorage.getItem('tallerms_portal_token')) return 'cliente';
  } catch { /* almacenamiento bloqueado o dato corrupto */ }
  return null;
}

@Injectable({ providedIn: 'root' })
export class PrecargaPorRol implements PreloadingStrategy {
  preload(ruta: Route, cargar: () => Observable<any>): Observable<any> {
    const rol = rolActual();
    // Sin sesión no se precarga nada: la única pantalla que importa es el login, que
    // ya está cargándose, y no se sabe todavía qué va a necesitar esta persona.
    if (!rol) return of(null);

    const permitidos = POR_ROL[rol];
    if (!permitidos || !permitidos.includes(ruta.path || '')) return of(null);

    // 2 s de espera: la precarga es una comodidad, no una urgencia. Dejar pasar el
    // renderizado inicial es lo que evita que compita con el contenido de la pantalla
    // que la persona está esperando ver.
    return timer(2000).pipe(mergeMap(() => cargar()));
  }
}
