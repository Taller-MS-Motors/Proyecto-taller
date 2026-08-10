# Documentación de la API — Sistema MS Motos

Referencia de los endpoints del sistema, agrupados por módulo.

**Prefijo común:** todas las rutas cuelgan de `/api`.

**Control de acceso.** Los roles internos siguen una jerarquía ascendente:
`recepción < técnico < administración`. Un endpoint marcado como «Recepción o
superior» es accesible también por técnico y administración. Los tokens de cliente y
de personal son de tipos distintos y no son intercambiables.

**Convenciones de respuesta.** Éxito: `{ data: ... }`. Error: `{ error: "mensaje" }`.
Los datos inválidos devuelven 400; sin sesión, 401; sin permiso, 403; inexistente, 404.
El 500 se reserva para fallas reales del servidor.

---

## Autenticación · `/api/auth`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| POST | `/auth/login` | Inicia sesión del personal | Público | `email`, `password` |
| GET | `/auth/me` | Usuario de la sesión actual | Autenticado | — |
| POST | `/auth/2fa/verificar` | Canjea el código de dos pasos por la sesión | Público (token parcial) | `token_parcial`, `codigo` |
| GET | `/auth/2fa/estado` | Indica si la cuenta tiene 2FA activo | Autenticado | — |
| POST | `/auth/2fa/setup` | Genera el secreto y el código QR | Autenticado | — |
| POST | `/auth/2fa/activar` | Activa la verificación en dos pasos | Autenticado | `codigo` |
| POST | `/auth/2fa/desactivar` | Desactiva la verificación en dos pasos | Autenticado | `password` |

## Citas · `/api/citas`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/citas` | Lista citas con filtros | Recepción o superior | `?fecha`, `?estado`, `?tecnico_id`, `?sucursal_id`, `?q` |
| POST | `/citas` | Agenda una cita | Recepción, Admin | `cliente_id`, `moto_id`, `fecha`, `hora`, `motivo` |
| GET | `/citas/:id` | Detalle de una cita | Recepción o superior | — |
| PUT | `/citas/:id` | Reprograma o edita la cita | Recepción, Admin | `fecha`, `hora`, `motivo`, `tecnico_id` |
| PATCH | `/citas/:id/estado` | Cambia el estado | Recepción o superior¹ | `estado` |
| PATCH | `/citas/:id/asignar` | Asigna un mecánico | Admin | `tecnico_id` |

¹ El técnico solo puede modificar las citas que tiene asignadas.

## Órdenes de trabajo · `/api/ordenes`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/ordenes` | Lista órdenes con filtros | Recepción o superior | `?estado`, `?tecnico_id`, `?fecha_desde`, `?fecha_hasta` |
| POST | `/ordenes` | Crea una orden de trabajo | Recepción o superior | `moto_id`, `cliente_id`, `problema_reportado` |
| GET | `/ordenes/:id` | Detalle completo de la orden | Recepción o superior | — |
| PUT | `/ordenes/:id` | Edita diagnóstico y costos | Técnico o superior | `diagnostico`, `costo_mano_obra`, `costo_repuestos`, `descuento` |
| PATCH | `/ordenes/:id/estado` | Avanza el estado de la orden | Recepción o superior | `estado` |
| PATCH | `/ordenes/:id/tecnico` | Reasigna el mecánico | Recepción o superior | `tecnico_id` |
| POST | `/ordenes/:id/avances` | Registra un avance del trabajo | Recepción o superior | `descripcion` |
| GET | `/ordenes/:id/avances` | Historial de avances | Recepción o superior | — |
| POST | `/ordenes/:id/repuestos` | Agrega un repuesto con precio | Recepción o superior | `nombre`, `cantidad`, `costo_unitario` |
| GET | `/ordenes/:id/tiempos` | Tiempo consumido por etapa | Recepción o superior | — |

## Clientes · `/api/clientes`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/clientes` | Lista y busca clientes | Recepción, Admin | `?q` |
| POST | `/clientes` | Registra un cliente | Recepción, Admin | `nombre`, `apellido`, `telefono`, `email`, `cedula` |
| GET | `/clientes/:id` | Ficha del cliente | Recepción, Admin | — |
| PUT | `/clientes/:id` | Edita los datos del cliente | Recepción, Admin | `nombre`, `apellido`, `telefono`, `email` |
| DELETE | `/clientes/:id` | Elimina al cliente del sistema² | Recepción, Admin | — |
| PATCH | `/clientes/:id/portal` | Activa o desactiva el acceso al portal | Admin | `activar`, `password` |
| PATCH | `/clientes/:id/cortesia` | Canjea el servicio de cortesía | Recepción, Admin | — |
| GET | `/clientes/:id/motos` | Vehículos del cliente | Recepción, Admin | — |
| GET | `/clientes/:id/ordenes` | Historial de órdenes | Recepción, Admin | — |

