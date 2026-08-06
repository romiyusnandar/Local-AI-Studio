import { useEffect, useRef, useState } from "react";
import { Paperclip, ArrowUp, X, Square, Globe, Sparkles, Boxes, Copy, Check, Loader2 } from "lucide-react";
import { Api } from "../services/api.js";
import { engineStatusText } from "../lib/status.js";
import Markdown from "./Markdown.jsx";
import { cn } from "@/lib/utils";

// resizeImageToDataUrl memperkecil gambar (sisi terpanjang ≤ maxDim) sebelum
// dikirim ke model vision. Gambar besar diubah jadi ratusan/ribuan "token
// visual" yang SANGAT lambat diproses di CPU/GPU terintegrasi (mis. foto
// 1835px bisa >3 menit). Perkecil ke ~1024px memangkasnya drastis tanpa
// banyak kehilangan detail. Encode JPEG supaya payload kecil.
function resizeImageToDataUrl(file, maxDim = 1024) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(canvas.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = reject;
    img.src = url;
  });
}

// splitThinking memisahkan output model reasoning menjadi bagian "berpikir"
// (di dalam <think>…</think>) dan "jawaban" (di luarnya). Model biasa yang
// tidak memakai <think> otomatis dianggap seluruhnya sebagai jawaban.
function splitThinking(raw) {
  const openIdx = raw.indexOf("<think>");
  if (openIdx === -1) return { hasThink: false, thinkDone: false, thinking: "", answer: raw };
  const afterOpen = raw.slice(openIdx + 7); // panjang "<think>"
  const closeIdx = afterOpen.indexOf("</think>");
  if (closeIdx === -1) {
    return { hasThink: true, thinkDone: false, thinking: afterOpen, answer: raw.slice(0, openIdx) };
  }
  const thinking = afterOpen.slice(0, closeIdx);
  const answer = (raw.slice(0, openIdx) + afterOpen.slice(closeIdx + 8)).replace(/^\s+/, ""); // panjang "</think>"
  return { hasThink: true, thinkDone: true, thinking, answer };
}

