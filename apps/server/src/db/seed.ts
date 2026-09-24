/**
 * Seed database.
 *
 *   pnpm db:seed           -> buat admin awal (bila belum ada user)
 *   pnpm db:seed --demo    -> + data contoh: lokasi, peserta, bank soal berisi
 *                             semua jenis soal, ujian, dan jadwal yang sudah terbit
 */
import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { ExamSettings, PLACEHOLDER_ASSET_ID, QUESTION_TYPES, Scoring, questionTemplate } from "@cbt/shared";
import { config } from "../config.js";
import { closeQueues } from "../lib/queue.js";
import { hashPassword, hashPasswordLight } from "../lib/password.js";
import { ensureBucket, putObject, sha256 } from "../lib/storage.js";
import { publishSchedule } from "../modules/schedules.js";
import { db, pool } from "./client.js";
import { runMigrations } from "./migrate.js";
import {
  assets,
  examSectionQuestions,
  examSections,
  exams,
  participants,
  questionBanks,
  questions,
  scheduleParticipants,
  schedules,
  sites,
  stimuli,
  users,
} from "./schema.js";

const DEMO_SITE_SECRET = "demo-secret-ganti-saya";
const DEMO_PARTICIPANT_PASSWORD = "123456";

async function seedAdmin() {
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(users);
  if (n > 0) {
    console.log("• User sudah ada, admin awal tidak dibuat");
    return (await db.query.users.findFirst({ where: eq(users.role, "admin") }))?.id ?? null;
  }
  const [admin] = await db
    .insert(users)
    .values({
      username: config.BOOTSTRAP_ADMIN_USERNAME.toLowerCase(),
      name: "Administrator",
      role: "admin",
      passwordHash: await hashPassword(config.BOOTSTRAP_ADMIN_PASSWORD),
    })
    .returning({ id: users.id });
  console.log(`• Admin dibuat: ${config.BOOTSTRAP_ADMIN_USERNAME} / ${config.BOOTSTRAP_ADMIN_PASSWORD} (segera ganti password!)`);
  return admin!.id;
}

function demoMapSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400" viewBox="0 0 800 400">
  <rect width="800" height="400" fill="#bfe3ff"/>
  <rect x="60" y="120" width="160" height="90" rx="30" fill="#6cbf6c"/><text x="140" y="170" font-size="18" text-anchor="middle">Sumatra</text>
  <rect x="240" y="80" width="160" height="140" rx="40" fill="#6cbf6c"/><text x="320" y="155" font-size="18" text-anchor="middle">Kalimantan</text>
  <rect x="250" y="260" width="200" height="40" rx="15" fill="#6cbf6c"/><text x="350" y="285" font-size="18" text-anchor="middle">Jawa</text>
  <rect x="440" y="110" width="90" height="120" rx="20" fill="#6cbf6c"/><text x="485" y="175" font-size="18" text-anchor="middle">Sulawesi</text>
  <rect x="600" y="150" width="170" height="100" rx="30" fill="#6cbf6c"/><text x="685" y="205" font-size="18" text-anchor="middle">Papua</text>
