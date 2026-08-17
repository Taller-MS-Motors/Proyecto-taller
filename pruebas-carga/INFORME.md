# Informe de Pruebas No Funcionales — TallerMS / MS Motos

**Fecha:** 31 de julio de 2026 · **Última revisión:** 16 de agosto de 2026
**Alcance:** API del backend bajo carga y estrés (§4–§6), Core Web Vitals del frontend en
laboratorio (§6-bis), techo de la mensajería interna (§6-ter) y medición de campo (§6-quater).

> **Cómo leer las secciones nuevas.** Las tablas de resultados de §4, §5 y §6-bis son
> **mediciones** hechas en las fechas indicadas. Las secciones §6-ter y §6-quater
> documentan trabajo posterior: los problemas se identificaron leyendo el código, las
> correcciones **están aplicadas**, y lo que falta es volver a medir para cuantificarlas.
> Cada afirmación dice de cuál de los dos tipos es; ninguna estimación se presenta como
> medición.

> **Nota sobre el enunciado.** La guía original asume un backend Laravel/PHP y pide
> "versión PHP", Laravel Pulse y Telescope. Este proyecto es **Express/Node + MySQL**,
> así que esas herramientas no aplican. Lo equivalente aquí: el registro de consultas
> lentas de MySQL y `performance_schema` en lugar de Telescope, y las métricas de
> Railway más el registro de la aplicación en lugar de Pulse. k6, JMeter y Lighthouse
> sí aplican tal cual, porque prueban HTTP y navegador, no el lenguaje del servidor.

---

## 1. Entorno de prueba

| | |
|---|---|
| **Máquina** | Windows 11, 18 núcleos lógicos, disco SSD local |
| **Backend** | Node.js v24.16, Express 5.2, **2 workers** (`WEB_CONCURRENCY=2`) |
| **Base de datos** | MySQL **8.4.3** local, puerto 3307, instancia aislada · `max_connections=300` |
| **Pool** | 40 conexiones repartidas entre workers (20 c/u) |
| **Generador de carga** | k6 **v2.1.0** |
| **Red** | localhost — **sin latencia de red** (ver limitaciones, §7) |
| **Caché / colas** | Sin Redis ni colas. Solo caché en memoria del proceso para configuración y catálogo de servicios (TTL 30 s) |

### Tamaño del dataset

Se sembró con `backend/scripts/seed-carga.js`. La base **real** del taller tiene ~30
clientes y 4,8 MB: con ese volumen toda consulta vuela y una prueba de carga no
encuentra nada. Se generó un orden de magnitud representativo del crecimiento esperado:

| Tabla | Filas |
|---|---|
| clientes | 2 000 |
| motos | 3 000 (300 con foto, ~100 KB c/u) |
| citas | 5 000 |
| órdenes de trabajo | 1 500 |
| promociones | 30 (todas con imagen) |
| **Peso total** | **39,1 MB** (~8× producción) |

### Diferencia relevante con producción

Los límites de tasa se elevaron **solo durante la prueba** (`RATE_API_MAX`, etc.). Con
los valores normales —600 req/min por IP y 30 logins cada 15 min— una prueba desde una
sola máquina choca contra el limitador antes de acercarse al límite real del sistema, y
mediría el limitador en vez de la aplicación.

---

## 2. Criterios de aceptación (SLO)

Definidos **antes** de medir y escritos como umbrales ejecutables en
[`slo.js`](slo.js), de modo que la prueba falla sola si no se cumplen.

| Criterio | Valor | Por qué |
|---|---|---|
| p95 de latencia | **< 500 ms** | El taller usa la app en el mostrador con el cliente delante. Medio segundo es donde deja de sentirse inmediata. Se usa p95 y no promedio porque el promedio esconde justo la petición lenta que molesta |
| p99 de latencia | **< 1500 ms** | Ni la cola peor debería llegar a donde alguien piensa que se colgó |
| Tasa de error | **< 1 %** | Más que eso y el personal pierde confianza en el sistema |
| Concurrencia objetivo | **50 usuarios** | El taller tiene 5 empleados; su pico real ronda 10 personas contando el portal. Se pide 10× ese pico como margen |
| Escrituras (crear cita) | p95 < 1000 ms | Hace INSERT y valida cupos; es una acción puntual, no un bucle |

Sobre la concurrencia: poner un número enorme no prueba nada — garantiza fallar y no
dice cuánto aguanta de verdad. El valor de la prueba está en conocer el techo real.

---

## 3. Escenarios

Flujos reales del personal, no `GET /` ([`carga.js`](carga.js)):

```
login (una vez)  →  listar órdenes  →  listar clientes  →  ver promociones
                 →  [20 % de las iteraciones] crear cita
```

Decisiones de diseño del escenario:

- **El login va en `setup()` y el token se comparte.** No es por comodidad: el
  limitador permite 30 logins por IP cada 15 minutos. Loguearse en cada iteración
  mediría el limitador. Además refleja la realidad: una persona entra una vez y
  trabaja toda la mañana.
- **Pausa de 1 a 3 s entre acciones.** Sin *think time* la prueba mide un bombardeo
  que nunca va a ocurrir.
- **Solo el 20 % escribe.** En un taller se consulta mucho más de lo que se agenda.
- **Los `cliente_id` se toman de la base**, no se inventan (ver hallazgo 1).

### Los seis escenarios funcionales

`carga.js` mide un flujo mixto de personal para obtener el número de carga sostenida.
Los **seis escenarios completos** del enunciado (E1–E6), cada uno con el rol que lo
ejecuta en la realidad, están en [`escenarios.js`](escenarios.js):

