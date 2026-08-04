import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Download, Upload, Trash2 } from "lucide-react";
import { Api } from "../services/api.js";
import { engineStatusText } from "../lib/status.js";
import "./ImageGen.css";

export default function ImageGen() {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [mode, setMode] = useState("generate");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("512x512");
  const [sourceFile, setSourceFile] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [gen, setGen] = useState({ active: false, step: 0, steps: 0, speed: "", decoding: false });
  const [resultUrl, setResultUrl] = useState(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [history, setHistory] = useState([]);

  const fileInputRef = useRef(null);
  const timerRef = useRef(null);
  const genPollRef = useRef(null);
  const urlRef = useRef(null);

  useEffect(() => {
    refreshModels();
    refreshStatus();
    refreshHistory();
    const t = setInterval(refreshStatus, 1200);
    return () => {
      clearInterval(t);
      clearInterval(timerRef.current);
      clearInterval(genPollRef.current);
    };
  }, []);

  async function refreshHistory() {
    try {
      const data = await Api.imgHistory();
      setHistory(data.items || []);
    } catch {
      // diamkan
    }
  }

  async function onDeleteHistory(file) {
    try {
      await Api.imgDeleteHistory(file);
      refreshHistory();
    } catch (err) {
      alert(err.message);
    }
  }

  async function refreshStatus() {
    try {
      setStatus(await Api.status("img"));
    } catch {
      // diamkan
    }
  }

  async function refreshModels() {
    try {
      const data = await Api.models("img");
      setModels(data.models || []);
      setActiveModel(data.active || "");
    } catch {
      // diamkan
    }
  }

  async function onSelectModel(e) {
    const model = e.target.value;
    setActiveModel(model);
    try {
      await Api.selectModel("img", model);
    } catch (err) {
      alert(err.message);
    }
  }

  async function onSourceFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setSourceFile(file);
    setSourcePreview(URL.createObjectURL(file));
  }

  function startTimer() {
    const start = Date.now();
    timerRef.current = setInterval(() => setElapsed((Date.now() - start) / 1000), 100);
  }
  function stopTimer() {
    clearInterval(timerRef.current);
  }

  function startGenPoll() {
    genPollRef.current = setInterval(async () => {
      try {
        setGen(await Api.imgGeneration());
      } catch {
        // diamkan
      }
    }, 600);
  }
  function stopGenPoll() {
    clearInterval(genPollRef.current);
    setGen({ active: false, step: 0, steps: 0, speed: "", decoding: false });
  }

  async function onGenerate() {
    if (!status.mesinHidup) {
      alert("Mesin image gen sedang mati — pilih model dulu.");
      return;
    }
    if (!prompt.trim()) {
      alert("Isi prompt dulu.");
      return;
    }
    if (mode === "edit" && !sourceFile) {
      alert("Pilih gambar sumber dulu.");
      return;
    }

    setBusy(true);
    setErrorMsg("");
    setElapsed(0);
    startTimer();
    startGenPoll();

    try {
      let blob;
      if (mode === "generate") {
        blob = await Api.imgGenerate({ prompt, size });
      } else {
        const fd = new FormData();
        fd.append("prompt", prompt);
        fd.append("image", sourceFile);
        fd.append("size", size);
        blob = await Api.imgEdit(fd, { prompt, size });
      }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setResultUrl(url);
      refreshHistory();
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      stopTimer();
      stopGenPoll();
      setBusy(false);
    }
  }

  return (
    <div className="img-panel">
      <div className="img-header">
        <div>
          <h1>Generasi Gambar</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>{engineStatusText(status, "image gen")}</span>
          </div>
          {!status.mesinHidup && status.load?.active && status.load.progress > 0 && (
            <div className="load-bar">
              <i style={{ width: `${status.load.progress}%` }} />
            </div>
          )}
        </div>
        <select value={activeModel} onChange={onSelectModel} disabled={models.length === 0}>
          {models.length === 0 && <option>Belum ada model</option>}
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </div>

      <div className="img-body">
        <div className="mode-toggle">
          <button className={mode === "generate" ? "active" : ""} onClick={() => setMode("generate")}>
            Teks → Gambar
          </button>
          <button className={mode === "edit" ? "active" : ""} onClick={() => setMode("edit")}>
            Edit Gambar
          </button>
        </div>

        {mode === "edit" && (
          <>
            <label className="label">Gambar sumber</label>
            <div className="dropzone" onClick={() => fileInputRef.current.click()}>
              {sourcePreview ? (
                <img className="preview" src={sourcePreview} alt="" />
              ) : (
                <>
                  <Upload size={18} />
                  <span>Klik untuk pilih gambar</span>
                </>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onSourceFile} />
          </>
        )}

        <label className="label">Prompt</label>
        <textarea rows={3} placeholder="Deskripsikan gambar yang ingin dibuat…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

        <label className="label">Ukuran</label>
        <select className="size-select" value={size} onChange={(e) => setSize(e.target.value)}>
          <option value="512x512">512 × 512</option>
          <option value="768x768">768 × 768</option>
          <option value="1024x1024">1024 × 1024</option>
        </select>

        <button className="btn-primary" onClick={onGenerate} disabled={busy}>
          <ImageIcon size={16} />
          <span>{busy ? "Membuat gambar…" : "Buat Gambar"}</span>
        </button>

        {busy && (
          <div className="img-result generating">
            <div className="spinner" />
            {gen.decoding ? (
              <span>Decoding gambar (VAE)…</span>
            ) : gen.steps > 0 ? (
              <span>
                Langkah {gen.step}/{gen.steps}
                {gen.speed ? ` · ${gen.speed}` : ""}
              </span>
            ) : (
              <span>Menyiapkan generate…</span>
            )}
            {gen.steps > 0 && !gen.decoding && (
              <div className="gen-progress">
                <i style={{ width: `${Math.round((gen.step / gen.steps) * 100)}%` }} />
              </div>
            )}
            <span className="elapsed">{elapsed.toFixed(1)}s</span>
          </div>
        )}

        {!busy && errorMsg && (
          <div className="img-result">
            <span className="error-text">{errorMsg}</span>
          </div>
        )}

        {!busy && !errorMsg && resultUrl && (
          <div className="img-result">
            <img src={resultUrl} alt="Hasil generasi" />
            <a className="btn-sm" href={resultUrl} download="generated.png">
              <Download size={14} />
              <span>Unduh</span>
            </a>
          </div>
        )}

        {history.length > 0 && (
          <div className="img-history">
            <label className="label">Histori ({history.length})</label>
            <div className="history-grid">
              {history.map((h) => (
                <div className="history-item" key={h.file} title={h.prompt || h.mode}>
                  <a href={h.url} target="_blank" rel="noreferrer">
                    <img src={h.url} alt={h.prompt || "gambar"} loading="lazy" />
                  </a>
                  <div className="history-meta">
                    <span className="history-prompt">{h.prompt || (h.mode === "edit" ? "(edit)" : "—")}</span>
                    <button className="history-del" onClick={() => onDeleteHistory(h.file)} title="Hapus">
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
