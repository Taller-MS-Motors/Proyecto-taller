// Cloudflare Turnstile (captcha anti-bot invisible) para los formularios públicos.
// Degradación segura: si no hay site key configurado (environment.turnstileSiteKey)
// o estamos en la app nativa, NO se carga nada y los formularios funcionan igual que
// siempre — el token viaja vacío y el backend (que también degrada sin secret) lo omite.

import { Capacitor } from '@capacitor/core';
import { environment } from '../../environments/environment';

const SITE_KEY: string = (environment as any).turnstileSiteKey || '';
const SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// Turnstile es web-first; en el WebView nativo es poco fiable, así que solo se activa
// en la web y cuando hay site key. Los demás casos quedan cubiertos por honeypot + rate limit.
export function turnstileHabilitado(): boolean {
  return !!SITE_KEY && !Capacitor.isNativePlatform();
}

let scriptPromise: Promise<void> | null = null;
function cargarScript(): Promise<void> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    if ((window as any).turnstile) return resolve();
    const s = document.createElement('script');
    s.src = SCRIPT_URL;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('No se pudo cargar Turnstile'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

export interface TurnstileWidget {
  token(): string;
  reset(): void;
  destroy(): void;
}

// Monta el widget dentro del contenedor y va guardando el último token emitido.
// Si Turnstile no está habilitado o falla la carga, devuelve un widget "vacío" cuyo
// token() es '' (el flujo sigue igual). Nunca lanza.
export async function montarTurnstile(container: HTMLElement): Promise<TurnstileWidget> {
  const vacio: TurnstileWidget = { token: () => '', reset: () => {}, destroy: () => {} };
  if (!turnstileHabilitado() || !container) return vacio;
  try {
    await cargarScript();
    const ts = (window as any).turnstile;
    if (!ts) return vacio;
    let tokenActual = '';
    const id = ts.render(container, {
      sitekey: SITE_KEY,
      callback: (t: string) => { tokenActual = t; },
      'error-callback': () => { tokenActual = ''; },
      'expired-callback': () => { tokenActual = ''; },
    });
    return {
      token: () => tokenActual,
      reset: () => { try { ts.reset(id); tokenActual = ''; } catch { /* noop */ } },
      destroy: () => { try { ts.remove(id); } catch { /* noop */ } },
    };
  } catch {
    return vacio;
  }
}
