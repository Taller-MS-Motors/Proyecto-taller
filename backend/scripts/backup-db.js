#!/usr/bin/env node
// Respaldo manual de la base de producción.
//
// Railway solo ofrece backups automáticos en el plan Pro, así que este script hace
// el equivalente casero: un volcado completo con mysqldump, comprimido y con
// rotación (conserva los últimos N). Correlo cada tanto — y SIEMPRE antes de tocar
// algo delicado (migraciones, borrados masivos, cambios de esquema).
//
//   node scripts/backup-db.js
//
// La URL de la base se toma de (en este orden):
//   1. el argumento:            node scripts/backup-db.js "mysql://user:pass@host:puerto/base"
//   2. la variable BACKUP_DB_URL
//   3. la variable MYSQL_PUBLIC_URL   (la que expone Railway)
//   4. el CLI de Railway, si estás logueado (lo normal: no hay que pegar nada)
//
// Los respaldos van a backend/backups/ (ignorada por git: contienen datos reales).

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { varRailway } = require('./railway-var');

const CONSERVAR = 10;                    // cuántos respaldos se mantienen
const DIR = path.join(__dirname, '..', 'backups');

// mysqldump no siempre está en el PATH en Windows; probamos las rutas típicas.
const CANDIDATOS = [
  'mysqldump',
  'C:\\Program Files\\MySQL\\MySQL Workbench 8.0\\mysqldump.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysqldump.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe',
];

// Devuelve el primer mysqldump utilizable. Para el del PATH no alcanza con
// suponer que existe: se comprueba ejecutándolo, si no falla recién al volcar.
function buscarMysqldump() {
  for (const c of CANDIDATOS) {
    if (c === 'mysqldump') {
      const r = spawnSync(c, ['--version'], { stdio: 'ignore' });
      if (!r.error && r.status === 0) return c;
    } else if (fs.existsSync(c)) {
      return c;
    }
  }
  return null;
}

// Extrae los datos de conexión de una URL mysql://usuario:clave@host:puerto/base
function parsearUrl(url) {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port || '3306',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
  };
}

// Borra los respaldos más viejos, conservando los CONSERVAR más recientes.
function rotar() {
  const archivos = fs.readdirSync(DIR)
    .filter((f) => f.endsWith('.sql.gz'))
    .map((f) => ({ f, t: fs.statSync(path.join(DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  for (const viejo of archivos.slice(CONSERVAR)) {
    fs.unlinkSync(path.join(DIR, viejo.f));
    console.log(`   (rotación) borrado ${viejo.f}`);
  }
}

const url = process.argv[2] || process.env.BACKUP_DB_URL || process.env.MYSQL_PUBLIC_URL
  || varRailway('MySQL', 'MYSQL_PUBLIC_URL');
if (!url) {
  console.error('❌ Falta la URL de la base.');
  console.error('   Lo normal es que la lea sola del CLI de Railway: probá `railway login`.');
  console.error('   Si no, pasala como argumento o definí BACKUP_DB_URL / MYSQL_PUBLIC_URL.');
  console.error('   La encontrás en Railway → servicio MySQL → Variables → MYSQL_PUBLIC_URL');
  process.exit(1);
}

const bin = buscarMysqldump();
if (!bin) {
  console.error('❌ No se encontró mysqldump. Instalá MySQL (o MySQL Workbench) o agregalo al PATH.');
  process.exit(1);
}

const cfg = parsearUrl(url);
fs.mkdirSync(DIR, { recursive: true });

const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const destino = path.join(DIR, `${cfg.database}_${sello}.sql.gz`);

console.log(`📦 Respaldando ${cfg.database} desde ${cfg.host}:${cfg.port} …`);

// La contraseña va por variable de entorno (MYSQL_PWD) y no como argumento:
// los argumentos son visibles en la lista de procesos del sistema.
const dump = spawn(bin, [
  `--host=${cfg.host}`,
  `--port=${cfg.port}`,
  `--user=${cfg.user}`,
  '--single-transaction',      // instantánea consistente sin bloquear la operación del taller
  '--quick',
  '--routines',
  '--triggers',
  '--default-character-set=utf8mb4',
  '--no-tablespaces',          // evita pedir el privilegio PROCESS
  cfg.database,
], { env: { ...process.env, MYSQL_PWD: cfg.password } });

const salida = fs.createWriteStream(destino);
const gzip = zlib.createGzip();
dump.stdout.pipe(gzip).pipe(salida);

let errores = '';
dump.stderr.on('data', (d) => { errores += d.toString(); });

dump.on('error', (err) => {
  console.error('❌ No se pudo ejecutar mysqldump:', err.message);
  process.exit(1);
});

// Se espera a las DOS cosas: que mysqldump termine y que el archivo cierre. Los
// listeners van sueltos (no anidados) porque el orden entre ambos no está garantizado:
// anidarlos se pierde el evento si el archivo cierra antes de que salga el proceso.
let codigoDump = null;
let archivoListo = false;

function finalizar() {
  if (codigoDump === null || !archivoListo) return;   // falta una de las dos

  if (codigoDump !== 0) {
    console.error(`❌ mysqldump falló (código ${codigoDump}):`);
    console.error(errores.trim());
    if (fs.existsSync(destino)) fs.unlinkSync(destino);
    process.exit(1);
  }
  const bytes = fs.statSync(destino).size;
  const mb = (bytes / 1024 / 1024).toFixed(2);
  // Un respaldo casi vacío suele indicar que algo salió mal (permisos, base vacía).
  if (bytes < 1024) {
    console.error(`⚠️  El respaldo quedó sospechosamente chico (${mb} MB). Revisalo antes de confiar en él.`);
    if (errores.trim()) console.error(errores.trim());
    process.exit(1);
  }
  console.log(`✅ Listo: ${path.basename(destino)} (${mb} MB)`);
  if (errores.trim()) console.log(`   Avisos de mysqldump: ${errores.trim().split('\n')[0]}`);
  rotar();
  console.log(`   Guardado en: ${DIR}`);
}

dump.on('close', (code) => { codigoDump = code; finalizar(); });
salida.on('finish', () => { archivoListo = true; finalizar(); });
