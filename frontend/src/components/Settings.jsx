import { useEffect, useState } from "react";
import { MessageSquare, Image as ImageIcon, Key, Check, Trash2, ExternalLink } from "lucide-react";
import { Api } from "../services/api.js";
import "./Settings.css";

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    Api.getSettings().then(setSettings).catch(() => {});
  }, []);

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
