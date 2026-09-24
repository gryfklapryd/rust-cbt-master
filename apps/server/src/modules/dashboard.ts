import { count, gte, sql } from "drizzle-orm";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { db } from "../db/client.js";
import { attemptAnswers, attempts, exams, participants, questions, schedules, sites, syncBatches } from "../db/schema.js";
import { getQueues } from "../lib/queue.js";

const routes: FastifyPluginAsyncZod = async (app) => {
  app.get("/", { onRequest: app.requireUser(), schema: { tags: ["dashboard"] } }, async () => {
    const onlineSince = new Date(Date.now() - 5 * 60 * 1000);
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const one = async <T>(p: Promise<T[]>) => (await p)[0]!;
    const [p, s, sOnline, q, e, sch, a, aToday, manual, batchFailed] = await Promise.all([
      one(db.select({ n: count() }).from(participants)),
      one(db.select({ n: count() }).from(sites)),
      one(db.select({ n: count() }).from(sites).where(gte(sites.lastSeenAt, onlineSince))),
      one(db.select({ n: count() }).from(questions)),
      one(db.select({ n: count() }).from(exams)),
      one(db.select({ n: count() }).from(schedules).where(gte(schedules.endAt, new Date()))),
      one(db.select({ n: count() }).from(attempts)),
      one(db.select({ n: count() }).from(attempts).where(gte(attempts.receivedAt, dayStart))),
      one(db.select({ n: count() }).from(attemptAnswers).where(sql`${attemptAnswers.gradeStatus} = 'pending_manual'`)),
      one(db.select({ n: count() }).from(syncBatches).where(sql`${syncBatches.status} = 'failed'`)),
    ]);
    const queues = getQueues();
    const queueStats = Object.fromEntries(
      await Promise.all(
        Object.entries(queues).map(async ([name, queue]) => [
          name,
          await queue.getJobCounts("waiting", "active", "delayed", "failed", "completed").catch(() => null),
        ]),
      ),
    );
    return {
      participants: p.n,
      sites: s.n,
      sitesOnline: sOnline.n,
      questions: q.n,
      exams: e.n,
      upcomingSchedules: sch.n,
      attempts: a.n,
      attemptsToday: aToday.n,
      pendingManualGrading: manual.n,
      failedBatches: batchFailed.n,
      queues: queueStats,
    };
  });
};

export default routes;
