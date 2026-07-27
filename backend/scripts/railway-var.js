// Lee una variable de un servicio de Railway usando el CLI ya autenticado.
//
// Existe para que los scripts de mantenimiento no obliguen a pegar contraseñas en la
// terminal (quedan en el historial del shell y en la lista de procesos). Si el CLI no
// está instalado o el proyecto no está enlazado, devuelve null y el script que llama
// decide qué hacer.

const path = require('path');
const { execSync } = require('child_process');

function varRailway(servicio, nombre) {
  // En Windows `railway` es un .cmd, así que hay que pasar por el shell. Para que eso
  // sea seguro, los dos parámetros se limitan a nombres simples: nada de comillas,
  // espacios ni caracteres que el shell pueda interpretar.
  if (!/^[A-Za-z0-9_-]+$/.test(servicio) || !/^[A-Za-z0-9_]+$/.test(nombre)) {
    throw new Error(`Nombre de servicio o variable inválido: ${servicio} / ${nombre}`);
  }
  const raiz = path.join(__dirname, '..', '..');
  try {
    const out = execSync(`railway variables --service ${servicio} --kv`, {
      cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const linea = out.split('\n').find((l) => l.startsWith(`${nombre}=`));
    return linea ? linea.slice(nombre.length + 1).trim() : null;
  } catch {
    return null;   // sin CLI, sin sesión o sin proyecto enlazado
  }
}

module.exports = { varRailway };
