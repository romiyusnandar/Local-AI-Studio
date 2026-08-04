import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { updateProgress } from "./progress.js";

// downloadWithResume mengunduh url ke dest, melanjutkan dari ukuran file
// yang sudah ada kalau server sumbernya mendukung HTTP Range (dipakai untuk
// resume unduhan besar yang terputus). signal (AbortSignal) dipakai untuk
// membatalkan unduhan dari luar (tombol "Batal" di UI).
export async function downloadWithResume(url, dest, signal) {
  let start = 0;
  try {
    const st = await fsp.stat(dest);
    start = st.size;
  } catch {
    // belum ada file .part, mulai dari 0
  }

  const headers = start > 0 ? { Range: `bytes=${start}-` } : {};
  const res = await fetch(url, { headers, signal });

  if (res.status !== 200 && res.status !== 206) {
    throw new Error(`server menolak (HTTP ${res.status})`);
  }
  if (res.status === 200) {
    start = 0; // server mengabaikan Range, mulai dari awal
  }

  const contentLength = Number(res.headers.get("content-length") || 0);
  const total = contentLength + start;

  await fsp.mkdir(path.dirname(dest), { recursive: true });

  const file = fs.createWriteStream(dest, { flags: start > 0 ? "r+" : "w", start });
  let written = start;
  let lastTick = Date.now();

  const reader = res.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await new Promise((resolve, reject) => {
        file.write(value, (err) => (err ? reject(err) : resolve()));
      });
      written += value.length;
      // Jangan update tiap potongan — biar UI tidak macet dipoll berlebihan.
      if (Date.now() - lastTick > 300) {
        updateProgress(written, total);
        lastTick = Date.now();
      }
    }
  } finally {
    await new Promise((resolve) => file.end(resolve));
  }

  updateProgress(written, total);

  if (total > 0 && written !== total) {
    throw new Error(`unduhan tidak lengkap (${written} dari ${total} byte)`);
  }
  // Kalau server tidak mengirim Content-Length (mis. chunked), total di atas
  // jadi 0 dan tidak ketangkap pengecekan di atas. Untuk unduhan baru (belum
  // ada bytes tersimpan), tidak menerima satu byte pun jelas kegagalan
  // jaringan, bukan unduhan sukses berukuran nol — tanpa ini file kosong
  // lolos ke tahap validasi dan cuma dilaporkan sebagai "bukan model yang
  // valid", padahal akar masalahnya koneksi terputus. Untuk resume (start >
  // 0) tidak diperlakukan sama, karena file lama bisa saja sudah lengkap.
  if (start === 0 && written === 0) {
    throw new Error("tidak ada data diterima dari server — kemungkinan koneksi terputus, coba lagi");
  }
}
