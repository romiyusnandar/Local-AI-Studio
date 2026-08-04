import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

const workerPath = path.join(__dirname, "..", "workers", "tts-kokoro-worker.mjs");
const cacheDir = path.join(ROOT, "app", "tts-cache");
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const DTYPE = "q8"; // sama seperti default referensi — kualitas cukup, cepat di CPU

export const VOICES = [
  "af_heart", "af_alloy", "af_aoede", "af_bella", "af_jessica", "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah", "af_sky",
  "am_adam", "am_echo", "am_eric", "am_fenrir", "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
  "bf_emma", "bf_isabella", "bf_alice", "bf_lily",
  "bm_george", "bm_lewis", "bm_daniel", "bm_fable",
];

// TTS lewat kokoro-js tidak punya konsep "model terpasang" seperti mesin
// lain — modelnya di-download & di-cache otomatis oleh library begitu
// pertama kali dipakai, jadi selalu dianggap "siap" (permintaan pertama
// cuma akan lebih lambat karena proses unduh berjalan di baliknya).
export async function status() {
  return { mesinHidup: true, model: `Kokoro-82M (${DTYPE})` };
}

// speak men-spawn worker sekali untuk satu permintaan sintesis (bukan
// proses persisten), sesuai pola referensi. Mengembalikan Buffer WAV.
export async function speak(text, voice, speed) {
  if (!text || !text.trim()) throw new Error("teks tidak boleh kosong");

  const id = crypto.randomBytes(8).toString("hex");
  const outputPath = path.join(os.tmpdir(), `tts-out-${id}.wav`);

  const payload = JSON.stringify({
    text,
    voice: voice || "af_heart",
    speed: speed || 1,
    modelId: MODEL_ID,
    dtype: DTYPE,
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