| # | Rol | Flujo | Endpoints |
|---|---|---|---|
| E1 | Cliente | Entra → inicio → agenda una cita | `/portal/resumen`, `/portal/motos`, `POST /portal/citas` |
| E2 | Cliente | Entra → mis citas → sigue una | `/portal/citas`, `/portal/citas/:id` |
| E3 | Recepción | Recibe → busca cliente → agenda | `/recepcion/citas-hoy`, `/recepcion/clientes?q=`, `POST /citas` |
| E4 | Admin | Órdenes → filtra → abre una | `/ordenes`, `/ordenes?estado=`, `/ordenes/:id` |
| E5 | Mecánico | Resumen → agenda → sus citas | `/mecanico/resumen`, `/mecanico/agenda`, `/mecanico/citas` |
| E6 | Admin | Reportes del mes y del año | `/admin/resumen`, `/admin/reportes?periodo=` |

Cada escenario corre con pocos usuarios y **umbral propio por etiqueta**, así se ve cuál
incumple en vez del promedio de todos. Dos decisiones a dejar dichas:

- **E4 no cambia el estado de la orden.** Las transiciones solo son válidas desde
  ciertos estados: en una prueba masiva la mayoría daría 400 y se mediría el camino de
  rechazo, no el trabajo real. Se cubre en las pruebas de API.
- **E1 y E2 necesitaban un cliente con contraseña real.** Los 2 000 clientes sembrados
  llevan un hash de relleno que no sirve para entrar, así que ningún escenario del
  portal podía iniciar sesión. `seed-carga.js` ahora crea además un cliente de prueba
  con contraseña conocida **y su moto** (sin moto, E1 no tiene sobre qué agendar).

---

## 4. Carga

50 usuarios concurrentes · rampa 30 s + meseta 2 min + bajada 20 s.

**Resultado final (tras las correcciones de §6):**

| Métrica | Valor | SLO | |
|---|---|---|---|
| p95 global | **43,55 ms** | < 500 ms | ✅ |
| p99 global | **496,37 ms** | < 1500 ms | ✅ |
| Tasa de error | **0,01 %** | < 1 % | ✅ |
| Checks funcionales | **100 %** | > 99 % | ✅ |
| Throughput | ~18 iteraciones/s | — | |

Por operación (p95): listar órdenes 34 ms · listar promociones 15 ms ·
listar clientes 83 ms · crear cita 866 ms.

**Conclusión:** con la carga esperada el sistema cumple todos los criterios con holgura.
Crear una cita es la operación más lenta —hace INSERT, valida cupos y dispara
notificaciones— pero se mantiene dentro de su umbral.

---

## 5. Estrés

Escalones de 50 → 100 → 200 → 400 → 800 usuarios, solo lectura, sin *think time*
([`estres.js`](estres.js)).

| Usuarios | Peticiones | Mediana | p95 | p99 | Máx |
|---|---|---|---|---|---|
| 50 | 11 034 | 300 ms | 1 261 ms | 2 749 ms | 2 972 ms |
| 100 | 3 775 | 737 ms | 2 526 ms | 2 901 ms | 2 979 ms |
| 200 | 2 703 | 1 173 ms | 2 869 ms | 2 937 ms | 2 980 ms |
| 400 | 2 040 | 479 ms | 2 881 ms | 2 941 ms | 3 087 ms |

**Cómo falla:** no falla. **Tasa de error 0 % en los 33 103 pedidos**, incluso en el
escalón de 800. El sistema **se degrada, no se cae**: las peticiones se encolan y la
latencia sube, pero se siguen respondiendo todas.

**Dónde se degrada:** el punto de quiebre respecto al SLO está **entre 50 y 100
usuarios concurrentes sin pausa**. Ya en 50 el p95 (1 261 ms) supera el objetivo de
500 ms, porque este escenario dispara peticiones sin descanso — muy por encima de lo
que hace una persona real. Con el patrón de uso realista de §4, los mismos 50 usuarios
dan un p95 de 43 ms. La diferencia entre ambos números es el margen que da el *think
time*.

**Recuperación:** al bajar de 800 a 25 usuarios la latencia vuelve a valores normales
sin reiniciar nada, y ningún worker murió. Se satura, no se rompe.

---

## 6. Hallazgos y acciones correctivas

Resumen de todo lo encontrado, con su estado. "Corregido y medido" significa que hay
números del antes y el después en este informe; "corregido, falta medir" significa que el
cambio está en el código y la mejora está razonada, pero no cuantificada con una corrida
propia.

| # | Hallazgo | Dónde | Estado |
|---|---|---|---|
| 1 | Un dato inválido devolvía HTTP 500 | Backend, todas las rutas | ✅ Corregido y medido (6,16 % → 0 % de error) |
| 2 | El listado de promociones pesaba 3 MB | `GET /api/promos` | ✅ Corregido y medido (3 007 KB → 5,6 KB) |
| 3 | Un cambio desplegado que no tuvo efecto | Railway / arranque | ✅ Corregido y verificado en producción |
| 4 | Accesibilidad bajo el objetivo | Registro + toda la app | ✅ Corregido (3 causas), falta remedir |
| 5 | Los archivos con hash se revalidaban en cada visita | `express.static` | ✅ Corregido, falta remedir |
| 6-ter · 1 | El hilo del chat devolvía las fotos embebidas | Mensajería | ✅ Corregido, falta medir |
| 6-ter · 2 | `/contactos` hacía 5 subconsultas por contacto | Mensajería | ✅ Corregido, falta medir |
| 6-ter · 3 | Faltaban los índices compuestos del chat | `mensajes_internos` | ✅ Corregido, falta medir |
| §7 · 5 | Se precargaban los 83 chunks a todo el mundo | Enrutador Angular | ✅ Corregido, falta remedir |
| §7 · 1 | Las imágenes viven en la base en base64 | Arquitectura | ⏳ Abierto — es el techo real |
| §7 · 6 | 960 ms de respuesta del documento raíz | Hosting | ⏳ Abierto — necesita CDN |

