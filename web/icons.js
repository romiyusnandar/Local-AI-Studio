// Ikon SVG stroke minimal, viewBox 24x24, tanpa dependency luar (offline-first).
// Setiap fungsi mengembalikan string SVG siap-pakai.

const svg = (paths, extra = "") => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${paths}</svg>`;

export const Icons = {
  chat: svg(`<path d="M4 5h16v11H8l-4 4z"/>`),
  image: svg(`<rect x="3" y="4" width="18" height="16" rx="1.5"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M21 16l-5.5-5.5L3 20"/>`),
  mic: svg(`<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>`),
  waveform: svg(`<path d="M3 12h2l2-6 3 14 3-11 2 7 2-4h4"/>`),
  box: svg(`<path d="M3 8l9-5 9 5-9 5-9-5z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>`),
  activity: svg(`<path d="M3 12h4l2-7 4 14 3-9 2 4h4"/>`),
  download: svg(`<path d="M12 4v11"/><path d="M7 11l5 5 5-5"/><path d="M5 20h14"/>`),
  trash: svg(`<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>`),
  play: svg(`<path d="M6 4l14 8-14 8V4z"/>`),
  stop: svg(`<rect x="5" y="5" width="14" height="14" rx="1.5"/>`),
  send: svg(`<path d="M4 12l16-8-6 16-3-6-7-2z"/>`),
  upload: svg(`<path d="M12 15V4"/><path d="M7 9l5-5 5 5"/><path d="M5 20h14"/>`),
  sliders: svg(`<path d="M4 6h10M17 6h3M4 12h3M9 12h11M4 18h13M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>`),
  check: svg(`<path d="M4 12l6 6L20 6"/>`),
  alert: svg(`<path d="M12 3l10 18H2L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/>`),
  chevronDown: svg(`<path d="M6 9l6 6 6-6"/>`),
  x: svg(`<path d="M5 5l14 14M19 5L5 19"/>`),
  copy: svg(`<rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15V4h11"/>`),
  loader: svg(`<path d="M12 3v3M12 18v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M3 12h3M18 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>`),
  moon: svg(`<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>`),
  cpu: svg(`<rect x="7" y="7" width="10" height="10" rx="1"/><path d="M9 3v3M15 3v3M9 18v3M15 18v3M3 9h3M3 15h3M18 9h3M18 15h3"/>`),
  gpu: svg(`<rect x="3" y="7" width="18" height="10" rx="1.5"/><circle cx="8" cy="12" r="2"/><path d="M13 10h5M13 14h5"/>`),
  paperclip: svg(`<path d="M17 8l-7.5 7.5a3 3 0 0 1-4.24-4.24L13 3.5a2 2 0 1 1 2.83 2.83L8.5 13.66"/>`),
  plug: svg(`<path d="M8 3v5M16 3v5M6 8h12v3a6 6 0 0 1-12 0V8z"/><path d="M12 17v4"/>`),
  refresh: svg(`<path d="M4 4v5h5"/><path d="M20 20v-5h-5"/><path d="M5.5 9a7 7 0 0 1 12.6-2.5M18.5 15a7 7 0 0 1-12.6 2.5"/>`),
};
