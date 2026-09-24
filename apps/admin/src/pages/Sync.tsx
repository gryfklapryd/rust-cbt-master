import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Card, ConfirmButton, Empty, ErrorBox, Loading, PageHeader, Pagination, Select, StatusBadge, Toolbar } from "../components/ui";
import { api, qs, type Paged } from "../lib/api";
import { useAuth } from "../lib/auth";
import { fmtDate } from "../lib/format";
import { useAction } from "../lib/hooks";

interface Batch {
  id: string;
  status: string;
  attemptCount: number;
  outcomes: { attemptId: string; accepted: boolean; reason: string | null }[] | null;
  error: string | null;
  receivedAt: string;
  processedAt: string | null;
  deviceId: string | null;
  site: { id: string; code: string; name: string };
}

export function SyncPage() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const list = useQuery({
    queryKey: ["batches", page, status],
    queryFn: () => api.get<Paged<Batch>>(`/results/batches${qs({ page, pageSize: 50, status })}`),
    refetchInterval: 10_000,
  });
  const reprocess = useAction((id: string) => api.post(`/results/batches/${id}/reprocess`), { success: "Batch diproses ulang", invalidate: [["batches"]] });
  return (
    <>
      <PageHeader title="Sinkronisasi" subtitle="Batch hasil ujian yang dikirim aplikasi desktop dari titik ujian" />
      <Card>
        <Toolbar>
          <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
            <option value="">Semua status</option>
            <option value="received">Diterima</option><option value="processing">Diproses</option><option value="processed">Selesai</option><option value="failed">Gagal</option>
          </Select>
        </Toolbar>
        <ErrorBox error={list.error} />
        {list.isLoading ? <Loading /> : !list.data?.items.length ? <Empty>Belum ada data sinkronisasi.</Empty> : (
          <>
            <table className="table">
              <thead><tr><th>Diterima</th><th>Lokasi</th><th>Perangkat</th><th>Attempt</th><th>Status</th><th>Hasil</th><th /></tr></thead>
              <tbody>
                {list.data.items.map((b) => {
                  const rejected = b.outcomes?.filter((o) => !o.accepted) ?? [];
                  return (
                    <tr key={b.id}>
                      <td className="nowrap">{fmtDate(b.receivedAt)}<div className="muted small mono">{b.id.slice(0, 8)}</div></td>
                      <td className="mono">{b.site.code}</td>
                      <td>{b.deviceId ?? "—"}</td>
                      <td>{b.attemptCount}</td>
                      <td><StatusBadge status={b.status} />{b.error ? <div className="text-danger small">{b.error}</div> : null}</td>
                      <td className="small">
                        {b.outcomes ? `${b.outcomes.length - rejected.length} diterima` : "—"}
                        {rejected.map((r) => <div key={r.attemptId} className="text-danger">✕ {r.attemptId.slice(0, 8)}: {r.reason}</div>)}
                      </td>
                      <td>{can("admin") ? <ConfirmButton size="sm" confirm="Proses ulang batch ini?" onConfirm={() => reprocess.mutateAsync(b.id)}>Proses ulang</ConfirmButton> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Pagination page={page} pageSize={50} total={list.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
