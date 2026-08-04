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

export const Api = {
  status: () => j("/api/status"),
  models: () => j("/api/models"),
  catalog: () => j("/api/catalog"),
  selectModel: (model) => post("/api/models/select", { model }),
  downloadModel: (url, projectorUrl) => post("/api/models/download", { url, projectorUrl }),
  cancelDownload: () => post("/api/models/cancel"),
  deleteModel: (model) => post("/api/models/delete", { model }),
  progress: () => j("/api/progress"),

  chatStream(body, signal) {
    return fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  },
};
