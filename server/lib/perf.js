import os from "node:os";
import { execFile } from "node:child_process";

function execFileP(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
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

export async function getStats() {
  const [cpu, gpu] = await Promise.all([cpuPercent(), gpuStats()]);
  return {
    cpuPercent: cpu,
    cpuCores: os.cpus().length,
    ramUsedBytes: os.totalmem() - os.freemem(),
    ramTotalBytes: os.totalmem(),
    gpu,
  };
}
