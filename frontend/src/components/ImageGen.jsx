import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Download, Upload, Trash2 } from "lucide-react";
import { Api } from "../services/api.js";
import { engineStatusText } from "../lib/status.js";
import ModelChip from "./ModelChip.jsx";
import "./ImageGen.css";

export default function ImageGen({ onOpenModels }) {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [mode, setMode] = useState("generate");
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState("512x512");
  const [sourceFile, setSourceFile] = useState(null);
  const [sourcePreview, setSourcePreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [busyPrompt, setBusyPrompt] = useState("");
  const [elapsed, setElapsed] = useState(0);
  const [gen, setGen] = useState({ active: false, step: 0, steps: 0, speed: "", decoding: false });
  const [errorMsg, setErrorMsg] = useState("");
  const [history, setHistory] = useState([]);

  const fileInputRef = useRef(null);
  const timerRef = useRef(null);
  const genPollRef = useRef(null);

  useEffect(() => {
    refreshStatus();
    refreshHistory();
    // Ukuran gambar disetel di menu Pengaturan (tersimpan) — baca dari sana.
    Api.getSettings().then((s) => setSize(s.imageSize || "512x512")).catch(() => {});
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
      alert("Mesin image gen sedang mati — pasang & pilih model di Model Manager.");
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
    setBusyPrompt(prompt.trim());
    setErrorMsg("");
    setElapsed(0);
    startTimer();
    startGenPoll();

    try {
      if (mode === "generate") {
        await Api.imgGenerate({ prompt, size });
      } else {
        const fd = new FormData();
        fd.append("prompt", prompt);
        fd.append("image", sourceFile);
        fd.append("size", size);
        await Api.imgEdit(fd, { prompt, size });
      }
      // Hasil sudah tersimpan server-side ke histori — muncul di feed.
      await refreshHistory();
    } catch (err) {
      setErrorMsg(err.message);
    } finally {
      stopTimer();
      stopGenPoll();
      setBusy(false);
    }
  }

  const progressPct = gen.steps > 0 ? Math.round((gen.step / gen.steps) * 100) : 0;

  return (
    <div className="img-panel">
      <div className="panel-head">
        <div>
          <h1>Generasi Gambar</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>{engineStatusText(status, "image gen")}</span>
          </div>
        </div>
        <ModelChip model={status.model} onOpen={onOpenModels} />
      </div>

      <div className="img-body">
        {/* ---- Kolom kiri: form ---- */}
        <div className="img-form">
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
          <textarea rows={4} placeholder="Deskripsikan gambar yang ingin dibuat…" value={prompt} onChange={(e) => setPrompt(e.target.value)} />

          <label className="label">Ukuran</label>
          <div className="size-readonly">
            {size.replace("x", " × ")}
            <span className="size-hint">atur di Pengaturan</span>
          </div>

          <button className="btn-primary img-generate-btn" onClick={onGenerate} disabled={busy}>
            <ImageIcon size={16} />
            <span>{busy ? "Membuat gambar…" : "Buat Gambar"}</span>
          </button>
        </div>

        {/* ---- Kolom kanan: feed hasil (terbaru di atas) ---- */}
        <div className="gen-feed">
          {busy && (
            <div className="gen-card generating">
              <div className="gen-card-head">
                <span className="gen-card-prompt">{busyPrompt}</span>
                <span className="elapsed">{elapsed.toFixed(1)}s</span>
              </div>
              <div className="gen-progress-row">
                <div className="spinner" />
                <div className="gen-progress-info">
                  <span>
                    {gen.decoding
                      ? "Decoding gambar (VAE)…"
                      : gen.steps > 0
                        ? `Langkah ${gen.step}/${gen.steps}${gen.speed ? ` · ${gen.speed}` : ""}`
                        : "Menyiapkan generate…"}
                  </span>
                  {gen.steps > 0 && !gen.decoding && (
                    <div className="gen-progress">
                      <i style={{ width: `${progressPct}%` }} />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {!busy && errorMsg && (
            <div className="gen-card">
              <span className="error-text">{errorMsg}</span>
            </div>
          )}

          {history.map((h) => (
            <div className="gen-card" key={h.file}>
              <div className="gen-card-head">
                <span className="gen-card-prompt" title={h.prompt}>
                  {h.prompt || (h.mode === "edit" ? "(edit gambar)" : "—")}
                </span>
                <span className="gen-card-meta">
                  {h.size || ""}
                  {h.mode === "edit" ? " · edit" : ""}
                </span>
              </div>
              <img className="gen-card-img" src={h.url} alt={h.prompt || "gambar"} loading="lazy" />
              <div className="gen-card-actions">
                <a className="btn-sm" href={h.url} download={h.file}>
                  <Download size={14} />
                  <span>Unduh</span>
                </a>
                <button className="btn-sm btn-danger" onClick={() => onDeleteHistory(h.file)}>
                  <Trash2 size={14} />
                  <span>Hapus</span>
                </button>
              </div>
            </div>
          ))}

          {!busy && !errorMsg && history.length === 0 && (
            <div className="gen-empty">
              <ImageIcon size={26} />
              <p>Belum ada gambar. Tulis prompt di kiri lalu klik Buat Gambar.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
