// Pengaturan aplikasi yang bisa diubah pengguna lewat UI (menu Pengaturan)
// dan berlaku LANGSUNG tanpa restart server. Disimpan ke app/config.json.
//
// Nilai sensitif (mis. braveApiKey) tidak pernah dikirim balik utuh ke UI —
// hanya statusnya (tersimpan/belum) lewat getPublic().

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
const configPath = path.join(ROOT, "app", "config.json");

const DEFAULTS = {
  braveApiKey: "",
  imageSize: "512x512",
  thinkingEnabled: true, // aktifkan mode berpikir model (kirim enable_thinking)
  thinkingMode: "show", // saat aktif: "show" = tampilkan alur berpikir; "hide" = sembunyikan
};

let cache = null;

function load() {
  if (cache) return cache;
  try {
    cache = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(configPath, "utf8")) };
  } catch {
    cache = { ...DEFAULTS };
  }
  return cache;
}

// get mengembalikan nilai mentah satu setelan (dipakai internal, mis. untuk
// membaca braveApiKey saat search).
export function get(key) {
  return load()[key];
}

// getPublic: bentuk aman untuk dikirim ke UI — rahasia diganti flag boolean.
export function getPublic() {
  const s = load();
  return {
    braveApiKeySet: Boolean(s.braveApiKey),
    imageSize: s.imageSize,
    thinkingEnabled: s.thinkingEnabled,
    thinkingMode: s.thinkingMode,
  };
}

// update menerima patch sebagian; hanya field yang dikenal yang disimpan.
// braveApiKey === "" berarti menghapus key.
export async function update(patch = {}) {
  const cur = load();
  const next = { ...cur };
  if (typeof patch.braveApiKey === "string") next.braveApiKey = patch.braveApiKey.trim();
  if (typeof patch.imageSize === "string" && /^\d+x\d+$/.test(patch.imageSize)) next.imageSize = patch.imageSize;
  if (typeof patch.thinkingEnabled === "boolean") next.thinkingEnabled = patch.thinkingEnabled;
  if (patch.thinkingMode === "show" || patch.thinkingMode === "hide") next.thinkingMode = patch.thinkingMode;

  cache = next;
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
  return getPublic();
}
