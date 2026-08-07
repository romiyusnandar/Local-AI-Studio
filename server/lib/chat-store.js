// Penyimpanan riwayat chat: satu file JSON per percakapan di app/chats/,
// mengikuti pola sidecar JSON milik histori gambar (app/outputs/*.json).
// Sengaja TIDAK memakai SQLite/dependensi eksternal — cukup file JSON lokal,
// konsisten dengan sisa backend yang vanilla.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..", "..");
export const chatsDir = path.join(ROOT, "app", "chats");

// ID chat dibuat klien (crypto.randomUUID). Divalidasi ketat sebelum dipakai
// menyusun nama file, supaya tidak bisa keluar dari folder (path traversal).
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

function fileFor(id) {
  if (!SAFE_ID.test(id || "")) throw new Error("id chat tidak valid");
  return path.join(chatsDir, `chat-${id}.json`);
}

// deriveTitle mengambil judul dari pesan user pertama (dipangkas). Dipakai saat
// klien tidak mengirim title eksplisit.
function deriveTitle(messages) {
  const firstUser = Array.isArray(messages) ? messages.find((m) => m.role === "user") : null;
  const text = (typeof firstUser?.content === "string" ? firstUser.content : "").trim().replace(/\s+/g, " ");
  if (!text) return "Chat baru";
  return text.length > 60 ? text.slice(0, 60) + "…" : text;
}

// previewOf: cuplikan singkat (jawaban asisten terakhir, atau pesan berisi
// terakhir) untuk ditampilkan di kartu daftar riwayat.
function previewOf(messages) {
  if (!Array.isArray(messages)) return "";
  const rev = [...messages].reverse();
  const src = rev.find((m) => m.role === "assistant" && m.content) || rev.find((m) => m.content);
  const t = (src?.content || "").toString().trim().replace(/\s+/g, " ");
  return t.length > 140 ? t.slice(0, 140) + "…" : t;
}

// listChats: metadata semua chat (tanpa isi pesan penuh), terbaru dulu.
export async function listChats() {
  let names = [];
  try {
    names = await fs.readdir(chatsDir);
  } catch {
    return []; // folder belum ada — belum ada chat
  }
  const items = [];
  for (const name of names) {
    if (!name.startsWith("chat-") || !name.endsWith(".json")) continue;
    try {
      const c = JSON.parse(await fs.readFile(path.join(chatsDir, name), "utf8"));
      if (!c.id) continue;
      items.push({
        id: c.id,
        title: c.title || "Chat baru",
        createdAt: c.createdAt || 0,
        updatedAt: c.updatedAt || c.createdAt || 0,
        messageCount: Array.isArray(c.messages) ? c.messages.length : 0,
        tokens: c.tokens || 0,
        preview: previewOf(c.messages),
      });
    } catch {
      // file rusak/terpotong — lewati agar daftar tetap tampil
    }
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

// getChat: satu percakapan lengkap (dengan messages), atau null bila tak ada.
export async function getChat(id) {
  try {
    return JSON.parse(await fs.readFile(fileFor(id), "utf8"));
  } catch {
    return null;
  }
}

// saveChat: upsert. createdAt dipertahankan dari file lama; updatedAt = sekarang.
export async function saveChat({ id, messages, title, tokens }) {
  if (!SAFE_ID.test(id || "")) throw new Error("id chat tidak valid");
  if (!Array.isArray(messages)) throw new Error("messages harus array");
  await fs.mkdir(chatsDir, { recursive: true });
  const existing = await getChat(id);
  const now = Date.now();
  const chat = {
    id,
    title: (title && title.trim()) || deriveTitle(messages),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    // Total token kumulatif percakapan. Kalau klien tidak mengirim (mis. save
    // parsial), pertahankan nilai lama supaya tidak ter-reset ke 0.
    tokens: Number.isFinite(tokens) ? tokens : existing?.tokens || 0,
    messages,
  };
  await fs.writeFile(fileFor(id), JSON.stringify(chat), "utf8");
  return { id: chat.id, title: chat.title, createdAt: chat.createdAt, updatedAt: chat.updatedAt, tokens: chat.tokens };
}

// deleteChat: hapus satu file chat (idempoten).
export async function deleteChat(id) {
  await fs.rm(fileFor(id), { force: true });
}
