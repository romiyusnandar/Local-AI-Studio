import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import AdmZip from "adm-zip";
import * as tar from "tar";
import { downloadWithResume } from "./download.js";
import { setProgress } from "./progress.js";

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, ...opts }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

// hasNvidia menandai keberadaan driver NVIDIA. nvidia-smi ikut terpasang
// bersama driver di semua platform, jadi lebih andal daripada mengecek path.
async function hasNvidia() {
  try {
    await execFileP("nvidia-smi", ["-L"]);
    return true;
  } catch {
    return false;
  }
}

// hasVulkan mengecek loader Vulkan lewat tool bawaan SDK, atau keberadaan
// library loader-nya langsung kalau vulkaninfo tidak ada.
async function hasVulkan() {
  try {
    await execFileP("vulkaninfo", ["--summary"]);
    return true;
  } catch {
    // lanjut cek file loader
  }

  const candidates =
    process.platform === "win32"
      ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vulkan-1.dll")]
      : ["/usr/lib/x86_64-linux-gnu/libvulkan.so.1", "/usr/lib64/libvulkan.so.1", "/usr/lib/libvulkan.so.1"];

  for (const p of candidates) {
    try {
      await fsp.access(p);
      return true;
    } catch {
      // lanjut ke kandidat berikutnya
    }
  }
  return false;
}

// detectAccel memilih varian backend berdasarkan hardware. Urutannya dari
// tercepat ke paling aman: CUDA -> Vulkan -> CPU.
export async function detectAccel() {
  if (process.platform === "darwin") return "metal";
  if (await hasNvidia()) return "cuda";
  if (await hasVulkan()) return "vulkan";
  return "cpu";
}

function currentOS() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

export async function loadManifest(manifestPath) {
  const raw = await fsp.readFile(manifestPath, "utf8");
  return JSON.parse(raw);
}

// pickBackend memilih entri yang cocok dengan OS dan akselerasi. Kalau
// varian yang diinginkan tidak ada, mundur ke CPU/metal daripada gagal total.
export function pickBackend(manifest, accel) {
  const os = currentOS();
  let fallback = null;
  for (const entry of manifest.backends) {
    if (entry.os !== os) continue;
    if (entry.accel === accel) return entry;
    if (entry.accel === "cpu" || entry.accel === "metal") fallback = entry;
  }
  if (fallback) return fallback;
  throw new Error(`tidak ada backend untuk ${os}`);
}

function versionFileIn(dir) {
  return path.join(dir, ".version");
}

async function backendReadyIn(dir, manifest, entry) {
  try {
    await fsp.access(path.join(dir, entry.entrypoint));
  } catch {
    return false;
  }
  try {
    const raw = (await fsp.readFile(versionFileIn(dir), "utf8")).trim();
    const [version] = raw.split("\n");
    return version === manifest.version;
  } catch {
    return false;
  }
}

export async function installedAccelIn(dir) {
  try {
    const raw = (await fsp.readFile(versionFileIn(dir), "utf8")).trim();
    const parts = raw.split("\n");
    return parts[1] || "";
  } catch {
    return "";
  }
}

// ensureBackendFor memastikan satu varian backend (LLM, TTS, dll) terpasang
// di dir sesuai manifest yang diberikan.
export async function ensureBackendFor(dir, manifestPath, accel) {
  const manifest = await loadManifest(manifestPath);
  const entry = pickBackend(manifest, accel);

  if (await backendReadyIn(dir, manifest, entry)) {
    console.log(`backend sudah ada: ${manifest.version} (${entry.accel})`);
    return;
  }

  await installBackendInto(dir, manifest, entry);
}

// removeAllRetry mengulang penghapusan folder beberapa kali dengan jeda.
// Berguna di Windows saat file masih terkunci sesaat setelah proses
// pemiliknya mati.
async function removeAllRetry(dir, attempts = 5, delayMs = 500) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

// installBackendInto mengunduh dan memasang satu varian backend ke dir.
// Rilis ada yang berupa arsip zip/tar.gz, ada yang langsung berupa
// executable tunggal (mis. koboldcpp nantinya) — semua ditangani di sini.
export async function installBackendInto(dir, manifest, entry) {
  console.log(`mengunduh backend ${manifest.version} (${entry.accel})...`);
  setProgress({ active: true, label: `Mengunduh backend ${manifest.version}` });

  await fsp.mkdir(dir, { recursive: true });
  await removeAllRetry(dir); // bersihkan varian lama biar tidak tercampur

  const urlLower = entry.url.toLowerCase();
  const isZip = urlLower.endsWith(".zip");
  const isTarGz = urlLower.endsWith(".tar.gz") || urlLower.endsWith(".tgz");
  const tmp = path.join(path.dirname(dir), path.basename(dir) + ".download.part");

  try {
    await downloadWithResume(entry.url, tmp, undefined);
  } catch (err) {
    setProgress({ error: err.message, done: true });
    throw err;
  }

  await fsp.mkdir(dir, { recursive: true });

  if (isZip) {
    setProgress({ active: true, label: "Mengekstrak...", percent: 100 });
    extractZipFlat(tmp, dir);
  } else if (isTarGz) {
    setProgress({ active: true, label: "Mengekstrak...", percent: 100 });
    await extractTarGzFlat(tmp, dir);
  } else {
    // Rilis berupa executable tunggal — langsung jadi entrypoint.
    await fsp.rename(tmp, path.join(dir, entry.entrypoint));
  }
  await fsp.rm(tmp, { force: true });

  if (process.platform !== "win32") {
    await fsp.chmod(path.join(dir, entry.entrypoint), 0o755).catch(() => {});
  }

  const stamp = `${manifest.version}\n${entry.accel}`;
  await fsp.writeFile(versionFileIn(dir), stamp, "utf8");

  setProgress({ done: true, percent: 100, label: "Backend siap" });
  console.log("backend siap:", entry.accel);
}

// extractZipFlat meratakan semua file ke satu folder (rilis llama.cpp dkk
// membungkus isinya dalam folder build/bin/), sekaligus mencegah zip-slip
// (entri bernama "../../etc/passwd" bisa menulis di luar folder tujuan).
function extractZipFlat(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const absDest = path.resolve(destDir);

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = path.basename(entry.entryName);
    if (!name) continue;

    const target = path.join(absDest, name);
    if (!target.startsWith(absDest + path.sep)) {
      throw new Error(`isi zip mencurigakan: ${entry.entryName}`);
    }
    fs.writeFileSync(target, entry.getData());
  }
}

async function extractTarGzFlat(tarPath, destDir) {
  const absDest = path.resolve(destDir);
  await tar.x({
    file: tarPath,
    cwd: absDest,
    strip: 0,
    filter: () => true,
    // tar package sudah menolak path traversal ("../") secara default.
    onentry: (entry) => {
      // Ratakan semua file ke root destDir (samakan perilaku dengan extractZipFlat).
      entry.path = path.basename(entry.path);
    },
  });
}
