// Nook brand art + UI icons (inline SVG, zero external assets)
// v0.14 — full icon refresh: one consistent 24px grid, 1.8 stroke, round caps,
// balanced optical weights, softer corners. Every icon redrawn by hand.

export const frogSvg = `
<svg class="frog" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <circle cx="21" cy="21" r="9.5" fill="#9fe09b"/>
  <circle cx="43" cy="21" r="9.5" fill="#9fe09b"/>
  <rect x="7" y="19" width="50" height="33" rx="16" fill="#9fe09b"/>
  <rect x="7" y="19" width="50" height="33" rx="16" fill="none" stroke="#7cc487" stroke-width="1.4"/>
  <circle cx="21" cy="20" r="5.2" fill="#fdfdf6"/>
  <circle cx="43" cy="20" r="5.2" fill="#fdfdf6"/>
  <circle cx="22" cy="21" r="2.5" fill="#20263a"/>
  <circle cx="42" cy="21" r="2.5" fill="#20263a"/>
  <circle cx="22.9" cy="20" r="0.9" fill="#fdfdf6"/>
  <circle cx="42.9" cy="20" r="0.9" fill="#fdfdf6"/>
  <circle cx="14.5" cy="38" r="3.6" fill="#f2b3c0" opacity="0.85"/>
  <circle cx="49.5" cy="38" r="3.6" fill="#f2b3c0" opacity="0.85"/>
  <path d="M26 41 q6 5.5 12 0" stroke="#4c8a5a" stroke-width="2.4" fill="none" stroke-linecap="round"/>
</svg>`;

const S = 'fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const svg = (inner) => `<svg viewBox="0 0 24 24" ${S}>${inner}</svg>`;

