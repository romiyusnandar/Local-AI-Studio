// Lapisan tipis di atas fetch untuk semua endpoint backend Local AI Studio.

async function j(url, opts) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* respons bukan JSON */ }
  if (!res.ok) {
    const msg = (body && body.error) ? body.error : `permintaan gagal (${res.status})`;
    throw new Error(msg);
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

// kind: "llm" | "tts" | "stt" | "img" -> base path API
const BASE = {
  llm: "/api",
  tts: "/api/tts",
  stt: "/api/stt",
  img: "/api/img",
};

export const Api = {
  status: (kind) => j(`${BASE[kind]}/status`),
  models: (kind) => j(kind === "llm" ? "/api/models" : `${BASE[kind]}/models`),
  catalog: (kind) => j(kind === "llm" ? "/api/catalog" : `${BASE[kind]}/catalog`),
  select: (kind, model) => post(kind === "llm" ? "/api/models/select" : `${BASE[kind]}/models/select`, { model }),
  download: (kind, url, projectorUrl) => post(
    kind === "llm" ? "/api/models/download" : `${BASE[kind]}/models/download`,
    projectorUrl ? { url, projectorUrl } : { url },
  ),
  cancelDownload: (kind) => post(kind === "llm" ? "/api/models/cancel" : `${BASE[kind]}/models/cancel`),
  deleteModel: (kind, model) => post(kind === "llm" ? "/api/models/delete" : `${BASE[kind]}/models/delete`, { model }),
  progress: () => j("/api/progress"),
  perf: () => j("/api/perf"),

  // chat: fetch mentah karena responsnya SSE stream, bukan JSON tunggal
  chatStream(body, signal) {
    return fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  },

  // tts: balasan berupa bytes audio/wav
  async speak(text, voice) {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || `mesin TTS gagal (${res.status})`);
    }
    return res.blob();
  },

  // stt: upload multipart, balasan JSON {text}
  async transcribe(blob, filename) {
    const fd = new FormData();
    fd.append("file", blob, filename || "rekaman.wav");
    const res = await fetch("/api/stt/transcribe", { method: "POST", body: fd });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body && body.error) || `mesin STT gagal (${res.status})`);
    return body;
  },

  // image: balasan berupa bytes gambar
  async imgGenerate(payload) {
    const res = await fetch("/api/img/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || `mesin image gen gagal (${res.status})`);
    }
    return res.blob();
  },

  async imgEdit(formData) {
    const res = await fetch("/api/img/edit", { method: "POST", body: formData });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || `mesin image gen gagal (${res.status})`);
    }
    return res.blob();
  },
};
