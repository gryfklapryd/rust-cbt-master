import { and, arrayContains, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  QUESTION_TYPE_META,
  QUESTION_TYPES,
  QuestionDefinition,
  QuestionType,
  Scoring,
  gradeResponse,
  questionTemplate,
} from "@cbt/shared";
import { db } from "../db/client.js";
import { QUESTION_STATUSES, attemptAnswers, questions, stimuli } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate, ValidationError } from "../lib/http.js";
import { currentUser } from "../plugins/auth.js";

const QuestionMeta = z.object({
  bankId: z.uuid(),
  stimulusId: z.uuid().nullish(),
  code: z.string().trim().max(64).nullish(),
  difficulty: z.enum(["easy", "medium", "hard"]).nullish(),
  tags: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
  status: z.enum(QUESTION_STATUSES).default("draft"),
});

/** Body mentah: konten & kunci divalidasi terpisah dengan `QuestionDefinition` agar pesan error lebih jelas. */
const QuestionInput = QuestionMeta.extend({
  type: QuestionType,
  content: z.unknown(),
  answerKey: z.unknown(),
  scoring: z.unknown().optional(),
});

const ListQuery = PageQuery.extend({
  bankId: z.uuid().optional(),
  type: QuestionType.optional(),
  status: z.enum(QUESTION_STATUSES).optional(),
  tag: z.string().optional(),
  stimulusId: z.uuid().optional(),
  ids: z
    .string()
    .optional()
    .transform((s) => (s ? s.split(",").filter(Boolean) : undefined)),
});

export function parseDefinition(input: { type: string; content: unknown; answerKey: unknown; scoring?: unknown }) {
  const def = QuestionDefinition.safeParse({ type: input.type, content: input.content, answerKey: input.answerKey });
  if (!def.success) throw new ValidationError("Definisi soal tidak valid", def.error);
  const scoring = Scoring.safeParse(input.scoring ?? { mode: QUESTION_TYPE_META[def.data.type].defaultScoringMode });
  if (!scoring.success) throw new ValidationError("Pengaturan skor tidak valid", scoring.error);
  return { definition: def.data, scoring: scoring.data };
}

