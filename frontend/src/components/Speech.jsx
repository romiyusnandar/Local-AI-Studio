import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload, Copy } from "lucide-react";
import { Api } from "../services/api.js";
import { MicRecorder } from "../lib/wav.js";
import "./Speech.css";

export default function Speech() {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);

  const recorderRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    refreshModels();
    refreshStatus();
    const t = setInterval(refreshStatus, 3000);
    return () => clearInterval(t);
  }, []);

  async function refreshStatus() {
    try {
      setStatus(await Api.status("stt"));
    } catch {
      // diamkan
    }
  }

  async function refreshModels() {
    try {
      const data = await Api.models("stt");
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
      await Api.selectModel("stt", model);
    } catch (err) {
      alert(err.message);
    }
  }

  async function toggleRecording() {
    if (!status.mesinHidup) {
      alert("Mesin STT sedang mati — pilih model dulu.");
      return;
    }
    if (!isRecording) {
      try {
        recorderRef.current = new MicRecorder((v) => setLevel(v));
        await recorderRef.current.start();
        setIsRecording(true);
      } catch (err) {
        alert("Tidak bisa mengakses mikrofon: " + err.message);
      }
    } else {
      const blob = recorderRef.current.stop();
      setIsRecording(false);
      setLevel(0);
      runTranscribe(blob, "rekaman.wav");
    }
  }

  async function onFileSelected(e) {
    const file = e.target.files[0];
    if (!file) return;
    runTranscribe(file, file.name);
  }

  async function runTranscribe(blob, filename) {
    setBusy(true);
    setTranscript("Mentranskripsi…");
    try {
      const res = await Api.transcribe(blob, filename);
      setTranscript(res.text || "(tidak ada teks terdeteksi)");
    } catch (err) {
      setTranscript("");
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function copyTranscript() {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript);
  }

  return (
    <div className="speech-panel">
      <div className="speech-header">
        <div>
          <h1>Suara ke Teks</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>
              {status.mesinHidup ? `siap — ${status.model}` : "mesin STT mati — pilih model"}
            </span>
          </div>
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

      <div className="speech-body">
        <label className="label">Rekam dari mikrofon</label>
        <div className="mic-row">
          <button className={`mic-btn${isRecording ? " recording" : ""}`} onClick={toggleRecording} disabled={busy}>
            {isRecording ? <Square size={20} /> : <Mic size={20} />}
          </button>
          <div className="level-meter">
            {Array.from({ length: 24 }).map((_, i) => {
              const lit = i < Math.round(level * 24);
              return (
                <i
                  key={i}
                  style={{
                    height: lit ? `${8 + (i / 24) * 18}px` : "6px",
                    background: lit ? (i > 19 ? "#e2574c" : "var(--teal)") : "var(--border-strong)",
                  }}
                />
              );
            })}
          </div>
        </div>

        <label className="label">Atau unggah file audio</label>
        <div className="dropzone" onClick={() => fileInputRef.current.click()}>
          <Upload size={18} />
          <span>Klik untuk pilih file audio</span>
        </div>
        <input ref={fileInputRef} type="file" accept="audio/*" style={{ display: "none" }} onChange={onFileSelected} />

        <label className="label">Transkrip</label>
        <textarea className="transcript-box" readOnly value={transcript} placeholder="Transkrip akan muncul di sini…" />
        <button className="btn-sm" onClick={copyTranscript}>
          <Copy size={14} />
          <span>Salin</span>
        </button>
      </div>
    </div>
  );
}