### Hallazgo 1 — Un dato inválido devolvía HTTP 500

**Detección.** La primera corrida arrojó **6,16 % de error**: las 624 altas de cita
fallaron. El registro del servidor mostraba violaciones de clave foránea.

**Causa.** `POST /api/citas` no comprueba que el `cliente_id` exista. El error de MySQL
llegaba al manejador genérico y salía como **500**. Un dato mal enviado —error del
cliente— se reportaba como falla del servidor.

**Por qué importa más allá de la prueba.** El cliente no puede distinguir "mandé mal los
datos" de "el sistema está caído", y en el monitoreo un formulario mal llenado se ve
igual que una caída real.

**Corrección.** En `backend/src/utils/responder.js`, los códigos de MySQL que describen
un dato inválido (FK inexistente, duplicado, texto muy largo, ENUM inválido, nulo
obligatorio) pasan a **400** con un mensaje que explica qué pasó. Aplica a **todas** las
rutas, no solo a citas. Cubierto con 2 tests nuevos.

| | Antes | Después |
|---|---|---|
| Tasa de error | **6,16 %** | **0,00 %** |
| Checks funcionales | 93,83 % | 100 % |

---

### Hallazgo 2 — El listado de promociones pesaba 3 MB

**Detección.** La métrica de tamaño de respuesta marcó **3 007 KB** por petición a
`/api/promos`, y la prueba de 3 minutos transfirió **11 GB**.

**Causa.** `SELECT *` arrastraba la imagen de cada promoción. Las imágenes se guardan
como *data URL* en base64 dentro de la propia tabla (~100 KB cada una): con 30
promociones activas, cada carga del panel movía 3 MB.

**Corrección.** El listado devuelve `tiene_imagen` y la imagen se pide por separado.
Es el patrón que **el portal del cliente ya usaba**; el panel del administrador nunca
se migró. El frontend las carga a demanda.

| | Antes | Después | |
|---|---|---|---|
| Peso de `/api/promos` | 3 007 KB | **5,6 KB** | **528×** |
| p95 de ese endpoint | 66,45 ms | **14,71 ms** | 4,5× |
| p95 global | 68,40 ms | **43,55 ms** | 1,6× |

En localhost el efecto sobre la latencia es moderado porque no hay red de por medio.
Sobre una conexión real esos 3 MB son el problema dominante: a 10 Mbps son ~2,4
segundos solo de transferencia, antes de que el navegador dibuje nada.

---

### Hallazgo 3 — Un cambio desplegado que no tuvo efecto

**Detección.** Tras activar el arranque multiproceso, el deploy salió `SUCCESS` y la
API respondía 200… pero seguía corriendo un solo proceso.

**Causa.** `railway.json` y `nixpacks.toml` arrancan el binario directo
(`node backend/src/server.js`) y nunca pasan por `npm start`, así que cambiar el script
del `package.json` no hizo nada.

**Corrección.** Ambos archivos apuntan al nuevo punto de entrada. Verificado en los
registros de producción: `🧵 Multiproceso: 2 workers` y un solo worker con las tareas
programadas.

**Lección aplicable al resto del informe:** un deploy en verde no prueba que el cambio
esté activo. Hay que verificar el efecto, no el estado del despliegue.

---

## 6-bis. Frontend — Core Web Vitals

Medido con **Lighthouse 13.4.1** contra el entorno desplegado
(`/portal/login`, la puerta de entrada pública del cliente), en escritorio y en móvil
con estrangulamiento de red y CPU simulados.

| | Escritorio | Móvil (red simulada) | Umbral "bueno" |
|---|---|---|---|
| **Performance** | **95** | **84** | ≥ 90 |
| Accesibilidad | 94 | 94 | ≥ 90 |
| Buenas prácticas | **100** | **100** | ≥ 90 |
| SEO | 75 | 75 | ≥ 90 |

### Core Web Vitals

| Métrica | Escritorio | Móvil | Umbral |
|---|---|---|---|
| **LCP** (mayor elemento visible) | **1,0 s** | **2,1 s** | < 2,5 s ✅ |
| **CLS** (salto de diseño) | **0** | **0** | < 0,1 ✅ |
| **TBT** (bloqueo del hilo) | 30 ms | **480 ms** | < 200 ms ⚠️ |
| FCP | 0,5 s | 1,2 s | < 1,8 s ✅ |
| Speed Index | 2,0 s | 4,8 s | < 3,4 s ⚠️ |
| Time to Interactive | 1,8 s | 6,1 s | — |

**Peso de la carga inicial:** 1 180 KB en 41 peticiones, de los cuales **514 KB son
JavaScript** en 31 archivos.

### Lectura

**Lo bueno.** `CLS = 0` en ambos: nada se mueve mientras carga, que es el defecto más
molesto de percibir y de los más difíciles de corregir después. El servidor responde el
documento en 170 ms. Buenas prácticas en 100.

**Lo que hay que mirar.** En móvil, **TBT de 480 ms y TTI de 6,1 s**. Es el costo del
paquete de JavaScript: 514 KB que el teléfono tiene que descargar, analizar y ejecutar
antes de que la pantalla responda al primer toque. En un gama media real se siente como
"se ve pero no reacciona". Es el patrón esperable de una SPA de Angular.

> **Corregido después.** La primera lectura de este punto fue que faltaba *lazy loading*
> por ruta —que el portal del cliente arrastraba código del panel de administración—. **Era
> falso**: la carga diferida ya estaba bien hecha. Lo que sí pasaba es que el enrutador
> precargaba los 83 chunks a todo el mundo apenas arrancaba. La explicación completa y la
> corrección están en la **recomendación 5** del §7; se deja acá el diagnóstico original
> porque entender por qué era equivocado vale más que borrarlo.

