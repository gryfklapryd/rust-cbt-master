import { describe, expect, it } from "vitest";
import {
  ExamPackage,
  QUESTION_TYPES,
  QuestionDefinition,
  collectAssetIds,
  gradeResponse,
  matchText,
  parseNumericInput,
  questionTemplate,
  scoreFromRubric,
  TextMatchRule,
  type QuestionType,
} from "../src/index.js";

const tpl = (type: QuestionType) => questionTemplate(type).definition;

describe("templates", () => {
  it.each(QUESTION_TYPES)("template %s valid", (type) => {
    const r = QuestionDefinition.safeParse(tpl(type));
    expect(r.success, JSON.stringify(r.error?.issues)).toBe(true);
  });
});

describe("konsistensi definisi", () => {
  it("menolak kunci yang merujuk opsi tak dikenal", () => {
    const def = tpl("single_choice");
    const r = QuestionDefinition.safeParse({ ...def, answerKey: { correctOptionId: "Z" } });
    expect(r.success).toBe(false);
  });
  it("menolak id opsi duplikat", () => {
    const def = tpl("multiple_choice");
    if (def.type !== "multiple_choice") throw new Error();
    const r = QuestionDefinition.safeParse({
      ...def,
      content: { ...def.content, options: [...def.content.options, { id: "A", content: "dup" }] },
    });
    expect(r.success).toBe(false);
  });
  it("fill_blanks: penanda di teks harus sesuai daftar blank", () => {
    const def = tpl("fill_blanks");
    if (def.type !== "fill_blanks") throw new Error();
    const r = QuestionDefinition.safeParse({ ...def, content: { ...def.content, text: "<p>[[b1]] saja</p>" } });
    expect(r.success).toBe(false);
  });
  it("ordering: kunci harus memuat semua item", () => {
    const r = QuestionDefinition.safeParse({ ...tpl("ordering"), answerKey: { order: ["a", "b"] } });
    expect(r.success).toBe(false);
  });
});

