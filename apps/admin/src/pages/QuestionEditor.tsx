import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { Html, QuestionView } from "@cbt/question-ui";
import {
  QUESTION_TYPE_META,
  QUESTION_TYPES,
  QuestionDefinition,
  Scoring,
  gradeResponse,
  questionTemplate,
  type QuestionType,
} from "@cbt/shared";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ErrorBox,
  Field,
  Input,
  JsonEditor,
  Loading,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  useToast,
} from "../components/ui";
import { api } from "../lib/api";
import { useAssetResolver } from "../lib/assets";
import { fmtNum } from "../lib/format";
import { InlineAssetUpload, assetSnippet } from "./Assets";
import type { QuestionRow, Stimulus } from "./Banks";

interface QuestionFull extends QuestionRow {
  answerKey: unknown;
  scoring: { points: number; mode: "all_or_nothing" | "partial"; penalty: number; allowNegative: boolean };
  stimulus: Stimulus | null;
}

const pretty = (v: unknown) => JSON.stringify(v, null, 2);

function tryParse(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

export function QuestionEditorPage() {
  const { bankId, questionId } = useParams<{ bankId: string; questionId?: string }>();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const isNew = !questionId;

  const existing = useQuery({
    queryKey: ["question", questionId],
    queryFn: () => api.get<QuestionFull>(`/questions/${questionId}`),
    enabled: !isNew,
  });
  const stimuli = useQuery({ queryKey: ["stimuli", bankId], queryFn: () => api.get<Stimulus[]>(`/banks/${bankId}/stimuli`) });
  const stats = useQuery({
    queryKey: ["question-stats", questionId],
    queryFn: () => api.get<{ responses: number; fullyCorrect: number; difficultyIndex: number | null; avgTimeSeconds: number | null }>(`/questions/${questionId}/stats`),
    enabled: !isNew,
  });

  const [type, setType] = useState<QuestionType>((search.get("type") as QuestionType) ?? "single_choice");
  const [contentText, setContentText] = useState("");
  const [keyText, setKeyText] = useState("");
  const [meta, setMeta] = useState({ code: "", difficulty: "", tags: "", status: "draft", stimulusId: "" });
  const [scoring, setScoring] = useState({ points: "1", mode: "all_or_nothing", penalty: "0", allowNegative: false });
  const [response, setResponse] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [serverError, setServerError] = useState<unknown>(null);
  const [loaded, setLoaded] = useState(false);

  const loadTemplate = (t: QuestionType) => {
    const tpl = questionTemplate(t);
    setContentText(pretty(tpl.definition.content));
    setKeyText(pretty(tpl.definition.answerKey));
    setScoring((s) => ({ ...s, mode: tpl.scoring.mode ?? "all_or_nothing" }));
    setResponse(null);
  };

  useEffect(() => {
    if (loaded) return;
    if (isNew) {
      loadTemplate(type);
      setLoaded(true);
    } else if (existing.data) {
      const q = existing.data;
      setType(q.type);
      setContentText(pretty(q.content));
      setKeyText(pretty(q.answerKey));
      setMeta({ code: q.code ?? "", difficulty: q.difficulty ?? "", tags: q.tags.join(", "), status: q.status, stimulusId: q.stimulusId ?? "" });
      setScoring({ points: String(q.scoring.points), mode: q.scoring.mode, penalty: String(q.scoring.penalty ?? 0), allowNegative: !!q.scoring.allowNegative });
      setLoaded(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing.data, isNew, loaded]);

  const content = tryParse(contentText);
  const key = tryParse(keyText);
  const scoringValue = useMemo(
    () => Scoring.safeParse({ points: Number(scoring.points), mode: scoring.mode, penalty: Number(scoring.penalty) || 0, allowNegative: scoring.allowNegative }),
    [scoring],
  );
  const validation = useMemo(() => {
    if (!content.ok || !key.ok) return null;
    return QuestionDefinition.safeParse({ type, content: content.value, answerKey: key.value });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, contentText, keyText]);
  const definition = validation?.success ? validation.data : null;
  const grade = definition && scoringValue.success ? gradeResponse(definition, scoringValue.data, response) : null;
  const resolve = useAssetResolver(content.ok ? content.value : null);
  const stimulus = stimuli.data?.find((s) => s.id === meta.stimulusId);
  const resolveStimulus = useAssetResolver(stimulus?.content);

  // Editor teks soal (prompt) yang tersinkron dengan JSON konten.
  const prompt = content.ok && content.value && typeof content.value === "object" ? String((content.value as { prompt?: string }).prompt ?? "") : "";
  const setPrompt = (p: string) => {
    if (!content.ok) return;
    setContentText(pretty({ ...(content.value as object), prompt: p }));
  };

  const save = async () => {
    setServerError(null);
    if (!definition || !scoringValue.success) {
      toast.error(new Error("Perbaiki kesalahan validasi terlebih dahulu"));
      return;
    }
    setSaving(true);
    try {
      const body = {
        bankId,
        type,
        content: definition.content,
        answerKey: definition.answerKey,
        scoring: scoringValue.data,
        code: meta.code || null,
        difficulty: meta.difficulty || null,
        tags: meta.tags.split(",").map((t) => t.trim()).filter(Boolean),
        status: meta.status,
        stimulusId: meta.stimulusId || null,
      };
      const saved = isNew ? await api.post<QuestionFull>("/questions", body) : await api.patch<QuestionFull>(`/questions/${questionId}`, body);
      toast.success(isNew ? "Soal dibuat" : `Soal disimpan (v${saved.version})`);
      void qc.invalidateQueries({ queryKey: ["questions"] });
      void qc.invalidateQueries({ queryKey: ["bank", bankId] });
      void qc.invalidateQueries({ queryKey: ["question", saved.id] });
      if (isNew) navigate(`/banks/${bankId}/questions/${saved.id}`, { replace: true });
    } catch (err) {
      setServerError(err);
    } finally {
      setSaving(false);
    }
  };

  if (!isNew && existing.isLoading) return <Loading />;
  const typeMeta = QUESTION_TYPE_META[type];

  return (
    <>
      <PageHeader
        title={isNew ? "Soal baru" : `Soal ${existing.data?.code ?? ""}`}
        subtitle={
          <>
            <Badge tone="info">{typeMeta.label}</Badge> {typeMeta.description}{" "}
            {!typeMeta.autoGraded ? <Badge tone="warning">dinilai manual</Badge> : null}
            {existing.data ? <> · v{existing.data.version} · <StatusBadge status={existing.data.status} /></> : null}
          </>
        }
        actions={
          <>
            <Link className="btn btn-ghost" to={`/banks/${bankId}`}>← Kembali</Link>
            <Button variant="primary" loading={saving} onClick={save}>Simpan</Button>
          </>
        }
      />
      <ErrorBox error={existing.error ?? serverError} />
      <div className="editor-grid">
        <div className="stack">
          <Card title="Pengaturan">
            <div className="grid-3">
              <Field label="Jenis soal">
                <Select
                  value={type}
                  onChange={(e) => {
                    const t = e.target.value as QuestionType;
                    if (!window.confirm("Ganti jenis soal? Konten & kunci akan diganti dengan contoh jenis baru.")) return;
                    setType(t);
                    loadTemplate(t);
                  }}
                >
                  {QUESTION_TYPES.map((t) => <option key={t} value={t}>{QUESTION_TYPE_META[t].label}</option>)}
                </Select>
              </Field>
              <Field label="Kode soal"><Input value={meta.code} onChange={(e) => setMeta({ ...meta, code: e.target.value })} /></Field>
              <Field label="Status">
                <Select value={meta.status} onChange={(e) => setMeta({ ...meta, status: e.target.value })}>
                  <option value="draft">Draf</option><option value="ready">Siap</option><option value="archived">Arsip</option>
                </Select>
              </Field>
              <Field label="Tingkat kesulitan">
                <Select value={meta.difficulty} onChange={(e) => setMeta({ ...meta, difficulty: e.target.value })}>
                  <option value="">-</option><option value="easy">Mudah</option><option value="medium">Sedang</option><option value="hard">Sulit</option>
                </Select>
              </Field>
              <Field label="Tag" hint="Pisahkan dengan koma"><Input value={meta.tags} onChange={(e) => setMeta({ ...meta, tags: e.target.value })} /></Field>
              <Field label="Stimulus / bacaan">
                <Select value={meta.stimulusId} onChange={(e) => setMeta({ ...meta, stimulusId: e.target.value })}>
                  <option value="">Tanpa stimulus</option>
                  {stimuli.data?.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </Select>
              </Field>
            </div>
          </Card>

          <Card title="Skor">
            <div className="grid-3">
              <Field label="Poin maksimum" hint="0 = tidak dinilai (angket)">
                <Input type="number" min={0} step="any" value={scoring.points} onChange={(e) => setScoring({ ...scoring, points: e.target.value })} />
              </Field>
              <Field label="Mode">
                <Select value={scoring.mode} onChange={(e) => setScoring({ ...scoring, mode: e.target.value })}>
                  <option value="all_or_nothing">Semua atau tidak sama sekali</option>
                  <option value="partial">Parsial (proporsional)</option>
                </Select>
              </Field>
              <Field label="Penalti jawaban salah" hint="Dikurangkan bila salah total">
                <Input type="number" min={0} step="any" value={scoring.penalty} onChange={(e) => setScoring({ ...scoring, penalty: e.target.value })} />
              </Field>
            </div>
            <Checkbox label="Izinkan skor negatif" checked={scoring.allowNegative} onChange={(e) => setScoring({ ...scoring, allowNegative: e.target.checked })} />
            {!scoringValue.success ? <div className="field-error">{scoringValue.error.issues.map((i) => i.message).join("; ")}</div> : null}
          </Card>

          <Card
            title="Teks soal"
            actions={<InlineAssetUpload onUploaded={(a) => setPrompt(`${prompt}\n${assetSnippet(a)}`)} />}
          >
            <Textarea className="mono" rows={5} value={prompt} disabled={!content.ok} onChange={(e) => setPrompt(e.target.value)} />
            <p className="muted small">HTML. Media: <code>&lt;img src="asset://…"&gt;</code>. Rumus: <code>\( … \)</code>.</p>
          </Card>

          <Card title="Konten (JSON)" actions={<Button size="sm" variant="ghost" onClick={() => window.confirm("Ganti konten & kunci dengan contoh?") && loadTemplate(type)}>Isi contoh</Button>}>
            <JsonEditor value={contentText} onChange={setContentText} rows={16} />
          </Card>
          <Card title="Kunci jawaban / rubrik (JSON)">
            <p className="muted small">Bagian ini hanya disimpan di server pusat dan tidak pernah dikirim ke titik ujian.</p>
            <JsonEditor value={keyText} onChange={setKeyText} rows={10} />
          </Card>
          {validation && !validation.success ? (
            <Card title="Kesalahan validasi">
              <ul className="issues">
                {validation.error.issues.map((i, idx) => (
                  <li key={idx}><code>{i.path.join(".") || "(root)"}</code> {i.message}</li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>

        <div className="stack sticky">
          <Card title="Pratinjau (tampilan peserta)" actions={<Button size="sm" variant="ghost" onClick={() => setResponse(null)}>Kosongkan jawaban</Button>}>
            {stimulus ? (
              <div className="stimulus-box">
                <div className="muted small">{stimulus.title}</div>
                <Html html={stimulus.content} resolveAsset={resolveStimulus} />
              </div>
            ) : null}
            {definition ? (
              <QuestionView type={type} content={definition.content} value={response} onChange={setResponse} resolveAsset={resolve} />
            ) : (
              <p className="muted">Pratinjau muncul setelah konten & kunci valid.</p>
            )}
          </Card>
          <Card title="Uji kunci">
            {grade ? (
              <dl className="kv">
                <dt>Status</dt>
                <dd><StatusBadge status={grade.status} /></dd>
                <dt>Skor</dt>
                <dd>{grade.score === null ? "menunggu koreksi manual" : `${fmtNum(grade.score, 4)} / ${grade.maxScore}`}</dd>
                {grade.fraction !== null ? (<><dt>Proporsi benar</dt><dd>{fmtNum(grade.fraction * 100)}%</dd></>) : null}
                {grade.error ? (<><dt>Kesalahan</dt><dd className="text-danger">{grade.error}</dd></>) : null}
              </dl>
            ) : <p className="muted">-</p>}
            <details>
              <summary className="muted small">Jawaban (JSON yang dikirim desktop)</summary>
              <pre className="code-block">{pretty(response)}</pre>
              {grade?.details ? <pre className="code-block">{pretty(grade.details)}</pre> : null}
            </details>
          </Card>
          {!isNew && stats.data ? (
            <Card title="Statistik butir">
              <dl className="kv">
                <dt>Jumlah jawaban</dt><dd>{stats.data.responses}</dd>
                <dt>Benar penuh</dt><dd>{stats.data.fullyCorrect}</dd>
                <dt>Tingkat kesukaran (p)</dt><dd>{fmtNum(stats.data.difficultyIndex, 3)}</dd>
                <dt>Rata-rata waktu</dt><dd>{stats.data.avgTimeSeconds ? `${fmtNum(stats.data.avgTimeSeconds, 0)} detik` : "-"}</dd>
              </dl>
            </Card>
          ) : null}
        </div>
      </div>
    </>
  );
}
