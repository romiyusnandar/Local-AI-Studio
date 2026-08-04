// Hanya satu unduhan sekaligus di seluruh aplikasi (model apa pun, mesin
// apa pun) — dua unduhan 5GB bersamaan lebih menyakitkan daripada berguna,
// dan progresnya jadi tidak bisa ditampilkan dengan jelas. Sama seperti
// dlMu/dlBusy di models.go versi Go.

let busy = false;
let abortController = null;

export function isDownloadActive() {
  return busy;
}

export function beginDownload() {
  if (busy) throw new Error("masih ada unduhan berjalan");
  abortController = new AbortController();
  busy = true;
  return abortController.signal;
}

export function endDownload() {
  busy = false;
  abortController = null;
}

export function cancelDownload() {
  if (!abortController) return false;
  abortController.abort();
  return true;
}
