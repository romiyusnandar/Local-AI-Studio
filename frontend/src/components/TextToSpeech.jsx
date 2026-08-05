import { useEffect, useRef, useState } from "react";
import { Volume2, Download } from "lucide-react";
import { Api } from "../services/api.js";
import ModelChip from "./ModelChip.jsx";
import "./TextToSpeech.css";

export default function TextToSpeech({ onOpenModels }) {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [voices, setVoices] = useState([]);
  const [voice, setVoice] = useState("af_heart");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const urlRef = useRef(null);
  const lastModelRef = useRef("");

  async function refreshVoices() {
    try {
      const d = await Api.ttsVoices();
      const list = d.voices || [];
      setVoices(list);
      // Kalau voice terpilih tidak ada di daftar model baru, ikuti yang pertama.
      setVoice((v) => (list.includes(v) ? v : list[0] || ""));
    } catch {
      setVoices([]);
    }
  }

  useEffect(() => {
    refreshVoices();
    // Pantau model aktif; daftar suara ikut model (Kokoro vs Piper), jadi
    // refresh voices tiap kali model berganti dari Model Manager.
    const tick = async () => {
      try {
        const s = await Api.status("tts");
        setStatus(s);
        if (s.model !== lastModelRef.current) {
          lastModelRef.current = s.model;
          refreshVoices();
        }
      } catch {
        // diamkan
      }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => {
      clearInterval(t);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, []);

  async function onSpeak() {
    const t = text.trim();
    if (!t) return;
    setBusy(true);
    try {
      const blob = await Api.speak(t, voice);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setAudioUrl(url);
    } catch (err) {
      alert(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tts-panel">
      <div className="panel-head">
        <div>
          <h1>Teks ke Suara</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>{status.mesinHidup ? `siap — ${status.model}` : "pasang model di Model Manager"}</span>
          </div>
        </div>
        <div className="tts-header-right">
          {voices.length > 0 ? (
            <select value={voice} onChange={(e) => setVoice(e.target.value)}>
              {voices.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          ) : (
            <span className="voice-single">Suara tunggal</span>
          )}
          <ModelChip model={status.model} onOpen={onOpenModels} />
        </div>
      </div>

      <div className="tts-body">
        <label className="label">Teks</label>
        <textarea
          rows={5}
          placeholder="Tulis teks yang ingin diucapkan…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />

        <button className="btn-primary" onClick={onSpeak} disabled={busy || !text.trim()}>
          <Volume2 size={16} />
          <span>{busy ? "Membuat suara…" : "Ucapkan"}</span>
        </button>

        {audioUrl && (
          <div className="audio-result">
            <audio controls autoPlay src={audioUrl} />
            <a className="btn-sm" href={audioUrl} download="suara.wav">
              <Download size={14} />
              <span>Unduh</span>
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
