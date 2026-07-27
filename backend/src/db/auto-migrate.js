// Migraciones idempotentes que corren al arrancar el servidor.
// Seguras de ejecutar en cada deploy: solo aplican el cambio si falta.
const { pool } = require('./pool');

async function ensureSchema() {
  try {
    // orden_fotos.url debe ser MEDIUMTEXT para guardar imágenes base64 (data URL).
    // En esquemas viejos era VARCHAR(500) y truncaba las fotos.
    const [[col]] = await pool.query(
      `SELECT DATA_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orden_fotos' AND COLUMN_NAME = 'url'`
    );
    if (col && col.DATA_TYPE.toLowerCase() !== 'mediumtext') {
      await pool.query('ALTER TABLE orden_fotos MODIFY COLUMN url MEDIUMTEXT NOT NULL');
      console.log('🔧 Migración: orden_fotos.url → MEDIUMTEXT');
    }

    // Tablas del módulo de garantías (idempotente, no borra datos).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS garantias (
        id                   INT AUTO_INCREMENT PRIMARY KEY,
        orden_id             INT NOT NULL,
        descripcion_problema TEXT NOT NULL,
        cubre_repuestos      TINYINT(1) DEFAULT 0,
        cubre_mano_obra      TINYINT(1) DEFAULT 0,
        estado               ENUM('abierto','en_revision','aprobado','rechazado','resuelto') NOT NULL DEFAULT 'abierto',
        resolucion           TEXT,
        creado_por           INT,
        created_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (orden_id)   REFERENCES ordenes_trabajo(id),
        FOREIGN KEY (creado_por) REFERENCES usuarios(id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS garantia_fotos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        garantia_id INT NOT NULL,
        url         MEDIUMTEXT NOT NULL,
        descripcion VARCHAR(200),
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (garantia_id) REFERENCES garantias(id)
      )
    `);

    // Portal del cliente: contraseña opcional para acceso al seguimiento.
    await addColumnIfMissing('clientes', 'password_hash', 'VARCHAR(255) NULL');

    // Fotos del portal (data URL base64, igual que orden_fotos/promos): avatar del
    // cliente y foto de cada moto. MEDIUMTEXT aguanta imágenes comprimidas (~16 MB máx).
    await addColumnIfMissing('clientes', 'foto', 'MEDIUMTEXT NULL');
    await addColumnIfMissing('motos', 'foto', 'MEDIUMTEXT NULL');

    // Preferencias de notificación por cliente (el cliente decide si quiere recibirlas).
    // notif_avances: avisos de cambio de estado de sus servicios (aplicado hoy).
    // notif_recordatorios: recordatorio antes de la cita (se persiste; el envío aún no existe).
    await addColumnIfMissing('clientes', 'notif_avances', 'TINYINT(1) NOT NULL DEFAULT 1');
    await addColumnIfMissing('clientes', 'notif_recordatorios', 'TINYINT(1) NOT NULL DEFAULT 1');

    // Códigos de recuperación de contraseña (olvidé mi contraseña) enviados por correo.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS password_reset_codes (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        cliente_id INT NOT NULL,
        code_hash  VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        used       TINYINT(1) DEFAULT 0,
        attempts   INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cliente (cliente_id),
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
      )
    `);

    // Códigos de ingreso sin contraseña (OTP por correo) para el portal del cliente.
    // Misma forma y garantías que password_reset_codes (hash, expiración, intentos,
    // un solo uso), pero en tabla aparte para no interferir con el flujo de reset.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS login_codes (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        cliente_id INT NOT NULL,
        code_hash  VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        used       TINYINT(1) DEFAULT 0,
        attempts   INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_login_cliente (cliente_id),
        FOREIGN KEY (cliente_id) REFERENCES clientes(id)
      )
    `);

    // Aprobación digital del presupuesto por parte del cliente.
    await addColumnIfMissing(
      'ordenes_trabajo', 'aprobacion_cliente',
      "ENUM('pendiente','aprobado','rechazado') NOT NULL DEFAULT 'pendiente'"
    );
    await addColumnIfMissing('ordenes_trabajo', 'motivo_rechazo', 'TEXT NULL');

    // Encuesta de satisfacción del cliente al entregar.
    await addColumnIfMissing('ordenes_trabajo', 'calificacion', 'TINYINT NULL');
    await addColumnIfMissing('ordenes_trabajo', 'comentario_satisfaccion', 'TEXT NULL');

    // Contador atómico por año para numero_orden (evita la condición de carrera de COUNT(*)).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS orden_contadores (
        anio   INT PRIMARY KEY,
        ultimo INT NOT NULL DEFAULT 0
      )
    `);
    // Siembra el contador con el último correlativo ya usado por año (idempotente).
    await pool.query(`
      INSERT IGNORE INTO orden_contadores (anio, ultimo)
      SELECT YEAR(created_at), COUNT(*) FROM ordenes_trabajo GROUP BY YEAR(created_at)
    `);

    // Promociones (marketing).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS promos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        titulo      VARCHAR(150) NOT NULL,
        descripcion TEXT NOT NULL,
        descuento   INT DEFAULT 0,
        activa      TINYINT(1) DEFAULT 1,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Fidelización: visitas del cliente y cortesía disponible cada N entregas.
    await addColumnIfMissing('clientes', 'visitas', 'INT DEFAULT 0');
    await addColumnIfMissing('clientes', 'cortesia_disponible', 'TINYINT(1) DEFAULT 0');
    await addColumnIfMissing('ordenes_trabajo', 'visita_contada', 'TINYINT(1) DEFAULT 0');

    // Historial de cortesías canjeadas: registra cada vez que el taller aplica una
    // cortesía a un cliente (quién, cuándo, sobre qué orden). El cliente lo ve en el portal.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS recompensas_canjeadas (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        cliente_id   INT NOT NULL,
        orden_id     INT NULL,
        aplicado_por INT NULL,
        descripcion  VARCHAR(150) NOT NULL DEFAULT 'Servicio de cortesía',
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_rc_cliente (cliente_id),
        FOREIGN KEY (cliente_id)   REFERENCES clientes(id),
        FOREIGN KEY (aplicado_por) REFERENCES usuarios(id)
      )
    `);

    // Panel del mecánico: la cita es la unidad de trabajo del técnico.
    await addColumnIfMissing('citas', 'tecnico_id', 'INT NULL');
    await addColumnIfMissing('citas', 'tipo_servicio', 'VARCHAR(100) NULL');
    await addColumnIfMissing('citas', 'monto', 'DECIMAL(10,2) DEFAULT 0');
    await addColumnIfMissing('citas', 'calificacion', 'TINYINT NULL');
    await addColumnIfMissing('citas', 'comentario_satisfaccion', 'TEXT NULL');
    await addColumnIfMissing('citas', 'fecha_inicio', 'TIMESTAMP NULL');
    await addColumnIfMissing('citas', 'fecha_fin', 'TIMESTAMP NULL');
    // El cliente confirma que asistirá a su cita agendada (señal de no-show para el taller).
    await addColumnIfMissing('citas', 'confirmada_cliente', 'TINYINT(1) DEFAULT 0');
    // Check-in en mostrador: momento en que el cliente llegó al taller (antes de crear la orden).
    await addColumnIfMissing('citas', 'hora_llegada', 'DATETIME NULL');
    await addColumnIfMissing('citas', 'fecha_listo', 'TIMESTAMP NULL');

    // Automatización (jobs programados):
    // recordatorio_enviado: idempotencia del job de recordatorios (1 = ya se avisó de esta cita).
    // no_show: el job diario marca las citas vencidas nunca atendidas (no las cancela ni borra).
    await addColumnIfMissing('citas', 'recordatorio_enviado', 'TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing('citas', 'no_show', 'TINYINT(1) NOT NULL DEFAULT 0');
    // Cancelación hecha por el cliente desde el portal: sin esto el taller no se
    // enteraba (la cita simplemente desaparecía de la agenda). Alimenta la alerta
    // 'cita_cancelada' de recepción.
    await addColumnIfMissing('citas', 'fecha_cancelacion', 'DATETIME NULL');

    // Nuevos estados de la cita (flujo que ve el cliente en el portal).
    // Idempotente: solo migra si el enum todavía tiene los estados viejos.
    const [[citaEstado]] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'citas' AND COLUMN_NAME = 'estado'`
    );
    if (citaEstado && citaEstado.COLUMN_TYPE.includes('pendiente')) {
      await pool.query('ALTER TABLE citas MODIFY COLUMN estado VARCHAR(20)');
      await pool.query(`
        UPDATE citas SET estado = CASE estado
          WHEN 'pendiente'  THEN 'agendado'
          WHEN 'confirmada' THEN 'agendado'
          WHEN 'completada' THEN 'entregado'
          WHEN 'cancelada'  THEN 'cancelado'
          ELSE estado END
      `);
      await pool.query(`
        ALTER TABLE citas MODIFY COLUMN estado
          ENUM('agendado','en_revision','en_mantenimiento','listo','entregado','cancelado')
          NOT NULL DEFAULT 'agendado'
      `);
      console.log('🔧 Migración: citas.estado → nuevo flujo del mecánico');
    }

    // Portal v2: feed de notificaciones de avance para el cliente.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS notificaciones (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        cliente_id INT NOT NULL,
        cita_id    INT,
        titulo     VARCHAR(150) NOT NULL,
        mensaje    VARCHAR(255) NOT NULL,
        leida      TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_cliente (cliente_id),
        FOREIGN KEY (cliente_id) REFERENCES clientes(id),
        FOREIGN KEY (cita_id)    REFERENCES citas(id)
      )
    `);
    // Tipo de evento (icono/color en el portal) e índice para el contador de no leídas.
    await addColumnIfMissing('notificaciones', 'tipo', "VARCHAR(30) NOT NULL DEFAULT 'estado'");
    await crearIndiceSiFalta('notificaciones', 'idx_cliente_leida', '(cliente_id, leida)');

    // Ofertas con imagen (data URL base64).
    await addColumnIfMissing('promos', 'imagen', 'MEDIUMTEXT NULL');
    // Precio final de la oferta (lo fija el admin; opcional, para mostrar en el portal).
    await addColumnIfMissing('promos', 'precio_final', 'INT NULL');

    // Puente cita ↔ orden: una cita puede generar/enlazar una orden de trabajo.
    await addColumnIfMissing('citas', 'orden_id', 'INT NULL');
    await crearIndiceSiFalta('citas', 'idx_citas_orden', '(orden_id)');

    // Índice (fecha,hora) en citas: acelera la disponibilidad y permite que el
    // bloqueo de rango (FOR UPDATE) del control de cupo sea preciso.
    await crearIndiceSiFalta('citas', 'idx_citas_fecha_hora', '(fecha, hora)');

    // Placa única a nivel de base (no solo en la app). Columna generada normalizada
    // (sin espacios/guiones, mayúsculas) + índice único. Se guarda cada paso por
    // separado para que, si hay placas duplicadas heredadas, el índice falle sin
    // abortar el resto de la migración (la validación de la app sigue cubriendo).
    await tryStep('motos.placa_norm', () =>
      addColumnIfMissing(
        'motos', 'placa_norm',
        "VARCHAR(32) AS (UPPER(REPLACE(REPLACE(placa,' ',''),'-',''))) STORED"
      )
    );
    await tryStep('uq_motos_placa_norm', () =>
      crearIndiceSiFalta('motos', 'uq_motos_placa_norm', '(placa_norm)', { unico: true })
    );

    // Panel del mecánico v2: perfil profesional (lo edita el propio técnico).
    await addColumnIfMissing('usuarios', 'telefono', 'VARCHAR(20) NULL');
    await addColumnIfMissing('usuarios', 'especialidades', 'VARCHAR(300) NULL');
    await addColumnIfMissing('usuarios', 'horario', 'VARCHAR(200) NULL');
    // Foto de perfil del personal (data URL base64, igual que clientes.foto).
    await addColumnIfMissing('usuarios', 'foto', 'MEDIUMTEXT NULL');

    // Tareas del mecánico: checklist propio + asignadas por el admin (Fase C).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS tareas_mecanico (
        id           INT AUTO_INCREMENT PRIMARY KEY,
        tecnico_id   INT NOT NULL,
        titulo       VARCHAR(150) NOT NULL,
        detalle      VARCHAR(300),
        prioridad    ENUM('baja','normal','alta','urgente') NOT NULL DEFAULT 'normal',
        hecha        TINYINT(1) DEFAULT 0,
        asignado_por INT,
        vence        DATETIME NULL,
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_tarea_tecnico (tecnico_id),
        FOREIGN KEY (tecnico_id)   REFERENCES usuarios(id),
        FOREIGN KEY (asignado_por) REFERENCES usuarios(id)
      )
    `);
    // Fase C en bases existentes: origen (quién la asignó), vencimiento y prioridad ampliada.
    await addColumnIfMissing('tareas_mecanico', 'asignado_por', 'INT NULL');
    await addColumnIfMissing('tareas_mecanico', 'vence', 'DATETIME NULL');
    // Amplía prioridad a 4 niveles conservando los valores viejos (normal/alta), sin perder datos.
    const [[tareaPrio]] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tareas_mecanico' AND COLUMN_NAME = 'prioridad'`
    );
    if (tareaPrio && !tareaPrio.COLUMN_TYPE.includes('urgente')) {
      await pool.query(
        "ALTER TABLE tareas_mecanico MODIFY COLUMN prioridad ENUM('baja','normal','alta','urgente') NOT NULL DEFAULT 'normal'"
      );
      console.log('🔧 Migración: tareas_mecanico.prioridad → 4 niveles');
    }

    // Roles simplificados: se eliminan jefe_taller y gerencia (todo se consolida en admin).
    // 1) Remapear usuarios existentes ANTES de achicar el enum (para no perder filas).
    await tryStep('remap roles a admin', () =>
      pool.query("UPDATE usuarios SET rol = 'admin' WHERE rol IN ('jefe_taller', 'gerencia')")
    );
    // 2) Achicar el enum solo si todavía tiene los valores viejos (idempotente).
    const [[rolCol]] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'usuarios' AND COLUMN_NAME = 'rol'`
    );
    if (rolCol && (rolCol.COLUMN_TYPE.includes('jefe_taller') || rolCol.COLUMN_TYPE.includes('gerencia'))) {
      await tryStep('achicar enum rol', async () => {
        await pool.query(
          "ALTER TABLE usuarios MODIFY COLUMN rol ENUM('recepcion','tecnico','admin') NOT NULL DEFAULT 'tecnico'"
        );
        console.log('🔧 Migración: roles → recepcion/tecnico/admin');
      });
    }

    // Mensajería interna mecánico ↔ recepción.
    // destino_rol agrupa por rol (p. ej. mensaje "a recepción"); destino_id apunta
    // a un usuario puntual (p. ej. la respuesta de recepción a un técnico).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensajes_internos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        remitente_id INT NOT NULL,
        destino_rol VARCHAR(20),
        destino_id  INT,
        mensaje     VARCHAR(500) NOT NULL,
        leido       TINYINT(1) DEFAULT 0,
        created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_msg_remitente (remitente_id),
        INDEX idx_msg_destino (destino_id),
        FOREIGN KEY (remitente_id) REFERENCES usuarios(id),
        FOREIGN KEY (destino_id)   REFERENCES usuarios(id)
      )
    `);

    // Configuración del taller (fila única id=1): datos del negocio, horarios de
    // atención, capacidad de la agenda y preferencias de notificación. El portal
    // lee de aquí los cupos/horas (antes hardcodeados en utils/servicios.js).
    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracion (
        id                  TINYINT PRIMARY KEY,
        nombre_taller       VARCHAR(150),
        telefono            VARCHAR(40),
        email               VARCHAR(120),
        direccion           VARCHAR(200),
        logo                LONGTEXT,
        max_citas_hora      INT DEFAULT 2,
        dias_anticipacion   INT DEFAULT 30,
        duracion_cita_min   INT DEFAULT 90,
        horarios            JSON,
        notif_estado        TINYINT(1) DEFAULT 1,
        notif_recordatorio  TINYINT(1) DEFAULT 1,
        notif_cotizacion    TINYINT(1) DEFAULT 1,
        notif_email_entrega TINYINT(1) DEFAULT 0,
        updated_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    // Ventana mínima (horas) para que el cliente cancele/reprograme su cita.
    await addColumnIfMissing('configuracion', 'cancelacion_horas_min', 'INT DEFAULT 2');
    await addColumnIfMissing('configuracion', 'visitas_para_cortesia', 'INT DEFAULT 7');
    await addColumnIfMissing('configuracion', 'zona_horaria_offset', 'INT DEFAULT -6');
    // Siembra la fila única con valores por defecto (idempotente: INSERT IGNORE).
    // Horarios: 0=Dom … 6=Sáb. L-V 08-17, Sáb 08-13, Dom cerrado.
    await tryStep('seed configuracion', () =>
      pool.query(
        `INSERT IGNORE INTO configuracion
           (id, nombre_taller, telefono, email, direccion,
            max_citas_hora, dias_anticipacion, duracion_cita_min, horarios)
         VALUES (1, 'MS Motos', '', '', '', 2, 30, 90, ?)`,
        [JSON.stringify([
          { dia: 0, abre: '08:00', cierra: '13:00', activo: 0 },
          { dia: 1, abre: '08:00', cierra: '17:00', activo: 1 },
          { dia: 2, abre: '08:00', cierra: '17:00', activo: 1 },
          { dia: 3, abre: '08:00', cierra: '17:00', activo: 1 },
          { dia: 4, abre: '08:00', cierra: '17:00', activo: 1 },
          { dia: 5, abre: '08:00', cierra: '17:00', activo: 1 },
          { dia: 6, abre: '08:00', cierra: '13:00', activo: 1 },
        ])]
      )
    );

    // Sucursales (locales del taller). El sistema pasa de single-local a multi-local:
    // la cita, la orden y el personal se asocian a una sucursal. Se siembran Liberia y
    // Cañas con ids fijos para poder rellenar los datos viejos de forma determinista.
    // Orden importante: crear+sembrar la tabla ANTES de las columnas y el backfill.
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sucursales (
        id         INT AUTO_INCREMENT PRIMARY KEY,
        nombre     VARCHAR(100) NOT NULL,
        direccion  VARCHAR(200),
        telefono   VARCHAR(40),
        activa     TINYINT(1) DEFAULT 1,
        orden      INT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
    await tryStep('seed sucursales', () =>
      pool.query("INSERT IGNORE INTO sucursales (id, nombre, orden) VALUES (1, 'Liberia', 1), (2, 'Cañas', 2)")
    );

    // Columna sucursal_id (sin FK aquí, igual que citas.tecnico_id/orden_id; las FK van
    // solo en schema.sql para instalación limpia). NULL en usuarios = "atiende ambas".
    await addColumnIfMissing('citas', 'sucursal_id', 'INT NULL');
    await addColumnIfMissing('ordenes_trabajo', 'sucursal_id', 'INT NULL');
    await addColumnIfMissing('usuarios', 'sucursal_id', 'INT NULL');
    // Backfill: las citas y órdenes históricas quedan en Liberia (id=1).
    await tryStep('backfill citas.sucursal_id', () =>
      pool.query('UPDATE citas SET sucursal_id = 1 WHERE sucursal_id IS NULL')
    );
    await tryStep('backfill ordenes.sucursal_id', () =>
      pool.query('UPDATE ordenes_trabajo SET sucursal_id = 1 WHERE sucursal_id IS NULL')
    );
    // Índice por (sucursal, fecha, hora): hace preciso el bloqueo FOR UPDATE del cupo por local.
    await crearIndiceSiFalta('citas', 'idx_citas_sucursal_fecha_hora', '(sucursal_id, fecha, hora)');

    // Repuestos: agregar estado 'solicitado' para que el mecánico pida piezas sin precio.
    const [[repEstado]] = await pool.query(
      `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orden_repuestos' AND COLUMN_NAME = 'estado'`
    );
    if (repEstado && !repEstado.COLUMN_TYPE.includes('solicitado')) {
      await pool.query(
        "ALTER TABLE orden_repuestos MODIFY COLUMN estado ENUM('disponible','pendiente','pedido_especial','solicitado') DEFAULT 'pendiente'"
      );
      console.log('🔧 Migración: orden_repuestos.estado → +solicitado');
    }

    // Mensajería interna v2: foto, vínculo a orden y soporte de broadcast.
    await addColumnIfMissing('mensajes_internos', 'foto', 'MEDIUMTEXT NULL');
    await addColumnIfMissing('mensajes_internos', 'orden_id', 'INT NULL');
    await addColumnIfMissing('mensajes_internos', 'tipo', "VARCHAR(20) NOT NULL DEFAULT 'directo'");

    // Mensajería interna v3: sucursal (para filtrar por sede) y lectura POR USUARIO.
    // Antes `leido` era global por mensaje: al abrir la bandeja se marcaba leído para
    // todo el rol, así que el badge de "no leído" no era confiable entre personas.
    await addColumnIfMissing('mensajes_internos', 'sucursal_id', 'INT NULL');
    await crearIndiceSiFalta('mensajes_internos', 'idx_msg_sucursal', '(sucursal_id)');
    await pool.query(`
      CREATE TABLE IF NOT EXISTS mensaje_lecturas (
        mensaje_id INT NOT NULL,
        usuario_id INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (mensaje_id, usuario_id),
        INDEX idx_ml_usuario (usuario_id)
      )`);

    // Mensajería v4 (chat 1:1 estilo WhatsApp): índices para leer hilos por par
    // de usuarios y bandejas por destinatario sin escanear la tabla.
    await crearIndiceSiFalta('mensajes_internos', 'idx_msg_par', '(remitente_id, destino_id, created_at)');
    await crearIndiceSiFalta('mensajes_internos', 'idx_msg_destino_created', '(destino_id, created_at)');

    // El listado de clientes filtra por activo y ordena por nombre/apellido: sin este
    // índice MySQL escanea la tabla entera y hace filesort en cada carga del módulo.
    await crearIndiceSiFalta('clientes', 'idx_clientes_activo_nombre', '(activo, nombre, apellido)');

    // FK constraints en columnas agregadas por addColumnIfMissing (integridad referencial).
    await tryStep('fk citas.tecnico_id', () => addFkIfMissing('citas', 'fk_citas_tecnico', 'tecnico_id', 'usuarios', 'id'));
    await tryStep('fk citas.orden_id', () => addFkIfMissing('citas', 'fk_citas_orden', 'orden_id', 'ordenes_trabajo', 'id'));
    await tryStep('fk citas.sucursal_id', () => addFkIfMissing('citas', 'fk_citas_sucursal', 'sucursal_id', 'sucursales', 'id'));
    await tryStep('fk ordenes.sucursal_id', () => addFkIfMissing('ordenes_trabajo', 'fk_ordenes_sucursal', 'sucursal_id', 'sucursales', 'id'));
    await tryStep('fk usuarios.sucursal_id', () => addFkIfMissing('usuarios', 'fk_usuarios_sucursal', 'sucursal_id', 'sucursales', 'id'));
  } catch (err) {
    console.error('⚠️  Auto-migración falló:', err.code || err.message);
  }
}