</svg>`;
}

async function seedDemo(adminId: string | null) {
  const existing = await db.query.sites.findFirst({ where: eq(sites.code, "DEMO-01") });
  if (existing) {
    console.log("• Data demo sudah ada, dilewati");
    return;
  }
  await ensureBucket();

  // Lokasi
  const [site] = await db
    .insert(sites)
    .values({ code: "DEMO-01", name: "SMA Negeri Contoh (Lab Komputer 1)", capacity: 40, secretHash: await hashPassword(DEMO_SITE_SECRET) })
    .returning();

  // Peserta
  const pwHash = await hashPasswordLight(DEMO_PARTICIPANT_PASSWORD);
  const people = await db
    .insert(participants)
    .values(
      Array.from({ length: 30 }, (_, i) => ({
        number: `DEMO-${String(i + 1).padStart(4, "0")}`,
        name: `Peserta Demo ${i + 1}`,
        groupName: i < 15 ? "XII IPA 1" : "XII IPA 2",
        gender: (i % 2 === 0 ? "L" : "P") as "L" | "P",
        siteId: site!.id,
        passwordHash: pwHash,
      })),
    )
    .returning({ id: participants.id });

  // Aset untuk soal hotspot
  const svg = demoMapSvg();
  const assetId = randomUUID();
  await putObject(`assets/${assetId}`, svg, "image/svg+xml");
  await db.insert(assets).values({
    id: assetId,
    objectKey: `assets/${assetId}`,
    filename: "peta-indonesia.svg",
    mime: "image/svg+xml",
    size: Buffer.byteLength(svg),
    sha256: sha256(svg),
    createdBy: adminId,
  });

  // Bank soal: satu soal untuk tiap jenis + satu stimulus
  const [bank] = await db
    .insert(questionBanks)
    .values({ code: "DEMO", name: "Bank Soal Demo (semua jenis soal)", subject: "Umum", createdBy: adminId })
    .returning();
  const [stimulus] = await db
    .insert(stimuli)
    .values({
      bankId: bank!.id,
      title: "Bacaan: Fotosintesis",
      content:
        "<p>Fotosintesis adalah proses tumbuhan hijau membuat makanan sendiri. Dengan bantuan cahaya matahari dan klorofil, air dan karbon dioksida diubah menjadi glukosa dan oksigen.</p>",
    })
    .returning();

  const qIds: string[] = [];
  for (const [i, type] of QUESTION_TYPES.entries()) {
    const { definition, scoring } = questionTemplate(type);
    const content = JSON.parse(JSON.stringify(definition.content).replaceAll(PLACEHOLDER_ASSET_ID, assetId));
    const [q] = await db
      .insert(questions)
      .values({
        bankId: bank!.id,
        stimulusId: type === "essay" ? stimulus!.id : null,
        code: `DEMO-${String(i + 1).padStart(2, "0")}`,
        type,
        content,
        answerKey: definition.answerKey,
        scoring: Scoring.parse(scoring),
        status: "ready",
        tags: ["demo"],
        createdBy: adminId,
        updatedBy: adminId,
      })
      .returning({ id: questions.id });
    qIds.push(q!.id);
  }

  // Ujian dengan 2 bagian
  const [exam] = await db
    .insert(exams)
    .values({
      code: "DEMO-UJI",
      title: "Ujian Demo — Semua Jenis Soal",
      instructions: "<p>Bacalah setiap soal dengan teliti. Gunakan tombol <b>Ragu-ragu</b> bila belum yakin.</p>",
      durationMinutes: 90,
      settings: ExamSettings.parse({ shuffleQuestions: false }),
      status: "ready",
      createdBy: adminId,
    })
    .returning();
  const [s1] = await db.insert(examSections).values({ examId: exam!.id, title: "Bagian A — Pilihan & isian", order: 0 }).returning();
  const [s2] = await db
    .insert(examSections)
    .values({ examId: exam!.id, title: "Bagian B — Interaktif & uraian", order: 1 })
    .returning();
  await db.insert(examSectionQuestions).values(
    qIds.map((questionId, i) => ({ sectionId: i < 7 ? s1!.id : s2!.id, questionId, order: i })),
  );

  // Jadwal hari ini + peserta + terbitkan paket
  const start = new Date();
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 8 * 3600 * 1000);
  const [schedule] = await db
    .insert(schedules)
    .values({
      examId: exam!.id,
      siteId: site!.id,
      name: "Sesi Demo",
      startAt: start,
      endAt: end,
      accessToken: "DEMO01",
      createdBy: adminId,
    })
    .returning();
  await db.insert(scheduleParticipants).values(people.map((p) => ({ scheduleId: schedule!.id, participantId: p.id })));
  const pkg = await publishSchedule(schedule!.id, adminId);

  console.log("• Data demo dibuat:");
  console.log(`    Lokasi         : DEMO-01 / secret: ${DEMO_SITE_SECRET}`);
  console.log(`    Peserta        : DEMO-0001 … DEMO-0030 / password: ${DEMO_PARTICIPANT_PASSWORD}`);
  console.log(`    Token sesi     : DEMO01`);
  console.log(`    Paket          : v${pkg.version} (dibangun oleh worker)`);
}

async function main() {
  await runMigrations();
  const adminId = await seedAdmin();
  if (process.argv.includes("--demo")) await seedDemo(adminId);
}

main()
  .then(async () => {
    await closeQueues();
    await pool.end();
  })
  .catch(async (err) => {
    console.error(err);
    await closeQueues().catch(() => {});
    await pool.end().catch(() => {});
    process.exit(1);
  });
