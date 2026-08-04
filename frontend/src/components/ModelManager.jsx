import { useEffect, useRef, useState } from "react";
import { Download, Trash2 } from "lucide-react";
import { Api } from "../services/api.js";
import "./ModelManager.css";

// Baru "llm" (Chat) yang punya mesin sungguhan sekarang. Tab TTS/STT/Image
// tinggal ditambahkan di sini begitu fase-nya masing-masing selesai —
// tidak perlu ubah struktur komponen ini lagi.
const KINDS = [
  { id: "llm", label: "Chat", ext: ".gguf" },
  { id: "stt", label: "Suara→Teks", ext: ".bin" },
];

function formatBytes(n) {
  if (!n || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export default function ModelManager() {
  const [kind, setKind] = useState("llm");
  const [installed, setInstalled] = useState({ models: [], active: "" });
  const [catalog, setCatalog] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [progress, setProgress] = useState(null);
  const [customUrl, setCustomUrl] = useState("");
  const pollRef = useRef(null);

  useEffect(() => {
    load();
    return () => clearInterval(pollRef.current);
  }, [kind]);

  async function load() {
    setLoading(true);
    setError("");
    try {
      const [installedData, catalogData] = await Promise.all([Api.models(kind), Api.catalog(kind)]);
      setInstalled(installedData);
      setCatalog(catalogData.models || []);

      const p = await Api.progress();
      if (p.active) {
        setProgress(p);
        startPolling();
      }
    } catch (err) {
      setError("Gagal memuat katalog: " + err.message);
    } finally {
      setLoading(false);
    }
  }

  function startPolling() {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      try {
        const p = await Api.progress();
        setProgress(p);
        if (p.done) {
          clearInterval(pollRef.current);
          pollRef.current = null;
          setProgress(null);
          if (p.error) alert(p.error);
          load();
        }
      } catch {
        // diamkan
      }
    }, 500);
  }

  async function onUse(model) {
    try {
      await Api.selectModel(kind, model);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function onDelete(model) {
    if (!confirm(`Hapus ${model}?`)) return;
    try {
      await Api.deleteModel(kind, model);
      load();
    } catch (err) {
      alert(err.message);
    }
  }

  async function onInstall(url, projectorUrl) {
    try {
      await Api.downloadModel(kind, url, projectorUrl);
      startPolling();
    } catch (err) {
      alert(err.message);
    }
  }

  function onCustomInstall() {
    const url = customUrl.trim();
    if (!url) return;
    onInstall(url);
    setCustomUrl("");
  }

  const activeKind = KINDS.find((k) => k.id === kind);

  return (
    <div className="model-panel">
      <div className="model-header">
        <h1>Model</h1>
        <span className="sub">Kelola model untuk tiap mesin</span>
      </div>

      <div className="model-tabs">
        {KINDS.map((k) => (
          <button key={k.id} className={`model-tab${kind === k.id ? " active" : ""}`} onClick={() => setKind(k.id)}>
            {k.label}
          </button>
        ))}
      </div>

      <div className="model-body">
        {loading && <div className="empty">Memuat…</div>}
        {error && <div className="empty">{error}</div>}

        {!loading && !error && (
          <>
            <div className="section-title">Terpasang</div>
            {installed.models.length === 0 && <div className="empty">Belum ada model {activeKind.label} terpasang.</div>}
            {installed.models.map((m) => (
              <div key={m} className="model-row">
                <div className="model-row-main">
                  <div className="model-row-file">{m}</div>
                </div>
                {m === installed.active ? (
                  <span className="badge active">Aktif</span>
                ) : (
                  <button className="btn-sm" onClick={() => onUse(m)}>
                    Pakai
                  </button>
                )}
                <button className="btn-sm btn-danger" onClick={() => onDelete(m)} aria-label="Hapus">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}

            <div className="section-title">Tersedia untuk diunduh</div>
            {catalog.map((item) => (
              <div key={item.file} className="model-row">
                <div className="model-row-main">
                  <div className="model-row-name">{item.name}</div>
                  {item.note && <div className="model-row-note">{item.note}</div>}
                </div>
                <div className="model-row-size">
                  {formatBytes(item.sizeBytes)}
                  {item.projectorSizeBytes ? ` + ${formatBytes(item.projectorSizeBytes)} proyektor` : ""}
                </div>
                {item.installed ? (
                  <span className="badge">Terpasang</span>
                ) : (
                  <button className="btn-sm" onClick={() => onInstall(item.url, item.projectorUrl)}>
                    <Download size={14} />
                    <span>Pasang</span>
                  </button>
                )}
              </div>
            ))}

            {progress && (
              <div className="download-bar-wrap">
                <div className="download-bar">
                  <i style={{ width: `${progress.percent || 0}%` }} />
                </div>
                <div className="download-status">
                  <span>{progress.label || "Mengunduh…"}</span>
                  <span>
                    {progress.total ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} (${progress.percent}%)` : ""}
                  </span>
                  <button className="btn-sm" onClick={() => Api.cancelDownload(kind)}>
                    Batal
                  </button>
                </div>
              </div>
            )}

            <div className="custom-url">
              <label>Atau tempel URL Hugging Face ({activeKind.ext})</label>
              <div className="custom-url-row">
                <input
                  value={customUrl}
                  onChange={(e) => setCustomUrl(e.target.value)}
                  placeholder="https://huggingface.co/..."
                />
                <button className="btn-sm" onClick={onCustomInstall}>
                  <Download size={14} />
                  <span>Unduh</span>
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
