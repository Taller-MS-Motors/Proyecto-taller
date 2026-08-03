// Core Web Vitals medidos en el navegador de quien usa la app, y enviados al backend.
//
// Por qué existe: Lighthouse mide en laboratorio y no interactúa con la página, así
// que nunca puede dar INP —el tiempo que tarda la interfaz en responder a un toque—.
// Esa métrica solo aparece con una persona real usando la aplicación.
//
// El costo es despreciable: la librería pesa ~2 KB, observa de forma pasiva y no
// interviene en el renderizado. Si algo falla, se ignora en silencio: una métrica
// perdida no puede romperle la pantalla a nadie.

import { onLCP, onCLS, onINP, onFCP, onTTFB, type Metric } from 'web-vitals';
import { environment } from '../../environments/environment';

// En la app nativa el origen es capacitor://localhost y las rutas relativas no
// resuelven; se usa la URL absoluta que ya conoce el resto de la app.
const nativo = !!(window as any).Capacitor?.isNativePlatform?.();
const URL_METRICAS = `${nativo ? environment.nativeApiUrl : ''}${environment.apiUrl}/metricas/web-vitals`;

function enviar(m: Metric) {
  const cuerpo = JSON.stringify({
    metrica: m.name,
    // CLS es un índice sin unidad y llega con muchos decimales; el resto son ms.
    valor: m.name === 'CLS' ? Number(m.value.toFixed(4)) : Math.round(m.value),
    calificacion: m.rating,              // 'good' | 'needs-improvement' | 'poor'
    ruta: location.pathname,             // sin querystring: puede traer datos
    movil: window.innerWidth < 768,
  });

  try {
    // sendBeacon es el único que sobrevive al cierre de la pestaña, que es
    // justamente cuando se conocen los valores definitivos de CLS e INP.
    if (navigator.sendBeacon) {
      navigator.sendBeacon(URL_METRICAS, new Blob([cuerpo], { type: 'application/json' }));
      return;
    }
    // keepalive cumple el mismo papel donde no hay sendBeacon (Safari viejo).
    fetch(URL_METRICAS, {
      method: 'POST', body: cuerpo, keepalive: true,
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
  } catch {
    /* medir nunca debe romper la app */
  }
}

// Se llama una sola vez, al arrancar. Cada `on*` dispara cuando su métrica queda
// firme: LCP y CLS al ocultarse la página, INP tras las interacciones reales.
export function iniciarWebVitals() {
  try {
    onLCP(enviar);
    onCLS(enviar);
    onINP(enviar);
    onFCP(enviar);
    onTTFB(enviar);
  } catch {
    /* navegador sin soporte: se sigue sin métricas */
  }
}
