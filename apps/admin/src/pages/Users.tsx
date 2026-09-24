import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Button, Card, Checkbox, ConfirmButton, ErrorBox, Field, Input, Loading, Modal, PageHeader, Select } from "../components/ui";
import { api, type Paged } from "../lib/api";
import { useAuth, type Role } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { useAction } from "../lib/hooks";

interface User {
  id: string;
  username: string;
  name: string;
  email: string | null;
  role: Role;
  active: boolean;
  lastLoginAt: string | null;
}

const ROLES: { id: Role; label: string }[] = [
  { id: "admin", label: "Administrator — semua akses" },
  { id: "author", label: "Penulis soal — bank soal, media, ujian" },
  { id: "grader", label: "Korektor — koreksi jawaban uraian" },
  { id: "proctor", label: "Pengawas — lihat jadwal & hasil" },
];

export function UsersPage() {
  const { user: me } = useAuth();
  const [editing, setEditing] = useState<User | "new" | null>(null);
  const [form, setForm] = useState({ username: "", name: "", email: "", role: "author" as Role, password: "", active: true });
  const list = useQuery({ queryKey: ["users"], queryFn: () => api.get<Paged<User>>("/users?pageSize=500") });

  const save = useAction(
    () => {
      const body = { ...form, email: form.email || null, password: form.password || undefined };
      return editing === "new" ? api.post("/users", body) : api.patch(`/users/${(editing as User).id}`, body);
    },
    { success: "Pengguna disimpan", invalidate: [["users"]], onSuccess: () => setEditing(null) },
  );
  const remove = useAction((u: User) => api.del(`/users/${u.id}`), { success: "Pengguna dihapus", invalidate: [["users"]] });

  const open = (u: User | "new") => {
    setEditing(u);
    setForm(u === "new" ? { username: "", name: "", email: "", role: "author", password: "", active: true } : { username: u.username, name: u.name, email: u.email ?? "", role: u.role, password: "", active: u.active });
  };

  return (
    <>
      <PageHeader title="Pengguna" subtitle="Akun panel admin" actions={<Button variant="primary" onClick={() => open("new")}>+ Tambah pengguna</Button>} />
      <Card>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : (
          <table className="table">
            <thead>
              <tr><th>Username</th><th>Nama</th><th>Peran</th><th>Login terakhir</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {list.data?.items.map((u) => (
                <tr key={u.id}>
                  <td className="mono">{u.username}</td>
                  <td>{u.name}{u.email ? <div className="muted small">{u.email}</div> : null}</td>
                  <td>{ROLES.find((r) => r.id === u.role)?.label.split(" — ")[0]}</td>
                  <td>{fmtDate(u.lastLoginAt)}</td>
                  <td>{u.active ? <Badge tone="success">aktif</Badge> : <Badge>nonaktif</Badge>}</td>
                  <td className="row-actions">
                    <Button size="sm" onClick={() => open(u)}>Ubah</Button>
                    {u.id !== me?.id ? (
                      <ConfirmButton size="sm" variant="danger" confirm={`Hapus ${u.username}?`} onConfirm={() => remove.mutateAsync(u)}>Hapus</ConfirmButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Modal
        open={!!editing}
        title={editing === "new" ? "Tambah pengguna" : "Ubah pengguna"}
        onClose={() => setEditing(null)}
        footer={<><Button onClick={() => setEditing(null)}>Batal</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>Simpan</Button></>}
      >
        <div className="grid-2">
          <Field label="Username"><Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} /></Field>
          <Field label="Nama"><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={editing === "new" ? "Password" : "Password baru"} hint={editing === "new" ? "Minimal 8 karakter" : "Kosongkan bila tidak diubah"}>
            <Input type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
          </Field>
        </div>
        <Field label="Peran">
          <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as Role })}>
            {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
          </Select>
        </Field>
        <Checkbox label="Aktif" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
      </Modal>
    </>
  );
}
