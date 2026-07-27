#!/usr/bin/env node
// Crea (o rota) el usuario de MySQL con el que se conecta la aplicación.
//
// Hoy la app se conecta como root: si algún día se cuela una inyección SQL, el
// atacante hereda control total del servidor (leer mysql.user, crear usuarios,
// borrar tablas, tocar otras bases). Este script crea un usuario limitado a la
// base de la app y SOLO con los permisos que el código realmente usa.
//
//   node scripts/crear-usuario-app.js
//
// No cambia nada en Railway. Al terminar deja el MYSQL_URL nuevo en un archivo
// local (ignorado por git) para que lo pegues en las variables del backend.
// Si algo sale mal, root sigue funcionando igual: esto no toca al usuario actual.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { varRailway } = require('./railway-var');

const USUARIO = 'taller_app';

// Permisos derivados de lo que hace el código, no de una lista genérica:
//   SELECT/INSERT/UPDATE/DELETE  → las consultas de las rutas
//   CREATE/ALTER/INDEX/REFERENCES → auto-migrate.js (CREATE TABLE IF NOT EXISTS,
//                                   ALTER ... MODIFY/ADD COLUMN, índices y FKs)
// Queda fuera DROP a propósito: el código nunca borra tablas ni columnas, así que
// una inyección tampoco va a poder. Si una migración futura necesita DROP, el
// arranque va a fallar con "command denied" — se agrega acá y se vuelve a correr.
const PRIVILEGIOS = 'SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, REFERENCES';

const SALIDA = path.join(__dirname, '..', 'backups', 'nuevo-mysql-url.txt');

function parsear(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

// ¿La consulta falla por falta de permisos? Es lo que queremos comprobar.
async function debeFallar(conn, sql, descripcion) {
  try {
    await conn.query(sql);
    return `❌ ${descripcion}: NO fue bloqueado (el usuario tiene más permisos de los esperados)`;
  } catch (e) {
    const denegado = /denied|command denied|access denied/i.test(e.message);
    return denegado
      ? `   ✔ ${descripcion}: bloqueado`
      : `⚠️  ${descripcion}: falló con un error distinto → ${e.message}`;
  }
}

(async () => {
  console.log('🔎 Leyendo la configuración de Railway …');
  const publica = process.argv[2] || process.env.MYSQL_PUBLIC_URL || varRailway('MySQL', 'MYSQL_PUBLIC_URL');
  const interna = varRailway('MySQL', 'MYSQL_URL');

  if (!publica) {
    console.error('❌ No se pudo obtener MYSQL_PUBLIC_URL.');
    console.error('   Pasala como argumento: node scripts/crear-usuario-app.js "mysql://…"');
    process.exit(1);
  }
  if (!interna) {
    console.error('❌ No se pudo obtener MYSQL_URL (la interna) del servicio MySQL de Railway.');
    process.exit(1);
  }

  const root = parsear(publica);
  const clave = crypto.randomBytes(24).toString('base64url');   // 32 caracteres, seguros para URL

  const conn = await mysql.createConnection({ ...root, multipleStatements: false });
  console.log(`✅ Conectado como ${root.user} a ${root.host}:${root.port}/${root.database}`);

  // CREATE + ALTER: sirve tanto para crearlo la primera vez como para rotarle la clave.
  await conn.query(`CREATE USER IF NOT EXISTS ?@'%' IDENTIFIED BY ?`, [USUARIO, clave]);
  await conn.query(`ALTER USER ?@'%' IDENTIFIED BY ?`, [USUARIO, clave]);
  await conn.query(`GRANT ${PRIVILEGIOS} ON \`${root.database}\`.* TO ?@'%'`, [USUARIO]);
  await conn.query('FLUSH PRIVILEGES');
  console.log(`✅ Usuario '${USUARIO}' listo con: ${PRIVILEGIOS} sobre \`${root.database}\``);

  await conn.end();

  // ── Comprobación real: nos conectamos COMO la app y probamos qué puede y qué no.
  console.log('\n🧪 Probando el usuario nuevo …');
  const app = await mysql.createConnection({
    host: root.host, port: root.port, user: USUARIO, password: clave, database: root.database,
  });

  const [[{ n }]] = await app.query('SELECT COUNT(*) AS n FROM usuarios');
  console.log(`   ✔ Puede leer la base (usuarios: ${n})`);

  // Ojo: `information_schema` y `performance_schema` aparecen en SHOW DATABASES para
  // cualquier usuario, tenga permisos o no — verlas listadas no significa poder leerlas.
  // Por eso lo que se comprueba abajo es la lectura real, no la visibilidad.
  const [bases] = await app.query('SHOW DATABASES');
  const visibles = bases.map((b) => Object.values(b)[0]);
  console.log(`   ✔ Bases visibles: ${visibles.join(', ')}`);

  const pruebas = [
    await debeFallar(app, 'SELECT user, authentication_string FROM mysql.user LIMIT 1', 'Leer las contraseñas de mysql.user'),
    await debeFallar(app, "CREATE USER 'prueba_intruso'@'%' IDENTIFIED BY 'x'", 'Crear usuarios nuevos'),
    // Sobre una tabla inexistente a propósito: MySQL valida el permiso ANTES de la
    // existencia, así que si no tiene DROP responde "denied" sin arriesgar nada real.
    await debeFallar(app, 'DROP TABLE zzz_tabla_inexistente', 'Borrar tablas'),
    // performance_schema guarda el historial de consultas ejecutadas, con sus valores:
    // leerlo sería una filtración de datos de otras sesiones.
    await debeFallar(app, 'SELECT * FROM performance_schema.accounts LIMIT 1', 'Espiar el historial de consultas'),
  ];
  pruebas.forEach((p) => console.log(p));

  await app.end();

  const fallo = pruebas.some((p) => p.startsWith('❌'));
  if (fallo) {
    console.error('\n❌ El usuario quedó con más permisos de los que debería. No cambies nada en Railway todavía.');
    process.exit(1);
  }

  // La URL que va en el backend usa el host interno de Railway (no el proxy público).
  const u = new URL(interna);
  u.username = USUARIO;
  u.password = clave;

  fs.mkdirSync(path.dirname(SALIDA), { recursive: true });
  fs.writeFileSync(SALIDA, `MYSQL_URL=${u.toString()}\n`, { mode: 0o600 });

  console.log('\n✅ Todo en orden.');
  console.log(`   El MYSQL_URL nuevo quedó en: ${SALIDA}`);
  console.log('   (esa carpeta está ignorada por git — no se sube nunca)');
  console.log(`\n   Host interno: ${u.hostname}:${u.port}  ·  usuario: ${USUARIO}  ·  clave: ${clave.length} caracteres`);
  console.log('\n   Siguiente paso: pegar ese valor en Railway → servicio Proyecto-taller → Variables → MYSQL_URL');
  console.log('   root sigue funcionando: si algo falla, se revierte la variable y listo.');
})().catch((e) => {
  console.error('❌ Error:', e.message);
  process.exit(1);
});
