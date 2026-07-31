// Pool de conexiones a MySQL usando mysql2/promise.
// Soporta la variable MYSQL_URL (Railway) o variables individuales DB_* (local).
const mysql = require('mysql2/promise');
require('dotenv').config();

// Presupuesto TOTAL de conexiones, repartido entre los workers. Cada proceso abre su
// propio pool, así que sin dividir, 4 workers × 10 abrirían 40 y el número real se
// escaparía sin que nadie lo note (MySQL corta en max_connections y las peticiones
// empiezan a fallar con un error que no dice nada de esto).
const TOTAL_CONEXIONES = Number(process.env.DB_POOL_TOTAL) || 40;
const WORKERS = Math.max(1, Number(process.env.WEB_CONCURRENCY) || 1);
const POR_PROCESO = Math.max(4, Math.floor(TOTAL_CONEXIONES / WORKERS));

function buildConfig() {
  // Railway inyecta MYSQL_URL con el formato:
  // mysql://user:password@host:port/database
  if (process.env.MYSQL_URL) {
    return { uri: process.env.MYSQL_URL, waitForConnections: true, connectionLimit: POR_PROCESO };
  }
  return {
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'proyecto_taller',
    waitForConnections: true,
    connectionLimit: POR_PROCESO,
  };
}

const pool = mysql.createPool(buildConfig());

async function testConnection() {
  try {
    const conn = await pool.getConnection();
    await conn.ping();
    conn.release();
    const db = process.env.MYSQL_URL ? '(via MYSQL_URL)' : `${process.env.DB_HOST}:${process.env.DB_PORT}/${process.env.DB_NAME}`;
    console.log(`✅ MySQL conectado ${db}`);
  } catch (err) {
    console.error('❌ No se pudo conectar a MySQL:', err.code || err.message);
  }
}

module.exports = { pool, testConnection };
