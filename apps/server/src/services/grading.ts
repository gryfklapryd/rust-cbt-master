import { and, eq, inArray, sql } from "drizzle-orm";
import { QuestionDefinition, gradeResponse, type GradeResult } from "@cbt/shared";
import { db, type DbOrTx } from "../db/client.js";
import { attemptAnswers, attempts, examPackages, type AnswerGradeStatus, type PackageKeyEntry } from "../db/schema.js";

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/**
 * Nilai semua jawaban otomatis dalam satu attempt memakai snapshot kunci dari
 * paket yang diujikan, lalu hitung ulang total.
 *
 * - Nilai manual (uraian / unggah berkas yang sudah dikoreksi) tidak ditimpa.
 * - Soal yang ditampilkan tapi tidak dijawab dicatat sebagai `unanswered`.
 * - Idempoten: aman dijalankan berulang kali.
 */
export async function gradeAttempt(attemptId: string, opts: { force?: boolean } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    // Kunci baris attempt agar penilaian paralel untuk attempt yang sama tidak bertabrakan.
    const [attempt] = await tx.select().from(attempts).where(eq(attempts.id, attemptId)).for("update");
    if (!attempt) return;
    const [pkg] = await tx
      .select({ answerKeys: examPackages.answerKeys })
      .from(examPackages)
      .where(eq(examPackages.id, attempt.packageId));
    const keys = pkg?.answerKeys ?? {};

    // Soal yang disajikan ke peserta: urutan dari client, atau semua soal paket.
    const presented = attempt.questionOrder?.length ? attempt.questionOrder : Object.keys(keys);
    const existing = await tx.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId));
    const existingIds = new Set(existing.map((a) => a.questionId));
    const missing = presented.filter((id) => !existingIds.has(id) && keys[id]);
    if (missing.length) {
      await tx
        .insert(attemptAnswers)
        .values(missing.map((questionId) => ({ attemptId, questionId, response: null })))
        .onConflictDoNothing();
    }

    const rows = missing.length
      ? await tx.select().from(attemptAnswers).where(eq(attemptAnswers.attemptId, attemptId))
      : existing;

    for (const row of rows) {
      if (row.gradeStatus === "manual") continue; // sudah dikoreksi manual
      if (!opts.force && row.gradeStatus !== "pending") continue;
      const result = gradeWithKey(keys[row.questionId], row.response);
      await tx
        .update(attemptAnswers)
        .set({
          gradeStatus: result.status as AnswerGradeStatus,
          autoResult: result,
          score: result.score,
          maxScore: result.maxScore,
        })
        .where(and(eq(attemptAnswers.attemptId, attemptId), eq(attemptAnswers.questionId, row.questionId)));
    }

    await recomputeAttemptTotals(tx, attemptId);
  });
}

export function gradeWithKey(entry: PackageKeyEntry | undefined, response: unknown): GradeResult {
  if (!entry) {
    return { status: "invalid", score: 0, maxScore: 0, fraction: 0, correct: false, error: "Soal tidak ada di paket ujian" };
  }
  const def = QuestionDefinition.safeParse({ type: entry.type, content: entry.content, answerKey: entry.answerKey });
  if (!def.success) {
    return {
      status: "invalid",
      score: 0,
      maxScore: entry.scoring.points,
      fraction: 0,
      correct: false,
      error: "Definisi soal di paket tidak valid",
    };
  }
  return gradeResponse(def.data, entry.scoring, response);
}

/** Hitung ulang skor total, jumlah benar, dan status penilaian sebuah attempt. */
export async function recomputeAttemptTotals(tx: DbOrTx, attemptId: string): Promise<void> {
  const [agg] = await tx
    .select({
      score: sql<string | null>`sum(${attemptAnswers.score})`,
      maxScore: sql<string | null>`sum(${attemptAnswers.maxScore})`,
      pending: sql<number>`count(*) filter (where ${attemptAnswers.gradeStatus} in ('pending','pending_manual'))::int`,
      correct: sql<number>`count(*) filter (where ${attemptAnswers.maxScore} > 0 and ${attemptAnswers.score} >= ${attemptAnswers.maxScore})::int`,
      answered: sql<number>`count(*) filter (where ${attemptAnswers.gradeStatus} not in ('unanswered','pending'))::int`,
    })
    .from(attemptAnswers)
    .where(eq(attemptAnswers.attemptId, attemptId));
  const score = agg?.score !== null && agg?.score !== undefined ? Number(agg.score) : 0;
  const maxScore = agg?.maxScore !== null && agg?.maxScore !== undefined ? Number(agg.maxScore) : 0;
  const pending = agg?.pending ?? 0;
  await tx
    .update(attempts)
    .set({
      score: round(score),
      maxScore: round(maxScore),
      scaledScore: maxScore > 0 ? round((score / maxScore) * 100) : null,
      correctCount: agg?.correct ?? 0,
      answeredCount: agg?.answered ?? 0,
      gradingStatus: pending > 0 ? "partial" : "complete",
      gradedAt: new Date(),
    })
    .where(eq(attempts.id, attemptId));
}

/** Tandai ulang jawaban otomatis sebagai `pending` (mis. setelah kunci dikoreksi) — lalu worker menilai ulang. */
export async function resetAutoGrades(attemptIds: string[]): Promise<void> {
  if (!attemptIds.length) return;
  await db
    .update(attemptAnswers)
    .set({ gradeStatus: "pending" })
    .where(and(inArray(attemptAnswers.attemptId, attemptIds), sql`${attemptAnswers.gradeStatus} <> 'manual'`));
}