const I = {
  all: svg(`<path d="M4 6h16M4 12h16M4 18h9"/>`),
  star: svg(`<path d="m12 3.2 2.8 5.6 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.7l6.2-.9z"/>`),
  starFill: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3.2 2.8 5.6 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.7l6.2-.9z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" ${S} stroke-width="2.3"><path d="m4.5 12.5 5 5L20 6.5"/></svg>`,
  checkSq: svg(`<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><path d="m8.4 12.3 2.5 2.5 4.7-5.1"/>`),
  trash: svg(`<path d="M4 6.5h16"/><path d="M9.5 6.5V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v1.5"/><path d="M6 6.5l.9 12a2 2 0 0 0 2 1.9h6.2a2 2 0 0 0 2-1.9l.9-12"/><path d="M10 10.5v6M14 10.5v6"/>`),
  folder: svg(`<path d="M4 20h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-7.1a2 2 0 0 1-1.66-.89l-.98-1.47A2 2 0 0 0 8.6 3.75H4a2 2 0 0 0-2 2V18a2 2 0 0 0 2 2Z"/>`),
  settings: svg(`<circle cx="12" cy="12" r="3.1"/><path d="M18.6 15.4a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.56-1.11 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.08a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.08a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.56 1.03Z"/>`),
  pin: svg(`<path d="m9.2 4 6.4.02L17 10.3l2.3 2.7a.7.7 0 0 1-.53 1.15H5.23a.7.7 0 0 1-.53-1.15l2.3-2.7z"/><path d="M12 14.2V21"/>`),
  pinFill: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9.2 4 6.4.02L17 10.3l2.3 2.7a.7.7 0 0 1-.53 1.15H5.23a.7.7 0 0 1-.53-1.15l2.3-2.7z"/><path d="M12 14.2V21"/></svg>`,
  eye: svg(`<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>`),
  eyeOff: svg(`<path d="M10.7 6c.43-.06.86-.1 1.3-.1 6 0 9.5 6.1 9.5 6.1a17.8 17.8 0 0 1-2.16 2.96M6.6 6.6A17.5 17.5 0 0 0 2.5 12S6 18.2 12 18.2c1.52 0 2.88-.42 4.06-1.04M9.9 9.9a3 3 0 0 0 4.2 4.2"/><path d="m3 3 18 18"/>`),
  pencil: svg(`<path d="M4 20l.9-3.6L16.2 5.1a2 2 0 0 1 2.8 0l0 0a2 2 0 0 1 0 2.8L7.6 19.1zM14 7l3 3"/>`),
  search: `<svg viewBox="0 0 24 24" ${S} stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>`,
  export: svg(`<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M4 15v3.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V15"/>`),
  external: svg(`<path d="M15 3.5h5.5V9"/><path d="M20.5 3.5 11 13"/><path d="M18 13.5V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5.5"/>`),
  bell: svg(`<path d="M18 9.5a6 6 0 1 0-12 0c0 5-2 6.3-2 6.3h16s-2-1.3-2-6.3"/><path d="M10 19a2.1 2.1 0 0 0 4 0"/>`),
  repeat: svg(`<path d="m17 2.5 3.5 3.5-3.5 3.5"/><path d="M3 11.5v-1.5a4 4 0 0 1 4-4h13.5"/><path d="m7 21.5-3.5-3.5L7 14.5"/><path d="M21 12.5V14a4 4 0 0 1-4 4H3.5"/>`),
  calendar: svg(`<rect x="3.5" y="5" width="17" height="16" rx="3"/><path d="M8 3v4M16 3v4M3.5 10.5h17"/>`),
  chevronD: `<svg viewBox="0 0 24 24" ${S} stroke-width="2"><path d="m6 9 6 6 6-6"/></svg>`,
  copy: svg(`<rect x="9" y="9" width="12" height="12" rx="3"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>`),
  // v0.20 — markdown copy: an M with a down stroke, inside a rounded frame
  md: svg(`<rect x="3.5" y="5" width="17" height="14" rx="3"/><path d="M6.5 14.5v-5l2.5 3 2.5-3v5"/><path d="M16 9.5v5M14 12.5l2 2 2-2"/>`),
  download: svg(`<path d="M12 3.5V15M7.5 10.5 12 15l4.5-4.5"/><path d="M4 16v2.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V16"/>`),
  upload: svg(`<path d="M12 15V3.5M7.5 8 12 3.5 16.5 8"/><path d="M4 16v2.5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V16"/>`),
  clock: svg(`<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>`),
  link: svg(`<path d="M10 13.2a5 5 0 0 0 7.54.54l2.92-2.92a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 10.8a5 5 0 0 0-7.54-.54l-2.92 2.92a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`),
  zen: svg(`<path d="M4 8.5V6.5a2 2 0 0 1 2-2h2M16 4.5h2a2 2 0 0 1 2 2v2M20 15.5v2a2 2 0 0 1-2 2h-2M8 19.5H6a2 2 0 0 1-2-2v-2"/>`),
  mic: svg(`<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3.5M8.5 21.5h7"/>`),
  stop: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2.5"/></svg>`,
  play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.3v13.4a.7.7 0 0 0 1.06.6l10.7-6.7a.7.7 0 0 0 0-1.2L9.06 4.7A.7.7 0 0 0 8 5.3z"/></svg>`,
  pause: `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="4.5" width="4" height="15" rx="1.5"/><rect x="13.5" y="4.5" width="4" height="15" rx="1.5"/></svg>`,
  sparkle: svg(`<path d="M12 3.5l1.75 4.75L18.5 10l-4.75 1.75L12 16.5l-1.75-4.75L5.5 10l4.75-1.75z"/><path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z"/>`),
  user: svg(`<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5"/>`),
  clip: svg(`<path d="m21.2 11.7-8.8 8.8a5.5 5.5 0 0 1-7.8-7.8l8.8-8.8a3.7 3.7 0 0 1 5.2 5.2l-8.8 8.8a1.85 1.85 0 0 1-2.6-2.6l8.1-8.1"/>`),
  quote: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M5 16.5c-1.2 0-2.1-.9-2.1-2.2 0-2.7 1.9-5.4 4.6-6.9l.8 1.3c-1.7 1-2.7 2.4-2.9 3.8.3-.1.5-.1.8-.1 1.2 0 2.1.9 2.1 2.1S7.3 16.5 5 16.5zm8.6 0c-1.2 0-2.1-.9-2.1-2.2 0-2.7 1.9-5.4 4.6-6.9l.8 1.3c-1.7 1-2.7 2.4-2.9 3.8.3-.1.5-.1.8-.1 1.2 0 2.1.9 2.1 2.1s-1.1 2-3.3 2z"/></svg>`,
  book: svg(`<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4H6.5A2.5 2.5 0 0 0 4 6.5zM20 17v4H6.5A2.5 2.5 0 0 1 4 18.5"/>`),
  board: svg(`<rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="M8.7 7.5v9M15.3 7.5V13"/>`),
  image: svg(`<rect x="3.5" y="4" width="17" height="16" rx="3"/><circle cx="9" cy="9.5" r="1.7"/><path d="m3.5 16.5 4.7-4.7a1.5 1.5 0 0 1 2.1 0l4.2 4.2M13.5 14.5l1.7-1.7a1.5 1.5 0 0 1 2.1 0l3.2 3.2"/>`),
  mention: svg(`<circle cx="12" cy="12" r="4"/><path d="M16 12v1.5a2.5 2.5 0 0 0 5 0V12a9 9 0 1 0-3.5 7.1"/>`),
  wand: svg(`<path d="m3 21 9.5-9.5"/><path d="M15 4V2M15 10V8M11.5 6h2M18.5 6h2M12.2 6.8 11 5.6M17.8 6.8 19 5.6M18.5 12.5l1.2-1.2"/>`),
  palette: svg(`<path d="M12 3a9 9 0 1 0 0 18h1.8a2 2 0 0 0 1.4-3.4c-.8-.8-.2-2.1.9-2.1H19a2.5 2.5 0 0 0 2.5-2.5A9 9 0 0 0 12 3z"/><circle cx="7.5" cy="11.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="10.5" cy="7.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor" stroke="none"/>`),
  tag: svg(`<path d="M3.5 11V4.5A1.5 1.5 0 0 1 5 3h6.5a2 2 0 0 1 1.4.6l7.5 7.5a2 2 0 0 1 0 2.8l-6.5 6.5a2 2 0 0 1-2.8 0l-7.5-7.5a2 2 0 0 1-.6-1.4z"/><circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none"/>`),
  send: svg(`<path d="M21 3.5 10.7 13.8"/><path d="M21 3.5 14.2 21l-3.5-7.2L3.5 10.3z"/>`),
  plus: `<svg viewBox="0 0 24 24" ${S} stroke-width="2.1"><path d="M12 5.5v13M5.5 12h13"/></svg>`,
  minus: `<svg viewBox="0 0 24 24" ${S} stroke-width="2.1"><path d="M5.5 12h13"/></svg>`,
  close: `<svg viewBox="0 0 24 24" ${S} stroke-width="2.1"><path d="m6 6 12 12M18 6 6 18"/></svg>`,
  refresh: svg(`<path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 4v4h-4"/>`),
  moon: svg(`<path d="M20.5 14.5A8.5 8.5 0 1 1 9.5 3.5a7 7 0 0 0 11 11z"/>`),
  sun: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2.5 12h2M19.5 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>`),
  chart: svg(`<path d="M3.5 20.5h17"/><path d="M7 20.5v-6.5M12 20.5v-14M17 20.5V9.5"/>`),
  flame: svg(`<path d="M12 3.5c.3 2.9-4.2 4.9-4.2 9a4.2 4.2 0 0 0 8.4 0c0-1.2-.4-2.2-1-3.1 2.2 1 4.1 3 4.1 5.6a7.3 7.3 0 0 1-14.6 0c0-5.4 5.6-7.4 7.3-11.5z"/>`)
};

export function ico(name) {
  return I[name] || '';
}

export function setIcons() {
  document.querySelectorAll('[data-ico]').forEach((el) => {
    if (el.dataset.filled) return;
    el.innerHTML = ico(el.dataset.ico);
    el.dataset.filled = '1';
  });
  const logo = document.querySelector('.tb-logo');
  if (logo) {
    logo.innerHTML = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" width="19" height="19">
      <circle cx="21" cy="21" r="9.5" fill="#9fe09b"/>
      <circle cx="43" cy="21" r="9.5" fill="#9fe09b"/>
      <rect x="7" y="19" width="50" height="33" rx="16" fill="#9fe09b"/>
      <circle cx="22" cy="21" r="2.5" fill="#20263a"/>
      <circle cx="42" cy="21" r="2.5" fill="#20263a"/>
      <path d="M26 41 q6 5.5 12 0" stroke="#4c8a5a" stroke-width="2.6" fill="none" stroke-linecap="round"/>
    </svg>`;
  }
  const searchIcon = document.querySelector('.tb-search-icon');
  if (searchIcon) searchIcon.innerHTML = I.search;
}
