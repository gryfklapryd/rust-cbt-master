import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  ExamPackage,
  PLACEHOLDER_ASSET_ID,
  QUESTION_TYPES,
  type AttemptUploadInput,
  type QuestionType,
  type ResultsBatchAck,
} from "@cbt/shared";
import type { App } from "../src/app.js";

// Modul yang membaca config diimpor dinamis SETELAH setup env (lihat vitest.config.ts).
const { buildApp } = await import("../src/app.js");
const { db, pool } = await import("../src/db/client.js");
const { runMigrations } = await import("../src/db/migrate.js");
const { users } = await import("../src/db/schema.js");
const { hashPassword } = await import("../src/lib/password.js");
const { closeQueues, getQueues } = await import("../src/lib/queue.js");
const { ensureBucket } = await import("../src/lib/storage.js");
const { buildPackage } = await import("../src/services/package-builder.js");
const { ingestBatch } = await import("../src/services/results-ingest.js");
const { gradeAttempt } = await import("../src/services/grading.js");

let app: App;
let adminToken = "";

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function api<T = any>(
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  url: string,
  body?: unknown,
  token = adminToken,
): Promise<{ status: number; body: T; headers: Record<string, unknown> }> {
  const res = await app.inject({
    method,
    url,
    headers: { ...auth(token), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
  return { status: res.statusCode, body: res.body ? (res.json() as T) : (undefined as T), headers: res.headers };
}

/** Jalankan job antrean yang menunggu secara sinkron (tanpa proses worker). */
async function drainQueues() {
  const q = getQueues();
  for (const job of await q.packageBuild.getJobs(["waiting", "delayed"])) {
    await buildPackage(job.data.packageId);
    await job.remove();
  }
  for (const job of await q.resultsIngest.getJobs(["waiting", "delayed"])) {
    await ingestBatch(job.data.batchId);
    await job.remove();
  }
  for (const job of await q.grading.getJobs(["waiting", "delayed"])) {
    await gradeAttempt(job.data.attemptId, { force: job.data.force });
    await job.remove();
  }
}

beforeAll(async () => {
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations();
  await ensureBucket();
  await Promise.all(Object.values(getQueues()).map((q) => q.obliterate({ force: true })));
  await db.insert(users).values({ username: "admin", name: "Admin", role: "admin", passwordHash: await hashPassword("rahasia123") });
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeQueues();
  await pool.end();
});

describe("alur lengkap server pusat", () => {
  const ctx: Record<string, any> = {};

  it("login admin & tolak tanpa token", async () => {
    const bad = await api("POST", "/api/auth/login", { username: "admin", password: "salah" }, "");
    expect(bad.status).toBe(401);
    const res = await api<{ token: string }>("POST", "/api/auth/login", { username: "admin", password: "rahasia123" }, "");
    expect(res.status).toBe(200);
    adminToken = res.body.token;
    expect((await api("GET", "/api/sites", undefined, "")).status).toBe(401);
    expect((await api("GET", "/api/auth/me")).body.username).toBe("admin");
  });

  it("peran author tidak boleh membuat lokasi", async () => {
    await api("POST", "/api/users", { username: "penulis", name: "Penulis", role: "author", password: "penulis123" });
    const login = await api<{ token: string }>("POST", "/api/auth/login", { username: "penulis", password: "penulis123" }, "");
    const res = await api("POST", "/api/sites", { code: "X", name: "X" }, login.body.token);
    expect(res.status).toBe(403);
  });

  it("buat lokasi, impor peserta", async () => {
    const site = await api("POST", "/api/sites", { code: "lab-1", name: "Lab 1" });
    expect(site.status).toBe(201);
    expect(site.body.code).toBe("LAB-1");
    expect(site.body.secret).toBeTruthy();
    ctx.site = site.body;

    const imp = await api("POST", "/api/participants/import", {
      rows: Array.from({ length: 5 }, (_, i) => ({
        number: `P-${i + 1}`,
        name: `Peserta ${i + 1}`,
        groupName: "A",
        siteCode: "LAB-1",
        ...(i === 0 ? { password: "khusus1" } : {}),
      })),
    });
    expect(imp.status).toBe(200);
    expect(imp.body).toMatchObject({ created: 5, updated: 0 });
    expect(imp.body.credentials).toHaveLength(5);
    expect(imp.body.credentials[0]).toMatchObject({ number: "P-1", password: "khusus1" });

    const again = await api("POST", "/api/participants/import", { rows: [{ number: "P-1", name: "Peserta Satu" }] });
    expect(again.body).toMatchObject({ created: 0, updated: 1, credentials: [] });
  });

  it("unggah aset lewat multipart", async () => {
    const form = new FormData();
    form.append("file", new Blob(['<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'], { type: "image/svg+xml" }), "peta.svg");
    const res = await app.inject({ method: "POST", url: "/api/assets", headers: auth(adminToken), body: form });
    expect(res.statusCode).toBe(201);
    ctx.asset = res.json();
    expect(ctx.asset.uri).toBe(`asset://${ctx.asset.id}`);

    const signed = await api("POST", "/api/assets/signed-urls", { ids: [ctx.asset.id] });
    const content = await app.inject({ method: "GET", url: signed.body[ctx.asset.id] });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/svg+xml");
    const forged = await app.inject({ method: "GET", url: `/api/assets/${ctx.asset.id}/content?exp=9999999999&sig=x` });
    expect(forged.statusCode).toBe(403);
  });

  it("bank soal berisi semua jenis soal", async () => {
    const bank = await api("POST", "/api/banks", { code: "ipa", name: "IPA" });
    expect(bank.status).toBe(201);
    ctx.bank = bank.body;

    const types = await api<{ type: QuestionType; template: { definition: any; scoring: any } }[]>("GET", "/api/questions/types");
    expect(types.body.map((t) => t.type)).toEqual([...QUESTION_TYPES]);

    ctx.questions = {} as Record<QuestionType, string>;
    for (const t of types.body) {
      const def = JSON.parse(JSON.stringify(t.template.definition).replaceAll(PLACEHOLDER_ASSET_ID, ctx.asset.id));
      const res = await api("POST", "/api/questions", {
        bankId: ctx.bank.id,
        code: t.type,
        type: t.type,
        content: def.content,
        answerKey: def.answerKey,
        scoring: t.template.scoring,
        status: "ready",
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      ctx.questions[t.type] = res.body.id;
    }

    const invalid = await api("POST", "/api/questions", {
      bankId: ctx.bank.id,
      type: "single_choice",
      content: { prompt: "x", options: [{ id: "A", content: "a" }, { id: "B", content: "b" }] },
      answerKey: { correctOptionId: "Z" },
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.issues.length).toBeGreaterThan(0);

    const preview = await api("POST", "/api/questions/grade-preview", {
      ...types.body.find((t) => t.type === "multiple_choice")!.template.definition,
      scoring: { points: 4, mode: "partial" },
      response: { optionIds: ["A"] },
    });
    expect(preview.body).toMatchObject({ status: "graded", score: 2 });
  });

  it("ujian, jadwal, terbitkan paket", async () => {
    const exam = await api("POST", "/api/exams", { code: "uts", title: "UTS IPA", durationMinutes: 60 });
    expect(exam.status).toBe(201);
    ctx.exam = exam.body;
    const qIds = Object.values(ctx.questions) as string[];
    const structure = await api("PUT", `/api/exams/${ctx.exam.id}/structure`, {
      sections: [
        { title: "A", questions: qIds.slice(0, 8).map((questionId) => ({ questionId })) },
        { title: "B", questions: qIds.slice(8).map((questionId) => ({ questionId })) },
      ],
    });
    expect(structure.status).toBe(200);
    expect(structure.body.summary.totalQuestions).toBe(15);

    const dup = await api("PUT", `/api/exams/${ctx.exam.id}/structure`, {
      sections: [{ title: "A", questions: [{ questionId: qIds[0] }, { questionId: qIds[0] }] }],
    });
    expect(dup.status).toBe(400);

    const now = Date.now();
    const schedule = await api("POST", "/api/schedules", {
      examId: ctx.exam.id,
      siteId: ctx.site.id,
      name: "Sesi 1",
      startAt: new Date(now - 3600_000).toISOString(),
      endAt: new Date(now + 3600_000).toISOString(),
      generateToken: true,
    });
    expect(schedule.status).toBe(201);
    expect(schedule.body.accessToken).toHaveLength(6);
    ctx.schedule = schedule.body;

    const add = await api("POST", `/api/schedules/${ctx.schedule.id}/participants`, { fromSite: true });
    expect(add.body.added).toBe(5);

    const pub = await api("POST", `/api/schedules/${ctx.schedule.id}/publish`);
    expect(pub.status).toBe(202);
    expect(pub.body).toMatchObject({ version: 1, status: "building" });
    await drainQueues();
    const detail = await api("GET", `/api/schedules/${ctx.schedule.id}`);
    expect(detail.body.packages[0]).toMatchObject({ version: 1, status: "ready", questionCount: 15, participantCount: 5, assetCount: 1 });
  });

  it("titik ujian: auth, daftar jadwal, unduh paket tanpa kunci jawaban, unduh aset", async () => {
    const bad = await api("POST", "/api/sync/auth", { siteCode: "LAB-1", secret: "salah" }, "");
    expect(bad.status).toBe(401);
    const res = await api("POST", "/api/sync/auth", { siteCode: "lab-1", secret: ctx.site.secret, deviceId: "PC-1" }, "");
    expect(res.status).toBe(200);
    ctx.siteToken = res.body.token;

    // Token lokasi tidak boleh dipakai untuk API admin.
    expect((await api("GET", "/api/sites", undefined, ctx.siteToken)).status).toBe(403);

    const list = await api("GET", "/api/sync/schedules", undefined, ctx.siteToken);
    expect(list.body.schedules).toHaveLength(1);
    const meta = list.body.schedules[0].package;
    expect(meta.version).toBe(1);

    const dl = await app.inject({ method: "GET", url: `/api/sync/schedules/${ctx.schedule.id}/package`, headers: auth(ctx.siteToken) });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers.etag).toBe(`"${meta.checksum}"`);
    const pkg = ExamPackage.parse(dl.json());
    ctx.pkg = pkg;
    expect(pkg.questions).toHaveLength(15);
    expect(pkg.participants).toHaveLength(5);
    expect(pkg.participants[0]!.passwordHash).toMatch(/^\$argon2id\$/);
    expect(pkg.schedule.accessTokenHash).toMatch(/^\$argon2id\$/);
    expect(dl.body).not.toContain("answerKey");
    expect(dl.body).not.toContain("correctOptionId");
    expect(dl.body).not.toContain(ctx.schedule.accessToken);

    const notModified = await app.inject({
      method: "GET",
      url: `/api/sync/schedules/${ctx.schedule.id}/package`,
      headers: { ...auth(ctx.siteToken), "if-none-match": `"${meta.checksum}"` },
    });
    expect(notModified.statusCode).toBe(304);

    const asset = await app.inject({ method: "GET", url: `/api/sync/assets/${ctx.asset.id}`, headers: auth(ctx.siteToken) });
    expect(asset.statusCode).toBe(200);
    const other = await app.inject({ method: "GET", url: `/api/sync/assets/${randomUUID()}`, headers: auth(ctx.siteToken) });
    expect(other.statusCode).toBe(404);
  });

  it("kirim hasil, proses antrean, nilai otomatis", async () => {
    const pkg = ctx.pkg as ExamPackage;
    const qid = (t: QuestionType) => ctx.questions[t] as string;
    const allCorrect: Record<QuestionType, unknown> = {
      single_choice: { optionId: "A" },
      multiple_choice: { optionIds: ["A", "C"] },
      true_false: { value: true },
      multiple_true_false: { values: { s1: true, s2: false, s3: true } },
      short_answer: { text: "Sukarno" },
      numeric: { value: 3.14 },
      essay: { text: "Air dan CO2 diubah menjadi glukosa dengan cahaya." },
      matching: { pairs: [{ leftId: "L1", rightId: "R1" }, { leftId: "L2", rightId: "R2" }, { leftId: "L3", rightId: "R3" }] },
      ordering: { order: ["b", "c", "a"] },
      fill_blanks: { values: { b1: "1945", b2: "o1", b3: "w1" } },
      categorization: { mapping: { i1: "mamalia", i2: "unggas", i3: "mamalia", i4: "unggas" } },
      hotspot: { points: [{ x: 0.35, y: 0.3 }] },
      hot_text: { segmentIds: ["t2", "t4"] },
      matrix: { selections: { r1: ["cair"], r2: ["padat"], r3: ["gas"] } },
      file_upload: { files: [] },
    };
    const attempt = (participantIdx: number, responses: Partial<Record<QuestionType, unknown>>, extra: Partial<AttemptUploadInput> = {}): AttemptUploadInput => ({
      attemptId: randomUUID(),
      packageId: pkg.packageId,
      scheduleId: pkg.schedule.id,
      participantId: pkg.participants[participantIdx]!.id,
      status: "submitted",
      sequence: 1,
      startedAt: new Date(Date.now() - 1800_000).toISOString(),
      finishedAt: new Date().toISOString(),
      questionOrder: pkg.questions.map((q) => q.id),
      answers: Object.entries(responses).map(([t, response]) => ({ questionId: qid(t as QuestionType), response, timeSpentSeconds: 20 })),
      events: [{ type: "violation", at: new Date().toISOString() }],
      ...extra,
    });

    const a1 = attempt(0, allCorrect);
    const a2 = attempt(1, { single_choice: { optionId: "B" }, essay: { text: "" } });
    const a3 = attempt(2, allCorrect, { status: "in_progress", finishedAt: null });
    const foreign = attempt(3, allCorrect, { participantId: randomUUID() });
    ctx.a1 = a1;
    ctx.a2 = a2;
    ctx.a3 = a3;

    const batchId = randomUUID();
    const res = await api<ResultsBatchAck>("POST", "/api/sync/results", { batchId, attempts: [a1, a2, a3, foreign] }, ctx.siteToken);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("received");

    // Kirim ulang batch sama -> idempoten
    const again = await api("POST", "/api/sync/results", { batchId, attempts: [a1] }, ctx.siteToken);
    expect(again.status).toBe(200);

    await drainQueues();
    const ack = await api<ResultsBatchAck>("GET", `/api/sync/results/${batchId}`, undefined, ctx.siteToken);
    expect(ack.body.status).toBe("processed");
    expect(ack.body.attempts!.filter((o) => o.accepted)).toHaveLength(3);
    expect(ack.body.attempts!.find((o) => o.attemptId === foreign.attemptId)).toMatchObject({ accepted: false });

    const r1 = await api("GET", `/api/results/attempts/${a1.attemptId}`);
    // 13 soal otomatis benar; uraian menunggu koreksi; unggah berkas kosong = 0
    expect(r1.body).toMatchObject({ gradingStatus: "partial", score: 13, maxScore: 15, violationCount: 1 });
    const r2 = await api("GET", `/api/results/attempts/${a2.attemptId}`);
    expect(r2.body).toMatchObject({ gradingStatus: "complete", score: 0, maxScore: 15, answeredCount: 1 });
    const r3 = await api("GET", `/api/results/attempts/${a3.attemptId}`);
    expect(r3.body).toMatchObject({ status: "in_progress", gradingStatus: "pending" });
  });

  it("sinkron ulang: sequence lama diabaikan, attempt ganda ditolak", async () => {
    const a3 = ctx.a3 as AttemptUploadInput;
    const final = { ...a3, sequence: 2, status: "submitted" as const, finishedAt: new Date().toISOString() };
    const stale = { ...a3, sequence: 1, status: "in_progress" as const };
    const dupe = { ...a3, attemptId: randomUUID(), sequence: 1 };
    const batchId = randomUUID();
    await api("POST", "/api/sync/results", { batchId, attempts: [final, stale, dupe] }, ctx.siteToken);
    await drainQueues();
    const ack = await api<ResultsBatchAck>("GET", `/api/sync/results/${batchId}`, undefined, ctx.siteToken);
    expect(ack.body.attempts![0]).toMatchObject({ accepted: true, reason: null });
    expect(ack.body.attempts![1]!.reason).toMatch(/lebih lama/);
    expect(ack.body.attempts![2]).toMatchObject({ accepted: false });
    const r3 = await api("GET", `/api/results/attempts/${a3.attemptId}`);
    expect(r3.body).toMatchObject({ status: "submitted", sequence: 2, score: 13 });
  });

  it("koreksi manual uraian dengan rubrik", async () => {
    const queue = await api("GET", `/api/results/manual-queue?scheduleId=${ctx.schedule.id}`);
    expect(queue.body.total).toBe(2);
    const item = queue.body.items.find((i: any) => i.attemptId === ctx.a1.attemptId);
    expect(item.question.answerKey.rubric).toHaveLength(3);
    const graded = await api("POST", "/api/results/manual-grade", {
      attemptId: item.attemptId,
      questionId: item.questionId,
      rubricScores: { r1: 1, r2: 1, r3: 1 },
    });
    expect(graded.body.score).toBe(1);
    const r1 = await api("GET", `/api/results/attempts/${ctx.a1.attemptId}`);
    expect(r1.body).toMatchObject({ gradingStatus: "complete", score: 14, scaledScore: 93.3333 });
  });

  it("koreksi kunci setelah ujian + nilai ulang", async () => {
    // Ubah kunci pilihan ganda menjadi B.
    const q = await api("GET", `/api/questions/${ctx.questions.single_choice}`);
    const upd = await api("PATCH", `/api/questions/${ctx.questions.single_choice}`, { answerKey: { correctOptionId: "B" } });
    expect(upd.body.version).toBe(q.body.version + 1);

    // Tanpa refreshKeys, snapshot paket tetap dipakai -> skor tidak berubah.
    await api("POST", "/api/results/regrade", { scheduleId: ctx.schedule.id });
    await drainQueues();
    expect((await api("GET", `/api/results/attempts/${ctx.a1.attemptId}`)).body.score).toBe(14);

    const res = await api("POST", "/api/results/regrade", { scheduleId: ctx.schedule.id, refreshKeys: true });
    expect(res.body.refreshedPackages).toBe(1);
    await drainQueues();
    const r1 = await api("GET", `/api/results/attempts/${ctx.a1.attemptId}`);
    const r2 = await api("GET", `/api/results/attempts/${ctx.a2.attemptId}`);
    expect(r1.body.score).toBe(13); // pilihan ganda kini salah; nilai uraian manual tetap
    expect(r2.body.score).toBe(1); // jawaban B kini benar
    const summary = await api("GET", `/api/results/summary?scheduleId=${ctx.schedule.id}`);
    expect(summary.body.attempts).toBe(3);

    const csv = await app.inject({ method: "GET", url: `/api/results/attempts/export.csv?scheduleId=${ctx.schedule.id}`, headers: auth(adminToken) });
    expect(csv.statusCode).toBe(200);
    expect(csv.body.split("\n")).toHaveLength(4);
  });

  it("unggah lampiran jawaban idempoten", async () => {
    const id = randomUUID();
    const send = () => {
      const form = new FormData();
      form.append("attachmentId", id);
      form.append("file", new Blob(["isi berkas"], { type: "application/pdf" }), "jawaban.pdf");
      return app.inject({ method: "POST", url: "/api/sync/attachments", headers: auth(ctx.siteToken), body: form });
    };
    expect((await send()).statusCode).toBe(201);
    const second = await send();
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ id, filename: "jawaban.pdf", size: 10 });
  });

  it("proktor: penugasan ke lokasi, akun untuk server lokal, log aksi", async () => {
    const proctor = await api("POST", "/api/users", { username: "proktor1", name: "Proktor Satu", role: "proctor", password: "proktor123" });
    expect(proctor.status).toBe(201);
    const author = await api("GET", "/api/users?role=author");
    expect(author.body.items.map((u: { username: string }) => u.username)).toEqual(["penulis"]);

    // Hanya proktor/admin yang boleh ditugaskan.
    const wrong = await api("PUT", `/api/sites/${ctx.site.id}/proctors`, { userIds: [author.body.items[0].id] });
    expect(wrong.status).toBe(400);
    const set = await api("PUT", `/api/sites/${ctx.site.id}/proctors`, { userIds: [proctor.body.id, proctor.body.id] });
    expect(set.status).toBe(200);
    expect(set.body.proctors).toHaveLength(1);
    const site = await api("GET", `/api/sites/${ctx.site.id}`);
    expect(site.body.proctors[0]).toMatchObject({ username: "proktor1" });

    const list = await api("GET", "/api/sync/proctors", undefined, ctx.siteToken);
    expect(list.status).toBe(200);
    expect(list.body.proctors).toHaveLength(1);
    expect(list.body.proctors[0]).toMatchObject({ username: "proktor1", role: "proctor" });
    expect(list.body.proctors[0].passwordHash).toMatch(/^\$argon2id\$/);

    // Jadwal untuk server lokal membawa token sesi asli (ditampilkan di dasbor proktor).
    const schedules = await api("GET", "/api/sync/schedules", undefined, ctx.siteToken);
    expect(schedules.body.schedules[0].accessToken).toBe(ctx.schedule.accessToken);

    const entry = {
      id: randomUUID(),
      at: new Date().toISOString(),
      proctorId: proctor.body.id,
      username: "proktor1",
      action: "attempt_extra_time",
      scheduleId: ctx.schedule.id,
      attemptId: randomUUID(),
      data: { minutes: 10 },
    };
    const log = await api("POST", "/api/sync/proctor-log", { entries: [entry] }, ctx.siteToken);
    expect(log.body).toEqual({ received: 1, inserted: 1 });
    const again = await api("POST", "/api/sync/proctor-log", { entries: [entry] }, ctx.siteToken);
    expect(again.body).toEqual({ received: 1, inserted: 0 });
    const actions = await api("GET", `/api/sites/${ctx.site.id}/proctor-actions`);
    expect(actions.body.total).toBe(1);
    expect(actions.body.items[0]).toMatchObject({ action: "attempt_extra_time", username: "proktor1", data: { minutes: 10 } });

    // Proktor nonaktif tidak lagi dikirim ke server lokal.
    await api("PATCH", `/api/users/${proctor.body.id}`, { active: false });
    expect((await api("GET", "/api/sync/proctors", undefined, ctx.siteToken)).body.proctors).toHaveLength(0);
  });

  it("jadwal dengan hasil tidak bisa dihapus", async () => {
    const res = await api("DELETE", `/api/schedules/${ctx.schedule.id}`);
    expect(res.status).toBe(409);
  });
});
