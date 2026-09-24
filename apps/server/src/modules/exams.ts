import { asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { ExamSettings, findDuplicates } from "@cbt/shared";
import { db } from "../db/client.js";
import { EXAM_STATUSES, examSectionQuestions, examSections, exams, questions } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { currentUser } from "../plugins/auth.js";

const ExamInput = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .transform((s) => s.toUpperCase()),
  title: z.string().min(1).max(500),
  description: z.string().max(10_000).nullish(),
  instructions: z.string().max(100_000).nullish(),
  durationMinutes: z.number().int().min(1).max(24 * 60),
  settings: ExamSettings.default(ExamSettings.parse({})),
  status: z.enum(EXAM_STATUSES).default("draft"),
});

const SectionInput = z.object({
  title: z.string().min(1).max(500),
  instructions: z.string().max(100_000).nullish(),
  durationMinutes: z.number().int().min(1).nullish(),
  pickCount: z.number().int().min(1).nullish(),
  shuffleQuestions: z.boolean().default(false),
  questions: z
    .array(
      z.object({
        questionId: z.uuid(),
        pointsOverride: z.number().min(0).max(1_000).nullish(),
      }),
    )
    .max(1_000),
});

const StructureInput = z.object({ sections: z.array(SectionInput).min(1).max(50) });

