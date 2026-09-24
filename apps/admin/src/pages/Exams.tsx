import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ExamSettings, QUESTION_TYPE_META, QUESTION_TYPES, type QuestionType } from "@cbt/shared";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  Empty,
  ErrorBox,
  Field,
  Input,
  Loading,
  Modal,
  PageHeader,
  Pagination,
  Select,
  StatusBadge,
  Textarea,
  Toolbar,
  useToast,
} from "../components/ui";
import { api, qs, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate, stripHtml } from "../lib/format";
import { useAction } from "../lib/hooks";
import type { Bank, QuestionRow } from "./Banks";

interface ExamRow {
  id: string;
  code: string;
  title: string;
  durationMinutes: number;
  status: string;
  updatedAt: string;
  questionCount: number;
}
interface SectionQuestion {
  questionId: string;
  pointsOverride: number | null;
  order: number;
  question: { id: string; code: string | null; type: QuestionType; content: { prompt?: string }; scoring: { points: number }; status: string; version: number; bankId: string };
}
interface ExamDetail {
  id: string;
  code: string;
  title: string;
  description: string | null;
  instructions: string | null;
  durationMinutes: number;
  settings: ExamSettings;
  status: string;
  sections: {
    id: string;
    title: string;
    instructions: string | null;
    durationMinutes: number | null;
    pickCount: number | null;
    shuffleQuestions: boolean;
    questions: SectionQuestion[];
  }[];
  summary: { totalQuestions: number; totalPoints: number };
}

