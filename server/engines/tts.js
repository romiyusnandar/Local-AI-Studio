import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadCatalog as loadCatalogFrom } from "../lib/models.js";
import { setProgress } from "../lib/progress.js";
import { downloadWithResume } from "../lib/download.js";
import {
  beginDownload,
  endDownload,
  isDownloadActive as isDownloadActiveShared,
  cancelDownload as cancelDownloadShared,
} from "../lib/download-state.js";
import * as piper from "../lib/piper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const workerPath = path.join(__dirname, "..", "workers", "tts-kokoro-worker.mjs");
const cacheDir = path.join(ROOT, "app", "tts-cache");
export const modelDir = path.join(ROOT, "app", "tts-models");
const catalogPath = path.join(ROOT, "manifests", "tts_models.json");
const DEFAULT_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

// TTS mendukung dua engine, dipilih lewat Model Manager:
//   - Kokoro (kokoro-js/ONNX): "model" = manifest JSON pemilih dtype; bobot
//     di-cache library. Bahasa Inggris. Meniru TTS_MODEL_CATALOG referensi.
//   - Piper (binary ONNX): "model" = voice .onnx + .onnx.json yang diunduh
//     sungguhan. Dipakai untuk bahasa yang tak didukung Kokoro (mis. Indonesia).
// Tiap manifest terpasang menyimpan field "type" yang menentukan jalur speak().

export const VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  "bm_george", "bm_lewis", "bm_daniel", "bm_fable",
];

let activeModel = "";

export function getActiveModel() {
  return activeModel;
}
export function setActiveModel(name) {
  activeModel = name;
}

// Unduhan Piper (voice ~60MB) memakai lock unduhan bersama supaya bisa
// dibatalkan & tidak bentrok dengan unduhan model lain. Install Kokoro
// seketika, jadi lock tidak relevan untuknya.
export const isDownloadActive = isDownloadActiveShared;
export const cancelDownload = cancelDownloadShared;

export const loadCatalog = () => loadCatalogFrom(catalogPath);

// listModels: manifest .json yang ada di app/tts-models/. File config voice
// Piper ("<voice>.onnx.json") dikecualikan — itu bukan manifest model.
export async function listModels() {
  try {
    const entries = await fsp.readdir(modelDir);
    return entries.filter((e) => {
      const lower = e.toLowerCase();
      return lower.endsWith(".json") && !lower.endsWith(".onnx.json");
    });
  } catch {
    return [];
  }
}

export async function isValidModel(name) {
  return (await listModels()).includes(name);
}

async function readManifest(name) {
  try {
    return JSON.parse(await fsp.readFile(path.join(modelDir, name), "utf8"));
  } catch {
    return null;
  }
}

// status: TTS dianggap "hidup" selama ada model aktif terpasang.
export async function status() {
  const manifest = activeModel ? await readManifest(activeModel) : null;
  let label = activeModel || "";
  if (manifest) {
    label = manifest.type === "piper" ? `${manifest.name || activeModel} · piper` : `${manifest.name || activeModel} · ${manifest.dtype || "q8"}`;
  }
  return { mesinHidup: Boolean(activeModel), model: label };
}

export async function selectModel(name) {
  activeModel = name;
}

// getVoices mengembalikan daftar suara untuk model AKTIF (bukan daftar tetap):
//   - Kokoro: 28 voice bawaan kokoro-js (Inggris US/UK).
//   - Piper multi-speaker: nama-nama speaker dari speaker_id_map.
//   - Piper single-speaker (mis. voice Indonesia news_tts): kosong — memang
//     hanya ada satu suara, jadi tidak ada yang bisa dipilih.
export async function getVoices() {
  const manifest = activeModel ? await readManifest(activeModel) : null;
  if (!manifest || manifest.type !== "piper") {
    return { engine: "kokoro", voices: VOICES };
  }
  try {
    const cfg = JSON.parse(await fsp.readFile(path.join(modelDir, manifest.onnxFile + ".json"), "utf8"));
    if (cfg.num_speakers > 1 && cfg.speaker_id_map) {
      return { engine: "piper", voices: Object.keys(cfg.speaker_id_map) };
    }
  } catch {
    // config tidak terbaca — anggap single-speaker
  }
  return { engine: "piper", voices: [] };
}

