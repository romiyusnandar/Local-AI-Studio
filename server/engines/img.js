import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Agent, fetch as undiciFetch } from "undici";
import { ensureBackendFor, detectAccel } from "../lib/backend-manager.js";
import {
  listModelsIn,
  isValidModelIn,
  startModelDownload as startModelDownloadIn,
  deleteModelIn,
  loadCatalog as loadCatalogFrom,
  isValidImageModel,
} from "../lib/models.js";
import { cancelDownload as cancelDownloadShared, isDownloadActive } from "../lib/download-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

export const modelDir = path.join(ROOT, "app", "img-models");
export const backendDir = path.join(ROOT, "app", "img-backend");
export const outputsDir = path.join(ROOT, "app", "outputs");
const manifestPath = path.join(ROOT, "manifests", "img_backends.json");
const catalogPath = path.join(ROOT, "manifests", "img_models.json");
const MODEL_EXTS = [".gguf", ".safetensors"];

// ---------- state proses (mirip pola llm.js) ----------

let proc = null;
let port = 0;
let running = false;
let forceShutdown = false;
let activeModel = "";

// genState menyimpan progres langkah generate yang sedang berjalan, diisi
// dari parsing stdout/stderr sd-server (baris "step/steps - speed" dan fase
// "decoding" VAE). Flag active dikendalikan oleh generate()/edit() karena
// itulah sinyal paling andal kapan sebuah permintaan mulai & selesai.
let genState = { active: false, step: 0, steps: 0, speed: "", decoding: false };

export function getGenerationState() {
  return genState;
}

function resetGenState() {
  genState = { active: false, step: 0, steps: 0, speed: "", decoding: false };
}

// loadState menggambarkan progres pemuatan model saat mesin dinyalakan —
// supaya UI bisa menampilkan "sedang memuat apa" dengan progres, bukan cuma
// "menyala…" tanpa kepastian. Diisi dari parsing log sd-server.
let loadState = { active: false, phase: "", progress: 0, current: 0, total: 0, speed: "" };

export function getLoadState() {
  return loadState;
}

function setLoad(patch) {
  loadState = { ...loadState, ...patch, progress: Math.max(loadState.progress || 0, patch.progress ?? 0) };
}

// Lihat catatan di llm.js: merayapkan progres selama loading agar tidak
// tampak macet saat model diffusion besar dimuat.
let loadTimer = null;
function startLoadCreep() {
  clearInterval(loadTimer);
  loadTimer = setInterval(() => {
    if (!loadState.active) return clearInterval(loadTimer);
    if (loadState.progress < 90) loadState = { ...loadState, progress: loadState.progress + 1 };
  }, 500);
}

function beginLoad() {
  loadState = { active: true, phase: "Memuat model…", progress: 2, current: 0, total: 0, speed: "" };
  startLoadCreep();
}

function endLoad() {
  clearInterval(loadTimer);
  loadState = { active: false, phase: "", progress: 100, current: 0, total: 0, speed: "" };
}

// stripAnsi membuang escape-sequence warna/erase (mis. "\x1b[K") supaya
// regex progres bisa mencocokkan teks bersih.
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// parseLoadLine membaca log sd-server saat startup dan memutakhirkan
// loadState (fase + progres pemuatan bobot). Hanya diproses saat load aktif.
function parseLoadLine(line) {
  if (!loadState.active) return;
  const clean = stripAnsi(line);

  if (/loading model from|load .* using .* format|loading model/i.test(clean)) {
    setLoad({ phase: "Memuat bobot model…", progress: 3 });
  }
  // Progress bar pemuatan tensor sd.cpp: "| 12/34 - 5.2MB/s" (bukan it/s
  // atau s/it yang itu progres generate). current/total = jumlah tensor.
  const m = clean.match(/\|\s*(\d+)\/(\d+)\s*-\s*([^|]+)$/);
  if (m && !/it\/s|s\/it/.test(clean)) {
    const current = parseInt(m[1], 10);
    const total = parseInt(m[2], 10);
    setLoad({
      phase: "Memuat bobot model…",
      progress: total > 0 ? Math.min(90, Math.round((current / total) * 90)) : loadState.progress,
      current,
      total,
      speed: m[3].trim(),
    });
  }
  if (/loading tensors completed|model files processing completed|total params memory/i.test(clean)) {
    setLoad({ phase: "Inisialisasi model…", progress: 95, speed: "" });
  }
}

