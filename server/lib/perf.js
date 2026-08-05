import os from "node:os";
import { execFile } from "node:child_process";
import { detectAccel } from "./backend-manager.js";

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 4000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    for (const type in cpu.times) total += cpu.times[type];
    idle += cpu.times.idle;
  }
  return { idle, total };
}

// cpuPercent mengambil dua cuplikan os.cpus() berjarak 200ms untuk
// menghitung delta pemakaian — Node tidak punya API "persentase CPU"
// langsung seperti sebagian OS API, jadi dihitung manual dari waktu idle.
async function cpuPercent() {
  const t1 = cpuTimes();
  await new Promise((r) => setTimeout(r, 200));
  const t2 = cpuTimes();

  const totalDelta = t2.total - t1.total;
  if (totalDelta === 0) return 0;
  const idleDelta = t2.idle - t1.idle;
  return ((totalDelta - idleDelta) / totalDelta) * 100;
}

// gpuStats lewat nvidia-smi — kalau tidak ada GPU NVIDIA, kembalikan null
// saja daripada error; dashboard tetap tampil tanpa panel GPU.
async function gpuStats() {
  try {
    const stdout = await execFileP("nvidia-smi", [
      "--query-gpu=name,utilization.gpu,memory.used,memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const line = stdout.trim().split("\n")[0];
    const [name, util, usedMB, totalMB] = line.split(",").map((s) => s.trim());
    if (!name) return null;
    return {
      name,
      utilizationPercent: Number(util) || 0,
      vramUsedBytes: (Number(usedMB) || 0) * 1024 * 1024,
      vramTotalBytes: (Number(totalMB) || 0) * 1024 * 1024,
    };
  } catch {
    return null;
  }
}

// ---------- info sistem statis (OS, CPU, GPU, akselerasi) ----------

function prettyOS() {
  // os.version() memberi string ramah (mis. "Windows 11 Home") di Windows/macOS
  // versi baru; kalau tidak, rangkai dari platform + release.
  const names = { win32: "Windows", darwin: "macOS", linux: "Linux" };
  let base = "";
  try {
    base = os.version();
  } catch {
    base = "";
  }
  const label = base && base.length < 60 ? base : `${names[process.platform] || process.platform} ${os.release()}`;
  return `${label} · ${os.arch()}`;
}

// gpuName mendeteksi nama GPU lintas vendor (bukan hanya NVIDIA): nvidia-smi
// dulu, lalu query khusus OS. Kembalikan "" kalau tak terdeteksi.
async function gpuName() {
  try {
    const out = await execFileP("nvidia-smi", ["--query-gpu=name", "--format=csv,noheader"]);
    const n = out.trim().split("\n")[0].trim();
    if (n) return n;
  } catch {
    // bukan NVIDIA
  }
  try {
    if (process.platform === "win32") {
      const out = await execFileP("powershell", [
        "-NoProfile",
        "-Command",
        "(Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name) -join ', '",
      ]);
      return out.trim();
    }
    if (process.platform === "linux") {
      const out = await execFileP("sh", ["-c", "lspci | grep -iE 'vga|3d|display' | sed 's/.*: //' | head -1"]);
      return out.trim();
    }
    if (process.platform === "darwin") {
      const out = await execFileP("sh", ["-c", "system_profiler SPDisplaysDataType | grep 'Chipset Model' | head -1 | sed 's/.*: //'"]);
      return out.trim();
    }
  } catch {
    // gagal query — biarkan kosong
  }
  return "";
}

const ACCEL_LABELS = { cuda: "NVIDIA CUDA", vulkan: "Vulkan", metal: "Apple Metal", cpu: "CPU" };

let cachedSystem = null;

// getSystemInfo: info statis perangkat. Di-cache karena tidak berubah selama
// aplikasi hidup dan query GPU/akselerasi memanggil proses eksternal.
export async function getSystemInfo() {
  if (cachedSystem) return cachedSystem;
  const cpu0 = os.cpus()[0];
  const [accel, gpu] = await Promise.all([detectAccel().catch(() => "cpu"), gpuName()]);
  cachedSystem = {
    os: prettyOS(),
    cpu: cpu0 ? cpu0.model.trim() : "?",
    cpuCores: os.cpus().length,
    gpu,
    accel,
    accelLabel: ACCEL_LABELS[accel] || accel,
  };
  return cachedSystem;
}

export async function getStats() {
  const [cpu, gpu, system] = await Promise.all([cpuPercent(), gpuStats(), getSystemInfo()]);
  return {
    cpuPercent: cpu,
    cpuCores: os.cpus().length,
    ramUsedBytes: os.totalmem() - os.freemem(),
    ramTotalBytes: os.totalmem(),
    gpu,
    system,
  };
}