**SEO 75** es el puntaje más bajo, pero **no es relevante acá**: es una aplicación tras
inicio de sesión, no un sitio que deba posicionar en buscadores. Se reporta por
completitud, no como un problema a corregir.

**Relación con el hallazgo 2.** Esta medición se tomó en `/portal/login`, que no carga
promociones. La pantalla de ofertas sí las carga: antes de la corrección habría sumado
varios MB sobre estos 1 180 KB, en el dispositivo con menos margen. El impacto real de
esa corrección se ve mejor aquí que en los milisegundos de la prueba de carga local.

### Ampliación: el resto de las pantallas públicas

La medición anterior cubría solo `/portal/login`. Se agregaron las otras dos pantallas
públicas del portal. **No se pueden medir las pantallas internas** (inicio, mis citas,
agenda del mecánico, panel del administrador): están detrás de inicio de sesión y
Lighthouse no autentica — habría que guionarlo con Puppeteer, que queda pendiente.

Estas corridas usaron **Edge** (Chromium) porque la máquina no tiene Chrome, contra el
entorno desplegado y desde una sola ubicación de red. Para que la comparación sea
honesta se **volvió a medir `/portal/login` en las mismas condiciones**, en vez de
compararlo contra los números de la corrida original:

| Pantalla | Disp. | Perf | A11y | LCP | CLS | TBT |
|---|---|---|---|---|---|---|
| login *(remedido)* | escritorio | 81 | 94 | 1,5 s | 0 | 160 ms |
| login *(remedido)* | móvil | 62 | 94 | 2,6 s | 0 | 1 380 ms |
| **registro** | escritorio | **63 / 57** | **88** | **4,1 / 4,6 s** | 0 | 190 / 270 ms |
| **registro** | móvil | **44** | **88** | **16,8 s** | 0 | **940 ms** |
| **recuperar** | escritorio | 65 | 94 | 4,2 s | 0 | 130 ms |

Registro se midió dos veces en escritorio: 63 y 57. La diferencia entre corridas es
menor que la diferencia contra login, así que **no es ruido de red**.

**Lectura honesta de estos números.** Hay que separar dos cosas que se confunden fácil:

1. **El entorno de medición es peor que en la corrida original** (login pasó de 95 a 81
   en escritorio). Cambió el navegador y la red, así que los valores absolutos de esta
   tabla **no son comparables** con los de la sección anterior.
2. **Aun así, registro es genuinamente peor que login**, medidos el mismo día con la
   misma herramienta: 57–63 contra 81, y LCP de 4,1 s contra 1,5 s. Esa diferencia sí
   es real y no la explica el entorno.

**CLS = 0 en todas.** Se confirma en las cinco corridas: la estabilidad visual es una
fortaleza consistente de la aplicación, no un dato suelto de una pantalla.

**LCP incumple el umbral en registro y recuperar** (> 4 s es la banda "pobre" de
Google). Lighthouse señala dos causas, ambas ya identificadas en este informe:

- *"Reduce initial server response time — Root document took 960 ms"*: casi un segundo
  antes de que el navegador reciba el documento. Sigue abierto: es latencia hasta Railway
  más arranque del contenedor, y se resuelve con un CDN delante (recomendación 6).
- *"Reduce unused JavaScript — Est savings of 863 KiB"*: **corregido**. No era código mal
  separado sino la precarga de todos los chunks a todo el mundo; ver recomendación 5.
  Falta remedir para confirmar cuánto de esos 863 KiB desaparecen.

---

### Hallazgo 4 — Accesibilidad por debajo del objetivo en el registro

**Detección.** `registro` puntúa **88** en accesibilidad, bajo el SLO de 90, mientras
`recuperar` y `login` dan 94. La diferencia apunta a la pantalla, no al tema general.

**Causas (las dos que reporta Lighthouse):**

1. **`Form elements do not have associated labels`** — campos del formulario de registro
   sin etiqueta asociada. Afecta a quien usa lector de pantalla: escucha "cuadro de
   edición" sin saber qué se le pide. Es específico de esta pantalla y corregible.
2. **`[user-scalable="no"]` en el `<meta name="viewport">`** — bloquea el zoom con los
   dedos. Afecta a **toda** la aplicación, no solo al registro, y explica por qué
   ninguna pantalla llega a 100. Es el valor por defecto de Ionic y es deliberado, pero
   choca con que el sistema ofrezca ajuste de tamaño de texto por accesibilidad: una
   persona con baja visión no puede ampliar.

**Corrección de la primera.** Los campos sin etiqueta eran **nombre**, **apellido** y
**confirmar contraseña**. El detalle interesante: el `<input>` real vive dentro del shadow
DOM de Ionic y no queda asociado al `<ion-label>`, así que los demás campos **se salvaban
de casualidad** porque su `placeholder` cumple de nombre accesible. Los tres que no tenían
placeholder quedaban mudos para un lector de pantalla. Se les puso `aria-label` explícito,
que es la forma correcta y no depende del placeholder.

**Corrección de la segunda.** Se quitó `user-scalable=no, maximum-scale=1` del
`<meta name="viewport">`. Se había dejado pendiente por ser "una decisión de producto"
(el zoom accidental con dos dedos hace que una app se sienta menos nativa), y se resolvió
en favor de la accesibilidad por un argumento concreto: **la propia aplicación ofrece un
ajuste de tamaño de texto**, así que ya había asumido que hay gente que necesita agrandar.
Bloquear el zoom del sistema mientras se ofrece un sustituto propio y peor no se sostiene.
Afectaba a **todas** las pantallas, no solo al registro.

