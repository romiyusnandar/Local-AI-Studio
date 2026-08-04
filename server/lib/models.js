import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { downloadWithResume } from "./download.js";
import { setProgress } from "./progress.js";
import { beginDownload, endDownload } from "./download-state.js";

// safeFilename mengambil nama file dari URL dan menolak apa pun yang bisa
// keluar dari folder model.
export function safeFilename(rawUrl, exts) {
  const u = new URL(rawUrl);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("hanya http/https yang didukung");
  const name = path.basename(u.pathname);
  if (!name || name === "." || name === "/") throw new Error("nama file tidak bisa ditentukan dari URL");
  if (name.includes("/") || name.includes("\\") || name === "..") throw new Error("nama file tidak valid");
  const lower = name.toLowerCase();
  if (!exts.some((e) => lower.endsWith(e))) throw new Error(`hanya file ${exts.join("/")} yang didukung`);
  return name;
}

// hasMagic memeriksa byte pertama file. Pengganti murah untuk checksum:
// menangkap kasus paling umum yaitu server mengirim halaman HTML error,
// bukan model.
async function hasMagic(filePath, magic) {
  const fh = await fsp.open(filePath, "r");
  try {
    const buf = Buffer.alloc(magic.length);
    await fh.read(buf, 0, magic.length, 0);
    return buf.toString("utf8") === magic;
  } finally {
    await fh.close();
  }
}

export const isGGUF = (filePath) => hasMagic(filePath, "GGUF");

// isWhisperModel memeriksa magic bytes format ggml ("lmgg") yang dipakai
// model whisper.cpp (ekstensi .bin, beda dari GGUF).
export const isWhisperModel = (filePath) => hasMagic(filePath, "lmgg");

// isSafetensors memvalidasi header safetensors: 8 byte pertama adalah
// panjang header (little-endian), diikuti JSON yang dimulai dengan '{'.
export async function isSafetensors(filePath) {
  const fh = await fsp.open(filePath, "r");
  try {
    const lenBuf = Buffer.alloc(8);
    await fh.read(lenBuf, 0, 8, 0);
    const headerLen = lenBuf.readBigUInt64LE();
    if (headerLen === 0n || headerLen > 100n * 1024n * 1024n) return false;
    const firstByte = Buffer.alloc(1);
    await fh.read(firstByte, 0, 1, 8);
    return firstByte.toString("utf8") === "{";
  } finally {
    await fh.close();
  }
}

// isValidImageModel memilih validator sesuai ekstensi — image gen menerima
// .gguf (magic GGUF) maupun .safetensors (header terstruktur).
export function isValidImageModel(filePath) {
  return filePath.toLowerCase().endsWith(".safetensors") ? isSafetensors(filePath) : isGGUF(filePath);
}

export async function listModelsIn(dir, exts) {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && exts.some((ext) => e.name.toLowerCase().endsWith(ext)))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

export async function isValidModelIn(dir, exts, name) {
  return (await listModelsIn(dir, exts)).includes(name);
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

// startModelDownload mengunduh model utama ke targetDir, lalu kalau
// projectorUrl diisi, mengunduh file vision projector-nya juga dan mencatat
// sidecar "<model>.mmproj" berisi nama file projector — dibaca lagi saat
// model dijalankan (lihat projectorFor di llm.js).
export async function startModelDownload(rawUrl, targetDir, exts, validate, projectorUrl) {
  const name = safeFilename(rawUrl, exts);
  const final = path.join(targetDir, name);
  if (fs.existsSync(final)) throw new Error(`model "${name}" sudah ada`);

  const signal = beginDownload();
  setProgress({ active: true, label: `Mengunduh ${name}` });

  (async () => {
    try {
      await fsp.mkdir(targetDir, { recursive: true });
      await downloadAndValidate(rawUrl, targetDir, exts, validate, signal);
      console.log("model terunduh:", name);

      if (projectorUrl) {
        setProgress({ active: true, label: `Mengunduh proyektor untuk ${name}` });
        const projName = await downloadAndValidate(projectorUrl, targetDir, [".gguf"], isGGUF, signal);
        await fsp.writeFile(final + ".mmproj", projName, "utf8");
        console.log("proyektor terunduh:", projName);
      }

      setProgress({ done: true, percent: 100, label: `${name} siap` });
    } catch (err) {
      setProgress({ done: true, error: err.message, label: name });
    } finally {
      endDownload();
    }
  })();
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

export async function deleteModelIn(dir, name) {
  await fsp.rm(path.join(dir, name), { force: true });
  await removeProjectorSidecar(dir, name);
}

export async function loadCatalog(catalogPath) {
  const raw = await fsp.readFile(catalogPath, "utf8");
  return JSON.parse(raw);
}