export async function loadExamStructure(examId: string) {
  const exam = await db.query.exams.findFirst({
    where: eq(exams.id, examId),
    with: {
      sections: {
        orderBy: asc(examSections.order),
        with: {
          questions: {
            orderBy: asc(examSectionQuestions.order),
            with: {
              question: {
                columns: {
                  id: true,
                  code: true,
                  type: true,
                  content: true,
                  scoring: true,
                  status: true,
                  version: true,
                  bankId: true,
                  stimulusId: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!exam) return null;
  let totalQuestions = 0;
  let totalPoints = 0;
  for (const s of exam.sections) {
    const pts = s.questions.map((q) => q.pointsOverride ?? q.question.scoring.points);
    const n = s.pickCount ? Math.min(s.pickCount, pts.length) : pts.length;
    totalQuestions += n;
    // Bila diambil acak N soal, total poin adalah perkiraan (rata-rata x N).
    const sum = pts.reduce((a, b) => a + b, 0);
    totalPoints += s.pickCount && pts.length ? (sum / pts.length) * n : sum;
  }
  return { ...exam, summary: { totalQuestions, totalPoints: Math.round(totalPoints * 100) / 100 } };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["exams"], querystring: PageQuery } }, async (req) => {
    const q = req.query;
    const where = q.q ? or(ilike(exams.code, likePattern(q.q)), ilike(exams.title, likePattern(q.q))) : undefined;
    const { limit, offset } = paginate(q);
    const qc = db
      .select({ examId: examSections.examId, n: count().as("n") })
      .from(examSectionQuestions)
      .innerJoin(examSections, eq(examSections.id, examSectionQuestions.sectionId))
      .groupBy(examSections.examId)
      .as("qc");
    const [items, [total]] = await Promise.all([
      db
        .select({
          id: exams.id,
          code: exams.code,
          title: exams.title,
          durationMinutes: exams.durationMinutes,
          status: exams.status,
          updatedAt: exams.updatedAt,
          questionCount: sql<number>`coalesce(${qc.n}, 0)::int`,
        })
        .from(exams)
        .leftJoin(qc, eq(qc.examId, exams.id))
        .where(where)
        .orderBy(desc(exams.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ n: count() }).from(exams).where(where),
    ]);
    return paged(items, total!.n, q);
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["exams"], params: IdParams } }, async (req) => {
    const exam = await loadExamStructure(req.params.id);
    if (!exam) throw app.httpErrors.notFound("Ujian tidak ditemukan");
    return exam;
  });

  app.post("/", { onRequest: app.requireUser("author"), schema: { tags: ["exams"], body: ExamInput } }, async (req, reply) => {
    const me = currentUser(req).sub;
    const exam = await db.transaction(async (tx) => {
      const [e] = await tx
        .insert(exams)
        .values({ ...req.body, description: req.body.description ?? null, instructions: req.body.instructions ?? null, createdBy: me })
        .returning();
      // Setiap ujian dimulai dengan satu bagian kosong.
      await tx.insert(examSections).values({ examId: e!.id, title: "Bagian 1", order: 0 });
      return e!;
    });
    await audit(db, { type: "user", id: me }, "exam.create", "exam", exam.id);
    return reply.status(201).send(exam);
  });

  app.patch(
    "/:id",
    { onRequest: app.requireUser("author"), schema: { tags: ["exams"], params: IdParams, body: ExamInput.partial() } },
    async (req) => {
      const [exam] = await db.update(exams).set(req.body).where(eq(exams.id, req.params.id)).returning();
      if (!exam) throw app.httpErrors.notFound("Ujian tidak ditemukan");
      return exam;
    },
  );

  /** Ganti seluruh struktur (bagian + daftar soal) secara atomik. */
  app.put(
    "/:id/structure",
    { onRequest: app.requireUser("author"), schema: { tags: ["exams"], params: IdParams, body: StructureInput } },
    async (req) => {
      const examId = req.params.id;
      const exam = await db.query.exams.findFirst({ where: eq(exams.id, examId) });
      if (!exam) throw app.httpErrors.notFound("Ujian tidak ditemukan");
      const { sections } = req.body;
      const allIds = sections.flatMap((s) => s.questions.map((q) => q.questionId));
      const dups = findDuplicates(allIds);
      if (dups.length) throw app.httpErrors.badRequest(`Soal dipakai lebih dari sekali: ${dups.join(", ")}`);
      if (allIds.length) {
        const found = await db
          .select({ id: questions.id, status: questions.status })
          .from(questions)
          .where(inArray(questions.id, allIds));
        const known = new Map(found.map((f) => [f.id, f.status]));
        const missing = allIds.filter((id) => !known.has(id));
        if (missing.length) throw app.httpErrors.badRequest(`Soal tidak ditemukan: ${missing.join(", ")}`);
        const archived = allIds.filter((id) => known.get(id) === "archived");
        if (archived.length) throw app.httpErrors.badRequest(`Soal berstatus arsip tidak bisa dipakai: ${archived.join(", ")}`);
      }
      sections.forEach((s, i) => {
        if (s.pickCount && s.pickCount > s.questions.length) {
          throw app.httpErrors.badRequest(`Bagian ${i + 1}: pickCount (${s.pickCount}) melebihi jumlah soal (${s.questions.length})`);
        }
      });

      await db.transaction(async (tx) => {
        await tx.delete(examSections).where(eq(examSections.examId, examId));
        for (const [order, s] of sections.entries()) {
          const [section] = await tx
            .insert(examSections)
            .values({
              examId,
              order,
              title: s.title,
              instructions: s.instructions ?? null,
              durationMinutes: s.durationMinutes ?? null,
              pickCount: s.pickCount ?? null,
              shuffleQuestions: s.shuffleQuestions,
            })
            .returning({ id: examSections.id });
          if (s.questions.length) {
            await tx.insert(examSectionQuestions).values(
              s.questions.map((q, i) => ({
                sectionId: section!.id,
                questionId: q.questionId,
                order: i,
                pointsOverride: q.pointsOverride ?? null,
              })),
            );
          }
        }
        await tx.update(exams).set({ updatedAt: new Date() }).where(eq(exams.id, examId));
      });
      await audit(db, { type: "user", id: currentUser(req).sub }, "exam.structure", "exam", examId, {
        sections: sections.length,
        questions: allIds.length,
      });
      return loadExamStructure(examId);
    },
  );

  app.delete("/:id", { onRequest: app.requireUser("admin"), schema: { tags: ["exams"], params: IdParams } }, async (req, reply) => {
    const res = await db.delete(exams).where(eq(exams.id, req.params.id)).returning({ id: exams.id });
    if (!res.length) throw app.httpErrors.notFound("Ujian tidak ditemukan");
    await audit(db, { type: "user", id: currentUser(req).sub }, "exam.delete", "exam", req.params.id);
    return reply.status(204).send();
  });
};

export default routes;
