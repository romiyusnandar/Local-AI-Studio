import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Busboy from "busboy";
import * as llm from "./engines/llm.js";
import * as stt from "./engines/stt.js";
import * as tts from "./engines/tts.js";
import * as img from "./engines/img.js";
import { getProgress } from "./lib/progress.js";
import { getStats } from "./lib/perf.js";
import { augmentMessagesWithWebSearch } from "./lib/websearch.js";
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
        const aug = await augmentMessagesWithWebSearch(body.messages, { cacheDir: SEARCH_CACHE_DIR });
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
  sendJson(res, 200, { voices: tts.VOICES });
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
const imgRoutes = makeEngineRoutes(img);

const routes = {
  "/api/health": (req, res) => sendJson(res, 200, { ok: true, name: "Local AI Studio" }),

  "/api/status": llmRoutes.status,
  "/api/chat": handleChat,
  "/api/models": llmRoutes.models,
  "/api/models/select": llmRoutes.select,
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

  "/api/tts/status": (req, res) => tts.status().then((s) => sendJson(res, 200, s)),
  "/api/tts/speak": handleSpeak,
  "/api/tts/voices": handleVoices,

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

  "/api/perf": async (req, res) => {
    const [stats, llmStatus, sttStatus, ttsStatus, imgStatus] = await Promise.all([
      getStats(),
      llm.status(),
      stt.status(),
      tts.status(),
      img.status(),
    ]);
    sendJson(res, 200, {
      ...stats,
      engines: { llm: llmStatus, stt: sttStatus, tts: ttsStatus, img: imgStatus },
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

async function main() {
  try {
    await llm.ensureBackend();
  } catch (err) {
    console.log("gagal menyiapkan backend:", err.message);
    console.log("aplikasi tetap jalan — cek koneksi lalu restart");
  }
  const llmModels = await llm.listModels();
  if (llmModels.length > 0) {
    llm.setActiveModel(llmModels[0]);
  } else {
    console.log(`belum ada model — taruh file .gguf di ${llm.modelDir}/`);
  }
  llm.startEngine();

  try {
    await stt.ensureBackend();
  } catch (err) {
    console.log("gagal menyiapkan backend STT:", err.message);
    console.log("aplikasi tetap jalan — cek koneksi lalu restart");
  }
  const sttModels = await stt.listModels();
  if (sttModels.length > 0) {
    stt.setActiveModel(sttModels[0]);
  } else {
    console.log(`belum ada model STT — taruh file .bin di ${stt.modelDir}/`);
  }

  try {
    await img.ensureBackend();
  } catch (err) {
    console.log("gagal menyiapkan backend image gen:", err.message);
    console.log("aplikasi tetap jalan — cek koneksi lalu restart");
  }
  const imgModels = await img.listModels();
  if (imgModels.length > 0) {
    img.setActiveModel(imgModels[0]);
  } else {
    console.log(`belum ada model image gen — taruh file .gguf/.safetensors di ${img.modelDir}/`);
  }
  img.startEngine();

  server.listen(PORT, HOST, () => {
    console.log(`buka http://localhost:${PORT}`);
    if (HOST === "0.0.0.0") {
      for (const addr of lanAddresses()) {
        console.log(`  dari device lain di jaringan yang sama: http://${addr}:${PORT}`);
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
