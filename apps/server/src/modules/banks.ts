import { and, asc, count, desc, eq, ilike, or, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { StimulusSettings } from "@cbt/shared";
import { db } from "../db/client.js";
import { questionBanks, questions, stimuli } from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { IdParams, likePattern, PageQuery, paged, paginate } from "../lib/http.js";
import { currentUser } from "../plugins/auth.js";

const BankInput = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/)
    .transform((s) => s.toUpperCase()),
  name: z.string().min(1).max(200),
  subject: z.string().max(200).nullish(),
  description: z.string().max(5_000).nullish(),
});

const StimulusInput = z.object({
  title: z.string().min(1).max(500),
  content: z.string().min(1).max(500_000),
  settings: StimulusSettings.default({ mediaPlayLimit: 0 }),
});

const BankStimulusParams = z.object({ id: z.uuid(), stimulusId: z.uuid() });

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["banks"], querystring: PageQuery } }, async (req) => {
    const q = req.query;
    const where = q.q
      ? or(ilike(questionBanks.code, likePattern(q.q)), ilike(questionBanks.name, likePattern(q.q)), ilike(questionBanks.subject, likePattern(q.q)))
      : undefined;
    const { limit, offset } = paginate(q);
    const questionCount = db
      .select({ bankId: questions.bankId, n: count().as("n") })
      .from(questions)
      .groupBy(questions.bankId)
      .as("qc");
    const [items, [total]] = await Promise.all([
      db
        .select({
          id: questionBanks.id,
          code: questionBanks.code,
          name: questionBanks.name,
          subject: questionBanks.subject,
          description: questionBanks.description,
          createdAt: questionBanks.createdAt,
          updatedAt: questionBanks.updatedAt,
          questionCount: sql<number>`coalesce(${questionCount.n}, 0)::int`,
        })
        .from(questionBanks)
        .leftJoin(questionCount, eq(questionCount.bankId, questionBanks.id))
        .where(where)
        .orderBy(desc(questionBanks.updatedAt))
        .limit(limit)
        .offset(offset),
      db.select({ n: count() }).from(questionBanks).where(where),
    ]);
    return paged(items, total!.n, q);
  });

  app.get("/:id", { onRequest: app.requireUser(), schema: { tags: ["banks"], params: IdParams } }, async (req) => {
    const bank = await db.query.questionBanks.findFirst({ where: eq(questionBanks.id, req.params.id) });
    if (!bank) throw app.httpErrors.notFound("Bank soal tidak ditemukan");
    const byType = await db
      .select({ type: questions.type, n: count() })
      .from(questions)
      .where(eq(questions.bankId, bank.id))
      .groupBy(questions.type);
    return { ...bank, stats: Object.fromEntries(byType.map((r) => [r.type, r.n])) };
  });

  app.post("/", { onRequest: app.requireUser("author"), schema: { tags: ["banks"], body: BankInput } }, async (req, reply) => {
    const [bank] = await db
      .insert(questionBanks)
      .values({ ...req.body, subject: req.body.subject ?? null, description: req.body.description ?? null, createdBy: currentUser(req).sub })
      .returning();
    await audit(db, { type: "user", id: currentUser(req).sub }, "bank.create", "bank", bank!.id);
    return reply.status(201).send(bank);
  });

  app.patch(
    "/:id",
    { onRequest: app.requireUser("author"), schema: { tags: ["banks"], params: IdParams, body: BankInput.partial() } },
    async (req) => {
      const [bank] = await db.update(questionBanks).set(req.body).where(eq(questionBanks.id, req.params.id)).returning();
      if (!bank) throw app.httpErrors.notFound("Bank soal tidak ditemukan");
      return bank;
    },
  );

  app.delete("/:id", { onRequest: app.requireUser("admin"), schema: { tags: ["banks"], params: IdParams } }, async (req, reply) => {
    const res = await db.delete(questionBanks).where(eq(questionBanks.id, req.params.id)).returning({ id: questionBanks.id });
    if (!res.length) throw app.httpErrors.notFound("Bank soal tidak ditemukan");
    await audit(db, { type: "user", id: currentUser(req).sub }, "bank.delete", "bank", req.params.id);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- stimulus
  app.get("/:id/stimuli", { onRequest: app.requireUser(), schema: { tags: ["banks"], params: IdParams } }, async (req) => {
    return db.select().from(stimuli).where(eq(stimuli.bankId, req.params.id)).orderBy(asc(stimuli.title));
  });

  app.post(
    "/:id/stimuli",
    { onRequest: app.requireUser("author"), schema: { tags: ["banks"], params: IdParams, body: StimulusInput } },
    async (req, reply) => {
      const [s] = await db
        .insert(stimuli)
        .values({ ...req.body, bankId: req.params.id })
        .returning();
      return reply.status(201).send(s);
    },
  );

  app.patch(
    "/:id/stimuli/:stimulusId",
    {
      onRequest: app.requireUser("author"),
      schema: { tags: ["banks"], params: BankStimulusParams, body: StimulusInput.partial() },
    },
    async (req) => {
      const [s] = await db
        .update(stimuli)
        .set(req.body)
        .where(and(eq(stimuli.id, req.params.stimulusId), eq(stimuli.bankId, req.params.id)))
        .returning();
      if (!s) throw app.httpErrors.notFound("Stimulus tidak ditemukan");
      return s;
    },
  );

  app.delete(
    "/:id/stimuli/:stimulusId",
    { onRequest: app.requireUser("author"), schema: { tags: ["banks"], params: BankStimulusParams } },
    async (req, reply) => {
      const res = await db
        .delete(stimuli)
        .where(and(eq(stimuli.id, req.params.stimulusId), eq(stimuli.bankId, req.params.id)))
        .returning({ id: stimuli.id });
      if (!res.length) throw app.httpErrors.notFound("Stimulus tidak ditemukan");
      return reply.status(204).send();
    },
  );
};

export default routes;
