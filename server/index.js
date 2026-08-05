import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { execFileSync } from "node:child_process";
import Busboy from "busboy";
import * as llm from "./engines/llm.js";
import * as stt from "./engines/stt.js";
import * as tts from "./engines/tts.js";
import * as img from "./engines/img.js";
import { getProgress } from "./lib/progress.js";
import { getStats } from "./lib/perf.js";
import { installedAccelIn } from "./lib/backend-manager.js";
import { augmentMessagesWithWebSearch } from "./lib/websearch.js";
import * as settings from "./lib/settings.js";
import { makeEngineRoutes, sendJson } from "./lib/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "frontend", "dist");
const SEARCH_CACHE_DIR = path.join(__dirname, "..", "app", "cache", "search");
const PORT = Number(process.env.FRONTEND_PORT) || 1420;

// Default 127.0.0.1: hanya bisa diakses dari komputer ini (aman). Set
// HOST=0.0.0.0 untuk membuka akses dari device lain di jaringan yang sama
// (mis. HP di WiFi yang sama). Aplikasi ini TIDAK punya autentikasi, jadi
// pakai 0.0.0.0 hanya di jaringan tepercaya — jangan diekspos ke internet.
const HOST = process.env.HOST || "127.0.0.1";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";

  // Cegah path traversal (mis. "/../../etc/passwd").
  const filePath = path.join(distDir, reqPath);
  if (!filePath.startsWith(distDir)) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// serveOutput menyajikan file gambar histori dari app/outputs/. Nama file
