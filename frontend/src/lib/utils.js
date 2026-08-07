import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// cn menggabungkan className bersyarat (clsx) lalu merapikan konflik utilitas
// Tailwind (tailwind-merge). Dipakai semua komponen shadcn/ui.
export function cn(...inputs) {
  return twMerge(clsx(inputs));
}

// newId membuat UUID v4 untuk id percakapan. TIDAK memakai crypto.randomUUID
// karena fungsi itu hanya tersedia di secure context (HTTPS/localhost) — saat
// aplikasi dibuka dari HP lewat IP LAN (http://192.168.x.x, non-secure),
// randomUUID undefined dan pemanggilannya melempar error (tombol jadi seolah
// tak bisa diklik). crypto.getRandomValues tersedia di konteks apa pun; ada
// fallback Math.random untuk lingkungan yang lebih tua lagi.
export function newId() {
  const c = globalThis.crypto;
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === "function") {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // versi 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // varian 10xx
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10, 16).join("")}`;
}