describe("gradeResponse", () => {
  it("single_choice benar/salah/kosong", () => {
    const def = tpl("single_choice");
    expect(gradeResponse(def, { points: 2 }, { optionId: "A" })).toMatchObject({ status: "graded", score: 2, correct: true });
    expect(gradeResponse(def, { points: 2 }, { optionId: "B" })).toMatchObject({ status: "graded", score: 0, correct: false });
    expect(gradeResponse(def, { points: 2 }, { optionId: null })).toMatchObject({ status: "unanswered", score: 0 });
    expect(gradeResponse(def, { points: 2 }, undefined)).toMatchObject({ status: "unanswered" });
  });

  it("single_choice penalti hanya untuk jawaban salah, bukan kosong", () => {
    const def = tpl("single_choice");
    const scoring = { points: 4, penalty: 1, allowNegative: true };
    expect(gradeResponse(def, scoring, { optionId: "B" }).score).toBe(-1);
    expect(gradeResponse(def, scoring, { optionId: null }).score).toBe(0);
    expect(gradeResponse(def, { points: 4, penalty: 1 }, { optionId: "B" }).score).toBe(0);
  });

  it("single_choice berbobot", () => {
    const def = tpl("single_choice");
    if (def.type !== "single_choice") throw new Error();
    const weighted = { ...def, answerKey: { correctOptionId: "A", optionWeights: { A: 1, B: 0.5, C: 0.25 } } };
    expect(gradeResponse(weighted, { points: 4, mode: "partial" }, { optionId: "B" }).score).toBe(2);
  });

  it("jawaban dengan format salah -> invalid", () => {
    const r = gradeResponse(tpl("single_choice"), { points: 1 }, { optionId: 12 });
    expect(r.status).toBe("invalid");
    expect(r.score).toBe(0);
    expect(r.error).toBeTruthy();
  });

  it("multiple_choice parsial dengan pengurangan salah pilih", () => {
    const def = tpl("multiple_choice"); // kunci A, C
    const partial = { points: 2, mode: "partial" as const };
    expect(gradeResponse(def, partial, { optionIds: ["A", "C"] }).score).toBe(2);
    expect(gradeResponse(def, partial, { optionIds: ["A"] }).score).toBe(1);
    expect(gradeResponse(def, partial, { optionIds: ["A", "B"] }).score).toBe(0);
    expect(gradeResponse(def, partial, { optionIds: ["A", "B", "C", "D"] }).score).toBe(0);
    expect(gradeResponse(def, { points: 2 }, { optionIds: ["A"] }).score).toBe(0);
  });

  it("true_false", () => {
    expect(gradeResponse(tpl("true_false"), {}, { value: true }).score).toBe(1);
    expect(gradeResponse(tpl("true_false"), {}, { value: false }).score).toBe(0);
  });

  it("multiple_true_false parsial", () => {
    const r = gradeResponse(tpl("multiple_true_false"), { points: 3, mode: "partial" }, { values: { s1: true, s2: true, s3: true } });
    expect(r.score).toBe(2);
    expect(r.details).toMatchObject({ perItem: { s1: true, s2: false, s3: true } });
  });

  it("short_answer: normalisasi huruf, spasi, tanda baca", () => {
    const def = tpl("short_answer");
    expect(gradeResponse(def, {}, { text: "  soekarno " }).score).toBe(1);
    expect(gradeResponse(def, {}, { text: "Ir Soekarno" }).score).toBe(1);
    expect(gradeResponse(def, {}, { text: "Hatta" }).score).toBe(0);
  });

  it("matchText mode contains/regex/aksen/bobot", () => {
    const rule = (r: Partial<TextMatchRule> & { value: string }) => TextMatchRule.parse(r);
    expect(matchText("jawabannya fotosintesis ya", [rule({ value: "fotosintesis", mode: "contains" })])).toBe(1);
    expect(matchText("warna", [rule({ value: "^warn[ae]$", mode: "regex" })])).toBe(1);
    expect(matchText("café", [rule({ value: "cafe", ignoreAccents: true })])).toBe(1);
    expect(matchText("ABC", [rule({ value: "abc", caseSensitive: true })])).toBe(0);
    expect(matchText("setengah", [rule({ value: "setengah", score: 0.5 })])).toBe(0.5);
    expect(matchText("x", [rule({ value: "([", mode: "regex" })])).toBe(0);
  });

  it("numeric: toleransi, koma desimal, rentang", () => {
    const def = tpl("numeric");
    expect(gradeResponse(def, {}, { value: 3.14 }).score).toBe(1);
    expect(gradeResponse(def, {}, { value: "3,14" }).score).toBe(1);
    expect(gradeResponse(def, {}, { value: 3.2 }).score).toBe(0);
    expect(gradeResponse(def, {}, { value: "abc" }).score).toBe(0);
    expect(parseNumericInput("1.234,5")).toBe(1234.5);
    expect(parseNumericInput("1,234.5")).toBe(1234.5);
    expect(parseNumericInput("-2e3")).toBe(-2000);
    expect(parseNumericInput("")).toBeNull();
    const range = QuestionDefinition.parse({ ...def, answerKey: { accepted: [{ min: 10, max: 20 }] } });
    expect(gradeResponse(range, {}, { value: 15 }).score).toBe(1);
    expect(gradeResponse(range, {}, { value: 21 }).score).toBe(0);
    const pct = QuestionDefinition.parse({ ...def, answerKey: { accepted: [{ value: 100, tolerance: 5, toleranceMode: "percent" }] } });
    expect(gradeResponse(pct, {}, { value: 104 }).score).toBe(1);
    expect(gradeResponse(pct, {}, { value: 106 }).score).toBe(0);
  });

  it("essay & file_upload menunggu penilaian manual, kosong langsung 0", () => {
    expect(gradeResponse(tpl("essay"), { points: 3 }, { text: "Tumbuhan …" })).toMatchObject({ status: "pending_manual", score: null });
    expect(gradeResponse(tpl("essay"), { points: 3 }, { text: "   " })).toMatchObject({ status: "unanswered", score: 0 });
    expect(
      gradeResponse(tpl("file_upload"), {}, {
        files: [{ attachmentId: "5b7c2a50-4b6e-4f6e-9a55-3f1c7f2c9a11", name: "a.jpg", size: 10, mime: "image/jpeg" }],
      }).status,
    ).toBe("pending_manual");
  });

  it("matching parsial & pengecoh", () => {
    const def = tpl("matching");
    const partial = { points: 3, mode: "partial" as const };
    const all = [
      { leftId: "L1", rightId: "R1" },
      { leftId: "L2", rightId: "R2" },
      { leftId: "L3", rightId: "R3" },
    ];
    expect(gradeResponse(def, partial, { pairs: all }).score).toBe(3);
    expect(gradeResponse(def, partial, { pairs: [{ leftId: "L1", rightId: "R1" }, { leftId: "L2", rightId: "R4" }] }).score).toBe(1);
    // pasangan duplikat untuk item kiri yang sama: hanya yang pertama dihitung
    expect(gradeResponse(def, partial, { pairs: [{ leftId: "L1", rightId: "R2" }, { leftId: "L1", rightId: "R1" }] }).score).toBe(0);
  });

  it("ordering", () => {
    const def = tpl("ordering"); // b, c, a
    expect(gradeResponse(def, {}, { order: ["b", "c", "a"] }).score).toBe(1);
    expect(gradeResponse(def, {}, { order: ["b", "a", "c"] }).score).toBe(0);
    expect(gradeResponse(def, { points: 3, mode: "partial" }, { order: ["b", "a", "c"] }).score).toBe(1);
  });

  it("fill_blanks: angka, dropdown, bank kata", () => {
    const def = tpl("fill_blanks");
    const partial = { points: 3, mode: "partial" as const };
    expect(gradeResponse(def, partial, { values: { b1: "1945", b2: "o1", b3: "w1" } }).score).toBe(3);
    expect(gradeResponse(def, partial, { values: { b1: "1945", b2: "o2", b3: null } }).score).toBe(1);
    expect(gradeResponse(def, partial, { values: { b1: "", b2: null } }).status).toBe("unanswered");
  });

  it("categorization dengan pengecoh", () => {
    const def = tpl("categorization");
    if (def.type !== "categorization") throw new Error();
    const withDistractor = QuestionDefinition.parse({
      ...def,
      content: { ...def.content, items: [...def.content.items, { id: "x", content: "Batu" }] },
    });
    const partial = { points: 4, mode: "partial" as const };
    const correct = { i1: "mamalia", i2: "unggas", i3: "mamalia", i4: "unggas" };
    expect(gradeResponse(withDistractor, partial, { mapping: correct }).score).toBe(4);
    expect(gradeResponse(withDistractor, partial, { mapping: { ...correct, x: "mamalia" } }).score).toBe(3);
    expect(gradeResponse(withDistractor, { points: 4 }, { mapping: { ...correct, x: "mamalia" } }).score).toBe(0);
  });

  it("hotspot: rect, circle, polygon", () => {
    const def = tpl("hotspot");
    expect(gradeResponse(def, {}, { points: [{ x: 0.4, y: 0.3 }] }).score).toBe(1);
    expect(gradeResponse(def, {}, { points: [{ x: 0.9, y: 0.9 }] }).score).toBe(0);
    const multi = QuestionDefinition.parse({
      ...def,
      content: { ...(def.content as object), maxSelections: 2 },
      answerKey: {
        regions: [
          { id: "c", shape: "circle", cx: 0.5, cy: 0.5, r: 0.1 },
          { id: "p", shape: "polygon", points: [[0, 0], [0.2, 0], [0, 0.2]] },
        ],
      },
    });
    expect(gradeResponse(multi, {}, { points: [{ x: 0.52, y: 0.5 }, { x: 0.05, y: 0.05 }] }).score).toBe(1);
    expect(gradeResponse(multi, { mode: "partial", points: 2 }, { points: [{ x: 0.52, y: 0.5 }, { x: 0.19, y: 0.19 }] }).score).toBe(0);
    expect(gradeResponse(multi, { mode: "partial", points: 2 }, { points: [{ x: 0.52, y: 0.5 }] }).score).toBe(1);
  });

  it("hot_text", () => {
    const def = tpl("hot_text");
    expect(gradeResponse(def, { mode: "partial", points: 2 }, { segmentIds: ["t2", "t4"] }).score).toBe(2);
    expect(gradeResponse(def, { mode: "partial", points: 2 }, { segmentIds: ["t2"] }).score).toBe(1);
  });

  it("matrix dinilai & matrix angket tidak dinilai", () => {
    const def = tpl("matrix");
    const sel = { r1: ["cair"], r2: ["padat"], r3: ["cair"] };
    expect(gradeResponse(def, { points: 3, mode: "partial" }, { selections: sel }).score).toBe(2);
    const survey = QuestionDefinition.parse({ ...def, answerKey: {} });
    expect(gradeResponse(survey, { points: 3 }, { selections: sel })).toMatchObject({ status: "ungraded", score: 0, maxScore: 0 });
  });

  it("poin 0 = tidak dinilai", () => {
    expect(gradeResponse(tpl("single_choice"), { points: 0 }, { optionId: "A" }).status).toBe("ungraded");
  });

  it("scoreFromRubric dibatasi per kriteria lalu diskalakan ke skor maksimum", () => {
    const rubric = [
      { id: "r1", maxPoints: 2 },
      { id: "r2", maxPoints: 2 },
    ];
    expect(scoreFromRubric(rubric, { r1: 5, r2: 1 }, 4)).toBe(3);
    expect(scoreFromRubric(rubric, { r1: 2, r2: 2 }, 10)).toBe(10);
    expect(scoreFromRubric(rubric, { r1: 1 }, 10)).toBe(2.5);
    expect(scoreFromRubric([], {}, 10)).toBe(0);
  });
});

describe("utilitas", () => {
  it("collectAssetIds menemukan rujukan asset:// di struktur bersarang", () => {
    const ids = collectAssetIds({
      a: '<img src="asset://11111111-1111-4111-8111-111111111111">',
      b: [{ src: "asset://22222222-2222-4222-8222-222222222222" }],
    });
    expect([...ids].sort()).toEqual(["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"]);
  });

  it("ExamPackage schema bisa di-parse", () => {
    expect(ExamPackage.safeParse({}).success).toBe(false);
  });
});
