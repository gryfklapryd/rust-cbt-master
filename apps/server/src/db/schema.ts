import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  AttemptStatus,
  BatchStatus,
  ExamSettings,
  GradeResult,
  QuestionType,
  Scoring,
  StimulusSettings,
} from "@cbt/shared";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
/** numeric(10,4) dipetakan ke number di TypeScript. */
const score = (name: string) => numeric(name, { precision: 10, scale: 4, mode: "number" });

// ---------------------------------------------------------------------------
// Pengguna panel admin
// ---------------------------------------------------------------------------
export const USER_ROLES = ["admin", "author", "grader", "proctor"] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  name: text("name").notNull(),
  email: text("email"),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: USER_ROLES }).notNull(),
  active: boolean("active").notNull().default(true),
  lastLoginAt: ts("last_login_at"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Titik / lokasi ujian (tempat aplikasi desktop dipasang)
// ---------------------------------------------------------------------------
export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  address: text("address"),
  /** Kapasitas komputer/peserta per sesi. */
  capacity: integer("capacity"),
  /** Hash argon2 dari secret yang dipakai aplikasi desktop untuk login sinkronisasi. */
  secretHash: text("secret_hash").notNull(),
  active: boolean("active").notNull().default(true),
  lastSeenAt: ts("last_seen_at"),
  lastSeenInfo: jsonb("last_seen_info").$type<Record<string, unknown>>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Proktor yang ditugaskan ke titik ujian. Akun (hash password) proktor ini dikirim ke
 * server lokal lokasi tersebut agar proktor bisa login di sana tanpa internet.
 */
export const siteProctors = pgTable(
  "site_proctors",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.userId] }), index("site_proctors_user_idx").on(t.userId)],
);

