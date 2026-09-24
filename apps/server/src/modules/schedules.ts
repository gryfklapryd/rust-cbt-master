import { and, asc, count, desc, eq, gte, ilike, inArray, lte, max, or, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { db } from "../db/client.js";
import {
  SCHEDULE_STATUSES,
  attempts,
  examPackages,
  exams,
  packageDownloads,
  participants,
  scheduleParticipants,
  schedules,
  sites,
} from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { randomCode } from "../lib/password.js";
import { getQueues } from "../lib/queue.js";
import { getObjectStream } from "../lib/storage.js";
import { currentUser } from "../plugins/auth.js";

const ScheduleBase = z.object({
  examId: z.uuid(),
  name: z.string().min(1).max(200),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }),
  lateEntryMinutes: z.number().int().min(0).nullish(),
  /** Token sesi. Kosongkan & set `generateToken` untuk dibuat otomatis. */
  accessToken: z.string().trim().min(4).max(32).nullish(),
  generateToken: z.boolean().default(false),
});

const ScheduleInput = ScheduleBase.extend({ siteId: z.uuid() });

const ListQuery = PageQuery.extend({
  siteId: z.uuid().optional(),
  examId: z.uuid().optional(),
  status: z.enum(SCHEDULE_STATUSES).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

const ParticipantSelector = z
  .object({
    participantIds: z.array(z.uuid()).max(20_000).optional(),
    groupName: z.string().optional(),
    /** Tambahkan semua peserta yang lokasi asalnya = lokasi jadwal. */
    fromSite: z.boolean().optional(),
  })
  .refine((b) => b.participantIds?.length || b.groupName || b.fromSite, "Isi participantIds, groupName, atau fromSite");

function assertTimes(startAt: string | Date, endAt: string | Date) {
  if (new Date(endAt) <= new Date(startAt)) {
    const e = new Error("Waktu selesai harus setelah waktu mulai");
    Object.assign(e, { statusCode: 400 });
    throw e;
  }
}

async function resolveParticipantIds(scheduleSiteId: string, sel: z.infer<typeof ParticipantSelector>) {
  const ids = new Set(sel.participantIds ?? []);
  if (sel.groupName) {
    const rows = await db.select({ id: participants.id }).from(participants).where(eq(participants.groupName, sel.groupName));
    rows.forEach((r) => ids.add(r.id));
  }
  if (sel.fromSite) {
    const rows = await db.select({ id: participants.id }).from(participants).where(eq(participants.siteId, scheduleSiteId));
    rows.forEach((r) => ids.add(r.id));
  }
  return [...ids];
}

async function addParticipants(scheduleId: string, ids: string[]) {
  let added = 0;
  for (let i = 0; i < ids.length; i += 1_000) {
    const res = await db
      .insert(scheduleParticipants)
      .values(ids.slice(i, i + 1_000).map((participantId) => ({ scheduleId, participantId })))
      .onConflictDoNothing()
      .returning({ id: scheduleParticipants.participantId });
    added += res.length;
  }
  return added;
}

/** Buat versi paket baru dan antrekan pembangunannya. */
export async function publishSchedule(scheduleId: string, userId: string | null) {
  const pkg = await db.transaction(async (tx) => {
    // Kunci jadwal supaya dua publish bersamaan tidak mendapat nomor versi sama.
    await tx.select({ id: schedules.id }).from(schedules).where(eq(schedules.id, scheduleId)).for("update");
    const [{ v } = { v: 0 }] = await tx
      .select({ v: max(examPackages.version) })
      .from(examPackages)
      .where(eq(examPackages.scheduleId, scheduleId));
    const [created] = await tx
      .insert(examPackages)
      .values({ scheduleId, version: (v ?? 0) + 1, status: "building", createdBy: userId })
      .returning();
    await tx.update(schedules).set({ status: "published" }).where(eq(schedules.id, scheduleId));
    return created!;
  });
  await getQueues().packageBuild.add("build", { scheduleId, packageId: pkg.id }, { jobId: `package-${pkg.id}` });
  return pkg;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["schedules"], querystring: ListQuery } }, async (req) => {
    const q = req.query;
    const conds: SQL[] = [];
    if (q.siteId) conds.push(eq(schedules.siteId, q.siteId));
    if (q.examId) conds.push(eq(schedules.examId, q.examId));
    if (q.status) conds.push(eq(schedules.status, q.status));
    if (q.from) conds.push(gte(schedules.endAt, new Date(q.from)));
    if (q.to) conds.push(lte(schedules.startAt, new Date(q.to)));
    if (q.q) {
      const like = likePattern(q.q);
      conds.push(or(ilike(schedules.name, like), ilike(exams.title, like), ilike(sites.name, like))!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const { limit, offset } = paginate(q);

    const pc = db
      .select({ scheduleId: scheduleParticipants.scheduleId, n: count().as("n") })
      .from(scheduleParticipants)
      .groupBy(scheduleParticipants.scheduleId)
      .as("pc");
    const ac = db
      .select({ scheduleId: attempts.scheduleId, n: count().as("an") })
      .from(attempts)
      .groupBy(attempts.scheduleId)
      .as("ac");
    const [items, [total]] = await Promise.all([
      db
        .select({
          id: schedules.id,
          name: schedules.name,
          startAt: schedules.startAt,
          endAt: schedules.endAt,
          status: schedules.status,
          accessToken: schedules.accessToken,
          exam: { id: exams.id, code: exams.code, title: exams.title },
          site: { id: sites.id, code: sites.code, name: sites.name },
          participantCount: sql<number>`coalesce(${pc.n}, 0)::int`,
          attemptCount: sql<number>`coalesce(${ac.n}, 0)::int`,
          latestPackage: sql<{ id: string; version: number; status: string; builtAt: string | null } | null>`(
            select json_build_object('id', p.id, 'version', p.version, 'status', p.status, 'builtAt', p.built_at, 'error', p.error)
            from exam_packages p where p.schedule_id = ${schedules.id} order by p.version desc limit 1)`,
        })
        .from(schedules)
        .innerJoin(exams, eq(exams.id, schedules.examId))
        .innerJoin(sites, eq(sites.id, schedules.siteId))
        .leftJoin(pc, eq(pc.scheduleId, schedules.id))
        .leftJoin(ac, eq(ac.scheduleId, schedules.id))
        .where(where)
        .orderBy(desc(schedules.startAt))
        .limit(limit)
        .offset(offset),
      db
        .select({ n: count() })
        .from(schedules)
        .innerJoin(exams, eq(exams.id, schedules.examId))
        .innerJoin(sites, eq(sites.id, schedules.siteId))
        .where(where),
    ]);
    return paged(items, total!.n, q);
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["schedules"], params: IdParams } }, async (req) => {
    const schedule = await db.query.schedules.findFirst({
      where: eq(schedules.id, req.params.id),
      with: {
        exam: { columns: { id: true, code: true, title: true, durationMinutes: true, status: true } },
        site: { columns: { id: true, code: true, name: true, lastSeenAt: true } },
        packages: {
          orderBy: desc(examPackages.version),
          columns: { answerKeys: false, assetIds: false },
        },
      },
    });
    if (!schedule) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
    const downloads = schedule.packages.length
      ? await db
          .select({ packageId: packageDownloads.packageId, n: count(), last: max(packageDownloads.downloadedAt) })
          .from(packageDownloads)
          .where(inArray(packageDownloads.packageId, schedule.packages.map((p) => p.id)))
          .groupBy(packageDownloads.packageId)
      : [];
    const dl = new Map(downloads.map((d) => [d.packageId, { count: d.n, lastAt: d.last }]));
    return { ...schedule, packages: schedule.packages.map((p) => ({ ...p, downloads: dl.get(p.id) ?? { count: 0, lastAt: null } })) };
  });

  app.get(
    "/:id/participants",
    { onRequest: app.requireUser(), schema: { tags: ["schedules"], params: IdParams, querystring: PageQuery } },
    async (req) => {
      const q = req.query;
      const where = eq(scheduleParticipants.scheduleId, req.params.id);
      const { limit, offset } = paginate(q);
      const [items, [total]] = await Promise.all([
        db
          .select({
            id: participants.id,
            number: participants.number,
            name: participants.name,
            groupName: participants.groupName,
            active: participants.active,
            attempt: {
              id: attempts.id,
              status: attempts.status,
              gradingStatus: attempts.gradingStatus,
              score: attempts.score,
              maxScore: attempts.maxScore,
              scaledScore: attempts.scaledScore,
            },
          })
          .from(scheduleParticipants)
          .innerJoin(participants, eq(participants.id, scheduleParticipants.participantId))
          .leftJoin(attempts, and(eq(attempts.scheduleId, scheduleParticipants.scheduleId), eq(attempts.participantId, participants.id)))
          .where(where)
          .orderBy(asc(participants.number))
          .limit(limit)
          .offset(offset),
        db.select({ n: count() }).from(scheduleParticipants).where(where),
      ]);
      return paged(
        items.map((i) => ({ ...i, attempt: i.attempt?.id ? i.attempt : null })),
        total!.n,
        q,
      );
    },
  );

  app.post("/", { onRequest: app.requireUser("admin"), schema: { tags: ["schedules"], body: ScheduleInput } }, async (req, reply) => {
    const { generateToken, accessToken, ...b } = req.body;
    assertTimes(b.startAt, b.endAt);
    const [s] = await db
      .insert(schedules)
      .values({
        ...b,
        startAt: new Date(b.startAt),
        endAt: new Date(b.endAt),
        lateEntryMinutes: b.lateEntryMinutes ?? null,
        accessToken: accessToken ?? (generateToken ? randomCode(6) : null),
        createdBy: currentUser(req).sub,
      })
      .returning();
    await audit(db, { type: "user", id: currentUser(req).sub }, "schedule.create", "schedule", s!.id);
    return reply.status(201).send(s);
  });

  /** Buat jadwal yang sama untuk banyak lokasi sekaligus, opsional dengan peserta sesuai lokasi asal. */
  app.post(
    "/bulk",
    {
      onRequest: app.requireUser("admin"),
      schema: {
        tags: ["schedules"],
        body: ScheduleBase.extend({
          siteIds: z.array(z.uuid()).min(1).max(1_000),
          assignParticipantsFromSite: z.boolean().default(true),
        }),
      },
    },
    async (req, reply) => {
      const { siteIds, assignParticipantsFromSite, generateToken, accessToken, ...b } = req.body;
      assertTimes(b.startAt, b.endAt);
      const me = currentUser(req).sub;
      const created: { id: string; siteId: string; participants: number }[] = [];
      for (const siteId of siteIds) {
        const [s] = await db
          .insert(schedules)
          .values({
            ...b,
            siteId,
            startAt: new Date(b.startAt),
            endAt: new Date(b.endAt),
            lateEntryMinutes: b.lateEntryMinutes ?? null,
            accessToken: accessToken ?? (generateToken ? randomCode(6) : null),
            createdBy: me,
          })
          .returning({ id: schedules.id });
        const n = assignParticipantsFromSite
          ? await addParticipants(s!.id, await resolveParticipantIds(siteId, { fromSite: true }))
          : 0;
        created.push({ id: s!.id, siteId, participants: n });
      }
      await audit(db, { type: "user", id: me }, "schedule.bulk_create", "schedule", undefined, { count: created.length });
      return reply.status(201).send({ created });
    },
  );

  app.patch(
    "/:id",
    {
      onRequest: app.requireUser("admin"),
      schema: {
        tags: ["schedules"],
        params: IdParams,
        body: ScheduleInput.omit({ generateToken: true }).partial().extend({ status: z.enum(SCHEDULE_STATUSES).optional() }),
      },
    },
    async (req) => {
      const existing = await db.query.schedules.findFirst({ where: eq(schedules.id, req.params.id) });
      if (!existing) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
      const { startAt, endAt, ...b } = req.body;
      assertTimes(startAt ?? existing.startAt, endAt ?? existing.endAt);
      const [s] = await db
        .update(schedules)
        .set({
          ...b,
          ...(startAt ? { startAt: new Date(startAt) } : {}),
          ...(endAt ? { endAt: new Date(endAt) } : {}),
        })
        .where(eq(schedules.id, req.params.id))
        .returning();
      return s;
    },
  );

  app.delete("/:id", { onRequest: app.requireUser("admin"), schema: { tags: ["schedules"], params: IdParams } }, async (req, reply) => {
    const [a] = await db.select({ n: count() }).from(attempts).where(eq(attempts.scheduleId, req.params.id));
    if (a!.n > 0) throw app.httpErrors.conflict("Jadwal sudah memiliki hasil ujian, tidak bisa dihapus (tutup saja)");
    const res = await db.delete(schedules).where(eq(schedules.id, req.params.id)).returning({ id: schedules.id });
    if (!res.length) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
    await audit(db, { type: "user", id: currentUser(req).sub }, "schedule.delete", "schedule", req.params.id);
    return reply.status(204).send();
  });

  app.post(
    "/:id/participants",
    { onRequest: app.requireUser("admin"), schema: { tags: ["schedules"], params: IdParams, body: ParticipantSelector } },
    async (req) => {
      const s = await db.query.schedules.findFirst({ where: eq(schedules.id, req.params.id) });
      if (!s) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
      const ids = await resolveParticipantIds(s.siteId, req.body);
      const added = await addParticipants(s.id, ids);
      return { added, requested: ids.length };
    },
  );

  app.delete(
    "/:id/participants",
    {
      onRequest: app.requireUser("admin"),
      schema: { tags: ["schedules"], params: IdParams, body: z.object({ participantIds: z.array(z.uuid()).min(1).max(20_000) }) },
    },
    async (req) => {
      const res = await db
        .delete(scheduleParticipants)
        .where(and(eq(scheduleParticipants.scheduleId, req.params.id), inArray(scheduleParticipants.participantId, req.body.participantIds)))
        .returning({ id: scheduleParticipants.participantId });
      return { removed: res.length };
    },
  );

  app.post("/:id/regenerate-token", { onRequest: app.requireUser("admin"), schema: { tags: ["schedules"], params: IdParams } }, async (req) => {
    const [s] = await db
      .update(schedules)
      .set({ accessToken: randomCode(6) })
      .where(eq(schedules.id, req.params.id))
      .returning({ id: schedules.id, accessToken: schedules.accessToken });
    if (!s) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
    return { ...s, note: "Terbitkan ulang paket agar token baru berlaku di titik ujian" };
  });

  /** Terbitkan (bangun) paket ujian versi baru. Titik ujian akan mengunduh versi terbaru. */
  app.post("/:id/publish", { onRequest: app.requireUser("admin"), schema: { tags: ["schedules"], params: IdParams } }, async (req, reply) => {
    const s = await db.query.schedules.findFirst({ where: eq(schedules.id, req.params.id) });
    if (!s) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
    if (s.status === "closed") throw app.httpErrors.conflict("Jadwal sudah ditutup");
    const pkg = await publishSchedule(s.id, currentUser(req).sub);
    await audit(db, { type: "user", id: currentUser(req).sub }, "schedule.publish", "schedule", s.id, { packageId: pkg.id, version: pkg.version });
    const { answerKeys: _k, assetIds: _a, ...rest } = pkg;
    return reply.status(202).send(rest);
  });

  app.post("/:id/close", { onRequest: app.requireUser("admin"), schema: { tags: ["schedules"], params: IdParams } }, async (req) => {
    const [s] = await db.update(schedules).set({ status: "closed" }).where(eq(schedules.id, req.params.id)).returning();
    if (!s) throw app.httpErrors.notFound("Jadwal tidak ditemukan");
    return s;
  });

  /** Unduh JSON paket (untuk pemeriksaan / distribusi manual lewat flashdisk). */
  app.get(
    "/:id/packages/:packageId/download",
    {
      onRequest: app.requireUser("admin"),
      schema: { tags: ["schedules"], params: z.object({ id: z.uuid(), packageId: z.uuid() }) },
    },
    async (req, reply) => {
      const [pkg] = await db
        .select()
        .from(examPackages)
        .where(and(eq(examPackages.id, req.params.packageId), eq(examPackages.scheduleId, req.params.id)));
      if (!pkg?.objectKey) throw app.httpErrors.notFound("Paket belum tersedia");
      const obj = await getObjectStream(pkg.objectKey);
      reply.header("content-type", "application/json");
      reply.header("content-disposition", `attachment; filename="paket-${pkg.scheduleId}-v${pkg.version}.json"`);
      return reply.send(obj.body);
    },
  );
};

export default routes;