export function ExamsPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ code: "", title: "", durationMinutes: "90" });
  const list = useQuery({ queryKey: ["exams", page, q], queryFn: () => api.get<Paged<ExamRow>>(`/exams${qs({ page, pageSize: 50, q })}`) });
  const create = useAction(() => api.post<ExamRow>("/exams", { ...form, durationMinutes: Number(form.durationMinutes) }), {
    success: "Ujian dibuat",
    invalidate: [["exams"]],
    onSuccess: () => setCreating(false),
  });
  const remove = useAction((e: ExamRow) => api.del(`/exams/${e.id}`), { success: "Ujian dihapus", invalidate: [["exams"]] });

  return (
    <>
      <PageHeader title="Ujian" subtitle="Susunan soal, durasi, dan aturan ujian" actions={can("author") ? <Button variant="primary" onClick={() => { setForm({ code: "", title: "", durationMinutes: "90" }); setCreating(true); }}>+ Ujian baru</Button> : null} />
      <Card>
        <Toolbar><Input placeholder="Cari…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} /></Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada ujian.</Empty> : (
          <>
            <table className="table">
              <thead><tr><th>Kode</th><th>Judul</th><th>Durasi</th><th>Soal</th><th>Status</th><th>Diubah</th><th /></tr></thead>
              <tbody>
                {list.data.items.map((e) => (
                  <tr key={e.id}>
                    <td className="mono">{e.code}</td>
                    <td><Link to={`/exams/${e.id}`}>{e.title}</Link></td>
                    <td>{e.durationMinutes} menit</td>
                    <td>{e.questionCount}</td>
                    <td><StatusBadge status={e.status} /></td>
                    <td>{fmtDate(e.updatedAt)}</td>
                    <td className="row-actions">
                      {can("admin") ? <ConfirmButton size="sm" variant="danger" confirm={`Hapus ujian ${e.code}?`} onConfirm={() => remove.mutateAsync(e)}>Hapus</ConfirmButton> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal open={creating} title="Ujian baru" onClose={() => setCreating(false)} footer={<><Button onClick={() => setCreating(false)}>Batal</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>Buat</Button></>}>
        <div className="grid-2">
          <Field label="Kode"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Durasi (menit)"><Input type="number" min={1} value={form.durationMinutes} onChange={(e) => setForm({ ...form, durationMinutes: e.target.value })} /></Field>
        </div>
        <Field label="Judul"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
      </Modal>
    </>
  );
}

// ---------------------------------------------------------------------------

interface SectionDraft {
  title: string;
  instructions: string;
  durationMinutes: string;
  pickCount: string;
  shuffleQuestions: boolean;
  questions: { questionId: string; pointsOverride: string; info: SectionQuestion["question"] | QuestionRow }[];
}

export function ExamDetailPage() {
  const { examId } = useParams<{ examId: string }>();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const exam = useQuery({ queryKey: ["exam", examId], queryFn: () => api.get<ExamDetail>(`/exams/${examId}`) });
  const [info, setInfo] = useState<{ code: string; title: string; description: string; instructions: string; durationMinutes: string; status: string; settings: ExamSettings } | null>(null);
  const [sections, setSections] = useState<SectionDraft[] | null>(null);
  const [dirty, setDirty] = useState(false);
  const [picker, setPicker] = useState<number | null>(null);

  useEffect(() => {
    if (!exam.data) return;
    const e = exam.data;
    setInfo({ code: e.code, title: e.title, description: e.description ?? "", instructions: e.instructions ?? "", durationMinutes: String(e.durationMinutes), status: e.status, settings: ExamSettings.parse(e.settings) });
    setSections(
      e.sections.map((s) => ({
        title: s.title,
        instructions: s.instructions ?? "",
        durationMinutes: s.durationMinutes?.toString() ?? "",
        pickCount: s.pickCount?.toString() ?? "",
        shuffleQuestions: s.shuffleQuestions,
        questions: s.questions.map((q) => ({ questionId: q.questionId, pointsOverride: q.pointsOverride?.toString() ?? "", info: q.question })),
      })),
    );
    setDirty(false);
  }, [exam.data]);

  const saveInfo = useAction(
    () => api.patch(`/exams/${examId}`, { ...info, description: info!.description || null, instructions: info!.instructions || null, durationMinutes: Number(info!.durationMinutes) }),
    { success: "Pengaturan ujian disimpan", invalidate: [["exam", examId], ["exams"]] },
  );
  const saveStructure = useAction(
    () =>
      api.put<ExamDetail>(`/exams/${examId}/structure`, {
        sections: sections!.map((s) => ({
          title: s.title,
          instructions: s.instructions || null,
          durationMinutes: s.durationMinutes ? Number(s.durationMinutes) : null,
          pickCount: s.pickCount ? Number(s.pickCount) : null,
          shuffleQuestions: s.shuffleQuestions,
          questions: s.questions.map((q) => ({ questionId: q.questionId, pointsOverride: q.pointsOverride === "" ? null : Number(q.pointsOverride) })),
        })),
      }),
    {
      success: "Susunan soal disimpan",
      onSuccess: (r) => {
        qc.setQueryData(["exam", examId], r);
        void qc.invalidateQueries({ queryKey: ["exams"] });
      },
    },
  );

  const update = (fn: (draft: SectionDraft[]) => SectionDraft[]) => {
    setSections((s) => fn(structuredClone(s ?? [])));
    setDirty(true);
  };
  const usedIds = new Set(sections?.flatMap((s) => s.questions.map((q) => q.questionId)) ?? []);

  if (exam.isLoading || !info || !sections) return exam.error ? <ErrorBox error={exam.error} /> : <Loading />;
  const setSetting = <K extends keyof ExamSettings>(k: K, v: ExamSettings[K]) => setInfo({ ...info, settings: { ...info.settings, [k]: v } });

  return (
    <>
      <PageHeader
        title={exam.data!.title}
        subtitle={<><span className="mono">{exam.data!.code}</span> · {exam.data!.summary.totalQuestions} soal · total {exam.data!.summary.totalPoints} poin</>}
        actions={<Link className="btn btn-ghost" to="/exams">← Semua ujian</Link>}
      />
      <div className="editor-grid">
        <div className="stack">
          <Card
            title="Susunan soal"
            actions={
              can("author") ? (
                <>
                  <Button size="sm" onClick={() => update((d) => [...d, { title: `Bagian ${d.length + 1}`, instructions: "", durationMinutes: "", pickCount: "", shuffleQuestions: false, questions: [] }])}>+ Bagian</Button>
                  <Button size="sm" variant="primary" disabled={!dirty} loading={saveStructure.isPending} onClick={() => saveStructure.mutate(undefined)}>Simpan susunan</Button>
                </>
              ) : null
            }
          >
            {dirty ? <p className="text-warning small">Ada perubahan yang belum disimpan.</p> : null}
            {sections.map((s, si) => (
              <div key={si} className="section-box">
                <div className="grid-4">
                  <Field label="Judul bagian"><Input value={s.title} onChange={(e) => update((d) => { d[si]!.title = e.target.value; return d; })} /></Field>
                  <Field label="Waktu bagian (menit)" hint="Kosong = ikut durasi ujian"><Input type="number" min={1} value={s.durationMinutes} onChange={(e) => update((d) => { d[si]!.durationMinutes = e.target.value; return d; })} /></Field>
                  <Field label="Ambil acak N soal" hint="Kosong = semua soal"><Input type="number" min={1} value={s.pickCount} onChange={(e) => update((d) => { d[si]!.pickCount = e.target.value; return d; })} /></Field>
                  <Field label="&nbsp;"><Checkbox label="Acak urutan soal" checked={s.shuffleQuestions} onChange={(e) => update((d) => { d[si]!.shuffleQuestions = e.target.checked; return d; })} /></Field>
                </div>
                <Field label="Petunjuk bagian (HTML)"><Textarea rows={2} value={s.instructions} onChange={(e) => update((d) => { d[si]!.instructions = e.target.value; return d; })} /></Field>
                <table className="table table-compact">
                  <thead><tr><th>#</th><th>Kode</th><th>Jenis</th><th>Soal</th><th>Poin</th><th /></tr></thead>
                  <tbody>
                    {s.questions.map((q, qi) => (
                      <tr key={q.questionId}>
                        <td>{qi + 1}</td>
                        <td className="mono">{q.info.code ?? "-"}</td>
                        <td><Badge tone="info">{QUESTION_TYPE_META[q.info.type].label}</Badge></td>
                        <td>
                          <Link to={`/banks/${q.info.bankId}/questions/${q.questionId}`}>{stripHtml(q.info.content.prompt, 90)}</Link>
                          {q.info.status === "draft" ? <> <Badge tone="warning">draf</Badge></> : null}
                        </td>
                        <td style={{ width: "7rem" }}>
                          <Input type="number" min={0} step="any" placeholder={String(q.info.scoring.points)} value={q.pointsOverride} title="Kosong = poin bawaan soal" onChange={(e) => update((d) => { d[si]!.questions[qi]!.pointsOverride = e.target.value; return d; })} />
                        </td>
                        <td className="row-actions">
                          <Button size="sm" variant="ghost" disabled={qi === 0} onClick={() => update((d) => { const a = d[si]!.questions; [a[qi - 1], a[qi]] = [a[qi]!, a[qi - 1]!]; return d; })}>▲</Button>
                          <Button size="sm" variant="ghost" disabled={qi === s.questions.length - 1} onClick={() => update((d) => { const a = d[si]!.questions; [a[qi + 1], a[qi]] = [a[qi]!, a[qi + 1]!]; return d; })}>▼</Button>
                          <Button size="sm" variant="ghost" onClick={() => update((d) => { d[si]!.questions.splice(qi, 1); return d; })}>✕</Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="actions">
                  <Button size="sm" onClick={() => setPicker(si)}>+ Tambah soal</Button>
                  {sections.length > 1 ? (
                    <Button size="sm" variant="ghost" onClick={() => window.confirm("Hapus bagian ini?") && update((d) => { d.splice(si, 1); return d; })}>Hapus bagian</Button>
                  ) : null}
                </div>
              </div>
            ))}
          </Card>
        </div>
        <div className="stack">
          <Card title="Pengaturan ujian" actions={can("author") ? <Button size="sm" variant="primary" loading={saveInfo.isPending} onClick={() => saveInfo.mutate(undefined)}>Simpan</Button> : null}>
            <Field label="Kode"><Input value={info.code} onChange={(e) => setInfo({ ...info, code: e.target.value })} /></Field>
            <Field label="Judul"><Input value={info.title} onChange={(e) => setInfo({ ...info, title: e.target.value })} /></Field>
            <div className="grid-2">
              <Field label="Durasi (menit)"><Input type="number" min={1} value={info.durationMinutes} onChange={(e) => setInfo({ ...info, durationMinutes: e.target.value })} /></Field>
              <Field label="Status">
                <Select value={info.status} onChange={(e) => setInfo({ ...info, status: e.target.value })}>
                  <option value="draft">Draf</option><option value="ready">Siap</option><option value="archived">Arsip</option>
                </Select>
              </Field>
            </div>
            <Field label="Deskripsi"><Textarea rows={2} value={info.description} onChange={(e) => setInfo({ ...info, description: e.target.value })} /></Field>
            <Field label="Petunjuk umum (HTML)"><Textarea rows={4} value={info.instructions} onChange={(e) => setInfo({ ...info, instructions: e.target.value })} /></Field>
            <h3 className="subhead">Aturan di aplikasi desktop</h3>
            <Checkbox label="Acak urutan soal" checked={info.settings.shuffleQuestions} onChange={(e) => setSetting("shuffleQuestions", e.target.checked)} />
            <Checkbox label="Acak urutan opsi" checked={info.settings.shuffleOptions} onChange={(e) => setSetting("shuffleOptions", e.target.checked)} />
            <Checkbox label="Boleh kembali ke soal sebelumnya" checked={info.settings.allowBackNavigation} onChange={(e) => setSetting("allowBackNavigation", e.target.checked)} />
            <Checkbox label="Tanda ragu-ragu" checked={info.settings.allowFlagging} onChange={(e) => setSetting("allowFlagging", e.target.checked)} />
            <Checkbox label="Kumpulkan otomatis saat waktu habis" checked={info.settings.autoSubmitOnTimeout} onChange={(e) => setSetting("autoSubmitOnTimeout", e.target.checked)} />
            <Checkbox label="Mode terkunci (layar penuh / kiosk)" checked={info.settings.lockdown} onChange={(e) => setSetting("lockdown", e.target.checked)} />
            <Checkbox label="Tampilkan skor ke peserta" checked={info.settings.showScoreToParticipant} onChange={(e) => setSetting("showScoreToParticipant", e.target.checked)} />
            <div className="grid-3">
              <Field label="Min. menit sebelum selesai"><Input type="number" min={0} value={info.settings.minTimeBeforeSubmitMinutes} onChange={(e) => setSetting("minTimeBeforeSubmitMinutes", Number(e.target.value) || 0)} /></Field>
              <Field label="Maks. pelanggaran" hint="0 = tanpa batas"><Input type="number" min={0} value={info.settings.maxViolations} onChange={(e) => setSetting("maxViolations", Number(e.target.value) || 0)} /></Field>
              <Field label="Nilai lulus (0-100)"><Input type="number" min={0} max={100} value={info.settings.passingScore ?? ""} onChange={(e) => setSetting("passingScore", e.target.value === "" ? undefined : Number(e.target.value))} /></Field>
            </div>
          </Card>
        </div>
      </div>
      <QuestionPicker
        open={picker !== null}
        exclude={usedIds}
        onClose={() => setPicker(null)}
        onPick={(rows) => {
          const si = picker!;
          update((d) => {
            d[si]!.questions.push(...rows.map((r) => ({ questionId: r.id, pointsOverride: "", info: r })));
            return d;
          });
          toast.success(`${rows.length} soal ditambahkan, jangan lupa simpan susunan`);
          setPicker(null);
        }}
      />
    </>
  );
}

function QuestionPicker({ open, exclude, onClose, onPick }: { open: boolean; exclude: Set<string>; onClose: () => void; onPick: (rows: QuestionRow[]) => void }) {
  const [bankId, setBankId] = useState("");
  const [type, setType] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Map<string, QuestionRow>>(new Map());
  const banks = useQuery({ queryKey: ["banks", "all"], queryFn: () => api.get<Paged<Bank>>("/banks?pageSize=500"), enabled: open });
  const list = useQuery({
    queryKey: ["questions", "picker", bankId, type, q, page],
    queryFn: () => api.get<Paged<QuestionRow>>(`/questions${qs({ bankId, type, q, page, pageSize: 30 })}`),
    enabled: open,
  });
  useEffect(() => {
    if (open) setSelected(new Map());
  }, [open]);
  const available = list.data?.items.filter((r) => !exclude.has(r.id) && r.status !== "archived") ?? [];

  return (
    <Modal
      open={open}
      wide
      title="Pilih soal"
      onClose={onClose}
      footer={<><span className="muted">{selected.size} dipilih</span><Button onClick={onClose}>Batal</Button><Button variant="primary" disabled={!selected.size} onClick={() => onPick([...selected.values()])}>Tambahkan</Button></>}
    >
      <Toolbar>
        <Select value={bankId} onChange={(e) => { setBankId(e.target.value); setPage(1); }}>
          <option value="">Semua bank</option>
          {banks.data?.items.map((b) => <option key={b.id} value={b.id}>{b.code} - {b.name}</option>)}
        </Select>
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">Semua jenis</option>
          {QUESTION_TYPES.map((t) => <option key={t} value={t}>{QUESTION_TYPE_META[t].label}</option>)}
        </Select>
        <Input placeholder="Cari…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Button size="sm" onClick={() => setSelected((m) => { const n = new Map(m); available.forEach((r) => n.set(r.id, r)); return n; })}>Pilih semua di halaman</Button>
      </Toolbar>
      {list.isLoading ? <Loading /> : (
        <>
          <table className="table table-compact">
            <tbody>
              {list.data?.items.map((r) => {
                const used = exclude.has(r.id);
                return (
                  <tr key={r.id} className={used ? "is-disabled" : ""}>
                    <td style={{ width: "2rem" }}>
                      <input
                        type="checkbox"
                        disabled={used || r.status === "archived"}
                        checked={selected.has(r.id)}
                        onChange={(e) => setSelected((m) => { const n = new Map(m); if (e.target.checked) n.set(r.id, r); else n.delete(r.id); return n; })}
                      />
                    </td>
                    <td className="mono">{r.code ?? "-"}</td>
                    <td><Badge tone="info">{QUESTION_TYPE_META[r.type].label}</Badge></td>
                    <td>{stripHtml(r.content.prompt, 100)}{used ? <span className="muted small"> (sudah dipakai)</span> : null}</td>
                    <td><StatusBadge status={r.status} /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {list.data ? <Pagination page={page} pageSize={30} total={list.data.total} onPage={setPage} /> : null}
        </>
      )}
    </Modal>
  );
}
