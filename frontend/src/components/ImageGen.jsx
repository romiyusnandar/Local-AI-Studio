import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Download, Upload, Trash2, Boxes, Loader2, Sparkles, Repeat2, X } from "lucide-react";
import { Api } from "../services/api.js";
import { engineStatusText } from "../lib/status.js";
import { cn } from "@/lib/utils";

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
  const [lightbox, setLightbox] = useState(null); // item histori yang dibuka penuh, atau null

  const fileInputRef = useRef(null);
  const timerRef = useRef(null);
  const genPollRef = useRef(null);
  const promptRef = useRef(null); // textarea prompt (untuk fokus saat "pakai lagi")
  const scrollRef = useRef(null); // kontainer scroll (untuk gulir ke form)

  // Tutup lightbox dengan tombol Escape.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e) => e.key === "Escape" && setLightbox(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // reusePrompt mengisi ulang form dari sebuah hasil: prompt (+ mode), lalu
  // gulir ke form dan fokuskan textarea supaya bisa langsung diubah & dibuat lagi.
  function reusePrompt(h) {
    setPrompt(h.prompt || "");
    if (h.mode === "generate" || h.mode === "edit") setMode(h.mode);
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
    setTimeout(() => promptRef.current?.focus(), 300);
  }

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
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Gambar</h1>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className={cn("size-2 flex-none rounded-full", status.mesinHidup ? "bg-panel-image shadow-[0_0_8px_var(--panel-image)]" : "bg-muted-foreground/40")} />
            <span className="truncate">{engineStatusText(status, "image gen")}</span>
          </div>
        </div>
        <button
          onClick={onOpenModels}
          title="Kelola / ganti model di Model Manager"
          className="flex flex-none items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
        >
          <Boxes size={13} />
          <span className={cn("max-w-[9rem] truncate", !status.model && "text-panel-image")}>{status.model || "Pilih model"}</span>
        </button>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 px-4 py-5 lg:grid-cols-[330px_minmax(0,1fr)]">
          {/* ---- form ---- */}
          <div className="space-y-4 self-start rounded-3xl border border-border bg-card p-4 lg:sticky lg:top-4">
            <div className="flex gap-1 rounded-2xl bg-muted p-1">
              {[
                ["generate", "Teks → Gambar"],
                ["edit", "Edit Gambar"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  onClick={() => setMode(id)}
                  className={cn(
                    "flex-1 rounded-xl px-3 py-2 text-sm font-medium transition-colors",
                    mode === id ? "bg-panel-image text-white shadow-md shadow-panel-image/30" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>

            {mode === "edit" && (
              <div className="space-y-2">
                <Label>Gambar sumber</Label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current.click()}
                  className="flex w-full flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-border bg-muted/30 p-5 text-sm text-muted-foreground transition-colors hover:border-panel-image/50 hover:text-foreground"
                >
                  {sourcePreview ? (
                    <img src={sourcePreview} alt="" className="max-h-44 rounded-xl object-contain" />
                  ) : (
                    <>
                      <Upload size={18} />
                      <span>Klik untuk pilih gambar</span>
                    </>
                  )}
                </button>
                <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onSourceFile} />
              </div>
            )}

            <div className="space-y-2">
              <Label>Prompt</Label>
              <textarea
                ref={promptRef}
                rows={4}
                placeholder="Deskripsikan gambar yang ingin dibuat…"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full resize-none rounded-2xl border border-border bg-background px-3 py-2.5 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-panel-image/60"
              />
            </div>

            <div className="space-y-2">
              <Label>Ukuran</Label>
              <div className="flex items-center justify-between rounded-2xl border border-border bg-muted/40 px-3 py-2 text-sm">
                <span className="font-mono">{size.replace("x", " × ")}</span>
                <span className="text-xs text-muted-foreground">atur di Pengaturan</span>
              </div>
            </div>

            <button
              onClick={onGenerate}
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-panel-image to-panel-chat py-2.5 text-sm font-semibold text-white shadow-lg shadow-panel-image/25 transition enabled:hover:brightness-110 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles size={16} />}
              <span>{busy ? "Membuat gambar…" : "Buat Gambar"}</span>
            </button>
          </div>

          {/* ---- feed hasil (terbaru di atas) ---- */}
          <div className="space-y-4">
            {busy && (
              <div className="overflow-hidden rounded-3xl border border-panel-image/30 bg-panel-image/5">
                <div className="flex items-center justify-between gap-2 px-4 py-2.5">
                  <span className="min-w-0 truncate text-sm">{busyPrompt}</span>
                  <span className="flex-none font-mono text-xs text-muted-foreground">{elapsed.toFixed(1)}s</span>
                </div>
                <div className="flex items-center gap-3 px-4 pb-4">
                  <Loader2 className="size-5 flex-none animate-spin text-panel-image" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs text-muted-foreground">
                      {gen.decoding
                        ? "Decoding gambar (VAE)…"
                        : gen.steps > 0
                          ? `Langkah ${gen.step}/${gen.steps}${gen.speed ? ` · ${gen.speed}` : ""}`
                          : "Menyiapkan generate…"}
                    </div>
                    {gen.steps > 0 && !gen.decoding && (
                      <div className="mt-1.5 h-2 w-full overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-panel-image transition-all duration-300" style={{ width: `${progressPct}%` }} />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {!busy && errorMsg && (
              <div className="rounded-3xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">{errorMsg}</div>
            )}

            {history.length > 0 && (
              <div className="columns-1 gap-4 sm:columns-2 [&>figure]:mb-4">
                {history.map((h) => (
                  <figure key={h.file} className="group relative break-inside-avoid overflow-hidden rounded-2xl border border-border bg-muted/40 shadow-sm transition-shadow hover:shadow-lg hover:shadow-panel-image/10">
                    {/* Klik gambar → buka penuh di lightbox in-app */}
                    <button type="button" onClick={() => setLightbox(h)} className="block w-full overflow-hidden" aria-label="Lihat gambar penuh">
                      <img
                        src={h.url}
                        alt={h.prompt || "gambar"}
                        loading="lazy"
                        className="w-full transition-transform duration-500 ease-out group-hover:scale-[1.03]"
                      />
                    </button>

                    {/* Aksi: selalu tampil di mobile, muncul saat hover di desktop */}
                    <div className="absolute right-2 top-2 flex gap-1.5 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100">
                      {h.prompt && (
                        <button
                          onClick={() => reusePrompt(h)}
                          title="Pakai prompt ini lagi"
                          aria-label="Pakai prompt ini lagi"
                          className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-panel-image"
                        >
                          <Repeat2 size={14} />
                        </button>
                      )}
                      <a
                        href={h.url}
                        download={h.file}
                        title="Unduh"
                        aria-label="Unduh gambar"
                        className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-black/80"
                      >
                        <Download size={14} />
                      </a>
                      <button
                        onClick={() => onDeleteHistory(h.file)}
                        title="Hapus"
                        aria-label="Hapus gambar"
                        className="flex size-8 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm transition hover:bg-destructive"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>

                    {/* Caption prompt + meta di atas gradasi gelap */}
                    <figcaption className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent p-3 pt-10 opacity-100 transition-opacity duration-200 sm:opacity-0 sm:group-hover:opacity-100">
                      <p className="line-clamp-2 text-xs font-medium leading-snug text-white/95">
                        {h.prompt || (h.mode === "edit" ? "(edit gambar)" : "—")}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[10px] text-white/65">
                        {h.size && <span>{h.size}</span>}
                        {h.mode === "edit" && <span>· edit</span>}
                        {h.steps > 0 && <span>· {h.steps} langkah</span>}
                        {h.durationMs > 0 && <span>· {fmtDur(h.durationMs)}</span>}
                      </div>
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}

            {!busy && !errorMsg && history.length === 0 && (
              <div className="flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border bg-card/40 px-4 py-16 text-center text-muted-foreground">
                <div className="flex size-12 items-center justify-center rounded-2xl bg-panel-image/10 text-panel-image">
                  <ImageIcon size={24} />
                </div>
                <p className="max-w-xs text-sm">Belum ada gambar. Tulis prompt di kiri lalu klik Buat Gambar.</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ---- lightbox: gambar penuh di atas backdrop gelap ---- */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/85 p-4 backdrop-blur-sm animate-in fade-in"
        >
          <img
            src={lightbox.url}
            alt={lightbox.prompt || "gambar"}
            onClick={(e) => e.stopPropagation()}
            className="max-h-[80vh] max-w-full rounded-2xl object-contain shadow-2xl"
          />
          {lightbox.prompt && (
            <p onClick={(e) => e.stopPropagation()} className="max-w-2xl text-center text-sm text-white/80">
              {lightbox.prompt}
            </p>
          )}
          <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
            <a
              href={lightbox.url}
              download={lightbox.file}
              className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-white/20"
            >
              <Download size={15} /> Unduh
            </a>
            {lightbox.prompt && (
              <button
                onClick={() => {
                  reusePrompt(lightbox);
                  setLightbox(null);
                }}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-4 py-2 text-sm font-medium text-white backdrop-blur transition hover:bg-panel-image"
              >
                <Repeat2 size={15} /> Pakai lagi
              </button>
            )}
          </div>
          <button
            onClick={() => setLightbox(null)}
            aria-label="Tutup"
            className="absolute right-4 top-4 flex size-10 items-center justify-center rounded-full bg-white/10 text-white backdrop-blur transition hover:bg-white/20"
          >
            <X size={20} />
          </button>
        </div>
      )}
    </div>
  );
}

function Label({ children }) {
  return <label className="block font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</label>;
}

// fmtDur: durasi ms → "3.4s" atau "1m 12s".
function fmtDur(ms) {
  const s = (ms || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}
