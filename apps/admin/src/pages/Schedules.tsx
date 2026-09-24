import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmButton,
  CopyText,
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
  Toolbar,
} from "../components/ui";
import { api, download, qs, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtBytes, fmtDate, fmtNum, fromLocalInput, toLocalInput } from "../lib/format";
import { useAction } from "../lib/hooks";
import type { Site } from "./Sites";

interface ScheduleRow {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  status: string;
  accessToken: string | null;
  exam: { id: string; code: string; title: string };
  site: { id: string; code: string; name: string };
  participantCount: number;
  attemptCount: number;
  latestPackage: { id: string; version: number; status: string; builtAt: string | null; error?: string | null } | null;
}
interface PackageRow {
  id: string;
  version: number;
  status: string;
  checksum: string | null;
  size: number | null;
  questionCount: number | null;
  participantCount: number | null;
  assetCount: number | null;
  error: string | null;
  builtAt: string | null;
  createdAt: string;
  downloads: { count: number; lastAt: string | null };
}
interface ScheduleDetail {
  id: string;
  name: string;
  startAt: string;
  endAt: string;
  lateEntryMinutes: number | null;
  accessToken: string | null;
  status: string;
  examId: string;
  siteId: string;
  exam: { id: string; code: string; title: string; durationMinutes: number; status: string };
  site: { id: string; code: string; name: string; lastSeenAt: string | null };
  packages: PackageRow[];
}
interface ScheduleParticipant {
  id: string;
  number: string;
  name: string;
  groupName: string | null;
  active: boolean;
  attempt: { id: string; status: string; gradingStatus: string; scaledScore: number | null } | null;
}
interface ExamOption {
  id: string;
  code: string;
  title: string;
  durationMinutes: number;
}

function defaultTimes() {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(8, 0, 0, 0);
  const end = new Date(start.getTime() + 2 * 3600_000);
  return { startAt: toLocalInput(start), endAt: toLocalInput(end) };
}

