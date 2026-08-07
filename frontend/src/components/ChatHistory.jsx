import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Sparkles, Plus, MessageSquare, Trash2, Loader2 } from "lucide-react";
import { Api } from "../services/api.js";
import { cn, newId } from "@/lib/utils";

// fmtRelative: "baru saja", "5 mnt lalu", "3 jam lalu", "2 hari lalu", atau
// tanggal lengkap untuk yang lebih lama dari seminggu.
function fmtRelative(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "baru saja";
  if (m < 60) return `${m} mnt lalu`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} jam lalu`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d} hari lalu`;
  return new Date(ts).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" });
}

// ChatHistory (rute /chat): daftar semua percakapan tersimpan, terbaru dulu.
// Kosong → tombol "Mulai chat" di tengah. Membuka/membuat chat mengarah ke
// /chat/:id.
export default function ChatHistory() {
  const navigate = useNavigate();
  const [items, setItems] = useState(null); // null = masih memuat
  const [deleting, setDeleting] = useState("");

  useEffect(() => {
    Api.listChats()
      .then((r) => setItems(r.items || []))
      .catch(() => setItems([]));
  }, []);

  const startNew = () => navigate(`/chat/${newId()}`);

  async function remove(id) {
    if (!confirm("Hapus percakapan ini?")) return;
    setDeleting(id);
    try {
      await Api.deleteChat(id);
      setItems((prev) => (prev || []).filter((c) => c.id !== id));
    } catch {
      // gagal hapus — biarkan item tetap ada
    } finally {
      setDeleting("");
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/* ---- header ---- */}
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold leading-tight">Chat</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Riwayat percakapanmu</p>
        </div>
        {items && items.length > 0 && (
          <button
            onClick={startNew}
            className="flex flex-none items-center gap-1.5 rounded-full bg-linear-to-br from-panel-chat to-panel-image px-3.5 py-2 text-sm font-medium text-white shadow-lg shadow-panel-chat/30 transition hover:brightness-110"
          >
            <Plus size={16} /> Chat baru
          </button>
        )}
      </header>

      {/* ---- isi ---- */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          {items === null ? (
            <div className="flex flex-1 items-center justify-center py-20 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
              <div className="flex size-16 items-center justify-center rounded-2xl bg-linear-to-br from-panel-chat to-panel-image text-white shadow-xl shadow-panel-chat/30">
                <Sparkles className="size-8" />
              </div>
              <div className="space-y-1">
                <h2 className="text-xl font-bold">Belum ada percakapan</h2>
                <p className="max-w-xs text-sm text-muted-foreground">Mulai chat pertamamu dengan model AI lokal.</p>
              </div>
              <button
                onClick={startNew}
                className="flex items-center gap-2 rounded-full bg-linear-to-br from-panel-chat to-panel-image px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-panel-chat/30 transition hover:brightness-110"
              >
                <Plus size={18} /> Mulai chat
              </button>
            </div>
          ) : (
            <ul className="flex flex-col gap-2">
              {items.map((c) => (
                <li
                  key={c.id}
                  className="group flex items-center gap-3 rounded-2xl border border-border bg-card px-4 py-3 transition-colors hover:border-panel-chat/50 hover:bg-accent"
                >
                  {/* Area teks = tombol navigasi ke chat. Dipisah dari tombol
                      hapus supaya tidak ada <button> bersarang (HTML invalid). */}
                  <button onClick={() => navigate(`/chat/${c.id}`)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <span className="flex size-9 flex-none items-center justify-center rounded-xl bg-panel-chat/15 text-panel-chat">
                      <MessageSquare className="size-[18px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground">{c.title || "Chat baru"}</span>
                      {c.preview && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{c.preview}</span>}
                    </span>
                  </button>
                  <div className="flex flex-none items-center gap-2">
                    {c.tokens > 0 && (
                      <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline" title="Total token percakapan ini">
                        Σ {c.tokens.toLocaleString()}
                      </span>
                    )}
                    <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">{fmtRelative(c.updatedAt)}</span>
                    {/* Selalu terlihat (di mobile tak ada hover); di desktop
                        warnanya menegas saat hover. */}
                    <button
                      onClick={() => remove(c.id)}
                      title="Hapus percakapan"
                      aria-label="Hapus percakapan"
                      className={cn(
                        "flex size-8 flex-none items-center justify-center rounded-lg text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive",
                        deleting === c.id && "text-destructive",
                      )}
                    >
                      {deleting === c.id ? <Loader2 size={15} className="animate-spin" /> : <Trash2 size={15} />}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
