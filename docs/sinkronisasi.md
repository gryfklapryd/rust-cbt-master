# Protokol sinkronisasi: server pusat ↔ aplikasi desktop

Dokumen ini adalah kontrak untuk aplikasi desktop (Rust + Tauri) di titik ujian.
Skema resminya ada di [`packages/shared/src/sync.ts`](../packages/shared/src/sync.ts) (Zod);
dokumentasi OpenAPI interaktif tersedia di `/docs` pada server.

Semua endpoint berada di bawah `/api/sync`. Format data JSON, waktu ISO-8601 dengan zona
waktu (`2026-09-24T08:00:00+07:00` atau `…Z`), ID berupa UUID.

## Alur umum

```
 (online, H-1 / pagi hari)                    (offline)                 (online, sesudah ujian)
 ┌───────────┐  ┌────────────┐  ┌──────────┐   ┌──────────────────┐    ┌─────────────┐  ┌──────────┐
 │ 1. auth   │→ │ 2. jadwal  │→ │ 3. paket │ → │ 5. ujian berjalan │ →  │ 6. lampiran │→ │ 7. hasil │
 └───────────┘  └────────────┘  │ 4. aset  │   │   (login peserta, │    └─────────────┘  └──────────┘
                                └──────────┘   │   simpan lokal)   │                          │
                                               └──────────────────┘                    8. cek status
```

1. **Auth lokasi**: `POST /api/sync/auth`
2. **Daftar jadwal**: `GET /api/sync/schedules`
3. **Unduh paket**: `GET /api/sync/schedules/:scheduleId/package`
4. **Unduh media**: `GET /api/sync/assets/:assetId` untuk tiap aset di `package.assets`
5. Ujian berjalan sepenuhnya **offline** memakai paket lokal.
6. **Unggah berkas jawaban** (soal `file_upload`): `POST /api/sync/attachments`
7. **Kirim hasil**: `POST /api/sync/results`
8. **Cek status batch**: `GET /api/sync/results/:batchId`

Opsional: `POST /api/sync/heartbeat` berkala saat online, supaya panel admin tahu lokasi aktif.

## 1. Auth

```http
POST /api/sync/auth
{ "siteCode": "SMAN1-LAB1", "secret": "…", "deviceId": "PC-SERVER-LAB1", "appVersion": "0.1.0" }
```

Respons `200`:

```json
{
  "token": "eyJ…",
  "expiresAt": "2026-09-25T05:00:00.000Z",
  "site": { "id": "…", "code": "SMAN1-LAB1", "name": "…" },
  "serverTime": "2026-09-24T05:00:00.000Z"
}
```

- `siteCode` + `secret` dibuat di panel admin (menu **Titik Ujian**). Secret hanya ditampilkan
  sekali; simpan terenkripsi di desktop (mis. keyring OS).
- Kirim `Authorization: Bearer <token>` di semua request berikutnya. Token berlaku `JWT_SITE_TTL`
  (bawaan 24 jam); login ulang bila mendapat `401`.
- Pakai `serverTime` untuk mendeteksi selisih jam komputer lokal.

## 2. Daftar jadwal

```http
GET /api/sync/schedules?since=2026-09-01T00:00:00Z
```

Mengembalikan jadwal lokasi ini yang berstatus `published` / `closed` dan belum berakhir sejak
`since` (bawaan 7 hari lalu). Setiap jadwal membawa ringkasan paket terbaru yang siap:

```json
{
  "serverTime": "…",
  "schedules": [
    {
      "id": "…", "name": "Sesi 1", "startAt": "…", "endAt": "…", "status": "published",
      "exam": { "id": "…", "code": "UTS-IPA", "title": "…", "durationMinutes": 90 },
      "package": { "id": "…", "version": 3, "checksum": "sha256-hex", "size": 15889, "builtAt": "…", "assetCount": 4 }
    }
  ]
}
```

`package: null` berarti paket belum pernah diterbitkan / masih dibangun. Bandingkan `checksum`
dengan paket lokal untuk tahu perlu mengunduh ulang atau tidak.