// parseGenLine membaca satu baris log sd-server dan memutakhirkan genState.
// Pola progres sd.cpp: "|####    | 7/20 - 12.05s/it". Hanya diproses saat
// generate memang aktif — kalau tidak, log startup sd-server (mis. "using
// VAE for encoding / decoding") akan salah dianggap progres.
function parseGenLine(line) {
  if (!genState.active) return;
  const clean = stripAnsi(line);
  if (/generate_image|generating image/i.test(clean)) {
    genState.step = 0;
    genState.steps = 0;
    genState.speed = "";
    genState.decoding = false;
  }
  const m = clean.match(/\|\s*[^|]*\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+\s*(?:it\/s|s\/it))/);
  if (m && !genState.decoding) {
    genState.step = parseInt(m[1], 10);
    genState.steps = parseInt(m[2], 10);
    genState.speed = m[3].trim();
  }
  if (/decoding|vae\s*decod/i.test(clean)) {
    genState.decoding = true;
    genState.speed = "";
  }
}

// makeSdTap: parse tiap baris untuk load/gen state, echo hanya baris penting.
const SD_KEEP = /error|warn|fail|exception|out of memory|loading model|total params|listening on|generate_image|generating image|decoding|completed/i;
function makeSdTap(out) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) {
      for (const sub of line.split("\r")) {
        if (!sub.trim()) continue;
        parseLoadLine(sub);
        parseGenLine(sub);
      }
      if (SD_KEEP.test(line)) out.write(line + "\n");
    }
  };
}

export function isRunning() {
  return running;
}
export function getActiveModel() {
  return activeModel;
}
export function setActiveModel(name) {
  activeModel = name;
}
export function getPort() {
  return port;
}
export { isDownloadActive };

export async function status() {
  return { mesinHidup: running, model: activeModel, load: loadState };
}

export async function selectModel(model) {
  shutdown(proc);
  activeModel = model;
  startEngine();
}

// ---------- backend ----------

export async function ensureBackend() {
  const accel = await detectAccel();
  await ensureBackendFor(backendDir, manifestPath, accel);
}

// ---------- model (delegasi ke lib/models.js) ----------

export const listModels = () => listModelsIn(modelDir, MODEL_EXTS);
export const isValidModel = (name) => isValidModelIn(modelDir, MODEL_EXTS, name);
export const loadCatalog = () => loadCatalogFrom(catalogPath);
export const cancelDownload = cancelDownloadShared;

export function startModelDownload(rawUrl, projectorUrl) {
  return startModelDownloadIn(rawUrl, modelDir, MODEL_EXTS, isValidImageModel, projectorUrl);
}

export async function deleteModel(name) {
  if (name === activeModel) {
    shutdown(proc);
    activeModel = "";
  }
  await deleteModelIn(modelDir, name);
}

// ---------- siklus hidup mesin ----------

function emptyPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
    srv.on("error", reject);
  });
}

async function runSD() {
  if (!activeModel) throw new Error("belum ada model image gen yang dipilih");

  const modelPath = path.join(modelDir, activeModel);
  await fsp.access(modelPath).catch(() => {
    throw new Error(`model image gen "${activeModel}" tidak ditemukan`);
  });

  const p = await emptyPort();
  const bin = path.join(backendDir, process.platform === "win32" ? "sd-server.exe" : "sd-server");

  // sd-server pakai nama flag beda dari llama/whisper: --listen-ip /
  // --listen-port, bukan --host / --port.
  const args = ["-m", modelPath, "--listen-ip", "127.0.0.1", "--listen-port", String(p)];

  // stdout & stderr di-pipe: semua baris di-parse untuk loadState/genState,
  // tapi yang di-echo ke konsol hanya baris penting (error, pemuatan model,
  // siap, mulai/selesai generate) — bukan dump metadata atau bar langkah.
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", makeSdTap(process.stdout));
  child.stderr.on("data", makeSdTap(process.stderr));

  proc = child;
  port = p;
  return child;
}

