import { useEffect, useState } from "react";
import { MessageSquare, Image as ImageIcon, Key, Check, Trash2, ExternalLink } from "lucide-react";
import { Api } from "../services/api.js";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

export default function Settings() {
  const [settings, setSettings] = useState(null);
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [chatModels, setChatModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [ctxDraft, setCtxDraft] = useState({});
  const [ctxLimits, setCtxLimits] = useState({});

  useEffect(() => {
    Api.getSettings().then(setSettings).catch(() => {});
    Api.models("llm")
      .then((d) => {
        setChatModels(d.models || []);
        setActiveModel(d.active || "");
      })
      .catch(() => {});
    Api.ctxLimits()
      .then((d) => setCtxLimits(d.limits || {}))
      .catch(() => {});
  }, []);

  // Seed input context dari setelan tersimpan (dan setiap kali setelan/model
  // berubah). Field default selalu ada; per-model kosong = pakai default.
  useEffect(() => {
    if (!settings) return;
    const d = { __default: String(settings.contextSizeDefault ?? 4096) };
    for (const f of chatModels) d[f] = settings.contextSizes?.[f] ? String(settings.contextSizes[f]) : "";
    setCtxDraft(d);
  }, [settings, chatModels]);

  function flashSaved() {
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1500);
  }

  async function saveKey() {
    const key = keyInput.trim();
    if (!key) return;
    setSavingKey(true);
    try {
      setSettings(await Api.updateSettings({ braveApiKey: key }));
      setKeyInput("");
      flashSaved();
    } catch (err) {
      alert(err.message);
    } finally {
      setSavingKey(false);
    }
  }

  async function deleteKey() {
    if (!confirm("Hapus Brave API key?")) return;
    try {
      setSettings(await Api.updateSettings({ braveApiKey: "" }));
    } catch (err) {
      alert(err.message);
    }
  }

  async function changeImageSize(size) {
    try {
      setSettings(await Api.updateSettings({ imageSize: size }));
      flashSaved();
    } catch (err) {
      alert(err.message);
    }
  }

  async function patchSettings(patch) {
    try {
      setSettings(await Api.updateSettings(patch));
      flashSaved();
    } catch (err) {
      alert(err.message);
    }
  }

  const setDraft = (key, v) => setCtxDraft((d) => ({ ...d, [key]: v }));

  function commitDefaultCtx() {
    const v = parseInt(ctxDraft.__default, 10);
    if (Number.isFinite(v) && v !== settings.contextSizeDefault) patchSettings({ contextSizeDefault: v });
  }

  function commitModelCtx(file) {
    const raw = ctxDraft[file];
    let v = raw === "" || raw == null ? 0 : parseInt(raw, 10);
    if (!Number.isFinite(v)) v = 0;
    // Jangan biarkan melebihi context latih model (n_ctx_train).
    const limit = ctxLimits[file];
    if (limit && v > limit) {
      v = limit;
      setDraft(file, String(limit));
    }
    const cur = settings.contextSizes?.[file] || 0;
    if (v !== cur) patchSettings({ contextSizes: { [file]: v } });
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold leading-tight">Pengaturan</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Setelan tiap mesin — berlaku langsung, tersimpan otomatis.</p>
        </div>
        {savedFlash && (
          <span className="flex flex-none items-center gap-1.5 rounded-full bg-success/15 px-3 py-1 text-xs font-medium text-success">
            <Check size={14} /> Tersimpan
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6 px-4 py-6">
          {!settings ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">Memuat pengaturan…</div>
          ) : (
            <>
              {/* ---- Chat ---- */}
              <Section icon={MessageSquare} accent="chat" title="Chat">
                <Row
                  stacked
                  label="Brave Search API Key"
                  desc={
                    <>
                      Opsional — bikin mode web lebih andal. Tanpa key tetap jalan (scraping).{" "}
                      <a href="https://api-dashboard.search.brave.com/register" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-panel-chat hover:underline">
                        Dapatkan key <ExternalLink size={11} />
                      </a>
                    </>
                  }
                >
                  {settings.braveApiKeySet ? (
                    <div className="flex items-center gap-2">
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-success/15 px-3 py-1.5 text-xs font-medium text-success">
                        <Key size={13} /> Key tersimpan
                      </span>
                      <button onClick={deleteKey} className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive">
                        <Trash2 size={13} /> Hapus
                      </button>
                    </div>
                  ) : (
                    <div className="flex gap-2">
                      <input
                        type="password"
                        placeholder="Tempel Brave API key di sini…"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && saveKey()}
                        className="min-w-0 flex-1 rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-panel-chat/60"
                      />
                      <button onClick={saveKey} disabled={savingKey || !keyInput.trim()} className="flex-none rounded-xl bg-panel-chat px-4 py-2 text-sm font-semibold text-white transition enabled:hover:brightness-110 disabled:opacity-50">
                        {savingKey ? "Menyimpan…" : "Simpan"}
                      </button>
                    </div>
                  )}
                </Row>

                <Row label="Mode berpikir model" desc="Untuk model reasoning — berpikir dulu, atau langsung menjawab.">
                  <label className="flex cursor-pointer items-center gap-3">
                    <Switch checked={settings.thinkingEnabled} onCheckedChange={(v) => patchSettings({ thinkingEnabled: v })} />
                    <span className="font-mono text-xs text-muted-foreground">{settings.thinkingEnabled ? "Aktif" : "Nonaktif"}</span>
                  </label>
                </Row>

                {settings.thinkingEnabled && (
                  <Row label="Tampilan alur berpikir" desc='Tampilkan alur berpikirnya, atau cukup indikator "berpikir…".'>
                    <Select value={settings.thinkingMode} onChange={(e) => patchSettings({ thinkingMode: e.target.value })} accent="chat">
                      <option value="show">Tampilkan alur berpikir</option>
                      <option value="hide">Sembunyikan (hanya "berpikir…")</option>
                    </Select>
                  </Row>
                )}

                <Row
                  stacked
                  label="Context window (n_ctx)"
                  desc="Token maks per percakapan. Lebih besar = butuh RAM/VRAM lebih. Mengubah model aktif me-restart mesin."
                >
                  <div className="overflow-hidden rounded-2xl border border-border">
                    <CtxLine>
                      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">Default (semua model)</span>
                      <CtxInput
                        value={ctxDraft.__default ?? ""}
                        onChange={(e) => setDraft("__default", e.target.value)}
                        onBlur={commitDefaultCtx}
                        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                      />
                      <span className="w-8 flex-none font-mono text-[11px] text-muted-foreground">token</span>
                    </CtxLine>

                    {chatModels.length > 0 && (
                      <>
                        <div className="bg-muted/40 px-3.5 py-2 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Override per model</div>
                        {chatModels.map((f) => (
                          <CtxLine key={f}>
                            <span className="flex min-w-0 flex-1 items-center gap-2 text-xs" title={f}>
                              <span className="truncate">{f}</span>
                              {f === activeModel && <span className="flex-none rounded-full bg-panel-chat/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-panel-chat">aktif</span>}
                              {ctxLimits[f] > 0 && <span className="hidden flex-none rounded-full border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground sm:inline">maks {ctxLimits[f].toLocaleString("id-ID")}</span>}
                            </span>
                            <CtxInput
                              max={ctxLimits[f] || undefined}
                              placeholder={`${settings.contextSizeDefault}`}
                              value={ctxDraft[f] ?? ""}
                              onChange={(e) => setDraft(f, e.target.value)}
                              onBlur={() => commitModelCtx(f)}
                              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                            />
                            <span className="w-8 flex-none font-mono text-[11px] text-muted-foreground">token</span>
                          </CtxLine>
                        ))}
                      </>
                    )}
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                    Kosongkan = pakai default. Badge <b className="text-foreground">maks</b> = batas context model.
                  </p>
                </Row>
              </Section>

              {/* ---- Gambar ---- */}
              <Section icon={ImageIcon} accent="image" title="Gambar">
                <Row label="Ukuran gambar default" desc="Dipakai di panel Gambar.">
                  <Select value={settings.imageSize} onChange={(e) => changeImageSize(e.target.value)} accent="image">
                    <option value="512x512">512 × 512</option>
                    <option value="768x768">768 × 768</option>
                    <option value="1024x1024">1024 × 1024</option>
                  </Select>
                </Row>
              </Section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

const ACCENT = {
  chat: "bg-panel-chat/15 text-panel-chat",
  image: "bg-panel-image/15 text-panel-image",
};

// Section: kartu satu mesin — header (ikon ber-badge + judul) lalu daftar baris
// setelan yang dipisah divider.
function Section({ icon: Icon, accent = "chat", title, children }) {
  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-card">
      <div className="flex items-center gap-2.5 border-b border-border px-5 py-3.5">
        <span className={cn("flex size-8 flex-none items-center justify-center rounded-xl", ACCENT[accent])}>
          <Icon className="size-4" />
        </span>
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="divide-y divide-border px-5">{children}</div>
    </section>
  );
}

// Row: satu setelan. Default = label/deskripsi di kiri, kontrol di kanan
// (menumpuk di mobile). stacked = kontrol full-width di bawah label (untuk
// input panjang seperti API key & tabel context window).
function Row({ label, desc, children, stacked }) {
  return (
    <div className={cn("py-4", stacked ? "space-y-3" : "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6")}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{label}</div>
        {desc && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{desc}</p>}
      </div>
      <div className={cn(!stacked && "flex-none")}>{children}</div>
    </div>
  );
}

function Select({ accent = "chat", className, ...props }) {
  return (
    <select
      {...props}
      className={cn(
        "w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none transition-colors sm:w-auto sm:min-w-[220px]",
        accent === "image" ? "focus:border-panel-image/60" : "focus:border-panel-chat/60",
        className,
      )}
    />
  );
}

// CtxLine: satu baris di tabel context window (dipisah garis, gap konsisten).
function CtxLine({ children }) {
  return <div className="flex items-center gap-3 border-b border-border px-3.5 py-2.5 last:border-b-0">{children}</div>;
}

function CtxInput(props) {
  return (
    <input
      type="number"
      min={512}
      step={512}
      {...props}
      className="w-24 flex-none rounded-lg border border-border bg-background px-2.5 py-1.5 text-right font-mono text-sm outline-none transition-colors focus:border-panel-chat/60 sm:w-28"
    />
  );
}
