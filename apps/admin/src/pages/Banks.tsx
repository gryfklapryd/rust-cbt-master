import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Html } from "@cbt/question-ui";
import { QUESTION_TYPE_META, QUESTION_TYPES, type QuestionType } from "@cbt/shared";
import {
  Badge,
  Button,
  Card,
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
  Tabs,
  Textarea,
  Toolbar,
  useToast,
} from "../components/ui";
import { api, qs, type Paged } from "../lib/api";
import { useAssetResolver } from "../lib/assets";
import { useAuth } from "../lib/auth";
import { fmtDate, stripHtml } from "../lib/format";
import { useAction } from "../lib/hooks";
import { InlineAssetUpload, assetSnippet } from "./Assets";

export interface Bank {
  id: string;
  code: string;
  name: string;
  subject: string | null;
  description: string | null;
  questionCount?: number;
  updatedAt: string;
  stats?: Record<string, number>;
}
export interface QuestionRow {
  id: string;
  bankId: string;
  stimulusId: string | null;
  code: string | null;
  type: QuestionType;
  content: { prompt?: string };
  scoring: { points: number; mode: string };
  difficulty: string | null;
  tags: string[];
  status: string;
  version: number;
  updatedAt: string;
}
export interface Stimulus {
  id: string;
  bankId: string;
  title: string;
  content: string;
  settings: { mediaPlayLimit: number };
}

export function BanksPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Bank | "new" | null>(null);
  const [form, setForm] = useState({ code: "", name: "", subject: "", description: "" });
  const list = useQuery({ queryKey: ["banks", page, q], queryFn: () => api.get<Paged<Bank>>(`/banks${qs({ page, pageSize: 50, q })}`) });

  const save = useAction(
    () => {
      const body = { ...form, subject: form.subject || null, description: form.description || null };
      return editing === "new" ? api.post("/banks", body) : api.patch(`/banks/${(editing as Bank).id}`, body);
    },
    { success: "Bank soal disimpan", invalidate: [["banks"]], onSuccess: () => setEditing(null) },
  );
  const remove = useAction((b: Bank) => api.del(`/banks/${b.id}`), { success: "Bank soal dihapus", invalidate: [["banks"]] });
  const open = (b: Bank | "new") => {
    setEditing(b);
    setForm(b === "new" ? { code: "", name: "", subject: "", description: "" } : { code: b.code, name: b.name, subject: b.subject ?? "", description: b.description ?? "" });
  };

  return (
    <>
      <PageHeader title="Bank Soal" subtitle="Kumpulan soal per mata pelajaran / topik" actions={can("author") ? <Button variant="primary" onClick={() => open("new")}>+ Bank soal</Button> : null} />
      <Card>
        <Toolbar>
          <Input placeholder="Cari…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada bank soal.</Empty> : (
          <>
            <table className="table">
              <thead><tr><th>Kode</th><th>Nama</th><th>Mapel</th><th>Jumlah soal</th><th>Diubah</th><th /></tr></thead>
              <tbody>
                {list.data.items.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.code}</td>
                    <td><Link to={`/banks/${b.id}`}>{b.name}</Link></td>
                    <td>{b.subject ?? "-"}</td>
                    <td>{b.questionCount}</td>
                    <td>{fmtDate(b.updatedAt)}</td>
                    <td className="row-actions">
                      {can("author") ? <Button size="sm" onClick={() => open(b)}>Ubah</Button> : null}
                      {can("admin") ? (
                        <ConfirmButton size="sm" variant="danger" confirm={`Hapus bank ${b.code} beserta seluruh soalnya?`} onConfirm={() => remove.mutateAsync(b)}>Hapus</ConfirmButton>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
      <Modal
        open={!!editing}
        title={editing === "new" ? "Bank soal baru" : "Ubah bank soal"}
        onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Batal</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button></>}
      >
        <div className="grid-2">
          <Field label="Kode"><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
          <Field label="Mata pelajaran"><Input value={form.subject} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
        </div>
        <Field label="Nama"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <Field label="Deskripsi"><Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
      </Modal>
    </>
  );
}