// waitForReady polling /sdcpp/v1/capabilities — sd-server tidak punya
// endpoint /health seperti llama-server, tapi capabilities selalu 200
// begitu server siap terima koneksi. Model diffusion butuh waktu lebih
// lama dimuat daripada LLM.
function waitForReady(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/sdcpp/v1/capabilities`, { signal: AbortSignal.timeout(3000) });
        if (res.ok) return resolve();
      } catch {
        // belum siap, coba lagi
      }
      if (Date.now() > deadline) return reject(new Error("mesin image gen tidak merespons dalam 120 detik"));
      setTimeout(tick, 500);
    };
    tick();
  });
}

export function killProcess(child) {
  if (!child || child.killed) return false;
  if (process.platform === "win32") {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], () => {});
  } else {
    child.kill();
  }
  return true;
}

export function shutdown(child) {
  if (killProcess(child)) forceShutdown = true;
}

// monitor me-restart mesin image gen kalau ia berhenti sendiri (crash).
// Tidak ada fallback otomatis ke CPU seperti LLM kalau varian GPU gagal
// berulang kali.
async function monitor(child) {
  let failedAttempts = 0;

  for (;;) {
    const start = Date.now();
    running = true;
    await new Promise((resolve) => child.once("exit", resolve));
    running = false;

    if (forceShutdown) return;

    if (Date.now() - start > 60000) failedAttempts = 0;
    failedAttempts++;

    if (failedAttempts > 3) {
      console.log("mesin image gen gagal 3 kali berturut-turut, berhenti mencoba");
      return;
    }

    const pause = failedAttempts * 2000;
    console.log(`mesin image gen berhenti, mencoba lagi dalam ${pause}ms (percobaan ${failedAttempts}/3)`);
    setLoad({ active: true, phase: `Mesin berhenti tak terduga, mencoba lagi (percobaan ${failedAttempts}/3)…`, progress: 0 });
    await new Promise((r) => setTimeout(r, pause));

    try {
      beginLoad();
      setLoad({ phase: `Mencoba lagi (percobaan ${failedAttempts}/3)…` });
      child = await runSD();
      await waitForReady();
      endLoad();
    } catch (err) {
      console.log("gagal menyalakan ulang mesin image gen:", err.message);
      continue;
    }
  }
}

export async function startEngine() {
  beginLoad();
  let child;
  try {
    child = await runSD();
  } catch (err) {
    console.log("gagal menjalankan mesin image gen:", err.message);
    setLoad({ active: false, phase: `gagal: ${err.message}` });
    return;
  }

  console.log("menunggu mesin image gen siap...");
  try {
    await waitForReady();
  } catch (err) {
    console.log("mesin image gen tidak siap:", err.message);
    setLoad({ active: false, phase: `gagal: ${err.message}` });
    shutdown(child);
    return;
  }
  console.log("mesin image gen siap dengan model:", activeModel);
  endLoad();

  monitor(child);
}

export function getProcess() {
  return proc;
}

// ---------- generate / edit ----------

// Generasi gambar bisa makan waktu berpuluh menit (CPU) atau beberapa
// menit (GPU) untuk resolusi/step besar — jauh melebihi timeout bawaan
// undici (headersTimeout/bodyTimeout default 300 detik), yang kalau
// dibiarkan akan memutus koneksi ke sd-server tepat sebelum responsnya
// selesai walau generate-nya sendiri sukses. Agent kustom ini menaikkan
// batas itu ke 15 menit. Catatan: fetch() bawaan Node punya undici
// terbundel sendiri yang tidak kompatibel dengan Agent dari paket npm
// "undici" (beda versi, beda protokol handler internal) — jadi request
// ini harus lewat fetch() dari paket "undici" juga, bukan fetch() global.
const longTimeoutAgent = new Agent({ headersTimeout: 15 * 60 * 1000, bodyTimeout: 15 * 60 * 1000 });

// sdImageResponse cocok dengan bentuk balasan /v1/images/generations dan
// /v1/images/edits milik sd-server (OpenAI-compatible).
async function proxyImageRequest(path_, body, contentType, signal) {
  const res = await undiciFetch(`http://127.0.0.1:${port}${path_}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
    signal,
    duplex: "half",
    dispatcher: longTimeoutAgent,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`mesin image gen gagal membuat gambar${detail ? `: ${detail}` : ""}`);
  }

  const out = await res.json();
  if (!out.data || out.data.length === 0) throw new Error("respons mesin image gen tidak dikenal");

  const buf = Buffer.from(out.data[0].b64_json, "base64");
  const format = out.output_format || "png";
  return { buf, contentType: `image/${format}` };
}

