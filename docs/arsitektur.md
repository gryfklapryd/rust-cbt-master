# Arsitektur

## Gambaran besar

```
                         ┌──────────────────────── Server pusat (Docker Compose) ─────────────────────────┐
                         │                                                                                  │
 Panel admin (browser) ──┼─► nginx (admin SPA + reverse proxy /api) ──► API Fastify ──► PostgreSQL         │
                         │                                               │   │      ──► MinIO (media,       │
 Aplikasi desktop  ──────┼─► /api/sync/* ────────────────────────────────┘   │           paket, hasil)      │
 (Tauri, titik ujian)    │                                                   ▼                              │
                         │                                         Redis ◄── BullMQ ──► Worker              │
                         │                                                         (bangun paket,          │
                         │                                                          proses hasil, nilai)    │
                         └──────────────────────────────────────────────────────────────────────────────────┘
```

| Komponen | Teknologi | Peran |
|---|---|---|
| `apps/server` (API) | Node.js 22, Fastify 5, Zod 4, Drizzle ORM | REST API admin & sinkronisasi, validasi, auth JWT |
| `apps/server` (worker) | BullMQ + Redis | pekerjaan berat di luar request: bangun paket, ingest hasil, penilaian |
| PostgreSQL | 17 | data master, soal, jadwal, attempt, jawaban, audit |
| MinIO | S3-compatible | media soal, JSON paket, payload hasil mentah (arsip), lampiran jawaban |
| `apps/admin` | React 19, Vite, TanStack Query | panel admin |
| `packages/shared` | TypeScript + Zod | **kontrak tunggal**: skema 15 jenis soal, mesin penilaian, format paket & hasil |
| `packages/question-ui` | React | tampilan & interaksi semua jenis soal, dipakai admin (pratinjau) dan frontend Tauri |

## Prinsip desain

1. **Kunci jawaban tidak pernah keluar dari server pusat.** Paket ujian hanya berisi `content`.
   Penilaian dilakukan di server setelah hasil dikirim.
2. **Ujian berjalan offline.** Titik ujian cukup online saat mengunduh paket dan saat mengirim hasil.
   Login peserta & token sesi diverifikasi lokal dengan hash argon2id di paket.
3. **Paket adalah snapshot.** Saat jadwal diterbitkan, worker membekukan soal (konten + kunci + skor)
   menjadi satu versi paket. Mengubah soal di bank setelahnya tidak mengubah ujian yang sudah
   berjalan. Kunci versi paket disimpan di `exam_packages.answer_keys` dan dipakai penilaian.
   Koreksi kunci pasca-ujian dilakukan secara eksplisit (Hasil → *Koreksi kunci & nilai ulang*).
4. **Sinkronisasi idempoten.** `batchId`, `attemptId`, `attachmentId` dibuat client (UUID) sehingga
   pengiriman ulang aman. `sequence` per attempt menentukan data terbaru.
5. **Terima cepat, proses di antrean.** `POST /api/sync/results` hanya memvalidasi, menyimpan payload
   mentah ke MinIO, mencatat batch, dan membalas `202`. Worker `results-ingest` memecah menjadi
   attempt/jawaban/event, lalu `grading` menilai. Payload mentah tetap diarsip untuk audit dan
   pemrosesan ulang.
6. **Satu sumber kebenaran untuk skema.** Server, admin, dan (nanti) desktop memakai paket
   `@cbt/shared` yang sama sehingga bentuk data tidak bisa menyimpang.

## Model data (ringkas)

```
users                      pengguna panel admin (admin / author / grader / proctor)
sites                      titik ujian (kode + hash secret)
participants               peserta (nomor unik, hash password, kelompok, lokasi asal)
assets                     media di MinIO (sha256)
question_banks ─┬─ stimuli           bacaan/media bersama
                └─ questions         type, content, answer_key, scoring, version, status
exams ── exam_sections ── exam_section_questions (urutan, override poin, pickCount per bagian)
schedules (exam × site × waktu, token sesi) ── schedule_participants
exam_packages              versi paket per jadwal: objek JSON di MinIO, checksum, snapshot kunci
package_downloads          log unduhan paket
sync_batches               batch hasil dari lokasi (payload mentah di MinIO, outcome per attempt)
attempts                   satu per (jadwal, peserta): status, skor total, nilai 0-100
attempt_answers            jawaban per soal: response, hasil nilai otomatis, nilai manual, rubrik
attempt_events             log kejadian (mulai, pelanggaran, …)
attachments                berkas jawaban (soal unggah berkas)
audit_logs                 jejak aksi penting
```

## Antrean (BullMQ)

| Antrean | Dipicu oleh | Pekerjaan |
|---|---|---|
| `package-build` | *Terbitkan paket* di jadwal | kumpulkan soal/stimulus/peserta/aset, validasi ulang, tulis JSON ke MinIO, simpan snapshot kunci, tandai paket lama `superseded` |
| `results-ingest` | `POST /api/sync/results` | validasi kepemilikan (lokasi, paket, peserta), upsert attempt + jawaban + event per attempt dalam transaksi terpisah |
| `grading` | ingest selesai, *nilai ulang* | nilai jawaban otomatis dengan snapshot kunci, lewati nilai manual, hitung ulang total |

Job dicoba ulang 5× dengan backoff eksponensial. Kesalahan data (mis. paket tanpa peserta)
tidak dicoba ulang; statusnya dicatat di baris terkait (`exam_packages.error`, `sync_batches.error`).
Redis dijalankan dengan AOF dan `maxmemory-policy noeviction` agar job tidak hilang.

## Peran pengguna

| Peran | Akses |
|---|---|
| `admin` | semua, termasuk pengguna, lokasi, peserta, jadwal, penerbitan paket, hapus data |
| `author` | bank soal, stimulus, media, ujian (susunan soal) |
| `grader` | koreksi manual, nilai ulang per attempt |
| `proctor` | melihat dasbor, jadwal (termasuk token sesi), hasil |

## Keamanan

- Password admin: argon2id (m=19 MiB). Password peserta & token sesi: argon2id ringan (m=4 MiB)
  karena dikirim massal di paket; tetap tidak bisa dibalik tanpa brute force.
- Secret titik ujian hanya ditampilkan sekali saat dibuat / diganti.
- Endpoint login dibatasi laju (rate limit).
- Konten HTML soal disanitasi (DOMPurify) saat ditampilkan; hanya skema URL aman yang diizinkan.
- Media untuk panel admin diakses via URL bertanda tangan HMAC berumur 1 jam; titik ujian hanya
  bisa mengunduh aset yang ada di paket miliknya.
- Koreksi manual bersifat *blind*: identitas peserta tidak ditampilkan.

## Aplikasi desktop

Client titik ujian ada di repo [`rust-cbt-client`](https://github.com/gryfklapryd/rust-cbt-client) (Rust + Tauri 2),
mengikuti kontrak di [sinkronisasi.md](sinkronisasi.md). Paket `shared` dan `question-ui` disalin ke repo tersebut.

## Pengembangan berikutnya (belum dikerjakan)

- Enkripsi isi paket (soal) dengan kunci yang dirilis menjelang jadwal dimulai.
- Editor soal visual per jenis (saat ini: editor JSON tervalidasi + pratinjau langsung).
- Render rumus LaTeX (KaTeX) di `question-ui`.
- Analisis butir lanjutan (daya beda, analisis pengecoh), laporan per kelompok, impor soal dari Word/QTI.
