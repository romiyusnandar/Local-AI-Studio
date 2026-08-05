// engineStatusText merangkai teks status satu mesin dari objek status
// (yang kini menyertakan info load: fase + progres pemuatan model). Dipakai
// bersama oleh panel Chat & Gambar supaya teksnya konsisten.
//
// label: kata benda mesin, mis. "chat" atau "image gen".
export function engineStatusText(status, label) {
  if (status.mesinHidup) return `siap — ${status.model || "model aktif"}`;

  const load = status.load;
  // Detail progres pemuatan (bar + persen) ditampilkan di Model Manager;
  // di panel fitur cukup teks ringkas.
  if (load?.active) return "memuat model…";
  if (load?.phase?.startsWith("gagal")) return load.phase;

  return status.model ? `mesin ${label} menyala…` : `mesin ${label} mati — pilih model di Model Manager`;
}
