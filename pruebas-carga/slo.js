// Criterios de aceptación (SLO) — definidos ANTES de medir.
//
// Van como umbrales de k6, no como texto en un documento: así la prueba falla sola
// cuando no se cumplen y no queda a interpretación de quien lee el resultado.
//
// Por qué estos números y no otros:
//
//   p95 < 500 ms      El taller usa la app desde el mostrador con el cliente delante.
//                     Medio segundo es el punto donde una pantalla deja de sentirse
//                     inmediata. Se usa p95 y no el promedio porque el promedio
//                     esconde justo lo que molesta: la petición lenta ocasional.
//
//   p99 < 1500 ms     Ni siquiera la cola peor debería llegar al segundo y medio,
//                     que es cuando alguien piensa que se colgó y vuelve a tocar.
//
//   errores < 1%      De cada 100 acciones, como mucho una puede fallar. Más que eso
//                     y el personal pierde la confianza en el sistema.
//
//   50 concurrentes   El taller tiene 5 empleados y su pico real son ~10 personas a
//                     la vez contando el portal. Se pide 10× ese pico como margen.
//                     Poner un número enorme acá no prueba nada: garantiza fallar y
//                     no dice cuánto aguanta de verdad.
//
// Los escenarios de escritura llevan un umbral más flojo a propósito: crear una cita
// hace INSERT y valida cupos, y es una acción puntual, no algo que se repita en bucle.

export const SLO = {
  p95_ms: 500,
  p99_ms: 1500,
  error_max: 0.01,
  concurrentes: 50,
};

export const umbrales = {
  // Tasa de error global de la prueba.
  http_req_failed: [`rate<${SLO.error_max}`],
  // Latencia global.
  http_req_duration: [`p(95)<${SLO.p95_ms}`, `p(99)<${SLO.p99_ms}`],
  // Por operación, para saber cuál es la que se cae y no solo que "algo" se cayó.
  'http_req_duration{operacion:listar_ordenes}': [`p(95)<${SLO.p95_ms}`],
  'http_req_duration{operacion:listar_clientes}': [`p(95)<${SLO.p95_ms}`],
  'http_req_duration{operacion:listar_promos}': [`p(95)<${SLO.p95_ms}`],
  'http_req_duration{operacion:crear_cita}': ['p(95)<1000'],
  // Los checks funcionales tienen que pasar casi siempre: si la app responde rápido
  // pero devuelve basura, la prueba no puede darse por buena.
  checks: ['rate>0.99'],
};
