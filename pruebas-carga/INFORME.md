# Informe de Pruebas No Funcionales — TallerMS / MS Motos

**Fecha:** 31 de julio de 2026
**Alcance:** API del backend bajo carga y estrés (§4–§6) y Core Web Vitals del frontend (§6-bis).

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
"se ve pero no reacciona". Es el patrón esperable de una SPA de Angular, y la vía de
mejora es *lazy loading* por ruta: hoy el portal del cliente arrastra código del panel
de administración que nunca va a usar.

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
  antes de que el navegador reciba el documento.
- *"Reduce unused JavaScript — Est savings of 863 KiB"*: es la misma carga diferida por
  ruta de la recomendación 5, ahora cuantificada.

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

Ninguna de las dos se corrigió en esta ronda: la primera es un cambio de plantilla y la
segunda es una decisión de producto (afecta la sensación de app nativa). Quedan
registradas con su causa exacta para decidirlas.

---

## 7. Limitaciones y trabajo pendiente

Lo que este informe **no** demuestra, dicho explícitamente:

1. **Se midió en localhost.** Sin latencia de red, la transferencia de datos casi no
   cuesta. Es la razón por la que el hallazgo 2 se ve modesto en milisegundos pese a
   ser 528× menos tráfico. Una medición contra el entorno desplegado daría números
   peores y más realistas.
2. **Del frontend solo se midieron las tres pantallas públicas** (login, registro,
   recuperar). Las internas —inicio del cliente, mis citas, ofertas, agenda del
   mecánico, panel del administrador— están detrás de inicio de sesión y Lighthouse no
   autentica: haría falta guionarlo con Puppeteer. Son justamente las que cargan datos
   pesados, así que sus números serán peores que los de esta tabla.
3. **No se usó WebPageTest** (red simulada 3G/4G, waterfall, filmstrip) ni se midió
   **INP**: esa métrica necesita interacción real de usuario y no la reporta un análisis
   de laboratorio; requiere datos de campo con `web-vitals.js`.
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
2. **Aplicar el mismo criterio del hallazgo 2 al chat**, que aún envía las fotos de los
   mensajes dentro del listado.
3. **Store compartido (Redis) para el limitador de tasa** antes de escalar a varias
   instancias: hoy es por proceso y el cupo efectivo se multiplica.
4. **Paginación estricta** en los listados globales, que hoy tienen un tope de 500 filas.
5. **Carga diferida por ruta en el frontend.** Son 514 KB de JavaScript en la carga
   inicial y un TBT de 480 ms en móvil: el portal del cliente arrastra código del panel
   de administración que nunca va a usar. Es la mayor mejora pendiente de cara a las
   tiendas de aplicaciones, donde el objetivo es un teléfono de gama media.

---

## Cómo reproducir

```bash
# 0. Frontend (Core Web Vitals) — las tres pantallas publicas
# Sin Chrome instalado: export CHROME_PATH="...\msedge.exe" (Edge tambien es Chromium)
for p in login registro recuperar; do
  npx lighthouse <url>/portal/$p --preset=desktop --output=json --output-path=lh-$p-escritorio.json
  npx lighthouse <url>/portal/$p             --output=json --output-path=lh-$p-movil.json   # movil + red simulada
done

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
```

El script de siembra **se niega a correr contra cualquier host que no sea local**:
sembrar miles de registros falsos en producción no se deshace sin restaurar un respaldo.