// di-decode dan divalidasi agar tidak keluar dari folder outputs.
function serveOutput(pathname, res) {
  const name = decodeURIComponent(pathname.slice("/outputs/".length));
  const filePath = path.join(img.outputsDir, name);
  if (!filePath.startsWith(img.outputsDir)) {
    res.writeHead(400);
    res.end("Bad request");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// ---------- handler LLM (chat: proxy SSE, bukan pola model-manager biasa) ----------

// handleChat mem-proxy stream SSE dari llama-server ke browser. Penting:
// kalau browser menutup koneksi duluan (refresh, tutup tab, tekan Stop),
// request ke llama-server DIBATALKAN lewat AbortController. Membatalkan
// fetch menutup koneksi TCP ke backend, dan llama.cpp berhenti membangkitkan
// token begitu koneksi client-nya putus. Tanpa ini, generasi terus jalan di
// background (CPU/RAM tetap tinggi) walau tab sudah ditutup.
async function handleChat(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  if (!llm.isRunning()) return sendJson(res, 503, { error: "mesin AI sedang mati" });

  const controller = new AbortController();
  let finished = false;

  // 'close' dipicu saat koneksi ke browser tertutup — baik karena kita
  // selesai (finished=true) maupun karena client pergi duluan. Hanya batalkan
  // upstream kalau client pergi sebelum kita selesai.
  res.on("close", () => {
    if (!finished) controller.abort();
  });

  try {
    const raw = [];
    for await (const chunk of req) raw.push(chunk);
    const body = JSON.parse(Buffer.concat(raw).toString("utf8") || "{}");

    // Mode browsing: cari di web, suntik hasilnya sebagai konteks. Kegagalan
    // pencarian (diblokir/timeout/rate-limit) TIDAK menggagalkan chat — kita
    // lanjut tanpa konteks web dan memberi tahu UI lewat webError.
    let webSources = [];
    let webError = "";
    if (body.useWeb) {
      try {
        const aug = await augmentMessagesWithWebSearch(body.messages, {
          cacheDir: SEARCH_CACHE_DIR,
          braveApiKey: settings.get("braveApiKey"),
        });
        body.messages = aug.messages;
        webSources = aug.sources;
        if (!webSources.length) webError = "tidak ada hasil pencarian web";
      } catch (err) {
        webError = `pencarian web gagal: ${err.message}`;
      }
    }

    // Buang field kustom kita sebelum diteruskan ke llama-server (yang cuma
    // mengerti field OpenAI standar).
    delete body.useWeb;
    delete body.webQuery;

    const upstream = await fetch(`http://127.0.0.1:${llm.getPort()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!upstream.ok || !upstream.body) {
      finished = true;
      return sendJson(res, 502, { error: "mesin AI tidak merespons" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    // Kirim sumber web (atau info kegagalannya) sebagai event SSE pertama,
    // sebelum token model, supaya UI bisa menampilkannya lebih dulu.
    if (body.stream !== false && (webSources.length || webError)) {
      res.write(`event: web_sources\ndata: ${JSON.stringify({ sources: webSources, error: webError })}\n\n`);
    }
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    finished = true;
    res.end();
  } catch (err) {
    finished = true;
    // AbortError = client memutus duluan; itu normal, bukan kegagalan mesin.
    if (err && err.name === "AbortError") {
      if (!res.writableEnded) res.end();
      return;
    }
    if (!res.headersSent) sendJson(res, 502, { error: "mesin AI tidak merespons" });
    else if (!res.writableEnded) res.end();
  }
}

// ---------- handler STT (transcribe: upload multipart, bukan model-manager biasa) ----------

function parseMultipartFile(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    let fileBuffer = null;
    let filename = "audio.wav";
    const chunks = [];

    bb.on("file", (_name, stream, info) => {
      filename = info.filename || filename;
      stream.on("data", (d) => chunks.push(d));
    });
    bb.on("finish", () => {
      fileBuffer = Buffer.concat(chunks);
      resolve({ fileBuffer, filename });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

async function handleTranscribe(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  try {
    const { fileBuffer, filename } = await parseMultipartFile(req);
    if (!fileBuffer || fileBuffer.length === 0) {
      return sendJson(res, 400, { error: "file audio tidak ditemukan" });
    }
    const result = await stt.transcribe(fileBuffer, filename);
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, err.message === "mesin STT sedang mati" ? 503 : 500, { error: err.message });
  }
}

// ---------- handler TTS (speak: balasan audio mentah, bukan pola model-manager biasa) ----------

async function handleSpeak(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

    const wav = await tts.speak(body.text, body.voice, body.speed);
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(wav);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleVoices(req, res) {
  sendJson(res, 200, await tts.getVoices());
}

// ---------- handler Pengaturan (baca/ubah config, langsung berlaku) ----------

// handleCtxLimits: { limits: { namaFile: n_ctx_train } } untuk model chat
// terpasang — dipakai UI menampilkan & membatasi input context per model.
async function handleCtxLimits(req, res) {
  try {
    sendJson(res, 200, { limits: await llm.contextLimits() });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
}

async function handleSettings(req, res) {
  if (req.method === "GET") return sendJson(res, 200, settings.getPublic());
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan GET atau POST" });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

    // Backstop: batasi override context per-model ke n_ctx_train model itu —
    // mencegah nilai di atas context latih (yang bikin output melantur), meski
    // request datang langsung ke API tanpa lewat UI.
    if (body.contextSizes && typeof body.contextSizes === "object") {
      const limits = await llm.contextLimits();
      for (const [file, val] of Object.entries(body.contextSizes)) {
        const lim = limits[file];
        const n = Number(val);
        if (lim && Number.isFinite(n) && n > lim) body.contextSizes[file] = lim;
      }
    }

    // n_ctx ditetapkan saat llama-server dinyalakan, jadi kalau context efektif
    // model yang SEDANG aktif berubah, engine perlu di-restart agar -c baru
    // dipakai. Bandingkan sebelum/sesudah update untuk model aktif saja.
    const active = llm.getActiveModel();
    const ctxBefore = active ? settings.contextForModel(active) : 0;
    const updated = await settings.update(body);
    if (active && llm.isRunning() && settings.contextForModel(active) !== ctxBefore) {
      llm.selectModel(active); // restart dengan context baru (non-blocking)
    }

    sendJson(res, 200, updated);
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

// ---------- handler Image (generate/edit: balasan gambar mentah, bukan pola model-manager biasa) ----------

// handleImgGenerate/handleImgEdit mem-proxy ke sd-server dan decode
// b64_json responsnya jadi bytes gambar mentah — konsisten dengan pola
// handleSpeak (TTS) supaya klien tinggal pakai <img>/blob tanpa decode
// manual.
async function handleImgGenerate(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");

    const { buf, contentType } = await img.generate(payload);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(buf);
  } catch (err) {
    sendJson(res, err.message === "mesin image gen sedang mati" ? 503 : 502, { error: err.message });
  }
}

async function handleImgEdit(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  try {
    // prompt & size dikirim frontend sebagai query param supaya bisa dicatat
    // ke histori tanpa harus mem-parse ulang body multipart (yang tetap
    // diteruskan mentah ke sd-server).
    const q = new URL(req.url, "http://localhost").searchParams;
    const meta = { prompt: q.get("prompt") || "", size: q.get("size") || "" };
    const { buf, contentType } = await img.edit(Readable.toWeb(req), req.headers["content-type"], undefined, meta);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(buf);
  } catch (err) {
    sendJson(res, err.message === "mesin image gen sedang mati" ? 503 : 502, { error: err.message });
  }
}

async function handleImgHistoryDelete(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    await img.deleteHistory(body.file);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

// ---------- routing ----------

const llmRoutes = makeEngineRoutes(llm);
const sttRoutes = makeEngineRoutes(stt);
const ttsRoutes = makeEngineRoutes(tts);
const imgRoutes = makeEngineRoutes(img);

const routes = {
  "/api/health": (req, res) => sendJson(res, 200, { ok: true, name: "Local AI Studio" }),

  "/api/status": llmRoutes.status,
  "/api/chat": handleChat,
  "/api/models": llmRoutes.models,
  "/api/models/select": llmRoutes.select,
  "/api/models/ctx-limits": handleCtxLimits,
  "/api/catalog": llmRoutes.catalog,
  "/api/models/download": llmRoutes.download,
  "/api/models/cancel": llmRoutes.cancel,
  "/api/models/delete": llmRoutes.delete,

  "/api/stt/status": sttRoutes.status,
  "/api/stt/transcribe": handleTranscribe,
  "/api/stt/models": sttRoutes.models,
  "/api/stt/models/select": sttRoutes.select,
  "/api/stt/catalog": sttRoutes.catalog,
  "/api/stt/models/download": sttRoutes.download,
  "/api/stt/models/cancel": sttRoutes.cancel,
  "/api/stt/models/delete": sttRoutes.delete,

  "/api/tts/status": ttsRoutes.status,
  "/api/tts/speak": handleSpeak,
  "/api/tts/voices": handleVoices,
  "/api/tts/models": ttsRoutes.models,
  "/api/tts/models/select": ttsRoutes.select,
  "/api/tts/catalog": ttsRoutes.catalog,
  "/api/tts/models/download": ttsRoutes.download,
  "/api/tts/models/cancel": ttsRoutes.cancel,
  "/api/tts/models/delete": ttsRoutes.delete,

  "/api/img/status": imgRoutes.status,
  "/api/img/generate": handleImgGenerate,
  "/api/img/edit": handleImgEdit,
  "/api/img/generation": (req, res) => sendJson(res, 200, img.getGenerationState()),
  "/api/img/history": (req, res) => img.listHistory().then((h) => sendJson(res, 200, { items: h })),
  "/api/img/history/delete": handleImgHistoryDelete,
  "/api/img/models": imgRoutes.models,
  "/api/img/models/select": imgRoutes.select,
  "/api/img/catalog": imgRoutes.catalog,
  "/api/img/models/download": imgRoutes.download,
  "/api/img/models/cancel": imgRoutes.cancel,
  "/api/img/models/delete": imgRoutes.delete,

  "/api/progress": (req, res) => sendJson(res, 200, getProgress()),

  "/api/settings": handleSettings,

  "/api/perf": async (req, res) => {
    const [stats, llmStatus, sttStatus, ttsStatus, imgStatus, llmAccel, sttAccel, imgAccel] = await Promise.all([
      getStats(),
      llm.status(),
      stt.status(),
      tts.status(),
      img.status(),
      installedAccelIn(llm.backendDir),
      installedAccelIn(stt.backendDir),
      installedAccelIn(img.backendDir),
    ]);
    sendJson(res, 200, {
      ...stats,
      engines: {
        llm: { ...llmStatus, accel: llmAccel },
        stt: { ...sttStatus, accel: sttAccel },
        tts: { ...ttsStatus, accel: "cpu" },
        img: { ...imgStatus, accel: imgAccel },
      },
    });
  },
};

const server = http.createServer((req, res) => {
  const pathname = req.url.split("?")[0];
  const handler = routes[pathname];
  if (handler) {
    Promise.resolve(handler(req, res)).catch((err) => {
      console.error("handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "kesalahan internal" });
    });
    return;
  }

  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, { error: "endpoint tidak ditemukan" });
  }

  // Gambar histori disajikan dari app/outputs/ (di luar folder build frontend).
  if (pathname.startsWith("/outputs/")) {
    return serveOutput(pathname, res);
  }

  return serveStatic(req, res);
});

// killOrphans membunuh proses inference yatim (llama-server/sd-server) dari
// sesi sebelumnya yang tidak sempat dimatikan (mis. server ditutup paksa,
// crash, atau node dibunuh tanpa membunuh anaknya). Karena aplikasi TIDAK
// auto-load model, saat startup seharusnya tidak ada proses ini yang sah —
// jadi aman membersihkan semuanya agar RAM tidak terpakai proses hantu.
function killOrphans() {
  const names = process.platform === "win32" ? ["llama-server.exe", "sd-server.exe"] : ["llama-server", "sd-server"];
  for (const n of names) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/F", "/IM", n, "/T"], { stdio: "ignore" });
      else execFileSync("pkill", ["-9", "-f", n], { stdio: "ignore" });
    } catch {
      // tidak ada proso yang cocok — normal
    }
  }
}

// cleanupChildren mematikan proses backend anak saat server ini berhenti,
// supaya tidak jadi yatim. Dipanggil pada SIGINT/SIGTERM (mis. Ctrl+C).
function cleanupChildren() {
  for (const proc of [llm.getProcess(), img.getProcess()]) {
    if (!proc || proc.killed || !proc.pid) continue;
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
      else proc.kill("SIGKILL");
    } catch {
      // sudah mati / gagal — abaikan
    }
  }
}

let shuttingDown = false;
function gracefulExit() {
  // Ctrl+C kedua (atau sinyal kedua): jangan tunggu apa pun — paksa keluar.
  if (shuttingDown) {
    console.log("mematikan paksa…");
    process.exit(1);
  }
  shuttingDown = true;
  console.log("\nmematikan… (tekan Ctrl+C lagi untuk paksa)");

  // Jaring pengaman: apa pun yang terjadi, proses HARUS berhenti. Jika
  // cleanupChildren tersangkut (mis. taskkill lambat/menggantung), timer ini
  // memaksa keluar. unref() supaya timer sendiri tidak menahan event loop.
  const hardKill = setTimeout(() => process.exit(1), 3000);
  hardKill.unref();

  try {
    cleanupChildren();
  } catch {
    // apa pun errornya, tetap keluar
  }
  process.exit(0);
}
process.on("SIGINT", gracefulExit);
process.on("SIGTERM", gracefulExit);

async function main() {
  // Bersihkan proses inference yatim dari sesi sebelumnya sebelum mulai.
  killOrphans();

  // Catatan: backend (binari llama/whisper/sd) tetap disiapkan saat start,
  // tapi TIDAK ada model yang dimuat otomatis. Pengguna memilih model yang
  // ingin dipakai di Model Manager, dan hanya saat itulah mesinnya menyala —
  // supaya tidak ada model yang ter-load tanpa diminta (mencegah error &
  // pemakaian RAM/VRAM yang tidak perlu). Disiapkan berurutan agar progress
  // unduhan backend (state global bersama) tidak saling menimpa.
  await llm.ensureBackend().catch((err) => console.log("gagal menyiapkan backend chat:", err.message));
  await stt.ensureBackend().catch((err) => console.log("gagal menyiapkan backend STT:", err.message));
  await img.ensureBackend().catch((err) => console.log("gagal menyiapkan backend image gen:", err.message));
  console.log("backend siap — pilih model di Model Manager untuk mulai memakai tiap mesin");

  server.listen(PORT, HOST, () => {
    console.log("=====================================");
    console.log(`  buka http://localhost:${PORT}  `);
    if (HOST === "0.0.0.0") {
      for (const addr of lanAddresses()) {
        console.log(`  dari device lain di jaringan yang sama: http://${addr}:${PORT}`);
        console.log("=====================================");
      }
      console.log("  (akses jaringan aktif — pastikan hanya di jaringan tepercaya)");
    }
  });
}

// lanAddresses mengumpulkan IPv4 non-internal (alamat LAN) supaya bisa
// ditampilkan sebagai URL yang bisa dibuka dari device lain.
function lanAddresses() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces || []) {
      if (i.family === "IPv4" && !i.internal) out.push(i.address);
    }
  }
  return out;
}

main();
