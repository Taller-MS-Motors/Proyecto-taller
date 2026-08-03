#!/usr/bin/env node
// Siembra un volumen realista para las pruebas de carga.
//
// La base real del taller tiene ~30 clientes y 4,8 MB: con eso toda consulta vuela y
// una prueba de carga no encuentra nada. Este script genera el orden de magnitud al
// que la aplicación tendría que llegar para que los cuellos se noten.
//
//   node scripts/seed-carga.js "mysql://root@127.0.0.1:3307/taller_pruebas"
//
// SOLO contra una base local. Se niega a correr contra cualquier otro host: sembrar
// miles de clientes falsos en producción sería irreversible sin restaurar un respaldo.

const mysql = require('mysql2/promise');
const bcrypt = require('bcrypt');

// Cliente de prueba con acceso al portal: lo usan los escenarios E1 y E2.
const EMAIL_PRUEBA = 'cliente.carga@ejemplo.test';
const PASS_PRUEBA = 'Prueba.Carga.2026';

const N = {
  clientes: 2000,
  motos: 3000,
  citas: 5000,
  ordenes: 1500,
  promos: 30,
  // Mensajería interna: 5 000 mensajes repartidos entre el personal. La proporción
  // con foto es la que define el peso del hilo, igual que motosConFoto define el de
  // la base (el hilo devuelve 200 mensajes con la imagen embebida).
  mensajes: 5000,
  mensajesConFoto: 0.10,
  // Proporción de motos con foto. Las fotos se guardan como data URL en base64 dentro
  // de la propia tabla, así que este número es el que decide cuánto pesa la base.
  motosConFoto: 0.10,
};

const HOSTS_PERMITIDOS = ['localhost', '127.0.0.1', '::1'];

const MARCAS = ['Honda', 'Yamaha', 'Suzuki', 'Bajaj', 'KTM', 'Vespa', 'Kawasaki', 'TVS'];
const MODELOS = ['CB190R', 'FZ150', 'GN125', 'Rouser NS200', 'Duke 200', 'Primavera 150', 'XR150L', 'Apache 160'];
const NOMBRES = ['Ana', 'Luis', 'María', 'Carlos', 'Sofía', 'Diego', 'Laura', 'Jorge', 'Karla', 'Andrés'];
const APELLIDOS = ['Mora', 'Rodríguez', 'Castro', 'Solís', 'Jiménez', 'Vargas', 'Alemán', 'Rojas'];
const SERVICIOS = ['Cambio de aceite y filtros', 'Revisión completa', 'Cambio de pastillas de freno',
  'Kit de transmisión (cadena y piñones)', 'Diagnóstico electrónico', 'Cambio de neumáticos'];

const al = (a) => a[Math.floor(Math.random() * a.length)];
const entero = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

// Data URL de ~100 KB, el tamaño típico de las fotos que ya hay en producción.
function fotoFalsa() {
  return 'data:image/jpeg;base64,' + Buffer.alloc(75 * 1024, 'a').toString('base64');
}

// Fecha dentro de los últimos 2 años, en formato YYYY-MM-DD.
function fecha() {
  const d = new Date(Date.now() - entero(0, 730) * 86400000);
  return d.toISOString().slice(0, 10);
}

async function enLotes(conn, sql, filas, tam = 500) {
  for (let i = 0; i < filas.length; i += tam) {
    await conn.query(sql, [filas.slice(i, i + tam)]);
  }
}

