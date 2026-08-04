import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureBackendFor, detectAccel } from "../lib/backend-manager.js";
import {
  listModelsIn,
  isValidModelIn,
  startModelDownload as startModelDownloadIn,
  deleteModelIn,
  loadCatalog as loadCatalogFrom,
  isGGUF,
} from "../lib/models.js";
import { cancelDownload as cancelDownloadShared, isDownloadActive } from "../lib/download-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

export const modelDir = path.join(ROOT, "app", "models");
export const backendDir = path.join(ROOT, "app", "backend");
const manifestPath = path.join(ROOT, "manifests", "backends.json");
const catalogPath = path.join(ROOT, "manifests", "models.json");
const MODEL_EXTS = [".gguf"];

// ---------- state proses (mirip var package-level di main.go) ----------

let proc = null;
let port = 0;
let running = false;
let forceShutdown = false;
let activeModel = "";

// loadState menggambarkan progres pemuatan model saat mesin dinyalakan —
// supaya UI menampilkan fase pemuatan, bukan cuma "menyala…". Diisi dari
// parsing log llama-server. llama.cpp tidak selalu memberi persentase
// pemuatan bobot yang bersih, jadi progresnya berbasis fase (memuat →
// bobot → menyiapkan server → siap).
let loadState = { active: false, phase: "", progress: 0, current: 0, total: 0, speed: "" };

export function getLoadState() {
  return loadState;
}

function setLoad(patch) {
  loadState = { ...loadState, ...patch, progress: Math.max(loadState.progress || 0, patch.progress ?? 0) };
}

function beginLoad() {
  loadState = { active: true, phase: "Memulai mesin…", progress: 0, current: 0, total: 0, speed: "" };
}

function endLoad() {
  loadState = { active: false, phase: "", progress: 100, current: 0, total: 0, speed: "" };
}

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

// parseLoadLine membaca log llama-server saat startup dan memutakhirkan
// loadState. Hanya diproses saat load aktif.
function parseLoadLine(line) {
  if (!loadState.active) return;
  const clean = stripAnsi(line);
  if (/load_model: loading model|loading model '/i.test(clean)) {
    setLoad({ phase: "Memuat model…", progress: 8 });
  }
  if (/load_tensors|loading model tensors|llama_model_loader/i.test(clean)) {
    setLoad({ phase: "Memuat bobot model…", progress: 30 });
  }
  // Beberapa build llama.cpp mencetak persentase pemuatan buffer, mis.
  // "load_tensors: ... buffer size = ..." atau progres "  - 45 %".
  const pct = clean.match(/(\d{1,3})\s*%/);
  if (pct && /load|tensor|buffer/i.test(clean)) {
    const v = parseInt(pct[1], 10);
    if (v >= 0 && v <= 100) setLoad({ phase: "Memuat bobot model…", progress: Math.min(90, 30 + Math.round(v * 0.6)) });
  }
  if (/model loaded|initializing, n_slots/i.test(clean)) {
    setLoad({ phase: "Menyiapkan server…", progress: 92 });
  }
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

// ---------- model (delegasi ke lib/models.js yang generik) ----------

export const listModels = () => listModelsIn(modelDir, MODEL_EXTS);
export const isValidModel = (name) => isValidModelIn(modelDir, MODEL_EXTS, name);
export const loadCatalog = () => loadCatalogFrom(catalogPath);
export const cancelDownload = cancelDownloadShared;

export function startModelDownload(rawUrl, projectorUrl) {
  return startModelDownloadIn(rawUrl, modelDir, MODEL_EXTS, isGGUF, projectorUrl);
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

// projectorFor mengecek sidecar "<model>.mmproj" yang ditulis saat unduhan
// companion projector selesai (model multimodal seperti LLaVA).
async function projectorFor(modelPath) {
  try {
    const projName = (await fsp.readFile(modelPath + ".mmproj", "utf8")).trim();
    if (!projName) return null;
    const projPath = path.join(path.dirname(modelPath), projName);
    await fsp.access(projPath);
    return projPath;
  } catch {
    return null;
  }
}

async function runLlama() {
  if (!activeModel) throw new Error("belum ada model yang dipilih");

  const modelPath = path.join(modelDir, activeModel);
  await fsp.access(modelPath).catch(() => {
    throw new Error(`model "${activeModel}" tidak ditemukan`);
  });

  const p = await emptyPort();
  const bin = path.join(backendDir, process.platform === "win32" ? "llama-server.exe" : "llama-server");

  const args = ["-m", modelPath, "--host", "127.0.0.1", "--port", String(p)];
  const proj = await projectorFor(modelPath);
  if (proj) args.push("--mmproj", proj);

  // stdout & stderr di-pipe (bukan "inherit") supaya log pemuatan model
  // bisa di-parse untuk loadState, sambil tetap diteruskan ke console.
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const tap = (chunk, out) => {
    const s = chunk.toString();
    out.write(s);
    for (const line of s.split(/\r|\n/)) {
      if (line.trim()) parseLoadLine(line);
    }
  };
  child.stdout.on("data", (c) => tap(c, process.stdout));
  child.stderr.on("data", (c) => tap(c, process.stderr));

  proc = child;
  port = p;
  return child;
}

function waitForReady(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return resolve();
      } catch {
        // belum siap, coba lagi
      }
      if (Date.now() > deadline) return reject(new Error("mesin tidak merespons dalam 60 detik"));
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
      console.log("mesin gagal 3 kali berturut-turut, berhenti mencoba");
      return;
    }

    const pause = failedAttempts * 2000;
    console.log(`mesin berhenti, mencoba lagi dalam ${pause}ms (percobaan ${failedAttempts}/3)`);
    setLoad({ active: true, phase: `Mesin berhenti tak terduga, mencoba lagi (percobaan ${failedAttempts}/3)…`, progress: 0 });
    await new Promise((r) => setTimeout(r, pause));

    try {
      beginLoad();
      setLoad({ phase: `Mencoba lagi (percobaan ${failedAttempts}/3)…` });
      child = await runLlama();
      await waitForReady();
      endLoad();
    } catch (err) {
      console.log("gagal menyalakan ulang:", err.message);
      continue;
    }
  }
}

export async function startEngine() {
  beginLoad();
  let child;
  try {
    child = await runLlama();
  } catch (err) {
    console.log("gagal menjalankan mesin:", err.message);
    setLoad({ active: false, phase: `gagal: ${err.message}` });
    return;
  }

  console.log("menunggu mesin siap...");
  try {
    await waitForReady();
  } catch (err) {
    console.log("mesin tidak siap:", err.message);
    setLoad({ active: false, phase: `gagal: ${err.message}` });
    shutdown(child);
    return;
  }
  console.log("mesin siap dengan model:", activeModel);
  endLoad();

  monitor(child);
}

export function getProcess() {
  return proc;
}
