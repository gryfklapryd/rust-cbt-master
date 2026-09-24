import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Checkbox, ConfirmButton, CopyText, Empty, ErrorBox, Field, Input, Loading, Modal, PageHeader, Pagination, Textarea, Toolbar } from "../components/ui";
import { api, qs, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { useAction } from "../lib/hooks";

export interface Site {
  id: string;
  code: string;
  name: string;
  address: string | null;
  capacity: number | null;
  active: boolean;
  lastSeenAt: string | null;
  lastSeenInfo: Record<string, unknown> | null;
  proctors: { id: string; username: string; name: string; active: boolean }[];
}

interface UserRow {
  id: string;
  username: string;
  name: string;
  role: string;
  active: boolean;
}

interface ProctorAction {
  id: string;
  username: string;
  action: string;
  attemptId: string | null;
  participantId: string | null;
  data: Record<string, unknown> | null;
  at: string;
}

const ACTION_LABELS: Record<string, string> = {
  login: "login",
  logout: "logout",
  device_approve: "setujui PC peserta",
  device_revoke: "cabut PC peserta",
  attempt_reset_device: "izinkan pindah komputer",
  attempt_extra_time: "tambah waktu",
  attempt_terminate: "hentikan ujian peserta",
  attempt_unlock: "buka kunci peserta",
  attempt_delete: "hapus attempt",
  package_download: "unduh paket",
  results_upload: "kirim hasil",
  results_export: "ekspor hasil",
  settings_change: "ubah pengaturan",
};

const empty = { code: "", name: "", address: "", capacity: "", active: true };

export function SitesPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [editing, setEditing] = useState<Site | "new" | null>(null);
  const [form, setForm] = useState(empty);
  const [secret, setSecret] = useState<{ code: string; secret: string } | null>(null);
  const [proctorSite, setProctorSite] = useState<Site | null>(null);
  const [logSite, setLogSite] = useState<Site | null>(null);

  const list = useQuery({
    queryKey: ["sites", page, q],
    queryFn: () => api.get<Paged<Site>>(`/sites${qs({ page, pageSize: 50, q })}`),
  });

  const save = useAction(
    async () => {
      const body = { code: form.code, name: form.name, address: form.address || null, capacity: form.capacity ? Number(form.capacity) : null, active: form.active };
      return editing === "new" ? api.post<Site & { secret: string }>("/sites", body) : api.patch<Site>(`/sites/${(editing as Site).id}`, body);
    },
    {
      success: "Titik ujian disimpan",
      invalidate: [["sites"]],
      onSuccess: (r) => {
        setEditing(null);
        if ("secret" in r && typeof r.secret === "string") setSecret({ code: r.code, secret: r.secret });
      },
    },
  );
  const rotate = useAction((s: Site) => api.post<Site & { secret: string }>(`/sites/${s.id}/rotate-secret`), {
    onSuccess: (r) => setSecret({ code: r.code, secret: r.secret }),
  });
  const remove = useAction((s: Site) => api.del(`/sites/${s.id}`), { success: "Titik ujian dihapus", invalidate: [["sites"]] });

  const open = (s: Site | "new") => {
    setEditing(s);
    setForm(
      s === "new"
        ? empty
        : { code: s.code, name: s.name, address: s.address ?? "", capacity: s.capacity?.toString() ?? "", active: s.active },
    );
  };
  const online = (s: Site) => s.lastSeenAt && Date.now() - new Date(s.lastSeenAt).getTime() < 5 * 60_000;

  return (
    <>
      <PageHeader
        title="Titik Ujian"
        subtitle="Setiap lokasi punya satu server lokal yang login ke server pusat memakai kode + secret. Proktor yang ditugaskan bisa login di server lokal lokasinya."
        actions={can("admin") ? <Button variant="primary" onClick={() => open("new")}>+ Tambah lokasi</Button> : null}
      />
      <Card>
        <Toolbar>
          <Input placeholder="Cari kode / nama…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada titik ujian.</Empty> : (
          <>
            <table className="table">
              <thead>
                <tr>
                  <th>Kode</th>
                  <th>Nama</th>
                  <th>Kapasitas</th>
                  <th>Proktor</th>
                  <th>Terakhir terhubung</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((s) => (
                  <tr key={s.id}>
                    <td className="mono">{s.code}</td>
                    <td>
                      {s.name}
                      {s.address ? <div className="muted small">{s.address}</div> : null}
                    </td>
                    <td>{s.capacity ?? "-"}</td>
                    <td className="small">
                      {s.proctors.length ? s.proctors.map((p) => <div key={p.id}>{p.name} <span className="muted mono">{p.username}</span></div>) : <span className="muted">belum ada</span>}
                    </td>
                    <td>
                      {online(s) ? <Badge tone="success">online</Badge> : null} {fmtDate(s.lastSeenAt)}
                      {s.lastSeenInfo?.appVersion ? <div className="muted small">app v{String(s.lastSeenInfo.appVersion)}</div> : null}
                    </td>
                    <td>{s.active ? <Badge tone="success">aktif</Badge> : <Badge>nonaktif</Badge>}</td>
                    <td className="row-actions">
                      <Button size="sm" onClick={() => setLogSite(s)}>Log proktor</Button>
                      {can("admin") ? (
                        <>
                          <Button size="sm" onClick={() => setProctorSite(s)}>Proktor</Button>
                          <Button size="sm" onClick={() => open(s)}>Ubah</Button>
                          <ConfirmButton size="sm" confirm={`Buat secret baru untuk ${s.code}? Aplikasi desktop harus dikonfigurasi ulang.`} onConfirm={() => rotate.mutateAsync(s)}>
                            Ganti secret
                          </ConfirmButton>
                          <ConfirmButton size="sm" variant="danger" confirm={`Hapus lokasi ${s.code}?`} onConfirm={() => remove.mutateAsync(s)}>
                            Hapus
                          </ConfirmButton>
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

      <Modal
        open={!!editing}
        title={editing === "new" ? "Tambah titik ujian" : "Ubah titik ujian"}
        onClose={() => setEditing(null)}
        footer={
          <>
            <Button onClick={() => setEditing(null)}>Batal</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button>
          </>
        }
      >
        <div className="grid-2">
          <Field label="Kode" hint="Huruf/angka, mis. SMAN1-LAB1">
            <Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} />
          </Field>
          <Field label="Kapasitas komputer">
            <Input type="number" min={0} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} />
          </Field>
        </div>
        <Field label="Nama">
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="Alamat">
          <Textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </Field>
        <Checkbox label="Aktif" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
      </Modal>

      <Modal open={!!secret} title="Kredensial titik ujian" onClose={() => setSecret(null)} footer={<Button variant="primary" onClick={() => setSecret(null)}>Sudah saya catat</Button>}>
        <p>Masukkan kredensial ini ke <strong>server lokal</strong> (aplikasi desktop mode server lokal) di lokasi tersebut. <strong>Secret hanya ditampilkan sekali.</strong></p>
        <dl className="kv">
          <dt>Kode lokasi</dt>
          <dd><CopyText text={secret?.code ?? ""} /></dd>
          <dt>Secret</dt>
          <dd><CopyText text={secret?.secret ?? ""} /></dd>
        </dl>
      </Modal>

      {proctorSite ? <ProctorsModal site={proctorSite} onClose={() => setProctorSite(null)} /> : null}
      {logSite ? <ProctorLogModal site={logSite} onClose={() => setLogSite(null)} /> : null}
    </>
  );
}

function ProctorsModal({ site, onClose }: { site: Site; onClose: () => void }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set(site.proctors.map((p) => p.id)));
  const users = useQuery({
    queryKey: ["users", "proctor-candidates"],
    queryFn: async () => {
      const [proctors, admins] = await Promise.all([
        api.get<Paged<UserRow>>(`/users${qs({ role: "proctor", pageSize: 500 })}`),
        api.get<Paged<UserRow>>(`/users${qs({ role: "admin", pageSize: 500 })}`),
      ]);
      return [...proctors.items, ...admins.items];
    },
  });
  const save = useAction(() => api.put(`/sites/${site.id}/proctors`, { userIds: [...selected] }), {
    success: "Proktor disimpan. Server lokal menerima perubahan saat sinkronisasi berikutnya.",
    invalidate: [["sites"]],
    onSuccess: onClose,
  });
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  return (
    <Modal
      open
      title={`Proktor ${site.code}`}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Batal</Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button>
        </>
      }
    >
      <p className="muted small">
        Proktor login di server lokal lokasi ini memakai username dan password akun pusatnya, juga saat lokasi tidak terhubung
        ke internet. Buat akun proktor baru di menu Pengguna dengan peran <strong>proctor</strong>.
      </p>
      <ErrorBox error={users.error} />
      {users.isLoading ? <Loading /> : !users.data?.length ? <Empty>Belum ada pengguna berperan proktor.</Empty> : (
        <div className="stack">
          {users.data.map((u) => (
            <Checkbox
              key={u.id}
              checked={selected.has(u.id)}
              onChange={() => toggle(u.id)}
              label={
                <>
                  {u.name} <span className="muted mono">{u.username}</span> <Badge>{u.role}</Badge>
                  {!u.active ? <> <Badge tone="warning">nonaktif</Badge></> : null}
                </>
              }
            />
          ))}
        </div>
      )}
    </Modal>
  );
}

