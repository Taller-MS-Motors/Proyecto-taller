// Arranque multiproceso.
//
// Node corre en un solo hilo: un proceso usa un núcleo por más que la máquina tenga
// varios. Este arranque levanta un worker por núcleo y reparte las conexiones entre
// ellos, multiplicando la capacidad sin tocar una línea de las rutas.
//
// Dos cosas NO se pueden duplicar, y de eso se encarga el primario:
//
//   1. La migración del esquema. Varios ALTER TABLE en paralelo sobre la misma tabla
//      se pisan entre sí. Corre acá, una vez, ANTES de levantar los workers.
//   2. Los jobs de fondo. Los recordatorios de cita mandan correos: con 4 workers,
//      cada cliente recibiría 4. Solo el worker 0 los arranca.
//
// Para volver a un solo proceso: `node src/server.js` sigue funcionando igual y hace
// las dos cosas por su cuenta (es lo que conviene en desarrollo).
const cluster = require('cluster');
const os = require('os');

// Cuántos workers.
//
// NO se deduce de os.cpus(): dentro de un contenedor eso devuelve los núcleos del
// HOST, no lo que la plataforma te asignó. En una caja de 18 núcleos con un
// contenedor de 0,5 vCPU y 512 MB, levantar 18 (o 4) procesos empeora las cosas:
// cada worker de Node arranca en ~60 MB y se pelean por el mismo tiempo de CPU.
//
// Por eso el valor se declara: WEB_CONCURRENCY, ajustado al plan contratado.
// Sin declarar se usan 2, que aprovecha una segunda vCPU si la hay y sigue entrando
// con holgura en un contenedor chico. Los núcleos del host se muestran solo como
// referencia al arrancar.
const CPUS = os.cpus().length;
const WORKERS = Math.max(1, Math.min(Number(process.env.WEB_CONCURRENCY) || 2, 8));

if (!cluster.isPrimary || WORKERS === 1) {
  // Un solo worker no justifica el primario: se arranca directo y se ahorra un proceso.
  require('./server');
} else {
  const { testConnection } = require('./db/pool');
  const { ensureSchema } = require('./db/auto-migrate');

  (async () => {
    console.log(`🧵 Multiproceso: ${WORKERS} workers (WEB_CONCURRENCY${process.env.WEB_CONCURRENCY ? '' : ' sin definir → 2'}; el host reporta ${CPUS} núcleos, que en un contenedor NO es lo asignado)`);
    await testConnection();
    await ensureSchema();   // una sola vez, antes de que nadie acepte requests

    // Se recuerda cuál es el worker de los jobs: si justo ese muere, el reemplazo
    // tiene que retomarlos, o los recordatorios dejan de salir sin que nadie se entere.
    let workerDeJobs = null;
    const levantar = (conJobs) => {
      const w = cluster.fork({ MIGRADO: '1', JOBS: conJobs ? '1' : '0', WEB_CONCURRENCY: String(WORKERS) });
      if (conJobs) workerDeJobs = w.id;
      return w;
    };

    for (let i = 0; i < WORKERS; i++) levantar(i === 0);

    // Apagado ordenado. Railway manda SIGTERM en cada deploy: sin esta bandera el
    // primario repondría los workers a medida que mueren y pelearía contra su propio
    // apagado, hasta que la plataforma lo mate a la fuerza.
    let cerrando = false;
    for (const senal of ['SIGTERM', 'SIGINT']) {
      process.on(senal, () => {
        cerrando = true;
        for (const w of Object.values(cluster.workers)) w.kill(senal);
      });
    }

    // Si un worker muere (excepción no capturada, OOM), se repone: el servicio sigue
    // en pie con los demás mientras tanto.
    cluster.on('exit', (worker, code, signal) => {
      // No alcanza con mirar la bandera: si la señal va a todo el grupo de procesos,
      // los workers pueden morir ANTES de que corra el manejador del primario y se
      // repondrían justo mientras el sistema se está apagando. Una muerte por señal
      // de terminación siempre es "nos pidieron parar", nunca "se cayó".
      //
      // Ojo: no siempre llega como `signal`. Según cómo se entregue (y en Windows),
      // Node reporta signal=null y el código 128+n — 143 para SIGTERM, 130 para
      // SIGINT. Hay que contemplar las dos formas o la guarda no sirve de nada.
      const terminado = signal === 'SIGTERM' || signal === 'SIGINT' || code === 143 || code === 130;
      if (cerrando || terminado) return;
      const teniaJobs = worker.id === workerDeJobs;
      console.error(`⚠️  Worker ${worker.process.pid} murió (${signal || code}). Reponiendo${teniaJobs ? ' (con los jobs)' : ''}…`);
      levantar(teniaJobs);
    });
  })().catch((err) => {
    console.error('❌ No se pudo arrancar:', err.message);
    process.exit(1);
  });
}
