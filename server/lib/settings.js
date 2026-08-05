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
  contextSizeDefault: 4096, // n_ctx dipakai saat model tak punya override
  contextSizes: {}, // override per-model: { [namaFileModel]: n_ctx (token) }
};

// Batas n_ctx yang wajar: minimum masih berguna, maksimum menahan pengguna
// tak sengaja minta context raksasa yang bikin kehabisan RAM/VRAM.
const CTX_MIN = 512;
const CTX_MAX = 131072;
const clampCtx = (v) => Math.min(CTX_MAX, Math.max(CTX_MIN, Math.round(v)));

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
    contextSizeDefault: s.contextSizeDefault,
    contextSizes: { ...s.contextSizes },
  };
}

// contextForModel: n_ctx efektif untuk satu model — override per-model kalau
// ada, kalau tidak pakai default. Dipakai llm.js saat menyalakan llama-server.
export function contextForModel(modelFile) {
  const s = load();
  const v = s.contextSizes?.[modelFile];
  return Number.isFinite(v) && v > 0 ? v : s.contextSizeDefault;
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

  if (Number.isFinite(patch.contextSizeDefault)) next.contextSizeDefault = clampCtx(patch.contextSizeDefault);

  // contextSizes patch bersifat merge: { file: angka } menyetel/override,
  // { file: 0 } atau null menghapus override (kembali ke default).
  if (patch.contextSizes && typeof patch.contextSizes === "object") {
    const map = { ...next.contextSizes };
    for (const [file, val] of Object.entries(patch.contextSizes)) {
      const n = Number(val);
      if (!val || n === 0) delete map[file];
      else if (Number.isFinite(n)) map[file] = clampCtx(n);
    }
    next.contextSizes = map;
  }

  cache = next;
  await fsp.mkdir(path.dirname(configPath), { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify(next, null, 2), "utf8");
  return getPublic();
}
