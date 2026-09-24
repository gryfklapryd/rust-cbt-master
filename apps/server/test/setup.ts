/**
 * Lingkungan tes integrasi. Membutuhkan PostgreSQL, Redis, dan S3 (MinIO) yang berjalan —
 * lihat `docker compose -f docker-compose.dev.yml up -d` di root repo.
 * Variabel bisa ditimpa lewat env: TEST_DATABASE_URL, TEST_REDIS_URL, TEST_S3_ENDPOINT.
 */
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://cbt:cbt@localhost:5432/cbt_test";
process.env.REDIS_URL = process.env.TEST_REDIS_URL ?? "redis://localhost:6379/15";
process.env.S3_ENDPOINT = process.env.TEST_S3_ENDPOINT ?? process.env.S3_ENDPOINT ?? "http://localhost:9000";
process.env.S3_BUCKET = process.env.TEST_S3_BUCKET ?? "cbt-test";