**Tercera causa, encontrada después: contraste insuficiente en el panel oscuro.** No la
reportó la corrida de Lighthouse sobre las pantallas públicas —el panel está detrás de
inicio de sesión— sino la revisión de los tokens del tema. El token `--tx3` valía
`#525252`, que sobre los fondos oscuros del panel (`#111111`–`#1a1a1a`) da entre **2,2 y
2,5:1**, muy lejos del 4,5:1 que exige WCAG AA para texto normal. Se usa en etiquetas de
sección y textos de apoyo, así que la falla estaba repetida en **todas** las pantallas del
panel. Se subió a `#8A8A8A`, el gris más tenue que supera 4,5:1 contra el fondo más claro
de la familia. Mismo caso, y misma corrección, en los dos `#737373` del portal oscuro.

> **Nota de método.** Estas tres correcciones **no están reflejadas en las tablas de
> puntajes de arriba**: esas corridas son anteriores. Falta volver a medir para
> cuantificar la mejora; lo esperable es que `registro` supere el 90 de accesibilidad y
> que el resto suba unos puntos al desaparecer la falla del viewport, que era común a
> todas las pantallas.

---

### Hallazgo 5 — Los archivos con hash se revalidaban en cada visita

**Detección.** Al revisar por qué el documento tarda, se midieron las cabeceras que
manda producción para un asset con hash:

```
GET /main.b8e0610d56ade15b.js  →  Cache-Control: public, max-age=0
```

**Causa.** `express.static` sin opciones no fija `max-age`. Los archivos del build
llevan el hash del contenido en el nombre —si cambia el contenido, cambia el nombre—
así que podrían cachearse indefinidamente, pero el navegador estaba obligado a
revalidar **los ~31 archivos JS en cada visita**: un viaje de ida y vuelta por archivo
para que el servidor conteste "no cambió".

**Corrección.** Los archivos con hash se sirven con `max-age` de un año e `immutable`;
`index.html` se sirve con `no-cache` porque es el que apunta a los hashes nuevos y, si
se cacheara, un despliegue no se vería hasta que venciera.

**A quién beneficia.** A las visitas repetidas, que es el caso normal: el personal del
taller abre la aplicación todos los días.

---

## 6-ter. Mensajería interna — análisis del techo

El chat quedó fuera de las corridas anteriores. Se analizó su código y se preparó
[`mensajeria.js`](mensajeria.js) para medirlo. **Los números de abajo son estimaciones
a partir del código y del tamaño conocido de las fotos, no mediciones**: sirven para
saber dónde mirar, no para dar por probado el módulo.

> **Estado: los tres riesgos ya están corregidos en el código.** Cada uno lleva abajo su
> corrección. Lo que sigue pendiente es **medir**: `mensajeria.js` está escrito y no se ha
> ejecutado, así que la mejora está razonada y no comprobada con números propios.

### Lo que hace distinto a este módulo

El costo del chat **no depende de cuánto se escriba**, sino de **cuánta gente lo tenga
abierto**. El frontend refresca solo:

| Componente | Cada | Qué pide |
|---|---|---|
| `chat-hilo` | **12 s** | Los últimos **200 mensajes** de la conversación |
| `chat-contactos` | **15 s** | La lista completa de contactos |

Nadie toca nada y el tráfico ocurre igual. Es el patrón contrario al del resto de la
aplicación, donde una pantalla se carga cuando alguien entra.

### Riesgo 1 — El hilo devuelve las fotos embebidas (mismo caso que el hallazgo 2)

`SELECT_MSG` incluye `m.foto`, que es **MEDIUMTEXT con la imagen en base64**. La consulta
del hilo devuelve 200 mensajes con su foto adentro. Con el mismo tamaño de imagen que
usa el resto del sistema (~100 KB):

| Fotos entre los últimos 200 | Peso por refresco | Por usuario y minuto |
|---|---|---|
| 5 | ~0,5 MB | 2,5 MB |
| 20 (10 %) | **~2 MB** | **10 MB** |
| 50 (25 %) | ~5 MB | 25 MB |

Con 5 empleados y el chat abierto, el caso del 10 % son **~50 MB/min sostenidos**, o sea
unos **7 Mbps solo de chat** — sin que nadie escriba un mensaje. Es exactamente el
problema de las promociones (3 MB por listado) pero repitiéndose **cinco veces por
minuto y por persona**.

**Corrección aplicada** (análoga a la del hallazgo 2). `SELECT_MSG` ahora devuelve
`(m.foto IS NOT NULL) AS tiene_foto` en vez de la imagen, y esta se sirve aparte por
`GET /api/mensajeria/mensaje/:id/foto`. Lo mismo con los avatares del personal, que
viajaban en la lista de contactos y en la cabecera del hilo
(`GET /api/mensajeria/contacto/:id/foto`).

Tres detalles que hacen que la corrección sirva de verdad:

- **El cliente cachea por id de mensaje.** Un mensaje enviado no cambia nunca, así que una
  vez traída la imagen no se vuelve a pedir. El refresco de 12 s solo busca las de los
  mensajes nuevos, que casi siempre son cero: **es lo que convierte el polling de mover
  megabytes a mover texto.** Sin la caché, la corrección solo habría movido el tráfico de
  una petición a otra.
- **La foto recién enviada se siembra en la caché** con la copia que ya está en memoria,
  en vez de volver a bajarla del servidor.
- **Se reserva el alto de la burbuja** mientras la imagen viaja, para no reintroducir salto
  de diseño (CLS) justo después de haber medido 0 en todas las pantallas.

El control de acceso de la ruta nueva se escribió explícito: un id de mensaje es un número
correlativo, así que sin comprobar pertenencia al par cualquiera del personal podría
recorrer ids y leer fotos de conversaciones ajenas. Devuelve **404 y no 403** cuando no
corresponde, porque un 403 confirmaría que ese mensaje existe.

| | Antes | Después |
|---|---|---|
| Hilo con 20 fotos, por refresco | ~2 MB | ~2 MB la primera vez, **~0 KB** en los siguientes |
| 5 personas con el chat abierto | ~50 MB/min sostenidos | picos al abrir, sin costo sostenido |

