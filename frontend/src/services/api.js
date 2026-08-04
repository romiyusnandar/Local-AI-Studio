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

// kind: "llm" | "tts" | "stt" | "img" -> base path API.
const BASE = { llm: "/api", stt: "/api/stt", tts: "/api/tts", img: "/api/img" };

export const Api = {
  status: (kind = "llm") => j(`${BASE[kind]}/status`),
  models: (kind = "llm") => j(`${BASE[kind]}/models`),
  catalog: (kind = "llm") => j(`${BASE[kind]}/catalog`),
  selectModel: (kind, model) => post(`${BASE[kind]}/models/select`, { model }),
  downloadModel: (kind, url, projectorUrl) => post(`${BASE[kind]}/models/download`, projectorUrl ? { url, projectorUrl } : { url }),
  cancelDownload: (kind = "llm") => post(`${BASE[kind]}/models/cancel`),
  deleteModel: (kind, model) => post(`${BASE[kind]}/models/delete`, { model }),
  progress: () => j("/api/progress"),
  perf: () => j("/api/perf"),

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

  ttsVoices: () => j("/api/tts/voices"),

  async speak(text, voice, speed) {
    const res = await fetch("/api/tts/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, speed }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error((body && body.error) || `mesin TTS gagal (${res.status})`);
    }
    return res.blob();
  },

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
