import { useEffect, useRef, useState } from "react";
import { Api } from "../services/api.js";
import "./TopStatusBar.css";

const BAR_COUNT = 8;

function Meter({ label, pct, visible, onClick }) {
  if (!visible) return null;
  const lit = Math.round(((pct || 0) / 100) * BAR_COUNT);
  return (
    <button className="meter" onClick={onClick} title="Buka Sistem">
      <span className="meter-label">{label}</span>
      <span className="meter-bars">
        {Array.from({ length: BAR_COUNT }, (_, idx) => {
          const isLit = idx < lit;
          const cls = ["", isLit ? "lit" : "", isLit && idx >= 5 ? "hot" : "", isLit && idx >= 7 ? "crit" : ""]
            .filter(Boolean)
            .join(" ");
          return <i key={idx} className={cls} />;
        })}
      </span>
      <span className="meter-value">{pct == null ? "—" : `${Math.round(pct)}%`}</span>
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
    <header className="meterbridge">
      <div className="wordmark">
        <span className="dot" />
        <span className="full">Local AI Studio</span>
      </div>
      <div className="meters">
        <Meter label="CPU" pct={perf ? perf.cpuPercent : null} visible onClick={onOpenSystem} />
        <Meter label="RAM" pct={ramPct} visible onClick={onOpenSystem} />
        <Meter label="GPU" pct={perf && perf.gpu ? perf.gpu.utilizationPercent : null} visible={!!(perf && perf.gpu)} onClick={onOpenSystem} />
      </div>
    </header>
  );
}