**Lo que la corrección no resuelve.** La primera apertura de un hilo con muchas fotos sigue
descargando todas —ahora en peticiones paralelas en vez de una sola respuesta—, porque se
piden las de los 200 mensajes y no solo las visibles en pantalla. El tráfico total de esa
primera vez es el mismo; lo que desaparece es la **repetición cada 12 s**, que era el
problema real. Cargar solo las que entran en pantalla queda como mejora posterior.

### Riesgo 2 — `/contactos` hace 5 subconsultas correlacionadas por contacto

Para cada empleado de la lista, la consulta resuelve cuatro subconsultas para el último
mensaje (texto, si es foto, remitente y fecha) más un `COUNT(*)` de no leídos que a su
vez lleva un `NOT EXISTS` anidado. Son **5 subconsultas × N contactos**, y encima
ordena por una columna calculada (`ultima_fecha`), lo que obliga a materializar el
resultado antes de ordenar.

Con 5 empleados no se nota. El costo crece con el **total de mensajes de la tabla**, no
con los que se ven en pantalla: cada subconsulta recorre `mensajes_internos` buscando el
par. Y se ejecuta cada 15 s por cada persona con la pantalla abierta.

**Corrección aplicada.** La consulta pasó a **dos recorridos fijos**, independientes de la
cantidad de contactos:

- el **último mensaje de cada par**, con `ROW_NUMBER() OVER (PARTITION BY … ORDER BY
  created_at DESC, id DESC)` sobre los mensajes propios — una sola pasada resuelve de golpe
  lo que antes eran cuatro subconsultas repetidas por contacto;
- los **no leídos agrupados por remitente**, con un `GROUP BY` en lugar del `COUNT` con
  `NOT EXISTS` anidado por fila.

El desempate por `id` no es decorativo: varios mensajes pueden compartir el segundo, y sin
él la conversación mostraría un "último mensaje" arbitrario. El `ORDER BY` final ahora usa
una columna del `JOIN` y no una calculada, y los parámetros del query bajaron de 11 a 7.
De **5·N** recorridos de la tabla a **2**.

### Riesgo 3 — Faltan los índices que piden esas consultas

La tabla tiene `idx_msg_remitente(remitente_id)` e `idx_msg_destino(destino_id)`, dos
índices de **una sola columna**. Las consultas del chat filtran por el **par**
(`remitente_id` Y `destino_id`), además de `tipo`, y ordenan por `created_at`. Con
índices de una columna, MySQL entra por una de ellas y filtra y ordena el resto en
memoria.

**Índice que corresponde:**

```sql
CREATE INDEX idx_msg_par ON mensajes_internos (remitente_id, destino_id, created_at);
CREATE INDEX idx_msg_par_inv ON mensajes_internos (destino_id, remitente_id, created_at);
```

Los dos porque la conversación se consulta en ambos sentidos (`A→B` o `B→A`).

**Corrección aplicada.** Los dos índices se crean desde `ensureSchema`
([`auto-migrate.js`](../backend/src/db/auto-migrate.js)), más un tercero para los avisos,
que se filtran por rol y se ordenan por fecha:

```sql
CREATE INDEX idx_msg_broadcast ON mensajes_internos (tipo, destino_rol, created_at);
```

Van por `ensureSchema` y no por `schema.sql` porque ese archivo tiene `DROP TABLE`: en
producción el esquema se cambia con migraciones idempotentes, nunca recreando las tablas.

### Estimación del techo, y por qué hay que medirlo

Juntando lo anterior, el límite **no era la cantidad de mensajes almacenados** sino la
combinación de tres cosas: cuántas personas tienen el chat abierto, cuántas fotos hay
entre los últimos 200 de cada hilo, y el total de filas de la tabla (que degradaba
`/contactos`).

El orden de magnitud esperable era: **el ancho de banda se agota antes que la base**. Con
20 fotos por hilo y 10 personas con el chat abierto, ~100 MB/min; la base, en cambio,
aguanta millones de filas con los índices del riesgo 3.

Con las tres correcciones, el techo debería moverse de sitio: ya no es el ancho de banda
sostenido, sino la **frecuencia de refresco** (12 s y 15 s por persona con la pantalla
abierta), que ahora mueve respuestas de texto. El siguiente límite razonable de encontrar
es el número de personas con el chat abierto contra el pool de conexiones, no los
megabytes.

**Eso es exactamente lo que falta comprobar.** `mensajeria.js` registra `peso_hilo_kb` y
`peso_contactos_kb` además de la latencia, porque en este módulo **los milisegundos engañan
si no se ve cuántos bytes se movieron**, y `seed-carga.js` ya siembra 5 000 mensajes (10 %
con foto) para que haya volumen que recorrer. Correrlo antes y después de estas
correcciones es la forma de convertir las tablas de arriba en medición.

---

## 6-quater. Medición de campo — Core Web Vitals de usuarios reales

Todo lo del §6-bis es **laboratorio**: una herramienta que carga la página en condiciones
controladas y la mira sin tocarla. Sirve para comparar cambios, pero tiene un punto ciego
que no se arregla con más corridas: **el INP no existe sin interacción**. Es el tiempo que
tarda la interfaz en pintar la respuesta a un toque, y Lighthouse no toca nada. Es también
la métrica que más se parece a la queja real del personal —"se ve pero no reacciona"—, que
en el §6-bis solo aparece indirectamente, como TBT de 480 ms en móvil.

**Qué se agregó.** La librería oficial `web-vitals` (~2 KB) en el arranque de la
aplicación ([`web-vitals.util.ts`](../frontend/src/app/shared/web-vitals.util.ts)), que
observa de forma pasiva LCP, CLS, INP, FCP y TTFB y los envía a
`POST /api/metricas/web-vitals`. El resumen se consulta por
`GET /api/metricas/web-vitals` (solo administración) y se guarda en la tabla `web_vitals`.

