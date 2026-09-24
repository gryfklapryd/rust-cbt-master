import { and, asc, avg, count, desc, eq, ilike, inArray, max, min, or, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { QuestionDefinition, Scoring, scoreFromRubric } from "@cbt/shared";
import { db } from "../db/client.js";
import {
  GRADING_STATUSES,
  attachments,
  attemptAnswers,
  attemptEvents,
  attempts,
  examPackages,
  exams,
  participants,
  questions,
  schedules,
  sites,
  syncBatches,
  type PackageKeyEntry,
} from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { enqueueGrading, getQueues } from "../lib/queue.js";
import { getObjectStream } from "../lib/storage.js";
import { recomputeAttemptTotals, resetAutoGrades } from "../services/grading.js";
import { currentUser } from "../plugins/auth.js";

const AttemptFilter = z.object({
  scheduleId: z.uuid().optional(),
  examId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  gradingStatus: z.enum(GRADING_STATUSES).optional(),
});

function attemptConds(f: z.infer<typeof AttemptFilter> & { q?: string }) {
  const conds: SQL[] = [];
  if (f.scheduleId) conds.push(eq(attempts.scheduleId, f.scheduleId));
  if (f.examId) conds.push(eq(schedules.examId, f.examId));
  if (f.siteId) conds.push(eq(attempts.siteId, f.siteId));
  if (f.gradingStatus) conds.push(eq(attempts.gradingStatus, f.gradingStatus));
  if (f.q) conds.push(or(ilike(participants.number, likePattern(f.q)), ilike(participants.name, likePattern(f.q)))!);
  return conds.length ? and(...conds) : undefined;
}

const attemptListColumns = {
  id: attempts.id,
  status: attempts.status,
  gradingStatus: attempts.gradingStatus,
  startedAt: attempts.startedAt,
  finishedAt: attempts.finishedAt,
  score: attempts.score,
  maxScore: attempts.maxScore,
  scaledScore: attempts.scaledScore,
  correctCount: attempts.correctCount,
  answeredCount: attempts.answeredCount,
  violationCount: attempts.violationCount,
  receivedAt: attempts.receivedAt,
  participant: { id: participants.id, number: participants.number, name: participants.name, groupName: participants.groupName },
  schedule: { id: schedules.id, name: schedules.name },
  site: { id: sites.id, code: sites.code, name: sites.name },
  exam: { id: exams.id, code: exams.code, title: exams.title },
};

function attemptsQuery() {
  return db
    .select(attemptListColumns)
    .from(attempts)
    .innerJoin(participants, eq(participants.id, attempts.participantId))
    .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
    .innerJoin(exams, eq(exams.id, schedules.examId))
    .innerJoin(sites, eq(sites.id, attempts.siteId));
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    "/attempts",
    { onRequest: app.requireUser(), schema: { tags: ["results"], querystring: PageQuery.merge(AttemptFilter) } },
    async (req) => {
      const q = req.query;
      const where = attemptConds(q);
      const { limit, offset } = paginate(q);
      const [items, [total]] = await Promise.all([
        attemptsQuery().where(where).orderBy(asc(participants.number)).limit(limit).offset(offset),
        db
          .select({ n: count() })
          .from(attempts)
          .innerJoin(participants, eq(participants.id, attempts.participantId))
          .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
          .where(where),
      ]);
      return paged(items, total!.n, q);
    },
  );

  /** Ekspor hasil ke CSV (bisa dibuka di Excel). */
  app.get(
    "/attempts/export.csv",
    { onRequest: app.requireUser(), schema: { tags: ["results"], querystring: AttemptFilter } },
    async (req, reply) => {
      const rows = await attemptsQuery().where(attemptConds(req.query)).orderBy(asc(sites.code), asc(participants.number));
      const header = [
        "nomor_peserta", "nama", "kelompok", "kode_lokasi", "lokasi", "kode_ujian", "ujian", "jadwal",
        "status", "status_penilaian", "mulai", "selesai", "skor", "skor_maks", "nilai_100", "jumlah_benar", "jumlah_dijawab", "pelanggaran",
      ];
      const lines = rows.map((r) =>
        [
          r.participant.number, r.participant.name, r.participant.groupName, r.site.code, r.site.name, r.exam.code, r.exam.title,
          r.schedule.name, r.status, r.gradingStatus, r.startedAt, r.finishedAt, r.score, r.maxScore, r.scaledScore,
          r.correctCount, r.answeredCount, r.violationCount,
        ]
          .map(csvCell)
          .join(","),
      );
      reply.header("content-type", "text/csv; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="hasil-ujian.csv"`);
      return "﻿" + [header.join(","), ...lines].join("\n");
    },
  );

  app.get("/attempts/:id", { onRequest: app.requireUser(), schema: { tags: ["results"], params: IdParams } }, async (req) => {
    const [attempt] = await attemptsQuery().where(eq(attempts.id, req.params.id));
    if (!attempt) throw app.httpErrors.notFound("Attempt tidak ditemukan");
    const [extra] = await db
      .select({ questionOrder: attempts.questionOrder, client: attempts.client, packageId: attempts.packageId, sequence: attempts.sequence })
      .from(attempts)
      .where(eq(attempts.id, req.params.id));
    const [pkg] = await db
      .select({ answerKeys: examPackages.answerKeys, version: examPackages.version })
      .from(examPackages)
      .where(eq(examPackages.id, extra!.packageId));
    const keys = pkg?.answerKeys ?? {};
    const answers = await db
      .select({
        questionId: attemptAnswers.questionId,
        response: attemptAnswers.response,
        answeredAt: attemptAnswers.answeredAt,
        timeSpentSeconds: attemptAnswers.timeSpentSeconds,
        flagged: attemptAnswers.flagged,
        changeCount: attemptAnswers.changeCount,
        gradeStatus: attemptAnswers.gradeStatus,
        autoResult: attemptAnswers.autoResult,
        score: attemptAnswers.score,
        maxScore: attemptAnswers.maxScore,
        manualScore: attemptAnswers.manualScore,
        rubricScores: attemptAnswers.rubricScores,
        feedback: attemptAnswers.feedback,
        gradedAt: attemptAnswers.gradedAt,
        code: questions.code,
      })
      .from(attemptAnswers)
      .innerJoin(questions, eq(questions.id, attemptAnswers.questionId))
      .where(eq(attemptAnswers.attemptId, req.params.id));
    const order = extra!.questionOrder ?? Object.keys(keys);
    const pos = new Map(order.map((id, i) => [id, i]));
    answers.sort((a, b) => (pos.get(a.questionId) ?? 1e9) - (pos.get(b.questionId) ?? 1e9));
    const events = await db
      .select()
      .from(attemptEvents)
      .where(eq(attemptEvents.attemptId, req.params.id))
      .orderBy(asc(attemptEvents.at));
    return {
      ...attempt,
      ...extra,
      packageVersion: pkg?.version ?? null,
      answers: answers.map((a) => ({ ...a, question: keys[a.questionId] ?? null })),
      events,
    };
  });

  /** Hapus attempt (mis. peserta diizinkan mengulang). */
  app.delete("/attempts/:id", { onRequest: app.requireUser("admin"), schema: { tags: ["results"], params: IdParams } }, async (req, reply) => {
    const res = await db.delete(attempts).where(eq(attempts.id, req.params.id)).returning({ id: attempts.id, participantId: attempts.participantId });
    if (!res.length) throw app.httpErrors.notFound("Attempt tidak ditemukan");
    await audit(db, { type: "user", id: currentUser(req).sub }, "attempt.delete", "attempt", req.params.id, { participantId: res[0]!.participantId });
    return reply.status(204).send();
  });

  app.post("/attempts/:id/regrade", { onRequest: app.requireUser("admin", "grader"), schema: { tags: ["results"], params: IdParams } }, async (req, reply) => {
    await enqueueGrading(req.params.id, true);
    return reply.status(202).send({ queued: 1 });
  });

  /**
   * Nilai ulang semua attempt dari sebuah jadwal / ujian. Dengan `refreshKeys`,
   * snapshot kunci di paket diperbarui dari bank soal terlebih dahulu (untuk koreksi
   * kunci jawaban yang salah setelah ujian berlangsung). Soal yang jenisnya berubah dilewati.
   */
  app.post(
    "/regrade",
    {
      onRequest: app.requireUser("admin"),
      schema: {
        tags: ["results"],
        body: z
          .object({ scheduleId: z.uuid().optional(), examId: z.uuid().optional(), refreshKeys: z.boolean().default(false) })
          .refine((b) => b.scheduleId || b.examId, "Isi scheduleId atau examId"),
      },
    },
    async (req, reply) => {
      const { scheduleId, examId, refreshKeys } = req.body;
      const scheduleIds = scheduleId
        ? [scheduleId]
        : (await db.select({ id: schedules.id }).from(schedules).where(eq(schedules.examId, examId!))).map((s) => s.id);
      if (!scheduleIds.length) return reply.status(202).send({ queued: 0, refreshedPackages: 0 });

      let refreshedPackages = 0;
      const skipped: string[] = [];
      if (refreshKeys) {
        const pkgs = await db
          .select({ id: examPackages.id, answerKeys: examPackages.answerKeys })
          .from(examPackages)
          .where(and(inArray(examPackages.scheduleId, scheduleIds), inArray(examPackages.status, ["ready", "superseded"])));
        for (const p of pkgs) {
          const keys = { ...(p.answerKeys ?? {}) };
          const ids = Object.keys(keys);
          if (!ids.length) continue;
          const current = await db.select().from(questions).where(inArray(questions.id, ids));
          for (const q of current) {
            const old = keys[q.id]!;
            const def = QuestionDefinition.safeParse({ type: q.type, content: q.content, answerKey: q.answerKey });
            if (!def.success || def.data.type !== old.type) {
              skipped.push(q.id);
              continue;
            }
            // Pertahankan poin yang berlaku di paket (bisa berasal dari override ujian).
            const scoring: PackageKeyEntry["scoring"] = Scoring.parse({ ...q.scoring, points: old.scoring.points });
            // Konten tetap versi yang diujikan; hanya kunci & aturan skor yang diperbarui.
            keys[q.id] = { ...old, answerKey: def.data.answerKey, scoring, version: q.version };
          }
          await db.update(examPackages).set({ answerKeys: keys }).where(eq(examPackages.id, p.id));
          refreshedPackages++;
        }
      }
      const ids = (
        await db
          .select({ id: attempts.id })
          .from(attempts)
          .where(and(inArray(attempts.scheduleId, scheduleIds), inArray(attempts.status, ["submitted", "timed_out", "terminated"])))
      ).map((a) => a.id);
      await resetAutoGrades(ids);
      await getQueues().grading.addBulk(ids.map((attemptId) => ({ name: "grade", data: { attemptId, force: true } })));
      await audit(db, { type: "user", id: currentUser(req).sub }, "results.regrade", "schedule", scheduleId ?? undefined, {
        examId,
        attempts: ids.length,
        refreshKeys,
      });
      return reply.status(202).send({ queued: ids.length, refreshedPackages, skippedQuestions: [...new Set(skipped)] });
    },
  );

  // ------------------------------------------------------------------ penilaian manual
  /** Daftar jawaban yang menunggu koreksi manual (uraian, unggah berkas). */
  app.get(
    "/manual-queue",
    {
      onRequest: app.requireUser("grader"),
      schema: {
        tags: ["results"],
        querystring: PageQuery.extend({
          scheduleId: z.uuid().optional(),
          examId: z.uuid().optional(),
          questionId: z.uuid().optional(),
          includeGraded: z.coerce.boolean().default(false),
        }),
      },
    },
    async (req) => {
      const q = req.query;
      const conds: SQL[] = [
        q.includeGraded
          ? inArray(attemptAnswers.gradeStatus, ["pending_manual", "manual"])
          : eq(attemptAnswers.gradeStatus, "pending_manual"),
      ];
      if (q.scheduleId) conds.push(eq(attempts.scheduleId, q.scheduleId));
      if (q.examId) conds.push(eq(schedules.examId, q.examId));
      if (q.questionId) conds.push(eq(attemptAnswers.questionId, q.questionId));
      const where = and(...conds);
      const { limit, offset } = paginate(q);
      const base = () =>
        db
          .select({
            attemptId: attemptAnswers.attemptId,
            questionId: attemptAnswers.questionId,
            response: attemptAnswers.response,
            gradeStatus: attemptAnswers.gradeStatus,
            score: attemptAnswers.score,
            maxScore: attemptAnswers.maxScore,
            rubricScores: attemptAnswers.rubricScores,
            feedback: attemptAnswers.feedback,
            packageId: attempts.packageId,
            // Identitas peserta sengaja tidak ditampilkan agar koreksi tetap objektif (blind grading).
            scheduleName: schedules.name,
          })
          .from(attemptAnswers)
          .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
          .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
          .where(where);
      const [items, [total]] = await Promise.all([
        base().orderBy(asc(attemptAnswers.questionId), asc(attempts.receivedAt)).limit(limit).offset(offset),
        db
          .select({ n: count() })
          .from(attemptAnswers)
          .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
          .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
          .where(where),
      ]);
      // Sertakan snapshot soal (konten + rubrik) dari paket.
      const pkgIds = [...new Set(items.map((i) => i.packageId))];
      const pkgs = pkgIds.length
        ? await db.select({ id: examPackages.id, answerKeys: examPackages.answerKeys }).from(examPackages).where(inArray(examPackages.id, pkgIds))
        : [];
      const keyOf = (pid: string, qid: string) => pkgs.find((p) => p.id === pid)?.answerKeys?.[qid] ?? null;
      return paged(
        items.map(({ packageId, ...i }) => ({ ...i, question: keyOf(packageId, i.questionId) })),
        total!.n,
        q,
      );
    },
  );

  app.post(
    "/manual-grade",
    {
      onRequest: app.requireUser("grader"),
      schema: {
        tags: ["results"],
        body: z
          .object({
            attemptId: z.uuid(),
            questionId: z.uuid(),
            /** Skor langsung; atau kosongkan dan isi `rubricScores`. */
            score: z.number().min(0).optional(),
            rubricScores: z.record(z.string(), z.number().min(0)).optional(),
            feedback: z.string().max(10_000).nullish(),
          })
          .refine((b) => b.score !== undefined || b.rubricScores, "Isi score atau rubricScores"),
      },
    },
    async (req) => {
      const b = req.body;
      const me = currentUser(req).sub;
      return db.transaction(async (tx) => {
        const [row] = await tx
          .select({ answer: attemptAnswers, packageId: attempts.packageId })
          .from(attemptAnswers)
          .innerJoin(attempts, eq(attempts.id, attemptAnswers.attemptId))
          .where(and(eq(attemptAnswers.attemptId, b.attemptId), eq(attemptAnswers.questionId, b.questionId)))
          .for("update");
        if (!row) throw app.httpErrors.notFound("Jawaban tidak ditemukan");
        const [pkg] = await tx.select({ answerKeys: examPackages.answerKeys }).from(examPackages).where(eq(examPackages.id, row.packageId));
        const entry = pkg?.answerKeys?.[b.questionId];
        const maxScore = entry?.scoring.points ?? row.answer.maxScore ?? 0;
        let score: number;
        if (b.rubricScores) {
          const rubric = ((entry?.answerKey as { rubric?: { id: string; maxPoints: number }[] } | undefined)?.rubric ?? []);
          if (!rubric.length) throw app.httpErrors.badRequest("Soal ini tidak memiliki rubrik");
          score = scoreFromRubric(rubric, b.rubricScores, maxScore);
        } else {
          if (b.score! > maxScore) throw app.httpErrors.badRequest(`Skor melebihi skor maksimum (${maxScore})`);
          score = b.score!;
        }
        await tx
          .update(attemptAnswers)
          .set({
            gradeStatus: "manual",
            manualScore: score,
            score,
            maxScore,
            rubricScores: b.rubricScores ?? null,
            feedback: b.feedback ?? null,
            gradedBy: me,
            gradedAt: new Date(),
          })
          .where(and(eq(attemptAnswers.attemptId, b.attemptId), eq(attemptAnswers.questionId, b.questionId)));
        await recomputeAttemptTotals(tx, b.attemptId);
        await audit(tx, { type: "user", id: me }, "results.manual_grade", "attempt", b.attemptId, { questionId: b.questionId, score });
        return { attemptId: b.attemptId, questionId: b.questionId, score, maxScore };
      });
    },
  );

  /** Unduh berkas jawaban peserta (soal unggah berkas). */
  app.get("/attachments/:id", { onRequest: app.requireUser("grader"), schema: { tags: ["results"], params: IdParams } }, async (req, reply) => {
    const att = await db.query.attachments.findFirst({ where: eq(attachments.id, req.params.id) });
    if (!att) throw app.httpErrors.notFound("Berkas tidak ditemukan");
    const obj = await getObjectStream(att.objectKey);
    reply.header("content-type", att.mime);
    reply.header("content-length", att.size);
    reply.header("content-disposition", `inline; filename="${att.filename}"`);
    return reply.send(obj.body);
  });

  // ------------------------------------------------------------------ ringkasan
  app.get(
    "/summary",
    { onRequest: app.requireUser(), schema: { tags: ["results"], querystring: AttemptFilter } },
    async (req) => {
      const where = attemptConds(req.query);
      const [agg] = await db
        .select({
          attempts: count(),
          submitted: sql<number>`count(*) filter (where ${attempts.status} <> 'in_progress')::int`,
          graded: sql<number>`count(*) filter (where ${attempts.gradingStatus} = 'complete')::int`,
          avgScore: avg(attempts.scaledScore),
          minScore: min(attempts.scaledScore),
          maxScore: max(attempts.scaledScore),
          stddev: sql<string | null>`stddev_pop(${attempts.scaledScore})`,
        })
        .from(attempts)
        .innerJoin(participants, eq(participants.id, attempts.participantId))
        .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
        .where(where);
      const distribution = await db
        .select({
          bucket: sql<number>`least(floor(${attempts.scaledScore} / 10), 9)::int`,
          n: count(),
        })
        .from(attempts)
        .innerJoin(participants, eq(participants.id, attempts.participantId))
        .innerJoin(schedules, eq(schedules.id, attempts.scheduleId))
        .where(and(where, sql`${attempts.scaledScore} is not null`))
        .groupBy(sql`1`)
        .orderBy(sql`1`);
      const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100);
      return {
        attempts: agg!.attempts,
        submitted: agg!.submitted,
        graded: agg!.graded,
        avgScore: num(agg!.avgScore),
        minScore: num(agg!.minScore),
        maxScore: num(agg!.maxScore),
        stddev: num(agg!.stddev),
        /** Jumlah peserta per rentang nilai 0-9, 10-19, …, 90-100. */
        distribution: Array.from({ length: 10 }, (_, i) => distribution.find((d) => d.bucket === i)?.n ?? 0),
      };
    },
  );

  // ------------------------------------------------------------------ pemantauan sinkronisasi
  app.get(
    "/batches",
    {
      onRequest: app.requireUser(),
      schema: { tags: ["results"], querystring: PageQuery.extend({ siteId: z.uuid().optional(), status: z.string().optional() }) },
    },
    async (req) => {
      const q = req.query;
      const conds: SQL[] = [];
      if (q.siteId) conds.push(eq(syncBatches.siteId, q.siteId));
      if (q.status) conds.push(eq(syncBatches.status, q.status as "received"));
      const where = conds.length ? and(...conds) : undefined;
      const { limit, offset } = paginate(q);
      const [items, [total]] = await Promise.all([
        db
          .select({
            id: syncBatches.id,
            status: syncBatches.status,
            attemptCount: syncBatches.attemptCount,
            outcomes: syncBatches.outcomes,
            error: syncBatches.error,
            receivedAt: syncBatches.receivedAt,
            processedAt: syncBatches.processedAt,
            deviceId: syncBatches.deviceId,
            site: { id: sites.id, code: sites.code, name: sites.name },
          })
          .from(syncBatches)
          .innerJoin(sites, eq(sites.id, syncBatches.siteId))
          .where(where)
          .orderBy(desc(syncBatches.receivedAt))
          .limit(limit)
          .offset(offset),
        db.select({ n: count() }).from(syncBatches).where(where),
      ]);
      return paged(items, total!.n, q);
    },
  );

  app.post("/batches/:id/reprocess", { onRequest: app.requireUser("admin"), schema: { tags: ["results"], params: IdParams } }, async (req, reply) => {
    const [b] = await db
      .update(syncBatches)
      .set({ status: "received", error: null })
      .where(eq(syncBatches.id, req.params.id))
      .returning({ id: syncBatches.id });
    if (!b) throw app.httpErrors.notFound("Batch tidak ditemukan");
    await getQueues().resultsIngest.add("ingest", { batchId: b.id });
    return reply.status(202).send({ queued: true });
  });
};

export default routes;