## 3. Paket ujian

```http
GET /api/sync/schedules/:scheduleId/package
If-None-Match: "<checksum paket lokal>"
```

- `200` + JSON `ExamPackage`, header `ETag: "<checksum>"`, `X-Package-Id`, `X-Package-Version`.
- `304` bila paket lokal sudah terbaru.
- `checksum` = SHA-256 (hex) dari body persis seperti diterima → verifikasi integritas setelah unduh.

Isi paket (ringkas; lihat `ExamPackage` di `sync.ts`):

| Field | Keterangan |
|---|---|
| `formatVersion` | saat ini `1`; tolak paket dengan versi yang tidak dikenal |
| `packageId`, `version` | identitas paket; **`packageId` wajib dikirim balik di setiap attempt** |
| `site` | lokasi pemilik paket |
| `schedule` | waktu mulai/selesai, `lateEntryMinutes`, `accessTokenHash` (argon2id token sesi, atau `null`) |
| `exam` | judul, petunjuk, `durationMinutes`, `settings` (acak soal/opsi, navigasi, kiosk, batas pelanggaran, …), `sections[]` berisi `questionIds` berurutan, `pickCount`, `durationMinutes` per bagian |
| `questions[]` | `{ id, type, content, points, stimulusId, version }`, **tanpa kunci jawaban** |
| `stimuli[]` | bacaan/media bersama, `settings.mediaPlayLimit` |
| `participants[]` | `{ id, number, name, groupName, gender, birthDate, passwordHash, photoAssetId }` |
| `assets[]` | `{ id, filename, mime, size, sha256 }` untuk diunduh di langkah 4 |

### Login offline

