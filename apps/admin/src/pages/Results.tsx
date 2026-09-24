import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { QuestionView } from "@cbt/question-ui";
import { QUESTION_TYPE_META, type QuestionType } from "@cbt/shared";
import {
  Badge,
  Button,
  Card,
  ConfirmButton,
  Empty,
  ErrorBox,
  Input,
  Loading,
  PageHeader,
  Pagination,
  Select,
  Stat,
  StatusBadge,
  Toolbar,
} from "../components/ui";
import { api, download, qs, type Paged } from "../lib/api";
import { useAssetResolver } from "../lib/assets";
import { useAuth } from "../lib/auth";
import { fmtDate, fmtNum } from "../lib/format";
import { useAction } from "../lib/hooks";

interface AttemptRow {
  id: string;
  status: string;
  gradingStatus: string;
  startedAt: string;
  finishedAt: string | null;
  score: number | null;
  maxScore: number | null;
  scaledScore: number | null;
  correctCount: number | null;
  answeredCount: number | null;
  violationCount: number;
  participant: { id: string; number: string; name: string; groupName: string | null };
  schedule: { id: string; name: string };
  site: { id: string; code: string; name: string };
  exam: { id: string; code: string; title: string };
}
interface Summary {
  attempts: number;
  submitted: number;
  graded: number;
  avgScore: number | null;
  minScore: number | null;
  maxScore: number | null;
  stddev: number | null;
  distribution: number[];
}

