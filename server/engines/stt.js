import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ensureBackendFor, detectAccel } from "../lib/backend-manager.js";
import {
  listModelsIn,
  isValidModelIn,
  startModelDownload as startModelDownloadIn,
  deleteModelIn,
  loadCatalog as loadCatalogFrom,
  isWhisperModel,
} from "../lib/models.js";
import { cancelDownload as cancelDownloadShared, isDownloadActive } from "../lib/download-state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

export const modelDir = path.join(ROOT, "app", "stt-models");
export const backendDir = path.join(ROOT, "app", "stt-backend");
const manifestPath = path.join(ROOT, "manifests", "stt_backends.json");
const catalogPath = path.join(ROOT, "manifests", "stt_models.json");
const MODEL_EXTS = [".bin"];

let activeModel = "";

export function getActiveModel() {
  return activeModel;
}
export function setActiveModel(name) {
  activeModel = name;
}
export { isDownloadActive };

export async function status() {
  return { mesinHidup: await isReady(), model: activeModel };
}

// selectModel: STT tidak punya proses persisten untuk di-restart (spawn
// per-request), jadi cukup ganti model aktifnya saja.
export async function selectModel(model) {
  activeModel = model;
}

export async function ensureBackend() {
  // whisper.cpp belum ada rilis Vulkan resmi — CPU saja untuk sekarang.
  await ensureBackendFor(backendDir, manifestPath, "cpu");
}

export const listModels = () => listModelsIn(modelDir, MODEL_EXTS);
export const isValidModel = (name) => isValidModelIn(modelDir, MODEL_EXTS, name);
export const loadCatalog = () => loadCatalogFrom(catalogPath);
export const cancelDownload = cancelDownloadShared;

export function startModelDownload(rawUrl) {
  return startModelDownloadIn(rawUrl, modelDir, MODEL_EXTS, isWhisperModel);
}

export async function deleteModel(name) {
  if (name === activeModel) activeModel = "";
  await deleteModelIn(modelDir, name);
}

// isReady: STT tidak punya proses persisten (spawn per-request lewat
// whisper-cli), jadi "siap" cukup berarti ada model aktif dan backend-nya
// terpasang — bukan status proses yang sedang berjalan.
export async function isReady() {
  if (!activeModel) return false;
  try {
    await fsp.access(path.join(modelDir, activeModel));
    await fsp.access(binPath());
    return true;
  } catch {
    return false;
  }
}

function binPath() {
  return path.join(backendDir, process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli");
}

// transcribe menjalankan whisper-cli sekali untuk satu file audio (bukan
// server persisten), sesuai pola referensi. File audio & hasil JSON ditulis
// ke folder temp OS lalu dibersihkan setelah selesai.
export async function transcribe(audioBuffer, originalName) {
  if (!(await isReady())) throw new Error("mesin STT sedang mati");

  const ext = path.extname(originalName || "") || ".wav";
  const id = crypto.randomBytes(8).toString("hex");
  const inputPath = path.join(os.tmpdir(), `stt-in-${id}${ext}`);
  const outputBase = path.join(os.tmpdir(), `stt-out-${id}`);

  await fsp.writeFile(inputPath, audioBuffer);

  try {
    await new Promise((resolve, reject) => {
      execFile(
        binPath(),
        [
          "-m", path.join(modelDir, activeModel),
          "-f", inputPath,
          "-l", "auto",
          "-nt",
          "-np",
          "-oj",
          "-of", outputBase,
        ],
        { timeout: 120000 },
        (err) => (err ? reject(err) : resolve())
      );
    });

    const json = JSON.parse(await fsp.readFile(outputBase + ".json", "utf8"));
    const text = (json.transcription || []).map((seg) => seg.text).join("").trim();
    return { text };
  } finally {
    await fsp.rm(inputPath, { force: true });
    await fsp.rm(outputBase + ".json", { force: true });
  }
}
