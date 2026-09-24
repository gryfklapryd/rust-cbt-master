import { buildApp } from "./app.js";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { closeQueues } from "./lib/queue.js";
import { ensureBucket } from "./lib/storage.js";
import { startWorkers } from "./worker.js";

async function main() {
  await runMigrations();
  await ensureBucket();
  const app = await buildApp();
  const stopWorkers = config.INLINE_WORKER ? startWorkers(app.log) : null;
  if (stopWorkers) app.log.info("worker antrean berjalan di proses API (INLINE_WORKER=true)");

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "menghentikan server…");
    await app.close();
    await stopWorkers?.();
    await closeQueues();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: config.HOST, port: config.PORT });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