² Conserva las órdenes y la facturación; se borran los datos personales y el acceso.

## Empleados · `/api/usuarios`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/usuarios` | Lista los empleados | Admin | — |
| POST | `/usuarios` | Crea un empleado | Admin | `nombre`, `email`, `password`, `rol`, `sucursal_id` |
| PUT | `/usuarios/:id` | Edita los datos del empleado | Admin | `nombre`, `email`, `rol`, `telefono` |
| PATCH | `/usuarios/:id/activo` | Activa o desactiva el acceso | Admin | `activo` |
| PATCH | `/usuarios/:id/sucursal` | Cambia la sede asignada | Admin | `sucursal_id` |
| DELETE | `/usuarios/:id` | Elimina al empleado | Admin | — |

## Motos · `/api/motos`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/motos` | Lista vehículos | Autenticado | `?cliente_id`, `?q` |
| POST | `/motos` | Registra un vehículo | Autenticado | `cliente_id`, `marca`, `modelo`, `anio`, `placa` |
| GET | `/motos/:id` | Ficha del vehículo | Autenticado | — |
| PUT | `/motos/:id` | Edita los datos | Autenticado | `marca`, `modelo`, `anio`, `placa` |
| GET | `/motos/:id/historial` | Historial de servicios | Autenticado | — |

## Recepción · `/api/recepcion`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/recepcion/resumen` | Indicadores del día | Recepción o superior | — |
| GET | `/recepcion/citas-hoy` | Citas de la jornada | Recepción o superior | — |
| GET | `/recepcion/agenda` | Citas en un rango de fechas | Recepción o superior | `?desde`, `?hasta` |
| GET | `/recepcion/alertas` | Eventos recientes del taller | Recepción o superior | — |
| POST | `/recepcion/citas/:id/crear-orden` | Genera la orden desde la cita | Recepción o superior | — |
| PATCH | `/recepcion/citas/:id/llegada` | Registra el ingreso del cliente | Recepción o superior | — |
| GET | `/recepcion/cotizaciones` | Cotizaciones pendientes o enviadas | Recepción o superior | `?estado` |
| POST | `/recepcion/cotizaciones/:id/armar` | Arma la cotización completa | Recepción o superior | `repuestos`, `costo_mano_obra`, `tecnico_id` |
| POST | `/recepcion/cotizaciones/:id/enviar` | Envía el presupuesto al cliente | Recepción o superior | — |
| POST | `/recepcion/ordenes/:id/entregar` | Cierra la orden y factura | Recepción o superior | `metodo_pago` |
| GET | `/recepcion/disponibilidad` | Cupos libres de una fecha | Recepción o superior | `?fecha` |

## Mecánico · `/api/mecanico`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/mecanico/resumen` | Indicadores del técnico | Técnico o superior | — |
| GET | `/mecanico/citas` | Sus citas asignadas | Técnico o superior | — |
| GET | `/mecanico/agenda` | Su agenda por rango | Técnico o superior | `?desde`, `?hasta` |
| PATCH | `/mecanico/citas/:id/estado` | Avanza el estado de su cita | Técnico o superior | `estado` |
| POST | `/mecanico/ordenes/:id/repuestos` | Solicita un repuesto | Técnico o superior | `nombre`, `cantidad` |
| GET | `/mecanico/tareas` | Sus tareas asignadas | Técnico o superior | — |
| PATCH | `/mecanico/tareas/:id` | Actualiza el estado de una tarea | Técnico o superior | `completada` |
| GET | `/mecanico/perfil` | Su perfil y estadísticas | Técnico o superior | — |
| PUT | `/mecanico/perfil/password` | Cambia su contraseña | Técnico o superior | `actual`, `nueva` |

## Administración · `/api/admin`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/admin/resumen` | Resumen ejecutivo | Admin | — |
| GET | `/admin/reportes` | Reportes por período | Admin | `?periodo`, `?empleado` |
| GET | `/admin/opiniones` | Calificaciones de clientes | Admin | — |
| GET | `/admin/calendario` | Vista mensual de la agenda | Admin | `?mes`, `?anio` |
| GET | `/admin/configuracion` | Configuración del taller | Admin | — |
| PUT | `/admin/configuracion` | Actualiza la configuración | Admin | `nombre_taller`, `horarios`, `notif_*` |
| GET | `/admin/servicios` | Catálogo de servicios | Admin | — |
| POST | `/admin/servicios` | Agrega un servicio | Admin | `nombre`, `precio`, `duracion` |
| GET | `/admin/sucursales` | Sedes del taller | Admin | — |
| POST | `/admin/sucursales` | Agrega una sede | Admin | `nombre`, `direccion`, `telefono` |
| POST | `/admin/tareas` | Asigna una tarea a un mecánico | Admin | `tecnico_id`, `descripcion` |
| PUT | `/admin/cuenta/password` | Cambia su contraseña | Admin | `actual`, `nueva` |

