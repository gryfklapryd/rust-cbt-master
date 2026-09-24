import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { HeartbeatRequest, ProctorLogBatch, ResultsBatch, SyncAuthRequest, type ProctorsResponse, type ResultsBatchAck } from "@cbt/shared";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { assets, attachments, examPackages, exams, packageDownloads, proctorActions, schedules, siteProctors, sites, syncBatches, users } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams } from "../lib/http.js";
import { verifyPassword } from "../lib/password.js";
import { getQueues } from "../lib/queue.js";
import { deleteObject, getObjectStream, putObject, putStream, sha256 } from "../lib/storage.js";
import { currentSite } from "../plugins/auth.js";
import { safeFilename } from "./assets.js";

function toAck(b: typeof syncBatches.$inferSelect): ResultsBatchAck {
  return {
    batchId: b.id,
    status: b.status,
    attemptCount: b.attemptCount,
    receivedAt: b.receivedAt.toISOString(),
    processedAt: b.processedAt?.toISOString() ?? null,
    error: b.error,
    ...(b.outcomes ? { attempts: b.outcomes } : {}),
  };
}

/**
 * API untuk aplikasi desktop di titik ujian.
 * Semua endpoint (kecuali /auth) memakai token lokasi dari POST /api/sync/auth.
 */
