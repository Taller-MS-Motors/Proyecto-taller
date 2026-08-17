// Dónde dejó npx las dependencias de Lighthouse.
//
// Los scripts de medición (lighthouse-auth.mjs, medir-inp.mjs) usan `puppeteer-core` y
// `lighthouse`, que ya vienen con la instalación que hace `npx lighthouse`. Se resuelven
// desde ahí a propósito: son herramientas de medición, no dependencias de la aplicación,
// y no tienen por qué engordar el `package.json` del proyecto.
//
// El problema es que npx guarda cada paquete en `<cache>/_npx/<hash>/`, y ese hash cambia
// de equipo a equipo. Escribir la ruta fija hace que el script solo corra en la máquina
// donde se escribió. Acá se busca: se recorren las ubicaciones habituales del caché de npm
// y se devuelve la primera carpeta que realmente tenga instalado lo que hace falta.

import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

// Raíces posibles del caché de npm, en orden de confianza:
//   · lo que diga npm (si el script se lanzó por `npm run`),
//   · el valor por defecto en Windows,
//   · el valor por defecto en Linux y macOS.
function raicesCache() {
  const raices = [];
  if (process.env.npm_config_cache) raices.push(process.env.npm_config_cache);
  const local = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
  raices.push(join(local, 'npm-cache'));
  raices.push(join(homedir(), '.npm'));
  return raices;
}

/**
 * Devuelve la ruta del `_npx/<hash>/` que contiene los paquetes pedidos.
 * `NPX_CACHE` la fuerza a mano, por si el caché está en un lugar poco común.
 *
 * @param {string[]} paquetes Los que tienen que estar presentes (p. ej. puppeteer-core).
 */
export function rutaNpx(paquetes = ['puppeteer-core', 'lighthouse']) {
  if (process.env.NPX_CACHE) return process.env.NPX_CACHE;

  for (const raiz of raicesCache()) {
    const npx = join(raiz, '_npx');
    if (!existsSync(npx)) continue;
    for (const hash of readdirSync(npx)) {
      const mods = join(npx, hash, 'node_modules');
      if (paquetes.every((p) => existsSync(join(mods, p)))) return join(npx, hash) + '/';
    }
  }

  // Sin esto el fallo aparecería más adelante como un críptico "Cannot find module".
  console.error(
    `No se encontró la instalación de npx con ${paquetes.join(' y ')}.\n` +
    'Instalalos con una corrida de Lighthouse:\n' +
    '  npx lighthouse --version\n' +
    'o indicá la carpeta a mano:\n' +
    '  NPX_CACHE="/ruta/al/cache/_npx/<hash>/" node pruebas-carga/<script>.mjs'
  );
  process.exit(1);
}