Cuatro decisiones que vale la pena dejar dichas:

- **Se envía con `sendBeacon`.** Es el único mecanismo que sobrevive al cierre de la
  pestaña, que es justamente cuando quedan firmes los valores definitivos de CLS e INP. El
  `fetch` con `keepalive` queda de reserva para navegadores que no lo tengan.
- **El endpoint de escritura es público a propósito.** Las métricas más valiosas son las de
  login y registro, que ocurren **antes** de que exista un token. A cambio se valida con
  dureza: solo los cinco nombres conocidos, valor finito entre 0 y 600 000 ms (un tope que
  además descarta pestañas que estuvieron en segundo plano) y ruta recortada. Queda dentro
  del limitador general de `/api`.
- **Se guarda la ruta sin querystring** y nada más: ni identificador de usuario, ni IP, ni
  agente. Alcanza para agrupar por pantalla y no convierte una tabla de rendimiento en un
  registro de actividad de las personas.
- **Se reporta el percentil 75**, que es el criterio de Google: una métrica "cumple" si el
  75 % de las visitas la cumple. El promedio escondería justo la cola lenta, que es la que
  la gente recuerda.

Si algo de esto falla, se ignora en silencio: **medir nunca debe romperle la pantalla a
nadie**.

**Estado.** Instrumentado y compilando; **sin datos todavía**. Para que la sección tenga
números hace falta que la versión con la instrumentación esté un tiempo en producción y
que se use. Además quedan dos cosas abiertas, que se anotan acá para que no se pierdan:

1. **Nadie lee todavía el `GET`.** No hay pantalla que lo muestre, así que los datos solo
   se ven consultando la API a mano. Corresponde una tarjeta en el panel de administración.
2. **La tabla no tiene política de retención.** Son cinco filas por carga de página y por
   persona, sin borrado por antigüedad, sobre una base que ya es el recurso más ajustado
   del plan de Railway. Hace falta una limpieza periódica —o guardar agregados en vez de
   cada muestra— antes de dejarla corriendo mucho tiempo.

---

## 7. Limitaciones y trabajo pendiente

Lo que este informe **no** demuestra, dicho explícitamente:

1. **Se midió en localhost.** Sin latencia de red, la transferencia de datos casi no
   cuesta. Es la razón por la que el hallazgo 2 se ve modesto en milisegundos pese a
   ser 528× menos tráfico. Una medición contra el entorno desplegado daría números
   peores y más realistas.
2. **Del frontend solo hay números de las tres pantallas públicas** (login, registro,
   recuperar). Las internas —inicio del cliente, mis citas, ofertas, agenda del mecánico,
   panel del administrador— están detrás de inicio de sesión, y Lighthouse no autentica.
   **Ya no es un impedimento técnico:** [`lighthouse-auth.mjs`](lighthouse-auth.mjs) inicia
   sesión por la API con Puppeteer, deja el token en `localStorage` y corre Lighthouse
   sobre ese mismo navegador con `disableStorageReset`. Falta ejecutarlo y volcar los
   resultados acá. Son justamente las pantallas que cargan datos pesados, así que sus
   números serán peores que los de esta tabla.

   Vale la pena registrar **por qué hacía falta el guion**: pedirle a Lighthouse
   `/portal/inicio` sin sesión no falla — el guard de Angular redirige a `/portal/login` y
   el informe sale igual, con el número de la pantalla equivocada. Se comprobó mirando
   `finalDisplayedUrl` en el JSON. Un error así no se nota si uno solo mira el puntaje.
3. **No se usó WebPageTest** (red simulada 3G/4G, waterfall, filmstrip). **Del INP ya hay
   instrumentación, pero todavía no hay datos:** la métrica no existe sin interacción real,
   así que se agregaron las dos vías que la producen —
   [`medir-inp.mjs`](medir-inp.mjs), que abre un navegador, inicia sesión, hace clics
   reales y lee el INP de la librería oficial; y la recolección de campo descrita en
   §6-quater, que la mide en los navegadores de quienes usan la app. Falta acumular visitas
   reales y reportar el percentil 75.
4. **Los escenarios E1–E6 están escritos pero no ejecutados.** `escenarios.js` quedó
   listo; falta correrlo contra la base sembrada y volcar sus números acá. Los
   resultados de §4 y §5 corresponden a `carga.js` y `estres.js`, que sí se ejecutaron.
5. **El escalón de 800 usuarios quedó parcial**: la exportación de datos crudos frenó
   al generador y no completó ese tramo. Los escalones hasta 400 sí son completos.
6. **La máquina de prueba tiene 18 núcleos**; el contenedor de producción tiene una
   fracción de eso. Los números absolutos de producción serán menores.
7. **Las corridas de Lighthouse de la ampliación usaron Edge**, no Chrome (la máquina
   no lo tiene). Ambos son Chromium y las métricas son equivalentes, pero por eso se
   remidió login en las mismas condiciones en vez de comparar contra la corrida vieja.

### Recomendaciones, por prioridad

1. **Sacar las imágenes de la base de datos** hacia almacenamiento de objetos con CDN.
   Es el techo real: hoy cada foto ocupa 33 % más por el base64, viaja por el pool de
   conexiones y no se puede cachear. Cuanto más se espere, más caro migrar lo ya
   guardado.
2. ~~**Aplicar el mismo criterio del hallazgo 2 al chat**, que aún envía las fotos de los
   mensajes dentro del listado.~~ **Hecho** (ver §6-ter): el hilo y la lista de contactos
   devuelven `tiene_foto` y las imágenes se piden aparte y se cachean por id. Falta
   **medirlo** con `mensajeria.js`.
3. **Store compartido (Redis) para el limitador de tasa** antes de escalar a varias
   instancias: hoy es por proceso y el cupo efectivo se multiplica.