export function BankDetailPage() {
  const { bankId } = useParams<{ bankId: string }>();
  const [tab, setTab] = useState<"questions" | "stimuli">("questions");
  const bank = useQuery({ queryKey: ["bank", bankId], queryFn: () => api.get<Bank>(`/banks/${bankId}`) });
  return (
    <>
      <PageHeader
        title={bank.data ? `${bank.data.name}` : "Bank soal"}
        subtitle={bank.data ? <><span className="mono">{bank.data.code}</span> · {bank.data.subject ?? "tanpa mapel"}</> : null}
        actions={<Link className="btn btn-ghost" to="/banks">← Semua bank</Link>}
      />
      <ErrorBox error={bank.error} />
      {bank.data?.stats && Object.keys(bank.data.stats).length ? (
        <div className="chips">
          {Object.entries(bank.data.stats).map(([t, n]) => (
            <Badge key={t} tone="info">{QUESTION_TYPE_META[t as QuestionType]?.label ?? t}: {n}</Badge>
          ))}
        </div>
      ) : null}
      <Tabs tabs={[{ id: "questions", label: "Soal" }, { id: "stimuli", label: "Stimulus / bacaan" }]} value={tab} onChange={setTab} />
      {tab === "questions" ? <QuestionsTab bankId={bankId!} /> : <StimuliTab bankId={bankId!} />}
    </>
  );
}

