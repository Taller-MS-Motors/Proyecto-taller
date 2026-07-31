# Informe de Pruebas No Funcionales — TallerMS / MS Motos

**Fecha:** 31 de julio de 2026
**Alcance:** API del backend bajo carga y estrés. El frontend queda pendiente (ver §7).

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

## 7. Limitaciones y trabajo pendiente

Lo que este informe **no** demuestra, dicho explícitamente:

1. **Se midió en localhost.** Sin latencia de red, la transferencia de datos casi no
   cuesta. Es la razón por la que el hallazgo 2 se ve modesto en milisegundos pese a
   ser 528× menos tráfico. Una medición contra el entorno desplegado daría números
   peores y más realistas.
2. **No se midió el frontend.** Falta Lighthouse (LCP, CLS, INP, tamaño del paquete) y
   WebPageTest con red 3G/4G simulada.
3. **El escalón de 800 usuarios quedó parcial**: la exportación de datos crudos frenó
   al generador y no completó ese tramo. Los escalones hasta 400 sí son completos.
4. **La máquina de prueba tiene 18 núcleos**; el contenedor de producción tiene una
   fracción de eso. Los números absolutos de producción serán menores.

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

---

## Cómo reproducir

```bash
# 1. Base de pruebas
node backend/src/db/migrate.js                     # con MYSQL_URL apuntando a la base local
node backend/scripts/seed-carga.js "mysql://root@127.0.0.1:3307/taller_pruebas"

# 2. Backend con los límites elevados (solo para la prueba)
MYSQL_URL=... WEB_CONCURRENCY=2 RATE_API_MAX=1000000 RATE_AUTH_MAX=1000000 \
  node backend/src/cluster.js

# 3. Pruebas
k6 run -e BASE=http://localhost:3000 pruebas-carga/carga.js
k6 run -e BASE=http://localhost:3000 pruebas-carga/estres.js
```

El script de siembra **se niega a correr contra cualquier host que no sea local**:
sembrar miles de registros falsos en producción no se deshace sin restaurar un respaldo.
