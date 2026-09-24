import { Worker, type Job } from "bullmq";
import { config } from "./config.js";
import { pool } from "./db/client.js";
import {
  QUEUE_NAMES,
  closeQueues,
  redisConnection,
  type GradingJob,
  type PackageBuildJob,
  type ResultsIngestJob,
} from "./lib/queue.js";
import { ensureBucket } from "./lib/storage.js";
import { gradeAttempt } from "./services/grading.js";
import { buildPackage } from "./services/package-builder.js";
import { ingestBatch } from "./services/results-ingest.js";

export interface Logger {
  info: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
}

/** Jalankan semua worker antrean. Mengembalikan fungsi untuk menghentikannya. */
export function startWorkers(log: Logger = consoleLogger) {
  const opts = { connection: redisConnection, concurrency: config.WORKER_CONCURRENCY };
  const workers = [
    new Worker<PackageBuildJob>(QUEUE_NAMES.packageBuild, async (job) => buildPackage(job.data.packageId), {
      ...opts,
      concurrency: 2,
    }),
    new Worker<ResultsIngestJob>(QUEUE_NAMES.resultsIngest, async (job) => ingestBatch(job.data.batchId), opts),
    new Worker<GradingJob>(QUEUE_NAMES.grading, async (job) => gradeAttempt(job.data.attemptId, { force: job.data.force }), {
      ...opts,
      concurrency: config.WORKER_CONCURRENCY * 2,
    }),
  ];
  for (const w of workers) {
    w.on("completed", (job: Job) => log.info({ queue: w.name, jobId: job.id }, "job selesai"));
    w.on("failed", (job: Job | undefined, err: Error) =>
      log.error({ queue: w.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, "job gagal"),
    );
  }
  return async () => {
    await Promise.all(workers.map((w) => w.close()));
  };
}

const consoleLogger: Logger = {
  info: (obj, msg) => console.log(JSON.stringify({ level: "info", msg, ...obj })),
  error: (obj, msg) => console.error(JSON.stringify({ level: "error", msg, ...obj })),
};

async function main() {
  await ensureBucket();
  const stop = startWorkers();
  consoleLogger.info({ queues: Object.values(QUEUE_NAMES) }, "worker berjalan");
  const shutdown = async () => {
    consoleLogger.info({}, "menghentikan worker…");
    await stop();
    await closeQueues();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
