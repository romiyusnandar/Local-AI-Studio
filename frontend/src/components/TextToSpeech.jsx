import { useEffect, useRef, useState } from "react";
import { Volume2, Download, Boxes, Loader2 } from "lucide-react";
import { Api } from "../services/api.js";
import { cn } from "@/lib/utils";

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
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Teks → Suara</h1>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className={cn("size-2 flex-none rounded-full", status.mesinHidup ? "bg-panel-tts shadow-[0_0_8px_var(--panel-tts)]" : "bg-muted-foreground/40")} />
            <span className="truncate">{status.mesinHidup ? `siap — ${status.model}` : "mesin TTS mati — pasang model di Model Manager"}</span>
          </div>
        </div>
        <button
          onClick={onOpenModels}
          title="Kelola / ganti model di Model Manager"
          className="flex flex-none items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Boxes size={13} />
          <span className={cn("max-w-[9rem] truncate", !status.model && "text-panel-tts")}>{status.model || "Pilih model"}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-6">
          {/* ---- pilih suara ---- */}
          <div className="space-y-2.5">
            <Label>Suara</Label>
            {voices.length > 0 ? (
              <select
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
                className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-panel-tts/60 sm:w-auto sm:min-w-[240px]"
              >
                {voices.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            ) : (
              <span className="inline-block rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">Suara tunggal (model ini tak punya pilihan suara)</span>
            )}
          </div>

          {/* ---- teks ---- */}
          <div className="space-y-2.5">
            <Label>Teks</Label>
            <textarea
              rows={5}
              placeholder="Tulis teks yang ingin diucapkan…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="w-full resize-none rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus:border-panel-tts/60"
            />
          </div>

          <button
            onClick={onSpeak}
            disabled={busy || !text.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-panel-tts to-panel-models py-2.5 text-sm font-semibold text-white shadow-lg shadow-panel-tts/25 transition enabled:hover:brightness-110 disabled:opacity-50 sm:w-auto sm:px-6"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Volume2 size={16} />}
            <span>{busy ? "Membuat suara…" : "Ucapkan"}</span>
          </button>

          {audioUrl && (
            <div className="space-y-3 rounded-3xl border border-panel-tts/30 bg-panel-tts/5 p-4">
              <audio controls autoPlay src={audioUrl} className="w-full" />
              <a
                href={audioUrl}
                download="suara.wav"
                className="inline-flex items-center gap-1.5 rounded-full bg-panel-tts/15 px-3.5 py-1.5 text-xs font-semibold text-panel-tts transition hover:bg-panel-tts hover:text-white"
              >
                <Download size={13} /> Unduh
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Label({ children }) {
  return <label className="block font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</label>;
}