/** Aksi proktor di server lokal (reset login, tambah waktu, hentikan, ...), dikirim dari lokasi. */
export const proctorActions = pgTable(
  "proctor_actions",
  {
    /** UUID dibuat server lokal; kunci idempoten. */
    id: uuid("id").primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    /** Tanpa foreign key: akun bisa sudah dihapus di pusat saat log tiba. */
    userId: uuid("user_id"),
    username: text("username").notNull(),
    action: text("action").notNull(),
    scheduleId: uuid("schedule_id"),
    attemptId: uuid("attempt_id"),
    participantId: uuid("participant_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    at: ts("at").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
  },
  (t) => [index("proctor_actions_site_at_idx").on(t.siteId, t.at), index("proctor_actions_attempt_idx").on(t.attemptId)],
);

// ---------------------------------------------------------------------------
// Peserta
// ---------------------------------------------------------------------------
export const participants = pgTable(
  "participants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Nomor peserta (unik), dipakai untuk login di aplikasi desktop. */
    number: text("number").notNull().unique(),
    name: text("name").notNull(),
    /** Kelas / rombel / kelompok. */
    groupName: text("group_name"),
    gender: text("gender", { enum: ["L", "P"] }),
    birthDate: date("birth_date", { mode: "string" }),
    /** Lokasi asal (opsional, untuk memudahkan penjadwalan). */
    siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
    passwordHash: text("password_hash"),
    photoAssetId: uuid("photo_asset_id").references(() => assets.id, { onDelete: "set null" }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("participants_group_idx").on(t.groupName), index("participants_site_idx").on(t.siteId)],
);

// ---------------------------------------------------------------------------
// Aset media (MinIO)
// ---------------------------------------------------------------------------
export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  objectKey: text("object_key").notNull().unique(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Bank soal
// ---------------------------------------------------------------------------
export const questionBanks = pgTable("question_banks", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  subject: text("subject"),
  description: text("description"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Stimulus: bacaan/gambar/audio yang dipakai bersama oleh beberapa soal. */
export const stimuli = pgTable(
  "stimuli",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankId: uuid("bank_id")
      .notNull()
      .references(() => questionBanks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    content: text("content").notNull(),
    settings: jsonb("settings").$type<StimulusSettings>().notNull().default({ mediaPlayLimit: 0 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("stimuli_bank_idx").on(t.bankId)],
);

export const QUESTION_STATUSES = ["draft", "ready", "archived"] as const;

export const questions = pgTable(
  "questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bankId: uuid("bank_id")
      .notNull()
      .references(() => questionBanks.id, { onDelete: "cascade" }),
    stimulusId: uuid("stimulus_id").references(() => stimuli.id, { onDelete: "set null" }),
    /** Kode soal opsional dari penulis (unik per bank). */
    code: text("code"),
    type: text("type").$type<QuestionType>().notNull(),
    /** Bagian publik (dikirim ke desktop). */
    content: jsonb("content").notNull(),
    /** Kunci jawaban / rubrik (tidak pernah dikirim ke desktop). */
    answerKey: jsonb("answer_key").notNull(),
    scoring: jsonb("scoring").$type<Scoring>().notNull(),
    difficulty: text("difficulty", { enum: ["easy", "medium", "hard"] }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    status: text("status", { enum: QUESTION_STATUSES }).notNull().default("draft"),
    /** Naik setiap konten/kunci/skor berubah. Paket ujian menyimpan salinan (snapshot) versi soal. */
    version: integer("version").notNull().default(1),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("questions_bank_idx").on(t.bankId),
    index("questions_type_idx").on(t.type),
    uniqueIndex("questions_bank_code_uq").on(t.bankId, t.code),
  ],
);

// ---------------------------------------------------------------------------
// Ujian
// ---------------------------------------------------------------------------
export const EXAM_STATUSES = ["draft", "ready", "archived"] as const;

export const exams = pgTable("exams", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  instructions: text("instructions"),
  durationMinutes: integer("duration_minutes").notNull(),
  settings: jsonb("settings").$type<ExamSettings>().notNull(),
  status: text("status", { enum: EXAM_STATUSES }).notNull().default("draft"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const examSections = pgTable(
  "exam_sections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    instructions: text("instructions"),
    order: integer("order").notNull().default(0),
    durationMinutes: integer("duration_minutes"),
    pickCount: integer("pick_count"),
    shuffleQuestions: boolean("shuffle_questions").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("exam_sections_exam_idx").on(t.examId)],
);

export const examSectionQuestions = pgTable(
  "exam_section_questions",
  {
    sectionId: uuid("section_id")
      .notNull()
      .references(() => examSections.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    order: integer("order").notNull().default(0),
    /** Timpa poin soal khusus untuk ujian ini. */
    pointsOverride: score("points_override"),
  },
  (t) => [primaryKey({ columns: [t.sectionId, t.questionId] })],
);

// ---------------------------------------------------------------------------
// Jadwal / sesi ujian per lokasi
// ---------------------------------------------------------------------------
export const SCHEDULE_STATUSES = ["draft", "published", "closed"] as const;

export const schedules = pgTable(
  "schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    examId: uuid("exam_id")
      .notNull()
      .references(() => exams.id, { onDelete: "restrict" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    startAt: ts("start_at").notNull(),
    endAt: ts("end_at").notNull(),
    lateEntryMinutes: integer("late_entry_minutes"),
    /** Token sesi yang dibacakan pengawas (disimpan terbaca agar bisa ditampilkan di admin). */
    accessToken: text("access_token"),
    status: text("status", { enum: SCHEDULE_STATUSES }).notNull().default("draft"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("schedules_site_idx").on(t.siteId, t.startAt), index("schedules_exam_idx").on(t.examId)],
);

export const scheduleParticipants = pgTable(
  "schedule_participants",
  {
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.scheduleId, t.participantId] }), index("sp_participant_idx").on(t.participantId)],
);

// ---------------------------------------------------------------------------
// Paket ujian (snapshot yang dikirim ke desktop)
// ---------------------------------------------------------------------------
export const PACKAGE_STATUSES = ["building", "ready", "failed", "superseded"] as const;
export type PackageStatus = (typeof PACKAGE_STATUSES)[number];

/** Salinan kunci per soal di dalam paket, dipakai penilaian agar konsisten dengan yang diujikan. */
export interface PackageKeyEntry {
  type: QuestionType;
  version: number;
  content: unknown;
  answerKey: unknown;
  scoring: Scoring;
}

export const examPackages = pgTable(
  "exam_packages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: text("status", { enum: PACKAGE_STATUSES }).notNull().default("building"),
    /** Lokasi JSON paket di object storage. */
    objectKey: text("object_key"),
    checksum: text("checksum"),
    size: bigint("size", { mode: "number" }),
    questionCount: integer("question_count"),
    participantCount: integer("participant_count"),
    assetCount: integer("asset_count"),
    /** Aset yang boleh diunduh titik ujian pemilik paket ini. */
    assetIds: uuid("asset_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** questionId -> snapshot kunci. Tetap di server. */
    answerKeys: jsonb("answer_keys").$type<Record<string, PackageKeyEntry>>(),
    error: text("error"),
    builtAt: ts("built_at"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("exam_packages_schedule_version_uq").on(t.scheduleId, t.version)],
);

export const packageDownloads = pgTable(
  "package_downloads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    packageId: uuid("package_id")
      .notNull()
      .references(() => examPackages.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    downloadedAt: ts("downloaded_at").notNull().defaultNow(),
  },
  (t) => [index("package_downloads_pkg_idx").on(t.packageId)],
);

// ---------------------------------------------------------------------------
// Sinkronisasi hasil
// ---------------------------------------------------------------------------
export interface BatchAttemptOutcome {
  attemptId: string;
  accepted: boolean;
  reason: string | null;
}

export const syncBatches = pgTable(
  "sync_batches",
  {
    /** batchId dari client (idempoten). */
    id: uuid("id").primaryKey(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "cascade" }),
    deviceId: text("device_id"),
    status: text("status", { enum: ["received", "processing", "processed", "failed"] as const satisfies readonly BatchStatus[] })
      .notNull()
      .default("received"),
    /** Lokasi payload mentah di object storage (arsip & pemrosesan ulang). */
    objectKey: text("object_key").notNull(),
    attemptCount: integer("attempt_count").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    outcomes: jsonb("outcomes").$type<BatchAttemptOutcome[]>(),
    error: text("error"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    processedAt: ts("processed_at"),
  },
  (t) => [index("sync_batches_site_idx").on(t.siteId, t.receivedAt)],
);

export const GRADING_STATUSES = ["pending", "partial", "complete"] as const;
export type GradingStatus = (typeof GRADING_STATUSES)[number];

export const attempts = pgTable(
  "attempts",
  {
    /** attemptId dari client. */
    id: uuid("id").primaryKey(),
    scheduleId: uuid("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "restrict" }),
    participantId: uuid("participant_id")
      .notNull()
      .references(() => participants.id, { onDelete: "restrict" }),
    packageId: uuid("package_id")
      .notNull()
      .references(() => examPackages.id, { onDelete: "restrict" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => sites.id, { onDelete: "restrict" }),
    status: text("status", { enum: ["in_progress", "submitted", "timed_out", "terminated"] as const satisfies readonly AttemptStatus[] }).notNull(),
    sequence: integer("sequence").notNull(),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    questionOrder: jsonb("question_order").$type<string[]>(),
    optionOrders: jsonb("option_orders").$type<Record<string, string[]>>(),
    client: jsonb("client").$type<Record<string, unknown>>(),
    violationCount: integer("violation_count").notNull().default(0),
    gradingStatus: text("grading_status", { enum: GRADING_STATUSES }).notNull().default("pending"),
    score: score("score"),
    maxScore: score("max_score"),
    /** Nilai skala 0-100. */
    scaledScore: score("scaled_score"),
    correctCount: integer("correct_count"),
    answeredCount: integer("answered_count"),
    gradedAt: ts("graded_at"),
    lastBatchId: uuid("last_batch_id"),
    receivedAt: ts("received_at").notNull().defaultNow(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("attempts_schedule_participant_uq").on(t.scheduleId, t.participantId),
    index("attempts_site_idx").on(t.siteId),
    index("attempts_grading_idx").on(t.gradingStatus),
  ],
);

export const ANSWER_GRADE_STATUSES = [
  "pending",
  "graded",
  "unanswered",
  "pending_manual",
  "manual",
  "ungraded",
  "invalid",
] as const;
export type AnswerGradeStatus = (typeof ANSWER_GRADE_STATUSES)[number];

export const attemptAnswers = pgTable(
  "attempt_answers",
  {
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    questionId: uuid("question_id")
      .notNull()
      .references(() => questions.id, { onDelete: "restrict" }),
    response: jsonb("response"),
    answeredAt: ts("answered_at"),
    timeSpentSeconds: integer("time_spent_seconds"),
    flagged: boolean("flagged").notNull().default(false),
    changeCount: integer("change_count"),
    gradeStatus: text("grade_status", { enum: ANSWER_GRADE_STATUSES }).notNull().default("pending"),
    autoResult: jsonb("auto_result").$type<GradeResult>(),
    score: score("score"),
    maxScore: score("max_score"),
    /** Penilaian manual. */
    manualScore: score("manual_score"),
    rubricScores: jsonb("rubric_scores").$type<Record<string, number>>(),
    feedback: text("feedback"),
    gradedBy: uuid("graded_by").references(() => users.id, { onDelete: "set null" }),
    gradedAt: ts("graded_at"),
  },
  (t) => [
    primaryKey({ columns: [t.attemptId, t.questionId] }),
    index("attempt_answers_question_idx").on(t.questionId),
    index("attempt_answers_status_idx").on(t.gradeStatus),
  ],
);

export const attemptEvents = pgTable(
  "attempt_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    attemptId: uuid("attempt_id")
      .notNull()
      .references(() => attempts.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    at: ts("at").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>(),
  },
  (t) => [
    index("attempt_events_attempt_idx").on(t.attemptId, t.at),
    uniqueIndex("attempt_events_dedupe_uq").on(t.attemptId, t.type, t.at),
  ],
);

/** Berkas jawaban (soal unggah berkas) yang diunggah titik ujian. */
export const attachments = pgTable("attachments", {
  /** attachmentId dari client (idempoten). */
  id: uuid("id").primaryKey(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  attemptId: uuid("attempt_id"),
  questionId: uuid("question_id"),
  objectKey: text("object_key").notNull(),
  filename: text("filename").notNull(),
  mime: text("mime").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  sha256: text("sha256").notNull(),
  createdAt: createdAt(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorType: text("actor_type", { enum: ["user", "site", "system"] }).notNull(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    data: jsonb("data").$type<Record<string, unknown>>(),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("audit_logs_at_idx").on(t.at), index("audit_logs_entity_idx").on(t.entity, t.entityId)],
);

// ---------------------------------------------------------------------------
// Relasi (untuk query relasional drizzle)
// ---------------------------------------------------------------------------
export const questionBanksRelations = relations(questionBanks, ({ many }) => ({
  questions: many(questions),
  stimuli: many(stimuli),
}));
export const questionsRelations = relations(questions, ({ one }) => ({
  bank: one(questionBanks, { fields: [questions.bankId], references: [questionBanks.id] }),
  stimulus: one(stimuli, { fields: [questions.stimulusId], references: [stimuli.id] }),
}));
export const stimuliRelations = relations(stimuli, ({ one, many }) => ({
  bank: one(questionBanks, { fields: [stimuli.bankId], references: [questionBanks.id] }),
  questions: many(questions),
}));
export const examsRelations = relations(exams, ({ many }) => ({
  sections: many(examSections),
  schedules: many(schedules),
}));
export const examSectionsRelations = relations(examSections, ({ one, many }) => ({
  exam: one(exams, { fields: [examSections.examId], references: [exams.id] }),
  questions: many(examSectionQuestions),
}));
export const examSectionQuestionsRelations = relations(examSectionQuestions, ({ one }) => ({
  section: one(examSections, { fields: [examSectionQuestions.sectionId], references: [examSections.id] }),
  question: one(questions, { fields: [examSectionQuestions.questionId], references: [questions.id] }),
}));
export const schedulesRelations = relations(schedules, ({ one, many }) => ({
  exam: one(exams, { fields: [schedules.examId], references: [exams.id] }),
  site: one(sites, { fields: [schedules.siteId], references: [sites.id] }),
  participants: many(scheduleParticipants),
  packages: many(examPackages),
}));
export const scheduleParticipantsRelations = relations(scheduleParticipants, ({ one }) => ({
  schedule: one(schedules, { fields: [scheduleParticipants.scheduleId], references: [schedules.id] }),
  participant: one(participants, { fields: [scheduleParticipants.participantId], references: [participants.id] }),
}));
export const examPackagesRelations = relations(examPackages, ({ one }) => ({
  schedule: one(schedules, { fields: [examPackages.scheduleId], references: [schedules.id] }),
}));
export const attemptsRelations = relations(attempts, ({ one, many }) => ({
  schedule: one(schedules, { fields: [attempts.scheduleId], references: [schedules.id] }),
  participant: one(participants, { fields: [attempts.participantId], references: [participants.id] }),
  package: one(examPackages, { fields: [attempts.packageId], references: [examPackages.id] }),
  site: one(sites, { fields: [attempts.siteId], references: [sites.id] }),
  answers: many(attemptAnswers),
  events: many(attemptEvents),
}));
export const attemptAnswersRelations = relations(attemptAnswers, ({ one }) => ({
  attempt: one(attempts, { fields: [attemptAnswers.attemptId], references: [attempts.id] }),
  question: one(questions, { fields: [attemptAnswers.questionId], references: [questions.id] }),
}));
export const attemptEventsRelations = relations(attemptEvents, ({ one }) => ({
  attempt: one(attempts, { fields: [attemptEvents.attemptId], references: [attempts.id] }),
}));
