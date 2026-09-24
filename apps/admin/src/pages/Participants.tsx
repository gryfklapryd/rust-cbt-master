import { useQuery } from "@tanstack/react-query";
import Papa from "papaparse";
import { useState } from "react";
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
  Toolbar,
} from "../components/ui";
import { api, qs, saveBlob, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useAction } from "../lib/hooks";
import type { Site } from "./Sites";

interface Participant {
  id: string;
  number: string;
  name: string;
  groupName: string | null;
  gender: "L" | "P" | null;
  birthDate: string | null;
  siteId: string | null;
  active: boolean;
}
interface Credential {
  number: string;
  name: string;
  password: string;
}
interface ImportRow {
  number: string;
  name: string;
  groupName?: string | null;
  gender?: "L" | "P" | null;
  birthDate?: string | null;
  siteCode?: string | null;
  password?: string | null;
}

/** Nama kolom CSV yang dikenali (huruf kecil, tanpa spasi). */
const COLUMN_ALIASES: Record<keyof ImportRow, string[]> = {
  number: ["number", "nomor", "nomor_peserta", "no_peserta", "nopes", "username"],
  name: ["name", "nama", "nama_peserta"],
  groupName: ["groupname", "group", "kelompok", "kelas", "rombel"],
  gender: ["gender", "jk", "jenis_kelamin", "l/p"],
  birthDate: ["birthdate", "tgl_lahir", "tanggal_lahir"],
  siteCode: ["sitecode", "kode_lokasi", "lokasi", "site"],
  password: ["password", "kata_sandi", "sandi"],
};

function mapRow(raw: Record<string, string>): ImportRow {
  const norm = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.trim().toLowerCase().replace(/\s+/g, "_"), (v ?? "").trim()]));
  const pick = (key: keyof ImportRow) => COLUMN_ALIASES[key].map((a) => norm[a]).find((v) => v !== undefined && v !== "") ?? undefined;
  const gender = pick("gender")?.toUpperCase();
  let birthDate = pick("birthDate");
  // Terima format DD/MM/YYYY atau DD-MM-YYYY.
  const m = birthDate?.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) birthDate = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return {
    number: pick("number") ?? "",
    name: pick("name") ?? "",
    groupName: pick("groupName"),
    gender: gender === "L" || gender === "P" ? gender : undefined,
    birthDate,
    siteCode: pick("siteCode"),
    password: pick("password"),
  };
}

export function downloadCredentials(creds: Credential[], filename = "kartu-peserta.csv") {
  const csv = Papa.unparse(creds.map((c) => ({ nomor_peserta: c.number, nama: c.name, password: c.password })));
  saveBlob(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }), filename);
}

