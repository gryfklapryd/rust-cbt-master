import { Queue, type ConnectionOptions } from "bullmq";
import { config } from "../config.js";

export const QUEUE_NAMES = {
  /** Membangun paket ujian (snapshot soal + peserta + aset) untuk satu jadwal. */
  packageBuild: "package-build",
  /** Memproses batch hasil ujian dari titik ujian menjadi attempt + jawaban. */
  resultsIngest: "results-ingest",
  /** Menilai satu attempt (otomatis) dan menghitung ulang total skor. */
  grading: "grading",
} as const;

export interface PackageBuildJob {
  scheduleId: string;
  packageId: string;
}
export interface ResultsIngestJob {
  batchId: string;
}
export interface GradingJob {
  attemptId: string;
  /** Nilai ulang semua jawaban otomatis walaupun sudah dinilai. */
  force?: boolean;
}

export const redisConnection: ConnectionOptions = {
  url: config.REDIS_URL,
  maxRetriesPerRequest: null,
};

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: "exponential", delay: 2_000 },
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: { age: 7 * 24 * 3600 },
};

let queues:
  | {
      packageBuild: Queue<PackageBuildJob>;
      resultsIngest: Queue<ResultsIngestJob>;
      grading: Queue<GradingJob>;
    }
  | undefined;

export function getQueues() {
  queues ??= {
    packageBuild: new Queue<PackageBuildJob>(QUEUE_NAMES.packageBuild, { connection: redisConnection, defaultJobOptions }),
    resultsIngest: new Queue<ResultsIngestJob>(QUEUE_NAMES.resultsIngest, {
      connection: redisConnection,
      defaultJobOptions,
    }),
    grading: new Queue<GradingJob>(QUEUE_NAMES.grading, { connection: redisConnection, defaultJobOptions }),
  };
  return queues;
}

export async function closeQueues() {
  if (!queues) return;
  await Promise.all(Object.values(queues).map((q) => q.close()));
  queues = undefined;
}

/** Penilaian bersifat idempoten, jadi aman bila attempt yang sama di-enqueue lebih dari sekali. */
export async function enqueueGrading(attemptId: string, force = false) {
  await getQueues().grading.add("grade", { attemptId, force });
}
