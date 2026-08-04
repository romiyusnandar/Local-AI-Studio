// Worker Kokoro TTS — di-spawn sekali per permintaan sintesis (bukan server
// persisten), sesuai pola referensi (tts-kokoro-worker.mjs). Baca payload
// JSON dari stdin, generate audio, tulis ke file, laporkan hasilnya lewat
// stdout. Isolasi ini mencegah crash/leak di runtime ONNX ikut menjatuhkan
// server utama.

import fs from "node:fs/promises";
import path from "node:path";
import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const payload = JSON.parse(await readStdin());

  // env.cacheDir harus diimpor langsung dari @huggingface/transformers, BUKAN
  // dari kokoro-js — kokoro-js re-export "env" miliknya sendiri yang cuma
  // proxy wasmPaths, cacheDir di situ tidak berpengaruh sama sekali.
  // Defaultnya nyempil di node_modules/@huggingface/transformers/.cache,
  // ikut hilang tiap kali npm install ulang.
  if (payload.cacheDir) {
    env.cacheDir = payload.cacheDir;
  }

  const tts = await KokoroTTS.from_pretrained(payload.modelId, {
    dtype: payload.dtype || "q8",
    device: "cpu",
  });

  const audio = await tts.generate(payload.text, {
    voice: payload.voice || "af_heart",
    speed: Number(payload.speed) || 1,
  });

  await fs.mkdir(path.dirname(payload.output), { recursive: true });
  await audio.save(payload.output);

  process.stdout.write(
    JSON.stringify({
      ok: true,
      output: payload.output,
      sampleRate: audio.sampling_rate || audio.sample_rate || 24000,
    })
  );
}

main().catch((err) => {
  process.stderr.write(err?.stack || err?.message || String(err));
  process.exit(1);
});