const routes: FastifyPluginAsyncZod = async (app) => {
  /** Katalog jenis soal + template contoh untuk editor. */
  app.get("/types", { onRequest: app.requireUser(), schema: { tags: ["questions"] } }, async () => {
    return QUESTION_TYPES.map((type) => ({ type, ...QUESTION_TYPE_META[type], template: questionTemplate(type) }));
  });

  /** Validasi definisi soal tanpa menyimpan. */
  app.post(
    "/validate",
    {
      onRequest: app.requireUser(),
      schema: { tags: ["questions"], body: z.object({ type: z.string(), content: z.unknown(), answerKey: z.unknown(), scoring: z.unknown().optional() }) },
    },
    async (req) => {
      try {
        const parsed = parseDefinition(req.body);
        return { valid: true, issues: [], ...parsed };
      } catch (err) {
        if (err instanceof ValidationError) return { valid: false, issues: err.issues };
        throw err;
      }
    },
  );

  /** Uji kunci: nilai sebuah jawaban terhadap definisi (tersimpan atau draf) tanpa menyimpan apa pun. */
  app.post(
    "/grade-preview",
    {
      onRequest: app.requireUser(),
      schema: {
        tags: ["questions"],
        body: z.object({
          type: z.string(),
          content: z.unknown(),
          answerKey: z.unknown(),
          scoring: z.unknown().optional(),
          response: z.unknown(),
        }),
      },
    },
    async (req) => {
      const { definition, scoring } = parseDefinition(req.body);
      return gradeResponse(definition, scoring, req.body.response);
    },
  );

  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["questions"], querystring: ListQuery } }, async (req) => {
    const q = req.query;
    const conds: SQL[] = [];
    if (q.bankId) conds.push(eq(questions.bankId, q.bankId));
    if (q.type) conds.push(eq(questions.type, q.type));
    if (q.status) conds.push(eq(questions.status, q.status));
    if (q.stimulusId) conds.push(eq(questions.stimulusId, q.stimulusId));
    if (q.tag) conds.push(arrayContains(questions.tags, [q.tag]));
    if (q.ids?.length) conds.push(inArray(questions.id, q.ids));
    if (q.q) {
      conds.push(or(ilike(questions.code, likePattern(q.q)), sql`${questions.content}->>'prompt' ilike ${likePattern(q.q)}`)!);
    }
    const where = conds.length ? and(...conds) : undefined;
    const { limit, offset } = paginate(q);
    const [items, [total]] = await Promise.all([
      db
        .select({
          id: questions.id,
          bankId: questions.bankId,
          stimulusId: questions.stimulusId,
          code: questions.code,
          type: questions.type,
          content: questions.content,
          scoring: questions.scoring,
          difficulty: questions.difficulty,
          tags: questions.tags,
          status: questions.status,
          version: questions.version,
          updatedAt: questions.updatedAt,
        })
        .from(questions)
        .where(where)
        .orderBy(asc(questions.code), desc(questions.createdAt))
        .limit(limit)
        .offset(offset),
      db.select({ n: count() }).from(questions).where(where),
    ]);
    return paged(items, total!.n, q);
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["questions"], params: IdParams } }, async (req) => {
    const question = await db.query.questions.findFirst({ where: eq(questions.id, req.params.id), with: { stimulus: true } });
    if (!question) throw app.httpErrors.notFound("Soal tidak ditemukan");
    return question;
  });

  async function assertStimulusInBank(stimulusId: string | null | undefined, bankId: string) {
    if (!stimulusId) return;
    const s = await db.query.stimuli.findFirst({ where: and(eq(stimuli.id, stimulusId), eq(stimuli.bankId, bankId)) });
    if (!s) throw app.httpErrors.badRequest("Stimulus tidak ditemukan di bank soal ini");
  }

  app.post("/", { onRequest: app.requireUser("author"), schema: { tags: ["questions"], body: QuestionInput } }, async (req, reply) => {
    const { definition, scoring } = parseDefinition(req.body);
    await assertStimulusInBank(req.body.stimulusId, req.body.bankId);
    const me = currentUser(req).sub;
    const [q] = await db
      .insert(questions)
      .values({
        bankId: req.body.bankId,
        stimulusId: req.body.stimulusId ?? null,
        code: req.body.code || null,
        difficulty: req.body.difficulty ?? null,
        tags: req.body.tags,
        status: req.body.status,
        type: definition.type,
        content: definition.content,
        answerKey: definition.answerKey,
        scoring,
        createdBy: me,
        updatedBy: me,
      })
      .returning();
    return reply.status(201).send(q);
  });

  app.patch(
    "/:id",
    {
      onRequest: app.requireUser("author"),
      schema: { tags: ["questions"], params: IdParams, body: QuestionInput.partial() },
    },
    async (req) => {
      const existing = await db.query.questions.findFirst({ where: eq(questions.id, req.params.id) });
      if (!existing) throw app.httpErrors.notFound("Soal tidak ditemukan");
      const b = req.body;
      const touchesDefinition = b.type !== undefined || b.content !== undefined || b.answerKey !== undefined || b.scoring !== undefined;
      const { definition, scoring } = parseDefinition({
        type: b.type ?? existing.type,
        content: b.content ?? existing.content,
        answerKey: b.answerKey ?? existing.answerKey,
        scoring: b.scoring ?? existing.scoring,
      });
      const bankId = b.bankId ?? existing.bankId;
      const stimulusId = b.stimulusId === undefined ? existing.stimulusId : b.stimulusId;
      await assertStimulusInBank(stimulusId, bankId);
      const changed =
        touchesDefinition &&
        JSON.stringify([definition, scoring]) !==
          JSON.stringify([{ type: existing.type, content: existing.content, answerKey: existing.answerKey }, existing.scoring]);
      const [q] = await db
        .update(questions)
        .set({
          bankId,
          stimulusId: stimulusId ?? null,
          ...(b.code !== undefined ? { code: b.code || null } : {}),
          ...(b.difficulty !== undefined ? { difficulty: b.difficulty ?? null } : {}),
          ...(b.tags !== undefined ? { tags: b.tags } : {}),
          ...(b.status !== undefined ? { status: b.status } : {}),
          type: definition.type,
          content: definition.content,
          answerKey: definition.answerKey,
          scoring,
          version: changed ? existing.version + 1 : existing.version,
          updatedBy: currentUser(req).sub,
        })
        .where(eq(questions.id, req.params.id))
        .returning();
      return q;
    },
  );

  app.delete("/:id", { onRequest: app.requireUser("author"), schema: { tags: ["questions"], params: IdParams } }, async (req, reply) => {
    const res = await db.delete(questions).where(eq(questions.id, req.params.id)).returning({ id: questions.id });
    if (!res.length) throw app.httpErrors.notFound("Soal tidak ditemukan");
    await audit(db, { type: "user", id: currentUser(req).sub }, "question.delete", "question", req.params.id);
    return reply.status(204).send();
  });

  app.post("/:id/duplicate", { onRequest: app.requireUser("author"), schema: { tags: ["questions"], params: IdParams } }, async (req, reply) => {
    const src = await db.query.questions.findFirst({ where: eq(questions.id, req.params.id) });
    if (!src) throw app.httpErrors.notFound("Soal tidak ditemukan");
    const me = currentUser(req).sub;
    const { id: _id, createdAt: _c, updatedAt: _u, version: _v, ...rest } = src;
    const [q] = await db
      .insert(questions)
      .values({ ...rest, code: src.code ? `${src.code}-copy-${Date.now().toString(36)}` : null, status: "draft", createdBy: me, updatedBy: me })
      .returning();
    return reply.status(201).send(q);
  });

  /** Impor banyak soal sekaligus (JSON). Semua divalidasi dulu; bila ada yang gagal, tidak ada yang disimpan. */
  app.post(
    "/import",
    {
      onRequest: app.requireUser("author"),
      schema: {
        tags: ["questions"],
        body: z.object({
          bankId: z.uuid(),
          questions: z.array(QuestionInput.omit({ bankId: true })).min(1).max(5_000),
        }),
      },
    },
    async (req) => {
      const me = currentUser(req).sub;
      const errors: { index: number; issues: { path: string; message: string }[] }[] = [];
      const rows = req.body.questions.flatMap((item, index) => {
        try {
          const { definition, scoring } = parseDefinition(item);
          return [
            {
              bankId: req.body.bankId,
              stimulusId: item.stimulusId ?? null,
              code: item.code || null,
              difficulty: item.difficulty ?? null,
              tags: item.tags,
              status: item.status,
              type: definition.type,
              content: definition.content,
              answerKey: definition.answerKey,
              scoring,
              createdBy: me,
              updatedBy: me,
            },
          ];
        } catch (err) {
          if (err instanceof ValidationError) {
            errors.push({ index, issues: err.issues });
            return [];
          }
          throw err;
        }
      });
      if (errors.length) {
        const e = app.httpErrors.badRequest(`${errors.length} soal tidak valid`);
        Object.assign(e, { issues: errors });
        throw e;
      }
      const inserted = await db.transaction(async (tx) => {
        const out: { id: string }[] = [];
        for (let i = 0; i < rows.length; i += 500) {
          out.push(...(await tx.insert(questions).values(rows.slice(i, i + 500)).returning({ id: questions.id })));
        }
        return out;
      });
      await audit(db, { type: "user", id: me }, "question.import", "bank", req.body.bankId, { count: inserted.length });
      return { imported: inserted.length, ids: inserted.map((r) => r.id) };
    },
  );

  /** Analisis butir sederhana dari jawaban yang sudah dinilai. */
  app.get("/:id/stats", { onRequest: app.requireUser(), schema: { tags: ["questions"], params: IdParams } }, async (req) => {
    const [row] = await db
      .select({
        responses: count(),
        answered: sql<number>`count(*) filter (where ${attemptAnswers.gradeStatus} not in ('unanswered','pending'))::int`,
        fullyCorrect: sql<number>`count(*) filter (where ${attemptAnswers.score} = ${attemptAnswers.maxScore} and ${attemptAnswers.maxScore} > 0)::int`,
        avgScore: sql<number | null>`avg(${attemptAnswers.score})::float`,
        avgMaxScore: sql<number | null>`avg(${attemptAnswers.maxScore})::float`,
        avgTimeSeconds: sql<number | null>`avg(${attemptAnswers.timeSpentSeconds})::float`,
      })
      .from(attemptAnswers)
      .where(eq(attemptAnswers.questionId, req.params.id));
    const r = row!;
    return {
      ...r,
      /** Tingkat kesukaran (p-value): rata-rata skor / skor maks. */
      difficultyIndex: r.avgScore !== null && r.avgMaxScore ? r.avgScore / r.avgMaxScore : null,
    };
  });
};

export default routes;
