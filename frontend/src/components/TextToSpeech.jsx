import { useEffect, useRef, useState } from "react";
import { Volume2, Download } from "lucide-react";
import { Api } from "../services/api.js";
import "./TextToSpeech.css";

export default function TextToSpeech() {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [voices, setVoices] = useState([]);
  const [voice, setVoice] = useState("af_heart");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [audioUrl, setAudioUrl] = useState(null);
  const urlRef = useRef(null);

  useEffect(() => {
    Api.status("tts").then(setStatus).catch(() => {});
    Api.ttsVoices()
      .then((d) => setVoices(d.voices || []))
      .catch(() => {});
    return () => {
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
      <div className="tts-header">
        <div>
          <h1>Teks ke Suara</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>{status.mesinHidup ? `siap — ${status.model}` : "memeriksa mesin…"}</span>
          </div>
        </div>
        <select value={voice} onChange={(e) => setVoice(e.target.value)} disabled={voices.length === 0}>
          {voices.length === 0 && <option>Memuat suara…</option>}
          {voices.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
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
