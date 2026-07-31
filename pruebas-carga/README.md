# Pruebas no funcionales

Carga y estrés de la API con [k6](https://k6.io).

| Archivo | Qué es |
|---|---|
| [`INFORME.md`](INFORME.md) | **El entregable.** Las 6 secciones con los resultados medidos |
| `slo.js` | Criterios de aceptación como umbrales ejecutables |
| `carga.js` | Carga esperada sostenida (50 usuarios, flujos reales) |
| `estres.js` | Escalones hasta el punto de quiebre y recuperación |

Las instrucciones para reproducir están al final del informe.

> Nunca correr contra producción: son 26 clientes y 18 órdenes reales, y en el plan
> gratuito de Railway se mediría el estrangulamiento de la plataforma, no la app.