- **Peserta**: verifikasi password dengan `passwordHash` (format PHC `$argon2id$v=19$m=…,t=…,p=…$…`).
  Di Rust: crate [`argon2`](https://crates.io/crates/argon2) → `PasswordHash::new(hash)` lalu
  `Argon2::default().verify_password(pw.as_bytes(), &parsed)` (parameter dibaca dari string hash).
- **Token sesi**: bila `schedule.accessTokenHash` tidak `null`, pengawas membacakan token dan desktop
  memverifikasinya dengan cara yang sama.
- Hanya izinkan mulai di antara `startAt` dan `endAt` (serta `startAt + lateEntryMinutes` bila diisi).

### Menjalankan ujian

- Tampilkan soal sesuai `exam.sections` (urut `order`). Bila `pickCount` diisi, ambil acak N soal dari
  bagian itu per peserta; bila `shuffleQuestions` / `settings.shuffleQuestions`, acak urutannya.
  Opsi diacak bila `settings.shuffleOptions` **dan** `content.shuffleOptions` (dll.) bernilai `true`.
- Simpan urutan final di `questionOrder` (dan `optionOrders`) pada attempt, karena **penilaian dan
  laporan hanya memperhitungkan soal di `questionOrder`**. Bila `questionOrder` tidak dikirim,
  server menganggap semua soal paket disajikan.
- Bentuk `content` dan bentuk jawaban tiap jenis soal: lihat [jenis-soal.md](jenis-soal.md).
  Komponen React siap pakai untuk semua jenis ada di [`packages/question-ui`](../packages/question-ui).
- Media: ganti `asset://<id>` di HTML dengan URL berkas lokal (mis. `convertFileSrc` di Tauri);
  `QuestionView` menerima prop `resolveAsset(id) => url`.

## 4. Aset

```http
GET /api/sync/assets/:assetId
If-None-Match: "<sha256>"
```

Hanya aset yang tercantum di paket (siap / lama) milik lokasi ini yang bisa diunduh; selain itu `404`.
Verifikasi `sha256` setelah unduh.

## 6. Lampiran jawaban (soal unggah berkas)

```http
POST /api/sync/attachments        (multipart/form-data)
  attachmentId = <uuid dibuat desktop>      ← kirim field teks SEBELUM field file
  attemptId    = <uuid attempt>             (opsional)
  questionId   = <uuid soal>                (opsional)
  file         = <berkas>
```

- `201` saat pertama kali, `200` + data yang sama bila `attachmentId` sudah pernah diunggah (idempoten).
- Di jawaban soal `file_upload`, rujuk berkas dengan `attachmentId` tersebut.
- Unggah semua lampiran **sebelum** mengirim hasil.

## 7. Kirim hasil

```http
POST /api/sync/results
{
  "batchId": "<uuid baru per pengiriman>",
  "attempts": [
    {
      "attemptId": "<uuid dibuat saat peserta mulai>",
      "packageId": "<package.packageId>",
      "scheduleId": "…",
      "participantId": "…",
      "status": "submitted",                 // in_progress | submitted | timed_out | terminated
      "sequence": 4,                         // naik setiap kali attempt ini dikirim
      "startedAt": "…", "finishedAt": "…",
      "questionOrder": ["<questionId>", "…"],
      "optionOrders": { "<questionId>": ["C", "A", "D", "B"] },
      "answers": [
        { "questionId": "…", "response": { "optionId": "A" }, "answeredAt": "…",
          "timeSpentSeconds": 42, "flagged": false, "changeCount": 1 }
      ],
      "events": [
        { "type": "start", "at": "…" },
        { "type": "violation", "at": "…", "data": { "reason": "focus_lost" } }
      ],
      "client": { "deviceId": "PC-07", "appVersion": "0.1.0", "hostname": "LAB1-PC07" }
    }
  ]
}
```

Respons `202` (atau `200` bila `batchId` sudah pernah diterima):

```json
{ "batchId": "…", "status": "received", "attemptCount": 1, "receivedAt": "…", "processedAt": null, "error": null }
```

Aturan penting:

- **Idempoten per `batchId`.** Bila koneksi putus dan tidak yakin terkirim, kirim ulang dengan
  `batchId` yang sama. Batch baru → `batchId` baru.
- Maksimal 500 attempt per batch; body maksimal `BODY_LIMIT_MB` (bawaan 50 MB). Pecah bila perlu.
- **Kirim seluruh jawaban attempt setiap kali** (bukan hanya yang berubah). Server menyimpan data
  dengan `sequence` terbesar; data dengan `sequence` lebih kecil diabaikan.
- Attempt `in_progress` boleh dikirim untuk pemantauan; penilaian hanya berjalan untuk status akhir
  (`submitted`, `timed_out`, `terminated`).
- Satu peserta hanya boleh punya satu attempt per jadwal. Bila pengawas mengizinkan mengulang,
  admin harus menghapus attempt lama di panel (menu Hasil) sebelum attempt baru diterima.
- Kirim event pelanggaran dengan `type: "violation"`; jumlahnya ditampilkan di laporan.
  Event dideduplikasi berdasarkan `(type, at)`, jadi aman terkirim berulang.

## 8. Status batch

```http
GET /api/sync/results/:batchId
```

```json
{
  "batchId": "…", "status": "processed", "attemptCount": 2, "receivedAt": "…", "processedAt": "…", "error": null,
  "attempts": [
    { "attemptId": "…", "accepted": true, "reason": null },
    { "attemptId": "…", "accepted": false, "reason": "Peserta tidak terdaftar di jadwal ini" }
  ]
}
```

`status`: `received` → `processing` → `processed` | `failed`. Tandai attempt lokal sebagai
"tersinkron" hanya bila `accepted: true`. Attempt yang ditolak perlu ditangani manual (tampilkan
`reason` ke operator).

## Kode respons

| Kode | Arti |
|---|---|
| `400` | body tidak sesuai skema (`issues` berisi rincian) |
| `401` | token tidak ada / kedaluwarsa → login ulang |
| `403` | token bukan token lokasi |
| `404` | jadwal/paket/aset bukan milik lokasi ini atau belum tersedia |
| `409` | ID (batch/lampiran) sudah dipakai lokasi lain |
| `413` | body/berkas terlalu besar |
| `429` | terlalu banyak percobaan login |
