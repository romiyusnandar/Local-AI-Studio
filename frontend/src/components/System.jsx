import { useEffect, useRef, useState } from "react";
import { Cpu, MemoryStick, Gauge, RefreshCw, MessageSquare, Image, Mic, Volume2 } from "lucide-react";
import { Api } from "../services/api.js";
import "./System.css";

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

function barClass(pct) {
  if (pct > 85) return "crit";
  if (pct > 60) return "hot";
  return "";
}

const ENGINE_META = [
  { kind: "llm", label: "Chat", icon: MessageSquare },
  { kind: "img", label: "Image Gen", icon: Image },
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
    <div className="system-panel">
      <div className="system-header">
        <div>
          <h1>Sistem</h1>
          <span className="sub">Pemakaian sumber daya &amp; status mesin, waktu nyata</span>
        </div>
        <button className="btn-sm" onClick={refresh}>
          <RefreshCw size={13} />
          <span>Segarkan</span>
        </button>
      </div>

      <div className="system-body">
        {!perf ? (
          <div className="system-loading">Memuat data sistem&hellip;</div>
        ) : (
          <div className="grid-cards">
            <div className="card">
              <div className="card-label">
                <Cpu size={13} />
                <span>CPU</span>
              </div>
              <div className="card-value">
                {Math.round(perf.cpuPercent)}
                <small>%</small>
              </div>
              <div className="bar-track">
                <i style={{ width: `${perf.cpuPercent}%` }} className={barClass(perf.cpuPercent)} />
              </div>
              <div className="card-sub">{perf.cpuCores} core</div>
            </div>

            <div className="card">
              <div className="card-label">
                <MemoryStick size={13} />
                <span>RAM</span>
              </div>
              <div className="card-value">
                {Math.round(ramPct)}
                <small>%</small>
              </div>
              <div className="bar-track">
                <i style={{ width: `${ramPct}%` }} className={barClass(ramPct)} />
              </div>
              <div className="card-sub">
                {formatBytes(perf.ramUsedBytes)} / {formatBytes(perf.ramTotalBytes)}
              </div>
            </div>

            {perf.gpu ? (
              <div className="card">
                <div className="card-label">
                  <Gauge size={13} />
                  <span>GPU</span>
                </div>
                <div className="card-value">
                  {Math.round(perf.gpu.utilizationPercent)}
                  <small>%</small>
                </div>
                <div className="bar-track">
                  <i style={{ width: `${perf.gpu.utilizationPercent}%` }} />
                </div>
                <div className="card-sub">
                  {perf.gpu.name} — {formatBytes(perf.gpu.vramUsedBytes)} / {formatBytes(perf.gpu.vramTotalBytes)} VRAM
                </div>
              </div>
            ) : (
              <div className="card">
                <div className="card-label">
                  <Gauge size={13} />
                  <span>GPU</span>
                </div>
                <div className="card-sub">Tidak ada GPU NVIDIA terdeteksi. Mesin berjalan di CPU.</div>
              </div>
            )}
          </div>
        )}

        <div className="model-section-title">Status Mesin</div>
        <div className="engine-grid">
          {ENGINE_META.map(({ kind, label, icon: Icon }) => {
            const s = engines[kind];
            const ready = s && s.mesinHidup;
            return (
              <div className="engine-card" key={kind}>
                <div className="engine-card-top">
                  <div className="engine-name">
                    <Icon size={15} />
                    <span>{label}</span>
                  </div>
                  <span className="status-line">
                    <span className={`dot${ready ? " ready" : ""}`} />
                  </span>
                </div>
                <div className="engine-model">{s ? s.model || (ready ? "aktif" : "tidak ada model") : "—"}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
