import Fastify, { type FastifyServerOptions } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import sensible from "@fastify/sensible";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  hasZodFastifySchemaValidationErrors,
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { sql } from "drizzle-orm";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { pgErrorToHttp } from "./lib/http.js";
import { checkStorage } from "./lib/storage.js";
import authPlugin from "./plugins/auth.js";
import assetsRoutes from "./modules/assets.js";
import authRoutes from "./modules/auth.js";
import banksRoutes from "./modules/banks.js";
import dashboardRoutes from "./modules/dashboard.js";
import examsRoutes from "./modules/exams.js";
import participantsRoutes from "./modules/participants.js";
import questionsRoutes from "./modules/questions.js";
import resultsRoutes from "./modules/results.js";
import schedulesRoutes from "./modules/schedules.js";
import sitesRoutes from "./modules/sites.js";
import syncRoutes from "./modules/sync.js";
import usersRoutes from "./modules/users.js";

export async function buildApp(opts: FastifyServerOptions = {}) {
  const app = Fastify({
    logger:
      config.LOG_LEVEL === "silent"
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: ["req.headers.authorization", "body.password", "body.secret"],
          },
    bodyLimit: config.BODY_LIMIT_MB * 1024 * 1024,
    trustProxy: true,
    ...opts,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(cors, {
    origin: config.CORS_ORIGINS.split(",").map((s) => s.trim()),
    credentials: true,
  });
  await app.register(rateLimit, { global: false });
  await app.register(multipart, {
    limits: { fileSize: config.UPLOAD_LIMIT_MB * 1024 * 1024, files: 1 },
  });
  await app.register(swagger, {
    openapi: {
      info: {
        title: "CBT Server Pusat",
        description: "API panel admin & sinkronisasi titik ujian (aplikasi desktop).",
        version: "0.1.0",
      },
      components: {
        securitySchemes: { bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
      security: [{ bearer: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });
  await app.register(authPlugin);

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        statusCode: 400,
        error: "Bad Request",
        message: "Validasi gagal",
        issues: err.validation.map((v) => ({ path: v.instancePath, message: v.message, params: v.params })),
      });
    }
    const pg = pgErrorToHttp(err);
    if (pg) {
      return reply.status(pg.statusCode).send({ statusCode: pg.statusCode, error: "Conflict", message: pg.message });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error(err);
    return reply.status(status).send({
      statusCode: status,
      error: status >= 500 ? "Internal Server Error" : ((err as Error).name ?? "Error"),
      message: status >= 500 && config.NODE_ENV === "production" ? "Terjadi kesalahan di server" : (err as Error).message,
      ...((err as { issues?: unknown }).issues ? { issues: (err as { issues?: unknown }).issues } : {}),
    });
  });

  app.get("/health", { schema: { hide: true } }, async () => {
    const [dbOk, s3Ok] = await Promise.all([
      db.execute(sql`select 1`).then(
        () => true,
        () => false,
      ),
      checkStorage(),
    ]);
    return { status: dbOk && s3Ok ? "ok" : "degraded", db: dbOk, storage: s3Ok, time: new Date().toISOString() };
  });

  // API panel admin
  await app.register(
    async (api) => {
      await api.register(authRoutes, { prefix: "/auth" });
      await api.register(usersRoutes, { prefix: "/users" });
      await api.register(sitesRoutes, { prefix: "/sites" });
      await api.register(participantsRoutes, { prefix: "/participants" });
      await api.register(assetsRoutes, { prefix: "/assets" });
      await api.register(banksRoutes, { prefix: "/banks" });
      await api.register(questionsRoutes, { prefix: "/questions" });
      await api.register(examsRoutes, { prefix: "/exams" });
      await api.register(schedulesRoutes, { prefix: "/schedules" });
      await api.register(resultsRoutes, { prefix: "/results" });
      await api.register(dashboardRoutes, { prefix: "/dashboard" });
      // API sinkronisasi untuk aplikasi desktop titik ujian
      await api.register(syncRoutes, { prefix: "/sync" });
    },
    { prefix: "/api" },
  );

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