(async () => {
  const url = process.argv[2] || process.env.SEED_DB_URL;
  if (!url) {
    console.error('❌ Falta la URL. Ej: node scripts/seed-carga.js "mysql://root@127.0.0.1:3307/taller_pruebas"');
    process.exit(1);
  }
  const u = new URL(url);
  if (!HOSTS_PERMITIDOS.includes(u.hostname)) {
    console.error(`❌ Solo contra una base local. Host recibido: ${u.hostname}`);
    console.error('   Sembrar miles de registros falsos en un servidor real no se deshace sin restaurar un respaldo.');
    process.exit(1);
  }

  const conn = await mysql.createConnection({
    host: u.hostname, port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  });
  console.log(`🌱 Sembrando en ${u.hostname}:${u.port}${u.pathname} …`);
  const t0 = Date.now();

  // Clientes. Uno de cada diez con acceso al portal (hash fijo: no se usa para entrar,
  // solo para que la columna no quede vacía y las consultas midan lo mismo).
  const hash = '$2b$10$abcdefghijklmnopqrstuvwxyz012345678901234567890123456789';
  const clientes = Array.from({ length: N.clientes }, (_, i) => [
    al(NOMBRES), al(APELLIDOS), `8${entero(1000000, 9999999)}`,
    `cliente${i}@ejemplo.test`, String(entero(100000000, 899999999)),
    i % 10 === 0 ? hash : null,
  ]);
  await enLotes(conn, 'INSERT INTO clientes (nombre, apellido, telefono, email, cedula, password_hash) VALUES ?', clientes);

  // Un cliente con contraseña REAL. Los 2000 de arriba llevan un hash de relleno que no
  // sirve para entrar, así que sin este los escenarios del portal (E1 y E2 de
  // escenarios.js) no tendrían con quién iniciar sesión.
  const hashReal = await bcrypt.hash(PASS_PRUEBA, 10);
  await conn.query(
    `INSERT INTO clientes (nombre, apellido, telefono, email, cedula, password_hash)
     VALUES ('Cliente', 'Carga', '80000000', ?, '999999999', ?)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash)`,
    [EMAIL_PRUEBA, hashReal]
  );
  const [[{ idPortal }]] = await conn.query('SELECT id AS idPortal FROM clientes WHERE email = ?', [EMAIL_PRUEBA]);

  const [[{ minCliente }]] = await conn.query('SELECT MIN(id) AS minCliente FROM clientes');
  const [[{ maxCliente }]] = await conn.query('SELECT MAX(id) AS maxCliente FROM clientes');
  console.log(`   clientes: ${N.clientes} (+1 con portal: ${EMAIL_PRUEBA})`);

  // Motos. Solo una fracción lleva foto: son ~100 KB cada una y definen el peso real.
  const motos = Array.from({ length: N.motos }, () => [
    entero(minCliente, maxCliente), al(MARCAS), al(MODELOS), entero(2010, 2026),
    `${al('ABCDEFGH')}${entero(100000, 999999)}`,
    Math.random() < N.motosConFoto ? fotoFalsa() : null,
  ]);
  await enLotes(conn, 'INSERT INTO motos (cliente_id, marca, modelo, anio, placa, foto) VALUES ?', motos, 100);

  // El cliente del portal necesita su propia moto: las de arriba se reparten al azar
  // y podría quedarse sin ninguna, y sin moto el escenario E1 no puede agendar.
  await conn.query(
    `INSERT INTO motos (cliente_id, marca, modelo, anio, placa)
     VALUES (?, 'Honda', 'CB 190R', 2024, 'CARGA01')
     ON DUPLICATE KEY UPDATE cliente_id = VALUES(cliente_id)`,
    [idPortal]
  );

  const [[{ minMoto }]] = await conn.query('SELECT MIN(id) AS minMoto FROM motos');
  const [[{ maxMoto }]] = await conn.query('SELECT MAX(id) AS maxMoto FROM motos');
  console.log(`   motos: ${N.motos} (${Math.round(N.motos * N.motosConFoto)} con foto)`);

  const estados = ['agendado', 'en_revision', 'en_mantenimiento', 'listo', 'entregado', 'cancelado'];
  const citas = Array.from({ length: N.citas }, () => [
    entero(minCliente, maxCliente), entero(minMoto, maxMoto), fecha(),
    `${String(entero(8, 16)).padStart(2, '0')}:00:00`,
    al(SERVICIOS), al(SERVICIOS), al(estados), entero(15000, 250000),
  ]);
  await enLotes(conn, 'INSERT INTO citas (cliente_id, moto_id, fecha, hora, motivo, tipo_servicio, estado, monto) VALUES ?', citas);
  console.log(`   citas: ${N.citas}`);

  // Los del ENUM real de la tabla — 'lista_entrega', no 'lista'.
  const estadosOrden = ['recepcion', 'diagnostico', 'esperando_aprobacion', 'esperando_repuestos',
    'en_reparacion', 'lista_entrega', 'entregada', 'cancelada'];
  const ordenes = Array.from({ length: N.ordenes }, (_, i) => [
    `OT-2026-${String(i + 1).padStart(5, '0')}`, entero(minMoto, maxMoto), entero(minCliente, maxCliente),
    al(['No enciende', 'Ruido al frenar', 'Cadena floja', 'Se ahoga en ralentí', 'Luz de tablero encendida']),
    al(estadosOrden), entero(10000, 300000), entero(0, 150000),
  ]);
  await enLotes(conn, 'INSERT INTO ordenes_trabajo (numero_orden, moto_id, cliente_id, problema_reportado, estado, costo_mano_obra, costo_repuestos) VALUES ?', ordenes);
  console.log(`   órdenes: ${N.ordenes}`);

  // Promociones CON imagen: es el caso que hace pesada la respuesta del panel.
  const promos = Array.from({ length: N.promos }, (_, i) => [
    `Promoción ${i + 1}`, 'Descripción de la promoción de prueba.', entero(5, 50), fotoFalsa(), 1,
  ]);
  await enLotes(conn, 'INSERT INTO promos (titulo, descripcion, descuento, imagen, activa) VALUES ?', promos, 20);
  console.log(`   promos: ${N.promos} (todas con imagen)`);

  // Mensajería interna. Hasta ahora no se sembraba y el módulo quedaba sin medir,
  // pese a ser el que más se parece al caso de las promos: el hilo devuelve los
  // últimos 200 mensajes CON su foto embebida, y el frontend lo repite cada 12 s.
  // Se reparten entre los empleados existentes, en pares, para que las consultas
  // por conversación tengan volumen real que recorrer.
  const [empleados] = await conn.query('SELECT id FROM usuarios WHERE activo = 1');
  if (empleados.length >= 2) {
    const ids = empleados.map((u) => u.id);
    const mensajes = Array.from({ length: N.mensajes }, () => {
      const a = al(ids);
      let b = al(ids);
      while (b === a && ids.length > 1) b = al(ids);
      return [a, b, `Mensaje de prueba ${entero(1, 999999)}`, 'directo',
        Math.random() < N.mensajesConFoto ? fotoFalsa() : null];
    });
    await enLotes(conn, 'INSERT INTO mensajes_internos (remitente_id, destino_id, mensaje, tipo, foto) VALUES ?', mensajes, 100);
    console.log(`   mensajes: ${N.mensajes} (${Math.round(N.mensajes * N.mensajesConFoto)} con foto)`);
  } else {
    console.log('   mensajes: omitidos (hacen falta al menos 2 empleados activos)');
  }

  const [[tam]] = await conn.query(
    "SELECT ROUND(SUM(DATA_LENGTH+INDEX_LENGTH)/1024/1024,1) mb FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE()"
  );
  console.log(`\n✅ Listo en ${((Date.now() - t0) / 1000).toFixed(1)}s — la base pesa ahora ${tam.mb} MB`);
  await conn.end();
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
