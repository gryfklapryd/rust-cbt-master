import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Html, QuestionView } from "@cbt/question-ui";
import { QUESTION_TYPE_META, type QuestionType } from "@cbt/shared";
import { Badge, Button, Card, Checkbox, Empty, ErrorBox, Field, Input, Loading, PageHeader, Pagination, Select, Textarea, Toolbar, useToast } from "../components/ui";
import { api, qs, request, type Paged } from "../lib/api";
import { useAssetResolver } from "../lib/assets";
import { fmtNum } from "../lib/format";
import { useAction } from "../lib/hooks";

interface Rubric {
  id: string;
  criterion: string;
  maxPoints: number;
}
interface QueueItem {
  attemptId: string;
  questionId: string;
  response: unknown;
  gradeStatus: string;
  score: number | null;
  maxScore: number | null;
  rubricScores: Record<string, number> | null;
  feedback: string | null;
  scheduleName: string;
  question: {
    type: QuestionType;
    content: { prompt: string };
    answerKey: { modelAnswer?: string; rubric?: Rubric[]; graderNotes?: string };
    scoring: { points: number };
  } | null;
}

async function openAttachment(id: string) {
  const res = await request<Response>("GET", `/results/attachments/${id}`, undefined, { raw: true });
  const url = URL.createObjectURL(await res.blob());
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function GradeCard({ item, onSaved }: { item: QueueItem; onSaved: () => void }) {
  const q = item.question;
  const rubric = q?.answerKey.rubric ?? [];
  const [rubricScores, setRubricScores] = useState<Record<string, string>>({});
  const [score, setScore] = useState("");
  const [feedback, setFeedback] = useState(item.feedback ?? "");
  const resolve = useAssetResolver(q?.content);
  const toast = useToast();
  useEffect(() => {
    setRubricScores(Object.fromEntries(Object.entries(item.rubricScores ?? {}).map(([k, v]) => [k, String(v)])));
    setScore(item.gradeStatus === "manual" && item.score !== null ? String(item.score) : "");
  }, [item]);

  const save = useAction(
    () =>
      api.post<{ score: number; maxScore: number }>("/results/manual-grade", {
        attemptId: item.attemptId,
        questionId: item.questionId,
        ...(rubric.length
          ? { rubricScores: Object.fromEntries(rubric.map((r) => [r.id, Number(rubricScores[r.id] ?? 0) || 0])) }
          : { score: Number(score) }),
        feedback: feedback || null,
      }),
    { success: (r) => `Tersimpan: ${fmtNum(r.score)} / ${r.maxScore}`, invalidate: [["manual-queue"]], onSuccess: onSaved },
  );
  const files = (item.response as { files?: { attachmentId: string; name: string; size: number }[] } | null)?.files ?? [];

  return (
    <Card
      title={<>{q ? <Badge tone="info">{QUESTION_TYPE_META[q.type].label}</Badge> : null} <span className="muted small">{item.scheduleName} · peserta disamarkan</span></>}
      actions={item.gradeStatus === "manual" ? <Badge tone="success">sudah dikoreksi: {fmtNum(item.score)}</Badge> : <Badge tone="warning">belum dikoreksi</Badge>}
    >
      <div className="grid-2">
        <div>
          {q ? <QuestionView type={q.type} content={q.content} value={item.response} readOnly resolveAsset={resolve} /> : null}
          {files.length ? (
            <div className="actions">
              {files.map((f) => (
                <Button key={f.attachmentId} size="sm" onClick={() => openAttachment(f.attachmentId).catch((e) => toast.error(e))}>📎 {f.name}</Button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="stack">
          {q?.answerKey.modelAnswer ? (
            <div className="preview-box">
              <div className="muted small">Contoh jawaban</div>
              <Html html={q.answerKey.modelAnswer} resolveAsset={resolve} />
            </div>
          ) : null}
          {q?.answerKey.graderNotes ? <p className="muted small">Catatan: {q.answerKey.graderNotes}</p> : null}
          {rubric.length ? (
            <table className="table table-compact">
              <thead><tr><th>Kriteria</th><th>Skor</th></tr></thead>
              <tbody>
                {rubric.map((r) => (
                  <tr key={r.id}>
                    <td>{r.criterion}</td>
                    <td style={{ width: "8rem" }}>
                      <Input type="number" min={0} max={r.maxPoints} step="any" value={rubricScores[r.id] ?? ""} placeholder={`0–${r.maxPoints}`} onChange={(e) => setRubricScores({ ...rubricScores, [r.id]: e.target.value })} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <Field label={`Skor (0–${q?.scoring.points ?? item.maxScore})`}>
              <Input type="number" min={0} max={q?.scoring.points ?? undefined} step="any" value={score} onChange={(e) => setScore(e.target.value)} />
            </Field>
          )}
          {rubric.length ? <p className="muted small">Total rubrik diskalakan ke skor maksimum soal ({q?.scoring.points} poin).</p> : null}
          <Field label="Catatan untuk peserta (opsional)"><Textarea rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} /></Field>
          <Button variant="primary" loading={save.isPending} disabled={!rubric.length && score === ""} onClick={() => save.mutate(undefined)}>Simpan nilai</Button>
        </div>
      </div>
    </Card>
  );
}

export function GradingPage() {
  const [page, setPage] = useState(1);
  const [examId, setExamId] = useState("");
  const [includeGraded, setIncludeGraded] = useState(false);
  const exams = useQuery({ queryKey: ["exams", "all"], queryFn: () => api.get<Paged<{ id: string; code: string; title: string }>>("/exams?pageSize=500") });
  const queue = useQuery({
    queryKey: ["manual-queue", page, examId, includeGraded],
    queryFn: () => api.get<Paged<QueueItem>>(`/results/manual-queue${qs({ page, pageSize: 10, examId, includeGraded })}`),
  });
  return (
    <>
      <PageHeader title="Koreksi" subtitle="Penilaian manual jawaban uraian dan unggahan berkas. Identitas peserta disamarkan." />
      <Toolbar>
        <Select value={examId} onChange={(e) => { setExamId(e.target.value); setPage(1); }}>
          <option value="">Semua ujian</option>
          {exams.data?.items.map((x) => <option key={x.id} value={x.id}>{x.code} — {x.title}</option>)}
        </Select>
        <Checkbox label="Tampilkan yang sudah dikoreksi" checked={includeGraded} onChange={(e) => { setIncludeGraded(e.target.checked); setPage(1); }} />
        <span className="muted">{queue.data ? `${queue.data.total} jawaban` : ""}</span>
      </Toolbar>
      <ErrorBox error={queue.error} />
      {queue.isLoading ? <Loading /> : !queue.data?.items.length ? <Empty>Tidak ada jawaban yang menunggu koreksi. 🎉</Empty> : (
        <div className="stack">
          {queue.data.items.map((item) => (
            <GradeCard key={`${item.attemptId}:${item.questionId}`} item={item} onSaved={() => {}} />
          ))}
          <Pagination page={page} pageSize={10} total={queue.data.total} onPage={setPage} />
        </div>
      )}
    </>
  );
}
