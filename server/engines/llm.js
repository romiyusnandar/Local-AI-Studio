import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { spawn, execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureBackendFor, detectAccel } from "../lib/backend-manager.js";
import { downloadWithResume } from "../lib/download.js";
import { setProgress, getProgress } from "../lib/progress.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

export const modelDir = path.join(ROOT, "app", "models");
export const backendDir = path.join(ROOT, "app", "backend");
const manifestPath = path.join(ROOT, "manifests", "backends.json");
const catalogPath = path.join(ROOT, "manifests", "models.json");

// ---------- state proses (mirip var package-level di main.go) ----------

let proc = null;
let port = 0;
let running = false;
let forceShutdown = false;
let activeModel = "";

// Hanya satu unduhan model sekaligus di seluruh aplikasi.
let dlBusy = false;
let dlAbort = null;

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
export function isDownloadActive() {
  return dlBusy;
}

// ---------- backend ----------

export async function ensureBackend() {
  const accel = await detectAccel();
  await ensureBackendFor(backendDir, manifestPath, accel);
}

// ---------- model ----------

export async function listModels() {
  try {
    const entries = await fsp.readdir(modelDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".gguf"))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export async function isValidModel(name) {
  return (await listModels()).includes(name);
}

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

  const child = spawn(bin, args, { stdio: ["ignore", "inherit", "inherit"] });
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
    await new Promise((r) => setTimeout(r, pause));

    try {
      child = await runLlama();
      await waitForReady();
    } catch (err) {
      console.log("gagal menyalakan ulang:", err.message);
      continue;
    }
  }
}

export async function startEngine() {
  let child;
  try {
    child = await runLlama();
  } catch (err) {
    console.log("gagal menjalankan mesin:", err.message);
    return;
  }

  console.log("menunggu mesin siap...");
  try {
    await waitForReady();
  } catch (err) {
    console.log("mesin tidak siap:", err.message);
    shutdown(child);
    return;
  }
  console.log("mesin siap dengan model:", activeModel);

  monitor(child);
}

export function getProcess() {
  return proc;
}

// ---------- download model ----------

function safeFilename(rawUrl, exts) {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("hanya http/https yang didukung");
  const name = path.basename(u.pathname);
  if (!name || name === "." || name === "/") throw new Error("nama file tidak bisa ditentukan dari URL");
  if (name.includes("/") || name.includes("\\") || name === "..") throw new Error("nama file tidak valid");
  const lower = name.toLowerCase();
  if (!exts.some((e) => lower.endsWith(e))) throw new Error(`hanya file ${exts.join("/")} yang didukung`);
  return name;
}

async function isGGUF(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    return buf.toString("utf8") === "GGUF";
  } finally {
    await fh.close();
  }
}

async function downloadAndValidate(rawUrl, targetDir, exts, validate, signal) {
  const name = safeFilename(rawUrl, exts);
  const final = path.join(targetDir, name);
  const tmp = final + ".part";
  await downloadWithResume(rawUrl, tmp, signal);
  if (!(await validate(tmp))) {
    await fsp.rm(tmp, { force: true });
    throw new Error("file yang diunduh bukan model yang valid");
  }
  await fsp.rename(tmp, final);
  return name;
}

export async function startModelDownload(rawUrl, projectorUrl) {
  if (dlBusy) throw new Error("masih ada unduhan berjalan");

  const name = safeFilename(rawUrl, [".gguf"]);
  const final = path.join(modelDir, name);
  if (fs.existsSync(final)) throw new Error(`model "${name}" sudah ada`);

  const controller = new AbortController();
  dlAbort = controller;
  dlBusy = true;
  setProgress({ active: true, label: `Mengunduh ${name}` });

  (async () => {
    try {
      await fsp.mkdir(modelDir, { recursive: true });
      await downloadAndValidate(rawUrl, modelDir, [".gguf"], isGGUF, controller.signal);
      console.log("model terunduh:", name);

      if (projectorUrl) {
        setProgress({ active: true, label: `Mengunduh proyektor untuk ${name}` });
        const projName = await downloadAndValidate(projectorUrl, modelDir, [".gguf"], isGGUF, controller.signal);
        await fsp.writeFile(final + ".mmproj", projName, "utf8");
        console.log("proyektor terunduh:", projName);
      }

      setProgress({ done: true, percent: 100, label: `${name} siap` });
    } catch (err) {
      setProgress({ done: true, error: err.message, label: name });
    } finally {
      dlBusy = false;
      dlAbort = null;
    }
  })();
}

export function cancelDownload() {
  if (!dlAbort) return false;
  dlAbort.abort();
  return true;
}

async function removeProjectorSidecar(dir, model) {
  const sidecar = path.join(dir, model) + ".mmproj";
  try {
    const projName = (await fsp.readFile(sidecar, "utf8")).trim();
    if (projName) await fsp.rm(path.join(dir, projName), { force: true });
  } catch {
    // tidak ada sidecar, tidak apa-apa
  }
  await fsp.rm(sidecar, { force: true });
}

export async function deleteModel(name) {
  if (name === activeModel) {
    shutdown(proc);
    activeModel = "";
  }
  await fsp.rm(path.join(modelDir, name), { force: true });
  await removeProjectorSidecar(modelDir, name);
}

export async function loadCatalog() {
  const raw = await fsp.readFile(catalogPath, "utf8");
  return JSON.parse(raw);
}
