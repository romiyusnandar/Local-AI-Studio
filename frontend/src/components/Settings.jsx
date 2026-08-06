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
        <div className="mx-auto max-w-2xl space-y-5 px-4 py-5">
          {!settings ? (
            <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-10 text-center text-sm text-muted-foreground">Memuat pengaturan…</div>
          ) : (
            <>
              {/* ---- Chat ---- */}
              <section className="space-y-6 rounded-3xl border border-border bg-card p-5">
                <SectionTitle icon={MessageSquare} color="text-panel-chat">Chat</SectionTitle>

                <Field label="Brave Search API Key">
                  <Help>
                    Opsional — bikin mode web lebih andal. Tanpa key tetap jalan (scraping).{" "}
                    <a href="https://api-dashboard.search.brave.com/register" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-panel-chat hover:underline">
                      Dapatkan key <ExternalLink size={11} />
                    </a>
                  </Help>
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
                </Field>

                <Field label="Mode berpikir model">
                  <Help>Untuk model reasoning — berpikir dulu, atau langsung menjawab.</Help>
                  <div className="flex items-center gap-3">
                    <Switch checked={settings.thinkingEnabled} onCheckedChange={(v) => patchSettings({ thinkingEnabled: v })} />
                    <span className="font-mono text-xs text-muted-foreground">{settings.thinkingEnabled ? "Aktif" : "Nonaktif"}</span>
                  </div>
                </Field>

                {settings.thinkingEnabled && (
                  <Field label="Tampilan alur berpikir">
                    <Help>Tampilkan alur berpikirnya, atau cukup indikator "berpikir…".</Help>
                    <Select value={settings.thinkingMode} onChange={(e) => patchSettings({ thinkingMode: e.target.value })} accent="chat">
                      <option value="show">Tampilkan alur berpikir</option>
                      <option value="hide">Sembunyikan (hanya "berpikir…")</option>
                    </Select>
                  </Field>
                )}

                <Field label="Context window (n_ctx)">
                  <Help>Token maks per percakapan. Lebih besar = butuh RAM/VRAM lebih. Mengubah model aktif me-restart mesin.</Help>

                  <CtxRow>
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">Default (semua model)</span>
                    <CtxInput
                      value={ctxDraft.__default ?? ""}
                      onChange={(e) => setDraft("__default", e.target.value)}
                      onBlur={commitDefaultCtx}
                      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                    />
                    <span className="w-9 flex-none font-mono text-[11px] text-muted-foreground">token</span>
                  </CtxRow>

                  {chatModels.length > 0 && (
                    <>
                      <div className="pt-1 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Override per model</div>
                      {chatModels.map((f) => (
                        <CtxRow key={f}>
                          <span className="flex min-w-0 flex-1 items-center gap-2 text-xs" title={f}>
                            <span className="truncate">{f}</span>
                            {f === activeModel && <span className="flex-none rounded-full bg-panel-chat/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-panel-chat">aktif</span>}
                            {ctxLimits[f] > 0 && <span className="flex-none rounded-full border border-border px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground">maks {ctxLimits[f].toLocaleString("id-ID")}</span>}
                          </span>
                          <CtxInput
                            max={ctxLimits[f] || undefined}
                            placeholder={`${settings.contextSizeDefault}`}
                            value={ctxDraft[f] ?? ""}
                            onChange={(e) => setDraft(f, e.target.value)}
                            onBlur={() => commitModelCtx(f)}
                            onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
                          />
                          <span className="w-9 flex-none font-mono text-[11px] text-muted-foreground">token</span>
                        </CtxRow>
                      ))}
                      <Help>Kosongkan = pakai default. Badge <b className="text-foreground">maks</b> = batas context model.</Help>
                    </>
                  )}
                </Field>
              </section>

              {/* ---- Gambar ---- */}
              <section className="space-y-6 rounded-3xl border border-border bg-card p-5">
                <SectionTitle icon={ImageIcon} color="text-panel-image">Gambar</SectionTitle>
                <Field label="Ukuran gambar default">
                  <Help>Dipakai di panel Gambar.</Help>
                  <Select value={settings.imageSize} onChange={(e) => changeImageSize(e.target.value)} accent="image">
                    <option value="512x512">512 × 512</option>
                    <option value="768x768">768 × 768</option>
                    <option value="1024x1024">1024 × 1024</option>
                  </Select>
                </Field>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ icon: Icon, color, children }) {
  return (
    <div className="flex items-center gap-2 text-sm font-semibold">
      <Icon className={cn("size-4", color)} />
      <span>{children}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div className="space-y-2.5">
      <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      {children}
    </div>
  );
}

function Help({ children }) {
  return <p className="text-xs leading-relaxed text-muted-foreground">{children}</p>;
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

function CtxRow({ children }) {
  return <div className="flex items-center gap-2.5">{children}</div>;
}

function CtxInput(props) {
  return (
    <input
      type="number"
      min={512}
      step={512}
      {...props}
      className="w-28 flex-none rounded-xl border border-border bg-background px-3 py-1.5 text-right font-mono text-sm outline-none transition-colors focus:border-panel-chat/60"
    />
  );
}
