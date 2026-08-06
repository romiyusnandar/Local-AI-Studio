import { useEffect, useRef, useState } from "react";
import { Cpu, MemoryStick, Gauge, RefreshCw, MessageSquare, Image as ImageIcon, Mic, Volume2, Monitor, Zap } from "lucide-react";
import { Api } from "../services/api.js";
import { cn } from "@/lib/utils";

function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

// Warna bar meter berdasarkan beban: hijau (aman) → amber → merah (kritis).
function barColor(pct) {
  if (pct > 85) return "bg-destructive";
  if (pct > 60) return "bg-warning";
  return "bg-panel-system";
}

const ENGINE_META = [
  { kind: "llm", label: "Chat", icon: MessageSquare },
  { kind: "img", label: "Gambar", icon: ImageIcon },
  { kind: "stt", label: "Suara→Teks", icon: Mic },
  { kind: "tts", label: "Teks→Suara", icon: Volume2 },
];

export default function System() {
  const [perf, setPerf] = useState(null);
  const [engines, setEngines] = useState({});
  const timerRef = useRef(null);

  const refresh = async () => {
    try {
      const p = await Api.perf();
      setPerf(p);
      setEngines(p.engines || {});
    } catch {
      // mesin baru start / belum bisa dihubungi — coba lagi di tick berikutnya
    }
  };

  useEffect(() => {
    refresh();
    timerRef.current = setInterval(refresh, 2500);
    return () => clearInterval(timerRef.current);
  }, []);

  const ramPct = perf && perf.ramTotalBytes ? (perf.ramUsedBytes / perf.ramTotalBytes) * 100 : 0;

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-none items-center justify-between gap-3 border-b border-border px-5 py-3">
        <div>
          <h1 className="text-lg font-semibold leading-tight">Sistem</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">Pemakaian sumber daya &amp; status mesin, waktu nyata.</p>
        </div>
        <button onClick={refresh} className="inline-flex flex-none items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs text-muted-foreground transition hover:bg-accent hover:text-accent-foreground">
          <RefreshCw size={13} /> Segarkan
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 px-4 py-5">
          {/* ---- perangkat ---- */}
          {perf?.system && (
            <div className="space-y-2.5">
              <SectionTitle>Perangkat</SectionTitle>
              <div className="divide-y divide-border rounded-3xl border border-border bg-card">
                <InfoRow icon={Monitor} k="Sistem Operasi" v={perf.system.os} />
                <InfoRow icon={Cpu} k="CPU" v={`${perf.system.cpu} · ${perf.system.cpuCores} core`} />
                <InfoRow icon={Gauge} k="GPU" v={perf.system.gpu || "tidak terdeteksi"} />
                <InfoRow icon={Zap} k="Backend akselerasi" v={<AccelBadge label={perf.system.accelLabel} />} />
              </div>
            </div>
          )}

          {/* ---- meter sumber daya ---- */}
          <div className="space-y-2.5">
            <SectionTitle>Sumber Daya</SectionTitle>
            {!perf ? (
              <div className="rounded-2xl border border-dashed border-border bg-card/40 px-4 py-8 text-center text-sm text-muted-foreground">Memuat data sistem…</div>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <MeterCard icon={Cpu} label="CPU" pct={perf.cpuPercent} sub={`${perf.cpuCores} core`} />
                <MeterCard icon={MemoryStick} label="RAM" pct={ramPct} sub={`${formatBytes(perf.ramUsedBytes)} / ${formatBytes(perf.ramTotalBytes)}`} />
                {perf.gpu ? (
                  <MeterCard
                    icon={Gauge}
                    label="GPU"
                    pct={perf.gpu.utilizationPercent}
                    sub={`${formatBytes(perf.gpu.vramUsedBytes)} / ${formatBytes(perf.gpu.vramTotalBytes)} VRAM`}
                  />
                ) : (
                  <div className="rounded-3xl border border-border bg-card p-4">
                    <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      <Gauge size={13} /> GPU
                    </div>
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      {perf.system?.gpu || "GPU tidak terdeteksi"}. Pemakaian & VRAM waktu-nyata hanya untuk GPU NVIDIA.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ---- status mesin ---- */}
          <div className="space-y-2.5">
            <SectionTitle>Status Mesin</SectionTitle>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {ENGINE_META.map(({ kind, label, icon: Icon }) => {
                const s = engines[kind];
                const ready = s && s.mesinHidup;
                return (
                  <div key={kind} className={cn("rounded-2xl border bg-card p-3.5", ready ? "border-panel-system/40" : "border-border")}>
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        <Icon size={15} className={ready ? "text-panel-system" : "text-muted-foreground"} />
                        <span>{label}</span>
                      </div>
                      <div className="flex flex-none items-center gap-2">
                        {s?.accel && <span className="rounded-full bg-panel-system/15 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase text-panel-system">{s.accel}</span>}
                        <span className={cn("size-2 rounded-full", ready ? "bg-panel-system shadow-[0_0_8px_var(--panel-system)]" : "bg-muted-foreground/40")} />
                      </div>
                    </div>
                    <div className="mt-2 truncate font-mono text-xs text-muted-foreground">{s ? s.model || (ready ? "aktif" : "tidak ada model") : "—"}</div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }) {
  return <div className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{children}</div>;
}

function InfoRow({ icon: Icon, k, v }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 text-sm">
      <Icon size={15} className="flex-none text-muted-foreground" />
      <span className="flex-none text-muted-foreground">{k}</span>
      <span className="ml-auto min-w-0 truncate text-right font-medium">{v}</span>
    </div>
  );
}

function AccelBadge({ label }) {
  return <span className="rounded-full bg-panel-system/15 px-2.5 py-1 font-mono text-[11px] font-semibold uppercase text-panel-system">{label}</span>;
}

function MeterCard({ icon: Icon, label, pct, sub }) {
  return (
    <div className="rounded-3xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <Icon size={13} /> {label}
      </div>
      <div className="mt-2 font-display text-3xl font-bold leading-none">
        {Math.round(pct)}
        <span className="text-lg text-muted-foreground">%</span>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
        <div className={cn("h-full rounded-full transition-all duration-500", barColor(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-1.5 truncate font-mono text-[11px] text-muted-foreground">{sub}</div>
    </div>
  );
}
