import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card, ConfirmButton, CopyText, Empty, ErrorBox, Input, Loading, PageHeader, Pagination, Select, Toolbar, useToast } from "../components/ui";
import { api, qs, type Paged } from "../lib/api";
import { useAssetResolver } from "../lib/assets";
import { fmtBytes, fmtDate } from "../lib/format";
import { useAction } from "../lib/hooks";

export interface Asset {
  id: string;
  filename: string;
  mime: string;
  size: number;
  sha256: string;
  createdAt: string;
}

export async function uploadAsset(file: File): Promise<Asset & { uri: string }> {
  const form = new FormData();
  form.append("file", file, file.name);
  return api.post("/assets", form);
}

export function AssetPreview({ asset, resolve }: { asset: Asset; resolve: (id: string) => string | undefined }) {
  const url = resolve(asset.id);
  if (!url) return <div className="asset-thumb muted">…</div>;
  if (asset.mime.startsWith("image/")) return <img className="asset-thumb" src={url} alt={asset.filename} loading="lazy" />;
  if (asset.mime.startsWith("audio/")) return <audio className="asset-thumb" src={url} controls preload="none" />;
  if (asset.mime.startsWith("video/")) return <video className="asset-thumb" src={url} controls preload="none" />;
  return (
    <a className="asset-thumb" href={url} target="_blank" rel="noreferrer">
      📄 buka
    </a>
  );
}

/** Snippet HTML untuk disisipkan ke konten soal. */
export function assetSnippet(a: Asset) {
  const uri = `asset://${a.id}`;
  if (a.mime.startsWith("image/")) return `<img src="${uri}" alt="${a.filename}">`;
  if (a.mime.startsWith("audio/")) return `<audio controls src="${uri}"></audio>`;
  if (a.mime.startsWith("video/")) return `<video controls src="${uri}"></video>`;
  return `<a href="${uri}">${a.filename}</a>`;
}

export function AssetsPage() {
  const [page, setPage] = useState(1);
  const [q, setQ] = useState("");
  const [mime, setMime] = useState("");
  const [uploading, setUploading] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ["assets", page, q, mime],
    queryFn: () => api.get<Paged<Asset>>(`/assets${qs({ page, pageSize: 40, q, mime })}`),
  });
  const resolve = useAssetResolver(list.data?.items.map((a) => `asset://${a.id}`));
  const remove = useAction((a: Asset) => api.del(`/assets/${a.id}`), { success: "Media dihapus", invalidate: [["assets"]] });

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) await uploadAsset(f);
      toast.success(`${files.length} berkas diunggah`);
      void qc.invalidateQueries({ queryKey: ["assets"] });
    } catch (err) {
      toast.error(err);
    } finally {
      setUploading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Media"
        subtitle={<>Gambar, audio, video, PDF untuk soal. Rujuk di konten soal dengan <code>asset://&lt;id&gt;</code>.</>}
        actions={
          <label className={`btn btn-primary${uploading ? " is-loading" : ""}`}>
            {uploading ? "Mengunggah…" : "+ Unggah media"}
            <input type="file" multiple hidden accept="image/*,audio/*,video/*,application/pdf" onChange={(e) => { void onFiles(e.target.files); e.target.value = ""; }} />
          </label>
        }
      />
      <Card>
        <Toolbar>
          <Input placeholder="Cari nama berkas…" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
          <Select value={mime} onChange={(e) => { setMime(e.target.value); setPage(1); }}>
            <option value="">Semua jenis</option>
            <option value="image/">Gambar</option>
            <option value="audio/">Audio</option>
            <option value="video/">Video</option>
            <option value="application/pdf">PDF</option>
          </Select>
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada media.</Empty> : (
          <>
            <div className="asset-grid">
              {list.data.items.map((a) => (
                <div key={a.id} className="asset-card">
                  <AssetPreview asset={a} resolve={resolve} />
                  <div className="asset-meta">
                    <strong title={a.filename}>{a.filename}</strong>
                    <span className="muted small">{a.mime} · {fmtBytes(a.size)} · {fmtDate(a.createdAt)}</span>
                    <CopyText text={assetSnippet(a)} />
                  </div>
                  <ConfirmButton size="sm" variant="ghost" confirm={`Hapus ${a.filename}? Soal yang merujuk media ini akan gagal dipaketkan.`} onConfirm={() => remove.mutateAsync(a)}>
                    Hapus
                  </ConfirmButton>
                </div>
              ))}
            </div>
            <Pagination page={page} pageSize={40} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}

/** Tombol kecil untuk mengunggah media dari dalam editor lalu mengembalikan snippet-nya. */
export function InlineAssetUpload({ onUploaded }: { onUploaded: (a: Asset) => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <label className={`btn btn-secondary btn-sm${busy ? " is-loading" : ""}`}>
      {busy ? "Mengunggah…" : "Unggah media"}
      <input
        type="file"
        hidden
        accept="image/*,audio/*,video/*,application/pdf"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          setBusy(true);
          try {
            onUploaded(await uploadAsset(f));
          } catch (err) {
            toast.error(err);
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}