function ProctorLogModal({ site, onClose }: { site: Site; onClose: () => void }) {
  const [page, setPage] = useState(1);
  const log = useQuery({
    queryKey: ["proctor-actions", site.id, page],
    queryFn: () => api.get<Paged<ProctorAction>>(`/sites/${site.id}/proctor-actions${qs({ page, pageSize: 50 })}`),
  });
  return (
    <Modal open title={`Log proktor ${site.code}`} onClose={onClose} footer={<Button onClick={onClose}>Tutup</Button>}>
      <ErrorBox error={log.error} />
      {log.isLoading ? <Loading /> : !log.data?.items.length ? <Empty>Belum ada aksi proktor yang terkirim dari lokasi ini.</Empty> : (
        <>
          <table className="table">
            <thead><tr><th>Waktu</th><th>Proktor</th><th>Aksi</th><th>Rincian</th></tr></thead>
            <tbody>
              {log.data.items.map((a) => (
                <tr key={a.id}>
                  <td className="small">{fmtDate(a.at)}</td>
                  <td className="mono small">{a.username}</td>
                  <td>{ACTION_LABELS[a.action] ?? a.action}</td>
                  <td className="small mono">
                    {a.attemptId ? <div>attempt {a.attemptId.slice(0, 8)}</div> : null}
                    {a.data && Object.keys(a.data).length ? JSON.stringify(a.data) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <Pagination page={page} pageSize={50} total={log.data.total} onPage={setPage} />
        </>
      )}
    </Modal>
  );
}