// startModelDownload = "install": Kokoro menulis manifest seketika; Piper
// mengunduh voice .onnx/.onnx.json + memastikan binary Piper terpasang, lalu
// menulis manifest. Unduhan Piper berjalan di latar belakang (progress
// dipolling UI) supaya route langsung merespons.
export async function startModelDownload(url) {
  const raw = String(url || "").trim();
  const id = raw.replace(/^(kokoro|piper):\/\/install\//, "");

  const catalog = await loadCatalog();
  const entry = catalog.models.find((m) => m.id === id || m.file === id);
  if (!entry) throw new Error("model TTS tidak dikenal");

  await fsp.mkdir(modelDir, { recursive: true });

  if (entry.type === "piper") {
    await startPiperInstall(entry);
    return;
  }

  // Kokoro — instan.
  const manifest = {
    id: entry.id,
    type: "kokoro",
    name: entry.name,
    file: entry.file,
    modelId: entry.modelId || DEFAULT_MODEL_ID,
    dtype: entry.dtype || "q8",
    installed: true,
    createdAt: new Date().toISOString(),
    note: "Bobot Kokoro di-cache kokoro-js di app/tts-cache saat generate pertama.",
  };
  await fsp.writeFile(path.join(modelDir, entry.file), JSON.stringify(manifest, null, 2), "utf8");
  if (!activeModel) activeModel = entry.file;
  setProgress({ active: false, done: true, percent: 100, label: `${entry.name} terpasang` });
}

function startPiperInstall(entry) {
  if (isDownloadActiveShared()) throw new Error("masih ada unduhan lain berjalan");
  const signal = beginDownload();
  setProgress({ active: true, label: `Menyiapkan ${entry.name}` });

  (async () => {
    try {
      // 1) Binary Piper (per-OS).
      await piper.ensureBackend();

      // 2) Voice .onnx (besar) + .onnx.json (kecil).
      const onnxDest = path.join(modelDir, entry.onnxFile);
      const cfgDest = onnxDest + ".json";
      setProgress({ active: true, label: `Mengunduh voice ${entry.name}` });
      await downloadWithResume(entry.onnxUrl, onnxDest, signal);
      await downloadWithResume(entry.configUrl, cfgDest, signal);

      // 3) Manifest.
      const manifest = {
        id: entry.id,
        type: "piper",
        name: entry.name,
        file: entry.file,
        onnxFile: entry.onnxFile,
        installed: true,
        createdAt: new Date().toISOString(),
        note: "Voice Piper (.onnx) tersimpan di app/tts-models.",
      };
      await fsp.writeFile(path.join(modelDir, entry.file), JSON.stringify(manifest, null, 2), "utf8");
      if (!activeModel) activeModel = entry.file;

      setProgress({ done: true, percent: 100, label: `${entry.name} terpasang` });
    } catch (err) {
      setProgress({ done: true, error: err.message, label: entry.name });
    } finally {
      endDownload();
    }
  })();
}

export async function deleteModel(name) {
  const manifest = await readManifest(name);
  await fsp.rm(path.join(modelDir, name), { force: true });
  // Piper: hapus juga file voice-nya.
  if (manifest?.type === "piper" && manifest.onnxFile) {
    await fsp.rm(path.join(modelDir, manifest.onnxFile), { force: true });
    await fsp.rm(path.join(modelDir, manifest.onnxFile + ".json"), { force: true });
  }
  if (name === activeModel) {
    const rest = await listModels();
    activeModel = rest[0] || "";
  }
}

// ensureDefaultModel memasang varian Kokoro rekomendasi (Q8) kalau belum ada
// model TTS sama sekali, supaya TTS langsung bisa dipakai out-of-box.
export async function ensureDefaultModel() {
  const installed = await listModels();
  if (installed.length > 0) {
    activeModel = installed.includes("kokoro-onnx-q8.json") ? "kokoro-onnx-q8.json" : installed[0];
    return;
  }
  try {
    const catalog = await loadCatalog();
    const rec = catalog.models.find((m) => m.recommended) || catalog.models[0];
    if (rec) await startModelDownload(rec.url);
  } catch (err) {
    console.log("gagal memasang model TTS default:", err.message);
  }
}

// ---------- sintesis ----------

export async function speak(text, voice, speed) {
  if (!text || !text.trim()) throw new Error("teks tidak boleh kosong");

  const manifest = activeModel ? await readManifest(activeModel) : null;
  if (!manifest) throw new Error("belum ada model TTS terpasang — pasang di Model Manager");

  return manifest.type === "piper" ? speakPiper(manifest, text, voice) : speakKokoro(manifest, text, voice, speed);
}

async function speakPiper(manifest, text, voice) {
  const onnxPath = path.join(modelDir, manifest.onnxFile);
  if (!fs.existsSync(onnxPath)) throw new Error("file voice Piper tidak ditemukan — pasang ulang model");

  // Voice multi-speaker: petakan nama speaker ke id-nya untuk flag --speaker.
  let speaker;
  if (voice) {
    try {
      const cfg = JSON.parse(await fsp.readFile(onnxPath + ".json", "utf8"));
      if (cfg.num_speakers > 1 && cfg.speaker_id_map && voice in cfg.speaker_id_map) {
        speaker = cfg.speaker_id_map[voice];
      }
    } catch {
      // config tidak terbaca — pakai speaker default
    }
  }

  const id = crypto.randomBytes(8).toString("hex");
  const outputPath = path.join(os.tmpdir(), `tts-piper-${id}.wav`);
  try {
    await piper.speak(onnxPath, text, outputPath, speaker);
    return await fsp.readFile(outputPath);
  } finally {
    await fsp.rm(outputPath, { force: true });
  }
}

async function speakKokoro(manifest, text, voice, speed) {
  const id = crypto.randomBytes(8).toString("hex");
  const outputPath = path.join(os.tmpdir(), `tts-out-${id}.wav`);

  const payload = JSON.stringify({
    text,
    voice: voice || "af_heart",
    speed: speed || 1,
    modelId: manifest.modelId || DEFAULT_MODEL_ID,
    dtype: manifest.dtype || "q8",
    cacheDir,
    output: outputPath,
  });

  await new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [workerPath],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        try {
          const result = JSON.parse(stdout);
          if (!result.ok) return reject(new Error("worker TTS gagal"));
          resolve();
        } catch {
          reject(new Error("respons worker TTS tidak dikenal"));
        }
      }
    );
    child.stdin.write(payload);
    child.stdin.end();
  });

  try {
    return await fsp.readFile(outputPath);
  } finally {
    await fsp.rm(outputPath, { force: true });
  }
}
