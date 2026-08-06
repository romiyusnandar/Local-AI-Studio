import { NavLink } from "react-router-dom";
import { MessageSquare, Image as ImageIcon, Mic, Volume2, Boxes, Activity, Settings as SettingsIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Tiap panel = satu rute (path bahasa Inggris) + warna identitasnya sendiri
// (signature colorful). Dipakai di sidebar desktop maupun bottom-nav mobile.
// Class ditulis lengkap (bukan dinamis) supaya terdeteksi Tailwind.
export const NAV_ITEMS = [
  { path: "/chat", label: "Chat", short: "Chat", icon: MessageSquare, accent: "chat" },
  { path: "/image", label: "Gambar", short: "Gambar", icon: ImageIcon, accent: "image" },
  { path: "/speech", label: "Suara→Teks", short: "S→T", icon: Mic, accent: "speech" },
  { path: "/tts", label: "Teks→Suara", short: "T→S", icon: Volume2, accent: "tts" },
  { path: "/models", label: "Model", short: "Model", icon: Boxes, accent: "models" },
  { path: "/system", label: "Sistem", short: "Sistem", icon: Activity, accent: "system" },
  { path: "/settings", label: "Pengaturan", short: "Atur", icon: SettingsIcon, accent: "settings" },
];

const ACCENT = {
  chat: { text: "text-panel-chat", soft: "bg-panel-chat/15", dot: "bg-panel-chat", glow: "shadow-panel-chat/40" },
  image: { text: "text-panel-image", soft: "bg-panel-image/15", dot: "bg-panel-image", glow: "shadow-panel-image/40" },
  speech: { text: "text-panel-speech", soft: "bg-panel-speech/15", dot: "bg-panel-speech", glow: "shadow-panel-speech/40" },
  tts: { text: "text-panel-tts", soft: "bg-panel-tts/15", dot: "bg-panel-tts", glow: "shadow-panel-tts/40" },
  models: { text: "text-panel-models", soft: "bg-panel-models/15", dot: "bg-panel-models", glow: "shadow-panel-models/40" },
  system: { text: "text-panel-system", soft: "bg-panel-system/15", dot: "bg-panel-system", glow: "shadow-panel-system/40" },
  settings: { text: "text-panel-settings", soft: "bg-panel-settings/15", dot: "bg-panel-settings", glow: "shadow-panel-settings/40" },
};

export default function Sidebar() {
  return (
    <aside className="hidden w-60 flex-none flex-col gap-1.5 border-r border-border bg-card/40 p-3 md:flex">
      <div className="px-2 pb-2 pt-1">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Studio</span>
      </div>
      {NAV_ITEMS.map(({ path, label, icon: Icon, accent }) => {
        const a = ACCENT[accent];
        return (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              cn(
                "group relative flex items-center gap-3 rounded-2xl px-3 py-2.5 text-sm font-medium transition-all duration-200",
                isActive ? cn(a.soft, a.text) : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )
            }
          >
            {({ isActive }) => (
              <>
                <span
                  className={cn(
                    "flex size-8 flex-none items-center justify-center rounded-xl transition-all duration-200",
                    isActive ? cn(a.dot, "text-white shadow-lg", a.glow) : "bg-transparent group-hover:scale-110",
                  )}
                >
                  <Icon className="size-[18px]" />
                </span>
                <span className="truncate">{label}</span>
              </>
            )}
          </NavLink>
        );
      })}
    </aside>
  );
}

// Bottom-nav untuk layar sempit (HP). Menggantikan sidebar vertikal.
export function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 flex items-stretch gap-0.5 border-t border-border bg-card/95 px-1 py-1.5 backdrop-blur md:hidden">
      {NAV_ITEMS.map(({ path, short, icon: Icon, accent }) => {
        const a = ACCENT[accent];
        return (
          <NavLink
            key={path}
            to={path}
            className={({ isActive }) =>
              cn(
                "flex min-w-0 flex-1 flex-col items-center gap-1 rounded-xl px-0.5 py-1.5 text-[10px] font-medium transition-colors",
                isActive ? cn(a.soft, a.text) : "text-muted-foreground",
              )
            }
          >
            <Icon className="size-5 flex-none" />
            <span className="max-w-full truncate">{short}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