export function ParticipantsPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [group, setGroup] = useState("");
  const [editing, setEditing] = useState<Participant | "new" | null>(null);
  const [form, setForm] = useState({ number: "", name: "", groupName: "", gender: "", birthDate: "", siteId: "", password: "", active: true });
  const [importRows, setImportRows] = useState<ImportRow[] | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<Credential[] | null>(null);

  const list = useQuery({
    queryKey: ["participants", page, q, group],
    queryFn: () => api.get<Paged<Participant>>(`/participants${qs({ page, pageSize: 50, q, groupName: group })}`),
  });
  const groups = useQuery({ queryKey: ["participant-groups"], queryFn: () => api.get<string[]>("/participants/groups") });
  const sites = useQuery({ queryKey: ["sites", "all"], queryFn: () => api.get<Paged<Site>>("/sites?pageSize=500") });
  const siteName = (id: string | null) => sites.data?.items.find((s) => s.id === id)?.code ?? "—";

  const save = useAction(
    () => {
      const body = {
        number: form.number,
        name: form.name,
        groupName: form.groupName || null,
        gender: form.gender || null,
        birthDate: form.birthDate || null,
        siteId: form.siteId || null,
        active: form.active,
        ...(form.password ? { password: form.password } : {}),
      };
      return editing === "new"
        ? api.post<Participant & { password: string }>("/participants", body)
        : api.patch<Participant>(`/participants/${(editing as Participant).id}`, body);
    },
    {
      success: "Peserta disimpan",
      invalidate: [["participants"], ["participant-groups"]],
      onSuccess: (r) => {
        setEditing(null);
        if ("password" in r && typeof r.password === "string") setCredentials([{ number: r.number, name: r.name, password: r.password }]);
      },
    },
  );
  const remove = useAction((p: Participant) => api.del(`/participants/${p.id}`), { success: "Peserta dihapus", invalidate: [["participants"]] });
  const doImport = useAction(
    () => api.post<{ created: number; updated: number; skipped: number; credentials: Credential[] }>("/participants/import", { rows: importRows }),
    {
      success: (r) => `Impor selesai: ${r.created} baru, ${r.updated} diperbarui`,
      invalidate: [["participants"], ["participant-groups"]],
      onSuccess: (r) => {
        setImportRows(null);
        if (r.credentials.length) setCredentials(r.credentials);
      },
    },
  );
  const resetGroup = useAction(() => api.post<{ credentials: Credential[] }>("/participants/reset-passwords", { groupName: group }), {
    success: (r) => `${r.credentials.length} password dibuat ulang`,
    onSuccess: (r) => setCredentials(r.credentials),
  });

  const open = (p: Participant | "new") => {
    setEditing(p);
    setForm(
      p === "new"
        ? { number: "", name: "", groupName: group, gender: "", birthDate: "", siteId: "", password: "", active: true }
        : { number: p.number, name: p.name, groupName: p.groupName ?? "", gender: p.gender ?? "", birthDate: p.birthDate ?? "", siteId: p.siteId ?? "", password: "", active: p.active },
    );
  };

  const onFile = (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    Papa.parse<Record<string, string>>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (res) => {
        const rows = res.data.map(mapRow);
        const bad = rows.findIndex((r) => !r.number || !r.name);
        if (!rows.length) setImportError("File kosong");
        else if (bad >= 0) setImportError(`Baris ${bad + 2}: kolom nomor & nama wajib diisi`);
        setImportRows(rows);
      },
      error: (err) => setImportError(err.message),
    });
  };

  return (
    <>
      <PageHeader
        title="Peserta"
        subtitle="Data peserta ujian. Password peserta disimpan dalam bentuk hash; salin/cetak saat dibuat."
        actions={
          can("admin") ? (
            <>
              <label className="btn btn-secondary">
                Impor CSV
                <input type="file" accept=".csv,text/csv" hidden onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
              </label>
              <Button variant="primary" onClick={() => open("new")}>+ Tambah peserta</Button>
            </>
          ) : null
        }
      />
      <Card>
        <Toolbar>
          <Input placeholder="Cari nomor / nama…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select value={group} onChange={(e) => { setGroup(e.target.value); setPage(1); }}>
            <option value="">Semua kelompok</option>
            {groups.data?.map((g) => <option key={g} value={g}>{g}</option>)}
          </Select>
          {group && can("admin") ? (
            <ConfirmButton size="sm" confirm={`Buat ulang password semua peserta kelompok ${group}? Password lama tidak berlaku lagi (terbitkan ulang paket).`} onConfirm={() => resetGroup.mutateAsync(undefined)}>
              Buat ulang password kelompok
            </ConfirmButton>
          ) : null}
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada peserta.</Empty> : (
          <>
            <table className="table">
              <thead>
                <tr><th>Nomor</th><th>Nama</th><th>Kelompok</th><th>L/P</th><th>Lokasi asal</th><th>Status</th><th /></tr>
              </thead>
              <tbody>
                {list.data.items.map((p) => (
                  <tr key={p.id}>
                    <td className="mono">{p.number}</td>
                    <td>{p.name}</td>
                    <td>{p.groupName ?? "—"}</td>
                    <td>{p.gender ?? "—"}</td>
                    <td className="mono">{siteName(p.siteId)}</td>
                    <td>{p.active ? <Badge tone="success">aktif</Badge> : <Badge>nonaktif</Badge>}</td>
                    <td className="row-actions">
                      {can("admin") ? (
                        <>
                          <Button size="sm" onClick={() => open(p)}>Ubah</Button>
                          <ConfirmButton size="sm" variant="danger" confirm={`Hapus ${p.number}?`} onConfirm={() => remove.mutateAsync(p)}>Hapus</ConfirmButton>
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
        title={editing === "new" ? "Tambah peserta" : "Ubah peserta"}
        onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Batal</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button></>}
      >
        <div className="grid-2">
          <Field label="Nomor peserta"><Input value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value })} /></Field>
          <Field label="Nama"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Kelompok / kelas"><Input list="groups" value={form.groupName} onChange={(e) => setForm({ ...form, groupName: e.target.value })} /></Field>
          <Field label="Jenis kelamin">
            <Select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
              <option value="">—</option><option value="L">Laki-laki</option><option value="P">Perempuan</option>
            </Select>
          </Field>
          <Field label="Tanggal lahir"><Input type="date" value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} /></Field>
          <Field label="Lokasi asal">
            <Select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
              <option value="">—</option>
              {sites.data?.items.map((s) => <option key={s.id} value={s.id}>{s.code} — {s.name}</option>)}
            </Select>
          </Field>
          <Field label="Password" hint={editing === "new" ? "Kosongkan untuk dibuat otomatis" : "Kosongkan bila tidak diubah"}>
            <Input value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        <datalist id="groups">{groups.data?.map((g) => <option key={g} value={g} />)}</datalist>
        <Checkbox label="Aktif" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
      </Modal>

      <Modal
        open={!!importRows}
        wide
        title={`Impor ${importRows?.length ?? 0} peserta`}
        onClose={() => setImportRows(null)}
        footer={<><Button onClick={() => setImportRows(null)}>Batal</Button><Button variant="primary" disabled={!!importError} loading={doImport.isPending} onClick={() => doImport.mutate(undefined)}>Impor</Button></>}
      >
        <p className="muted">
          Kolom yang dikenali: <code>nomor</code>, <code>nama</code>, <code>kelompok</code>, <code>jk</code> (L/P), <code>tgl_lahir</code>,{" "}
          <code>kode_lokasi</code>, <code>password</code>. Nomor yang sudah ada akan diperbarui. Peserta baru tanpa password dibuatkan password acak.
        </p>
        {importError ? <pre className="error-box">{importError}</pre> : null}
        <div className="scroll-box">
          <table className="table table-compact">
            <thead><tr><th>Nomor</th><th>Nama</th><th>Kelompok</th><th>L/P</th><th>Tgl lahir</th><th>Lokasi</th><th>Password</th></tr></thead>
            <tbody>
              {importRows?.slice(0, 200).map((r, i) => (
                <tr key={i}><td>{r.number}</td><td>{r.name}</td><td>{r.groupName}</td><td>{r.gender}</td><td>{r.birthDate}</td><td>{r.siteCode}</td><td>{r.password ? "••••" : ""}</td></tr>
              ))}
            </tbody>
          </table>
          {(importRows?.length ?? 0) > 200 ? <p className="muted">… dan {importRows!.length - 200} baris lagi</p> : null}
        </div>
      </Modal>

      <Modal
        open={!!credentials}
        wide
        title="Password peserta"
        onClose={() => setCredentials(null)}
        footer={<><Button onClick={() => downloadCredentials(credentials ?? [])}>Unduh CSV</Button><Button variant="primary" onClick={() => setCredentials(null)}>Tutup</Button></>}
      >
        <p><strong>Password hanya ditampilkan sekali.</strong> Unduh CSV untuk mencetak kartu peserta. Terbitkan ulang paket jadwal terkait agar password baru berlaku di titik ujian.</p>
        <div className="scroll-box">
          <table className="table table-compact">
            <thead><tr><th>Nomor</th><th>Nama</th><th>Password</th></tr></thead>
            <tbody>{credentials?.map((c) => <tr key={c.number}><td className="mono">{c.number}</td><td>{c.name}</td><td className="mono">{c.password}</td></tr>)}</tbody>
          </table>
        </div>
      </Modal>
    </>
  );
}
