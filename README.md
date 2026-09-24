# rust-cbt-master

Sistem **Computer Based Test (CBT)** terdistribusi:

- **Server pusat** (repo ini, sudah dikerjakan): menyimpan bank soal, peserta, jadwal, dan hasil;
  membangun paket ujian; menerima dan menilai hasil dari titik ujian; panel admin.
- **Aplikasi desktop** (Rust + Tauri, repo [`rust-cbt-client`](https://github.com/gryfklapryd/rust-cbt-client)): dipasang di tiap titik ujian, mengunduh paket
  (peserta, soal, jadwal) sebelum ujian, menjalankan ujian **offline**, lalu mengirim hasil ke server pusat.

Mendukung **15 jenis soal**: pilihan ganda, pilihan ganda kompleks, benar/salah, benar/salah majemuk,
isian singkat, isian angka, uraian, menjodohkan, mengurutkan, isian rumpang (teks/angka/dropdown/bank kata),
pengelompokan, hotspot gambar, pilih teks, matriks/Likert, dan unggah berkas, lengkap dengan penilaian
otomatis (mode semua-atau-tidak / parsial, penalti) dan koreksi manual berbasis rubrik.
Rincian: [docs/jenis-soal.md](docs/jenis-soal.md).

## Struktur

```
apps/
  server/         API Fastify + worker BullMQ (TypeScript, Drizzle, PostgreSQL, MinIO)
  admin/          Panel admin React + Vite
packages/
  shared/         Kontrak bersama: skema Zod jenis soal, mesin penilaian, format paket & hasil
  question-ui/    Komponen React untuk menampilkan/menjawab semua jenis soal (admin & Tauri)
                  (shared & question-ui disalin ke rust-cbt-client dengan scripts/sync-shared.sh di repo itu)
docs/
  arsitektur.md   Arsitektur, model data, antrean, keamanan
  sinkronisasi.md Protokol server ↔ aplikasi desktop (untuk pengembang client Tauri)
  jenis-soal.md   Bentuk konten, kunci, jawaban, dan aturan nilai tiap jenis soal
```

| Kebutuhan | Pilihan |
|---|---|
| Runtime / framework | Node.js 22 + Fastify 5 |
| Database / ORM | PostgreSQL 17 + Drizzle ORM (migrasi SQL di `apps/server/drizzle`) |
| Validasi | Zod 4 (juga untuk skema request API & dokumentasi OpenAPI di `/docs`) |
| Penyimpanan media | MinIO (S3-compatible) |
| Antrean | BullMQ + Redis: bangun paket, proses hasil, penilaian |
| Admin panel | React 19 (satu monorepo pnpm, siap dipakai bersama frontend Tauri) |
| Deploy | Docker Compose di satu server |

## Deploy (Docker Compose, satu server)

```bash
cp .env.example .env          # WAJIB: ganti password, JWT_SECRET, admin awal
docker compose up -d --build
docker compose run --rm api node dist/db/seed.js           # buat admin awal
docker compose run --rm api node dist/db/seed.js --demo    # (opsional) data contoh lengkap
```

- Panel admin: `http://<server>:8080` (port dari `HTTP_PORT`)
- Dokumentasi API (OpenAPI): `http://<server>:8080/docs`
- Aplikasi desktop diarahkan ke `http://<server>:8080` (endpoint `/api/sync/*`)
- Migrasi database berjalan otomatis saat container `api` start.
- Layanan: `postgres`, `redis`, `minio`, `api`, `worker` (proses antrean terpisah), `admin` (nginx: SPA + proxy `/api`).
- Image MinIO dibangun dari source ([`deploy/minio`](deploy/minio/Dockerfile)) karena image resmi `minio/minio` sudah tidak tersedia di Docker Hub. Build pertama butuh beberapa menit.
- Pasang HTTPS di depan port tersebut (reverse proxy / load balancer) untuk produksi.

Data contoh (`--demo`) membuat lokasi `DEMO-01` (secret `demo-secret-ganti-saya`), 30 peserta
`DEMO-0001…0030` (password `123456`), bank soal berisi satu contoh untuk tiap jenis soal, ujian, dan
jadwal hari ini yang langsung diterbitkan (token sesi `DEMO01`).

## Pengembangan lokal

Butuh Node.js ≥ 22, pnpm 10, dan Docker (untuk PostgreSQL/Redis/MinIO).

```bash
pnpm install
docker compose -f docker-compose.dev.yml up -d   # postgres, redis, minio (+ database cbt_test)
pnpm db:seed --demo                               # migrasi + admin (admin / admin12345) + data contoh

INLINE_WORKER=true pnpm dev:server                # API :3000 (worker di proses yang sama)
pnpm dev:admin                                    # panel admin :5173 (proxy /api ke :3000)
# atau jalankan worker terpisah: pnpm dev:worker
```

Konfigurasi server lewat environment, lihat [`apps/server/src/config.ts`](apps/server/src/config.ts)
(nilai bawaan cocok dengan `docker-compose.dev.yml`).

### Tes

```bash
pnpm --filter @cbt/shared test    # unit test skema & penilaian semua jenis soal
pnpm --filter @cbt/server test    # tes integrasi alur lengkap (butuh postgres, redis, minio dev)
pnpm typecheck
```

Tes integrasi server menjalankan skenario ujung-ke-ujung: buat lokasi, impor peserta, unggah media,
buat 15 jenis soal, susun ujian, terbitkan paket, login lokasi, unduh paket (dan memastikan tidak ada
kunci jawaban di dalamnya), kirim hasil, penilaian otomatis, koreksi manual rubrik, koreksi kunci
dan nilai ulang, serta idempotensi sinkronisasi.

### Mengubah skema database

```bash
# ubah apps/server/src/db/schema.ts, lalu:
pnpm db:generate    # buat file migrasi SQL baru di apps/server/drizzle
pnpm db:migrate
```

## Alur kerja singkat

1. **Titik Ujian**: daftarkan lokasi; catat kode + secret untuk konfigurasi aplikasi desktop.
2. **Peserta**: impor CSV (`nomor, nama, kelompok, jk, tgl_lahir, kode_lokasi, password`); unduh CSV password untuk kartu peserta.
3. **Media** & **Bank Soal**: unggah gambar/audio/video, buat soal (editor dengan validasi langsung, pratinjau tampilan peserta, dan uji kunci).
4. **Ujian**: susun bagian dan soal, atur durasi, acak soal/opsi, mode kiosk, batas pelanggaran.
5. **Jadwal**: buat sesi untuk satu atau banyak lokasi sekaligus, daftarkan peserta, lalu **Terbitkan paket**.
6. Aplikasi desktop mengunduh paket, ujian berjalan offline, hasil dikirim kembali.
7. **Hasil**: nilai otomatis, **Koreksi** untuk uraian/unggahan, ekspor CSV, nilai ulang bila kunci dikoreksi.
8. **Sinkronisasi**: pantau batch hasil dari tiap lokasi.