// fmtDuration merangkai lama waktu: "3.2s" atau "1m 5s".
function fmtDuration(s) {
  if (!s || s < 0) return "0s";
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}m ${sec}s`;
}

// CopyButton: aksi salin untuk isi pesan asisten (muncul saat hover).
function CopyButton({ text }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // diabaikan
        }
      }}
      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] text-muted-foreground opacity-0 transition hover:bg-muted hover:text-foreground group-hover:opacity-100"
      title="Salin jawaban"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      <span>{copied ? "Tersalin" : "Salin"}</span>
    </button>
  );
}

export default function Chat({ onOpenModels }) {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [attachedImage, setAttachedImage] = useState(null);
  const [sending, setSending] = useState(false);
  const [sessionTokens, setSessionTokens] = useState(0);
  const [webMode, setWebMode] = useState(false);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [thinkingMode, setThinkingMode] = useState("show");

  const abortRef = useRef(null);
  const bodyRef = useRef(null);
  const fileInputRef = useRef(null);
  const taRef = useRef(null); // textarea composer (auto-grow ≤ 3 baris)
  const carriedWebRef = useRef(""); // konteks pencarian web terakhir, dibawa ke follow-up
  const thinkEnabledRef = useRef(true);
  const pinnedRef = useRef(true); // true = ikuti stream ke bawah otomatis
  const thinkBodyRef = useRef(null); // kotak reasoning live (scroll internal)
  const thinkPinnedRef = useRef(true); // ikuti stream di dalam kotak reasoning

  // onBodyScroll menandai apakah pengguna sedang menempel di bawah. Kalau
  // mereka scroll ke atas (untuk membaca), auto-scroll berhenti; begitu
  // kembali ke bawah, auto-scroll aktif lagi.
  function onBodyScroll() {
    const el = bodyRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }

  // onThinkScroll: sama seperti onBodyScroll tapi untuk kotak reasoning —
  // auto-scroll internal berhenti kalau user menggulir ke atas di dalamnya.
  function onThinkScroll(e) {
    const el = e.currentTarget;
    thinkPinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }

  useEffect(() => {
    refreshStatus();
    // Setelan berpikir dibaca dari Pengaturan. Disimpan juga di ref supaya
    // nilai terbaru terpakai di dalam handler streaming tanpa stale closure.
    Api.getSettings()
      .then((s) => {
        setThinkingEnabled(s.thinkingEnabled !== false);
        thinkEnabledRef.current = s.thinkingEnabled !== false;
        setThinkingMode(s.thinkingMode || "show");
      })
      .catch(() => {});
    // 1.2s: cukup responsif untuk menampilkan progres pemuatan model.
    const t = setInterval(refreshStatus, 1200);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
    // Kotak reasoning live: auto-scroll internal mengikuti stream reasoning.
    const tb = thinkBodyRef.current;
    if (tb && thinkPinnedRef.current) tb.scrollTop = tb.scrollHeight;
  }, [messages]);

  // Model non-vision → buang lampiran gambar yang mungkin masih tersisa.
  useEffect(() => {
    if (!status.multimodal && attachedImage) setAttachedImage(null);
  }, [status.multimodal]);

  // Auto-grow textarea mengikuti isi, dibatasi 3 baris lalu baru scroll.
  // Dihitung dari line-height + padding aktual supaya tahan beda font/zoom.
  useEffect(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight) || 20;
    const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
    const max = lh * 3 + pad;
    el.style.height = Math.min(el.scrollHeight, max) + "px";
    el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
  }, [input]);

  async function refreshStatus() {
    try {
      setStatus(await Api.status());
    } catch {
      // aplikasi baru buka / offline sesaat
    }
  }

  async function onAttachFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      setAttachedImage(await resizeImageToDataUrl(file));
    } catch {
      alert("Gagal membaca gambar.");
    }
  }

  async function sendMessage(e) {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    if (!status.mesinHidup) {
      alert("Mesin chat sedang mati — pilih model dulu.");
      return;
    }

    const userMsg = { role: "user", content: text, image: attachedImage };
    const hadImage = !!attachedImage;
    const apiContent = hadImage
      ? [
          { type: "text", text },
          { type: "image_url", image_url: { url: attachedImage } },
        ]
      : text;

    const history = [...messages, userMsg];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setAttachedImage(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
    setSending(true);
    pinnedRef.current = true; // kirim pesan baru → selalu ikuti ke bawah
    thinkPinnedRef.current = true; // reasoning baru → ikuti dari awal

    const apiMessages = history.map((m, i) =>
      i === history.length - 1 && hadImage ? { role: m.role, content: apiContent } : { role: m.role, content: m.content }
    );

    try {
      abortRef.current = new AbortController();
      // stream_options.include_usage minta llama-server mengirim satu chunk
      // usage terakhir (prompt/completion/total tokens) supaya angkanya pasti,
      // bukan cuma perkiraan dari jumlah delta.
      const res = await Api.chatStream(
        // max_tokens = -1: tak ada batas panjang balasan — model berhenti
        // sendiri saat mengeluarkan token stop/EOS. Batas keras satu-satunya
        // jadi ukuran context window (n_ctx); kalau model "kabur" mengulang
        // teks, tombol Stop bisa menghentikannya manual.
        // useWeb mengaktifkan mode browsing: server mencari di web dan
        // menyuntikkan hasilnya sebagai konteks sebelum menjawab.
        // chat_template_kwargs.enable_thinking mengontrol mode berpikir untuk
        // model reasoning (mis. Qwen3) — false = model langsung menjawab.
        {
          messages: apiMessages,
          stream: true,
          max_tokens: -1,
          useWeb: webMode,
          // konteks pencarian sebelumnya (dibawa supaya follow-up tetap grounding)
          carriedWebContext: webMode ? carriedWebRef.current : "",
          chat_template_kwargs: { enable_thinking: thinkingEnabled },
          stream_options: { include_usage: true },
        },
        abortRef.current.signal
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "permintaan gagal" }));
        throw new Error(err.error || "permintaan gagal");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let assistantText = ""; // delta.content = jawaban final
      let reasoningText = ""; // delta.reasoning_content = alur berpikir
      let tokenCount = 0; // perkiraan live total token
      let thinkTokens = 0; // token alur berpikir
      let thinkStart = 0; // waktu mulai berpikir (delta reasoning pertama)
      let thinkEnd = 0; // waktu berpikir selesai (delta content pertama)
      let usage = null;
      let tps = 0;
      let webSources = [];
      let webErr = "";
      let webSkipped = false;
      let webReused = false;
      let webSearching = false;
      const startedAt = Date.now();

      const pushUpdate = () => {
        // Reasoning bisa datang lewat field reasoning_content (llama.cpp baru)
        // ATAU sebagai tag <think> di dalam content (build/model lama). Dukung
        // keduanya.
        const parsed = reasoningText
          ? { hasThink: true, thinking: reasoningText, answer: assistantText, thinkDone: assistantText.length > 0 }
          : splitThinking(assistantText);
        // Lama berpikir: dari delta reasoning pertama sampai jawaban muncul
        // (atau "sekarang" kalau masih berpikir).
        const thinkSeconds = thinkStart ? ((thinkEnd || Date.now()) - thinkStart) / 1000 : 0;
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: parsed.answer,
            hasThink: parsed.hasThink,
            thinkDone: parsed.thinkDone,
            thinking: parsed.thinking,
            thinkTokens,
            thinkSeconds,
            tokens: usage ? usage.completion_tokens : tokenCount,
            total: usage ? usage.total_tokens : null,
            tps,
            sources: webSources,
            webError: webErr,
            webSkipped,
            webReused,
            webSearching,
          };
          return next;
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") continue;
          try {
            const obj = JSON.parse(payload);
            // event: web_status — indikator "sedang mencari" (dikirim server
            // sebelum pencarian, karena pencarian bisa belasan detik).
            if (obj.searching !== undefined) {
              webSearching = obj.searching;
              pushUpdate();
              continue;
            }
            // event: web_sources — dikirim server setelah pencarian selesai.
            if (obj.sources !== undefined) {
              webSearching = false; // pencarian selesai
              webSources = obj.sources || [];
              webErr = obj.error || "";
              webSkipped = obj.skipped || false;
              webReused = obj.reused || false;
              // simpan konteks pencarian baru untuk dibawa ke follow-up
              if (obj.context) carriedWebRef.current = obj.context;
              pushUpdate();
              continue;
            }
            // chunk usage/timings terakhir: choices kosong, ada angka pasti
            if (obj.usage) usage = obj.usage;
            if (obj.timings && obj.timings.predicted_per_second) {
              tps = Math.round(obj.timings.predicted_per_second);
            }
            const delta = obj.choices?.[0]?.delta;
            const secs = () => (Date.now() - startedAt) / 1000;

            // Alur berpikir (field terpisah dari llama.cpp baru).
            if (delta?.reasoning_content) {
              if (!thinkStart) thinkStart = Date.now();
              reasoningText += delta.reasoning_content;
              thinkTokens++;
              tokenCount++;
              if (secs() > 0) tps = Math.round(tokenCount / secs());
              pushUpdate();
            }
            // Jawaban (dan/atau <think> untuk build/model lama).
            if (delta?.content) {
              assistantText += delta.content;
              tokenCount++;
              if (reasoningText) {
                // path reasoning_content: konten pertama = berpikir selesai
                if (thinkStart && !thinkEnd) thinkEnd = Date.now();
              } else {
                // path <think> di dalam content: lacak buka/tutup tag
                const s = splitThinking(assistantText);
                if (s.hasThink && !thinkStart) thinkStart = Date.now();
                if (s.hasThink && !s.thinkDone) thinkTokens++;
                if (s.thinkDone && thinkStart && !thinkEnd) thinkEnd = Date.now();
              }
              if (secs() > 0) tps = Math.round(tokenCount / secs());
              pushUpdate();
            }
          } catch {
            // potongan JSON belum utuh
          }
        }
      }
      pushUpdate();
      const used = usage ? usage.total_tokens : tokenCount;
      if (used) setSessionTokens((n) => n + used);
    } catch (err) {
      if (err.name !== "AbortError") {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = { role: "assistant", content: `(gagal: ${err.message})` };
          return next;
        });
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage(e);
    }
  }

  // stopGeneration membatalkan request stream. Client yang memutus koneksi
  // membuat server membatalkan request ke llama-server (lihat handleChat),
  // sehingga generasi benar-benar berhenti, bukan cuma disembunyikan di UI.
  function stopGeneration() {
    abortRef.current?.abort();
  }

  const loading = status.load?.active;

  return (
    <div className="flex h-full flex-col">
      {/* ---- header ---- */}
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Chat</h1>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted-foreground">
            <span className={cn("size-2 flex-none rounded-full", status.mesinHidup ? "bg-panel-chat shadow-[0_0_8px_var(--panel-chat)]" : "bg-muted-foreground/40")} />
            <span className="truncate">{engineStatusText(status, "chat")}</span>
          </div>
          {loading && (
            <div className="mt-2 h-1 w-56 max-w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full rounded-full bg-panel-chat transition-all duration-500" style={{ width: `${status.load.progress || 0}%` }} />
            </div>
          )}
        </div>
        {sessionTokens > 0 && (
          <span className="flex-none rounded-full bg-muted px-2.5 py-1 font-mono text-[11px] text-muted-foreground" title="Total token sesi ini">
            Σ {sessionTokens.toLocaleString()}
          </span>
        )}
      </header>

      {/* ---- daftar pesan ---- */}
      <div ref={bodyRef} onScroll={onBodyScroll} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-6 px-4 py-6">
          {messages.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-panel-chat to-panel-image text-white shadow-xl shadow-panel-chat/30">
                <Sparkles className="size-7" />
              </div>
              <h2 className="bg-gradient-to-r from-panel-chat to-panel-image bg-clip-text text-2xl font-bold text-transparent">Halo! Mau ngobrol apa?</h2>
              <p className="max-w-xs text-sm text-muted-foreground">Pilih model lewat pill di bawah, lalu tulis pesanmu. Bisa lampirkan gambar (model vision) atau cari di web.</p>
            </div>
          ) : (
            messages.map((m, i) => (
              <MessageRow
                key={i}
                m={m}
                isStreaming={sending && i === messages.length - 1}
                thinkingEnabled={thinkingEnabled}
                thinkingMode={thinkingMode}
                thinkBodyRef={thinkBodyRef}
                onThinkScroll={onThinkScroll}
              />
            ))
          )}
        </div>
      </div>

      {/* ---- composer terpadu ---- */}
      <div className="flex-none px-4 pb-4 pt-1">
        <form onSubmit={sendMessage} className="mx-auto w-full max-w-3xl">
          {attachedImage && (
            <div className="mb-2 inline-flex items-center gap-2 rounded-2xl border border-border bg-card px-2.5 py-1.5 text-xs text-muted-foreground">
              <img src={attachedImage} alt="" className="size-8 rounded-lg object-cover" />
              <span>gambar terlampir</span>
              <button type="button" onClick={() => setAttachedImage(null)} aria-label="Hapus lampiran" className="rounded-md p-0.5 hover:bg-muted hover:text-foreground">
                <X size={14} />
              </button>
            </div>
          )}
          <div className="rounded-[1.75rem] border border-border bg-card p-2.5 shadow-sm transition-colors focus-within:border-panel-chat/60">
            <textarea
              ref={taRef}
              rows={1}
              placeholder="Tulis pesan… (Enter untuk kirim, Shift+Enter baris baru)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              className="w-full resize-none overflow-y-hidden bg-transparent px-2 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
            <div className="flex items-center gap-1.5">
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={onAttachFile} />
              <IconToggle
                onClick={() => fileInputRef.current.click()}
                disabled={!status.multimodal}
                title={status.multimodal ? "Lampirkan gambar" : "Model aktif tidak mendukung gambar — pilih model vision di Model Manager"}
              >
                <Paperclip size={17} />
              </IconToggle>
              <IconToggle
                active={webMode}
                accent="chat"
                onClick={() => setWebMode((v) => { if (v) carriedWebRef.current = ""; return !v; })}
                title={webMode ? "Mode web aktif — cari di internet sebelum menjawab" : "Aktifkan mode web (cari di internet)"}
                aria-pressed={webMode}
              >
                <Globe size={17} />
              </IconToggle>

              <button
                type="button"
                onClick={onOpenModels}
                title="Kelola / ganti model di Model Manager"
                className="ml-auto flex min-w-0 items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <Boxes size={13} className="flex-none" />
                <span className={cn("max-w-[10rem] truncate", !status.model && "text-panel-chat")}>{status.model || "Pilih model"}</span>
              </button>

              {sending ? (
                <button type="button" onClick={stopGeneration} title="Hentikan" className="flex size-9 flex-none items-center justify-center rounded-full bg-destructive text-destructive-foreground transition hover:brightness-110">
                  <Square size={15} className="fill-current" />
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={!input.trim()}
                  title="Kirim"
                  className="flex size-9 flex-none items-center justify-center rounded-full bg-gradient-to-br from-panel-chat to-panel-image text-white shadow-lg shadow-panel-chat/30 transition enabled:hover:brightness-110 disabled:opacity-40"
                >
                  <ArrowUp size={18} />
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// IconToggle: tombol ikon kecil di composer; bisa aktif (ber-aksen) & disabled.
function IconToggle({ children, active, accent = "chat", disabled, ...props }) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={cn(
        "flex size-9 flex-none items-center justify-center rounded-full transition-colors",
        active ? "bg-panel-chat/15 text-panel-chat" : "text-muted-foreground hover:bg-muted hover:text-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground",
      )}
      {...props}
    >
      {children}
    </button>
  );
}

// MessageRow: satu baris pesan (user atau asisten) beserta sumber web, alur
// berpikir, jawaban markdown, dan statistik token.
function MessageRow({ m, thinkingEnabled, thinkingMode, thinkBodyRef, onThinkScroll, isStreaming }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] space-y-2">
          {m.image && <img src={m.image} alt="lampiran" className="ml-auto max-h-64 rounded-2xl border border-border object-contain" />}
          <div className="rounded-3xl rounded-br-md bg-panel-chat/15 px-4 py-2.5 text-sm leading-relaxed text-foreground">{m.content}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="group flex gap-3">
      <div className="mt-0.5 flex size-8 flex-none items-center justify-center rounded-xl bg-gradient-to-br from-panel-chat to-panel-image text-white shadow-md shadow-panel-chat/30">
        <Sparkles className="size-[15px]" />
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        {m.webSearching && (
          <div className="inline-flex items-center gap-2 rounded-full bg-panel-chat/10 px-3 py-1.5 text-xs font-medium text-panel-chat">
            <Loader2 className="size-3.5 animate-spin" /> Mencari di web…
          </div>
        )}
        {m.sources && m.sources.length > 0 && (
          <details className="rounded-2xl border border-border bg-card/50 px-3 py-2 text-xs">
            <summary className="flex cursor-pointer items-center gap-1.5 text-muted-foreground marker:content-none">
              <Globe size={12} className="text-panel-chat" /> {m.sources.length} sumber web
            </summary>
            <ol className="mt-2 space-y-1 pl-4">
              {m.sources.map((s) => (
                <li key={s.index} className="list-decimal text-muted-foreground">
                  <a href={s.url} target="_blank" rel="noreferrer" title={s.url} className="text-panel-chat hover:underline">
                    {s.title || s.url}
                  </a>
                </li>
              ))}
            </ol>
          </details>
        )}
        {m.webError && (
          <div className="flex items-center gap-1.5 rounded-xl bg-warning/10 px-3 py-1.5 text-xs text-warning">
            <Globe size={12} /> {m.webError} — dijawab tanpa konteks web
          </div>
        )}
        {m.webSkipped && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
            <Globe size={11} /> dijawab dari pengetahuan model — tak perlu cari web
          </div>
        )}
        {m.webReused && (
          <div className="inline-flex items-center gap-1.5 rounded-full bg-panel-chat/10 px-2.5 py-1 text-[11px] text-panel-chat">
            <Globe size={11} /> memakai konteks pencarian web sebelumnya
          </div>
        )}

        {/* Alur berpikir (model reasoning) — sesuai setelan Pengaturan */}
        {m.hasThink &&
          (!thinkingEnabled ? (
            !m.thinkDone && <ThinkPlaceholder label="memproses…" />
          ) : thinkingMode === "hide" ? (
            !m.thinkDone && <ThinkPlaceholder label={`berpikir… · ${fmtDuration(m.thinkSeconds)} · ${m.thinkTokens} token`} />
          ) : !m.thinkDone ? (
            <div className="rounded-2xl border border-panel-chat/25 bg-panel-chat/5 p-3">
              <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-panel-chat">
                <Loader2 className="size-3.5 animate-spin" /> berpikir… · {fmtDuration(m.thinkSeconds)} · {m.thinkTokens} token
              </div>
              <div ref={thinkBodyRef} onScroll={onThinkScroll} className="max-h-40 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">
                {m.thinking}
              </div>
            </div>
          ) : (
            <details className="rounded-2xl border border-border bg-card/50 px-3 py-2">
              <summary className="cursor-pointer text-xs text-muted-foreground marker:content-none">
                Berpikir selama {fmtDuration(m.thinkSeconds)} · {m.thinkTokens} token
              </summary>
              <div className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap font-mono text-xs leading-relaxed text-muted-foreground">{m.thinking}</div>
            </details>
          ))}

        {isStreaming && !m.content && !m.hasThink && !m.webSearching && (
          <div className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> menyusun jawaban…
          </div>
        )}

        {m.content && <Markdown>{m.content}</Markdown>}

        {m.content && m.tokens > 0 && (
          <div className="flex items-center gap-2 font-mono text-[11px] text-muted-foreground">
            <span>
              {m.tokens} token{m.total ? ` · ${m.total} total` : ""}
              {m.tps > 0 ? ` · ${m.tps} tok/s` : ""}
            </span>
            <CopyButton text={m.content} />
          </div>
        )}
      </div>
    </div>
  );
}

function ThinkPlaceholder({ label }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin text-panel-chat" /> {label}
    </div>
  );
}
