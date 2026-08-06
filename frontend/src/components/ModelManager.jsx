import { useEffect, useRef, useState } from "react";
import { Download, Trash2, Check, Eye, Loader2, HardDrive, X } from "lucide-react";
import { Api } from "../services/api.js";
import { cn } from "@/lib/utils";

// Tiap jenis mesin punya tab sendiri; komponen ini generik. noCustom: TTS
// tidak menerima URL kustom (varian Kokoro bawaan, bukan file Hugging Face).
const KINDS = [
  { id: "llm", label: "Chat", ext: ".gguf" },
  { id: "stt", label: "Suara→Teks", ext: ".bin" },
  { id: "tts", label: "Teks→Suara", ext: "kokoro", noCustom: true },
  { id: "img", label: "Gambar", ext: ".gguf/.safetensors" },
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
  // file katalog yang sedang diunduh — supaya progress bar bisa dirender di
  // dalam kartunya. "__custom__" = unduhan dari URL HF (bukan item katalog).
  const [downloadingFile, setDownloadingFile] = useState("");
  const [engineStatus, setEngineStatus] = useState({ mesinHidup: false, load: null });
  const pollRef = useRef(null);
  const statusRef = useRef(null);

  useEffect(() => {
    load();
    // Pantau status mesin untuk menampilkan progres pemuatan model (bar +
    // fase) di sini — bukan di panel fitur.
    refreshEngineStatus();
    statusRef.current = setInterval(refreshEngineStatus, 1000);
    return () => {
      clearInterval(pollRef.current);
      clearInterval(statusRef.current);
    };
  }, [kind]);

  async function refreshEngineStatus() {
    try {
      setEngineStatus(await Api.status(kind));
    } catch {
      // diamkan
    }
  }

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
          setDownloadingFile("");
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

  async function onInstall(url, projectorUrl, file) {
    try {
      setDownloadingFile(file || "__custom__");
      await Api.downloadModel(kind, url, projectorUrl);
      startPolling();
    } catch (err) {
      setDownloadingFile("");
      alert(err.message);
    }
  }

  function onCustomInstall() {
    const url = customUrl.trim();
    if (!url) return;
    onInstall(url, undefined, "__custom__");
    setCustomUrl("");
  }

  const activeKind = KINDS.find((k) => k.id === kind);
  // apakah progress aktif cocok dengan salah satu kartu katalog (untuk dirender
  // di dalam kartu) — kalau tidak, tampilkan di atas (unduhan URL kustom).
  const inCard = progress && catalog.some((c) => c.file === downloadingFile);

  return (
    <div className="flex h-full flex-col">
      <header className="flex-none border-b border-border px-5 py-3">
        <h1 className="text-lg font-semibold leading-tight">Model</h1>
        <p className="mt-0.5 text-xs text-muted-foreground">Kelola model tiap mesin — unduh, pilih aktif, hapus.</p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-5 px-4 py-5">
          {/* tab per mesin */}
          <div className="flex gap-1 rounded-2xl bg-muted p-1">
            {KINDS.map((k) => (
              <button
                key={k.id}
                onClick={() => setKind(k.id)}
                className={cn(
                  "min-w-0 flex-1 truncate rounded-xl px-2 py-2 text-xs font-medium transition-colors sm:px-3 sm:text-sm",
                  kind === k.id ? "bg-panel-models text-white shadow-md shadow-panel-models/30" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {k.label}
              </button>
            ))}
          </div>

          {loading && <Empty>Memuat…</Empty>}
          {error && <Empty>{error}</Empty>}

          {/* progres pemuatan model ke mesin */}
          {engineStatus.load?.active && (
            <div className="rounded-2xl border border-panel-models/30 bg-panel-models/5 p-3.5">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-1.5 font-medium text-panel-models">
                  <Loader2 className="size-3.5 animate-spin" /> {engineStatus.load.phase || "Memuat model…"}
                </span>
                <span className="font-mono text-muted-foreground">
                  {engineStatus.load.progress ? `${engineStatus.load.progress}%` : ""}
                  {engineStatus.load.speed ? ` · ${engineStatus.load.speed}` : ""}
                </span>
              </div>
              <Bar pct={engineStatus.load.progress || 0} />
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="space-y-2">
                <SectionTitle>Terpasang</SectionTitle>
                {installed.models.length === 0 && <Empty>Belum ada model {activeKind.label} terpasang.</Empty>}
                {installed.models.map((m) => {
                  const active = m === installed.active;
                  return (
                    <div key={m} className={cn("flex items-center gap-3 rounded-2xl border bg-card px-4 py-3", active ? "border-panel-models/50" : "border-border")}>
                      <HardDrive className={cn("size-4 flex-none", active ? "text-panel-models" : "text-muted-foreground")} />
                      <div className="min-w-0 flex-1 truncate font-mono text-sm">{m}</div>
                      {active ? (
                        <span className="flex flex-none items-center gap-1 rounded-full bg-panel-models/15 px-2.5 py-1 text-xs font-medium text-panel-models">
                          <Check size={13} /> Aktif
                        </span>
                      ) : (
                        <button onClick={() => onUse(m)} className="flex-none rounded-full bg-panel-models px-3.5 py-1.5 text-xs font-semibold text-white transition hover:brightness-110">
                          Pakai
                        </button>
                      )}
                      <button onClick={() => onDelete(m)} aria-label="Hapus" className="flex-none rounded-lg p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
              </div>

              {/* Unduh via URL Hugging Face — di bawah daftar Terpasang */}
              {!activeKind.noCustom && (
                <div className="space-y-2">
                  <SectionTitle>Unduh via URL Hugging Face ({activeKind.ext})</SectionTitle>
                  <div className="flex gap-2">
                    <input
                      value={customUrl}
                      onChange={(e) => setCustomUrl(e.target.value)}
                      placeholder="https://huggingface.co/…"
                      className="min-w-0 flex-1 rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none transition-colors focus:border-panel-models/60"
                    />
                    <button onClick={onCustomInstall} className="inline-flex flex-none items-center gap-1.5 rounded-xl bg-panel-models px-4 py-2 text-sm font-semibold text-white transition hover:brightness-110">
                      <Download size={14} /> Unduh
                    </button>
                  </div>
                  {/* progress unduhan URL kustom (atau yang tak cocok kartu) */}
                  {progress && !inCard && (
                    <div className="rounded-2xl border border-panel-models/30 bg-panel-models/5 p-3.5">
                      <DownloadProgress progress={progress} onCancel={() => Api.cancelDownload(kind)} />
                    </div>
                  )}
                </div>
              )}

              {/* fallback progress untuk mesin tanpa URL kustom (mis. TTS) */}
              {activeKind.noCustom && progress && !inCard && (
                <div className="rounded-2xl border border-panel-models/30 bg-panel-models/5 p-3.5">
                  <DownloadProgress progress={progress} onCancel={() => Api.cancelDownload(kind)} />
                </div>
              )}

              <div className="space-y-2">
                <SectionTitle>Tersedia untuk diunduh</SectionTitle>
                {catalog.map((item) => (
                  <div key={item.file} className="rounded-2xl border border-border bg-card p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{item.name}</span>
                          {item.multimodal && (
                            <span className="inline-flex items-center gap-1 rounded-full bg-panel-image/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-panel-image">
                              <Eye size={10} /> Vision
                            </span>
                          )}
                        </div>
                        {item.note && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.note}</p>}
                      </div>
                      <div className="flex-none text-right font-mono text-xs text-muted-foreground">
                        {item.sizeBytes ? formatBytes(item.sizeBytes) : item.size || ""}
                        {item.projectorSizeBytes ? <div className="text-[10px] opacity-70">+ {formatBytes(item.projectorSizeBytes)} proyektor</div> : null}
                      </div>
                    </div>
                    {progress && downloadingFile === item.file ? (
                      <div className="mt-3">
                        <DownloadProgress progress={progress} onCancel={() => Api.cancelDownload(kind)} />
                      </div>
                    ) : (
                      <div className="mt-3 flex justify-end">
                        {item.installed ? (
                          <span className="rounded-full bg-muted px-2.5 py-1 text-xs text-muted-foreground">Terpasang</span>
                        ) : (
                          <button
                            onClick={() => onInstall(item.url, item.projectorUrl, item.file)}
                            className="inline-flex items-center gap-1.5 rounded-full bg-panel-models/15 px-3.5 py-1.5 text-xs font-semibold text-panel-models transition hover:bg-panel-models hover:text-white"
                          >
                            <Download size={13} /> Pasang
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</div>;
}

function Empty({ children }) {
  return <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-6 text-center text-sm text-muted-foreground">{children}</div>;
}

function Bar({ pct }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div className="h-full rounded-full bg-panel-models transition-all duration-300" style={{ width: `${pct}%` }} />
    </div>
  );
}

// DownloadProgress: bar + label + tombol batal. Dipakai di dalam kartu model
// (unduhan katalog) maupun di atas (unduhan URL kustom).
function DownloadProgress({ progress, onCancel }) {
  return (
    <div>
      <Bar pct={progress.percent || 0} />
      <div className="mt-2 flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate text-panel-models">{progress.label || "Mengunduh…"}</span>
        <span className="flex flex-none items-center gap-2">
          <span className="font-mono text-muted-foreground">
            {progress.total ? `${formatBytes(progress.downloaded)} / ${formatBytes(progress.total)} (${progress.percent}%)` : ""}
          </span>
          <button onClick={onCancel} className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-1 text-muted-foreground transition hover:text-destructive">
            <X size={12} /> Batal
          </button>
        </span>
      </div>
    </div>
  );
}
