import { useEffect, useRef, useState } from "react";
import { Mic, Square, Upload, Copy, Check, Boxes, Loader2 } from "lucide-react";
import { Api } from "../services/api.js";
import { MicRecorder } from "../lib/wav.js";
import { cn } from "@/lib/utils";

export default function Speech({ onOpenModels }) {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [isRecording, setIsRecording] = useState(false);
  const [level, setLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const recorderRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
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
    try {
      await navigator.clipboard.writeText(transcript);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // diabaikan
    }
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Suara → Teks</h1>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className={cn("size-2 flex-none rounded-full", status.mesinHidup ? "bg-panel-speech shadow-[0_0_8px_var(--panel-speech)]" : "bg-muted-foreground/40")} />
            <span className="truncate">{status.mesinHidup ? `siap — ${status.model}` : "mesin STT mati — pasang model di Model Manager"}</span>
          </div>
        </div>
        <button
          onClick={onOpenModels}
          title="Kelola / ganti model di Model Manager"
          className="flex flex-none items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Boxes size={13} />
          <span className={cn("max-w-[9rem] truncate", !status.model && "text-panel-speech")}>{status.model || "Pilih model"}</span>
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
          {/* ---- rekam mikrofon ---- */}
          <div className="space-y-2.5">
            <Label>Rekam dari mikrofon</Label>
            <div className="flex items-center gap-4 rounded-3xl border border-border bg-card p-4">
              <button
                onClick={toggleRecording}
                disabled={busy}
                className={cn(
                  "flex size-16 flex-none items-center justify-center rounded-full text-white transition disabled:opacity-50",
                  isRecording ? "animate-pulse bg-destructive shadow-lg shadow-destructive/40" : "bg-gradient-to-br from-panel-speech to-panel-image shadow-lg shadow-panel-speech/30 enabled:hover:brightness-110",
                )}
              >
                {isRecording ? <Square size={22} className="fill-current" /> : <Mic size={24} />}
              </button>
              <div className="flex h-14 flex-1 items-end gap-[3px]">
                {Array.from({ length: 24 }).map((_, i) => {
                  const lit = i < Math.round(level * 24);
                  return (
                    <i
                      key={i}
                      className={cn("flex-1 rounded-full transition-all duration-75", lit ? (i > 19 ? "bg-destructive" : "bg-panel-speech") : "bg-muted-foreground/20")}
                      style={{ height: lit ? `${8 + (i / 24) * 32}px` : "6px" }}
                    />
                  );
                })}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">{isRecording ? "Merekam… klik lagi untuk berhenti & mentranskripsi." : "Klik mik untuk mulai merekam."}</p>
          </div>

          {/* ---- unggah file ---- */}
          <div className="space-y-2.5">
            <Label>Atau unggah file audio</Label>
            <button
              type="button"
              onClick={() => fileInputRef.current.click()}
              disabled={busy}
              className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-muted/30 p-6 text-sm text-muted-foreground transition-colors hover:border-panel-speech/50 hover:text-foreground disabled:opacity-50"
            >
              <Upload size={18} />
              <span>Klik untuk pilih file audio</span>
            </button>
            <input ref={fileInputRef} type="file" accept="audio/*" className="hidden" onChange={onFileSelected} />
          </div>

          {/* ---- transkrip ---- */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <Label>Transkrip</Label>
              {transcript && (
                <button onClick={copyTranscript} className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground transition hover:bg-muted hover:text-foreground">
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  <span>{copied ? "Tersalin" : "Salin"}</span>
                </button>
              )}
            </div>
            <div className="relative">
              <textarea
                readOnly
                value={busy ? "" : transcript}
                placeholder="Transkrip akan muncul di sini…"
                className="min-h-36 w-full resize-none rounded-2xl border border-border bg-card px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-muted-foreground"
              />
              {busy && (
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-sm text-panel-speech">
                  <Loader2 className="size-4 animate-spin" /> Mentranskripsi…
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Label({ children }) {
  return <label className="block font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</label>;
}
