// Piper TTS: engine TTS kedua (selain Kokoro) untuk bahasa yang tidak
// didukung Kokoro — khususnya Bahasa Indonesia. Piper adalah TTS neural cepat
// berbasis ONNX (github.com/rhasspy/piper). Tiap "voice" = pasangan file
// .onnx + .onnx.json. Binary piper diunduh per-OS.
//
// Berbeda dari backend lain (llama/sd/whisper) yang ekstraksinya diratakan,
// Piper HARUS mempertahankan folder espeak-ng-data/ di samping binary-nya,
// jadi ekstraksinya khusus (mempertahankan struktur, hanya membuang folder
// pembungkus "piper/").

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import AdmZip from "adm-zip";
import * as tar from "tar";
import { loadManifest, pickBackend, detectAccel } from "./backend-manager.js";
import { downloadWithResume } from "./download.js";
import { setProgress } from "./progress.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");

export const backendDir = path.join(ROOT, "app", "tts-piper-backend");
const manifestPath = path.join(ROOT, "manifests", "tts_piper_backends.json");

function binName() {
  return process.platform === "win32" ? "piper.exe" : "piper";
}

export function binPath() {
  return path.join(backendDir, binName());
}

function versionFile() {
  return path.join(backendDir, ".version");
}

async function isInstalled(version) {
  try {
    await fsp.access(binPath());
    const raw = (await fsp.readFile(versionFile(), "utf8")).trim();
    return raw === version;
  } catch {
    return false;
  }
}

// extractPreserving mengekstrak zip/tar.gz dengan MEMPERTAHANKAN struktur
// folder (beda dari extractZipFlat di backend-manager), sambil membuang satu
// folder pembungkus teratas ("piper/") dan mencegah zip-slip.
function extractZipPreserving(zipPath, destDir, stripPrefix) {
  const zip = new AdmZip(zipPath);
  const absDest = path.resolve(destDir);
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    let name = entry.entryName.replace(/\\/g, "/");
    if (stripPrefix && name.startsWith(stripPrefix)) name = name.slice(stripPrefix.length);
    if (!name) continue;
    const target = path.join(absDest, name);
    if (target !== absDest && !target.startsWith(absDest + path.sep)) {
      throw new Error(`isi zip mencurigakan: ${entry.entryName}`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.getData());
  }
}

async function extractTarGzPreserving(tarPath, destDir) {
  await tar.x({ file: tarPath, cwd: path.resolve(destDir), strip: 1 }); // strip folder "piper/"
}

// ensureBackend memasang binary Piper kalau belum ada.
export async function ensureBackend() {
  const manifest = await loadManifest(manifestPath);
  const accel = await detectAccel();
  // Piper hanya rilis CPU; pickBackend akan mundur ke entri cpu.
  const entry = pickBackend(manifest, accel === "metal" ? "cpu" : "cpu");

  if (await isInstalled(manifest.version)) {
    console.log(`backend Piper sudah ada: ${manifest.version}`);
    return;
  }

  console.log(`mengunduh backend Piper ${manifest.version}...`);
  setProgress({ active: true, label: "Mengunduh binary Piper" });

  await fsp.rm(backendDir, { recursive: true, force: true });
  await fsp.mkdir(backendDir, { recursive: true });

  const tmp = path.join(ROOT, "app", "piper-backend.download.part");
  await downloadWithResume(entry.url, tmp, undefined);

  setProgress({ active: true, label: "Mengekstrak Piper...", percent: 100 });
  if (entry.url.toLowerCase().endsWith(".zip")) {
    extractZipPreserving(tmp, backendDir, "piper/");
  } else {
    await extractTarGzPreserving(tmp, backendDir);
  }
  await fsp.rm(tmp, { force: true });

  if (process.platform !== "win32") {
    await fsp.chmod(binPath(), 0o755).catch(() => {});
  }
  await fsp.writeFile(versionFile(), manifest.version, "utf8");
  console.log("backend Piper siap");
}

// speak menjalankan piper untuk satu utterance: teks lewat stdin → WAV.
// espeak-ng-data diarahkan eksplisit ke folder backend agar tidak bergantung
// pada cwd/lokasi default.
export async function speak(onnxPath, text, outPath, speaker) {
  await fsp.access(binPath()).catch(() => {
    throw new Error("binary Piper belum terpasang");
  });

  const espeakData = path.join(backendDir, "espeak-ng-data");
  const args = ["--model", onnxPath, "--output_file", outPath, "--espeak_data", espeakData];
  if (speaker !== undefined && speaker !== null) args.push("--speaker", String(speaker));

  await new Promise((resolve, reject) => {
    const child = execFile(
      binPath(),
      args,
      { timeout: 120000, cwd: backendDir, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve();
      }
    );
    child.stdin.write(text);
    child.stdin.end();
  });
}
