# Jenis soal

> Dokumen ini dibangkitkan dari template di `packages/shared/src/questions/meta.ts`.
> Skema lengkap (Zod) ada di `packages/shared/src/questions/types.ts`, logika penilaian di `grading.ts`.

Setiap soal terdiri dari:

| Bagian | Isi | Dikirim ke titik ujian? |
|---|---|---|
| `content` | teks soal (HTML) + struktur opsi/item | **ya** (di dalam paket) |
| `answerKey` | kunci jawaban / rubrik | **tidak pernah** (tetap di server pusat) |
| `scoring` | `points`, `mode` (`all_or_nothing` / `partial`), `penalty`, `allowNegative` | hanya `points` |
| response | jawaban peserta yang dikirim balik oleh aplikasi desktop | - |

Aturan umum penilaian:

- Jawaban kosong → status `unanswered`, skor 0 (tanpa penalti).
- Bentuk jawaban tidak sesuai skema → status `invalid`, skor 0.
- `mode: "all_or_nothing"` → skor penuh hanya bila benar sempurna; `"partial"` → proporsional.
- `penalty` dikurangkan bila dijawab tetapi salah total (proporsi 0). Skor tidak negatif kecuali `allowNegative`.
- `points: 0` → soal tidak dinilai (`ungraded`).
- Konten HTML disanitasi saat ditampilkan. Media dirujuk dengan `asset://<uuid>`; rumus ditulis LaTeX `\( … \)`.