export async function generate(payload, signal) {
  if (!running) throw new Error("mesin image gen sedang mati");
  genState = { active: true, step: 0, steps: 0, speed: "", decoding: false };
  try {
    const result = await proxyImageRequest("/v1/images/generations", JSON.stringify(payload), "application/json", signal);
    await saveToHistory(result, { prompt: payload.prompt || "", size: payload.size || "", mode: "generate" });
    return result;
  } finally {
    resetGenState();
  }
}

export async function edit(formBody, contentType, signal, meta = {}) {
  if (!running) throw new Error("mesin image gen sedang mati");
  genState = { active: true, step: 0, steps: 0, speed: "", decoding: false };
  try {
    const result = await proxyImageRequest("/v1/images/edits", formBody, contentType, signal);
    await saveToHistory(result, { prompt: meta.prompt || "", size: meta.size || "", mode: "edit" });
    return result;
  } finally {
    resetGenState();
  }
}

// ---------- histori gambar ----------

// saveToHistory menulis gambar hasil + sidecar metadata JSON ke app/outputs/.
// Kegagalan menyimpan histori tidak boleh menggagalkan permintaan generate,
// jadi error hanya di-log.
async function saveToHistory({ buf, contentType }, meta) {
  try {
    await fsp.mkdir(outputsDir, { recursive: true });
    const ext = contentType.split("/")[1] || "png";
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const file = `img-${id}.${ext}`;
    await fsp.writeFile(path.join(outputsDir, file), buf);
    await fsp.writeFile(
      path.join(outputsDir, `img-${id}.json`),
      JSON.stringify({ file, prompt: meta.prompt, size: meta.size, mode: meta.mode, model: activeModel, createdAt: Date.now() }, null, 2),
      "utf8"
    );
  } catch (err) {
    console.log("gagal menyimpan histori gambar:", err.message);
  }
}

// listHistory mengembalikan daftar gambar tersimpan, terbaru dulu.
export async function listHistory() {
  let entries;
  try {
    entries = await fsp.readdir(outputsDir);
  } catch {
    return [];
  }
  const items = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(outputsDir, name), "utf8"));
      if (meta.file && (await fsp.access(path.join(outputsDir, meta.file)).then(() => true).catch(() => false))) {
        items.push({ ...meta, url: `/outputs/${encodeURIComponent(meta.file)}` });
      }
    } catch {
      // sidecar rusak, lewati
    }
  }
  return items.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// deleteHistory menghapus satu gambar histori beserta sidecar-nya. Nama file
// divalidasi agar tidak keluar dari folder outputs (cegah path traversal).
export async function deleteHistory(file) {
  if (!file || file.includes("/") || file.includes("\\") || file.includes("..")) {
    throw new Error("nama file tidak valid");
  }
  const base = file.replace(/\.[^.]+$/, "");
  await fsp.rm(path.join(outputsDir, file), { force: true });
  await fsp.rm(path.join(outputsDir, `${base}.json`), { force: true });
}