function QuestionsTab({ bankId }: { bankId: string }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [status, setStatus] = useState("");
  const [newType, setNewType] = useState<QuestionType>("single_choice");
  const list = useQuery({
    queryKey: ["questions", bankId, page, q, type, status],
    queryFn: () => api.get<Paged<QuestionRow>>(`/questions${qs({ bankId, page, pageSize: 50, q, type, status })}`),
  });
  const duplicate = useAction((id: string) => api.post<QuestionRow>(`/questions/${id}/duplicate`), {
    success: "Soal diduplikasi",
    invalidate: [["questions"], ["bank"]],
  });
  const remove = useAction((id: string) => api.del(`/questions/${id}`), { success: "Soal dihapus", invalidate: [["questions"], ["bank"]] });
  const importJson = useAction(
    async (file: File) => {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : data.questions;
      if (!Array.isArray(items)) throw new Error("File harus berisi array soal atau { questions: [...] }");
      return api.post<{ imported: number }>("/questions/import", { bankId, questions: items });
    },
    { success: (r) => `${r.imported} soal diimpor`, invalidate: [["questions"], ["bank"]] },
  );

  return (
    <Card
      actions={
        can("author") ? (
          <>
            <label className="btn btn-secondary btn-sm" title="Impor soal dari file JSON">
              Impor JSON
              <input type="file" accept="application/json,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) importJson.mutate(f, { onError: (err) => toast.error(err) }); }} />
            </label>
            <Select value={newType} onChange={(e) => setNewType(e.target.value as QuestionType)} aria-label="Jenis soal baru">
              {QUESTION_TYPES.map((t) => <option key={t} value={t}>{QUESTION_TYPE_META[t].label}</option>)}
            </Select>
            <Button variant="primary" size="sm" onClick={() => navigate(`/banks/${bankId}/questions/new?type=${newType}`)}>+ Soal baru</Button>
          </>
        ) : null
      }
    >
      <Toolbar>
        <Input placeholder="Cari kode / teks soal…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <Select value={type} onChange={(e) => { setType(e.target.value); setPage(1); }}>
          <option value="">Semua jenis</option>
          {QUESTION_TYPES.map((t) => <option key={t} value={t}>{QUESTION_TYPE_META[t].label}</option>)}
        </Select>
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">Semua status</option>
          <option value="draft">Draf</option>
          <option value="ready">Siap</option>
          <option value="archived">Arsip</option>
        </Select>
      </Toolbar>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada soal.</Empty> : (
        <>
          <table className="table">
            <thead><tr><th>Kode</th><th>Jenis</th><th>Soal</th><th>Poin</th><th>Status</th><th>Versi</th><th /></tr></thead>
            <tbody>
              {list.data.items.map((row) => (
                <tr key={row.id}>
                  <td className="mono">{row.code ?? "-"}</td>
                  <td><Badge tone="info">{QUESTION_TYPE_META[row.type].label}</Badge></td>
                  <td><Link to={`/banks/${bankId}/questions/${row.id}`}>{stripHtml(row.content.prompt) || "(tanpa teks)"}</Link>
                    {row.tags.length ? <div className="muted small">{row.tags.map((t) => `#${t}`).join(" ")}</div> : null}
                  </td>
                  <td>{row.scoring.points}</td>
                  <td><StatusBadge status={row.status} /></td>
                  <td>v{row.version}</td>
                  <td className="row-actions">
                    {can("author") ? (
                      <>
                        <Button size="sm" onClick={() => duplicate.mutate(row.id)}>Duplikat</Button>
                        <ConfirmButton size="sm" variant="danger" confirm="Hapus soal ini? (tidak bisa bila sudah dipakai ujian)" onConfirm={() => remove.mutateAsync(row.id)}>Hapus</ConfirmButton>
                      </>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  );
}

function StimuliTab({ bankId }: { bankId: string }) {
  const { can } = useAuth();
  const [editing, setEditing] = useState<Stimulus | "new" | null>(null);
  const [form, setForm] = useState({ title: "", content: "", mediaPlayLimit: "0" });
  const list = useQuery({ queryKey: ["stimuli", bankId], queryFn: () => api.get<Stimulus[]>(`/banks/${bankId}/stimuli`) });
  const resolve = useAssetResolver(form.content);
  const save = useAction(
    () => {
      const body = { title: form.title, content: form.content, settings: { mediaPlayLimit: Number(form.mediaPlayLimit) || 0 } };
      return editing === "new" ? api.post(`/banks/${bankId}/stimuli`, body) : api.patch(`/banks/${bankId}/stimuli/${(editing as Stimulus).id}`, body);
    },
    { success: "Stimulus disimpan", invalidate: [["stimuli", bankId]], onSuccess: () => setEditing(null) },
  );
  const remove = useAction((s: Stimulus) => api.del(`/banks/${bankId}/stimuli/${s.id}`), { success: "Stimulus dihapus", invalidate: [["stimuli", bankId]] });
  const open = (s: Stimulus | "new") => {
    setEditing(s);
    setForm(s === "new" ? { title: "", content: "", mediaPlayLimit: "0" } : { title: s.title, content: s.content, mediaPlayLimit: String(s.settings?.mediaPlayLimit ?? 0) });
  };

  return (
    <Card actions={can("author") ? <Button variant="primary" size="sm" onClick={() => open("new")}>+ Stimulus</Button> : null}>
      <p className="muted">Stimulus adalah bacaan / gambar / audio yang dipakai bersama oleh beberapa soal (mis. satu teks untuk 5 soal).</p>
      <ErrorBox error={list.error} />
      {list.isLoading ? <Loading /> : !list.data?.length ? <Empty>Belum ada stimulus.</Empty> : (
        <table className="table">
          <thead><tr><th>Judul</th><th>Isi</th><th /></tr></thead>
          <tbody>
            {list.data.map((s) => (
              <tr key={s.id}>
                <td>{s.title}</td>
                <td className="muted">{stripHtml(s.content, 160)}</td>
                <td className="row-actions">
                  {can("author") ? (
                    <>
                      <Button size="sm" onClick={() => open(s)}>Ubah</Button>
                      <ConfirmButton size="sm" variant="danger" confirm="Hapus stimulus ini? Soal terkait akan kehilangan stimulus." onConfirm={() => remove.mutateAsync(s)}>Hapus</ConfirmButton>
                    </>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Modal
        open={!!editing}
        wide
        title={editing === "new" ? "Stimulus baru" : "Ubah stimulus"}
        onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Batal</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button></>}
      >
        <div className="grid-2">
          <Field label="Judul"><Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Batas putar audio/video" hint="0 = tanpa batas"><Input type="number" min={0} value={form.mediaPlayLimit} onChange={(e) => setForm({ ...form, mediaPlayLimit: e.target.value })} /></Field>
        </div>
        <Field label={<span className="label-row">Konten (HTML) <InlineAssetUpload onUploaded={(a) => setForm((f) => ({ ...f, content: `${f.content}\n${assetSnippet(a)}` }))} /></span>}>
          <Textarea className="mono" rows={10} value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
        </Field>
        <div className="preview-box">
          <div className="muted small">Pratinjau</div>
          <Html html={form.content} resolveAsset={resolve} />
        </div>
      </Modal>
    </Card>
  );
}