| # | Jenis (`type`) | Nama | Dinilai |
|---|---|---|---|
| 1 | [`single_choice`](#single_choice) | Pilihan ganda | otomatis |
| 2 | [`multiple_choice`](#multiple_choice) | Pilihan ganda kompleks | otomatis |
| 3 | [`true_false`](#true_false) | Benar / Salah | otomatis |
| 4 | [`multiple_true_false`](#multiple_true_false) | Benar / Salah majemuk | otomatis |
| 5 | [`short_answer`](#short_answer) | Isian singkat | otomatis |
| 6 | [`numeric`](#numeric) | Isian angka | otomatis |
| 7 | [`essay`](#essay) | Uraian | manual |
| 8 | [`matching`](#matching) | Menjodohkan | otomatis |
| 9 | [`ordering`](#ordering) | Mengurutkan | otomatis |
| 10 | [`fill_blanks`](#fill_blanks) | Isian rumpang | otomatis |
| 11 | [`categorization`](#categorization) | Pengelompokan | otomatis |
| 12 | [`hotspot`](#hotspot) | Hotspot gambar | otomatis |
| 13 | [`hot_text`](#hot_text) | Pilih teks | otomatis |
| 14 | [`matrix`](#matrix) | Matriks / Likert | otomatis |
| 15 | [`file_upload`](#file_upload) | Unggah berkas | manual |

## single_choice

**Pilihan ganda**: Satu jawaban benar dari beberapa opsi. Mendukung bobot per opsi.

Penilaian: Benar bila `optionId` = `correctOptionId`. Dengan `optionWeights`, skor = bobot opsi terpilih × poin.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Ibu kota Indonesia saat ini adalah …</p>",
  "options": [
    {
      "id": "A",
      "content": "Jakarta"
    },
    {
      "id": "B",
      "content": "Bandung"
    },
    {
      "id": "C",
      "content": "Surabaya"
    },
    {
      "id": "D",
      "content": "Nusantara"
    }
  ],
  "shuffleOptions": true
}
```

</details>

Contoh `answerKey` (mode bawaan `all_or_nothing`):

```json
{
  "correctOptionId": "A"
}
```

Contoh jawaban (response):

```json
{
  "optionId": "A"
}
```

## multiple_choice

**Pilihan ganda kompleks**: Lebih dari satu jawaban benar.

Penilaian: Parsial: (opsi benar dipilih − opsi salah dipilih) / jumlah kunci, minimal 0.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Manakah yang termasuk bilangan prima? (pilih semua yang benar)</p>",
  "options": [
    {
      "id": "A",
      "content": "2"
    },
    {
      "id": "B",
      "content": "4"
    },
    {
      "id": "C",
      "content": "7"
    },
    {
      "id": "D",
      "content": "9"
    }
  ],
  "shuffleOptions": true
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "correctOptionIds": [
    "A",
    "C"
  ]
}
```

Contoh jawaban (response):

```json
{
  "optionIds": [
    "A",
    "C"
  ]
}
```

## true_false

**Benar / Salah**: Satu pernyataan, jawab benar atau salah.

Penilaian: Benar bila sama dengan kunci.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Air mendidih pada suhu 100°C di permukaan laut.</p>"
}
```

</details>

Contoh `answerKey` (mode bawaan `all_or_nothing`):

```json
{
  "value": true
}
```

Contoh jawaban (response):

```json
{
  "value": true
}
```

## multiple_true_false

**Benar / Salah majemuk**: Tabel beberapa pernyataan, masing-masing dijawab benar/salah (gaya AKM).

Penilaian: Parsial: jumlah pernyataan benar / jumlah pernyataan.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Tentukan benar atau salah setiap pernyataan berikut.</p>",
  "statements": [
    {
      "id": "s1",
      "content": "Matahari terbit dari timur."
    },
    {
      "id": "s2",
      "content": "Bulan adalah planet."
    },
    {
      "id": "s3",
      "content": "Bumi berbentuk bulat."
    }
  ],
  "shuffleStatements": false
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "values": {
    "s1": true,
    "s2": false,
    "s3": true
  }
}
```

Contoh jawaban (response):

```json
{
  "values": {
    "s1": true,
    "s2": false,
    "s3": true
  }
}
```

## short_answer

**Isian singkat**: Jawaban teks pendek, dicocokkan dengan daftar jawaban yang diterima.

Penilaian: Dicocokkan dengan aturan `accepted` (exact / contains / regex; opsi abaikan huruf besar-kecil, spasi, tanda baca, aksen). Skor = bobot aturan terbaik yang cocok.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Siapa presiden pertama Republik Indonesia?</p>",
  "maxLength": 100
}
```

</details>

Contoh `answerKey` (mode bawaan `all_or_nothing`):

```json
{
  "accepted": [
    {
      "value": "Soekarno",
      "mode": "exact",
      "caseSensitive": false,
      "normalizeWhitespace": true,
      "ignorePunctuation": true,
      "ignoreAccents": false,
      "score": 1
    },
    {
      "value": "Sukarno",
      "mode": "exact",
      "caseSensitive": false,
      "normalizeWhitespace": true,
      "ignorePunctuation": true,
      "ignoreAccents": false,
      "score": 1
    },
    {
      "value": "Ir. Soekarno",
      "mode": "exact",
      "caseSensitive": false,
      "normalizeWhitespace": true,
      "ignorePunctuation": true,
      "ignoreAccents": false,
      "score": 1
    }
  ]
}
```

Contoh jawaban (response):

```json
{
  "text": "Soekarno"
}
```

## numeric

**Isian angka**: Jawaban berupa angka dengan toleransi atau rentang.

Penilaian: Mendukung koma desimal & pemisah ribuan (`1.234,5`). Cocok bila dalam toleransi (absolut / persen) atau rentang `min`–`max`.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Berapakah nilai \\(\\pi\\) sampai dua desimal?</p>",
  "decimalPlaces": 2
}
```

</details>

Contoh `answerKey` (mode bawaan `all_or_nothing`):

```json
{
  "accepted": [
    {
      "value": 3.14,
      "tolerance": 0.005,
      "toleranceMode": "absolute",
      "score": 1
    }
  ]
}
```

Contoh jawaban (response):

```json
{
  "value": "3,14"
}
```

## essay

**Uraian**: Jawaban panjang, dinilai manual oleh korektor (opsional dengan rubrik).

Penilaian: Selalu `pending_manual` → dikoreksi di menu Koreksi (skor langsung atau per kriteria rubrik; total rubrik diskalakan ke poin soal). Jawaban kosong otomatis 0.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Jelaskan proses fotosintesis secara singkat.</p>",
  "minWords": 30,
  "maxWords": 300,
  "richText": false
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "modelAnswer": "<p>Tumbuhan mengubah air dan CO₂ menjadi glukosa dan O₂ dengan bantuan cahaya matahari dan klorofil.</p>",
  "rubric": [
    {
      "id": "r1",
      "criterion": "Menyebut bahan (air, CO₂)",
      "maxPoints": 1
    },
    {
      "id": "r2",
      "criterion": "Menyebut hasil (glukosa, O₂)",
      "maxPoints": 1
    },
    {
      "id": "r3",
      "criterion": "Menyebut peran cahaya & klorofil",
      "maxPoints": 1
    }
  ]
}
```

Contoh jawaban (response):

```json
{
  "text": "Tumbuhan mengubah air dan CO2 …"
}
```

## matching

**Menjodohkan**: Pasangkan item kiri dengan item kanan.

Penilaian: Parsial: (pasangan benar − item kiri pengecoh yang dipasangkan) / jumlah pasangan kunci. Hanya pasangan pertama tiap item kiri yang dihitung.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Jodohkan negara dengan ibu kotanya.</p>",
  "left": [
    {
      "id": "L1",
      "content": "Jepang"
    },
    {
      "id": "L2",
      "content": "Prancis"
    },
    {
      "id": "L3",
      "content": "Mesir"
    }
  ],
  "right": [
    {
      "id": "R1",
      "content": "Tokyo"
    },
    {
      "id": "R2",
      "content": "Paris"
    },
    {
      "id": "R3",
      "content": "Kairo"
    },
    {
      "id": "R4",
      "content": "Roma"
    }
  ],
  "allowReuse": false,
  "shuffle": true
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "pairs": [
    {
      "leftId": "L1",
      "rightId": "R1"
    },
    {
      "leftId": "L2",
      "rightId": "R2"
    },
    {
      "leftId": "L3",
      "rightId": "R3"
    }
  ]
}
```

Contoh jawaban (response):

```json
{
  "pairs": [
    {
      "leftId": "L1",
      "rightId": "R1"
    },
    {
      "leftId": "L2",
      "rightId": "R2"
    },
    {
      "leftId": "L3",
      "rightId": "R3"
    }
  ]
}
```

## ordering

**Mengurutkan**: Susun item ke urutan yang benar.

Penilaian: Semua-atau-tidak: urutan harus persis. Parsial: jumlah item di posisi benar / jumlah item.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Urutkan dari yang terkecil.</p>",
  "items": [
    {
      "id": "a",
      "content": "10"
    },
    {
      "id": "b",
      "content": "3"
    },
    {
      "id": "c",
      "content": "7"
    }
  ]
}
```

</details>

Contoh `answerKey` (mode bawaan `all_or_nothing`):

```json
{
  "order": [
    "b",
    "c",
    "a"
  ]
}
```

Contoh jawaban (response):

```json
{
  "order": [
    "b",
    "c",
    "a"
  ]
}
```

## fill_blanks

**Isian rumpang**: Teks dengan beberapa rumpang: isian teks, angka, dropdown, atau seret kata.

Penilaian: Tiap blank dinilai sesuai jenisnya (teks = aturan teks, angka = aturan angka, dropdown / bank kata = id opsi). Parsial: rata-rata skor blank.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Lengkapi kalimat berikut.</p>",
  "text": "<p>Indonesia merdeka pada tahun [[b1]]. Ibu kotanya adalah [[b2]], dan lagu kebangsaannya [[b3]].</p>",
  "blanks": [
    {
      "id": "b1",
      "kind": "numeric",
      "width": 6
    },
    {
      "id": "b2",
      "kind": "dropdown",
      "options": [
        {
          "id": "o1",
          "content": "Jakarta"
        },
        {
          "id": "o2",
          "content": "Medan"
        }
      ]
    },
    {
      "id": "b3",
      "kind": "word_bank"
    }
  ],
  "wordBank": [
    {
      "id": "w1",
      "content": "Indonesia Raya"
    },
    {
      "id": "w2",
      "content": "Garuda Pancasila"
    }
  ],
  "reuseWordBank": false
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "blanks": {
    "b1": {
      "numeric": [
        {
          "value": 1945,
          "tolerance": 0,
          "toleranceMode": "absolute",
          "score": 1
        }
      ]
    },
    "b2": {
      "optionIds": [
        "o1"
      ]
    },
    "b3": {
      "optionIds": [
        "w1"
      ]
    }
  }
}
```

Contoh jawaban (response):

```json
{
  "values": {
    "b1": "1945",
    "b2": "o1",
    "b3": "w1"
  }
}
```

## categorization

**Pengelompokan**: Seret item ke kategori yang tepat.

Penilaian: Parsial: (item tepat kategori − pengecoh yang ikut ditempatkan) / jumlah item berkunci.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Kelompokkan hewan berikut.</p>",
  "items": [
    {
      "id": "i1",
      "content": "Kucing"
    },
    {
      "id": "i2",
      "content": "Elang"
    },
    {
      "id": "i3",
      "content": "Paus"
    },
    {
      "id": "i4",
      "content": "Merpati"
    }
  ],
  "categories": [
    {
      "id": "mamalia",
      "content": "Mamalia"
    },
    {
      "id": "unggas",
      "content": "Burung"
    }
  ],
  "shuffleItems": true
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "mapping": {
    "i1": "mamalia",
    "i2": "unggas",
    "i3": "mamalia",
    "i4": "unggas"
  }
}
```

Contoh jawaban (response):

```json
{
  "mapping": {
    "i1": "mamalia",
    "i2": "unggas",
    "i3": "mamalia",
    "i4": "unggas"
  }
}
```

## hotspot

**Hotspot gambar**: Klik area yang benar pada gambar.

Penilaian: Koordinat dinormalisasi 0..1 terhadap gambar. Parsial: (region berbeda yang kena − klik meleset) / jumlah region.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Klik letak Pulau Kalimantan pada peta.</p>",
  "image": {
    "src": "asset://00000000-0000-4000-8000-000000000000",
    "width": 800,
    "height": 400,
    "alt": "Peta Indonesia"
  },
  "maxSelections": 1
}
```

</details>

Contoh `answerKey` (mode bawaan `all_or_nothing`):

```json
{
  "regions": [
    {
      "id": "kalimantan",
      "shape": "rect",
      "x": 0.3,
      "y": 0.2,
      "width": 0.2,
      "height": 0.35
    }
  ]
}
```

Contoh jawaban (response):

```json
{
  "points": [
    {
      "x": 0.41,
      "y": 0.33
    }
  ]
}
```

## hot_text

**Pilih teks**: Pilih kata/kalimat yang benar di dalam bacaan.

Penilaian: Seperti pilihan ganda kompleks, untuk segmen teks.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Pilih semua kata kerja dalam kalimat berikut.</p>",
  "segments": [
    {
      "id": "t1",
      "content": "Adik",
      "selectable": true
    },
    {
      "id": "t2",
      "content": "makan",
      "selectable": true
    },
    {
      "id": "t3",
      "content": "lalu",
      "selectable": true
    },
    {
      "id": "t4",
      "content": "tidur",
      "selectable": true
    },
    {
      "id": "t5",
      "content": ".",
      "selectable": false
    }
  ]
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "correctSegmentIds": [
    "t2",
    "t4"
  ]
}
```

Contoh jawaban (response):

```json
{
  "segmentIds": [
    "t2",
    "t4"
  ]
}
```

## matrix

**Matriks / Likert**: Grid baris x kolom. Tanpa kunci = angket (tidak dinilai).

Penilaian: Parsial: jumlah baris yang tepat / jumlah baris. Tanpa `correct` = angket (status `ungraded`, skor maks 0).

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Tentukan wujud zat berikut pada suhu ruang.</p>",
  "rows": [
    {
      "id": "r1",
      "content": "Air"
    },
    {
      "id": "r2",
      "content": "Besi"
    },
    {
      "id": "r3",
      "content": "Oksigen"
    }
  ],
  "columns": [
    {
      "id": "padat",
      "content": "Padat"
    },
    {
      "id": "cair",
      "content": "Cair"
    },
    {
      "id": "gas",
      "content": "Gas"
    }
  ],
  "multiplePerRow": false
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "correct": {
    "r1": [
      "cair"
    ],
    "r2": [
      "padat"
    ],
    "r3": [
      "gas"
    ]
  }
}
```

Contoh jawaban (response):

```json
{
  "selections": {
    "r1": [
      "cair"
    ],
    "r2": [
      "padat"
    ],
    "r3": [
      "gas"
    ]
  }
}
```

## file_upload

**Unggah berkas**: Peserta mengunggah berkas (foto, dokumen, rekaman), dinilai manual.

Penilaian: Berkas diunggah lebih dulu lewat `POST /api/sync/attachments`, lalu id-nya dirujuk di jawaban. Dinilai manual.

<details><summary>Contoh <code>content</code></summary>

```json
{
  "prompt": "<p>Foto hasil gambar kerja Anda lalu unggah di sini.</p>",
  "accept": [
    "image/*",
    ".pdf"
  ],
  "maxFiles": 2,
  "maxSizeMb": 10
}
```

</details>

Contoh `answerKey` (mode bawaan `partial`):

```json
{
  "rubric": [
    {
      "id": "r1",
      "criterion": "Kerapian & kelengkapan",
      "maxPoints": 1
    }
  ]
}
```

Contoh jawaban (response):

```json
{
  "files": [
    {
      "attachmentId": "5b7c2a50-4b6e-4f6e-9a55-3f1c7f2c9a11",
      "name": "kerja.jpg",
      "size": 204800,
      "mime": "image/jpeg"
    }
  ]
}
```
