import { and, asc, eq, inArray, ne } from "drizzle-orm";
import {
  ExamPackage,
  ExamSettings,
  PACKAGE_FORMAT_VERSION,
  QuestionDefinition,
  Scoring,
  StimulusSettings,
  collectAssetIds,
  type PackageQuestion,
} from "@cbt/shared";
import { db } from "../db/client.js";
import {
  assets,
  examPackages,
  examSectionQuestions,
  examSections,
  exams,
  participants,
  questions,
  scheduleParticipants,
  schedules,
  sites,
  stimuli,
  type PackageKeyEntry,
} from "../db/schema.js";
import { hashPasswordLight } from "../lib/password.js";
import { putObject, sha256 } from "../lib/storage.js";

export class PackageBuildError extends Error {}

/**
 * Bangun paket ujian untuk satu jadwal dan simpan ke object storage.
 *
 * Paket berisi snapshot soal (tanpa kunci), stimulus, peserta, dan daftar aset.
 * Kunci jawaban versi yang sama disimpan di `exam_packages.answer_keys` sehingga
 * penilaian selalu memakai kunci yang cocok dengan soal yang diujikan, walaupun
 * soal di bank diubah setelahnya.
 */
export async function buildPackage(packageId: string): Promise<void> {
  const pkg = await db.query.examPackages.findFirst({ where: eq(examPackages.id, packageId) });
  if (!pkg) throw new PackageBuildError(`Paket ${packageId} tidak ditemukan`);
  if (pkg.status === "ready") return; // idempoten

  try {
    const built = await composePackage(pkg.scheduleId, pkg.id, pkg.version);
    const json = JSON.stringify(built.package);
    const checksum = sha256(json);
    const objectKey = `packages/${pkg.scheduleId}/${pkg.id}.json`;
    await putObject(objectKey, json, "application/json");

    await db.transaction(async (tx) => {
      await tx
        .update(examPackages)
        .set({ status: "superseded" })
        .where(and(eq(examPackages.scheduleId, pkg.scheduleId), eq(examPackages.status, "ready"), ne(examPackages.id, pkg.id)));
      await tx
        .update(examPackages)
        .set({
          status: "ready",
          objectKey,
          checksum,
          size: Buffer.byteLength(json),
          questionCount: built.package.questions.length,
          participantCount: built.package.participants.length,
          assetCount: built.package.assets.length,
          assetIds: built.package.assets.map((a) => a.id),
          answerKeys: built.answerKeys,
          builtAt: new Date(built.package.builtAt),
          error: null,
        })
        .where(eq(examPackages.id, pkg.id));
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(examPackages).set({ status: "failed", error: message }).where(eq(examPackages.id, pkg.id));
    // Kesalahan data (bukan infrastruktur) tidak perlu dicoba ulang oleh antrean.
    if (err instanceof PackageBuildError) return;
    throw err;
  }
}

async function composePackage(scheduleId: string, packageId: string, version: number) {
  const schedule = await db.query.schedules.findFirst({ where: eq(schedules.id, scheduleId) });
  if (!schedule) throw new PackageBuildError("Jadwal tidak ditemukan");
  const [site] = await db.select().from(sites).where(eq(sites.id, schedule.siteId));
  const [exam] = await db.select().from(exams).where(eq(exams.id, schedule.examId));
  if (!site || !exam) throw new PackageBuildError("Lokasi atau ujian untuk jadwal ini tidak ditemukan");

  const sections = await db.select().from(examSections).where(eq(examSections.examId, exam.id)).orderBy(asc(examSections.order));
  const sectionQuestions = sections.length
    ? await db
        .select()
        .from(examSectionQuestions)
        .where(inArray(examSectionQuestions.sectionId, sections.map((s) => s.id)))
        .orderBy(asc(examSectionQuestions.order))
    : [];
  if (!sectionQuestions.length) throw new PackageBuildError("Ujian belum memiliki soal");

  const questionIds = sectionQuestions.map((sq) => sq.questionId);
  const questionRows = await db.select().from(questions).where(inArray(questions.id, questionIds));
  const questionById = new Map(questionRows.map((q) => [q.id, q]));

  const answerKeys: Record<string, PackageKeyEntry> = {};
  const packageQuestions: PackageQuestion[] = [];
  const problems: string[] = [];
  for (const sq of sectionQuestions) {
    const q = questionById.get(sq.questionId);
    if (!q) {
      problems.push(`Soal ${sq.questionId} tidak ditemukan`);
      continue;
    }
    const def = QuestionDefinition.safeParse({ type: q.type, content: q.content, answerKey: q.answerKey });
    if (!def.success) {
      problems.push(`Soal ${q.code ?? q.id} tidak valid: ${def.error.issues.map((i) => i.message).join("; ")}`);
      continue;
    }
    const scoring = Scoring.parse({ ...q.scoring, ...(sq.pointsOverride !== null ? { points: sq.pointsOverride } : {}) });
    answerKeys[q.id] = { type: def.data.type, version: q.version, content: def.data.content, answerKey: def.data.answerKey, scoring };
    packageQuestions.push({
      id: q.id,
      type: def.data.type,
      content: def.data.content,
      points: scoring.points,
      stimulusId: q.stimulusId,
      version: q.version,
    });
  }
  if (problems.length) throw new PackageBuildError(problems.join("\n"));

  const stimulusIds = [...new Set(questionRows.map((q) => q.stimulusId).filter((id): id is string => !!id))];
  const stimulusRows = stimulusIds.length ? await db.select().from(stimuli).where(inArray(stimuli.id, stimulusIds)) : [];

  const participantRows = await db
    .select({
      id: participants.id,
      number: participants.number,
      name: participants.name,
      groupName: participants.groupName,
      gender: participants.gender,
      birthDate: participants.birthDate,
      passwordHash: participants.passwordHash,
      photoAssetId: participants.photoAssetId,
      active: participants.active,
    })
    .from(scheduleParticipants)
    .innerJoin(participants, eq(participants.id, scheduleParticipants.participantId))
    .where(eq(scheduleParticipants.scheduleId, scheduleId))
    .orderBy(asc(participants.number));
  const activeParticipants = participantRows.filter((p) => p.active);
  if (!activeParticipants.length) throw new PackageBuildError("Jadwal belum memiliki peserta aktif");

  // Kumpulkan semua aset yang dirujuk.
  const assetIds = new Set<string>();
  collectAssetIds(packageQuestions.map((q) => q.content), assetIds);
  collectAssetIds(stimulusRows.map((s) => s.content), assetIds);
  collectAssetIds([exam.instructions, exam.description, ...sections.map((s) => s.instructions)], assetIds);
  for (const p of activeParticipants) if (p.photoAssetId) assetIds.add(p.photoAssetId);
  const assetRows = assetIds.size ? await db.select().from(assets).where(inArray(assets.id, [...assetIds])) : [];
  const missingAssets = [...assetIds].filter((id) => !assetRows.some((a) => a.id === id));
  if (missingAssets.length) throw new PackageBuildError(`Aset tidak ditemukan: ${missingAssets.join(", ")}`);

  const pkg: ExamPackage = {
    formatVersion: PACKAGE_FORMAT_VERSION,
    packageId,
    version,
    builtAt: new Date().toISOString(),
    site: { id: site.id, code: site.code, name: site.name },
    schedule: {
      id: schedule.id,
      name: schedule.name,
      startAt: schedule.startAt.toISOString(),
      endAt: schedule.endAt.toISOString(),
      lateEntryMinutes: schedule.lateEntryMinutes,
      accessTokenHash: schedule.accessToken ? await hashPasswordLight(schedule.accessToken) : null,
    },
    exam: {
      id: exam.id,
      code: exam.code,
      title: exam.title,
      description: exam.description,
      instructions: exam.instructions,
      durationMinutes: exam.durationMinutes,
      settings: ExamSettings.parse(exam.settings),
      sections: sections.map((s) => ({
        id: s.id,
        title: s.title,
        instructions: s.instructions,
        order: s.order,
        durationMinutes: s.durationMinutes,
        pickCount: s.pickCount,
        shuffleQuestions: s.shuffleQuestions,
        questionIds: sectionQuestions.filter((sq) => sq.sectionId === s.id).map((sq) => sq.questionId),
      })),
    },
    questions: packageQuestions,
    stimuli: stimulusRows.map((s) => ({
      id: s.id,
      title: s.title,
      content: s.content,
      settings: StimulusSettings.parse(s.settings ?? {}),
    })),
    participants: activeParticipants.map(({ active: _a, ...p }) => p),
    assets: assetRows.map((a) => ({ id: a.id, filename: a.filename, mime: a.mime, size: a.size, sha256: a.sha256 })),
  };

  // Pastikan paket sesuai kontrak sebelum dikirim.
  const check = ExamPackage.safeParse(pkg);
  if (!check.success) {
    throw new PackageBuildError(`Paket tidak sesuai kontrak: ${check.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return { package: pkg, answerKeys };
}
