import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import Busboy from "busboy";
import * as llm from "./engines/llm.js";
import * as stt from "./engines/stt.js";
import * as tts from "./engines/tts.js";
import { getProgress } from "./lib/progress.js";
import { makeEngineRoutes, sendJson } from "./lib/routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, "..", "frontend", "dist");
const PORT = Number(process.env.FRONTEND_PORT) || 1420;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
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

// ---------- handler LLM (chat: proxy SSE, bukan pola model-manager biasa) ----------

// handleChat mem-proxy mentah ke llama-server, meneruskan stream SSE apa
// adanya. Catatan: kalau client memutus koneksi duluan, itu bukan berarti
// prosesnya mati — status hidup/mati murni ditentukan monitor() di llm.js
// lewat event "exit", bukan disentuh di sini.
async function handleChat(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  if (!llm.isRunning()) return sendJson(res, 503, { error: "mesin AI sedang mati" });

  try {
    const upstream = await fetch(`http://127.0.0.1:${llm.getPort()}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: Readable.toWeb(req),
      duplex: "half",
    });

    if (!upstream.ok || !upstream.body) {
      return sendJson(res, 502, { error: "mesin AI tidak merespons" });
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    for await (const chunk of upstream.body) {
      res.write(chunk);
    }
    res.end();
  } catch {
    if (!res.headersSent) sendJson(res, 502, { error: "mesin AI tidak merespons" });
    else res.end();
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

// ---------- routing ----------

const llmRoutes = makeEngineRoutes(llm);
const sttRoutes = makeEngineRoutes(stt);

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

  "/api/progress": (req, res) => sendJson(res, 200, getProgress()),
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

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`buka http://localhost:${PORT}`);
  });
}

main();
