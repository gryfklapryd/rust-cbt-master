import { and, eq, sql } from "drizzle-orm";
import { ResultsBatch, type AttemptUpload } from "@cbt/shared";
import { db, type Tx } from "../db/client.js";
import {
  attemptAnswers,
  attemptEvents,
  attempts,
  examPackages,
  scheduleParticipants,
  schedules,
  syncBatches,
  type BatchAttemptOutcome,
} from "../db/schema.js";
import { enqueueGrading } from "../lib/queue.js";
import { getObjectBuffer } from "../lib/storage.js";

/** Status akhir yang memicu penilaian. */
const FINAL_STATUSES = new Set(["submitted", "timed_out", "terminated"]);

class Rejected extends Error {}

/**
 * Proses satu batch hasil ujian yang sudah diterima (payload mentah ada di object storage).
 * Setiap attempt diproses di transaksi sendiri sehingga satu attempt bermasalah
 * tidak menggagalkan attempt lain di batch yang sama.
 */
export async function ingestBatch(batchId: string): Promise<void> {
  const batch = await db.query.syncBatches.findFirst({ where: eq(syncBatches.id, batchId) });
  if (!batch || batch.status === "processed") return;
  await db.update(syncBatches).set({ status: "processing" }).where(eq(syncBatches.id, batchId));

  let payload: ResultsBatch;
  try {
    payload = ResultsBatch.parse(JSON.parse((await getObjectBuffer(batch.objectKey)).toString("utf8")));
  } catch (err) {
    await db
      .update(syncBatches)
      .set({ status: "failed", error: `Payload tidak bisa dibaca: ${(err as Error).message}`, processedAt: new Date() })
      .where(eq(syncBatches.id, batchId));
    return;
  }

  const outcomes: BatchAttemptOutcome[] = [];
  const toGrade: string[] = [];
  for (const attempt of payload.attempts) {
    try {
      const graded = await db.transaction((tx) => upsertAttempt(tx, batch.siteId, batchId, attempt));
      outcomes.push({ attemptId: attempt.attemptId, accepted: true, reason: graded.stale ? "Data lebih lama dari yang tersimpan (diabaikan)" : null });
      if (graded.grade) toGrade.push(attempt.attemptId);
    } catch (err) {
      if (!(err instanceof Rejected)) throw err; // error infrastruktur -> job dicoba ulang
      outcomes.push({ attemptId: attempt.attemptId, accepted: false, reason: err.message });
    }
  }

  for (const id of toGrade) await enqueueGrading(id);

  await db
    .update(syncBatches)
    .set({ status: "processed", outcomes, processedAt: new Date(), error: null })
    .where(eq(syncBatches.id, batchId));
}