// Ejecuta un paso aislado: si falla, lo loguea y sigue (no aborta la migración).
async function tryStep(label, fn) {
  try {
    await fn();
  } catch (err) {
    console.error(`⚠️  Migración (${label}) omitida:`, err.code || err.message);
  }
}

// Crea un índice solo si no existe (idempotente). `opts.unico` para índice único.
async function crearIndiceSiFalta(tabla, nombre, columnas, { unico = false } = {}) {
  const [[existe]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?`,
    [tabla, nombre]
  );
  if (!existe.n) {
    await pool.query(`CREATE ${unico ? 'UNIQUE ' : ''}INDEX ${nombre} ON ${tabla} ${columnas}`);
    console.log(`🔧 Migración: índice ${nombre} en ${tabla} creado`);
  }
}

// Agrega una columna solo si no existe (idempotente, no destructivo).
async function addColumnIfMissing(tabla, columna, definicion) {
  const [[existe]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [tabla, columna]
  );
  if (!existe.n) {
    await pool.query(`ALTER TABLE ${tabla} ADD COLUMN ${columna} ${definicion}`);
    console.log(`🔧 Migración: ${tabla}.${columna} agregada`);
  }
}

async function addFkIfMissing(tabla, fkName, columna, refTabla, refColumna) {
  const [[existe]] = await pool.query(
    `SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
    [tabla, fkName]
  );
  if (!existe.n) {
    await pool.query(`ALTER TABLE ${tabla} ADD CONSTRAINT ${fkName} FOREIGN KEY (${columna}) REFERENCES ${refTabla}(${refColumna})`);
    console.log(`🔧 Migración: FK ${fkName} en ${tabla} creada`);
  }
}

module.exports = { ensureSchema };
