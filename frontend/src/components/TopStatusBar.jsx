import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Api } from "../services/api.js";
import { cn } from "@/lib/utils";

const BAR_COUNT = 8;

function Meter({ label, pct, visible, onClick }) {
  if (!visible) return null;
  const lit = Math.round(((pct || 0) / 100) * BAR_COUNT);
  return (
    <button
      onClick={onClick}
      title="Buka Sistem"
      className="flex items-center gap-1.5 rounded-xl px-2 py-1 transition-colors hover:bg-muted"
    >
      <span className="font-mono text-[10px] font-semibold text-muted-foreground">{label}</span>
      <span className="flex items-end gap-[2px]">
        {Array.from({ length: BAR_COUNT }, (_, i) => {
          const isLit = i < lit;
          const color = !isLit ? "bg-muted-foreground/25" : i >= 7 ? "bg-destructive" : i >= 5 ? "bg-warning" : "bg-panel-system";
          return <i key={i} className={cn("w-1 rounded-full transition-colors", color)} style={{ height: `${5 + i}px` }} />;
        })}
      </span>
      <span className="w-8 text-right font-mono text-[10px] tabular-nums text-foreground/75">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
    </button>
  );
}

export default function TopStatusBar({ onOpenSystem }) {
  const [perf, setPerf] = useState(null);
  const timerRef = useRef(null);

  useEffect(() => {
    const poll = async () => {
      try {
        setPerf(await Api.perf());
      } catch {
        // mesin baru start / belum bisa dihubungi — coba lagi di tick berikutnya
      }
    };
    poll();
    timerRef.current = setInterval(poll, 2500);
    return () => clearInterval(timerRef.current);
  }, []);

  const ramPct = perf && perf.ramTotalBytes ? (perf.ramUsedBytes / perf.ramTotalBytes) * 100 : null;

  return (
    <header className="flex flex-none items-center justify-between gap-3 border-b border-border bg-card/40 px-3 py-2.5 sm:px-4">
      <div className="flex items-center gap-2.5">
        <div className="flex size-8 items-center justify-center rounded-xl bg-gradient-to-br from-panel-chat to-panel-image text-white shadow-lg shadow-panel-chat/30">
          <Sparkles className="size-[18px]" />
        </div>
        <span className="hidden font-display text-base font-semibold tracking-tight sm:inline sm:text-lg">Local AI Studio</span>
      </div>
      <div className="flex items-center gap-1 sm:gap-2">
        <Meter label="CPU" pct={perf ? perf.cpuPercent : null} visible onClick={onOpenSystem} />
        <Meter label="RAM" pct={ramPct} visible onClick={onOpenSystem} />
        <Meter label="GPU" pct={perf && perf.gpu ? perf.gpu.utilizationPercent : null} visible={!!(perf && perf.gpu)} onClick={onOpenSystem} />
      </div>
    </header>
  );
}