/** Histogram nilai 0-100 (satu seri, satu warna). Tooltip per batang + tabel alternatif. */
function Distribution({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  const labels = data.map((_, i) => (i === 9 ? "90–100" : `${i * 10}–${i * 10 + 9}`));
  return (
    <figure className="histogram" aria-label="Sebaran nilai peserta">
      <div className="histogram-plot">
        {data.map((n, i) => (
          <div key={i} className="histogram-col" title={`Nilai ${labels[i]}: ${n} peserta`}>
            <span className="histogram-value">{n || ""}</span>
            <div className="histogram-bar" style={{ height: `${(n / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="histogram-axis">
        {labels.map((l) => (
          <span key={l}>{l.split("–")[0]}</span>
        ))}
      </div>
      <details>
        <summary className="muted small">Lihat sebagai tabel</summary>
        <table className="table table-compact">
          <thead><tr><th>Rentang nilai</th><th>Peserta</th></tr></thead>
          <tbody>{data.map((n, i) => <tr key={i}><td>{labels[i]}</td><td>{n}</td></tr>)}</tbody>
        </table>
      </details>
    </figure>
  );
}

export function ResultsPage() {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const filters = {
    scheduleId: params.get("scheduleId") ?? "",
    examId: params.get("examId") ?? "",
    siteId: params.get("siteId") ?? "",
    gradingStatus: params.get("gradingStatus") ?? "",
    q: params.get("q") ?? "",
  };
  const setFilter = (k: keyof typeof filters, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v);
    else next.delete(k);
    setParams(next, { replace: true });
    setPage(1);
  };
  const { can } = useAuth();
  const list = useQuery({ queryKey: ["attempts", filters, page], queryFn: () => api.get<Paged<AttemptRow>>(`/results/attempts${qs({ ...filters, page, pageSize: 50 })}`) });
  const summary = useQuery({ queryKey: ["results-summary", filters], queryFn: () => api.get<Summary>(`/results/summary${qs({ ...filters, q: undefined })}`) });
  const exams = useQuery({ queryKey: ["exams", "all"], queryFn: () => api.get<Paged<{ id: string; code: string; title: string }>>("/exams?pageSize=500") });
  const sites = useQuery({ queryKey: ["sites", "all"], queryFn: () => api.get<Paged<{ id: string; code: string }>>("/sites?pageSize=500") });
  const regrade = useAction(
    (refreshKeys: boolean) => api.post<{ queued: number }>("/results/regrade", { scheduleId: filters.scheduleId || undefined, examId: filters.examId || undefined, refreshKeys }),
    { success: (r) => `${r.queued} attempt dinilai ulang di antrean`, invalidate: [["attempts"], ["results-summary"]] },
  );

  return (
    <>
      <PageHeader
        title="Hasil Ujian"
        subtitle="Hasil yang dikirim titik ujian, dinilai otomatis oleh worker"
        actions={
          <>
            {can("admin") && (filters.scheduleId || filters.examId) ? (
              <>
                <ConfirmButton confirm="Nilai ulang semua attempt dengan kunci pada paket?" onConfirm={() => regrade.mutateAsync(false)}>Nilai ulang</ConfirmButton>
                <ConfirmButton confirm="Perbarui kunci jawaban paket dari bank soal saat ini, lalu nilai ulang? Gunakan ini bila ada kunci yang salah." onConfirm={() => regrade.mutateAsync(true)}>Koreksi kunci &amp; nilai ulang</ConfirmButton>
              </>
            ) : null}
            <Button variant="primary" onClick={() => download(`/results/attempts/export.csv${qs({ ...filters, q: undefined })}`, "hasil-ujian.csv")}>Ekspor CSV</Button>
          </>
        }
      />
      {summary.data ? (
        <div className="grid-2">
          <div className="stats stats-compact">
            <Stat label="Hasil diterima" value={summary.data.attempts} hint={`${summary.data.submitted} selesai`} />
            <Stat label="Dinilai lengkap" value={summary.data.graded} />
            <Stat label="Rata-rata" value={fmtNum(summary.data.avgScore)} hint={`simpangan baku ${fmtNum(summary.data.stddev)}`} />
            <Stat label="Terendah / tertinggi" value={`${fmtNum(summary.data.minScore)} / ${fmtNum(summary.data.maxScore)}`} />
          </div>
          <Card title="Sebaran nilai (skala 100)">
            <Distribution data={summary.data.distribution} />
          </Card>
        </div>
      ) : null}
      <Card>
        <Toolbar>
          <Input placeholder="Cari nomor / nama…" value={filters.q} onChange={(e) => setFilter("q", e.target.value)} />
          <Select value={filters.examId} onChange={(e) => setFilter("examId", e.target.value)}>
            <option value="">Semua ujian</option>
            {exams.data?.items.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </Select>
          <Select value={filters.siteId} onChange={(e) => setFilter("siteId", e.target.value)}>
            <option value="">Semua lokasi</option>
            {sites.data?.items.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </Select>
          <Select value={filters.gradingStatus} onChange={(e) => setFilter("gradingStatus", e.target.value)}>
            <option value="">Semua status penilaian</option>
            <option value="pending">Menunggu</option><option value="partial">Sebagian (perlu koreksi)</option><option value="complete">Lengkap</option>
          </Select>
          {filters.scheduleId ? <Button size="sm" variant="ghost" onClick={() => setFilter("scheduleId", "")}>✕ filter jadwal</Button> : null}
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada hasil.</Empty> : (
          <>
            <table className="table">
              <thead><tr><th>Peserta</th><th>Ujian / jadwal</th><th>Lokasi</th><th>Status</th><th>Penilaian</th><th>Skor</th><th>Nilai</th><th>Benar</th><th>Pelanggaran</th></tr></thead>
              <tbody>
                {list.data.items.map((a) => (
                  <tr key={a.id}>
                    <td><Link to={`/results/${a.id}`}><span className="mono">{a.participant.number}</span> {a.participant.name}</Link><div className="muted small">{a.participant.groupName}</div></td>
                    <td><span className="mono">{a.exam.code}</span><div className="muted small">{a.schedule.name}</div></td>
                    <td className="mono">{a.site.code}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td><StatusBadge status={a.gradingStatus} /></td>
                    <td>{fmtNum(a.score)} / {fmtNum(a.maxScore)}</td>
                    <td><strong>{fmtNum(a.scaledScore)}</strong></td>
                    <td>{a.correctCount ?? "-"}</td>
                    <td>{a.violationCount ? <Badge tone="warning">{a.violationCount}</Badge> : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

interface AttemptDetail extends AttemptRow {
  questionOrder: string[] | null;
  client: Record<string, unknown> | null;
  sequence: number;
  packageVersion: number | null;
  answers: {
    questionId: string;
    code: string | null;
    response: unknown;
    timeSpentSeconds: number | null;
    flagged: boolean;
    changeCount: number | null;
    gradeStatus: string;
    score: number | null;
    maxScore: number | null;
    feedback: string | null;
    autoResult: { error?: string } | null;
    question: { type: QuestionType; content: unknown; answerKey: unknown; scoring: { points: number } } | null;
  }[];
  events: { id: string; type: string; at: string; data: Record<string, unknown> | null }[];
}

export function AttemptDetailPage() {
  const { attemptId } = useParams<{ attemptId: string }>();
  const { can } = useAuth();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: ["attempt", attemptId], queryFn: () => api.get<AttemptDetail>(`/results/attempts/${attemptId}`) });
  const resolve = useAssetResolver(detail.data?.answers.map((a) => a.question?.content));
  const regrade = useAction(() => api.post(`/results/attempts/${attemptId}/regrade`), { success: "Dinilai ulang di antrean", invalidate: [["attempt", attemptId]] });
  const remove = useAction(() => api.del(`/results/attempts/${attemptId}`), { success: "Attempt dihapus", onSuccess: () => navigate("/results") });

  if (detail.isLoading) return <Loading />;
  if (!detail.data) return <ErrorBox error={detail.error} />;
  const a = detail.data;
  return (
    <>
      <PageHeader
        title={<><span className="mono">{a.participant.number}</span> {a.participant.name}</>}
        subtitle={<>{a.exam.title} · {a.schedule.name} · <span className="mono">{a.site.code}</span> · paket v{a.packageVersion}</>}
        actions={
          <>
            <Link className="btn btn-ghost" to={`/results?scheduleId=${a.schedule.id}`}>← Hasil jadwal</Link>
            {can("admin", "grader") ? <Button onClick={() => regrade.mutate(undefined)}>Nilai ulang</Button> : null}
            {can("admin") ? <ConfirmButton variant="danger" confirm="Hapus attempt ini? Peserta bisa mengulang ujian dan hasil baru bisa dikirim." onConfirm={() => remove.mutateAsync(undefined)}>Hapus / reset</ConfirmButton> : null}
          </>
        }
      />
      <div className="stats">
        <Stat label="Nilai" value={fmtNum(a.scaledScore)} hint={`${fmtNum(a.score)} / ${fmtNum(a.maxScore)} poin`} />
        <Stat label="Status" value={<StatusBadge status={a.status} />} hint={<StatusBadge status={a.gradingStatus} />} />
        <Stat label="Dijawab / benar" value={`${a.answeredCount ?? "-"} / ${a.correctCount ?? "-"}`} />
        <Stat label="Waktu" value={fmtDate(a.startedAt)} hint={`selesai ${fmtDate(a.finishedAt)}`} />
        <Stat label="Pelanggaran" value={a.violationCount} hint={a.client?.deviceId ? `perangkat ${String(a.client.deviceId)}` : undefined} />
      </div>
      <div className="editor-grid">
        <div className="stack">
          {a.answers.map((ans, i) => (
            <Card
              key={ans.questionId}
              title={<>#{i + 1} <span className="mono">{ans.code ?? ""}</span> {ans.question ? <Badge tone="info">{QUESTION_TYPE_META[ans.question.type].label}</Badge> : null}</>}
              actions={<><StatusBadge status={ans.gradeStatus} /> <strong>{ans.score === null ? "?" : fmtNum(ans.score, 4)} / {fmtNum(ans.maxScore)}</strong></>}
            >
              {ans.question ? (
                <QuestionView type={ans.question.type} content={ans.question.content} value={ans.response} readOnly resolveAsset={resolve} />
              ) : (
                <pre className="code-block">{JSON.stringify(ans.response, null, 2)}</pre>
              )}
              <div className="muted small answer-meta">
                {ans.timeSpentSeconds !== null ? `${ans.timeSpentSeconds} detik` : ""}
                {ans.changeCount ? ` · diubah ${ans.changeCount}×` : ""}
                {ans.flagged ? " · ditandai ragu-ragu" : ""}
                {ans.autoResult?.error ? <span className="text-danger"> · {ans.autoResult.error}</span> : null}
              </div>
              {ans.feedback ? <p className="feedback">Catatan korektor: {ans.feedback}</p> : null}
              <details>
                <summary className="muted small">Kunci jawaban</summary>
                <pre className="code-block">{JSON.stringify(ans.question?.answerKey, null, 2)}</pre>
              </details>
            </Card>
          ))}
        </div>
        <div className="stack">
          <Card title={`Log kejadian (${a.events.length})`}>
            {!a.events.length ? <Empty>Tidak ada.</Empty> : (
              <ul className="timeline">
                {a.events.map((e) => (
                  <li key={e.id} className={e.type === "violation" ? "is-danger" : ""}>
                    <span className="muted small">{fmtDate(e.at)}</span> <strong>{e.type}</strong>
                    {e.data ? <div className="muted small mono">{JSON.stringify(e.data)}</div> : null}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}
