// makeEngineRoutes menghasilkan handler HTTP standar (status/models/select/
// catalog/download/cancel/delete) dari satu "engine" — dipakai ulang oleh
// LLM, STT, dan mesin-mesin berikutnya supaya tidak duplikasi logic yang
// sama persis di tiap engine. Engine cukup menyediakan:
//   listModels(), isValidModel(name), getActiveModel(), loadCatalog(),
//   startModelDownload(url, projectorUrl?), cancelDownload(), deleteModel(name),
//   status() -> {mesinHidup, model}, selectModel(name)

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

export function makeEngineRoutes(engine) {
  return {
    async status(req, res) {
      sendJson(res, 200, await engine.status());
    },

    async models(req, res) {
      const models = await engine.listModels();
      const cur = await engine.status();
      sendJson(res, 200, { models, active: engine.getActiveModel(), ready: cur.mesinHidup });
    },

    async select(req, res) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "permintaan tidak valid" });
      }
      if (!(await engine.isValidModel(body.model))) {
        return sendJson(res, 400, { error: "model tidak ditemukan" });
      }
      const cur = await engine.status();
      if (body.model === cur.model && cur.mesinHidup) {
        return sendJson(res, 200, { ok: true, model: body.model, note: "sudah aktif" });
      }
      await engine.selectModel(body.model);
      sendJson(res, 200, { ok: true, model: body.model });
    },

    async catalog(req, res) {
      try {
        const catalog = await engine.loadCatalog();
        const installed = new Set(await engine.listModels());
        const models = catalog.models.map((m) => ({ ...m, installed: installed.has(m.file) }));
        sendJson(res, 200, { models });
      } catch {
        sendJson(res, 500, { error: "katalog rusak" });
      }
    },

    async download(req, res) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "permintaan tidak valid" });
      }
      try {
        await engine.startModelDownload(body.url, body.projectorUrl);
        sendJson(res, 200, { ok: true });
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    },

    async cancel(req, res) {
      sendJson(res, 200, { ok: engine.cancelDownload() });
    },

    async delete(req, res) {
      if (req.method !== "POST") return sendJson(res, 405, { error: "gunakan POST" });
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { error: "permintaan tidak valid" });
      }
      if (!(await engine.isValidModel(body.model))) {
        return sendJson(res, 400, { error: "model tidak ditemukan" });
      }
      try {
        await engine.deleteModel(body.model);
        sendJson(res, 200, { ok: true });
      } catch {
        sendJson(res, 500, { error: "gagal menghapus" });
      }
    },
  };
}

export { sendJson, readJsonBody };