export function SchedulesPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState({ q: "", siteId: "", examId: "", status: "" });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ examId: "", siteIds: [] as string[], name: "", ...defaultTimes(), lateEntryMinutes: "", generateToken: true, assignFromSite: true });
  const list = useQuery({
    queryKey: ["schedules", page, filters],
    queryFn: () => api.get<Paged<ScheduleRow>>(`/schedules${qs({ page, pageSize: 50, ...filters })}`),
    refetchInterval: (q) => (q.state.data?.items.some((s) => s.latestPackage?.status === "building") ? 3000 : false),
  });
  const sites = useQuery({ queryKey: ["sites", "all"], queryFn: () => api.get<Paged<Site>>("/sites?pageSize=500") });
  const exams = useQuery({ queryKey: ["exams", "all"], queryFn: () => api.get<Paged<ExamOption>>("/exams?pageSize=500") });

  const create = useAction(
    () =>
      api.post<{ created: unknown[] }>("/schedules/bulk", {
        examId: form.examId,
        siteIds: form.siteIds,
        name: form.name,
        startAt: fromLocalInput(form.startAt),
        endAt: fromLocalInput(form.endAt),
        lateEntryMinutes: form.lateEntryMinutes ? Number(form.lateEntryMinutes) : null,
        generateToken: form.generateToken,
        assignParticipantsFromSite: form.assignFromSite,
      }),
    { success: (r) => `${r.created.length} jadwal dibuat`, invalidate: [["schedules"]], onSuccess: () => setCreating(false) },
  );
  const publish = useAction((id: string) => api.post(`/schedules/${id}/publish`), { success: "Paket sedang dibangun", invalidate: [["schedules"]] });

  return (
    <>
      <PageHeader
        title="Jadwal"
        subtitle="Sesi ujian per titik ujian. Terbitkan paket agar bisa diunduh aplikasi desktop."
        actions={can("admin") ? <Button variant="primary" onClick={() => { setForm({ ...form, siteIds: [], name: "", ...defaultTimes() }); setCreating(true); }}>+ Jadwal</Button> : null}
      />
      <Card>
        <Toolbar>
          <Input placeholder="Cari…" value={filters.q} onChange={(e) => { setFilters({ ...filters, q: e.target.value }); setPage(1); }} />
          <Select value={filters.siteId} onChange={(e) => { setFilters({ ...filters, siteId: e.target.value }); setPage(1); }}>
            <option value="">Semua lokasi</option>
            {sites.data?.items.map((s) => <option key={s.id} value={s.id}>{s.code}</option>)}
          </Select>
          <Select value={filters.examId} onChange={(e) => { setFilters({ ...filters, examId: e.target.value }); setPage(1); }}>
            <option value="">Semua ujian</option>
            {exams.data?.items.map((x) => <option key={x.id} value={x.id}>{x.code}</option>)}
          </Select>
          <Select value={filters.status} onChange={(e) => { setFilters({ ...filters, status: e.target.value }); setPage(1); }}>
            <option value="">Semua status</option>
            <option value="draft">Draf</option><option value="published">Terbit</option><option value="closed">Ditutup</option>
          </Select>
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada jadwal.</Empty> : (
          <>
            <table className="table">
              <thead><tr><th>Jadwal</th><th>Ujian</th><th>Lokasi</th><th>Waktu</th><th>Peserta</th><th>Paket</th><th>Status</th><th /></tr></thead>
              <tbody>
                {list.data.items.map((s) => (
                  <tr key={s.id}>
                    <td><Link to={`/schedules/${s.id}`}>{s.name}</Link>{s.accessToken ? <div className="muted small">token <span className="mono">{s.accessToken}</span></div> : null}</td>
                    <td><span className="mono">{s.exam.code}</span><div className="muted small">{s.exam.title}</div></td>
                    <td className="mono">{s.site.code}</td>
                    <td className="nowrap">{fmtDate(s.startAt)}<div className="muted small">s.d. {fmtDate(s.endAt)}</div></td>
                    <td>{s.participantCount}<div className="muted small">{s.attemptCount} hasil</div></td>
                    <td>{s.latestPackage ? <>v{s.latestPackage.version} <StatusBadge status={s.latestPackage.status} /></> : <span className="muted">belum</span>}</td>
                    <td><StatusBadge status={s.status} /></td>
                    <td className="row-actions">
                      {can("admin") && s.status !== "closed" ? <Button size="sm" onClick={() => publish.mutate(s.id)}>Terbitkan</Button> : null}
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
        open={creating}
        wide
        title="Jadwal baru"
        onClose={() => setCreating(false)}
        footer={<><Button onClick={() => setCreating(false)}>Batal</Button><Button variant="primary" disabled={!form.examId || !form.siteIds.length} loading={create.isPending} onClick={() => create.mutate(undefined)}>Buat {form.siteIds.length > 1 ? `${form.siteIds.length} jadwal` : "jadwal"}</Button></>}
      >
        <div className="grid-2">
          <Field label="Ujian">
            <Select value={form.examId} onChange={(e) => setForm({ ...form, examId: e.target.value })}>
              <option value="">Pilih ujian</option>
              {exams.data?.items.map((x) => <option key={x.id} value={x.id}>{x.code} - {x.title} ({x.durationMinutes} mnt)</option>)}
            </Select>
          </Field>
          <Field label="Nama sesi"><Input placeholder="mis. Sesi 1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Mulai"><Input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} /></Field>
          <Field label="Selesai"><Input type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} /></Field>
          <Field label="Batas terlambat (menit)" hint="Kosong = boleh masuk sampai jadwal selesai"><Input type="number" min={0} value={form.lateEntryMinutes} onChange={(e) => setForm({ ...form, lateEntryMinutes: e.target.value })} /></Field>
          <div>
            <Checkbox label="Buat token sesi otomatis" checked={form.generateToken} onChange={(e) => setForm({ ...form, generateToken: e.target.checked })} />
            <Checkbox label="Daftarkan peserta sesuai lokasi asal" checked={form.assignFromSite} onChange={(e) => setForm({ ...form, assignFromSite: e.target.checked })} />
          </div>
        </div>
        <Field label={`Titik ujian (${form.siteIds.length} dipilih), satu jadwal dibuat per lokasi`}>
          <div className="checklist">
            {sites.data?.items.map((s) => (
              <Checkbox
                key={s.id}
                label={<><span className="mono">{s.code}</span> {s.name}</>}
                checked={form.siteIds.includes(s.id)}
                onChange={(e) => setForm({ ...form, siteIds: e.target.checked ? [...form.siteIds, s.id] : form.siteIds.filter((x) => x !== s.id) })}
              />
            ))}
          </div>
        </Field>
      </Modal>
    </>
  );
}

export function ScheduleDetailPage() {
  const { scheduleId } = useParams<{ scheduleId: string }>();
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: "", startAt: "", endAt: "", lateEntryMinutes: "", accessToken: "" });
  const [addForm, setAddForm] = useState({ groupName: "", fromSite: false });
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const detail = useQuery({
    queryKey: ["schedule", scheduleId],
    queryFn: () => api.get<ScheduleDetail>(`/schedules/${scheduleId}`),
    refetchInterval: (q) => (q.state.data?.packages.some((p) => p.status === "building") ? 2000 : false),
  });
  const participants = useQuery({
    queryKey: ["schedule-participants", scheduleId, page],
    queryFn: () => api.get<Paged<ScheduleParticipant>>(`/schedules/${scheduleId}/participants${qs({ page, pageSize: 100 })}`),
  });
  const groups = useQuery({ queryKey: ["participant-groups"], queryFn: () => api.get<string[]>("/participants/groups") });
  const inv = [["schedule", scheduleId], ["schedule-participants", scheduleId], ["schedules"]];

  const publish = useAction(() => api.post(`/schedules/${scheduleId}/publish`), { success: "Paket sedang dibangun…", invalidate: inv });
  const close = useAction(() => api.post(`/schedules/${scheduleId}/close`), { success: "Jadwal ditutup", invalidate: inv });
  const regenToken = useAction(() => api.post(`/schedules/${scheduleId}/regenerate-token`), { success: "Token baru dibuat, terbitkan ulang paket", invalidate: inv });
  const save = useAction(
    () =>
      api.patch(`/schedules/${scheduleId}`, {
        name: form.name,
        startAt: fromLocalInput(form.startAt),
        endAt: fromLocalInput(form.endAt),
        lateEntryMinutes: form.lateEntryMinutes ? Number(form.lateEntryMinutes) : null,
        accessToken: form.accessToken || null,
      }),
    { success: "Jadwal disimpan, terbitkan ulang paket agar perubahan sampai ke lokasi", invalidate: inv, onSuccess: () => setEditing(false) },
  );
  const addParticipants = useAction(
    () => api.post<{ added: number }>(`/schedules/${scheduleId}/participants`, { groupName: addForm.groupName || undefined, fromSite: addForm.fromSite || undefined }),
    { success: (r) => `${r.added} peserta ditambahkan`, invalidate: inv, onSuccess: () => setAdding(false) },
  );
  const removeParticipants = useAction(() => api.del<{ removed: number }>(`/schedules/${scheduleId}/participants`, { participantIds: [...selected] }), {
    success: (r) => `${r.removed} peserta dikeluarkan`,
    invalidate: inv,
    onSuccess: () => setSelected(new Set()),
  });

  if (detail.isLoading) return <Loading />;
  if (!detail.data) return <ErrorBox error={detail.error} />;
  const s = detail.data;
  const latestReady = s.packages.find((p) => p.status === "ready");

  return (
    <>
      <PageHeader
        title={s.name}
        subtitle={<><span className="mono">{s.exam.code}</span> {s.exam.title} · <span className="mono">{s.site.code}</span> {s.site.name} · <StatusBadge status={s.status} /></>}
        actions={
          <>
            <Link className="btn btn-ghost" to="/schedules">← Semua jadwal</Link>
            <Link className="btn btn-secondary" to={`/results?scheduleId=${s.id}`}>Lihat hasil</Link>
            {can("admin") && s.status !== "closed" ? (
              <>
                <Button onClick={() => { setForm({ name: s.name, startAt: toLocalInput(s.startAt), endAt: toLocalInput(s.endAt), lateEntryMinutes: s.lateEntryMinutes?.toString() ?? "", accessToken: s.accessToken ?? "" }); setEditing(true); }}>Ubah</Button>
                <ConfirmButton confirm="Tutup jadwal? Paket tidak bisa diterbitkan lagi." onConfirm={() => close.mutateAsync(undefined)}>Tutup jadwal</ConfirmButton>
                <Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate(undefined)}>Terbitkan paket</Button>
              </>
            ) : null}
          </>
        }
      />
      <div className="grid-2">
        <Card title="Informasi">
          <dl className="kv">
            <dt>Waktu</dt><dd>{fmtDate(s.startAt)} s.d. {fmtDate(s.endAt)}</dd>
            <dt>Durasi ujian</dt><dd>{s.exam.durationMinutes} menit</dd>
            <dt>Batas terlambat</dt><dd>{s.lateEntryMinutes !== null ? `${s.lateEntryMinutes} menit` : "sampai jadwal selesai"}</dd>
            <dt>Token sesi</dt>
            <dd>
              {s.accessToken ? <CopyText text={s.accessToken} /> : <span className="muted">tidak memakai token</span>}{" "}
              {can("admin") ? <Button size="sm" variant="ghost" onClick={() => regenToken.mutate(undefined)}>buat baru</Button> : null}
            </dd>
            <dt>Lokasi terakhir online</dt><dd>{fmtDate(s.site.lastSeenAt)}</dd>
          </dl>
        </Card>
        <Card title="Paket ujian">
          {!s.packages.length ? <Empty>Belum pernah diterbitkan.</Empty> : (
            <table className="table table-compact">
              <thead><tr><th>Versi</th><th>Status</th><th>Isi</th><th>Diunduh</th><th /></tr></thead>
              <tbody>
                {s.packages.map((p) => (
                  <tr key={p.id}>
                    <td>v{p.version}<div className="muted small">{fmtDate(p.builtAt ?? p.createdAt)}</div></td>
                    <td><StatusBadge status={p.status} />{p.error ? <pre className="error-box small">{p.error}</pre> : null}</td>
                    <td className="small">{p.questionCount ?? "-"} soal · {p.participantCount ?? "-"} peserta · {p.assetCount ?? "-"} media<div className="muted">{fmtBytes(p.size)}</div></td>
                    <td className="small">{p.downloads.count}×<div className="muted">{fmtDate(p.downloads.lastAt)}</div></td>
                    <td>{p.status === "ready" || p.status === "superseded" ? <Button size="sm" variant="ghost" onClick={() => download(`/schedules/${s.id}/packages/${p.id}/download`, `paket-${s.site.code}-v${p.version}.json`)}>JSON</Button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {latestReady ? <p className="muted small">Checksum terbaru: <code>{latestReady.checksum?.slice(0, 16)}…</code></p> : null}
        </Card>
      </div>

      <Card
        title={`Peserta (${participants.data?.total ?? 0})`}
        actions={
          can("admin") ? (
            <>
              {selected.size ? <ConfirmButton size="sm" variant="danger" confirm={`Keluarkan ${selected.size} peserta dari jadwal?`} onConfirm={() => removeParticipants.mutateAsync(undefined)}>Keluarkan ({selected.size})</ConfirmButton> : null}
              <Button size="sm" variant="primary" onClick={() => { setAddForm({ groupName: "", fromSite: false }); setAdding(true); }}>+ Tambah peserta</Button>
            </>
          ) : null
        }
      >
        {participants.isLoading ? <Loading /> : !participants.data?.items.length ? <Empty>Belum ada peserta di jadwal ini.</Empty> : (
          <>
            <table className="table table-compact">
              <thead><tr><th /><th>Nomor</th><th>Nama</th><th>Kelompok</th><th>Status ujian</th><th>Nilai</th></tr></thead>
              <tbody>
                {participants.data.items.map((p) => (
                  <tr key={p.id}>
                    <td><input type="checkbox" checked={selected.has(p.id)} onChange={(e) => setSelected((cur) => { const n = new Set(cur); if (e.target.checked) n.add(p.id); else n.delete(p.id); return n; })} /></td>
                    <td className="mono">{p.number}</td>
                    <td>{p.name}{!p.active ? <> <Badge>nonaktif</Badge></> : null}</td>
                    <td>{p.groupName ?? "-"}</td>
                    <td>{p.attempt ? <Link to={`/results/${p.attempt.id}`}><StatusBadge status={p.attempt.status} /></Link> : <span className="muted">belum ada hasil</span>}</td>
                    <td>{p.attempt ? <>{fmtNum(p.attempt.scaledScore)} <StatusBadge status={p.attempt.gradingStatus} /></> : "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pagination page={page} pageSize={100} total={participants.data.total} onPage={setPage} />
          </>
        )}
      </Card>

      <Modal open={editing} title="Ubah jadwal" onClose={() => setEditing(false)} footer={<><Button onClick={() => setEditing(false)}>Batal</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button></>}>
        <Field label="Nama"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
        <div className="grid-2">
          <Field label="Mulai"><Input type="datetime-local" value={form.startAt} onChange={(e) => setForm({ ...form, startAt: e.target.value })} /></Field>
          <Field label="Selesai"><Input type="datetime-local" value={form.endAt} onChange={(e) => setForm({ ...form, endAt: e.target.value })} /></Field>
          <Field label="Batas terlambat (menit)"><Input type="number" min={0} value={form.lateEntryMinutes} onChange={(e) => setForm({ ...form, lateEntryMinutes: e.target.value })} /></Field>
          <Field label="Token sesi" hint="Kosong = tanpa token"><Input className="mono" value={form.accessToken} onChange={(e) => setForm({ ...form, accessToken: e.target.value.toUpperCase() })} /></Field>
        </div>
      </Modal>

      <Modal open={adding} title="Tambah peserta ke jadwal" onClose={() => setAdding(false)} footer={<><Button onClick={() => setAdding(false)}>Batal</Button><Button variant="primary" disabled={!addForm.groupName && !addForm.fromSite} loading={addParticipants.isPending} onClick={() => addParticipants.mutate(undefined)}>Tambahkan</Button></>}>
        <Field label="Berdasarkan kelompok">
          <Select value={addForm.groupName} onChange={(e) => setAddForm({ ...addForm, groupName: e.target.value })}>
            <option value="">-</option>
            {groups.data?.map((g) => <option key={g} value={g}>{g}</option>)}
          </Select>
        </Field>
        <Checkbox label={`Semua peserta dengan lokasi asal ${s.site.code}`} checked={addForm.fromSite} onChange={(e) => setAddForm({ ...addForm, fromSite: e.target.checked })} />
        <p className="muted small">Setelah menambah peserta, terbitkan ulang paket agar peserta baru bisa login di titik ujian.</p>
      </Modal>
    </>
  );
}
