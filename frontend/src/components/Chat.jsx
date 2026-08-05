import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, X, Square, Globe } from "lucide-react";
import { Api } from "../services/api.js";
import { engineStatusText } from "../lib/status.js";
import ModelChip from "./ModelChip.jsx";
import Markdown from "./Markdown.jsx";
import "./Chat.css";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
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
    const dataUrl = await fileToDataUrl(file);
    setAttachedImage(dataUrl);
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
        // max_tokens membatasi panjang balasan supaya model tidak lari tanpa
        // henti (mis. mengulang teks acak sampai context penuh).
        // useWeb mengaktifkan mode browsing: server mencari di web dan
        // menyuntikkan hasilnya sebagai konteks sebelum menjawab.
        // chat_template_kwargs.enable_thinking mengontrol mode berpikir untuk
        // model reasoning (mis. Qwen3) — false = model langsung menjawab.
        {
          messages: apiMessages,
          stream: true,
          max_tokens: 2048,
          useWeb: webMode,
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
            // event: web_sources — dikirim server sebelum token model kalau
            // mode browsing aktif. { sources: [...], error: "" }
            if (obj.sources !== undefined) {
              webSources = obj.sources || [];
              webErr = obj.error || "";
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

  return (
    <div className="chat-panel">
      <div className="panel-head">
        <div>
          <h1>Chat</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>{engineStatusText(status, "chat")}</span>
          </div>
        </div>
        <div className="chat-header-right">
          {sessionTokens > 0 && <span className="token-total" title="Total token sesi ini">Σ {sessionTokens.toLocaleString()} token</span>}
          <ModelChip model={status.model} onOpen={onOpenModels} />
        </div>
      </div>

      <div className="chat-body" ref={bodyRef} onScroll={onBodyScroll}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Belum ada percakapan. Pilih model lalu ajukan pertanyaan.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-role">{m.role === "user" ? "kamu" : "asisten"}</div>
            {m.image && <img className="msg-image" src={m.image} alt="lampiran" />}
            {m.role === "assistant" && m.sources && m.sources.length > 0 && (
              <details className="msg-sources">
                <summary>
                  <Globe size={12} /> {m.sources.length} sumber web
                </summary>
                <ol>
                  {m.sources.map((s) => (
                    <li key={s.index}>
                      <a href={s.url} target="_blank" rel="noreferrer" title={s.url}>
                        {s.title || s.url}
                      </a>
                    </li>
                  ))}
                </ol>
              </details>
            )}
            {m.role === "assistant" && m.webError && (
              <div className="msg-web-error">
                <Globe size={12} /> {m.webError} — dijawab tanpa konteks web
              </div>
            )}

            {/* Alur berpikir (model reasoning) — sesuai setelan di Pengaturan.
                Mode berpikir OFF: jangan tampilkan alur; kalau model tetap
                berpikir, cukup tunjukkan "memproses…" sampai jawaban muncul. */}
            {m.role === "assistant" &&
              m.hasThink &&
              (!thinkingEnabled ? (
                !m.thinkDone && (
                  <div className="think-placeholder">
                    <span className="think-dot" /> memproses…
                  </div>
                )
              ) : thinkingMode === "hide" ? (
                !m.thinkDone && (
                  <div className="think-placeholder">
                    <span className="think-dot" /> berpikir… · {fmtDuration(m.thinkSeconds)} · {m.thinkTokens} token
                  </div>
                )
              ) : !m.thinkDone ? (
                <div className="think-live">
                  <div className="think-head">
                    <span className="think-dot" /> berpikir… · {fmtDuration(m.thinkSeconds)} · {m.thinkTokens} token
                  </div>
                  <div className="think-body" ref={thinkBodyRef} onScroll={onThinkScroll}>
                    {m.thinking}
                  </div>
                </div>
              ) : (
                <details className="think-collapsed">
                  <summary>
                    Berpikir selama {fmtDuration(m.thinkSeconds)} · {m.thinkTokens} token
                  </summary>
                  <div className="think-body">{m.thinking}</div>
                </details>
              ))}

            {(m.role !== "assistant" || m.content) && (
              <div className="msg-bubble">
                {m.role === "assistant" ? <Markdown>{m.content}</Markdown> : m.content}
              </div>
            )}

            {m.role === "assistant" && m.content && m.tokens > 0 && (
              <div className="msg-stats">
                {m.tokens} token{m.total ? ` · ${m.total} total` : ""}
                {m.tps > 0 ? ` · ${m.tps} tok/s` : ""}
              </div>
            )}
          </div>
        ))}
      </div>

      <form className="composer" onSubmit={sendMessage}>
        {attachedImage && (
          <div className="attach-chip">
            <img src={attachedImage} alt="" />
            <span>gambar terlampir</span>
            <button type="button" onClick={() => setAttachedImage(null)} aria-label="Hapus lampiran">
              <X size={14} />
            </button>
          </div>
        )}
        <div className="composer-row">
          <button
            type="button"
            className="icon-btn"
            onClick={() => fileInputRef.current.click()}
            disabled={!status.multimodal}
            title={
              status.multimodal
                ? "Lampirkan gambar"
                : "Model aktif tidak mendukung gambar — pasang & pilih model vision di Model Manager"
            }
          >
            <Paperclip size={16} />
          </button>
          <button
            type="button"
            className={`icon-btn${webMode ? " web-on" : ""}`}
            onClick={() => setWebMode((v) => !v)}
            title={webMode ? "Mode web aktif — cari di internet sebelum menjawab" : "Aktifkan mode web (cari di internet)"}
            aria-pressed={webMode}
          >
            <Globe size={16} />
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onAttachFile} />
          <textarea
            rows={1}
            placeholder="Tulis pesan… (Enter untuk kirim, Shift+Enter baris baru)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          {sending ? (
            <button type="button" className="icon-btn stop" onClick={stopGeneration} title="Hentikan">
              <Square size={14} />
            </button>
          ) : (
            <button type="submit" className="icon-btn primary" title="Kirim">
              <Send size={16} />
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
