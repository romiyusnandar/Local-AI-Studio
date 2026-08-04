// Lapisan tipis di atas fetch untuk endpoint backend Local AI Studio.

async function j(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try {
    body = await res.json();
  } catch {
    // respons bukan JSON
  }
  if (!res.ok) {
    throw new Error((body && body.error) || `permintaan gagal (${res.status})`);
  }
  return body;
}

function post(url, payload) {
  return j(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

// kind: "llm" | "tts" | "stt" | "img" -> base path API. "tts"/"img" ditambah
// begitu fase-nya dikerjakan (tanpa perlu ubah kode di sini lagi, cukup
// tambah entri).
const BASE = { llm: "/api", stt: "/api/stt" };

export const Api = {
  status: (kind = "llm") => j(`${BASE[kind]}/status`),
  models: (kind = "llm") => j(`${BASE[kind]}/models`),
  catalog: (kind = "llm") => j(`${BASE[kind]}/catalog`),
  selectModel: (kind, model) => post(`${BASE[kind]}/models/select`, { model }),
  downloadModel: (kind, url, projectorUrl) => post(`${BASE[kind]}/models/download`, projectorUrl ? { url, projectorUrl } : { url }),
  cancelDownload: (kind = "llm") => post(`${BASE[kind]}/models/cancel`),
  deleteModel: (kind, model) => post(`${BASE[kind]}/models/delete`, { model }),
  progress: () => j("/api/progress"),

  chatStream(body, signal) {
    return fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  },

  async transcribe(blob, filename) {
    const fd = new FormData();
    fd.append("file", blob, filename || "rekaman.wav");
    const res = await fetch("/api/stt/transcribe", { method: "POST", body: fd });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `mesin STT gagal (${res.status})`);
    return body;
  },
};
