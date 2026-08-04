// State progres unduhan bersama — dibaca UI lewat polling /api/progress.
// Unduhan model/backend bisa berjalan menit-menit, jauh lebih lama dari
// satu request HTTP, jadi statusnya disimpan di sini dan dipoll terpisah.

let progress = { active: false, label: "", downloaded: 0, total: 0, percent: 0, error: "", done: false };

export function setProgress(patch) {
  progress = {
    active: false,
    label: "",
    downloaded: 0,
    total: 0,
    percent: 0,
    error: "",
    done: false,
    ...patch,
  };
}

export function getProgress() {
  return progress;
}

export function updateProgress(downloaded, total) {
  progress = {
    ...progress,
    downloaded,
    total,
    percent: total > 0 ? Math.floor((downloaded * 100) / total) : progress.percent,
  };
}
