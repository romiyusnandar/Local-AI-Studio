# Local AI Studio

Aplikasi web lokal untuk menjalankan model AI (chat/LLM, generasi gambar, ucapan-ke-teks, teks-ke-ucapan) sepenuhnya di komputer sendiri — tanpa API key, tanpa koneksi ke cloud, dan tanpa biaya per-penggunaan. Semua inferensi berjalan lokal lewat backend native (llama.cpp, stable-diffusion.cpp, whisper.cpp, kokoro-js).

> Proyek ini adalah hasil rewrite total dari versi Go sebelumnya (masih tersedia di branch `legacy-go` sebagai referensi)

## Arsitektur

### Gambaran umum

```
┌──────────────────────────────┐
│   Browser (React SPA)        │
│   frontend/dist (statis)     │
└───────────────┬───────────────┘
                │ HTTP / SSE
┌───────────────▼───────────────┐
│  server/index.js               │
│  Node.js http.createServer     │  <- vanilla, tanpa framework (Express dll)
│  routing manual per req.url    │
└───┬───────┬───────┬───────┬───┘
    │       │       │       │
    ▼       ▼       ▼       ▼
  llm.js  img.js  stt.js  tts.js      (server/engines/)
    │       │       │       │
    ▼       ▼       ▼       ▼
 llama-   sd-      whisper- kokoro-js
 server   server   cli      worker
 (proses  (proses  (spawn   (spawn
 persis-  persis-  per-     per-
 ten)     ten)     request) request)
```

Backend Node.js (`server/index.js`) murni pakai modul bawaan `http` — tidak memakai Express — dengan routing manual berdasarkan `req.url`, mem-serve hasil build frontend (`frontend/dist`) sebagai file statis, sekaligus jadi reverse-proxy tipis ke proses-proses inference native di baliknya.

### Struktur folder

```
server/
  index.js            # entrypoint HTTP, routing, proxy SSE/multipart
  engines/
    llm.js             # siklus hidup llama-server (chat + vision)
    img.js              # siklus hidup sd-server (image generation)
    stt.js              # spawn whisper-cli per-request (speech-to-text)
    tts.js              # spawn worker kokoro-js per-request (text-to-speech)
  lib/
    backend-manager.js   # deteksi akselerasi + unduh/pasang backend native
    models.js            # unduh/validasi/hapus model + katalog
    download.js           # unduhan resumable (HTTP Range)
    download-state.js      # lock unduhan single-flight + progress
    progress.js             # state progress unduhan yang dibagi antar-route
    perf.js                  # metrik CPU/RAM (os module) + GPU (nvidia-smi)
    routes.js                 # factory route standar (status/models/download/dst)
  workers/
    tts-kokoro-worker.mjs      # proses pendek: stdin JSON -> generate audio -> stdout

frontend/
  src/
    App.jsx                    # layout utama + routing panel
    components/                 # Chat, ImageGen, Speech, TextToSpeech,
                                 # ModelManager, System, TopStatusBar, Sidebar
    services/api.js               # lapisan fetch ke seluruh endpoint backend
  dist/                           # hasil build (di-serve statis oleh server)

manifests/
  backends.json, img_backends.json, stt_backends.json, tts_backends.json
  models.json, img_models.json, stt_models.json, tts_models.json
  # deskripsi JSON: OS + akselerasi -> URL unduhan backend/model

app/                              # runtime, dibuat otomatis, tidak masuk git
  backend/ img-backend/ stt-backend/     # binari native hasil unduh
  models/ img-models/ stt-models/         # bobot model
  tts-cache/                               # cache model Kokoro (ONNX)
```

### Pola per-mesin

| Mesin | Backend native | Pola proses | Catatan |
|---|---|---|---|
| **Chat (LLM)** | `llama-server` (llama.cpp) | Proses persisten, dipantau & di-restart otomatis kalau crash | Mendukung vision (gambar terlampir) lewat model `.mmproj` companion |
| **Image Generation** | `sd-server` (stable-diffusion.cpp) | Proses persisten | Mendukung akselerasi Vulkan (jauh lebih cepat dari CPU) |
| **Speech-to-Text** | `whisper-cli` (whisper.cpp) | Spawn baru tiap request, tanpa server persisten | Lebih sederhana, cocok untuk beban STT yang jarang & singkat |
| **Text-to-Speech** | `kokoro-js` (ONNX runtime asli) | Spawn worker Node pendek tiap request | Model TTS diunduh & di-cache otomatis oleh library sendiri ke `app/tts-cache/` |