async function upsertAttempt(
  tx: Tx,
  siteId: string,
  batchId: string,
  a: AttemptUpload,
): Promise<{ grade: boolean; stale: boolean }> {
  const [schedule] = await tx.select().from(schedules).where(eq(schedules.id, a.scheduleId));
  if (!schedule) throw new Rejected("Jadwal tidak ditemukan");
  if (schedule.siteId !== siteId) throw new Rejected("Jadwal bukan milik lokasi ini");

  const [pkg] = await tx
    .select({ id: examPackages.id, scheduleId: examPackages.scheduleId, answerKeys: examPackages.answerKeys })
    .from(examPackages)
    .where(eq(examPackages.id, a.packageId));
  if (!pkg || pkg.scheduleId !== a.scheduleId) throw new Rejected("Paket tidak cocok dengan jadwal");

  const [assigned] = await tx
    .select({ participantId: scheduleParticipants.participantId })
    .from(scheduleParticipants)
    .where(and(eq(scheduleParticipants.scheduleId, a.scheduleId), eq(scheduleParticipants.participantId, a.participantId)));
  if (!assigned) throw new Rejected("Peserta tidak terdaftar di jadwal ini");

  const [current] = await tx.select().from(attempts).where(eq(attempts.id, a.attemptId)).for("update");
  if (current) {
    if (current.scheduleId !== a.scheduleId || current.participantId !== a.participantId) {
      throw new Rejected("attemptId sudah dipakai untuk peserta/jadwal lain");
    }
    if (a.sequence < current.sequence) return { grade: false, stale: true };
  } else {
    const [other] = await tx
      .select({ id: attempts.id })
      .from(attempts)
      .where(and(eq(attempts.scheduleId, a.scheduleId), eq(attempts.participantId, a.participantId)));
    if (other) {
      throw new Rejected(
        "Peserta sudah memiliki attempt lain di jadwal ini. Hapus/reset attempt lama di panel admin bila memang mengulang.",
      );
    }
  }

  const keys = pkg.answerKeys ?? {};
  const values = {
    id: a.attemptId,
    scheduleId: a.scheduleId,
    participantId: a.participantId,
    packageId: a.packageId,
    siteId,
    status: a.status,
    sequence: a.sequence,
    startedAt: new Date(a.startedAt),
    finishedAt: a.finishedAt ? new Date(a.finishedAt) : null,
    questionOrder: a.questionOrder?.filter((id) => keys[id]) ?? null,
    optionOrders: a.optionOrders ?? null,
    client: a.client ?? null,
    lastBatchId: batchId,
  };
  if (current) {
    await tx
      .update(attempts)
      .set({ ...values, receivedAt: new Date() })
      .where(eq(attempts.id, a.attemptId));
  } else {
    await tx.insert(attempts).values(values);
  }

  // Jawaban: hanya untuk soal yang ada di paket. Bila jawaban berubah, nilai direset ke `pending`.
  const answers = a.answers.filter((ans) => keys[ans.questionId]);
  if (answers.length) {
    await tx
      .insert(attemptAnswers)
      .values(
        answers.map((ans) => ({
          attemptId: a.attemptId,
          questionId: ans.questionId,
          response: ans.response ?? null,
          answeredAt: ans.answeredAt ? new Date(ans.answeredAt) : null,
          timeSpentSeconds: ans.timeSpentSeconds ?? null,
          flagged: ans.flagged ?? false,
          changeCount: ans.changeCount ?? null,
        })),
      )
      .onConflictDoUpdate({
        target: [attemptAnswers.attemptId, attemptAnswers.questionId],
        set: {
          answeredAt: sql`excluded.answered_at`,
          timeSpentSeconds: sql`excluded.time_spent_seconds`,
          flagged: sql`excluded.flagged`,
          changeCount: sql`excluded.change_count`,
          // PostgreSQL mengevaluasi semua ekspresi SET terhadap baris lama, jadi perbandingan
          // `attempt_answers.response` di bawah memakai jawaban sebelumnya.
          gradeStatus: sql`case when ${attemptAnswers.response} is distinct from excluded.response then 'pending' else ${attemptAnswers.gradeStatus} end`,
          manualScore: sql`case when ${attemptAnswers.response} is distinct from excluded.response then null else ${attemptAnswers.manualScore} end`,
          rubricScores: sql`case when ${attemptAnswers.response} is distinct from excluded.response then null else ${attemptAnswers.rubricScores} end`,
          response: sql`excluded.response`,
        },
      });
  }

  if (a.events.length) {
    for (let i = 0; i < a.events.length; i += 1_000) {
      await tx
        .insert(attemptEvents)
        .values(
          a.events.slice(i, i + 1_000).map((e) => ({
            attemptId: a.attemptId,
            type: e.type,
            at: new Date(e.at),
            data: e.data ?? null,
          })),
        )
        .onConflictDoNothing();
    }
  }
  const [v] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(attemptEvents)
    .where(and(eq(attemptEvents.attemptId, a.attemptId), eq(attemptEvents.type, "violation")));
  await tx.update(attempts).set({ violationCount: v?.n ?? 0 }).where(eq(attempts.id, a.attemptId));

  return { grade: FINAL_STATUSES.has(a.status), stale: false };
}
