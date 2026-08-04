import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import * as llm from "./engines/llm.js";
import { getProgress } from "./lib/progress.js";

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

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

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

// ---------- handler LLM ----------

async function handleStatus(req, res) {
  sendJson(res, 200, { mesinHidup: llm.isRunning(), model: llm.getActiveModel() });
}

async function handleModels(req, res) {
  const models = await llm.listModels();
  sendJson(res, 200, { models, active: llm.getActiveModel(), ready: llm.isRunning() });
}

async function handleSelectModel(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "permintaan tidak valid" });
  }
  if (!(await llm.isValidModel(body.model))) {
    return sendJson(res, 400, { error: "model tidak ditemukan" });
  }
  if (body.model === llm.getActiveModel() && llm.isRunning()) {
    return sendJson(res, 200, { ok: true, model: body.model, note: "sudah aktif" });
  }
  llm.shutdown(llm.getProcess());
  llm.setActiveModel(body.model);
  llm.startEngine();
  sendJson(res, 200, { ok: true, model: body.model });
}

async function handleCatalog(req, res) {
  try {
    const catalog = await llm.loadCatalog();
    const installed = new Set(await llm.listModels());
    const models = catalog.models.map((m) => ({ ...m, installed: installed.has(m.file) }));
    sendJson(res, 200, { models });
  } catch {
    sendJson(res, 500, { error: "katalog rusak" });
  }
}

async function handleDownloadModel(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "permintaan tidak valid" });
  }
  try {
    await llm.startModelDownload(body.url, body.projectorUrl);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    sendJson(res, 400, { error: err.message });
  }
}

async function handleCancelDownload(req, res) {
  sendJson(res, 200, { ok: llm.cancelDownload() });
}

async function handleDeleteModel(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: "permintaan tidak valid" });
  }
  if (!(await llm.isValidModel(body.model))) {
    return sendJson(res, 400, { error: "model tidak ditemukan" });
  }
  try {
    await llm.deleteModel(body.model);
    sendJson(res, 200, { ok: true });
  } catch {
    sendJson(res, 500, { error: "gagal menghapus" });
  }
}

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

// ---------- routing ----------

const routes = {
  "/api/health": (req, res) => sendJson(res, 200, { ok: true, name: "Local AI Studio" }),
  "/api/status": handleStatus,
  "/api/chat": handleChat,
  "/api/models": handleModels,
  "/api/models/select": handleSelectModel,
  "/api/catalog": handleCatalog,
  "/api/models/download": handleDownloadModel,
  "/api/models/cancel": handleCancelDownload,
  "/api/models/delete": handleDeleteModel,
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

  const models = await llm.listModels();
  if (models.length > 0) {
    llm.setActiveModel(models[0]);
  } else {
    console.log(`belum ada model — taruh file .gguf di ${llm.modelDir}/`);
  }

  llm.startEngine();

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`buka http://localhost:${PORT}`);
  });
}

main();