4. **Paginación estricta** en los listados globales, que hoy tienen un tope de 500 filas.
5. ~~**Carga diferida por ruta en el frontend.**~~ **El diagnóstico era falso, pero había
   un problema real al lado — y ya está corregido.** Conviene leer las dos partes juntas,
   porque es el hallazgo del informe que más fácil se malinterpreta.

   **La carga diferida ya estaba bien hecha.** Se verificó buscando cadenas propias del
   panel de administración (`admin-empleados`, "Gestión de Empleados", "Resumen
   ejecutivo") dentro de `main.js`: **cero apariciones**. El código de la aplicación son
   2 198 KB repartidos en 83 chunks que se bajan bajo demanda, y `main.js` contiene solo
   el framework. También se descartó que arrastrara el compilador JIT: se cambió el
   arranque a `platformBrowser()` y el archivo resultante salió **con el hash idéntico**
   (el build moderno ya lo elimina), así que el cambio se revirtió por no aportar nada.

   **Entonces, ¿de dónde salían los 863 KiB de "unused JavaScript" que marcaba
   Lighthouse?** No de que los chunks estuvieran mal separados, sino de que **se
   descargaban igual**: el enrutador usaba `PreloadAllModules`, que después de arrancar se
   baja los 83 chunks **a todo el mundo**. Los archivos estaban bien partidos y aun así
   viajaban completos. Es un buen recordatorio de que "unused JavaScript" no dice *cómo*
   llegó ese código al navegador — hay que ir a mirar.

   Para el personal la estrategia tenía sentido: entra a la mañana y navega todo el día,
   conviene pagar la descarga una vez. Para el cliente del portal no: entra desde el
   teléfono, mira su cita y se va, y estaba bajando el panel de administración, la
   recepción y el módulo del mecánico, que **nunca va a poder abrir**. Y ese tráfico compite
   por el ancho de banda justo mientras la página intenta pintar, así que golpea a FCP, LCP
   y Speed Index — las tres métricas peores de la tabla del §6-bis en móvil.

   **Corrección aplicada.** Una estrategia propia
   ([`precarga-por-rol.ts`](../frontend/src/app/shared/precarga-por-rol.ts)) que precarga
   **solo los módulos que ese rol puede abrir**, y recién **2 s después** del arranque para
   no competir con el renderizado inicial. Sin sesión no precarga nada: la única pantalla
   que importa en ese momento es el login, que ya se está cargando, y todavía no se sabe
   qué va a necesitar esa persona.

   Falta **volver a medir** para cuantificarlo: el número esperable es que el "unused
   JavaScript" del portal caiga de 863 KiB a casi nada, sin tocar el paquete inicial.

   Consecuencia para el SLO, que no cambia: **el objetivo de < 500 KB de paquete inicial no
   es alcanzable** sin cambiar de framework —es el piso de Angular + Ionic, hoy 682 KB de
   `main.js` sin comprimir—. Corresponde subirlo (~700 KB) o dejar constancia de por qué se
   acepta.

6. **Poner un CDN delante (Cloudflare u otro).** Lighthouse marca
   `server-response-time` en **960 ms** para el documento raíz, con puntuación 0. No es
   código: es latencia geográfica hasta Railway más el arranque del contenedor. Es la
   mayor mejora pendiente de LCP y no se resuelve desde la aplicación.

---

## Cómo reproducir

```bash
# 0. Frontend (Core Web Vitals) — las tres pantallas publicas
# Sin Chrome instalado: export CHROME_PATH="...\msedge.exe" (Edge tambien es Chromium)
for p in login registro recuperar; do
  npx lighthouse <url>/portal/$p --preset=desktop --output=json --output-path=lh-$p-escritorio.json
  npx lighthouse <url>/portal/$p             --output=json --output-path=lh-$p-movil.json   # movil + red simulada
done

# 0-bis. Pantallas que exigen sesion (portal del cliente y panel del personal).
# Los scripts .mjs reusan puppeteer-core y lighthouse de la instalacion de npx: si la
# ruta del cache no es la del equipo donde se escribieron, se indica con NPX_CACHE.
# NPX_CACHE="$(npm config get cache)/_npx/<hash>/"   # ubicar con: ls "$(npm config get cache)/_npx"
PORTAL_EMAIL=cliente@correo.com PORTAL_PASS=... node pruebas-carga/lighthouse-auth.mjs
LOGIN_STAFF=1 EMAIL=admin@taller.com PASS=... node pruebas-carga/lighthouse-auth.mjs

# 0-ter. INP con interaccion real (clics de verdad sobre cada pantalla)
PORTAL_EMAIL=cliente@correo.com PORTAL_PASS=... node pruebas-carga/medir-inp.mjs

# 1. Base de pruebas
node backend/src/db/migrate.js                     # con MYSQL_URL apuntando a la base local
node backend/scripts/seed-carga.js "mysql://root@127.0.0.1:3307/taller_pruebas"

# 2. Backend con los límites elevados (solo para la prueba)
MYSQL_URL=... WEB_CONCURRENCY=2 RATE_API_MAX=1000000 RATE_AUTH_MAX=1000000 \
  node backend/src/cluster.js

# 3. Pruebas
k6 run -e BASE=http://localhost:3000 pruebas-carga/carga.js       # carga sostenida
k6 run -e BASE=http://localhost:3000 pruebas-carga/estres.js      # escalones hasta el quiebre
k6 run -e BASE=http://localhost:3000 pruebas-carga/escenarios.js  # los seis flujos E1-E6
k6 run -e BASE=http://localhost:3000 pruebas-carga/mensajeria.js  # techo del chat interno
```

El script de siembra **se niega a correr contra cualquier host que no sea local**:
sembrar miles de registros falsos en producción no se deshace sin restaurar un respaldo.
