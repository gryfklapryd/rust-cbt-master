import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Card, ErrorBox, Loading, PageHeader, Stat } from "../components/ui";
import { api } from "../lib/api";

interface Dashboard {
  participants: number;
  sites: number;
  sitesOnline: number;
  questions: number;
  exams: number;
  upcomingSchedules: number;
  attempts: number;
  attemptsToday: number;
  pendingManualGrading: number;
  failedBatches: number;
  queues: Record<string, Record<string, number> | null>;
}

const QUEUE_LABEL: Record<string, string> = {
  packageBuild: "Pembangunan paket",
  resultsIngest: "Pemrosesan hasil",
  grading: "Penilaian",
};

export function DashboardPage() {
  const { data, error, isLoading } = useQuery({
    queryKey: ["dashboard"],
    queryFn: () => api.get<Dashboard>("/dashboard"),
    refetchInterval: 15_000,
  });
  return (
    <>
      <PageHeader title="Dasbor" subtitle="Ringkasan kondisi server pusat dan titik ujian" />
      <ErrorBox error={error} />
      {isLoading || !data ? (
        <Loading />
      ) : (
        <>
          <div className="stats">
            <Stat label="Titik ujian" value={data.sites} hint={`${data.sitesOnline} online (5 menit terakhir)`} />
            <Stat label="Peserta" value={data.participants.toLocaleString("id-ID")} />
            <Stat label="Soal" value={data.questions.toLocaleString("id-ID")} hint={`${data.exams} ujian`} />
            <Stat label="Jadwal mendatang" value={data.upcomingSchedules} />
            <Stat label="Hasil diterima" value={data.attempts.toLocaleString("id-ID")} hint={`${data.attemptsToday} hari ini`} />
            <Stat
              label="Menunggu koreksi"
              value={<Link to="/grading">{data.pendingManualGrading}</Link>}
              hint="jawaban uraian / unggahan"
            />
            <Stat label="Batch sinkron gagal" value={<Link to="/sync">{data.failedBatches}</Link>} />
          </div>
          <Card title="Antrean pemrosesan">
            <table className="table">
              <thead>
                <tr>
                  <th>Antrean</th>
                  <th>Menunggu</th>
                  <th>Berjalan</th>
                  <th>Tertunda</th>
                  <th>Gagal</th>
                  <th>Selesai (24 jam)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(data.queues).map(([name, c]) => (
                  <tr key={name}>
                    <td>{QUEUE_LABEL[name] ?? name}</td>
                    {c ? (
                      <>
                        <td>{c.waiting}</td>
                        <td>{c.active}</td>
                        <td>{c.delayed}</td>
                        <td className={c.failed ? "text-danger" : ""}>{c.failed}</td>
                        <td>{c.completed}</td>
                      </>
                    ) : (
                      <td colSpan={5} className="muted">
                        Redis tidak terjangkau
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </>
  );
}
