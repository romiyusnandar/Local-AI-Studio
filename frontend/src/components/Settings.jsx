import { useEffect, useState } from "react";
import { MessageSquare, Image as ImageIcon, Key, Check, Trash2, ExternalLink } from "lucide-react";
import { Api } from "../services/api.js";
import "./Settings.css";

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [chatModels, setChatModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [ctxDraft, setCtxDraft] = useState({});
  const [ctxLimits, setCtxLimits] = useState({});

  useEffect(() => {
    Api.getSettings().then(setSettings).catch(() => {});
    Api.models("llm")
      .then((d) => {
        setChatModels(d.models || []);
        setActiveModel(d.active || "");
      })
      .catch(() => {});
    Api.ctxLimits()
      .then((d) => setCtxLimits(d.limits || {}))
      .catch(() => {});
  }, []);

  // Seed input context dari setelan tersimpan (dan setiap kali setelan/model
  // berubah). Field default selalu ada; per-model kosong = pakai default.
  useEffect(() => {
    if (!settings) return;
    const d = { __default: String(settings.contextSizeDefault ?? 4096) };
    for (const f of chatModels) d[f] = settings.contextSizes?.[f] ? String(settings.contextSizes[f]) : "";
    setCtxDraft(d);
  }, [settings, chatModels]);

  function flashSaved() {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      setSettings(await Api.updateSettings({ braveApiKey: key }));
      setKeyInput("");
      flashSaved();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingKey(false);
    }
  }

  async function deleteKey() {
    if (!confirm("Hapus Brave API key?")) return;
    try {
      setSettings(await Api.updateSettings({ braveApiKey: "" }));
    } catch (err) {
      alert(err.message);
    }
  }

  async function changeImageSize(size) {
    try {
      setSettings(await Api.updateSettings({ imageSize: size }));
      flashSaved();
    } catch (err) {
      alert(err.message);
    }
  }

  async function patchSettings(patch) {
    try {
      setSettings(await Api.updateSettings(patch));
      flashSaved();
    } catch (err) {
      alert(err.message);
    }
  }

  const setDraft = (key, v) => setCtxDraft((d) => ({ ...d, [key]: v }));

  function commitDefaultCtx() {
    const v = parseInt(ctxDraft.__default, 10);
    if (Number.isFinite(v) && v !== settings.contextSizeDefault) patchSettings({ contextSizeDefault: v });
  }

  function commitModelCtx(file) {
    const raw = ctxDraft[file];
    let v = raw === "" || raw == null ? 0 : parseInt(raw, 10);
    if (!Number.isFinite(v)) v = 0;
    // Jangan biarkan melebihi context latih model (n_ctx_train).
    const limit = ctxLimits[file];
    if (limit && v > limit) {
      v = limit;
      setDraft(file, String(limit));
    }
    const cur = settings.contextSizes?.[file] || 0;
    if (v !== cur) patchSettings({ contextSizes: { [file]: v } });
  }

  return (
    <div className="settings-panel">
      <div className="panel-head">
        <div>
          <h1>Pengaturan</h1>
          <div className="status-line">
            <span>Setelan tiap mesin — berlaku langsung, tersimpan otomatis</span>
          </div>
        </div>
        {savedFlash && (
          <span className="settings-saved">
            <Check size={14} /> Tersimpan
          </span>
        )}
      </div>

      <div className="settings-body">
        {!settings ? (
          <div className="settings-loading">Memuat pengaturan&hellip;</div>
        ) : (
          <>
            {/* ---- Chat ---- */}
            <section className="settings-section">
              <div className="settings-section-title">
                <MessageSquare size={15} />
                <span>Chat</span>
              </div>

              <div className="settings-field">
                <label className="label">Brave Search API Key</label>
                <p className="settings-help">
                  Opsional. Kalau diisi, mode web di Chat memakai API resmi Brave — jauh lebih andal (tanpa risiko rate-limit).
                  Tanpa key, pencarian tetap jalan lewat scraping. Key gratis 2.000 kueri/bulan.{" "}
                  <a href="https://api-dashboard.search.brave.com/register" target="_blank" rel="noreferrer">
                    Dapatkan key <ExternalLink size={11} />
                  </a>
                </p>

                {settings.braveApiKeySet ? (
                  <div className="key-status">
                    <span className="key-status-badge">
                      <Key size={13} /> Key tersimpan
                    </span>
                    <button className="btn-sm btn-danger" onClick={deleteKey}>
                      <Trash2 size={14} />
                      <span>Hapus</span>
                    </button>
                  </div>
                ) : (
                  <div className="key-input-row">
                    <input
                      type="password"
                      placeholder="Tempel Brave API key di sini…"
                      value={keyInput}
                      onChange={(e) => setKeyInput(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && saveKey()}
                    />
                    <button className="btn-primary" onClick={saveKey} disabled={savingKey || !keyInput.trim()}>
                      <span>{savingKey ? "Menyimpan…" : "Simpan"}</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="settings-field">
                <label className="label">Mode berpikir model</label>
                <p className="settings-help">
                  Untuk model reasoning (mis. Qwen3, DeepSeek-R1). <b>Aktif</b>: model diminta berpikir dulu sebelum
                  menjawab. <b>Nonaktif</b>: model diminta langsung menjawab tanpa berpikir.
                </p>
                <div className="toggle-row">
                  <button
                    type="button"
                    className={`toggle${settings.thinkingEnabled ? " on" : ""}`}
                    onClick={() => patchSettings({ thinkingEnabled: !settings.thinkingEnabled })}
                    aria-pressed={settings.thinkingEnabled}
                  >
                    <span className="toggle-knob" />
                  </button>
                  <span className="toggle-label">{settings.thinkingEnabled ? "Aktif" : "Nonaktif"}</span>
                </div>
              </div>

              {settings.thinkingEnabled && (
                <div className="settings-field">
                  <label className="label">Tampilan alur berpikir</label>
                  <p className="settings-help">
                    <b>Tampilkan</b>: alur berpikir muncul live + jumlah token, lalu tersimpan sebagai bagian yang bisa
                    dibuka; jawaban final di bawahnya. <b>Sembunyikan</b>: hanya "berpikir…" + jumlah token, lalu jawaban
                    final.
                  </p>
                  <select
                    className="settings-select"
                    value={settings.thinkingMode}
                    onChange={(e) => patchSettings({ thinkingMode: e.target.value })}
                  >
                    <option value="show">Tampilkan alur berpikir</option>
                    <option value="hide">Sembunyikan (hanya "berpikir…")</option>
                  </select>
                </div>
              )}

              <div className="settings-field">
                <label className="label">Context window (n_ctx)</label>
                <p className="settings-help">
                  Jumlah token maksimum yang muat dalam satu percakapan (prompt + riwayat + balasan). Model untuk coding
                  butuh context besar (mis. 8192–32768). Makin besar makin banyak RAM/VRAM terpakai, dan dibatasi context
                  maksimum yang dilatih model. Mengubah nilai model yang <b>sedang aktif</b> akan me-restart mesin sebentar.
                </p>

                <div className="ctx-row">
                  <span className="ctx-label ctx-default">Default (semua model)</span>
                  <input
                    type="number"
                    min={512}
                    step={512}
                    className="ctx-input"
                    value={ctxDraft.__default ?? ""}
                    onChange={(e) => setDraft("__default", e.target.value)}
                    onBlur={commitDefaultCtx}
                    onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                  />
                  <span className="ctx-unit">token</span>
                </div>

                {chatModels.length > 0 && (
                  <>
                    <div className="ctx-subtitle">Override per model</div>
                    {chatModels.map((f) => (
                      <div className="ctx-row" key={f}>
                        <span className="ctx-label" title={f}>
                          {f}
                          {f === activeModel && <span className="ctx-active">aktif</span>}
                          {ctxLimits[f] > 0 && <span className="ctx-max">maks {ctxLimits[f].toLocaleString("id-ID")}</span>}
                        </span>
                        <input
                          type="number"
                          min={512}
                          step={512}
                          max={ctxLimits[f] || undefined}
                          className="ctx-input"
                          placeholder={`default ${settings.contextSizeDefault}`}
                          value={ctxDraft[f] ?? ""}
                          onChange={(e) => setDraft(f, e.target.value)}
                          onBlur={() => commitModelCtx(f)}
                          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                        />
                        <span className="ctx-unit">token</span>
                      </div>
                    ))}
                    <p className="settings-help">
                      Kosongkan untuk memakai nilai default. Badge <b>maks</b> = context yang dilatih model itu; input
                      tak bisa melebihinya.
                    </p>
                  </>
                )}
              </div>
            </section>

            {/* ---- Gambar ---- */}
            <section className="settings-section">
              <div className="settings-section-title">
                <ImageIcon size={15} />
                <span>Gambar</span>
              </div>

              <div className="settings-field">
                <label className="label">Ukuran gambar default</label>
                <p className="settings-help">Dipakai saat membuat gambar di panel Gambar.</p>
                <select className="settings-select" value={settings.imageSize} onChange={(e) => changeImageSize(e.target.value)}>
                  <option value="512x512">512 × 512</option>
                  <option value="768x768">768 × 768</option>
                  <option value="1024x1024">1024 × 1024</option>
                </select>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