## Portal del cliente · `/api/portal`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| POST | `/portal/login` | Inicia sesión del cliente | Público | `email`, `password` |
| POST | `/portal/registro` | Auto-registro | Público | `nombre`, `apellido`, `telefono`, `email`, `cedula`, `password` |
| POST | `/portal/registro/verificar` | Confirma el correo con el código | Público | `email`, `codigo` |
| POST | `/portal/otp/solicitar` | Envía un código de acceso | Público | `email` |
| POST | `/portal/otp/verificar` | Ingresa con el código recibido | Público | `email`, `codigo` |
| POST | `/portal/recuperar/solicitar` | Envía código de recuperación | Público | `email` |
| POST | `/portal/recuperar/confirmar` | Define la contraseña nueva | Público | `email`, `codigo`, `password` |
| GET | `/portal/resumen` | Panel de inicio del cliente | Cliente | — |
| GET | `/portal/citas` | Sus citas | Cliente | — |
| POST | `/portal/citas` | Agenda una cita | Cliente | `moto_id`, `fecha`, `hora`, `tipo_servicio` |
| PATCH | `/portal/citas/:id/cancelar` | Cancela su cita | Cliente | — |
| GET | `/portal/motos` | Sus vehículos | Cliente | — |
| GET | `/portal/ordenes/:id` | Detalle de su orden | Cliente | — |
| POST | `/portal/ordenes/:id/aprobar` | Aprueba el presupuesto | Cliente | — |
| POST | `/portal/ordenes/:id/rechazar` | Rechaza el presupuesto | Cliente | `motivo` |
| GET | `/portal/notificaciones` | Sus notificaciones | Cliente | — |
| PUT | `/portal/perfil/password` | Cambia su contraseña | Cliente | `actual`, `nueva` |

## Mensajería interna · `/api/mensajeria`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/mensajeria/contactos` | Personal con su último mensaje | Recepción o superior | — |
| GET | `/mensajeria/conversacion/:usuarioId` | Hilo privado (últimos 200) | Recepción o superior | — |
| POST | `/mensajeria/conversacion/:usuarioId` | Envía un mensaje directo | Recepción o superior | `mensaje`, `foto` |
| GET | `/mensajeria/no-leidos` | Contador global de no leídos | Recepción o superior | — |
| GET | `/mensajeria/avisos` | Avisos generales del taller | Recepción o superior | — |
| POST | `/mensajeria/avisos` | Envía un aviso a los mecánicos | Recepción, Admin | `mensaje`, `foto` |
| GET | `/mensajeria/mensaje/:id/foto` | Imagen de un mensaje³ | Recepción o superior | — |
| GET | `/mensajeria/contacto/:id/foto` | Avatar de un compañero | Recepción o superior | — |

³ Solo accesible para quienes participan en esa conversación.

## Garantías · `/api/garantias`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/garantias` | Lista las garantías | Recepción o superior | `?estado` |
| POST | `/garantias` | Registra un reclamo | Recepción o superior | `orden_id`, `descripcion_problema` |
| GET | `/garantias/:id` | Detalle del reclamo | Recepción o superior | — |
| PUT | `/garantias/:id` | Actualiza estado y resolución | Recepción o superior | `estado`, `resolucion` |

## Promociones · `/api/promos`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/promos` | Lista promociones⁴ | Autenticado | — |
| POST | `/promos` | Crea una promoción | Admin | `titulo`, `descripcion`, `descuento`, `imagen` |
| GET | `/promos/:id/imagen` | Imagen de la promoción | Autenticado | — |
| PUT | `/promos/:id` | Edita la promoción | Admin | `titulo`, `descripcion`, `descuento` |

⁴ El listado devuelve `tiene_imagen`; la imagen se solicita por separado.

## Indicadores · `/api/dashboard`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/dashboard` | Indicadores operativos generales | Admin | — |
| GET | `/dashboard/flujo` | Órdenes por etapa del proceso | Admin | — |

## Métricas de experiencia · `/api/metricas`

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| POST | `/metricas/web-vitals` | Registra una métrica del navegador | Público⁵ | `metrica`, `valor`, `ruta` |
| GET | `/metricas/web-vitals` | Percentil 75 por métrica | Admin | `?dias` |

⁵ Público a propósito: las métricas más valiosas ocurren antes de iniciar sesión.

## Estado del servicio

| Método | Ruta | Descripción | Rol(es) permitido(s) | Body / parámetros |
|---|---|---|---|---|
| GET | `/health` | Verificación de salud del servicio | Público | — |