Backend native (llama-server, sd-server, whisper-cli) diunduh otomatis saat pertama kali dijalankan, sesuai OS dan akselerasi yang terdeteksi (CUDA/Vulkan/CPU), lewat `backend-manager.js` yang membaca deskripsi dari `manifests/*.json`.

### Panel di UI (React)

- **Chat** — percakapan streaming (SSE) dengan model LLM, bisa melampirkan gambar untuk model vision.
- **Gambar** — generate gambar dari teks, atau edit gambar yang sudah ada.
- **Suara→Teks** — rekam dari mikrofon atau unggah file audio, hasilkan transkrip.
- **Teks→Suara** — ubah teks jadi audio dengan berbagai pilihan suara.
- **Model** — kelola model untuk tiap mesin: lihat model terpasang, unduh dari katalog atau URL kustom, hapus, pilih model aktif.
- **Sistem** — pemantauan CPU/RAM/GPU real-time serta status hidup/mati tiap mesin. Ada juga "meter bridge" di header atas yang selalu tampil di semua panel.

## Fitur

- Chat dengan LLM lokal, termasuk dukungan model vision (input gambar)
- Generasi & edit gambar (text-to-image, image-to-image) dengan akselerasi Vulkan
- Speech-to-text dari mikrofon maupun file audio
- Text-to-speech dengan banyak pilihan suara (kokoro-js, ONNX asli)
- Manajer model terpadu: unduh dari katalog bawaan atau URL kustom, unduhan resumable, progress real-time, hapus model
- Deteksi akselerasi otomatis (CUDA/Vulkan/CPU) saat memasang backend
- Panel sistem dengan pemantauan CPU/RAM/GPU dan status tiap mesin secara real-time
- Semuanya berjalan lokal — tidak ada data yang keluar dari komputer

## Cara menjalankan

### Prasyarat

- **Node.js** versi 20 atau lebih baru harus sudah terinstal di sistem ([nodejs.org](https://nodejs.org))
- OS yang didukung: Windows, Linux, atau macOS
- Koneksi internet dibutuhkan **hanya** saat pertama kali mengunduh backend native dan model (setelah itu bisa dipakai offline)
- (Opsional, untuk akselerasi) GPU NVIDIA (CUDA) atau GPU dengan dukungan Vulkan

### Instalasi

```bash
git clone https://github.com/romiyusnandar/Local-AI-Studio.git
cd Local-AI-Studio

# install dependency backend (root)
npm install

# install dependency frontend
npm --prefix frontend install
```

### Build frontend

Frontend (Vite + React) perlu di-build dulu sebelum di-serve oleh server:

```bash
npm run build
```

Ini akan menghasilkan `frontend/dist/`, yang otomatis di-serve statis oleh server Node.js.

### Menjalankan aplikasi

```bash
npm start
```

Server akan:
1. Mendeteksi OS & akselerasi yang tersedia (CUDA/Vulkan/CPU).
2. Mengunduh backend native yang diperlukan (llama-server, sd-server, whisper-cli) kalau belum ada — ukurannya bisa ratusan MB, hanya terjadi sekali.
3. Menyalakan mesin Chat (LLM) dan Image Generation kalau sudah ada model terpasang di `app/models/` dan `app/img-models/`.
4. Berjalan di **http://localhost:1420**

Buka `http://localhost:1420` di browser. Kalau belum ada model, buka panel **Model** di sidebar untuk mengunduh model dari katalog bawaan atau menempelkan URL model sendiri (format `.gguf` untuk chat/image, `.bin` untuk STT).

### Mode pengembangan (opsional)

Untuk pengembangan frontend dengan hot-reload:

```bash
npm run dev:frontend
```

Ini menjalankan Vite dev server terpisah — tetap perlu `npm start` berjalan di terminal lain untuk API backend.

### Variabel lingkungan

| Variabel | Default | Keterangan |
|---|---|---|
| `FRONTEND_PORT` | `1420` | Port HTTP server |

## Catatan

- Model, cache, dan backend native yang terunduh **tidak** masuk ke repo git (lihat `.gitignore`) — semuanya diunduh otomatis saat runtime dan disimpan di folder `app/`.
- Versi lama berbasis Go (single-binary) masih tersedia sebagai referensi di branch [`legacy-go`](https://github.com/romiyusnandar/Local-AI-Studio/tree/legacy-go), tidak lagi dikembangkan.
