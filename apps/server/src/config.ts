import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const Env = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  DATABASE_URL: z.string().default("postgres://cbt:cbt@localhost:5432/cbt"),
  DATABASE_POOL_MAX: z.coerce.number().int().default(20),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  S3_ENDPOINT: z.string().default("http://localhost:9000"),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY: z.string().default("minioadmin"),
  S3_SECRET_KEY: z.string().default("minioadmin"),
  S3_BUCKET: z.string().default("cbt"),
  S3_FORCE_PATH_STYLE: bool.default(true),

  JWT_SECRET: z.string().min(32).default("dev-only-secret-change-me-please-0123456789"),
  /** Masa berlaku token admin. */
  JWT_ADMIN_TTL: z.string().default("12h"),
  /** Masa berlaku token titik ujian (desktop). */
  JWT_SITE_TTL: z.string().default("24h"),

  CORS_ORIGINS: z.string().default("http://localhost:5173"),
  /** Batas ukuran body JSON (upload hasil ujian bisa besar). */
  BODY_LIMIT_MB: z.coerce.number().default(50),
  /** Batas ukuran unggah berkas (aset, lampiran jawaban). */
  UPLOAD_LIMIT_MB: z.coerce.number().default(500),

  /** Jalankan worker di proses yang sama dengan API (praktis untuk dev/test). */
  INLINE_WORKER: bool.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().default(4),

  /** Admin awal yang dibuat oleh seed bila belum ada user. */
  BOOTSTRAP_ADMIN_USERNAME: z.string().default("admin"),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().default("admin12345"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Konfigurasi environment tidak valid:\n${msg}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production" && cfg.JWT_SECRET.startsWith("dev-only")) {
    throw new Error("JWT_SECRET wajib diisi di production");
  }
  return cfg;
}

export const config = loadConfig();
