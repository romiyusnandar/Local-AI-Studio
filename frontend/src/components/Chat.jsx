import { useEffect, useRef, useState } from "react";
import { Paperclip, Send, X } from "lucide-react";
import { Api } from "../services/api.js";
import "./Chat.css";

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export default function Chat() {
  const [status, setStatus] = useState({ mesinHidup: false, model: "" });
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModel] = useState("");
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [attachedImage, setAttachedImage] = useState(null);
  const [sending, setSending] = useState(false);
  const [sessionTokens, setSessionTokens] = useState(0);

  const abortRef = useRef(null);
  const bodyRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    refreshModels();
    refreshStatus();
    const t = setInterval(refreshStatus, 3000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  async function refreshStatus() {
    try {
      setStatus(await Api.status());
    } catch {
      // aplikasi baru buka / offline sesaat
    }
  }

  async function refreshModels() {
    try {
      const data = await Api.models();
      setModels(data.models || []);
      setActiveModel(data.active || "");
    } catch {
      // diamkan
    }
  }

  async function onSelectModel(e) {
    const model = e.target.value;
    setActiveModel(model);
    try {
      await Api.selectModel("llm", model);
    } catch (err) {
      alert(err.message);
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

    const apiMessages = history.map((m, i) =>
      i === history.length - 1 && hadImage ? { role: m.role, content: apiContent } : { role: m.role, content: m.content }
    );

    try {
      abortRef.current = new AbortController();
      // stream_options.include_usage minta llama-server mengirim satu chunk
      // usage terakhir (prompt/completion/total tokens) supaya angkanya pasti,
      // bukan cuma perkiraan dari jumlah delta.
      const res = await Api.chatStream(
        { messages: apiMessages, stream: true, stream_options: { include_usage: true } },
        abortRef.current.signal
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "permintaan gagal" }));
        throw new Error(err.error || "permintaan gagal");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let assistantText = "";
      let tokenCount = 0; // perkiraan live: ~1 token per delta berisi konten
      let usage = null;
      let tps = 0;
      const startedAt = Date.now();

      const pushUpdate = () => {
        setMessages((prev) => {
          const next = [...prev];
          next[next.length - 1] = {
            role: "assistant",
            content: assistantText,
            tokens: usage ? usage.completion_tokens : tokenCount,
            total: usage ? usage.total_tokens : null,
            tps,
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
            // chunk usage/timings terakhir: choices kosong, ada angka pasti
            if (obj.usage) usage = obj.usage;
            if (obj.timings && obj.timings.predicted_per_second) {
              tps = Math.round(obj.timings.predicted_per_second);
            }
            const token = obj.choices?.[0]?.delta?.content;
            if (token) {
              assistantText += token;
              tokenCount++;
              const secs = (Date.now() - startedAt) / 1000;
              if (secs > 0) tps = Math.round(tokenCount / secs);
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

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <div>
          <h1>Chat</h1>
          <div className="status-line">
            <span className={`dot${status.mesinHidup ? " ready" : ""}`} />
            <span>
              {status.mesinHidup
                ? `siap — ${status.model || "model aktif"}`
                : status.model
                  ? "mesin chat sedang menyala…"
                  : "mesin chat mati — pilih model"}
            </span>
          </div>
        </div>
        <div className="chat-header-right">
          {sessionTokens > 0 && <span className="token-total" title="Total token sesi ini">Σ {sessionTokens.toLocaleString()} token</span>}
          <select value={activeModel} onChange={onSelectModel} disabled={models.length === 0}>
            {models.length === 0 && <option>Belum ada model</option>}
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="chat-body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Belum ada percakapan. Pilih model lalu ajukan pertanyaan.</p>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg msg-${m.role}`}>
            <div className="msg-role">{m.role === "user" ? "kamu" : "asisten"}</div>
            {m.image && <img className="msg-image" src={m.image} alt="lampiran" />}
            <div className="msg-bubble">{m.content}</div>
            {m.role === "assistant" && m.tokens > 0 && (
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
          <button type="button" className="icon-btn" onClick={() => fileInputRef.current.click()} title="Lampirkan gambar">
            <Paperclip size={16} />
          </button>
          <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={onAttachFile} />
          <textarea
            rows={1}
            placeholder="Tulis pesan… (Enter untuk kirim, Shift+Enter baris baru)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" className="icon-btn primary" disabled={sending} title="Kirim">
            <Send size={16} />
          </button>
        </div>
      </form>
    </div>
  );
}