const routes: FastifyPluginAsyncZod = async (app) => {
  app.post(
    "/auth",
    {
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
      schema: { tags: ["sync"], security: [], body: SyncAuthRequest },
    },
    async (req) => {
      const { siteCode, secret, deviceId, appVersion } = req.body;
      const site = await db.query.sites.findFirst({ where: eq(sites.code, siteCode.toUpperCase()) });
      if (!site || !site.active || !(await verifyPassword(site.secretHash, secret))) {
        throw app.httpErrors.unauthorized("Kode lokasi atau secret salah");
      }
      await db
        .update(sites)
        .set({ lastSeenAt: new Date(), lastSeenInfo: { deviceId, appVersion, ip: req.ip, event: "auth" } })
        .where(eq(sites.id, site.id));
      const token = app.jwt.sign(
        { kind: "site", sub: site.id, siteCode: site.code, ...(deviceId ? { deviceId } : {}) },
        { expiresIn: config.JWT_SITE_TTL },
      );
      const decoded = app.jwt.decode<{ exp: number }>(token);
      return {
        token,
        expiresAt: decoded ? new Date(decoded.exp * 1000).toISOString() : null,
        site: { id: site.id, code: site.code, name: site.name },
        serverTime: new Date().toISOString(),
      };
    },
  );

  // Semua route di bawah butuh token lokasi.
  await app.register(async (instance) => {
    const siteApp = instance.withTypeProvider<ZodTypeProvider>();
    siteApp.addHook("onRequest", app.requireSite);

    siteApp.post("/heartbeat", { schema: { tags: ["sync"], body: HeartbeatRequest } }, async (req) => {
      const site = currentSite(req);
      await db
        .update(sites)
        .set({ lastSeenAt: new Date(), lastSeenInfo: { ...req.body, ip: req.ip, event: "heartbeat" } })
        .where(eq(sites.id, site.sub));
      return { serverTime: new Date().toISOString() };
    });

    /**
     * Akun proktor aktif yang ditugaskan ke lokasi ini, beserta hash password agar
     * server lokal bisa memverifikasi login proktor tanpa internet.
     */
    siteApp.get("/proctors", { schema: { tags: ["sync"] } }, async (req): Promise<ProctorsResponse> => {
      const site = currentSite(req);
      const rows = await db
        .select({ id: users.id, username: users.username, name: users.name, role: users.role, passwordHash: users.passwordHash })
        .from(siteProctors)
        .innerJoin(users, eq(users.id, siteProctors.userId))
        .where(and(eq(siteProctors.siteId, site.sub), eq(users.active, true)))
        .orderBy(asc(users.username));
      return { serverTime: new Date().toISOString(), proctors: rows };
    });

    /** Log aksi proktor dari server lokal. Idempoten per id entri. */
    siteApp.post("/proctor-log", { schema: { tags: ["sync"], body: ProctorLogBatch } }, async (req) => {
      const site = currentSite(req);
      const inserted = await db
        .insert(proctorActions)
        .values(
          req.body.entries.map((e) => ({
            id: e.id,
            siteId: site.sub,
            userId: e.proctorId,
            username: e.username,
            action: e.action,
            scheduleId: e.scheduleId ?? null,
            attemptId: e.attemptId ?? null,
            participantId: e.participantId ?? null,
            data: e.data ?? null,
            at: new Date(e.at),
          })),
        )
        .onConflictDoNothing()
        .returning({ id: proctorActions.id });
      return { received: req.body.entries.length, inserted: inserted.length };
    });

    /** Jadwal terbit untuk lokasi ini (default: yang belum lewat lebih dari 7 hari). */
    siteApp.get(
      "/schedules",
      {
        schema: {
          tags: ["sync"],
          querystring: z.object({ since: z.iso.datetime({ offset: true }).optional() }),
        },
      },
      async (req) => {
        const site = currentSite(req);
        const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 7 * 24 * 3600 * 1000);
        const rows = await db
          .select({
            id: schedules.id,
            name: schedules.name,
            startAt: schedules.startAt,
            endAt: schedules.endAt,
            status: schedules.status,
            /** Token sesi (teks asli) untuk ditampilkan di dasbor proktor server lokal. */
            accessToken: schedules.accessToken,
            exam: { id: exams.id, code: exams.code, title: exams.title, durationMinutes: exams.durationMinutes },
          })
          .from(schedules)
          .innerJoin(exams, eq(exams.id, schedules.examId))
          .where(and(eq(schedules.siteId, site.sub), inArray(schedules.status, ["published", "closed"]), gte(schedules.endAt, since)))
          .orderBy(asc(schedules.startAt));
        const packages = rows.length
          ? await db
              .select({
                scheduleId: examPackages.scheduleId,
                id: examPackages.id,
                version: examPackages.version,
                checksum: examPackages.checksum,
                size: examPackages.size,
                builtAt: examPackages.builtAt,
                assetCount: examPackages.assetCount,
              })
              .from(examPackages)
              .where(and(inArray(examPackages.scheduleId, rows.map((r) => r.id)), eq(examPackages.status, "ready")))
          : [];
        const byId = new Map(packages.map((p) => [p.scheduleId, p]));
        return {
          serverTime: new Date().toISOString(),
          schedules: rows.map((r) => {
            const p = byId.get(r.id);
            return { ...r, package: p ? { id: p.id, version: p.version, checksum: p.checksum, size: p.size, builtAt: p.builtAt, assetCount: p.assetCount } : null };
          }),
        };
      },
    );

    /**
     * Unduh paket terbaru sebuah jadwal. Mendukung `If-None-Match` (ETag = checksum)
     * sehingga client bisa cek pembaruan tanpa mengunduh ulang.
     */
    siteApp.get("/schedules/:id/package", { schema: { tags: ["sync"], params: IdParams } }, async (req, reply) => {
      const site = currentSite(req);
      const [row] = await db
        .select({ pkg: examPackages, siteId: schedules.siteId })
        .from(examPackages)
        .innerJoin(schedules, eq(schedules.id, examPackages.scheduleId))
        .where(and(eq(examPackages.scheduleId, req.params.id), eq(examPackages.status, "ready")))
        .orderBy(desc(examPackages.version))
        .limit(1);
      if (!row || row.siteId !== site.sub) throw app.httpErrors.notFound("Paket untuk jadwal ini belum tersedia");
      const etag = `"${row.pkg.checksum}"`;
      reply.header("etag", etag);
      reply.header("x-package-id", row.pkg.id);
      reply.header("x-package-version", String(row.pkg.version));
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      await db.insert(packageDownloads).values({ packageId: row.pkg.id, siteId: site.sub, deviceId: site.deviceId ?? null });
      const obj = await getObjectStream(row.pkg.objectKey!);
      reply.header("content-type", "application/json; charset=utf-8");
      if (row.pkg.size) reply.header("content-length", row.pkg.size);
      return reply.send(obj.body);
    });

    /** Unduh aset media. Hanya aset yang termuat di paket siap milik lokasi ini. */
    siteApp.get("/assets/:id", { schema: { tags: ["sync"], params: IdParams } }, async (req, reply) => {
      const site = currentSite(req);
      const [allowed] = await db
        .select({ one: sql<number>`1` })
        .from(examPackages)
        .innerJoin(schedules, eq(schedules.id, examPackages.scheduleId))
        .where(
          and(
            eq(schedules.siteId, site.sub),
            inArray(examPackages.status, ["ready", "superseded"]),
            sql`${req.params.id}::uuid = any(${examPackages.assetIds})`,
          ),
        )
        .limit(1);
      if (!allowed) throw app.httpErrors.notFound("Aset tidak ditemukan");
      const asset = await db.query.assets.findFirst({ where: eq(assets.id, req.params.id) });
      if (!asset) throw app.httpErrors.notFound("Aset tidak ditemukan");
      const etag = `"${asset.sha256}"`;
      reply.header("etag", etag);
      if (req.headers["if-none-match"] === etag) return reply.status(304).send();
      const obj = await getObjectStream(asset.objectKey);
      reply.header("content-type", asset.mime);
      reply.header("content-length", asset.size);
      return reply.send(obj.body);
    });

    /**
     * Unggah berkas jawaban (soal unggah berkas). Multipart: field `attachmentId`,
     * `attemptId`, `questionId` (sebelum field file) lalu `file`. Idempoten per attachmentId.
     */
    siteApp.post("/attachments", { schema: { tags: ["sync"], consumes: ["multipart/form-data"] } }, async (req, reply) => {
      const site = currentSite(req);
      const file = await req.file();
      if (!file) throw app.httpErrors.badRequest("Field `file` wajib diisi");
      const field = (name: string) => {
        const f = file.fields[name];
        const v = f && !Array.isArray(f) && "value" in f ? f.value : undefined;
        return typeof v === "string" ? v : undefined;
      };
      const meta = z
        .object({ attachmentId: z.uuid(), attemptId: z.uuid().optional(), questionId: z.uuid().optional() })
        .safeParse({ attachmentId: field("attachmentId"), attemptId: field("attemptId"), questionId: field("questionId") });
      if (!meta.success) {
        file.file.resume();
        throw app.httpErrors.badRequest("attachmentId (uuid) wajib dikirim sebelum field file");
      }
      const existing = await db.query.attachments.findFirst({ where: eq(attachments.id, meta.data.attachmentId) });
      if (existing) {
        file.file.resume();
        if (existing.siteId !== site.sub) throw app.httpErrors.conflict("attachmentId sudah dipakai");
        return reply.status(200).send(existing);
      }
      const objectKey = `attachments/${site.sub}/${meta.data.attachmentId}`;
      const { size, sha256: hash } = await putStream(objectKey, file.file, file.mimetype);
      if (file.file.truncated) {
        await deleteObject(objectKey);
        throw app.httpErrors.payloadTooLarge("Berkas melebihi batas ukuran");
      }
      const [row] = await db
        .insert(attachments)
        .values({
          id: meta.data.attachmentId,
          siteId: site.sub,
          attemptId: meta.data.attemptId ?? null,
          questionId: meta.data.questionId ?? null,
          objectKey,
          filename: safeFilename(file.filename),
          mime: file.mimetype,
          size,
          sha256: hash,
        })
        .onConflictDoNothing()
        .returning();
      return reply.status(201).send(row ?? (await db.query.attachments.findFirst({ where: eq(attachments.id, meta.data.attachmentId) })));
    });

    /**
     * Kirim hasil ujian. Payload disimpan apa adanya ke object storage lalu diproses
     * di antrean (`results-ingest`); respons 202 langsung dikirim.
     * Mengirim ulang batchId yang sama aman dan mengembalikan status batch tersebut.
     */
    siteApp.post(
      "/results",
      { schema: { tags: ["sync"], body: ResultsBatch } },
      async (req, reply) => {
        const site = currentSite(req);
        const body = req.body;
        const existing = await db.query.syncBatches.findFirst({ where: eq(syncBatches.id, body.batchId) });
        if (existing) {
          if (existing.siteId !== site.sub) throw app.httpErrors.conflict("batchId sudah dipakai");
          return reply.status(200).send(toAck(existing));
        }
        const json = JSON.stringify(body);
        const objectKey = `sync/${site.sub}/${new Date().toISOString().slice(0, 10)}/${body.batchId}.json`;
        await putObject(objectKey, json, "application/json");
        const [batch] = await db
          .insert(syncBatches)
          .values({
            id: body.batchId,
            siteId: site.sub,
            deviceId: site.deviceId ?? null,
            objectKey,
            attemptCount: body.attempts.length,
            payloadSha256: sha256(json),
          })
          .onConflictDoNothing()
          .returning();
        if (!batch) {
          const again = await db.query.syncBatches.findFirst({ where: eq(syncBatches.id, body.batchId) });
          return reply.status(200).send(toAck(again!));
        }
        await getQueues().resultsIngest.add("ingest", { batchId: batch.id }, { jobId: `ingest-${batch.id}` });
        await db.update(sites).set({ lastSeenAt: new Date() }).where(eq(sites.id, site.sub));
        await audit(db, { type: "site", id: site.sub }, "sync.results", "sync_batch", batch.id, { attempts: body.attempts.length });
        return reply.status(202).send(toAck(batch));
      },
    );

    siteApp.get("/results/:id", { schema: { tags: ["sync"], params: IdParams } }, async (req) => {
      const site = currentSite(req);
      const batch = await db.query.syncBatches.findFirst({ where: eq(syncBatches.id, req.params.id) });
      if (!batch || batch.siteId !== site.sub) throw app.httpErrors.notFound("Batch tidak ditemukan");
      return toAck(batch);
    });
  });
};

export default routes;
