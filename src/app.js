// Nook — main application logic.
// v0.5: fixed window dragging, real task manager (due dates, priorities,
// subtasks, repeat, reminders), 8 themes, realtime autosave, backup,
// markdown toolbar, close-to-tray.

import { call, IS_TAURI, mockImageSrc } from './api.js';
import { renderMarkdown, setImgResolver } from './markdown.js';
import { frogSvg, ico, setIcons } from './art.js';

const $ = (sel) => document.querySelector(sel);
const DAY = 86400000;

// ---- image serving (v0.9): images become data: URLs in an async cache ----
// The old scheme fetched every preview image through the nookimg:// protocol,
// which locked the database on the UI thread — clicking Preview could freeze
// the whole window. Now markdown renders instantly with a placeholder and
// each image patches itself in as its bytes arrive; nothing ever blocks.
const IMG_PLACEHOLDER =
  'data:image/svg+xml;base64,' +
  btoa('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="3"><rect width="4" height="3" fill="rgba(128,128,128,0.18)"/></svg>');
const imageCache = new Map();   // id -> data URL
const imageInflight = new Map(); // id -> Promise

function resolveImg(id) {
  if (imageCache.has(id)) return imageCache.get(id);
  if (!IS_TAURI) {
    const m = mockImageSrc(id);
    if (m) {
      imageCache.set(id, m);
      return m;
    }
  } else {
    loadImageData(id);
  }
  return IMG_PLACEHOLDER;
}

async function loadImageData(id) {
  if (imageInflight.has(id)) return imageInflight.get(id);
  const p = (async () => {
    try {
      const d = await call('get_note_image_data', { id });
      if (d && d.data) {
        const url = `data:${d.mime};base64,${d.data}`;
        imageCache.set(id, url);
        document.querySelectorAll('img[data-nook-img]').forEach((el) => {
          if (el.dataset.nookImg === id && el.getAttribute('src') !== url) {
            el.src = url;
            el.classList.add('img-in');
          }
        });
      }
    } catch { /* image stays a placeholder */ }
  })();
  imageInflight.set(id, p);
  try {
    await p;
  } finally {
    imageInflight.delete(id);
  }
}

setImgResolver(resolveImg);

const THEMES = [
  { id: 'midnight', name: 'Cozy Midnight', dots: ['#171126', '#5aa2ff'], light: false },
  { id: 'oled',     name: 'OLED Black',    dots: ['#000000', '#3ddc97'], light: false },
  { id: 'forest',   name: 'Forest Night',  dots: ['#0f1a13', '#7ddb8a'], light: false },
  { id: 'ocean',    name: 'Ocean Deep',    dots: ['#0c1726', '#5ec8f8'], light: false },
  { id: 'sunset',   name: 'Sunset Ember',  dots: ['#211318', '#ff9e7d'], light: false },
  { id: 'frost',    name: 'Frost',         dots: ['#10141c', '#7dd3fc'], light: false },
  { id: 'espresso', name: 'Espresso',      dots: ['#1a1412', '#d4a373'], light: false },
  { id: 'nord',     name: 'Nordic Frost',  dots: ['#2e3440', '#88c0d0'], light: false },
  { id: 'dracula',  name: 'Dracula Night', dots: ['#282a36', '#bd93f9'], light: false },
  { id: 'crimson',  name: 'Crimson Dusk',  dots: ['#1f1216', '#ff6b81'], light: false },
  { id: 'cyber',    name: 'Neon Cyber',    dots: ['#0a0f14', '#00e5a0'], light: false },
  { id: 'royal',    name: 'Royal Amethyst',dots: ['#171226', '#a78bfa'], light: false },
  { id: 'paper',    name: 'Paper Light',   dots: ['#f5f2ea', '#379d55'], light: true },
  { id: 'sepia',    name: 'Warm Sepia',    dots: ['#f4ecdc', '#a4762e'], light: true },
  { id: 'mint',     name: 'Mint Day',      dots: ['#eef6f0', '#2f9e6e'], light: true },
  { id: 'sakura',   name: 'Sakura',        dots: ['#fdf3f5', '#e05c7e'], light: true },
  { id: 'lavender', name: 'Lavender',      dots: ['#f3f1fb', '#7c5cd6'], light: true },
  { id: 'coffee',   name: 'Coffee Cream',  dots: ['#f1e7dc', '#8a5a3b'], light: true },
  { id: 'rose',     name: 'Rose Quartz',   dots: ['#faf0f2', '#d16a8a'], light: true },
  { id: 'matcha',   name: 'Matcha Latte',  dots: ['#f2f5ea', '#6b9b37'], light: true },
  { id: 'cloud',    name: 'Cloud Nine',    dots: ['#eef2f7', '#3b82c4'], light: true },
  { id: 'peach',    name: 'Peach Orchard', dots: ['#fdf1ea', '#e07a3f'], light: true },
  { id: 'aurora',   name: 'Aurora',        dots: ['#0d1b1e', '#4de3c1'], light: false },
  { id: 'carbon',   name: 'Carbon',        dots: ['#161616', '#e0e0e0'], light: false }
];
const LIGHT_THEMES = THEMES.filter((t) => t.light).map((t) => t.id);

// v0.11 — accent color override (Settings → Look). '' = theme's own accent.
const ACCENTS = {
  '':      null,
  blue:   { name: 'Default Blue', a: '#5aa2ff', s: '#82bcff', t: '#0a2550', soft: 'rgba(90,162,255,.15)',  glow: 'rgba(90,162,255,.45)'  },
  azure:  { name: 'Sky Azure',   a: '#38bdf8', s: '#6fd2fb', t: '#062a3c', soft: 'rgba(56,189,248,.15)',  glow: 'rgba(56,189,248,.45)'  },
  mint:   { name: 'Fresh Mint',  a: '#4ade9e', s: '#7dedbb', t: '#04301d', soft: 'rgba(74,222,158,.15)',  glow: 'rgba(74,222,158,.42)'  },
  violet: { name: 'Violet',      a: '#a78bfa', s: '#c0aafc', t: '#241457', soft: 'rgba(167,139,250,.16)', glow: 'rgba(167,139,250,.42)' },
  rose:   { name: 'Rose',        a: '#fb7ba2', s: '#ff9dbe', t: '#4a0c22', soft: 'rgba(251,123,162,.16)', glow: 'rgba(251,123,162,.42)' },
  amber:  { name: 'Amber',       a: '#fbbf24', s: '#ffd45e', t: '#3d2a02', soft: 'rgba(251,191,36,.16)',  glow: 'rgba(251,191,36,.4)'   },
  teal:   { name: 'Teal',        a: '#2dd4bf', s: '#5ee6d6', t: '#03302b', soft: 'rgba(45,212,191,.15)',  glow: 'rgba(45,212,191,.4)'   }
};

const PRIO_LABEL = ['', 'Low', 'Medium', 'High'];
const REPEAT_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

// ---------------------------------------------------------------- AI providers ----
// Every provider talks the OpenAI-compatible /chat/completions protocol.
const AI_PROVIDERS = [
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', key: true, models: true, hint: '400+ models — one key. openrouter.ai/keys' },
  { id: 'zai',        name: 'Z.ai (GLM)', url: 'https://api.z.ai/api/paas/v4', key: true, models: false, hint: 'GLM-4.6 · GLM-4.5 · GLM-4.5-Air — z.ai model names', suggestModels: ['glm-4.6', 'glm-4.5', 'glm-4.5-air', 'glm-4.5-flash', 'glm-4-plus'] },
  { id: 'openai',     name: 'OpenAI',     url: 'https://api.openai.com/v1', key: true, models: true, hint: 'GPT-4o / GPT-4.1 family — platform.openai.com' },
  { id: 'groq',       name: 'Groq',       url: 'https://api.groq.com/openai/v1', key: true, models: true, hint: 'Llama & Mixtral at crazy speed — console.groq.com' },
  { id: 'gemini',     name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai', key: true, models: true, hint: 'Use an AI Studio key — aistudio.google.com/apikey' },
  { id: 'deepseek',   name: 'DeepSeek',   url: 'https://api.deepseek.com/v1', key: true, models: true, hint: 'deepseek-chat / deepseek-reasoner', suggestModels: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'ollama',     name: 'Ollama (local)', url: 'http://127.0.0.1:11434/v1', key: false, models: true, hint: 'Free & offline — models you pulled with ollama' },
  { id: 'lmstudio',   name: 'LM Studio (local)', url: 'http://127.0.0.1:1234/v1', key: false, models: true, hint: 'Point LM Studio at port 1234 and go' },
  { id: 'custom',     name: 'Custom',     url: '', key: true, models: true, hint: 'Any OpenAI-compatible endpoint — e.g. Together, Mistral, xAI, OpenRouter-style base URLs' }
];
const DEFAULT_AI_SETTINGS = {
  active: '',
  providers: {},   // id -> { url, apiKey, model }
  systemPrompt: 'You are Nook AI, a friendly assistant inside a notes app. Be concise. Use Markdown.'
};

const state = {
  folders: [],
  folderCountMap: {},   // folderId -> live note count
  notes: [],            // summaries for the current view
  tasks: [],
  stats: null,
  view: { type: 'all' }, // all | favorites | trash | folder | tasks | recordings | chat | search
  activeTag: null,       // tag filter for the note list
  sort: localStorage.getItem('nook.sort') || 'updated',
  taskFilter: localStorage.getItem('nook.taskFilter') || 'all',
  taskSort: localStorage.getItem('nook.taskSort') || 'manual',
  expandedTask: null,
  currentNoteId: null,
  openNote: null,       // full note object being edited
  preview: false,
  query: '',
  userName: '',         // v0.10 — set during onboarding, used for greetings
  settings: {
    theme: 'midnight', fontSize: '15', editorFont: 'sans', editorWidth: 'normal',
    closeToTray: '0', autosave: '1', spellcheck: '0', density: 'cozy',
    defaultFolder: '', autostart: '0', edLine: '1.6', defaultView: 'all',
    ai: JSON.parse(JSON.stringify(DEFAULT_AI_SETTINGS))
  },
  tabs: [],              // open note ids, in order
  recPoll: null,         // recorder status poller
  audioEl: null,         // one shared audio player
  recViewLoaded: false,
  saveTimer: null,
  taskSaveTimer: null,
  saving: false,
  bootDone: false,
  // AI chat
  chats: [],
  chatId: null,
  chatMsgs: [],
  chatUseNote: false,
  aiStreaming: false,
  aiReqId: null,
  aiStreamText: ''
};

// The keystrokes typed since the last completed save. queueSave() fills it,
// flushSave() persists it and clears it. NEVER compare the DB copy against
// the DOM after mutating it first — that made v0.4 autosave a no-op.
let pending = null;
// v0.9: tags JSON as of the last successful save, per note. The tag editor
// mutates state.openNote.tags directly, so comparing against the note object
// itself can never detect a tags-only change (that froze the status on
// "Saving…" and silently dropped tags).
const savedTagsMap = new Map();

// ------------------------------------------------------------------ utils ----

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function startOfDay(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = startOfDay(Date.now()) - startOfDay(ts);
  if (diff <= 0) return 'Today';
  if (diff <= DAY) return 'Yesterday';
  if (diff < 7 * DAY) return d.toLocaleDateString(undefined, { weekday: 'short' });
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' })
  });
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return fmtDate(ts);
}

function tsToInput(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inputToTs(v) {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function dueLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diffDays = Math.round((startOfDay(ts) - startOfDay(Date.now())) / DAY);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  const timeStr = hasTime
    ? ' · ' + d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : '';
  if (diffDays === 0) return 'Today' + timeStr;
  if (diffDays === 1) return 'Tomorrow' + timeStr;
  if (diffDays === -1) return 'Yesterday' + timeStr;
  if (diffDays < -1) return `${-diffDays}d overdue`;
  const label = d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return label + timeStr;
}

function toast(msg, opts = {}) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  const icon = opts.icon || 'check';
  el.innerHTML = `<span class="t-ico">${ico(icon)}</span><span>${esc(msg)}</span>`;
  if (opts.action) {
    const btn = document.createElement('button');
    btn.className = 't-action';
    btn.textContent = opts.action.label;
    btn.addEventListener('click', () => {
      opts.action.fn();
      kill();
    });
    el.appendChild(btn);
  }
  root.appendChild(el);
  const kill = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 260);
  };
  setTimeout(kill, opts.ms || 2600);
}

function setSaveState(mode, text) {
  const wrap = $('#save-state');
  wrap.classList.toggle('saving', mode === 'saving');
  $('#save-text').textContent = text;
}

// ------------------------------------------------------------------ modals ----

function closeModal() {
  const root = $('#overlay-root');
  root.innerHTML = '';
}

// ------------------------------------------------------------------ zen mode (v0.10) ----
// Ctrl+Shift+F / Ctrl+\ / the ⊞ toolbar button — everything hides but your words.
function toggleZen() {
  const on = document.body.classList.toggle('zen');
  let pill = $('#zen-pill');
  if (on) {
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'zen-pill';
      pill.type = 'button';
      pill.innerHTML = `${ico('zen')} Zen — Esc to exit`;
      pill.addEventListener('click', toggleZen);
      document.body.appendChild(pill);
    }
    pill.classList.remove('hidden');
    toast('Zen mode — nothing between you and the page', { icon: 'zen' });
  } else if (pill) {
    pill.classList.add('hidden');
  }
}

// ------------------------------------------------------------------ confetti (v0.10) ----
// A tiny burst of paper squares wherever a little win just happened:
// a task ticked done, a Board card sailed into Done, onboarding finished.
const CONFETTI_COLORS = ['#5aa2ff', '#82bcff', '#b9a8ff', '#7dd3fc', '#4de3c1', '#f5c26b', '#ff8fab', '#a9c9ff'];
function confettiBurst(x, y, n = 18) {
  for (let i = 0; i < n; i++) {
    const p = document.createElement('i');
    p.className = 'confetti';
    const size = 5 + Math.random() * 5;
    p.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size * (Math.random() > 0.5 ? 1 : 0.45)}px;background:${CONFETTI_COLORS[i % CONFETTI_COLORS.length]}`;
    document.body.appendChild(p);
    const ang = Math.random() * Math.PI * 2;
    const v = 46 + Math.random() * 78;
    const dx = Math.cos(ang) * v;
    const dy = Math.sin(ang) * v - 70;
    p.animate(
      [
        { transform: 'translate(-50%,-50%) rotate(0deg)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy + 150}px)) rotate(${360 + Math.random() * 420}deg)`, opacity: 0 }
      ],
      { duration: 750 + Math.random() * 550, easing: 'cubic-bezier(.15,.6,.4,1)' }
    ).onfinish = () => p.remove();
    setTimeout(() => p.remove(), 1600); // belt & braces
  }
}

function confettiAtEl(el) {
  try {
    const r = el.getBoundingClientRect();
    confettiBurst(r.left + r.width / 2, r.top + r.height / 2, 16);
  } catch { /* never let confetti break anything */ }
}

// ------------------------------------------------------------------ greetings (v0.10) ----
function greetingWord() {
  const h = new Date().getHours();
  return h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : h < 21 ? 'Good evening' : 'Good night';
}

// v0.10 — global settings writer (openSettings has its own local one)
async function setSetting(key, value) {
  await call('set_setting', { key, value });
}

function confirmModal({ title, body, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    const root = $('#overlay-root');
    root.innerHTML = `
      <div class="overlay">
        <div class="modal">
          <h3>${esc(title)}</h3>
          <div class="modal-body">${esc(body)}</div>
          <div class="modal-actions">
            <button class="btn ghost" data-x="cancel">Cancel</button>
            <button class="btn ${danger ? 'danger' : 'primary'}" data-x="ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    root.querySelector('[data-x="cancel"]').addEventListener('click', () => done(false));
    root.querySelector('[data-x="ok"]').addEventListener('click', () => done(true));
    root.querySelector('.overlay').addEventListener('mousedown', (e) => {
      if (e.target === e.currentTarget) done(false);
    });
    root.querySelector('[data-x="ok"]').focus();
  });
}

function promptModal({ title, body = '', value = '', placeholder = '', confirmLabel = 'Save' }) {
  return new Promise((resolve) => {
    const root = $('#overlay-root');
    root.innerHTML = `
      <div class="overlay">
        <div class="modal">
          <h3>${esc(title)}</h3>
          ${body ? `<div class="modal-body">${esc(body)}</div>` : ''}
          <input type="text" id="pm-input" value="${esc(value)}" placeholder="${esc(placeholder)}" spellcheck="false" maxlength="60" />
          <div class="modal-actions">
            <button class="btn ghost" data-x="cancel">Cancel</button>
            <button class="btn primary" data-x="ok">${esc(confirmLabel)}</button>
          </div>
        </div>
      </div>`;
    const input = root.querySelector('#pm-input');
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    root.querySelector('[data-x="cancel"]').addEventListener('click', () => done(null));
    root.querySelector('[data-x="ok"]').addEventListener('click', () => done(input.value.trim()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value.trim());
      if (e.key === 'Escape') done(null);
    });
    root.querySelector('.overlay').addEventListener('mousedown', (e) => {
      if (e.target === e.currentTarget) done(null);
    });
    setTimeout(() => {
      input.focus();
      input.select();
    }, 30);
  });
}

// ------------------------------------------------------------------ titlebar ----
// Drag is handled here in JS (startDragging) — works on every pixel of the
// titlebar, unlike the CSS-only drag region that kept failing.

function wireTitlebar() {
  const getWin = async () => {
    if (window.__TAURI_WINDOW__) return window.__TAURI_WINDOW__;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    window.__TAURI_WINDOW__ = getCurrentWindow();
    return window.__TAURI_WINDOW__;
  };
  const min = $('#win-min');
  const max = $('#win-max');
  const close = $('#win-close');

  const updateMaxIcon = async () => {
    if (!IS_TAURI) return;
    try {
      const win = await getWin();
      const isMax = await win.isMaximized();
      max.querySelector('.ico-max').classList.toggle('hidden', isMax);
      max.querySelector('.ico-restore').classList.toggle('hidden', !isMax);
    } catch {
      /* non-tauri or early boot */
    }
  };
  window.__nookUpdateMax = updateMaxIcon;
  updateMaxIcon();

  // THE drag fix: mousedown anywhere on the titlebar (except real controls)
  // starts a native window drag.
  const tb = $('#titlebar');
  if (IS_TAURI) {
    tb.addEventListener('mousedown', async (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('input, button, select, textarea')) return;
      try {
        const win = await getWin();
        await win.startDragging();
      } catch {
        /* ignore */
      }
    });
    tb.addEventListener('dblclick', async (e) => {
      if (e.target.closest('input, button, select, textarea')) return;
      try {
        const win = await getWin();
        await win.toggleMaximize();
        setTimeout(updateMaxIcon, 120);
      } catch {
        /* ignore */
      }
    });
    getWin().then((win) => win.onResized(() => updateMaxIcon())).catch(() => {});
  }

  min.addEventListener('click', async () => {
    if (!IS_TAURI) return;
    try {
      (await getWin()).minimize();
    } catch { /* ignore */ }
  });

  max.addEventListener('click', async () => {
    if (!IS_TAURI) return;
    try {
      const win = await getWin();
      await win.toggleMaximize();
      setTimeout(updateMaxIcon, 120);
    } catch { /* ignore */ }
  });

  close.addEventListener('click', async () => {
    if (!IS_TAURI) return;
    try {
      await flushSave(); // never lose a keystroke
      (await getWin()).close();
    } catch { /* ignore */ }
  });

  // search
  const input = $('#search-input');
  const clearBtn = $('#search-clear');
  let searchTimer = null;

  input.addEventListener('input', () => {
    clearBtn.classList.toggle('hidden', !input.value);
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.query = input.value;
      if (input.value.trim()) {
        setView({ type: 'search' }, { keepQuery: true });
      } else if (state.view.type === 'search') {
        setView({ type: 'all' });
      }
    }, 220);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      input.value = '';
      clearBtn.classList.add('hidden');
      state.query = '';
      if (state.view.type === 'search') setView({ type: 'all' });
      input.blur();
    }
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.classList.add('hidden');
    state.query = '';
    input.focus();
    if (state.view.type === 'search') setView({ type: 'all' });
  });
}

// ------------------------------------------------------------------ sidebar ----

const VIEW_META = [
  { type: 'all', label: 'All Notes', icon: 'all' },
  { type: 'favorites', label: 'Favorites', icon: 'star' },
  { type: 'tasks', label: 'Tasks', icon: 'checkSq' },
  { type: 'board', label: 'Board', icon: 'board' },
  { type: 'chat', label: 'AI Chat', icon: 'sparkle' },
  { type: 'recordings', label: 'Recordings', icon: 'mic' },
  { type: 'trash', label: 'Trash', icon: 'trash' }
];

function tagsOf(n) {
  try {
    const raw = n.tags;
    const t = typeof raw === 'string' ? JSON.parse(raw || '[]') : raw;
    return Array.isArray(t) ? t.filter((x) => typeof x === 'string' && x.trim()) : [];
  } catch {
    return [];
  }
}

function allTags() {
  const map = new Map();
  for (const n of state.notes) {
    for (const t of tagsOf(n)) map.set(t, (map.get(t) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function renderSidebar() {
  const s = state.stats || { notes: 0, favorites: 0, openTasks: 0, trash: 0 };

  const viewsEl = $('#sb-views');
  viewsEl.innerHTML = VIEW_META.map((v) => {
    const active = state.view.type === v.type && !state.activeTag ? ' active' : '';
    const count = v.type === 'all' ? s.notes : v.type === 'favorites' ? s.favorites : v.type === 'tasks' ? s.openTasks : v.type === 'board' ? (state.tasks.filter((x) => !x.done).length || s.openTasks) : s.trash;
    const showCount = v.type !== 'tasks' && v.type !== 'board' && v.type !== 'recordings' && v.type !== 'chat';
    return `
      <button class="sb-row${active}" data-view="${v.type}">
        <span class="sb-ico">${ico(v.icon)}</span>
        <span class="sb-name">${v.label}</span>
        ${showCount ? `<span class="sb-count">${count}</span>` : ''}
      </button>`;
  }).join('');

  viewsEl.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', () => {
      state.activeTag = null;
      setView({ type: el.dataset.view });
    });
  });

  // v0.9 — tags section in the sidebar
  const tagsWrap = $('#sb-tags-wrap');
  const tagsEl = $('#sb-tags');
  const tags = allTags();
  tagsWrap.classList.toggle('hidden', !tags.length || state.view.type === 'tasks' || state.view.type === 'board' || state.view.type === 'recordings' || state.view.type === 'chat');
  tagsEl.innerHTML = tags
    .slice(0, 12)
    .map(
      ([t, c]) => `
      <button class="sb-row tag-row${state.activeTag === t ? ' active' : ''}" data-tag="${esc(t)}">
        <span class="sb-ico">${ico('tag')}</span>
        <span class="sb-name">${esc(t)}</span>
        <span class="sb-count">${c}</span>
      </button>`
    )
    .join('');
  tagsEl.querySelectorAll('[data-tag]').forEach((el) => {
    el.addEventListener('click', async () => {
      const t = el.dataset.tag;
      state.activeTag = state.activeTag === t ? null : t;
      renderSidebar();
      await refreshNotes();
      renderNoteList();
    });
  });

  const folEl = $('#sb-folders');
  if (!state.folders.length) {
    folEl.innerHTML = `<div class="sb-folders-empty">No folders yet</div>`;
  } else {
    folEl.innerHTML = state.folders
      .map((f) => {
        const active = state.view.type === 'folder' && state.view.folderId === f.id ? ' active' : '';
        const count = state.folderCountMap[f.id] || 0;
        return `
        <div class="sb-row folder-row${active}" data-fid="${esc(f.id)}" role="button" tabindex="0">
          <span class="sb-ico">${ico('folder')}</span>
          <span class="sb-name">${esc(f.name)}</span>
          <span class="sb-factions">
            <button class="f-ren" title="Rename">${ico('pencil')}</button>
            <button class="f-del" title="Delete folder">&times;</button>
          </span>
          <span class="sb-count">${count}</span>
        </div>`;
      })
      .join('');

    folEl.querySelectorAll('.folder-row').forEach((row) => {
      const fid = row.dataset.fid;
      row.addEventListener('click', (e) => {
        if (e.target.closest('.f-ren') || e.target.closest('.f-del')) return;
        setView({ type: 'folder', folderId: fid });
      });
      row.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const f = state.folders.find((x) => x.id === fid);
        if (!f) return;
        showMenu(e.clientX, e.clientY, [
          { label: 'New note here', icon: 'pencil', fn: async () => { const note = await call('create_note', { folderId: fid }); await refreshFolders(); await refreshNotes(); renderNoteList(); if (state.view.type !== 'folder') setView({ type: 'folder', folderId: fid }); selectNote(note.id); } },
          { sep: true },
          { label: 'Rename folder', icon: 'pencil', fn: () => row.querySelector('.f-ren').click() },
          { label: 'Delete folder', icon: 'trash', danger: true, fn: () => row.querySelector('.f-del').click() }
        ]);
      });
      row.querySelector('.f-ren').addEventListener('click', async () => {
        const f = state.folders.find((x) => x.id === fid);
        const name = await promptModal({
          title: 'Rename folder',
          value: f.name,
          placeholder: 'Folder name',
          confirmLabel: 'Rename'
        });
        if (name && name.trim()) {
          await call('rename_folder', { id: fid, name: name.trim() });
          await refreshFolders();
          renderSidebar();
          if (state.view.type === 'folder' && state.view.folderId === fid) renderListHeader();
          toast('Folder renamed');
        }
      });
      row.querySelector('.f-del').addEventListener('click', async () => {
        const f = state.folders.find((x) => x.id === fid);
        const ok = await confirmModal({
          title: 'Delete folder',
          body: `Delete "${f.name}"? Notes inside it stay safe — they just become unfiled.`,
          confirmLabel: 'Delete folder',
          danger: true
        });
        if (ok) {
          await call('delete_folder', { id: fid });
          if (state.view.type === 'folder' && state.view.folderId === fid) {
            setView({ type: 'all' });
          } else {
            await refreshAll();
          }
          toast('Folder deleted');
        }
      });
    });
  }
}

// ------------------------------------------------------------------ note list ----

function currentViewTitle() {
  if (state.activeTag) return `#${state.activeTag}`;
  switch (state.view.type) {
    case 'favorites': return 'Favorites';
    case 'trash': return 'Trash';
    case 'tasks': return 'Tasks';
    case 'recordings': return 'Recordings';
    case 'chat': return 'AI Chat';
    case 'search': return state.query.trim() ? `Results for “${state.query.trim()}”` : 'Search';
    case 'folder': {
      const f = state.folders.find((x) => x.id === state.view.folderId);
      return f ? f.name : 'Folder';
    }
    default: return 'All Notes';
  }
}

function renderListHeader() {
  $('#nl-title').textContent = currentViewTitle();
  $('#nl-count').textContent =
    state.view.type === 'tasks' || state.view.type === 'recordings' || state.view.type === 'chat' ? '' : `${state.notes.length}`;
  $('#nl-sort').value = state.sort;
  $('#nl-sort').style.display =
    state.view.type === 'tasks' || state.view.type === 'recordings' || state.view.type === 'chat' ? 'none' : '';
  const emptyBtn = $('#btn-empty-trash');
  emptyBtn.classList.toggle('hidden', !(state.view.type === 'trash' && state.notes.length > 0));
}

function renderNoteList(opts = {}) {
  renderListHeader();
  const el = $('#nl-items');
  // entry animation only on view switches — never while typing (saves reflow)
  el.classList.toggle('nl-anim', opts.animate !== false);

  if (state.view.type === 'tasks' || state.view.type === 'board' || state.view.type === 'recordings' || state.view.type === 'chat') {
    el.innerHTML = '';
    return;
  }

  if (!state.notes.length) {
    const messages = {
      all: ['Nothing here yet', 'Your nook is cozy and quiet. Write your first note!'],
      favorites: ['No favorites yet', 'Star a note and it will show up here.'],
      trash: ['Trash is empty', 'Deleted notes rest here until you empty it.'],
      search: ['No matches', 'Try a different search — titles and note text are searched.']
    };
    const folderMsg = ['This folder is empty', 'Add a note to fill it up.'];
    const [h, p] = state.view.type === 'folder' ? folderMsg : messages[state.view.type] || messages.all;
    el.innerHTML = `
      <div class="nl-empty">
        ${frogSvg}
        <div><b>${h}</b></div>
        <div>${p}</div>
      </div>`;
    return;
  }

  el.innerHTML = state.notes
    .map((n, i) => {
      const selected = n.id === state.currentNoteId ? ' selected' : '';
      const folder = state.folders.find((f) => f.id === n.folderId);
      const flags = [];
      if (n.pinned) flags.push(`<span class="f-pin" title="Pinned">${ico('pin')}</span>`);
      if (n.favorite) flags.push(`<span class="f-fav" title="Favorite">${ico('starFill')}</span>`);
      const titleText = n.title.trim() || 'Untitled note';
      const tags = tagsOf(n).slice(0, 3);
      return `
      <div class="note-card${selected}" data-nid="${esc(n.id)}" style="--i:${Math.min(14, i)}">
        <div class="nc-title">${esc(titleText)}${
          flags.length ? `<span class="nc-flags">${flags.join('')}</span>` : ''
        }</div>
        <div class="nc-snippet">${esc(n.snippet || 'No content yet')}</div>
        <div class="nc-meta">
          <span>${fmtDate(n.updatedAt)}</span>
          ${folder ? `<span>·</span><span class="nc-folder-name">${esc(folder.name)}</span>` : ''}
          ${tags.length ? `<span class="nc-tags">${tags.map((t) => `<span class="nc-tag">#${esc(t)}</span>`).join('')}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  el.querySelectorAll('.note-card').forEach((card) => {
    card.draggable = true;
    card.addEventListener('click', () => selectNote(card.dataset.nid));
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const nid = card.dataset.nid;
      const n = state.notes.find((x) => x.id === nid);
      if (!n) return;
      if (n.trashed || state.view.type === 'trash') {
        showMenu(e.clientX, e.clientY, [
          { label: 'Open', icon: 'pencil', fn: () => selectNote(nid) },
          { label: 'Restore note', icon: 'check', fn: async () => { await call('trash_note', { id: nid, trashed: false }); await refreshAll(); refreshStatsOnly(); toast('Note restored'); } },
          { sep: true },
          { label: 'Delete forever', icon: 'trash', danger: true, fn: async () => {
            const ok = await confirmModal({ title: 'Delete forever?', body: 'This note will be gone for good. There is no undo.', confirmLabel: 'Delete forever', danger: true });
            if (!ok) return;
            await call('delete_note_forever', { id: nid });
            if (state.currentNoteId === nid) { state.currentNoteId = null; state.openNote = null; renderEditor(); closeTab(nid, { switchAway: false }); }
            state.notes = state.notes.filter((x) => x.id !== nid);
            renderNoteList(); renderTabs(); refreshStatsOnly();
            toast('Deleted forever');
          } }
        ]);
        return;
      }
      const folder = state.folders.find((f) => f.id === n.folderId);
      showMenu(e.clientX, e.clientY, [
        { label: 'Open', icon: 'pencil', fn: () => selectNote(nid) },
        { label: n.pinned ? 'Unpin' : 'Pin to top', icon: 'pin', fn: async () => { await call('pin_note', { id: nid, pinned: !n.pinned }); n.pinned = !n.pinned; renderNoteList(); refreshNotes().then(renderNoteList); } },
        { label: n.favorite ? 'Remove favorite' : 'Favorite', icon: 'star', fn: async () => { await call('favorite_note', { id: nid, favorite: !n.favorite }); n.favorite = !n.favorite; renderNoteList(); refreshStatsOnly(); } },
        { sep: true },
        { label: 'Duplicate', icon: 'copy', fn: async () => { const copy = await call('duplicate_note', { id: nid }); await refreshAll(); if (copy) selectNote(copy.id); toast('Note duplicated', { icon: 'copy' }); } },
        { label: 'Export as Markdown', icon: 'export', fn: async () => { try { const p = await call('export_note', { id: nid }); if (p) toast(`Exported to ${p.split(/[\\/]/).pop()}`); } catch (err) { if (!/cancel/i.test(err.message)) toast('Export failed'); } } },
        { sep: true },
        { label: 'Move to Trash', icon: 'trash', danger: true, fn: async () => { await call('trash_note', { id: nid, trashed: true }); state.notes = state.notes.filter((x) => x.id !== nid); if (state.currentNoteId === nid) closeTab(nid); renderNoteList(); refreshStatsOnly(); toast('Moved to trash', { icon: 'trash' }); } }
      ]);
    });
  });
}

// ------------------------------------------------------------------ editor ----

function renderFolderSelect() {
  const sel = $('#ed-folder');
  const opts = ['<option value="">Unfiled</option>']
    .concat(
      state.folders.map(
        (f) =>
          `<option value="${esc(f.id)}"${state.openNote && state.openNote.folderId === f.id ? ' selected' : ''}>${esc(f.name)}</option>`
      )
    )
    .join('');
  sel.innerHTML = opts;
  if (state.openNote) sel.value = state.openNote.folderId || '';
}

function renderEditorToolbar() {
  const n = state.openNote;
  const trashMode = !!(n && n.trashed);
  const editable = n && !trashMode;

  $('#btn-pin').innerHTML = ico(n && n.pinned ? 'pinFill' : 'pin');
  $('#btn-pin').classList.toggle('on', !!(n && n.pinned));
  $('#btn-fav').innerHTML = ico(n && n.favorite ? 'starFill' : 'star');
  $('#btn-fav').classList.toggle('on-fav', !!(n && n.favorite));
  $('#btn-duplicate').innerHTML = ico('copy');
  $('#btn-ai').innerHTML = ico('sparkle');
  $('#btn-image').innerHTML = ico('image');
  $('#btn-preview').innerHTML = ico('eye');
  $('#btn-preview').classList.toggle('on', state.preview);
  $('#btn-zen').innerHTML = ico('zen');
  $('#btn-zen').classList.toggle('on', document.body.classList.contains('zen'));
  $('#btn-export').innerHTML = ico('export');
  $('#btn-trash').innerHTML = ico('trash');

  ['#btn-pin', '#btn-fav', '#btn-duplicate', '#btn-ai', '#btn-image', '#btn-preview', '#btn-zen', '#btn-export', '#btn-trash'].forEach((s) => {
    $(s).style.display = editable ? '' : 'none';
  });
  $('.ed-folder-wrap').style.display = editable ? '' : 'none';
  $('#md-bar').classList.toggle('hidden', !editable || state.preview);
  $('#ed-text').readOnly = !editable;
  $('#ed-title').readOnly = !editable;
  $('#ed-trash-banner').classList.toggle('hidden', !trashMode);
}

function renderEditor() {
  const emptyEl = $('#ed-empty');
  const pane = $('#ed-pane');

  if (!state.openNote) {
    pane.classList.add('hidden');
    emptyEl.classList.remove('hidden');
    emptyEl.className = 'empty-state';
    const inTrash = state.view.type === 'trash';
    emptyEl.innerHTML = inTrash
      ? `${frogSvg}<h2>Select a note</h2><p>Click a trashed note to restore or remove it forever.</p>`
      : `${frogSvg}<h2>Nothing selected</h2><p>Pick a note from the list, or start something new.</p>
         ${state.view.type !== 'trash' ? '<button class="btn primary" id="ed-new-note">Write a note</button>' : ''}`;
    const btn = $('#ed-new-note');
    if (btn) btn.addEventListener('click', () => createNote());
    return;
  }

  emptyEl.classList.add('hidden');
  emptyEl.className = 'hidden';
  pane.classList.remove('hidden');

  const n = state.openNote;
  $('#ed-title').value = n.title;
  $('#ed-text').value = n.content;
  renderFolderSelect();
  renderEditorToolbar();
  renderEditorTags();
  applyPreviewMode();
  updateWordCount();
  closeMention();
  closeFindBar();
  loadBacklinks();
}

// ---- v0.9: tag chips under the editor toolbar ----

function renderEditorTags() {
  const wrap = $('#ed-tags');
  const n = state.openNote;
  if (!wrap) return;
  const trashMode = !!(n && n.trashed);
  const tags = n ? tagsOf(n) : [];
  wrap.classList.toggle('hidden', !n || trashMode);
  if (!n || trashMode) return;
  wrap.innerHTML = `
    ${tags
      .map(
        (t) => `
      <span class="ed-tag" data-t="${esc(t)}">
        #${esc(t)}
        <button class="ed-tag-x" title="Remove tag" data-x="${esc(t)}">&times;</button>
      </span>`
      )
      .join('')}
    <input id="ed-tag-input" type="text" placeholder="+ tag" maxlength="24" spellcheck="false" autocomplete="off" />
  `;
  wrap.querySelectorAll('.ed-tag-x').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.x;
      const cur = tagsOf(state.openNote);
      state.openNote.tags = JSON.stringify(cur.filter((x) => x !== t));
      renderEditorTags();
      renderSidebar();
      renderNoteList({ animate: false });
      queueSave();
    });
  });
  const input = wrap.querySelector('#ed-tag-input');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const t = input.value.trim().replace(/^#/, '').replace(/[",]/g, '').slice(0, 24);
      if (!t) return;
      const cur = tagsOf(state.openNote);
      if (!cur.some((x) => x.toLowerCase() === t.toLowerCase())) {
        state.openNote.tags = JSON.stringify([...cur, t]);
        renderEditorTags();
        renderSidebar();
        renderNoteList({ animate: false });
        queueSave();
      }
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      state.openNote.tags = JSON.stringify(tags.slice(0, -1));
      renderEditorTags();
      renderSidebar();
      renderNoteList({ animate: false });
      queueSave();
    }
  });
}

function applyPreviewMode() {
  const showPreview = state.preview;
  $('#ed-text').classList.toggle('hidden', showPreview);
  const pv = $('#ed-preview');
  pv.classList.toggle('hidden', !showPreview);
  if (showPreview) {
    // THE v0.7 "preview shows old text" fix: always render the LIVE textarea
    // content (state.openNote can lag one autosave tick behind).
    // v0.9: rendering never blocks — embedded images arrive through the async
    // cache and patch themselves in, so clicking Preview can't freeze anymore.
    const text = $('#ed-text') ? $('#ed-text').value : (state.openNote ? state.openNote.content : '');
    pv.innerHTML = renderMarkdown(text);
    pv.scrollTop = 0;
    if (IS_TAURI) {
      const ids = new Set();
      const re = /nookimg:\/\/([A-Za-z0-9_-]+)/g;
      let m;
      while ((m = re.exec(text)) !== null) ids.add(m[1]);
      ids.forEach((id) => {
        if (!imageCache.has(id)) loadImageData(id);
      });
    }
  }
  $('#md-bar').classList.toggle('hidden', !state.openNote || showPreview || !!state.openNote.trashed);
}

function updateWordCount(text) {
  if (!state.openNote) {
    $('#stats-right').textContent = '';
    return;
  }
  const body = text !== undefined ? text : state.openNote.content;
  const words = body.trim() ? body.trim().split(/\s+/).length : 0;
  const chars = body.length;
  const mins = words > 0 ? Math.max(1, Math.round(words / 200)) : 0;
  $('#stats-right').textContent =
    `${words} words · ${chars} chars${mins ? ` · ${mins} min read` : ''}`;
}

// -------- markdown toolbar --------

function mdAction(kind) {
  const ta = $('#ed-text');
  if (!ta || ta.readOnly) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const v = ta.value;
  const sel = v.slice(s, e);

  const replace = (text, selStart, selEnd) => {
    ta.value = v.slice(0, s) + text + v.slice(e);
    ta.focus();
    ta.setSelectionRange(selStart, selEnd);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  };

  if (kind === 'bold') {
    const t = sel || 'bold text';
    replace(`**${t}**`, s + 2, s + 2 + t.length);
  } else if (kind === 'italic') {
    const t = sel || 'italic text';
    replace(`*${t}*`, s + 1, s + 1 + t.length);
  } else if (kind === 'code') {
    const t = sel || 'code';
    replace(`\`${t}\``, s + 1, s + 1 + t.length);
  } else if (kind === 'link') {
    const t = sel || 'link text';
    replace(`[${t}](https://)`, s + 1, s + 1 + t.length);
  } else if (kind === 'codeblock') {
    const t = sel || 'code here';
    replace(`\`\`\`\n${t}\n\`\`\``, s + 4, s + 4 + t.length);
  } else if (kind === 'divider') {
    replace(`${s > 0 && v[s - 1] !== '\n' ? '\n' : ''}\n---\n`, s, s);
  } else if (kind === 'timestamp') {
    const now = new Date();
    const stamp = now.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    replace(stamp, s + stamp.length, s + stamp.length);
  } else if (kind === 'image') {
    $('#ed-img-file').click();
  } else if (kind === 'mention') {
    openMentionPicker(ta);
  } else {
    // line-prefix actions: h1, h2, h3, ul, ol, check, quote
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e);
    if (le === -1) le = v.length;
    const block = v.slice(ls, le);
    const prefix = { h1: '# ', h2: '## ', h3: '### ', ul: '- ', ol: '1. ', check: '- [ ] ', quote: '> ' }[kind] || '';
    const lines = block.split('\n').map((l) => prefix + l.replace(/^(#{1,4} |> |- \[[ xX]\] |- |\d+[.)] )/, ''));
    const newText = lines.join('\n');
    ta.value = v.slice(0, ls) + newText + v.slice(le);
    ta.focus();
    ta.setSelectionRange(ls, ls + newText.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
}

// ------------------------------------------------------------------ tasks ----

function startOfToday() {
  return startOfDay(Date.now());
}

function taskMatchesFilter(t, f) {
  const start = startOfToday();
  const end = start + DAY - 1;
  switch (f) {
    case 'today': return !t.done && t.dueAt != null && t.dueAt >= start && t.dueAt <= end;
    case 'upcoming': return !t.done && t.dueAt != null && t.dueAt > end;
    case 'overdue': return !t.done && t.dueAt != null && t.dueAt < start;
    case 'done': return t.done;
    default: return !t.done;
  }
}

const TASK_SORTS = {
  manual: (a, b) => (a.done - b.done) || (a.position - b.position),
  due: (a, b) => (a.done - b.done) || ((a.dueAt ?? Infinity) - (b.dueAt ?? Infinity)) || (a.position - b.position),
  priority: (a, b) => (a.done - b.done) || (b.priority - a.priority) || (a.position - b.position),
  newest: (a, b) => (a.done - b.done) || (b.createdAt - a.createdAt)
};

function taskBadges(t) {
  const b = [];
  if (t.priority > 0) {
    b.push(`<span class="badge b-prio p${t.priority}">${PRIO_LABEL[t.priority]}</span>`);
  }
  if (t.status === 1 && !t.done) {
    b.push(`<span class="badge b-doing">● In progress</span>`);
  }
  if (t.dueAt != null) {
    const today = t.dueAt >= startOfToday() && t.dueAt < startOfToday() + DAY;
    const overdue = t.dueAt < startOfToday();
    const cls = overdue ? ' b-overdue' : today ? ' b-today' : '';
    b.push(`<span class="badge b-due${cls}">${ico('calendar')}${esc(dueLabel(t.dueAt))}</span>`);
  }
  if (t.repeat && t.repeat !== 'none') {
    b.push(`<span class="badge b-repeat">${ico('repeat')}${REPEAT_LABEL[t.repeat] || ''}</span>`);
  }
  const subs = t.subtasks || [];
  if (subs.length) {
    const d = subs.filter((x) => x.done).length;
    b.push(`<span class="badge b-subs${d === subs.length ? ' b-done' : ''}">${ico('checkSq')}${d}/${subs.length}</span>`);
  }
  if (t.remindAt != null) {
    b.push(`<span class="badge b-bell" title="Reminder set">${ico('bell')}</span>`);
  }
  if (t.notes && t.notes.trim()) {
    b.push(`<span class="badge" title="Has notes">${ico('all')}</span>`);
  }
  return b.join('');
}

function subtaskRow(s) {
  return `
    <div class="td-sub${s.done ? ' done' : ''}" data-sid="${esc(s.id)}">
      <button class="td-sub-check" title="Toggle">${ico('check')}</button>
      <span class="td-sub-title">${esc(s.title)}</span>
      <button class="td-sub-del" title="Remove subtask">&times;</button>
    </div>`;
}

function taskDetailsHtml(t) {
  const subs = t.subtasks || [];
  const subsDone = subs.filter((x) => x.done).length;
  return `
    <div class="tv-details">
      <input type="text" class="td-title-input" value="${esc(t.title)}" placeholder="Task title" spellcheck="false" maxlength="200" />
      <div class="td-grid">
        <label>Due date
          <input type="datetime-local" class="td-due" value="${tsToInput(t.dueAt)}" />
        </label>
        <label>Remind me at
          <input type="datetime-local" class="td-remind" value="${tsToInput(t.remindAt)}" />
        </label>
        <label>Priority
          <select class="td-prio">
            <option value="0"${t.priority === 0 ? ' selected' : ''}>None</option>
            <option value="1"${t.priority === 1 ? ' selected' : ''}>Low</option>
            <option value="2"${t.priority === 2 ? ' selected' : ''}>Medium</option>
            <option value="3"${t.priority === 3 ? ' selected' : ''}>High</option>
          </select>
        </label>
        <label>Repeat
          <select class="td-repeat">
            <option value="none"${t.repeat === 'none' ? ' selected' : ''}>Never</option>
            <option value="daily"${t.repeat === 'daily' ? ' selected' : ''}>Daily</option>
            <option value="weekly"${t.repeat === 'weekly' ? ' selected' : ''}>Weekly</option>
            <option value="monthly"${t.repeat === 'monthly' ? ' selected' : ''}>Monthly</option>
          </select>
        </label>
      </div>
      <textarea class="td-notes" placeholder="Notes — details, links, anything…">${esc(t.notes || '')}</textarea>
      <div class="td-subs">
        <div class="td-subs-head">
          <span>Checklist</span>
          <span>${subs.length ? `${subsDone}/${subs.length}` : ''}</span>
        </div>
        <div class="td-sub-rows">${subs.map(subtaskRow).join('')}</div>
        <form class="td-sub-add">
          <input type="text" placeholder="Add a subtask and press Enter…" spellcheck="false" maxlength="200" />
          <button type="submit">+</button>
        </form>
      </div>
    </div>`;
}

function renderTasks() {
  const view = $('#tasks-view');
  if (state.view.type !== 'tasks') {
    view.classList.add('hidden');
    $('#note-list').classList.remove('hidden');
    $('#editor').style.display = '';
    return;
  }
  view.classList.remove('hidden');
  $('#note-list').classList.add('hidden');
  $('#editor').style.display = 'none';

  const done = state.tasks.filter((t) => t.done).length;
  const total = state.tasks.length;
  $('#tv-progress-label').textContent =
    total === 0 ? 'A clean slate' : `${done} of ${total} done`;
  $('#tv-progress-bar').style.width = total === 0 ? '0%' : `${Math.round((done / total) * 100)}%`;
  $('#tv-sort').value = state.taskSort;

  // filter buttons with live counts
  const counts = { all: 0, today: 0, upcoming: 0, overdue: 0, done: 0 };
  state.tasks.forEach((t) => {
    if (taskMatchesFilter(t, 'all')) counts.all++;
    if (taskMatchesFilter(t, 'today')) counts.today++;
    if (taskMatchesFilter(t, 'upcoming')) counts.upcoming++;
    if (taskMatchesFilter(t, 'overdue')) counts.overdue++;
    if (taskMatchesFilter(t, 'done')) counts.done++;
  });
  $('#tv-filters').querySelectorAll('button').forEach((b) => {
    const f = b.dataset.f;
    b.classList.toggle('on', f === state.taskFilter);
    b.textContent = `${{ all: 'All open', today: 'Today', upcoming: 'Upcoming', overdue: 'Overdue', done: 'Done' }[f]} (${counts[f]})`;
  });

  const visible = state.tasks
    .filter((t) => taskMatchesFilter(t, state.taskFilter))
    .sort(TASK_SORTS[state.taskSort] || TASK_SORTS.manual);

  const list = $('#tv-list');
  if (!visible.length) {
    const emptyMsg = {
      all: 'Nothing to do — enjoy the quiet. ☕',
      today: 'Nothing due today. Sip your chai. ☕',
      upcoming: 'Nothing scheduled ahead yet.',
      overdue: 'Nothing overdue. You are on top of it! 🎉',
      done: 'Nothing completed yet — go finish something!'
    };
    list.innerHTML = `<div class="tv-empty">${frogSvg}<div>${emptyMsg[state.taskFilter] || emptyMsg.all}</div></div>`;
  } else {
    list.innerHTML = visible
      .map((t) => {
        const open = state.expandedTask === t.id ? ' open' : '';
        return `
      <li class="tv-item${t.done ? ' done' : ''}${open}" data-tid="${esc(t.id)}">
        <div class="tv-row">
          <button class="tv-check" title="Toggle done">${ico('check')}</button>
          <div class="tv-main">
            <div class="tv-line">
              <span class="tv-title">${esc(t.title)}</span>
              ${taskBadges(t)}
            </div>
          </div>
          <button class="tv-expand" title="Details">${ico('chevronD')}</button>
          <button class="tv-del" title="Delete task">&times;</button>
        </div>
        ${state.expandedTask === t.id ? taskDetailsHtml(t) : ''}
      </li>`;
      })
      .join('');

    list.querySelectorAll('.tv-item').forEach((item) => {
      wireTaskItem(item);
    });
  }

  $('#btn-clear-done').classList.toggle('hidden', done === 0);
}

function wireTaskItem(item) {
  const tid = item.dataset.tid;
  const t = () => state.tasks.find((x) => x.id === tid);

  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const task = t();
    if (!task) return;
    showMenu(e.clientX, e.clientY, [
      { label: task.done ? 'Mark as not done' : 'Mark as done', icon: 'checkSq', fn: () => item.querySelector('.tv-check').click() },
      { label: state.expandedTask === tid ? 'Hide details' : 'Details', icon: 'chevronD', fn: () => item.querySelector('.tv-expand').click() },
      { sep: true },
      { label: 'Delete task', icon: 'trash', danger: true, fn: () => item.querySelector('.tv-del').click() }
    ]);
  });

  item.querySelector('.tv-check').addEventListener('click', async (e) => {
    const chk = e.currentTarget;
    const task = t();
    if (!task) return;
    chk.classList.add('pop');
    setTimeout(async () => {
      try {
        const res = await call('set_task', { id: tid, done: !task.done });
        const idx = state.tasks.findIndex((x) => x.id === tid);
        if (idx !== -1 && res) state.tasks[idx] = res;
        if (res && !task.done && task.repeat !== 'none' && res.done === false) {
          toast(`Repeats ${task.repeat} — next: ${dueLabel(res.dueAt) || 'scheduled'}`, { icon: 'repeat' });
        }
        if (res && res.done && !task.done) confettiAtEl(chk); // v0.10 — small win, small party
        renderTasks();
        refreshStatsOnly();
      } catch (err) {
        toast('Could not update task: ' + err.message);
      }
    }, 190);
  });

  item.querySelector('.tv-del').addEventListener('click', async () => {
    item.classList.add('removing');
    setTimeout(async () => {
      await call('delete_task', { id: tid });
      if (state.expandedTask === tid) state.expandedTask = null;
      state.tasks = state.tasks.filter((x) => x.id !== tid);
      renderTasks();
      refreshStatsOnly();
    }, 240);
  });

  item.querySelector('.tv-expand').addEventListener('click', () => {
    state.expandedTask = state.expandedTask === tid ? null : tid;
    renderTasks();
  });

  if (state.expandedTask !== tid) return;

  // ------- details panel wiring -------
  const pushUpdate = (patch, immediate = false) => {
    clearTimeout(state.taskSaveTimer);
    const run = async () => {
      const task = t();
      if (!task) return;
      const merged = {
        id: task.id,
        title: task.title,
        notes: task.notes || '',
        priority: task.priority || 0,
        dueAt: task.dueAt ?? null,
        remindAt: task.remindAt ?? null,
        repeat: task.repeat || 'none',
        subtasks: task.subtasks || [],
        ...patch
      };
      try {
        await call('update_task', merged);
        const idx = state.tasks.findIndex((x) => x.id === task.id);
        if (idx !== -1) state.tasks[idx] = { ...state.tasks[idx], ...merged };
        renderTasks();
      } catch (err) {
        toast('Could not save task: ' + err.message);
      }
    };
    if (immediate) run();
    else state.taskSaveTimer = setTimeout(run, 300);
  };

  item.querySelector('.td-title-input').addEventListener('input', (e) => {
    const task = t();
    if (task) task.title = e.target.value;
    pushUpdate({ title: e.target.value });
  });

  item.querySelector('.td-due').addEventListener('change', (e) => {
    pushUpdate({ dueAt: inputToTs(e.target.value) }, true);
  });

  item.querySelector('.td-remind').addEventListener('change', (e) => {
    const v = inputToTs(e.target.value);
    pushUpdate({ remindAt: v }, true);
    if (v) toast('Reminder set for ' + dueLabel(v), { icon: 'bell' });
  });

  item.querySelector('.td-prio').addEventListener('change', (e) => {
    pushUpdate({ priority: Number(e.target.value) }, true);
  });

  item.querySelector('.td-repeat').addEventListener('change', (e) => {
    pushUpdate({ repeat: e.target.value }, true);
  });

  const notesEl = item.querySelector('.td-notes');
  notesEl.addEventListener('input', () => {
    const task = t();
    if (task) task.notes = notesEl.value;
    pushUpdate({ notes: notesEl.value });
  });

  const subInput = item.querySelector('.td-sub-add input');
  item.querySelector('.td-sub-add').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = subInput.value.trim();
    if (!title) return;
    const task = t();
    if (!task) return;
    const subs = (task.subtasks || []).concat([{ id: 's' + Date.now().toString(36) + Math.floor(Math.random() * 999), title, done: false }]);
    task.subtasks = subs;
    subInput.value = '';
    pushUpdate({ subtasks: subs }, true);
  });

  item.querySelectorAll('.td-sub').forEach((row) => {
    const sid = row.dataset.sid;
    row.querySelector('.td-sub-check').addEventListener('click', () => {
      const task = t();
      if (!task) return;
      const subs = (task.subtasks || []).map((s) =>
        s.id === sid ? { ...s, done: !s.done } : s
      );
      task.subtasks = subs;
      pushUpdate({ subtasks: subs }, true);
    });
    row.querySelector('.td-sub-del').addEventListener('click', () => {
      const task = t();
      if (!task) return;
      const subs = (task.subtasks || []).filter((s) => s.id !== sid);
      task.subtasks = subs;
      pushUpdate({ subtasks: subs }, true);
    });
  });
}

// ------------------------------------------------------------------ data flow ----

async function refreshFolders() {
  state.folders = await call('list_folders');
  const counts = await call('folder_counts');
  state.folderCountMap = Object.fromEntries(counts);
}

async function refreshNotes() {
  const tag = state.activeTag || undefined;
  if (state.view.type === 'search') {
    state.notes = await call('list_notes', {
      view: 'all',
      query: state.query.trim(),
      tag
    });
  } else if (state.view.type === 'folder') {
    state.notes = await call('list_notes', {
      view: 'folder',
      folderId: state.view.folderId,
      sort: state.sort,
      tag
    });
  } else {
    state.notes = await call('list_notes', { view: state.view.type, sort: state.sort, tag });
  }
}

async function refreshStatsOnly() {
  state.stats = await call('get_stats');
  renderSidebar();
  renderStatusStats();
}

async function refreshTasks() {
  state.tasks = await call('list_tasks');
}

async function refreshAll() {
  await Promise.all([refreshFolders(), refreshNotes(), refreshStatsOnly()]);
  // quick switcher works across every note, not just the current view
  state.allNotesCache = await call('list_notes', { view: 'all', sort: 'updated' });
  renderSidebar();
  renderNoteList();
  renderTasks();
}

function renderStatusStats() {
  if (!state.stats) return;
  if (!state.openNote) {
    $('#stats-right').textContent =
      `${state.stats.notes} notes · ${state.stats.openTasks} open tasks`;
  } else {
    // word count fills stats-right while editing; keep the counters after it
    updateWordCount();
  }
}

function setView(view, opts = {}) {
  state.view = view;
  closeSlash();
  closeMention();
  closeMenu();
  if (view.type === 'tasks' || view.type === 'board' || view.type === 'recordings' || view.type === 'chat') {
    state.currentNoteId = null;
    state.openNote = null;
  }
  renderSidebar();
  refreshNotes().then(() => {
    renderNoteList();
    if (view.type === 'tasks') {
      $('#tasks-view').classList.remove('hidden');
      $('#tasks-view').classList.add('view-enter');
      $('#board-view').classList.add('hidden');
      $('#rec-view').classList.add('hidden');
      $('#chat-view').classList.add('hidden');
      $('#note-list').classList.add('hidden');
      $('#editor').style.display = 'none';
      renderTasks();
    } else if (view.type === 'board') {
      $('#board-view').classList.remove('hidden');
      $('#board-view').classList.add('view-enter');
      $('#tasks-view').classList.add('hidden');
      $('#rec-view').classList.add('hidden');
      $('#chat-view').classList.add('hidden');
      $('#note-list').classList.add('hidden');
      $('#editor').style.display = 'none';
      refreshTasks().then(renderBoard);
    } else if (view.type === 'recordings') {
      $('#rec-view').classList.remove('hidden');
      $('#rec-view').classList.add('view-enter');
      $('#tasks-view').classList.add('hidden');
      $('#chat-view').classList.add('hidden');
      $('#note-list').classList.add('hidden');
      $('#editor').style.display = 'none';
      if (!state.recViewLoaded) {
        state.recViewLoaded = true;
        refreshRecDevices();
        call('recorder_status').then((st) => {
          if (st.recording) {
            updateRecUi(true, st.elapsedMs);
            if (!state.recPoll) state.recPoll = setInterval(pollRecStatus, 500);
          }
        }).catch(() => {});
      }
      renderRecordings();
    } else if (view.type === 'chat') {
      $('#chat-view').classList.remove('hidden');
      $('#chat-view').classList.add('view-enter');
      $('#tasks-view').classList.add('hidden');
      $('#board-view').classList.add('hidden');
      $('#rec-view').classList.add('hidden');
      $('#note-list').classList.add('hidden');
      $('#editor').style.display = 'none';
      openChatView();
    } else {
      $('#tasks-view').classList.add('hidden');
      $('#board-view').classList.add('hidden');
      $('#rec-view').classList.add('hidden');
      $('#chat-view').classList.add('hidden');
      $('#note-list').classList.remove('hidden');
      $('#editor').style.display = '';
    }
    // keep selection if the note is still visible in this view
    if (state.currentNoteId && !state.notes.some((n) => n.id === state.currentNoteId)) {
      if (view.type === 'trash' && state.openNote && !state.openNote.trashed) {
        state.currentNoteId = null;
        state.openNote = null;
        renderEditor();
      }
    }
    renderStatusStats();
  });
}

async function selectNote(id) {
  if (state.currentNoteId === id) return;
  // coming from Tasks / Board / Recordings / Chat — bring the library back
  if (state.view.type === 'tasks' || state.view.type === 'board' || state.view.type === 'recordings' || state.view.type === 'chat') {
    setView({ type: 'all' });
  }
  await flushSave();
  state.currentNoteId = id;
  const summary = state.notes.find((n) => n.id === id);
  const full = await call('get_note', { id });
  state.openNote = full || summary || null;
  if (!state.openNote) {
    state.currentNoteId = null;
    renderEditor();
    return;
  }
  state.preview = false;
  // snapshot tags as they exist in the DB right now — flushSave compares
  // against this to detect tags-only edits
  savedTagsMap.set(id, typeof state.openNote.tags === 'string' ? state.openNote.tags : JSON.stringify(state.openNote.tags || []));
  openTab(id, state.openNote.title.trim() || 'Untitled note');
  renderNoteList();
  renderEditor();
  renderStatusStats();
  setSaveState('saved', 'Saved');
  $('#ed-title').focus();
}

async function createNote() {
  await flushSave();
  let folderId = state.view.type === 'folder' ? state.view.folderId : null;
  if (!folderId && state.view.type !== 'folder' && state.settings.defaultFolder) {
    folderId = state.settings.defaultFolder; // v0.7 — default folder setting
  }
  const note = await call('create_note', { folderId });
  state.openNote = note;
  state.currentNoteId = note.id;
  state.preview = false;
  savedTagsMap.set(note.id, '[]');
  openTab(note.id, 'Untitled note');
  if (state.view.type !== 'all' && state.view.type !== 'folder' && state.view.type !== 'search') {
    setView({ type: 'all' });
  } else {
    await refreshAll();
    renderEditor();
  }
  setSaveState('saved', 'New note');
  $('#ed-title').focus();
  return note;
}

async function duplicateCurrent() {
  const n = state.openNote;
  if (!n) return;
  await flushSave();
  try {
    const copy = await call('duplicate_note', { id: n.id });
    if (!copy) return;
    await refreshAll();
    state.currentNoteId = copy.id;
    const full = await call('get_note', { id: copy.id });
    state.openNote = full || copy;
    openTab(copy.id, state.openNote.title.trim() || 'Untitled note');
    renderNoteList();
    renderEditor();
    toast('Note duplicated', { icon: 'copy' });
  } catch (err) {
    toast('Could not duplicate: ' + err.message);
  }
}

// -------- autosave (realtime: 250ms debounce + flush on blur/hide/close) --------

function queueSave() {
  if (!state.openNote) return;
  pending = {
    title: $('#ed-title').value,
    content: $('#ed-text').value
  };
  updateWordCount(pending.content);
  // Realtime autosave can be turned off in Settings — then we only save on
  // Ctrl+S / blur / close. The status bar always tells the truth.
  if (state.settings.autosave === '0') {
    setSaveState('saving', 'Unsaved — Ctrl+S to save');
    return;
  }
  // neutral hint here — flushSave flips it to "Saving…" only when a real
  // write happens (an early return must never leave a stuck "Saving…")
  setSaveState('idle', 'Editing…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 250);
}

async function flushSave() {
  clearTimeout(state.saveTimer);
  const n = state.openNote;
  if (!n || !pending) return;
  const { title, content } = pending;
  pending = null;
  // v0.9: tags ride along with every save — and a tags-only change must
  // still save, so tags join the "anything new?" comparison (against the
  // last SAVED tags, not the live object the tag editor just mutated).
  const tagsJson = JSON.stringify(tagsOf(n));
  // compare against the tags snapshot taken when this note was opened /
  // last saved — never against n.tags itself (the tag editor mutates it
  // before flushSave runs, so that compare could not detect anything)
  const prevTags = savedTagsMap.has(n.id) ? savedTagsMap.get(n.id) : tagsJson;
  if (n.title === title && n.content === content && prevTags === tagsJson) {
    return; // nothing new since the last save
  }
  n.title = title;
  n.content = content;
  n.tags = tagsJson;
  state.saving = true;
  setSaveState('saving', 'Saving…');
  try {
    await call('save_note', { id: n.id, title, content, tags: n.tags });
  } catch (err) {
    setSaveState('error', 'Save failed');
    toast('Could not save: ' + err.message);
    state.saving = false;
    return;
  }
  state.saving = false;
  savedTagsMap.set(n.id, tagsJson);

  // sync summary + tab label in the list
  const s = state.notes.find((x) => x.id === n.id);
  if (s) {
    s.title = title;
    s.tags = n.tags;
    const flat = content.replace(/[\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
    s.snippet = flat.length > 180 ? flat.slice(0, 180) + '…' : flat;
    s.updatedAt = Date.now();
    if (state.sort === 'updated' && !n.pinned) {
      // reflow: move updated note to top (below other pinned)
      const idx = state.notes.indexOf(s);
      if (idx > 0) {
        state.notes.splice(idx, 1);
        let insertAt = state.notes.findIndex((x) => x.pinned);
        if (insertAt === -1) insertAt = 0;
        else {
          while (insertAt < state.notes.length && state.notes[insertAt].pinned) insertAt++;
        }
        state.notes.splice(insertAt, 0, s);
      }
    }
    renderNoteList({ animate: false });
    renderSidebar(); // tags section + counts live here too
  } else {
    refreshNotes().then(() => renderNoteList({ animate: false }));
  }
  setSaveState('saved', 'Saved');
  const tab = state.tabs.find((t) => t.id === n.id);
  if (tab && tab.title !== (title.trim() || 'Untitled note')) {
    tab.title = title.trim() || 'Untitled note';
    renderTabs();
  }
  renderStatusStats();
}

// ------------------------------------------------------------------ actions ----

// ---- v0.9: Find & Replace (Ctrl+H) ----

let findState = { matches: [], idx: -1 };

function toggleFindBar() {
  const bar = $('#find-bar');
  if (!bar) return;
  if (bar.classList.contains('hidden')) {
    bar.classList.remove('hidden');
    $('#find-input').focus();
    $('#find-input').select();
    runFind();
  } else {
    closeFindBar();
  }
}

function closeFindBar() {
  const bar = $('#find-bar');
  if (bar) bar.classList.add('hidden');
  findState = { matches: [], idx: -1 };
}

function findMatches(text, q) {
  const res = [];
  if (!q) return res;
  const t = text.toLowerCase();
  const s = q.toLowerCase();
  let i = 0;
  while ((i = t.indexOf(s, i)) !== -1) {
    res.push(i);
    i += s.length;
  }
  return res;
}

function runFind(jump = true) {
  const ta = $('#ed-text');
  const q = $('#find-input').value;
  if (!ta) return;
  findState.matches = findMatches(ta.value, q);
  if (!findState.matches.length) {
    findState.idx = -1;
    $('#find-count').textContent = q ? 'No matches' : '';
    return;
  }
  if (jump) {
    // first match at/after the cursor, else the first one
    const at = ta.selectionStart || 0;
    findState.idx = findState.matches.findIndex((p) => p >= at);
    if (findState.idx === -1) findState.idx = 0;
  } else {
    findState.idx = Math.min(findState.idx, findState.matches.length - 1);
    if (findState.idx < 0) findState.idx = 0;
  }
  gotoMatch();
}

function gotoMatch() {
  const ta = $('#ed-text');
  const q = $('#find-input').value;
  if (!ta || findState.idx < 0 || !findState.matches.length) {
    $('#find-count').textContent = q ? 'No matches' : '';
    return;
  }
  const start = findState.matches[findState.idx];
  ta.focus();
  ta.setSelectionRange(start, start + q.length);
  $('#find-count').textContent = `${findState.idx + 1} of ${findState.matches.length}`;
}

function findStep(dir) {
  if (!findState.matches.length) return;
  findState.idx = (findState.idx + dir + findState.matches.length) % findState.matches.length;
  gotoMatch();
}

function replaceOne() {
  const ta = $('#ed-text');
  const q = $('#find-input').value;
  const r = $('#replace-input').value;
  if (!ta || !q || !findState.matches.length || findState.idx < 0) return;
  const start = findState.matches[findState.idx];
  ta.value = ta.value.slice(0, start) + r + ta.value.slice(start + q.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  runFind(false);
  toast('Replaced', { icon: 'pencil' });
}

function replaceAll() {
  const ta = $('#ed-text');
  const q = $('#find-input').value;
  const r = $('#replace-input').value;
  if (!ta || !q) return;
  const count = findMatches(ta.value, q).length;
  if (!count) return;
  const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  ta.value = ta.value.replace(re, r);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  $('#find-count').textContent = '';
  findState = { matches: [], idx: -1 };
  toast(`Replaced ${count} match${count === 1 ? '' : 'es'}`, { icon: 'pencil' });
}

// ---- v0.9: daily note — one note per day, made on demand ----

async function openDailyNote() {
  await flushSave();
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const title = `Daily note — ${stamp}`;
  const existing = state.notes.find((n) => n.title === title);
  if (existing) {
    await selectNote(existing.id);
    toast('Today\'s note is already here', { icon: 'calendar' });
    return;
  }
  let folderId = state.view.type === 'folder' ? state.view.folderId : state.settings.defaultFolder || null;
  const note = await call('create_note', { folderId });
  const h = d.getHours();
  const part = h < 5 ? 'quiet night' : h < 12 ? 'morning' : h < 17 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  const who = state.userName ? `, ${state.userName}` : '';
  const content = `# ${title}\n\nGood ${part}${who} — here's today's page.\n\n## Good things\n- \n\n## To do\n- [ ] \n\n## Notes\n`;
  await call('save_note', { id: note.id, title, content, tags: '["daily"]' });
  note.title = title;
  note.content = content;
  note.tags = '["daily"]';
  savedTagsMap.set(note.id, '["daily"]');
  await refreshAll();
  await selectNote(note.id);
  const ta = $('#ed-text');
  if (ta) ta.setSelectionRange(ta.value.length, ta.value.length);
  toast('Daily note ready — write away', { icon: 'calendar' });
}

async function togglePin() {
  const n = state.openNote;
  if (!n) return;
  n.pinned = !n.pinned;
  await call('pin_note', { id: n.id, pinned: n.pinned });
  renderEditorToolbar();
  const s = state.notes.find((x) => x.id === n.id);
  if (s) s.pinned = n.pinned;
  if (state.sort === 'updated') refreshNotes().then(renderNoteList);
  toast(n.pinned ? 'Pinned to top' : 'Unpinned');
}

async function toggleFavorite() {
  const n = state.openNote;
  if (!n) return;
  n.favorite = !n.favorite;
  await call('favorite_note', { id: n.id, favorite: n.favorite });
  renderEditorToolbar();
  const s = state.notes.find((x) => x.id === n.id);
  if (s) s.favorite = n.favorite;
  refreshStatsOnly();
  if (state.view.type === 'favorites' && !n.favorite) {
    state.notes = state.notes.filter((x) => x.id !== n.id);
    renderNoteList();
  }
  toast(n.favorite ? 'Added to favorites' : 'Removed from favorites');
}

async function moveCurrentNote(folderId) {
  const n = state.openNote;
  if (!n) return;
  n.folderId = folderId || null;
  await call('move_note', { id: n.id, folderId: n.folderId });
  const s = state.notes.find((x) => x.id === n.id);
  if (s) s.folderId = n.folderId;
  if (state.view.type === 'folder' && state.view.folderId !== n.folderId) {
    state.notes = state.notes.filter((x) => x.id !== n.id);
    state.currentNoteId = null;
    state.openNote = null;
    renderNoteList();
    renderEditor();
  }
  refreshStatsOnly();
  const fname = n.folderId ? (state.folders.find((f) => f.id === n.folderId) || {}).name : 'Unfiled';
  toast(`Moved to ${fname || 'Unfiled'}`);
}

async function trashCurrent() {
  const n = state.openNote;
  if (!n) return;
  await call('trash_note', { id: n.id, trashed: true });
  closeTab(n.id, { switchAway: false });
  state.notes = state.notes.filter((x) => x.id !== n.id);
  state.currentNoteId = null;
  state.openNote = null;
  renderNoteList();
  renderEditor();
  renderTabs();
  refreshStatsOnly();
  toast('Moved to trash', {
    action: {
      label: 'Undo',
      fn: async () => {
        await call('trash_note', { id: n.id, trashed: false });
        refreshAll();
      }
    }
  });
}

async function restoreCurrent() {
  const n = state.openNote;
  if (!n) return;
  await call('trash_note', { id: n.id, trashed: false });
  state.currentNoteId = null;
  state.openNote = null;
  state.notes = state.notes.filter((x) => x.id !== n.id);
  renderNoteList();
  renderEditor();
  refreshStatsOnly();
  toast('Note restored');
}

async function purgeCurrent() {
  const n = state.openNote;
  if (!n) return;
  const ok = await confirmModal({
    title: 'Delete forever?',
    body: 'This note will be gone for good. There is no undo.',
    confirmLabel: 'Delete forever',
    danger: true
  });
  if (!ok) return;
  await call('delete_note_forever', { id: n.id });
  closeTab(n.id, { switchAway: false });
  state.notes = state.notes.filter((x) => x.id !== n.id);
  state.currentNoteId = null;
  state.openNote = null;
  renderNoteList();
  renderEditor();
  renderTabs();
  refreshStatsOnly();
  toast('Deleted forever');
}

async function emptyTrash() {
  const ok = await confirmModal({
    title: 'Empty the trash?',
    body: `All ${state.notes.length} trashed note(s) will be deleted forever. There is no undo.`,
    confirmLabel: 'Empty trash',
    danger: true
  });
  if (!ok) return;
  const doomed = state.notes.map((n) => n.id);
  await call('empty_trash');
  state.tabs = state.tabs.filter((t) => !doomed.includes(t.id));
  state.currentNoteId = null;
  state.openNote = null;
  await refreshAll();
  renderTabs();
  renderEditor();
  toast('Trash emptied');
}

async function exportCurrent() {
  const n = state.openNote;
  if (!n) return;
  try {
    const path = await call('export_note', { id: n.id });
    if (path) toast(`Exported to ${path.split(/[\\/]/).pop()}`);
  } catch (err) {
    if (!/cancel/i.test(err.message)) toast('Export failed: ' + err.message);
  }
}

// v0.10 — self-contained web page export: images embedded, pretty styles,
// opens in any browser. Built from the same markdown the preview uses.
async function exportCurrentHtml() {
  const n = state.openNote;
  if (!n) return;
  try {
    // make sure every nookimg:// id in the note is in the async cache first,
    // so the rendered HTML carries real data: URLs instead of placeholders
    const ids = [...new Set([...String(n.content || '').matchAll(/nookimg:\/\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]))];
    if (IS_TAURI) await Promise.all(ids.map((id) => loadImageData(id)));
    const body = renderMarkdown(n.content || '');
    const title = esc(n.title || 'Untitled note');
    const html = `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8"/>\n<meta name="viewport" content="width=device-width, initial-scale=1"/>\n<title>${title}</title>\n<style>\n  :root{color-scheme:light dark}\n  body{margin:0;background:#101418;color:#e8e6e3;font:16px/1.7 -apple-system,'Segoe UI',Roboto,sans-serif}\n  article{max-width:760px;margin:0 auto;padding:48px 24px 80px}\n  h1,h2,h3,h4{line-height:1.25;color:#f4f2ee;margin:1.4em 0 .5em}\n  h1{font-size:2em;border-bottom:1px solid #2c333a;padding-bottom:.3em}\n  a{color:#7ec9ff}\n  blockquote{margin:1em 0;padding:.6em 1.2em;border-left:3px solid #5aa2ff;background:#16202e;border-radius:0 8px 8px 0;color:#c6d3e2}\n  code{font-family:ui-monospace,Consolas,monospace;font-size:.9em;background:#1c232b;padding:.15em .4em;border-radius:5px}\n  pre{background:#161c23;padding:16px 18px;border-radius:12px;overflow:auto;border:1px solid #26303a}\n  pre code{background:none;padding:0}\n  mark{background:#5a4a18;color:#ffd98a;padding:0 .2em;border-radius:3px}\n  del{color:#8b949e}\n  hr{border:none;border-top:1px solid #2c333a;margin:2em 0}\n  table{border-collapse:collapse;margin:1em 0;width:100%}\n  th,td{border:1px solid #2c333a;padding:8px 12px;text-align:left}\n  th{background:#1a2027}\n  .md-tablewrap{overflow-x:auto}\n  img{max-width:100%;border-radius:10px}\n  li.md-task{list-style:none;margin-left:-1.4em}\n  .md-box{display:inline-flex;width:15px;height:15px;border:1.5px solid #6b7684;border-radius:4px;margin-right:.5em;vertical-align:-2px;align-items:center;justify-content:center}\n  li.md-task.on .md-box{background:#5aa2ff;border-color:#5aa2ff}\n  li.md-task.on .md-box svg{width:11px;height:11px;color:#0a2550}\n  footer{max-width:760px;margin:0 auto;padding:0 24px 48px;color:#69737e;font-size:13px}\n  @media (prefers-color-scheme:light){body{background:#fbfaf8;color:#26282b}h1,h2,h3,h4{color:#1c1e21}a{color:#0b62c4}blockquote{background:#f2f4f1;color:#4a5349}code{background:#eef0f3}pre{background:#f3f5f7;border-color:#e1e4e8}mark{background:#ffe9a8;color:#5c4708}hr,th,td{border-color:#e1e4e8}th{background:#f2f4f1}}\n</style>\n</head>\n<body>\n<article>${body}</article>\n<footer>Exported from Nook — the cozy notes app</footer>\n</body>\n</html>`;
    const path = await call('export_note_html', { title: n.title || 'Untitled note', html });
    if (path) toast(`Web page saved — ${path.split(/[\\/]/).pop()}`, { icon: 'export' });
  } catch (err) {
    if (!/cancel/i.test(err.message)) toast('Export failed: ' + err.message);
  }
}

// the export button offers both flavours
function exportMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  showMenu(r.right, r.bottom + 6, [
    { header: true, label: 'Export this note as…' },
    { label: 'Markdown (.md)', icon: 'download', fn: exportCurrent },
    { label: 'Web page (.html)', icon: 'external', fn: exportCurrentHtml }
  ]);
}

// ------------------------------------------------------------------ folders ----

async function newFolder() {
  const name = await promptModal({
    title: 'New folder',
    placeholder: 'Folder name',
    confirmLabel: 'Create'
  });
  if (name && name.trim()) {
    const f = await call('create_folder', { name: name.trim() });
    await refreshFolders();
    renderSidebar();
    setView({ type: 'folder', folderId: f.id });
    toast(`Folder “${f.name}” created`);
  }
}

// ------------------------------------------------------------------ settings ----

async function openSettings(section) {
  const dataPath = await call('data_dir');
  const root = $('#overlay-root');
  const theme = state.settings.theme;
  const fs = state.settings.fontSize;
  const ef = state.settings.editorFont;
  const ew = state.settings.editorWidth;
  const ctt = state.settings.closeToTray === '1';
  const asv = state.settings.autosave === '1';
  const spc = state.settings.spellcheck === '1';
  const den = state.settings.density || 'cozy';
  const auto = state.settings.autostart === '1';
  const dline = state.settings.edLine || '1.6';
  const dview = state.settings.defaultView || 'all';
  const zoom = state.settings.zoom || '100';
  const tdays = state.settings.trashDays || '0';
  const ai = state.settings.ai;
  const activeId = ai.active || 'openrouter';

  const providerPanel = (pid) => {
    const meta = AI_PROVIDERS.find((p) => p.id === pid) || AI_PROVIDERS[0];
    const conf = ai.providers[pid] || {};
    const url = conf.url ?? meta.url ?? '';
    const model = conf.model || '';
    const apiKey = conf.apiKey || '';
    const needsKey = !!meta.key;
    const suggest = meta.suggestModels || [];
    const configured = !!model.trim() && (!needsKey || !!apiKey.trim());
    return `
      <div class="prov-panel${configured ? ' configured' : ''}">
        ${configured ? '<div class="prov-ready">' + ico('check') + ' This provider is set up — you can chat right away.</div>' : ''}
        <div class="prov-row">
          <label>Step 1 · API key ${needsKey ? '' : '<span class="prov-opt">(not needed)</span>'}</label>
          <div class="prov-keywrap">
            <input type="password" id="pv-key" value="${esc(apiKey)}" placeholder="${needsKey ? 'Paste your key — it saves itself' : 'No key needed'}" spellcheck="false" autocomplete="off" ${needsKey ? '' : 'disabled'} />
            <button type="button" class="prov-eye" id="pv-eye" title="Show / hide">${ico('eye')}</button>
          </div>
        </div>
        <div class="prov-row">
          <label>Step 2 · Model</label>
          <input type="text" id="pv-model" value="${esc(model)}" placeholder="e.g. ${pid === 'zai' ? 'glm-4.6' : pid === 'openai' ? 'gpt-4o-mini' : pid === 'openrouter' ? 'openai/gpt-4o-mini' : 'model-name'}" spellcheck="false" />
        </div>
        <div id="pv-models" class="prov-models"></div>
        ${suggest.length ? `<div class="prov-suggest"><span class="ps-label">Popular models — click one:</span>${suggest.map((m) => `<button type="button" class="pv-model${m === model ? ' on' : ''}" data-m="${esc(m)}">${esc(m)}</button>`).join('')}</div>` : ''}
        <div class="prov-row">
          <label>Advanced · API base URL</label>
          <input type="text" id="pv-url" value="${esc(url)}" placeholder="${esc(meta.url || 'https://…')}" spellcheck="false" />
        </div>
        <div class="prov-hint">${esc(meta.hint || '')}</div>
        <div class="prov-actions">
          ${meta.models ? '<button class="btn ghost small" id="pv-fetch">Fetch models</button>' : ''}
          <button class="btn primary small" id="pv-connect">Save &amp; connect</button>
          <span id="pv-status">${configured ? '<span style="color:var(--accent)">Ready ✓</span>' : ''}</span>
        </div>
        <div class="prov-note">🔑 Keys are stored only in the local Nook database on this PC — never in backups, never sent anywhere except the provider you picked.</div>
      </div>`;
  };

  root.innerHTML = `
    <div class="overlay">
      <div class="modal wide set-modal">
        <h3>${ico('settings')} Settings</h3>
        <div class="set-tabs" id="set-tabs">
          <button class="set-tab on" data-tab="look">${ico('palette')}Look</button>
          <button class="set-tab" data-tab="editor">${ico('pencil')}Editor</button>
          <button class="set-tab" data-tab="general">${ico('settings')}General</button>
          <button class="set-tab" data-tab="ai">${ico('sparkle')}AI</button>
          <button class="set-tab" data-tab="data">${ico('download')}Data</button>
        </div>

        <div class="set-pages">
        <!-- ================= LOOK ================= -->
        <div class="set-page" data-page="look">
          <div class="set-row" style="display:block">
            <div class="set-label">Theme</div>
            <div class="set-sub">24 cozy looks — pick your mood. Applies instantly.</div>
            <div class="theme-group"><div class="tg-label">🌙 Dark</div>
              <div class="theme-grid">${THEMES.filter((t) => !t.light).map((t) => `
                <button class="theme-chip${theme === t.id ? ' on' : ''}" data-t="${t.id}" title="${t.name}">
                  <span class="theme-dots"><i style="background:${t.dots[0]}"></i><i style="background:${t.dots[1]}"></i></span>
                  <span class="t-name">${t.name}</span>
                </button>`).join('')}
              </div>
            </div>
            <div class="theme-group"><div class="tg-label">☀️ Light</div>
              <div class="theme-grid">${THEMES.filter((t) => t.light).map((t) => `
                <button class="theme-chip${theme === t.id ? ' on' : ''}" data-t="${t.id}" title="${t.name}">
                  <span class="theme-dots"><i style="background:${t.dots[0]}"></i><i style="background:${t.dots[1]}"></i></span>
                  <span class="t-name">${t.name}</span>
                </button>`).join('')}
              </div>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Accent color</div>
              <div class="set-sub">Default Blue — or tint the whole app your way.</div>
            </div>
            <div class="seg" id="seg-accent">
              <button data-v="" class="${!state.settings.accent ? 'on' : ''}" title="Theme's own accent">Auto</button>
              ${Object.entries(ACCENTS).filter(([k]) => k).map(([k, v]) => `
                <button data-v="${k}" class="${state.settings.accent === k ? 'on' : ''}" title="${v.name}"><i class="acc-dot" style="background:${v.a}"></i>${v.name}</button>`).join('')}
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Note list density</div>
              <div class="set-sub">Roomy cards or a compact list.</div>
            </div>
            <div class="seg" id="seg-density">
              <button data-v="cozy" class="${den === 'cozy' ? 'on' : ''}">Cozy</button>
              <button data-v="compact" class="${den === 'compact' ? 'on' : ''}">Compact</button>
            </div>
          </div>
        </div>

        <!-- ================= EDITOR ================= -->
        <div class="set-page hidden" data-page="editor">
          <div class="set-row">
            <div>
              <div class="set-label">Text size</div>
              <div class="set-sub">Comfortable reading, your call.</div>
            </div>
            <div class="seg" id="seg-font">
              ${['13', '14', '15', '16', '18', '20'].map((v) => `<button data-v="${v}" class="${fs === v ? 'on' : ''}">${v}px</button>`).join('')}
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Editor font</div>
              <div class="set-sub">How your words look while you write.</div>
            </div>
            <div class="seg" id="seg-edfont">
              <button data-v="sans" class="${ef === 'sans' ? 'on' : ''}">Sans</button>
              <button data-v="serif" class="${ef === 'serif' ? 'on' : ''}">Serif</button>
              <button data-v="mono" class="${ef === 'mono' ? 'on' : ''}">Mono</button>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Editor width</div>
              <div class="set-sub">Cozy column or full display.</div>
            </div>
            <div class="seg" id="seg-width">
              <button data-v="normal" class="${ew === 'normal' ? 'on' : ''}">Normal</button>
              <button data-v="wide" class="${ew === 'wide' ? 'on' : ''}">Wide</button>
              <button data-v="full" class="${ew === 'full' ? 'on' : ''}">Full</button>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Line spacing</div>
              <div class="set-sub">How airy your paragraphs feel.</div>
            </div>
            <div class="seg" id="seg-edline">
              <button data-v="1.5" class="${dline === '1.5' ? 'on' : ''}">Snug</button>
              <button data-v="1.6" class="${dline === '1.6' ? 'on' : ''}">Cozy</button>
              <button data-v="1.8" class="${dline === '1.8' ? 'on' : ''}">Airy</button>
              <button data-v="2" class="${dline === '2' ? 'on' : ''}">Roomy</button>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Realtime autosave</div>
              <div class="set-sub">Save as you type (also on blur & close). Off = save manually with Ctrl+S.</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="set-autosave"${asv ? ' checked' : ''} />
              <span class="track"></span>
            </label>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Spell check</div>
              <div class="set-sub">Browser spellcheck inside the editor.</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="set-spellcheck"${spc ? ' checked' : ''} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <!-- ================= GENERAL ================= -->
        <div class="set-page hidden" data-page="general">
          <div class="set-row">
            <div>
              <div class="set-label">Your name</div>
              <div class="set-sub">Nook greets you by name — sidebar, AI chat, daily notes.</div>
            </div>
            <input type="text" id="set-username" class="set-text" value="${esc(state.userName)}" maxlength="24" placeholder="Your name" spellcheck="false" autocomplete="off" style="width:180px" />
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Welcome screen</div>
              <div class="set-sub">Miss the clouds? Watch the get-started again.</div>
            </div>
            <button class="btn ghost small" id="set-replay">Replay welcome</button>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Zoom</div>
              <div class="set-sub">Make the whole app bigger or smaller.</div>
            </div>
            <div class="seg" id="seg-zoom">
              ${['90', '100', '110', '125'].map((v) => `<button data-v="${v}" class="${zoom === v ? 'on' : ''}">${v}%</button>`).join('')}
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Open Nook on</div>
              <div class="set-sub">Where the app lands when it starts.</div>
            </div>
            <select id="set-defaultview" class="set-select">
              <option value="all"${dview === 'all' ? ' selected' : ''}>All Notes</option>
              <option value="favorites"${dview === 'favorites' ? ' selected' : ''}>Favorites</option>
              <option value="tasks"${dview === 'tasks' ? ' selected' : ''}>Tasks</option>
              <option value="board"${dview === 'board' ? ' selected' : ''}>Board</option>
            </select>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Default folder for new notes</div>
              <div class="set-sub">New notes land here (unless you're inside a folder).</div>
            </div>
            <select id="set-deffolder" class="set-select">
              <option value="">Unfiled</option>
              ${state.folders.map((f) => `<option value="${esc(f.id)}"${state.settings.defaultFolder === f.id ? ' selected' : ''}>${esc(f.name)}</option>`).join('')}
            </select>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Empty trash automatically</div>
              <div class="set-sub">Notes in the trash get removed after this many days.</div>
            </div>
            <select id="set-trashdays" class="set-select">
              <option value="0"${tdays === '0' ? ' selected' : ''}>Never</option>
              <option value="7"${tdays === '7' ? ' selected' : ''}>After 7 days</option>
              <option value="30"${tdays === '30' ? ' selected' : ''}>After 30 days</option>
              <option value="90"${tdays === '90' ? ' selected' : ''}>After 90 days</option>
            </select>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Close button hides to tray</div>
              <div class="set-sub">Nook keeps running (reminders still fire) — reopen it from the tray icon.</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="set-ctt"${ctt ? ' checked' : ''} />
              <span class="track"></span>
            </label>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Start Nook when I log in</div>
              <div class="set-sub">Launches quietly in the background with Windows.</div>
            </div>
            <label class="switch">
              <input type="checkbox" id="set-autostart"${auto ? ' checked' : ''} />
              <span class="track"></span>
            </label>
          </div>
        </div>

        <!-- ================= AI ================= -->
        <div class="set-page hidden" data-page="ai">
          <div class="set-row" style="display:block" id="sec-ai">
            <div class="set-label">Nook AI — bring your own key</div>
            <div class="set-sub">Pick a provider, paste the key, hit <b>Save &amp; connect</b>. Works with OpenRouter, Z.ai (GLM), OpenAI, Groq, Gemini, DeepSeek, Ollama, LM Studio.</div>
            <div class="prov-grid" id="prov-grid">
              ${AI_PROVIDERS.map((p) => {
                const conf = ai.providers[p.id] || {};
                const configured = !!(conf.model || '').trim() && (!p.key || !!(conf.apiKey || '').trim());
                return `<button class="prov-chip${activeId === p.id ? ' on' : ''}${configured ? ' ready' : ''}" data-p="${p.id}" title="${esc(p.name)}">
                  <span class="pc-name">${esc(p.name)}</span>
                  ${configured ? '<span class="pc-dot"></span>' : ''}
                </button>`;
              }).join('')}
            </div>
            <div id="prov-panel">${providerPanel(activeId)}</div>
            <div class="prov-row" style="margin-top:10px">
              <label>AI personality (system prompt)</label>
              <textarea id="ai-sysprompt" rows="2" spellcheck="false" class="prov-sys">${esc(ai.systemPrompt || '')}</textarea>
            </div>
          </div>
        </div>

        <!-- ================= DATA ================= -->
        <div class="set-page hidden" data-page="data">
          <div class="set-row">
            <div>
              <div class="set-label">Import notes</div>
              <div class="set-sub">Bring in .md or .txt files as notes.</div>
            </div>
            <div class="set-actions">
              <button class="btn ghost" id="btn-import-notes">${ico('upload')}Import files</button>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Backup</div>
              <div class="set-sub">Save everything to a file, or restore it on another PC. (API keys are never included.)</div>
            </div>
            <div class="set-actions">
              <button class="btn ghost" id="btn-backup-export">${ico('download')}Export</button>
              <button class="btn ghost" id="btn-backup-import">${ico('upload')}Import</button>
            </div>
          </div>
          <div class="set-row">
            <div>
              <div class="set-label">Your data</div>
              <div class="set-sub">Everything lives right here on this PC — notes never leave it.</div>
              <div class="data-path">${esc(dataPath)}\\nook.db</div>
            </div>
            <button class="btn ghost" id="btn-open-data">Open folder</button>
          </div>
          <div class="about-box">
            ${frogSvg}
            <div class="ab-text"><b>Nook v0.9.0</b> — a real native desktop app.<br>Rust + Tauri · SQLite · AI chat · 100% offline by default. Made cozy for Mr Real 🐸</div>
          </div>
        </div>
        </div>

        <div class="modal-actions">
          <button class="btn ghost" data-x="shortcuts">Shortcuts</button>
          <button class="btn primary" data-x="close">Done</button>
        </div>
      </div>
    </div>`;

  const done = () => closeModal();
  root.querySelector('[data-x="close"]').addEventListener('click', done);
  root.querySelector('[data-x="shortcuts"]').addEventListener('click', () => openShortcuts());
  root.querySelector('.overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) done();
  });
  root.querySelector('#btn-open-data').addEventListener('click', () => call('reveal_data_dir'));

  // v0.9 — tabbed settings: one clear page per topic
  const showTab = (name) => {
    root.querySelectorAll('.set-tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === name));
    root.querySelectorAll('.set-page').forEach((el) => el.classList.toggle('hidden', el.dataset.page !== name));
  };
  root.querySelectorAll('.set-tab').forEach((el) => {
    el.addEventListener('click', () => showTab(el.dataset.tab));
  });
  showTab(section === 'ai' ? 'ai' : section === 'data' ? 'data' : section === 'editor' ? 'editor' : 'look');

  const setSetting = async (key, value) => {
    await call('set_setting', { key, value });
  };

  root.querySelectorAll('.theme-chip').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.theme = b.dataset.t;
      root.querySelectorAll('.theme-chip').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('theme', b.dataset.t);
      applySettings();
    });
  });

  root.querySelectorAll('#seg-font button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.fontSize = b.dataset.v;
      root.querySelectorAll('#seg-font button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('fontSize', b.dataset.v);
      applySettings();
    });
  });

  root.querySelectorAll('#seg-edfont button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.editorFont = b.dataset.v;
      root.querySelectorAll('#seg-edfont button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('editorFont', b.dataset.v);
      applySettings();
    });
  });

  root.querySelectorAll('#seg-width button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.editorWidth = b.dataset.v;
      root.querySelectorAll('#seg-width button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('editorWidth', b.dataset.v);
      applySettings();
    });
  });

  root.querySelectorAll('#seg-accent button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.accent = b.dataset.v;
      root.querySelectorAll('#seg-accent button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('accent', b.dataset.v);
      applySettings();
      toast(b.dataset.v ? `Accent: ${ACCENTS[b.dataset.v].name}` : 'Accent: theme default');
    });
  });

  root.querySelectorAll('#seg-density button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.density = b.dataset.v;
      root.querySelectorAll('#seg-density button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('density', b.dataset.v);
      applySettings();
    });
  });

  root.querySelectorAll('#seg-edline button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.edLine = b.dataset.v;
      root.querySelectorAll('#seg-edline button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('edLine', b.dataset.v);
      applySettings();
    });
  });

  // v0.9 — zoom + trash auto-cleanup
  root.querySelectorAll('#seg-zoom button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.zoom = b.dataset.v;
      root.querySelectorAll('#seg-zoom button').forEach((x) => x.classList.toggle('on', x === b));
      await setSetting('zoom', b.dataset.v);
      applySettings();
      toast(`Zoom ${b.dataset.v}%`);
    });
  });

  root.querySelector('#set-username').addEventListener('change', async (e) => {
    state.userName = e.target.value.trim();
    await setSetting('userName', state.userName);
    applyGreeting();
    toast(state.userName ? `Nice to meet you, ${state.userName}` : 'Name cleared');
  });

  root.querySelector('#set-replay').addEventListener('click', () => {
    closeModal();
    obShow();
  });

  root.querySelector('#set-trashdays').addEventListener('change', async (e) => {
    state.settings.trashDays = e.target.value;
    await setSetting('trashDays', state.settings.trashDays);
    toast(e.target.value === '0' ? 'Trash keeps notes forever' : `Trash empties after ${e.target.value} days`);
  });

  root.querySelector('#set-defaultview').addEventListener('change', async (e) => {
    state.settings.defaultView = e.target.value || 'all';
    await setSetting('defaultView', state.settings.defaultView);
    toast('Nook will open on ' + e.target.selectedOptions[0].textContent);
  });

  root.querySelector('#set-ctt').addEventListener('change', async (e) => {
    state.settings.closeToTray = e.target.checked ? '1' : '0';
    await setSetting('closeToTray', state.settings.closeToTray);
    toast(e.target.checked ? 'Nook will hide to the tray' : 'Nook will quit when closed');
  });

  root.querySelector('#set-autosave').addEventListener('change', async (e) => {
    state.settings.autosave = e.target.checked ? '1' : '0';
    await setSetting('autosave', state.settings.autosave);
    toast(e.target.checked ? 'Realtime autosave on' : 'Autosave off — Ctrl+S to save');
    if (e.target.checked && pending) flushSave();
  });

  root.querySelector('#set-spellcheck').addEventListener('change', async (e) => {
    state.settings.spellcheck = e.target.checked ? '1' : '0';
    await setSetting('spellcheck', state.settings.spellcheck);
    applySettings();
  });

  root.querySelector('#set-deffolder').addEventListener('change', async (e) => {
    state.settings.defaultFolder = e.target.value || '';
    await setSetting('defaultFolder', state.settings.defaultFolder);
  });

  root.querySelector('#set-autostart').addEventListener('change', async (e) => {
    try {
      await call('autostart_set', { enabled: e.target.checked });
      state.settings.autostart = e.target.checked ? '1' : '0';
      toast(e.target.checked ? 'Nook will start with Windows' : 'Nook will not start with Windows');
    } catch (err) {
      e.target.checked = !e.target.checked;
      toast('Could not change: ' + err.message);
    }
  });

  root.querySelector('#btn-import-notes').addEventListener('click', async () => {
    try {
      const n = await call('import_notes');
      if (n) {
        await refreshAll();
        toast(`Imported ${n} note${n === 1 ? '' : 's'}`, { icon: 'upload' });
      }
    } catch (err) {
      if (!/cancel/i.test(err.message)) toast('Import failed: ' + err.message);
    }
  });

  // ---------------- AI providers ----------------
  const saveAi = async () => {
    await call('set_setting', { key: 'aiProviders', value: JSON.stringify(state.settings.ai) });
  };

  const refreshProvChips = () => {
    root.querySelectorAll('#prov-grid .prov-chip').forEach((chip) => {
      const pid = chip.dataset.p;
      const meta = AI_PROVIDERS.find((p) => p.id === pid);
      const conf = state.settings.ai.providers[pid] || {};
      const configured = !!(conf.model || '').trim() && (!meta?.key || !!(conf.apiKey || '').trim());
      chip.classList.toggle('on', pid === state.settings.ai.active);
      chip.classList.toggle('ready', configured);
      const dot = chip.querySelector('.pc-dot');
      if (dot) dot.remove();
      if (configured) chip.insertAdjacentHTML('beforeend', '<span class="pc-dot"></span>');
    });
    updateChatStatus();
  };

  const wireProviderPanel = () => {
    const panel = root.querySelector('#prov-panel');
    if (!panel) return;
    const pid = state.settings.ai.active || 'openrouter';
    const status = panel.querySelector('#pv-status');
    const confOf = () => {
      const ai2 = state.settings.ai;
      ai2.providers[pid] = ai2.providers[pid] || {};
      return ai2.providers[pid];
    };

    const keyInput = panel.querySelector('#pv-key');
    const modelInput2 = panel.querySelector('#pv-model');
    if (keyInput && !keyInput.disabled) {
      // v0.8 FIX: save WHILE typing (debounced) — not only on blur. Before,
      // a pasted key could be lost if the panel was re-rendered first, and
      // there was zero feedback that anything had been saved.
      let keyTimer = null;
      const persistKey = async () => {
        confOf().apiKey = keyInput.value.trim();
        await saveAi();
        refreshProvChips();
        status.innerHTML = '<span style="color:var(--accent)">Key saved ✓</span>';
        const meta2 = AI_PROVIDERS.find((p) => p.id === pid);
        // v0.9: no model picked yet? fetch one automatically — a bare key
        // used to sit there "not working" until a model was chosen by hand.
        if (!confOf().model) {
          if (meta2?.models && confOf().apiKey) {
            fetchModelsSilently(true);
          } else if (meta2?.suggestModels?.length) {
            confOf().model = meta2.suggestModels[0];
            if (modelInput2) modelInput2.value = meta2.suggestModels[0];
            await saveAi();
            refreshProvChips();
            status.innerHTML = `<span style="color:var(--accent)">Key saved ✓ · model auto-set to ${esc(meta2.suggestModels[0])}</span>`;
          }
        } else if (meta2?.models && confOf().apiKey) {
          fetchModelsSilently();
        }
      };
      keyInput.addEventListener('input', () => {
        clearTimeout(keyTimer);
        keyTimer = setTimeout(persistKey, 450);
      });
      keyInput.addEventListener('change', persistKey);
      keyInput.addEventListener('paste', () => {
        clearTimeout(keyTimer);
        keyTimer = setTimeout(persistKey, 120);
      });
    }
    const eye = panel.querySelector('#pv-eye');
    if (eye) {
      eye.addEventListener('click', () => {
        keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
      });
    }
    const urlInput = panel.querySelector('#pv-url');
    urlInput.addEventListener('change', async () => {
      confOf().url = urlInput.value.trim();
      await saveAi();
    });
    const modelInput = panel.querySelector('#pv-model');
    modelInput.addEventListener('change', async () => {
      confOf().model = modelInput.value.trim();
      await saveAi();
      refreshProvChips();
    });

    const sysp = root.querySelector('#ai-sysprompt');
    sysp.addEventListener('change', async () => {
      state.settings.ai.systemPrompt = sysp.value.trim() || DEFAULT_AI_SETTINGS.systemPrompt;
      await saveAi();
    });

    const fetchModelsSilently = async (autoPick = false) => {
      const box = panel.querySelector('#pv-models');
      if (!box) return;
      box.innerHTML = '<span class="ai-loading"><span class="ai-spin"></span>Fetching models…</span>';
      try {
        const models = await call('ai_list_models', { baseUrl: confOf().url, apiKey: confOf().apiKey || null });
        if (!models.length) {
          box.innerHTML = '<span class="pv-mini">Endpoint answered but listed no models — type the model name manually.</span>';
          return;
        }
        renderModelButtons(models);
        if (autoPick && !confOf().model) {
          confOf().model = models[0];
          const mi = panel.querySelector('#pv-model');
          if (mi) mi.value = models[0];
          await saveAi();
          renderModelButtons(models);
          refreshProvChips();
          status.innerHTML = `<span style="color:var(--accent)">Model auto-set to ${esc(models[0])}</span>`;
        }
      } catch (err) {
        box.innerHTML = `<span class="pv-mini" style="color:var(--danger)">${esc(err.message)}</span>`;
      }
    };

    const renderModelButtons = (models) => {
      const box = panel.querySelector('#pv-models');
      if (!box) return;
      box.innerHTML = models.slice(0, 60).map((m) =>
        `<button type="button" class="pv-model${m === modelInput.value.trim() ? ' on' : ''}" data-m="${esc(m)}">${esc(m)}</button>`
      ).join('');
      box.querySelectorAll('.pv-model').forEach((b) => {
        b.addEventListener('click', async () => {
          modelInput.value = b.dataset.m;
          confOf().model = b.dataset.m;
          await saveAi();
          box.querySelectorAll('.pv-model').forEach((x) => x.classList.toggle('on', x === b));
          refreshProvChips();
          toast(`Model set to ${b.dataset.m}`, { icon: 'sparkle' });
        });
      });
    };

    // popular-model chips (Z.ai etc. have no /models endpoint)
    panel.querySelectorAll('.prov-suggest .pv-model').forEach((b) => {
      b.addEventListener('click', async () => {
        modelInput.value = b.dataset.m;
        confOf().model = b.dataset.m;
        await saveAi();
        panel.querySelectorAll('.prov-suggest .pv-model').forEach((x) => x.classList.toggle('on', x === b));
        refreshProvChips();
        toast(`Model set to ${b.dataset.m}`, { icon: 'sparkle' });
      });
    });

    const fetchBtn = panel.querySelector('#pv-fetch');
    if (fetchBtn) {
      fetchBtn.addEventListener('click', async () => {
        confOf().url = urlInput.value.trim();
        confOf().apiKey = keyInput && !keyInput.disabled ? keyInput.value.trim() : confOf().apiKey;
        await saveAi();
        await fetchModelsSilently();
      });
    }

    const connectBtn = panel.querySelector('#pv-connect');
    if (connectBtn) {
      connectBtn.addEventListener('click', async () => {
        confOf().url = urlInput.value.trim();
        confOf().model = modelInput2 ? modelInput2.value.trim() : confOf().model;
        confOf().apiKey = keyInput && !keyInput.disabled ? keyInput.value.trim() : confOf().apiKey;
        await saveAi();
        if (!confOf().model) {
          status.innerHTML = '<span style="color:var(--warn)">Pick a model first (or click a popular one below)</span>';
          return;
        }
        status.innerHTML = '<span class="ai-loading"><span class="ai-spin"></span>Connecting…</span>';
        try {
          const reply = await call('ai_test', { baseUrl: confOf().url, apiKey: confOf().apiKey || null, model: confOf().model });
          status.innerHTML = `<span style="color:var(--accent)">${esc(reply)}</span>`;
          refreshProvChips();
          toast('AI connected — you can chat now!', { icon: 'sparkle' });
        } catch (err) {
          status.innerHTML = `<span style="color:var(--danger)">${esc(err.message)}</span>`;
        }
      });
    }
  };

  root.querySelectorAll('#prov-grid .prov-chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      state.settings.ai.active = chip.dataset.p;
      await saveAi();
      root.querySelector('#prov-panel').innerHTML = providerPanel(chip.dataset.p);
      wireProviderPanel();
      refreshProvChips();
    });
  });
  wireProviderPanel();
  refreshProvChips();

  root.querySelector('#btn-backup-export').addEventListener('click', async () => {
    try {
      const path = await call('export_backup');
      if (path) toast(`Backup saved: ${path.split(/[\\/]/).pop()}`, { icon: 'download' });
    } catch (err) {
      if (!/cancel/i.test(err.message)) toast('Backup failed: ' + err.message);
    }
  });

  root.querySelector('#btn-backup-import').addEventListener('click', async () => {
    const ok = await confirmModal({
      title: 'Import backup?',
      body: 'Everything currently in Nook will be REPLACED by the backup file. This cannot be undone.',
      confirmLabel: 'Choose backup file',
      danger: true
    });
    if (!ok) return;
    try {
      const stats = await call('import_backup');
      if (stats) {
        await loadSettings();
        applySettings();
        state.expandedTask = null;
        closeAllTabs();
        await refreshTasks();
        await refreshAll();
        state.currentNoteId = null;
        state.openNote = null;
        renderEditor();
        toast(`Backup restored — ${stats.notes} notes, ${stats.openTasks} open tasks`, { icon: 'upload' });
      }
    } catch (err) {
      if (!/cancel/i.test(err.message)) toast('Import failed: ' + err.message);
    }
  });
}

function openShortcuts() {
  const rows = [
    ['New note', 'Ctrl + N'],
    ['Search notes', 'Ctrl + F'],
    ['Quick switcher', 'Ctrl + K'],
    ['Save now', 'Ctrl + S'],
    ['Preview markdown', 'Ctrl + E'],
    ['Find & replace', 'Ctrl + H'],
    ['Bold / Italic', 'Ctrl + B / I'],
    ['Duplicate note', 'Ctrl + D'],
    ['Zen mode (nothing but your words)', 'Ctrl + Shift + F'],
    ['Open settings', 'Ctrl + ,'],
    ['This list', 'Ctrl + /'],
    ['Hide sidebar (focus mode)', 'Ctrl + \\'],
    ['Close dialog', 'Esc']
  ];
  const root = $('#overlay-root');
  root.innerHTML = `
    <div class="overlay">
      <div class="modal">
        <h3>Keyboard shortcuts</h3>
        <div class="kbd-list">
          ${rows.map(([label, keys]) => `<span>${label}</span><span class="kbd">${keys}</span>`).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn primary" data-x="close">Got it</button>
        </div>
      </div>
    </div>`;
  root.querySelector('[data-x="close"]').addEventListener('click', closeModal);
  root.querySelector('.overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

async function loadSettings() {
  state.settings.theme = (await call('get_setting', { key: 'theme' })) || 'midnight';
  // v0.4 → v0.5 theme migration
  if (state.settings.theme === 'dark') state.settings.theme = 'midnight';
  if (state.settings.theme === 'light') state.settings.theme = 'paper';
  state.settings.fontSize = (await call('get_setting', { key: 'fontSize' })) || '15';
  state.settings.editorFont = (await call('get_setting', { key: 'editorFont' })) || 'sans';
  state.settings.editorWidth = (await call('get_setting', { key: 'editorWidth' })) || 'normal';
  state.settings.closeToTray = (await call('get_setting', { key: 'closeToTray' })) || '0';
  // v0.7 settings
  state.settings.autosave = (await call('get_setting', { key: 'autosave' })) ?? '1';
  state.settings.spellcheck = (await call('get_setting', { key: 'spellcheck' })) || '0';
  state.settings.density = (await call('get_setting', { key: 'density' })) || 'cozy';
  state.settings.defaultFolder = (await call('get_setting', { key: 'defaultFolder' })) || '';
  state.settings.edLine = (await call('get_setting', { key: 'edLine' })) || '1.6';
  state.settings.defaultView = (await call('get_setting', { key: 'defaultView' })) || 'all';
  state.settings.zoom = (await call('get_setting', { key: 'zoom' })) || '100';
  state.settings.trashDays = (await call('get_setting', { key: 'trashDays' })) || '0';
  // v0.11 — accent color override ('' = theme default)
  state.settings.accent = (await call('get_setting', { key: 'accent' })) || '';
  // v0.10 — the user's name from onboarding, used for greetings
  state.userName = ((await call('get_setting', { key: 'userName' })) || '').trim();
  // AI providers (JSON blob; API keys stay in the local DB, never in backups)
  let ai = null;
  try {
    const raw = await call('get_setting', { key: 'aiProviders' });
    if (raw) ai = JSON.parse(raw);
  } catch { ai = null; }
  if (!ai || typeof ai !== 'object') ai = {};
  // v0.6 → v0.7 migration: old single-Ollama settings move to providers.ollama
  const legacyUrl = await call('get_setting', { key: 'aiUrl' });
  const legacyModel = await call('get_setting', { key: 'aiModel' });
  if (legacyUrl && !ai.providers?.ollama) {
    ai.providers = ai.providers || {};
    ai.providers.ollama = { url: legacyUrl, apiKey: '', model: legacyModel || '' };
    if (!ai.active) ai.active = legacyModel ? 'ollama' : '';
  }
  state.settings.ai = {
    active: ai.active || '',
    providers: ai.providers || {},
    systemPrompt: ai.systemPrompt || DEFAULT_AI_SETTINGS.systemPrompt
  };
  try {
    state.settings.autostart = IS_TAURI ? ((await call('autostart_get')) ? '1' : '0') : '0';
  } catch { state.settings.autostart = '0'; }
}

function activeAiProvider() {
  const ai = state.settings.ai;
  if (!ai.active) return null;
  const meta = AI_PROVIDERS.find((p) => p.id === ai.active);
  const conf = ai.providers[ai.active] || {};
  return {
    meta,
    url: (conf.url ?? meta?.url ?? '').trim(),
    apiKey: conf.apiKey || '',
    model: (conf.model || '').trim(),
    ready: !!(conf.model || '').trim() && (!meta?.key || !!(conf.apiKey || '').trim())
  };
}

function applySettings() {
  const t = state.settings.theme || 'midnight';
  document.body.dataset.theme = t;
  document.body.classList.toggle('light', LIGHT_THEMES.includes(t));
  document.documentElement.style.setProperty('--font-size', `${state.settings.fontSize}px`);
  document.body.dataset.edfont = state.settings.editorFont || 'sans';
  document.body.dataset.edwidth = state.settings.editorWidth || 'normal';
  document.body.dataset.edline = state.settings.edLine || '1.6';
  document.body.dataset.density = state.settings.density || 'cozy';
  // v0.11 — accent color override (Settings → Look); '' keeps the theme's own
  const acc = ACCENTS[state.settings.accent || ''];
  const setVar = (k, v) => document.body.style.setProperty(k, v);
  if (acc) {
    setVar('--accent', acc.a); setVar('--accent-strong', acc.s); setVar('--accent-text', acc.t);
    setVar('--accent-soft', acc.soft); setVar('--accent-glow', acc.glow);
  } else {
    ['--accent', '--accent-strong', '--accent-text', '--accent-soft', '--accent-glow'].forEach((k) => setVar(k, ''));
  }
  // v0.9: whole-UI zoom
  const z = Number(state.settings.zoom || '100');
  document.body.style.zoom = z && z !== 100 ? String(z / 100) : '';
  const ed = $('#ed-text');
  if (ed) ed.spellcheck = state.settings.spellcheck === '1';
}

// ------------------------------------------------------------------ shortcuts ----

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) {
      if (e.key === 'Escape') {
        if ($('#onboarding') && !$('#onboarding').classList.contains('hidden')) return; // onboarding handles its own keys
        if (mentionState.open) { closeMention(); return; }
        if (slashState.open) { closeSlash(); return; }
        if (document.body.classList.contains('zen')) { toggleZen(); return; }
        if ($('#menu-root').innerHTML) { closeMenu(); return; }
        if ($('#overlay-root').innerHTML) closeModal();
        return;
      }
      return;
    }
    switch (e.key.toLowerCase()) {
      case 'n':
        e.preventDefault();
        if (state.view.type !== 'trash') createNote();
        break;
      case 'f':
        e.preventDefault();
        if (e.shiftKey) { toggleZen(); break; } // Ctrl+Shift+F = zen (v0.10)
        $('#search-input').focus();
        $('#search-input').select();
        break;
      case 'e':
        e.preventDefault();
        if (state.openNote) {
          state.preview = !state.preview;
          applyPreviewMode();
          renderEditorToolbar();
        }
        break;
      case 'h':
        e.preventDefault();
        if (state.openNote && !state.openNote.trashed) toggleFindBar();
        break;
      case 'b':
        e.preventDefault();
        if (state.openNote && !state.preview && !state.openNote.trashed) mdAction('bold');
        break;
      case 'i':
        e.preventDefault();
        if (state.openNote && !state.preview && !state.openNote.trashed) mdAction('italic');
        break;
      case 'd':
        e.preventDefault();
        duplicateCurrent();
        break;
      case 's':
        e.preventDefault();
        flushSave().then(() => toast('Saved'));
        break;
      case ',':
        e.preventDefault();
        openSettings();
        break;
      case 'k':
        e.preventDefault();
        openQuickSwitcher();
        break;
      case '/':
        e.preventDefault();
        openShortcuts();
        break;
      case '\\':
        e.preventDefault();
        toggleZen();
        break;
      default:
        break;
    }
  });
}

// ------------------------------------------------------------------ events ----

function wireReminderListener() {
  if (!IS_TAURI) return;
  import('@tauri-apps/api/event')
    .then(({ listen }) => {
      listen('reminder', (e) => {
        const { id, title } = e.payload || {};
        toast(`⏰ ${title || 'Task reminder'}`, {
          icon: 'bell',
          ms: 10000,
          action: {
            label: 'Mark done',
            fn: async () => {
              try {
                await call('set_task', { id, done: true });
                await refreshTasks();
                renderTasks();
                refreshStatsOnly();
                toast('Task completed', { icon: 'checkSq' });
              } catch { /* ignore */ }
            }
          }
        });
      });
      listen('settings-changed', () => {
        loadSettings().then(applySettings).catch(() => {});
      });
      // v0.7 — recorder reports through events; no more frozen UI
      listen('recorder://event', (e) => {
        const p = e.payload || {};
        if (p.kind === 'started') {
          updateRecUi(true, 0);
          if (!state.recPoll) state.recPoll = setInterval(pollRecStatus, 500);
        } else if (p.kind === 'saved') {
          updateRecUi(false, 0);
          if (state.recPoll) { clearInterval(state.recPoll); state.recPoll = null; }
          if (p.info) toast(`Saved ${fmtClock(p.info.durationMs)} recording`, { icon: 'mic' });
          renderRecordings();
        } else if (p.kind === 'error') {
          updateRecUi(false, 0);
          if (state.recPoll) { clearInterval(state.recPoll); state.recPoll = null; }
          toast(p.message || 'Recorder error', { icon: 'mic', ms: 6000 });
          renderRecordings();
        }
      });
      // v0.7 — AI chat streaming
      listen('ai://event', (e) => {
        handleAiEvent(e.payload || {});
      });
    })
    .catch(() => {});
}

function wireEditor() {
  $('#ed-title').addEventListener('input', () => {
    if (!state.openNote) return;
    queueSave();
  });
  $('#ed-text').addEventListener('input', () => {
    if (!state.openNote) return;
    queueSave();
  });
  // v0.9 — find & replace bar
  $('#find-input').addEventListener('input', () => runFind());
  $('#find-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      closeFindBar();
      $('#ed-text').focus();
    }
  });
  $('#replace-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceOne();
    } else if (e.key === 'Escape') {
      closeFindBar();
      $('#ed-text').focus();
    }
  });
  $('#find-prev').addEventListener('click', () => findStep(-1));
  $('#find-next').addEventListener('click', () => findStep(1));
  $('#replace-one').addEventListener('click', replaceOne);
  $('#replace-all').addEventListener('click', replaceAll);
  $('#find-close').addEventListener('click', () => { closeFindBar(); $('#ed-text').focus(); });
  $('#btn-daily').addEventListener('click', openDailyNote);
  $('#btn-pin').addEventListener('click', togglePin);
  $('#btn-fav').addEventListener('click', toggleFavorite);
  $('#btn-duplicate').addEventListener('click', duplicateCurrent);
  $('#btn-trash').addEventListener('click', trashCurrent);
  $('#btn-restore').addEventListener('click', restoreCurrent);
  $('#btn-purge').addEventListener('click', purgeCurrent);
  $('#btn-export').addEventListener('click', (e) => {
    e.stopPropagation();
    exportMenu(e.currentTarget);
  });
  $('#btn-zen').addEventListener('click', toggleZen);
  $('#btn-preview').addEventListener('click', () => {
    if (state.preview) {
      state.preview = false;
      applyPreviewMode();
      renderEditorToolbar();
    } else {
      flushSave(); // persist the very latest keystrokes, then show them
      state.preview = true;
      applyPreviewMode();
      renderEditorToolbar();
    }
  });
  $('#btn-image').addEventListener('click', () => pickImages());
  $('#ed-img-file').addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (files.length) insertImageFiles(files);
  });
  $('#ed-text').addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      insertImageFiles(files);
    }
  });
  $('#ed-text').addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault();
  });
  $('#ed-text').addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) {
      e.preventDefault();
      e.stopPropagation();
      insertImageFiles(files);
    }
  });
  $('#ed-folder').addEventListener('change', (e) => moveCurrentNote(e.target.value || null));
  $('#ed-preview').addEventListener('click', (e) => {
    const mention = e.target.closest('.md-mention');
    if (mention) {
      e.preventDefault();
      openMentionByTitle(mention.dataset.mention);
      return;
    }
    const img = e.target.closest('img.md-img');
    if (img) {
      e.preventDefault();
      openLightbox(img.src, img.alt);
      return;
    }
    const a = e.target.closest('a');
    if (a) {
      e.preventDefault();
      call('open_url', { url: a.href });
    }
  });
  $('#nl-sort').addEventListener('change', async (e) => {
    state.sort = e.target.value;
    localStorage.setItem('nook.sort', state.sort);
    await refreshNotes();
    renderNoteList();
  });
  $('#btn-new-folder').addEventListener('click', newFolder);
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#btn-guide').addEventListener('click', openGuide);
  $('#btn-empty-trash').addEventListener('click', emptyTrash);
  $('#btn-ai').addEventListener('click', openAiMenu);
  $('#tab-new').addEventListener('click', () => createNote());
  $('#btn-rec').addEventListener('click', toggleRecording);
  $('#rec-pill-stop').addEventListener('click', toggleRecording);

  // right-click: custom menus everywhere (context-aware)
  window.addEventListener('contextmenu', (e) => {
    if (e.target.closest('.ctx')) return;
    if (e.target.closest('input, textarea, select') && !e.target.closest('#ed-text, #cv-input')) {
      return; // native menu for small fields
    }
    e.preventDefault();
    e.stopPropagation();
    showContextualMenu(e);
  });
  // click anywhere closes menus
  window.addEventListener('mousedown', (e) => {
    if (e.target.closest('.ctx, .slash')) return;
    closeMenu();
    if (slashState.open && !e.target.closest('#ed-text')) closeSlash();
    if (mentionState.open && !e.target.closest('#ed-text')) closeMention();
  }, true);

  wireSlash($('#ed-text'));
  wireMention($('#ed-text'));
  wireDragDrop();
  wireBoard();

  // markdown toolbar
  const mdBar = $('#md-bar');
  mdBar.addEventListener('mousedown', (e) => e.preventDefault()); // keep text selection
  mdBar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-md]');
    if (b) mdAction(b.dataset.md);
  });

  // tasks
  $('#tv-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#tv-input');
    const title = input.value.trim();
    if (!title) return;
    await call('create_task', { title });
    input.value = '';
    // if the new task can't be seen under the current filter, show everything
    const visible = state.tasks.some(
      (t) => t.title === title && taskMatchesFilter(t, state.taskFilter)
    );
    if (state.taskFilter !== 'all' && state.taskFilter !== 'done' && !visible) {
      state.taskFilter = 'all';
      localStorage.setItem('nook.taskFilter', 'all');
    }
    await refreshTasks();
    renderTasks();
    refreshStatsOnly();
  });
  $('#tv-sort').addEventListener('change', (e) => {
    state.taskSort = e.target.value;
    localStorage.setItem('nook.taskSort', state.taskSort);
    renderTasks();
  });
  $('#tv-filters').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-f]');
    if (!b) return;
    state.taskFilter = b.dataset.f;
    localStorage.setItem('nook.taskFilter', state.taskFilter);
    renderTasks();
  });
  $('#btn-clear-done').addEventListener('click', async () => {
    await call('clear_done_tasks');
    await refreshTasks();
    renderTasks();
    refreshStatsOnly();
  });

  // realtime save: flush whenever the app is hidden or loses focus
  window.addEventListener('blur', () => {
    flushSave();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) flushSave();
  });
  window.addEventListener('beforeunload', () => {
    if (state.openNote && pending) {
      if (state.openNote.title !== pending.title || state.openNote.content !== pending.content) {
        // fire and forget — best effort on close
        call('save_note', { id: state.openNote.id, title: pending.title, content: pending.content });
      }
    }
  });
}

// ==================================================================
// v0.6 — TABS
// ==================================================================

function noteTitleFor(id) {
  const s = state.notes.find((n) => n.id === id);
  if (s) return s.title.trim() || 'Untitled note';
  const t = state.tabs.find((x) => x.id === id);
  return (t && t.title) || 'Untitled note';
}

function openTab(id, title) {
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) existing.title = title || existing.title;
  else state.tabs.push({ id, title: title || 'Untitled note' });
  renderTabs();
}

function closeTab(id, { switchAway = true } = {}) {
  const idx = state.tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  if (state.currentNoteId === id) flushSave();
  state.tabs.splice(idx, 1);
  if (state.currentNoteId === id && switchAway) {
    const next = state.tabs[idx] || state.tabs[idx - 1] || null;
    if (next) {
      selectNote(next.id);
    } else {
      state.currentNoteId = null;
      state.openNote = null;
      renderEditor();
      renderTabs();
    }
  } else {
    renderTabs();
  }
}

function closeAllTabs() {
  state.tabs = [];
  state.currentNoteId = null;
  state.openNote = null;
  renderEditor();
  renderTabs();
}

function renderTabs() {
  const bar = $('#tabbar');
  const wrap = $('#tabs');
  if (!state.tabs.length) {
    bar.classList.add('hidden');
    wrap.innerHTML = '';
    return;
  }
  bar.classList.remove('hidden');
  wrap.innerHTML = state.tabs
    .map(
      (t) => `
      <div class="tab${t.id === state.currentNoteId ? ' active' : ''}" data-tid="${esc(t.id)}" draggable="true" title="${esc(t.title)}">
        <span class="t-label">${esc(t.title)}</span>
        <button class="t-close" title="Close tab">&times;</button>
      </div>`
    )
    .join('');

  wrap.querySelectorAll('.tab').forEach((el) => {
    const tid = el.dataset.tid;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.t-close')) return;
      if (tid !== state.currentNoteId) selectNote(tid);
    });
    el.querySelector('.t-close').addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(tid);
    });
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tid);
      }
    });
    // v0.8: drag tabs to reorder them
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', 'nook-tab:' + tid);
      e.dataTransfer.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
    el.addEventListener('drop', (e) => {
      const raw = e.dataTransfer.getData('text/plain') || '';
      if (!raw.startsWith('nook-tab:')) return; // note-card drops pass through
      e.preventDefault();
      e.stopPropagation();
      const srcId = raw.slice('nook-tab:'.length);
      if (srcId === tid) return;
      const from = state.tabs.findIndex((t) => t.id === srcId);
      const to = state.tabs.findIndex((t) => t.id === tid);
      if (from === -1 || to === -1) return;
      const [moved] = state.tabs.splice(from, 1);
      state.tabs.splice(to, 0, moved);
      renderTabs();
    });
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, [
        { label: 'Close tab', icon: 'x', fn: () => closeTab(tid) },
        { label: 'Close other tabs', icon: 'x', disabled: state.tabs.length < 2, fn: () => { state.tabs = state.tabs.filter((t) => t.id === tid); if (state.currentNoteId !== tid) selectNote(tid); else renderTabs(); } },
        { sep: true },
        { label: 'Close all tabs', icon: 'x', fn: closeAllTabs }
      ]);
    });
  });
}

// ==================================================================
// v0.6 — CONTEXT MENU (right-click)
// ==================================================================

function closeMenu() {
  $('#menu-root').innerHTML = '';
}

function showMenu(x, y, items) {
  const root = $('#menu-root');
  const html = items
    .map((it, idx) => {
      if (it.sep) return '<div class="ctx-sep"></div>';
      if (it.header) return `<div class="ctx-label">${esc(it.label || '')}</div>`;
      return `
        <button class="ctx-item${it.danger ? ' danger' : ''}${it.disabled ? ' disabled' : ''}" data-mi="${idx}">
          <span class="ci-ico">${it.icon ? ico(it.icon) : ''}</span>
          <span>${esc(it.label)}</span>
          ${it.key ? `<span class="ci-key">${esc(it.key)}</span>` : ''}
        </button>`;
    })
    .join('');
  root.innerHTML = `<div class="ctx">${html}</div>`;
  const menu = root.querySelector('.ctx');
  const rect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  menu.style.left = `${Math.min(x, vw - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, vh - rect.height - 8)}px`;

  root.querySelectorAll('.ctx-item').forEach((el) => {
    const it = items[Number(el.dataset.mi)];
    if (!it || !it.fn) return;
    el.addEventListener('click', () => {
      closeMenu();
      it.fn();
    });
  });
}

// ==================================================================
// v0.6 — SLASH MENU (Notion style, type / in the editor)
// ==================================================================

const SLASH_COMMANDS = [
  { name: 'Heading 1', hint: 'Big section title', icon: 'H1', kind: 'h1' },
  { name: 'Heading 2', hint: 'Medium section title', icon: 'H2', kind: 'h2' },
  { name: 'Heading 3', hint: 'Small section title', icon: 'H3', kind: 'h3' },
  { name: 'Bullet list', hint: 'Simple list', icon: '•', kind: 'ul' },
  { name: 'Numbered list', hint: '1. 2. 3.', icon: '1.', kind: 'ol' },
  { name: 'To-do list', hint: 'Track things with checkboxes', icon: '☑', kind: 'check' },
  { name: 'Quote', hint: 'Capture a quote', icon: '❝', kind: 'quote' },
  { name: 'Code block', hint: 'Monospaced code', icon: '<>', kind: 'codeblock' },
  { name: 'Inline code', hint: '`code`', icon: '<>', kind: 'code' },
  { name: 'Link', hint: 'Markdown link', icon: 'link', kind: 'link' },
  { name: 'Divider', hint: 'Visual separator', icon: '—', kind: 'divider' },
  { name: 'Timestamp', hint: 'Insert current date & time', icon: 'clock', kind: 'timestamp' },
  { name: 'Image', hint: 'Embed a picture from this PC', icon: 'image', kind: 'image' },
  { name: 'Mention note', hint: 'Link another note with [[…]]', icon: 'mention', kind: 'mention' },
  { name: 'Template · Daily journal', hint: 'Gratitude, wins, worries, to-dos', icon: 'date', kind: 'tplJournal' },
  { name: 'Template · Meeting notes', hint: 'Agenda, notes, action items', icon: 'book', kind: 'tplMeeting' },
  { name: 'Template · Weekly review', hint: 'Wins, lessons, next week', icon: 'clock', kind: 'tplWeek' }
];

// v0.10 — ready-made page skeletons, one /command away
const NOTE_TEMPLATES = {
  tplJournal: () => {
    const d = new Date().toLocaleDateString(undefined, { dateStyle: 'full' });
    return `## 🌤 ${d}\n\n### Grateful for\n- \n\n### Wins of today\n- \n\n### On my mind\n- \n\n### To do\n- [ ] `;
  },
  tplMeeting: () => {
    const d = new Date().toLocaleDateString(undefined, { dateStyle: 'medium' });
    return `## 📌 Meeting — ${d}\n\n**With:**  \n**Agenda:**\n\n### Notes\n- \n\n### Decisions\n- \n\n### Action items\n- [ ] `;
  },
  tplWeek: () => {
    const d = new Date().toLocaleDateString(undefined, { dateStyle: 'medium' });
    return `## 🗓 Weekly review — ${d}\n\n### Wins\n- \n\n### Lessons\n- \n\n### What to drop\n- \n\n### Focus next week\n- [ ] `;
  }
};

let slashState = { open: false, at: -1, query: '', sel: 0 };

function slashMatches() {
  const q = slashState.query.toLowerCase();
  return SLASH_COMMANDS.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.kind.includes(q) || (c.hint || '').toLowerCase().includes(q)
  );
}

function caretCoords(ta, pos) {
  const div = document.createElement('div');
  const st = getComputedStyle(ta);
  for (const k of ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent']) div.style[k] = st[k];
  div.style.position = 'absolute';
  div.style.visibility = 'hidden';
  div.style.whiteSpace = 'pre-wrap';
  div.style.wordWrap = 'break-word';
  div.style.width = `${ta.clientWidth}px`;
  div.style.padding = st.padding;
  div.style.boxSizing = st.boxSizing;
  div.textContent = ta.value.substring(0, pos);
  const span = document.createElement('span');
  span.textContent = '.';
  div.appendChild(span);
  ta.parentNode.appendChild(div);
  const coords = {
    top: span.offsetTop - ta.scrollTop,
    left: span.offsetLeft - ta.scrollLeft
  };
  div.remove();
  return coords;
}

function closeSlash() {
  slashState.open = false;
  const el = $('#slash-menu');
  if (el) el.remove();
}

function openSlash(ta) {
  slashState.open = true;
  slashState.query = '';
  slashState.sel = 0;
  renderSlash(ta);
}

function renderSlash(ta) {
  let el = $('#slash-menu');
  if (!el) {
    el = document.createElement('div');
    el.id = 'slash-menu';
    el.className = 'slash';
    $('#ed-body').appendChild(el);
  }
  const matches = slashMatches();
  slashState.sel = Math.min(slashState.sel, Math.max(0, matches.length - 1));
  if (!matches.length) {
    el.innerHTML = `<div class="slash-empty">No matching command</div>`;
    return;
  }
  el.innerHTML = matches
    .map((c, i) => {
      const sepRow = c.kind.startsWith('tpl') && !matches.slice(0, i).some((m) => m.kind.startsWith('tpl'))
        ? '<div class="slash-sep">Templates</div>'
        : '';
      return `${sepRow}
      <button class="slash-item${i === slashState.sel ? ' sel' : ''}" data-si="${i}">
        <span class="s-ico">${c.icon.startsWith('<') || c.icon.length <= 2 ? esc(c.icon) : ico(c.icon)}</span>
        <span><span class="s-name">${esc(c.name)}</span><br/><span class="s-hint">${esc(c.hint)}</span></span>
      </button>`;
    })
    .join('');
  const coords = caretCoords(ta, slashState.at);
  const bodyRect = $('#ed-body').getBoundingClientRect();
  el.style.left = `${Math.min(coords.left + 6, bodyRect.width - 246)}px`;
  el.style.top = `${coords.top + 30}px`;

  el.querySelectorAll('.slash-item').forEach((b) => {
    b.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep textarea focus
      applySlash(b.dataset.si, ta);
    });
  });
}

function applySlash(idx, ta) {
  const c = slashMatches()[idx];
  if (!c) return closeSlash();
  const v = ta.value;
  // v0.10 FIX: slashState.at is the anchor — the exact index of "/".
  // The old math drifted by query.length, so filtering more than one
  // character closed the menu and applying left "h1"-style residue behind.
  const anchor = slashState.at;
  const tokenLen = slashState.query.length + 1; // "/query"
  const before = v.slice(0, anchor);
  const after = v.slice(anchor + tokenLen);
  ta.value = before + after;
  ta.setSelectionRange(anchor, anchor);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  closeSlash();
  ta.focus();
  if (c.kind.startsWith('tpl')) {
    // v0.10 — templates insert at the caret like any other block
    const v2 = ta.value;
    const s2 = ta.selectionStart;
    const chunk = NOTE_TEMPLATES[c.kind]() + '\n';
    ta.value = v2.slice(0, s2) + chunk + v2.slice(s2);
    ta.setSelectionRange(s2 + chunk.length, s2 + chunk.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    toast('Template added — make it yours', { icon: 'pencil' });
  } else if (c.kind === 'codeblock' || c.kind === 'divider' || c.kind === 'timestamp') {
    // insert at caret instead of line-prefix
    const v2 = ta.value;
    const s2 = ta.selectionStart;
    const chunk = c.kind === 'codeblock' ? '```\ncode here\n```' : c.kind === 'divider' ? '\n---\n' : new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    ta.value = v2.slice(0, s2) + chunk + v2.slice(s2);
    ta.setSelectionRange(s2 + chunk.length, s2 + chunk.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  } else if (c.kind === 'image') {
    pickImages();
  } else if (c.kind === 'mention') {
    openMentionPicker(ta);
  } else {
    mdAction(c.kind);
  }
}

function wireSlash(ta) {
  ta.addEventListener('input', () => {
    if (!state.openNote || state.openNote.trashed) return;
    if (!slashState.open) return;
    const pos = ta.selectionStart;
    const v = ta.value;
    const start = slashState.at; // v0.10 FIX: fixed anchor — index of "/"
    if (pos <= start || v[start] !== '/') {
      closeSlash();
      return;
    }
    const q = v.slice(start + 1, pos);
    if (/\s/.test(q)) {
      closeSlash();
      return;
    }
    slashState.query = q;
    renderSlash(ta);
  });
  ta.addEventListener('keydown', (e) => {
    if (!slashState.open) {
      if (e.key === '/' && !state.preview && state.openNote && !state.openNote.trashed) {
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        // only trigger at line start (Notion style)
        if (pos === 0 || before.endsWith('\n') || /^\s*$/.test(before.split('\n').pop())) {
          setTimeout(() => {
            if (ta.selectionStart === pos + 1) openSlash(ta);
            if (slashState.open) {
              slashState.at = ta.selectionStart - 1;
              renderSlash(ta);
            }
          }, 0);
        }
        return;
      }
      return;
    }
    const matches = slashMatches();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      slashState.sel = (slashState.sel + 1) % Math.max(1, matches.length);
      renderSlash(ta);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      slashState.sel = (slashState.sel - 1 + matches.length) % Math.max(1, matches.length);
      renderSlash(ta);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      applySlash(slashState.sel, ta);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSlash();
    }
  });
}

// ==================================================================
// v0.6 — DRAG & DROP (notes → folders / trash)
// ==================================================================

function wireDragDrop() {
  const list = $('#nl-items');
  list.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.note-card');
    if (!card) return;
    e.dataTransfer.setData('text/plain', card.dataset.nid);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  list.addEventListener('dragend', (e) => {
    const card = e.target.closest('.note-card');
    if (card) card.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach((el) => el.classList.remove('drag-over'));
  });

  // v0.7 FIX: bind drop targets on the persistent sidebar CONTAINERS with
  // event delegation — per-row listeners used to die every time
  // renderSidebar() rebuilt the rows (drag-to-folder silently stopped).
  const wireDropTarget = (container) => {
    container.addEventListener('dragover', (e) => {
      const row = e.target.closest('.sb-row');
      if (!row || !e.dataTransfer.types.includes('text/plain')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      row.classList.add('drag-over');
    });
    container.addEventListener('dragleave', (e) => {
      const row = e.target.closest('.sb-row');
      if (row) row.classList.remove('drag-over');
    });
    container.addEventListener('drop', async (e) => {
      const row = e.target.closest('.sb-row');
      if (!row) return;
      e.preventDefault();
      row.classList.remove('drag-over');
      const nid = e.dataTransfer.getData('text/plain');
      if (!nid) return;
      const note = state.notes.find((n) => n.id === nid);
      if (!note) return;
      if (row.dataset.view === 'trash') {
        await call('trash_note', { id: nid, trashed: true });
        state.notes = state.notes.filter((n) => n.id !== nid);
        if (state.currentNoteId === nid) {
          state.currentNoteId = null;
          state.openNote = null;
          renderEditor();
        }
        renderNoteList();
        refreshStatsOnly();
        toast('Moved to trash', { icon: 'trash' });
        return;
      }
      if (row.dataset.fid) {
        await call('move_note', { id: nid, folderId: row.dataset.fid });
        note.folderId = row.dataset.fid;
        renderNoteList();
        refreshFolders().then(renderSidebar);
        const f = state.folders.find((x) => x.id === row.dataset.fid);
        toast(`Moved to ${f ? f.name : 'folder'}`, { icon: 'folder' });
      }
    });
  };
  wireDropTarget($('#sb-views'));
  wireDropTarget($('#sb-folders'));
}

// ==================================================================
// v0.8 — IMAGES IN NOTES (paste · drop · picker)
// ==================================================================

function fileToB64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result || '');
      resolve(s.includes(',') ? s.slice(s.indexOf(',') + 1) : s);
    };
    r.onerror = () => reject(new Error('Could not read the file'));
    r.readAsDataURL(file);
  });
}

function insertAtCaret(ta, text) {
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  const v = ta.value;
  const needsNlBefore = s > 0 && v[s - 1] !== '\n';
  const ins = (needsNlBefore ? '\n' : '') + text;
  ta.value = v.slice(0, s) + ins + v.slice(e);
  const caret = s + ins.length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

async function insertImageFiles(files) {
  const ta = $('#ed-text');
  if (!ta || !state.openNote || state.openNote.trashed) return;
  const imgs = [...files].filter((f) => f.type && f.type.startsWith('image/'));
  if (!imgs.length) return;
  setSaveState('saving', 'Adding image…');
  for (const f of imgs) {
    if (f.size > 10 * 1024 * 1024) {
      toast(`"${f.name || 'image'}" is over 10 MB — skipped`, { icon: 'image', ms: 4000 });
      continue;
    }
    try {
      const data = await fileToB64(f);
      const meta = await call('insert_note_image', {
        noteId: state.openNote.id,
        mime: f.type,
        name: f.name || 'image',
        data
      });
      insertAtCaret(ta, `![${(meta.name || 'image').replace(/[\[\]]/g, '')}](nookimg://${meta.id})\n`);
      toast('Image added', { icon: 'image' });
    } catch (err) {
      toast(err.message, { icon: 'image', ms: 4500 });
    }
  }
}

async function pickImages() {
  $('#ed-img-file').click();
}

// ---- @ mentions: type @ to link another note → [[Title]] ----

let mentionState = { open: false, at: -1, query: '', sel: 0 };

function mentionMatches() {
  const q = mentionState.query.toLowerCase();
  return (state.allNotesCache || [])
    .filter((n) => n.id !== state.currentNoteId)
    .filter((n) => !q || (n.title || 'untitled note').toLowerCase().includes(q))
    .slice(0, 8);
}

function closeMention() {
  mentionState.open = false;
  const el = $('#mention-menu');
  if (el) el.remove();
}

function renderMention(ta) {
  let el = $('#mention-menu');
  if (!el) {
    el = document.createElement('div');
    el.id = 'mention-menu';
    el.className = 'slash mention';
    $('#ed-body').appendChild(el);
  }
  const matches = mentionMatches();
  mentionState.sel = Math.min(Math.max(0, mentionState.sel), Math.max(0, matches.length - 1));
  if (!matches.length) {
    el.innerHTML = `<div class="slash-empty">No note matches "${esc(mentionState.query)}" — Enter to link anyway</div>`;
    return;
  }
  el.innerHTML = matches
    .map(
      (n, i) => `
      <button class="slash-item${i === mentionState.sel ? ' sel' : ''}" data-mi="${i}">
        <span class="s-ico">${ico('pencil')}</span>
        <span><span class="s-name">${esc(n.title.trim() || 'Untitled note')}</span><br/><span class="s-hint">${esc((n.snippet || '').slice(0, 52))}</span></span>
      </button>`
    )
    .join('');
  const coords = caretCoords(ta, mentionState.at);
  const bodyRect = $('#ed-body').getBoundingClientRect();
  el.style.left = `${Math.min(coords.left + 6, bodyRect.width - 246)}px`;
  el.style.top = `${coords.top + 30}px`;
  el.querySelectorAll('.slash-item').forEach((b) => {
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      applyMention(Number(b.dataset.mi), ta);
    });
  });
}

function openMentionPicker(ta) {
  // toolbar / slash-command entry: insert a fresh "@" and open the picker
  const pos = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const ins = (pos === 0 || before.endsWith('\n') || before.endsWith(' ') ? '' : ' ') + '@';
  ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(ta.selectionEnd ?? pos);
  const caret = pos + ins.length;
  ta.setSelectionRange(caret, caret);
  ta.focus();
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  mentionState = { open: true, at: caret - 1, query: '', sel: 0 };
  renderMention(ta);
}

function applyMention(idx, ta, customTitle) {
  const matches = mentionMatches();
  const pick = customTitle || (matches[idx] ? (matches[idx].title.trim() || 'Untitled note') : null);
  // v0.10 FIX: mentionState.at is the fixed index of "@" (same anchor fix as the slash menu)
  const start = mentionState.at;
  const end = mentionState.at + mentionState.query.length + 1;
  const v = ta.value;
  const linked = `[[${pick || mentionState.query || 'Untitled note'}]]`;
  ta.value = v.slice(0, start) + linked + v.slice(Math.min(end, v.length));
  const caret = start + linked.length;
  ta.setSelectionRange(caret, caret);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  closeMention();
  ta.focus();
}

function wireMention(ta) {
  ta.addEventListener('input', () => {
    if (!mentionState.open) return;
    const pos = ta.selectionStart;
    const v = ta.value;
    const start = mentionState.at; // v0.10 FIX: fixed anchor — index of "@"
    if (pos <= start || v[start] !== '@') {
      closeMention();
      return;
    }
    const q = v.slice(start + 1, pos);
    if (/\s/.test(q)) {
      closeMention();
      return;
    }
    mentionState.query = q;
    mentionState.sel = 0;
    renderMention(ta);
  });
  ta.addEventListener('keydown', (e) => {
    if (!mentionState.open) {
      // typing "@" (after whitespace / at start) opens the note picker — Notion style
      if (e.key === '@' && state.openNote && !state.openNote.trashed && !state.preview) {
        const pos = ta.selectionStart;
        const before = ta.value.slice(0, pos);
        if (pos === 0 || /[\s(\[]$/.test(before)) {
          setTimeout(() => {
            if (ta.selectionStart === pos + 1) {
              mentionState = { open: true, at: ta.selectionStart - 1, query: '', sel: 0 };
              renderMention(ta);
            }
          }, 0);
        }
      }
      return;
    }
    const matches = mentionMatches();
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      mentionState.sel = (mentionState.sel + 1) % Math.max(1, matches.length);
      renderMention(ta);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      mentionState.sel = (mentionState.sel - 1 + matches.length) % Math.max(1, matches.length);
      renderMention(ta);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      applyMention(mentionState.sel, ta);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeMention();
    } else if (e.key === ' ' || e.key === 'Enter') {
      closeMention();
    }
  });
}

async function openMentionByTitle(title) {
  const clean = String(title || '').trim().toLowerCase();
  if (!clean) return;
  if (!state.allNotesCache || !state.allNotesCache.length) {
    state.allNotesCache = await call('list_notes', { view: 'all', sort: 'updated' });
  }
  const hit = state.allNotesCache.find(
    (n) => (n.title || '').trim().toLowerCase() === clean
  );
  if (hit) {
    if (state.view.type === 'tasks' || state.view.type === 'board' || state.view.type === 'recordings' || state.view.type === 'chat') {
      setView({ type: 'all' });
    }
    await selectNote(hit.id);
  } else {
    toast(`No note named "${title}" yet`, { icon: 'mention' });
  }
}

// ---- backlinks ("linked from") under the editor ----

async function loadBacklinks() {
  const bar = $('#ed-backlinks');
  if (!bar || !state.openNote || state.view.type === 'trash') {
    if (bar) bar.classList.add('hidden');
    return;
  }
  try {
    const links = await call('note_backlinks', { id: state.openNote.id });
    if (!links.length) {
      bar.classList.add('hidden');
      return;
    }
    bar.classList.remove('hidden');
    bar.innerHTML =
      `<span class="bl-ico">${ico('mention')}</span><span class="bl-label">Linked from</span>` +
      links
        .slice(0, 6)
        .map(
          (l) =>
            `<button class="bl-chip" data-bid="${esc(l.id)}" title="${esc(l.snippet || '')}">${esc(l.title.trim() || 'Untitled note')}</button>`
        )
        .join('') +
      (links.length > 6 ? `<span class="bl-more">+${links.length - 6} more</span>` : '');
    bar.querySelectorAll('.bl-chip').forEach((b) => {
      b.addEventListener('click', async () => {
        if (state.view.type === 'trash') setView({ type: 'all' });
        await selectNote(b.dataset.bid);
      });
    });
  } catch {
    bar.classList.add('hidden');
  }
}

// ---- image lightbox in preview ----

function openLightbox(src, alt) {
  const root = $('#overlay-root');
  root.innerHTML = `
    <div class="overlay lightbox">
      <div class="lb-inner">
        <img src="${esc(src)}" alt="${esc(alt || '')}" />
        <div class="lb-cap">${esc(alt || 'Image')} · click anywhere to close</div>
      </div>
    </div>`;
  root.querySelector('.overlay').addEventListener('mousedown', () => closeModal());
  const escHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      window.removeEventListener('keydown', escHandler);
    }
  };
  window.addEventListener('keydown', escHandler);
}

// ==================================================================
// v0.8 — BOARD (Notion-style kanban, drag cards between columns)
// ==================================================================

const BOARD_COLS = [
  { status: 0, label: 'To do', dot: 'todo' },
  { status: 1, label: 'In progress', dot: 'doing' },
  { status: 2, label: 'Done', dot: 'done' }
];

let boardDragId = null;

function boardCardHtml(t) {
  const subs = t.subtasks || [];
  const subDone = subs.filter((x) => x.done).length;
  const badges = taskBadges(t);
  return `
    <div class="bv-card${t.done ? ' is-done' : ''}" draggable="true" data-tid="${esc(t.id)}" style="--i:${Math.min(12, t.position % 13)}">
      <div class="bv-prio p${t.priority || 0}"></div>
      <div class="bv-card-title">${esc(t.title)}</div>
      ${badges ? `<div class="bv-card-badges">${badges}</div>` : ''}
      ${subs.length ? `<div class="bv-subs">${ico('checkSq')}${subDone}/${subs.length}</div>` : ''}
    </div>`;
}

function renderBoard() {
  if (state.view.type !== 'board') return;
  const tasks = state.tasks || [];
  for (const col of BOARD_COLS) {
    const cardsEl = $(`#bvc-cards-${col.status}`);
    const countEl = $(`#bvc-count-${col.status}`);
    if (!cardsEl) continue;
    const inCol = tasks
      .filter((t) => (t.status ?? (t.done ? 2 : 0)) === col.status)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    countEl.textContent = inCol.length || '';
    cardsEl.innerHTML = inCol.length
      ? inCol.map(boardCardHtml).join('')
      : `<div class="bv-empty">Drop cards here</div>`;
    cardsEl.querySelectorAll('.bv-card').forEach((el) => {
      const tid = el.dataset.tid;
      el.addEventListener('dragstart', (e) => {
        boardDragId = tid;
        e.dataTransfer.setData('text/plain', tid);
        e.dataTransfer.effectAllowed = 'move';
        el.classList.add('dragging');
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        boardDragId = null;
        document.querySelectorAll('.bv-col').forEach((c) => c.classList.remove('drag-over'));
      });
      el.addEventListener('click', (e) => {
        if (e.button !== 0) return;
        state.expandedTask = tid;
        setView({ type: 'tasks' });
      });
      el.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        e.stopPropagation();
        showMenu(e.clientX, e.clientY, [
          { label: col.status === 2 ? 'Move to To do' : 'Mark done', icon: 'checkSq', fn: () => boardSetStatus(tid, col.status === 2 ? 0 : 2) },
          { label: 'Open in Tasks', icon: 'chevronD', fn: () => { state.expandedTask = tid; setView({ type: 'tasks' }); } },
          { sep: true },
          { label: 'Delete card', icon: 'trash', danger: true, fn: async () => { await call('delete_task', { id: tid }); state.tasks = state.tasks.filter((x) => x.id !== tid); renderBoard(); refreshStatsOnly(); renderSidebar(); } }
        ]);
      });
    });
  }
}

async function boardSetStatus(tid, status) {
  const t = state.tasks.find((x) => x.id === tid);
  if (!t) return;
  t.status = status;
  t.done = status === 2;
  try {
    await call('update_task', {
      id: t.id, title: t.title, notes: t.notes || '', priority: t.priority || 0,
      dueAt: t.dueAt ?? null, remindAt: t.remindAt ?? null, repeat: t.repeat || 'none',
      subtasks: t.subtasks || [], status
    });
    renderBoard();
    refreshStatsOnly();
    renderSidebar();
    if (status === 2) toast('Card done — nice!', { icon: 'checkSq' });
  } catch (err) {
    toast('Could not move card: ' + err.message);
  }
}

async function boardDrop(status, insertBeforeTid) {
  const tid = boardDragId;
  boardDragId = null;
  if (!tid) return;
  const t = state.tasks.find((x) => x.id === tid);
  if (!t) return;
  const oldStatus = t.status ?? (t.done ? 2 : 0);

  // local optimistic reorder within state.tasks
  const colIds = (st) =>
    state.tasks
      .filter((x) => (x.status ?? (x.done ? 2 : 0)) === st)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((x) => x.id);

  if (oldStatus !== status) t.status = status;
  const ids = colIds(status).filter((id) => id !== tid);
  const at = insertBeforeTid ? ids.indexOf(insertBeforeTid) : ids.length;
  ids.splice(at === -1 ? ids.length : at, 0, tid);
  ids.forEach((id, i) => {
    const task = state.tasks.find((x) => x.id === id);
    if (task) task.position = i + 1;
  });

  renderBoard();
  try {
    await call('update_task', {
      id: t.id, title: t.title, notes: t.notes || '', priority: t.priority || 0,
      dueAt: t.dueAt ?? null, remindAt: t.remindAt ?? null, repeat: t.repeat || 'none',
      subtasks: t.subtasks || [], status, position: t.position ?? null
    });
    await Promise.all(
      ids.map((id) => {
        const task = state.tasks.find((x) => x.id === id);
        if (!task) return Promise.resolve();
        return call('update_task', {
          id: task.id, title: task.title, notes: task.notes || '', priority: task.priority || 0,
          dueAt: task.dueAt ?? null, remindAt: task.remindAt ?? null, repeat: task.repeat || 'none',
          subtasks: task.subtasks || [], status: task.status ?? 0, position: task.position ?? null
        }).catch(() => {});
      })
    );
    refreshStatsOnly();
    renderSidebar();
    if (oldStatus !== status && status === 2) {
      toast('Card done — nice!', { icon: 'checkSq' });
      const card = $(`#bvc-cards-2 [data-tid="${t.id}"]`);
      if (card) confettiAtEl(card);
    }
  } catch (err) {
    toast('Could not move card: ' + err.message);
  }
}

function wireBoard() {
  for (const col of BOARD_COLS) {
    const cardsEl = $(`#bvc-cards-${col.status}`);
    if (!cardsEl) continue;
    cardsEl.addEventListener('dragover', (e) => {
      if (!boardDragId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const colEl = cardsEl.closest('.bv-col');
      colEl.classList.add('drag-over');
      // insertion indicator
      const cards = [...cardsEl.querySelectorAll('.bv-card:not(.dragging)')];
      const after = cards.find((c) => {
        const r = c.getBoundingClientRect();
        return e.clientY < r.top + r.height / 2;
      });
      cards.forEach((c) => c.classList.remove('drop-before'));
      if (after) after.classList.add('drop-before');
      cardsEl.dataset.insertBefore = after ? after.dataset.tid : '';
    });
    cardsEl.addEventListener('dragleave', (e) => {
      const colEl = cardsEl.closest('.bv-col');
      if (!colEl.contains(e.relatedTarget)) colEl.classList.remove('drag-over');
    });
    cardsEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const colEl = cardsEl.closest('.bv-col');
      colEl.classList.remove('drag-over');
      const before = cardsEl.dataset.insertBefore || null;
      delete cardsEl.dataset.insertBefore;
      document.querySelectorAll('.bv-card.drop-before').forEach((c) => c.classList.remove('drop-before'));
      boardDrop(col.status, before);
    });

    const form = document.querySelector(`.bv-new[data-status="${col.status}"]`);
    const addBtn = document.querySelector(`.bv-col[data-status="${col.status}"] .bv-add`);
    if (addBtn) {
      addBtn.addEventListener('click', () => {
        form.classList.toggle('hidden');
        if (!form.classList.contains('hidden')) form.querySelector('input').focus();
      });
    }
    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const input = form.querySelector('input');
        const title = input.value.trim();
        if (!title) return;
        try {
          const t = await call('create_task', { title, status: col.status });
          state.tasks.push(t);
          input.value = '';
          form.classList.add('hidden');
          renderBoard();
          refreshStatsOnly();
          renderSidebar();
          toast('Card added', { icon: 'board' });
        } catch (err) {
          toast(err.message);
        }
      });
    }
  }
}

// ==================================================================
// v0.6 — MEETING RECORDER
// ==================================================================

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function fmtBytes(b) {
  if (b > 1048576) return `${(b / 1048576).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(b / 1024))} KB`;
}

async function renderRecordings() {
  if (state.view.type !== 'recordings') return;
  const list = $('#rv-list');
  let recs = [];
  try {
    recs = await call('list_recordings');
  } catch { /* ignore */ }

  if (!recs.length) {
    list.innerHTML = `
      <div class="rv-empty">${frogSvg}
        <div><b>No recordings yet</b></div>
        <div>Hit <b>Start recording</b> in your next meeting — the file stays right here on your PC.</div>
      </div>`;
    return;
  }

  list.innerHTML = recs
    .map(
      (r) => `
      <div class="rv-item" data-name="${esc(r.name)}">
        <button class="rv-play" title="Play / pause">${ico('play')}</button>
        <div class="rv-main">
          <div class="rv-name">${esc(r.name.replace(/\.wav$/i, ''))}</div>
          <div class="rv-meta">${fmtClock(r.durationMs)} · ${fmtBytes(r.bytes)} · ${fmtDate(r.createdAt)}</div>
        </div>
        <div class="rv-actions">
          <button class="rv-ren" title="Rename">${ico('pencil')}</button>
          <button class="rv-exp" title="Save as…">${ico('export')}</button>
          <button class="rv-del" title="Delete">&times;</button>
        </div>
      </div>`
    )
    .join('');

  list.querySelectorAll('.rv-item').forEach((item) => {
    const name = item.dataset.name;
    const rec = recs.find((r) => r.name === name);
    item.querySelector('.rv-play').addEventListener('click', () => togglePlay(item, rec));
    item.querySelector('.rv-ren').addEventListener('click', async () => {
      const newName = await promptModal({
        title: 'Rename recording',
        value: name,
        placeholder: 'recording-name.wav',
        confirmLabel: 'Rename'
      });
      if (newName && newName.trim() && newName.trim() !== name) {
        const withExt = newName.trim().toLowerCase().endsWith('.wav') ? newName.trim() : newName.trim() + '.wav';
        await call('rename_recording', { from: name, to: withExt });
        renderRecordings();
        toast('Recording renamed');
      }
    });
    item.querySelector('.rv-exp').addEventListener('click', async () => {
      try {
        const p = await call('export_recording', { name });
        if (p) toast(`Saved to ${p.split(/[\\/]/).pop()}`, { icon: 'export' });
      } catch (err) {
        if (!/cancel/i.test(err.message)) toast('Export failed: ' + err.message);
      }
    });
    item.querySelector('.rv-del').addEventListener('click', async () => {
      const ok = await confirmModal({
        title: 'Delete recording?',
        body: `"${name}" will be deleted forever.`,
        confirmLabel: 'Delete',
        danger: true
      });
      if (!ok) return;
      if (state.audioEl) { state.audioEl.pause(); state.audioEl = null; }
      item.classList.add('removing');
      setTimeout(async () => {
        await call('delete_recording', { name });
        renderRecordings();
        toast('Recording deleted', { icon: 'trash' });
      }, 260);
    });
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(e.clientX, e.clientY, [
        { label: 'Play / pause', icon: 'play', fn: () => togglePlay(item, rec) },
        { label: 'Save as…', icon: 'export', fn: () => item.querySelector('.rv-exp').click() },
        { sep: true },
        { label: 'Delete recording', icon: 'trash', danger: true, fn: () => item.querySelector('.rv-del').click() }
      ]);
    });
  });
}

async function togglePlay(item, rec) {
  if (!IS_TAURI) {
    toast('Audio playback works in the desktop app', { icon: 'mic' });
    return;
  }
  let src = null;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    src = convertFileSrc(rec.path);
  } catch {
    src = null;
  }
  if (!src) {
    toast('Could not open audio file', { icon: 'mic' });
    return;
  }
  if (state.audioEl && !state.audioEl.paused && state.audioEl.dataset.name === rec.name) {
    state.audioEl.pause();
    setPlayIcons(rec.name, false);
    return;
  }
  if (state.audioEl) {
    state.audioEl.pause();
    document.querySelectorAll('.rv-audio').forEach((a) => a.remove());
    setPlayIcons(state.audioEl.dataset.name, false);
  }
  const audio = new Audio(src);
  audio.dataset.name = rec.name;
  state.audioEl = audio;
  const holder = document.createElement('div');
  holder.className = 'rv-audio';
  audio.controls = true;
  holder.appendChild(audio);
  item.appendChild(holder);
  audio.play().then(() => setPlayIcons(rec.name, true)).catch(() => toast('Playback failed', { icon: 'mic' }));
  audio.onended = () => {
    setPlayIcons(rec.name, false);
    holder.remove();
  };
}

function setPlayIcons(name, playing) {
  document.querySelectorAll('.rv-item').forEach((item) => {
    if (item.dataset.name !== name) return;
    item.querySelector('.rv-play').innerHTML = ico(playing ? 'pause' : 'play');
  });
}

async function refreshRecDevices() {
  const sel = $('#rec-device');
  try {
    const devices = await call('recorder_devices');
    sel.innerHTML = devices.length
      ? devices.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')
      : '<option value="">No microphone found</option>';
  } catch {
    sel.innerHTML = '<option value="">Default microphone</option>';
  }
}

async function pollRecStatus() {
  try {
    const st = await call('recorder_status');
    updateRecUi(st.recording, st.elapsedMs);
    if (!st.recording && state.recPoll) {
      clearInterval(state.recPoll);
      state.recPoll = null;
    }
  } catch { /* ignore */ }
}

function updateRecUi(recording, elapsedMs) {
  const btn = $('#btn-rec');
  const pill = $('#rec-pill');
  const timer = $('#rec-timer');
  const pillTime = $('#rec-pill-time');
  const label = $('#rec-label');
  btn.classList.toggle('recording', recording);
  btn.classList.toggle('idle', !recording);
  label.textContent = recording ? 'Stop recording' : 'Start recording';
  timer.classList.toggle('hidden', !recording);
  pill.classList.toggle('hidden', !recording);
  if (recording) {
    timer.textContent = fmtClock(elapsedMs);
    pillTime.textContent = fmtClock(elapsedMs);
  }
}

async function toggleRecording() {
  const btn = $('#btn-rec');
  if (btn.classList.contains('recording')) {
    // stop is fire-and-forget on the Rust side — the `saved` event refreshes
    // the UI when the WAV is finalised. Nothing blocks, nothing freezes.
    try {
      const info = await call('recorder_stop');
      updateRecUi(false, 0);
      if (state.recPoll) { clearInterval(state.recPoll); state.recPoll = null; }
      if (info) {
        // browser mock path (desktop reports via recorder://event)
        toast(`Saved ${fmtClock(info.durationMs)} recording`, { icon: 'mic' });
        renderRecordings();
      } else {
        toast('Finishing & saving…', { icon: 'mic' });
      }
    } catch (err) {
      toast('Could not stop: ' + err.message);
    }
    return;
  }
  try {
    const device = $('#rec-device').value || null;
    await call('recorder_start', { device });
    // optimistic UI — the `started`/`error` event confirms or corrects it
    updateRecUi(true, 0);
    if (!state.recPoll) state.recPoll = setInterval(pollRecStatus, 500);
  } catch (err) {
    toast(err.message, { icon: 'mic' });
  }
}

// ==================================================================
// v0.7 — NOOK AI (any OpenAI-compatible provider)
// ==================================================================

function aiActiveReady() {
  const p = activeAiProvider();
  return !!(p && p.ready);
}

async function aiEnsureModel() {
  if (aiActiveReady()) return true;
  openSettings('ai');
  toast('Pick an AI provider, add your key & model first — Settings → Nook AI', { icon: 'sparkle', ms: 5000 });
  return false;
}

async function aiRun(kind) {
  const n = state.openNote;
  if (!n || !n.content.trim()) {
    toast('Write something first — then let the AI work on it', { icon: 'sparkle' });
    return;
  }
  if (!(await aiEnsureModel())) return;

  const btn = $('#btn-ai');
  btn.innerHTML = `<span class="ai-spin"></span>`;
  const p = activeAiProvider();
  const prompts = {
    summarize: {
      system: 'You are a precise assistant inside a notes app. Reply with plain text only, no markdown headers.',
      prompt: `Summarize this note in 3-5 short bullet points (start each with "- "). Reply with only the bullets.\n\n---\n${n.content}`
    },
    actions: {
      system: 'You extract actionable tasks from notes. Reply with plain text only.',
      prompt: `Extract concrete action items from this note. One task per line, no numbering, no bullets, max 10 lines. If there are no action items, reply with exactly: NONE\n\n---\n${n.content}`
    },
    title: {
      system: 'You write short, clear titles. Reply with the title only.',
      prompt: `Suggest a short title (max 6 words) for this note. Reply with only the title.\n\n---\n${n.content.slice(0, 4000)}`
    },
    continue: {
      system: 'You are a writing partner inside a notes app. Continue the text naturally in the same voice, style and language. Output only the continuation — never repeat what is already written. Match the existing formatting (markdown).',
      prompt: `Continue writing this note from exactly where it stops. Write 3-6 more sentences (or list items if it's a list).\n\n---\n${n.content.slice(-4000)}`
    }
  };
  const cfg = prompts[kind];
  const messages = JSON.stringify([
    { role: 'system', content: cfg.system },
    { role: 'user', content: cfg.prompt }
  ]);
  try {
    const out = (
      await call('ai_complete', {
        baseUrl: p.url,
        apiKey: p.apiKey || null,
        model: p.model,
        messages
      })
    ).trim();
    btn.innerHTML = ico('sparkle');
    if (!out) {
      toast('The model returned nothing', { icon: 'sparkle' });
      return;
    }
    if (kind === 'actions') {
      const lines = out.split('\n').map((l) => l.replace(/^[-*\d.)\s]+/, '').trim()).filter((l) => l && l.toUpperCase() !== 'NONE');
      if (!lines.length) {
        toast('No action items found in this note', { icon: 'checkSq' });
        return;
      }
      for (const line of lines.slice(0, 10)) {
        await call('create_task', { title: line.slice(0, 200) });
      }
      await refreshTasks();
      renderTasks();
      refreshStatsOnly();
      toast(`Added ${Math.min(lines.length, 10)} task(s) from this note`, { icon: 'sparkle' });
    } else if (kind === 'title') {
      const title = out.replace(/^["']|["']$/g, '').split('\n')[0].slice(0, 80);
      $('#ed-title').value = title;
      queueSave();
      toast('Title updated', { icon: 'sparkle' });
    } else if (kind === 'continue') {
      const ta = $('#ed-text');
      if (!ta || ta.readOnly) return;
      const glue = ta.value.endsWith('\n') || !ta.value ? '' : '\n';
      ta.value = ta.value + glue + out + '\n';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
      toast('AI continued your writing', { icon: 'sparkle' });
    } else {
      showAiResult(out, n);
    }
  } catch (err) {
    btn.innerHTML = ico('sparkle');
    toast(err.message, { icon: 'sparkle', ms: 6000 });
  }
}

function showAiResult(out, n) {
  const root = $('#overlay-root');
  root.innerHTML = `
    <div class="overlay">
      <div class="modal" style="width:520px">
        <h3>${ico('sparkle')} Summary</h3>
        <div class="ai-out">${renderMarkdown(out)}</div>
        <div class="modal-actions">
          <button class="btn ghost" data-x="copy">Copy</button>
          <button class="btn ghost" data-x="insert">Insert into note</button>
          <button class="btn primary" data-x="close">Done</button>
        </div>
      </div>
    </div>`;
  const done = () => closeModal();
  root.querySelector('[data-x="close"]').addEventListener('click', done);
  root.querySelector('.overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) done();
  });
  root.querySelector('[data-x="copy"]').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(out);
      toast('Copied');
    } catch {
      toast('Could not copy');
    }
  });
  root.querySelector('[data-x="insert"]').addEventListener('click', () => {
    const ta = $('#ed-text');
    if (!ta || ta.readOnly) return;
    ta.value = `## Summary\n${out}\n\n---\n\n` + ta.value;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    closeModal();
    toast('Summary inserted at the top', { icon: 'sparkle' });
  });
}

function openAiMenu() {
  const btn = $('#btn-ai');
  const r = btn.getBoundingClientRect();
  showMenu(r.left, r.bottom + 6, [
    { label: 'Continue writing', icon: 'wand', key: 'AI', fn: () => aiRun('continue') },
    { label: 'Summarize note', icon: 'sparkle', fn: () => aiRun('summarize') },
    { label: 'Extract action items → tasks', icon: 'checkSq', fn: () => aiRun('actions') },
    { label: 'Suggest title', icon: 'pencil', fn: () => aiRun('title') },
    { sep: true },
    { label: 'Open AI chat', icon: 'all', key: 'Ctrl+K', fn: () => setView({ type: 'chat' }) },
    { sep: true },
    { header: true, label: 'Your provider, your key — see Settings' }
  ]);
}

// ==================================================================
// v0.7 — AI CHAT · redesigned in v0.10 (messenger-style bubbles,
// timestamps, smart scroll, code copy buttons, personal greeting)
// ==================================================================

function chatScrollStick(box, force = false) {
  // follow the stream only while the user is already near the bottom —
  // if they scrolled up to re-read, don't yank the scroll out of their hand
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 130;
  if (nearBottom || force) box.scrollTop = box.scrollHeight;
}

function fmtChatTime(ts) {
  try {
    return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function updateChatStatus() {
  const el = $('#cv-status');
  const prov = $('#cv-prov');
  const p = activeAiProvider();
  if (prov) {
    if (p && p.ready) {
      prov.classList.remove('hidden');
      prov.innerHTML = `${ico('sparkle')} <b>${esc(p.meta ? p.meta.name : 'AI')}</b><span class="cv-prov-model">${esc(p.model)}</span>`;
    } else {
      prov.classList.add('hidden');
    }
  }
  if (!el) return;
  if (!p || !p.ready) {
    el.innerHTML = `<span class="cv-pill warn">${ico('sparkle')} AI not set up yet — <button class="linklike" id="cv-goset">connect your key in Settings</button></span>`;
  } else {
    el.innerHTML = `<span class="cv-pill dim">keys stay on this PC · everything is local</span>`;
  }
  const go = el.querySelector('#cv-goset');
  if (go) go.addEventListener('click', () => openSettings('ai'));
}

const CHAT_SUGGESTIONS = [
  { icon: '💡', text: 'Brainstorm 10 ideas for my next project' },
  { icon: '🗓', text: 'Plan my day in 3 priority blocks' },
  { icon: '🧠', text: 'Explain a hard topic simply' },
  { icon: '✉️', text: 'Write a short email for me' },
  { icon: '📝', text: 'Summarize the note I have open' },
  { icon: '🎯', text: 'Turn my notes into action items' }
];

function userAvatarHtml() {
  const letter = (state.userName || 'You').trim().charAt(0).toUpperCase() || 'Y';
  return `<span class="cv-user-ava">${esc(letter)}</span>`;
}

function chatBubbleHtml(m) {
  const isUser = m.role === 'user';
  const body = isUser
    ? esc(m.content).replace(/\n/g, '<br/>')
    : renderMarkdown(m.content);
  const time = fmtChatTime(m.createdAt);
  return `
    <div class="cv-msg${isUser ? ' user' : ' bot'}" data-mid="${esc(m.id || '')}">
      <div class="cv-avatar">${isUser ? userAvatarHtml() : frogSvg}</div>
      <div class="cv-msg-main">
        <div class="cv-bubble"><div class="cv-content">${body}</div></div>
        ${!isUser && m.id ? `
        <div class="cv-msg-actions">
          <button class="cv-act" data-act="copy" title="Copy">${ico('copy')} Copy</button>
          <button class="cv-act" data-act="note" title="Append to the current note">${ico('pencil')} → Note</button>
        </div>` : ''}
        <div class="cv-meta"><b>${isUser ? esc(state.userName || 'You') : 'Nook AI'}</b><span>${time}</span></div>
      </div>
    </div>`;
}

// v0.10 — every ```code block``` in chat gets a one-click Copy button
function wireChatCodeCopy(scope) {
  (scope || $('#cv-messages')).querySelectorAll('.cv-content pre').forEach((pre) => {
    if (pre.querySelector('.pre-copy')) return;
    const btn = document.createElement('button');
    btn.className = 'pre-copy';
    btn.type = 'button';
    btn.innerHTML = `${ico('copy')} Copy`;
    btn.addEventListener('click', () => {
      const code = pre.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : pre.textContent)
        .then(() => { btn.classList.add('ok'); btn.innerHTML = `${ico('check')} Copied`; setTimeout(() => { btn.classList.remove('ok'); btn.innerHTML = `${ico('copy')} Copy`; }, 1400); })
        .catch(() => toast('Could not copy'));
    });
    pre.appendChild(btn);
  });
}

function renderChatMessages() {
  const box = $('#cv-messages');
  if (!box) return;
  if (!state.chatMsgs.length) {
    const who = state.userName ? `, <b class="cv-greet-name">${esc(state.userName)}</b>` : '';
    box.innerHTML = `
      <div class="cv-empty">
        <div class="cv-empty-frog">${frogSvg}</div>
        <h2>Salam${who}!</h2>
        <p>I live right here in Nook — draft ideas, summarize your notes,<br/>plan your day. Chats are saved on this PC only.</p>
        <div class="cv-suggest">
          ${CHAT_SUGGESTIONS.map((s) => `<button class="cv-sug" data-s="${esc(s.text)}"><span class="cv-sug-ico">${s.icon}</span><span>${esc(s.text)}</span></button>`).join('')}
        </div>
      </div>`;
    box.querySelectorAll('.cv-sug').forEach((b) => {
      b.addEventListener('click', () => {
        const input = $('#cv-input');
        input.value = b.dataset.s;
        input.focus();
        autoGrowChatInput();
      });
    });
    return;
  }
  box.innerHTML = state.chatMsgs.map(chatBubbleHtml).join('');
  wireChatMsgActions();
  wireChatCodeCopy(box);
  chatScrollStick(box, true);
}

function wireChatMsgActions() {
  $('#cv-messages').querySelectorAll('.cv-msg.bot').forEach((el) => {
    const mid = el.dataset.mid;
    el.querySelectorAll('.cv-act').forEach((b) => {
      b.addEventListener('click', () => {
        const m = state.chatMsgs.find((x) => x.id === mid);
        if (!m) return;
        if (b.dataset.act === 'copy') {
          navigator.clipboard.writeText(m.content).then(() => toast('Copied')).catch(() => toast('Could not copy'));
        } else if (b.dataset.act === 'note') {
          const ta = $('#ed-text');
          if (!ta) { toast('Open a note first', { icon: 'pencil' }); return; }
          ta.value = ta.value + (ta.value.endsWith('\n') || !ta.value ? '' : '\n\n') + m.content + '\n';
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          toast('Appended to the current note', { icon: 'pencil' });
        }
      });
    });
  });
}

async function refreshChats() {
  state.chats = await call('list_chats');
}

function renderChatSelect() {
  const sel = $('#cv-chat-select');
  sel.innerHTML = state.chats.length
    ? state.chats.map((c) => `<option value="${esc(c.id)}"${c.id === state.chatId ? ' selected' : ''}>${esc(c.title)}</option>`).join('')
    : '<option value="">No chats yet</option>';
}

async function openChatView() {
  await refreshChats();
  if (!state.chats.length) {
    const c = await call('create_chat', {});
    state.chats = [c];
    state.chatId = c.id;
  }
  if (!state.chats.some((c) => c.id === state.chatId)) {
    state.chatId = state.chats[0].id;
  }
  renderChatSelect();
  state.chatMsgs = await call('get_chat_messages', { chatId: state.chatId });
  renderChatMessages();
  updateChatStatus();
  updateChatComposer();
  setTimeout(() => $('#cv-input').focus(), 40);
}

function updateChatComposer() {
  const busy = state.aiStreaming;
  $('#cv-send').classList.toggle('hidden', busy);
  $('#cv-stop').classList.toggle('hidden', !busy);
  $('#cv-use-note').classList.toggle('on', state.chatUseNote);
}

function aiProviderOrWarn() {
  const p = activeAiProvider();
  if (!p || !p.ready) {
    openSettings('ai');
    toast('Add an API key & model first — Settings → Nook AI', { icon: 'sparkle', ms: 5000 });
    return null;
  }
  return p;
}

async function sendChat() {
  const input = $('#cv-input');
  const text = input.value.trim();
  if (!text || state.aiStreaming) return;
  const p = aiProviderOrWarn();
  if (!p) return;

  if (!state.chatId) {
    const c = await call('create_chat', {});
    state.chats.unshift(c);
    state.chatId = c.id;
    renderChatSelect();
  }

  input.value = '';
  autoGrowChatInput();

  const userMsg = await call('add_chat_message', { chatId: state.chatId, role: 'user', content: text });
  state.chatMsgs.push(userMsg);
  if (!state.chats.some((c) => c.id === state.chatId)) {
    // chat was created just now
    state.chats = await call('list_chats');
    renderChatSelect();
  } else {
    const c = state.chats.find((x) => x.id === state.chatId);
    if (c && c.title === 'New chat') {
      c.title = text.slice(0, 42);
      renderChatSelect();
    }
  }
  renderChatMessages();

  // build the request: history + optional note context
  const msgs = [];
  if (state.settings.ai.systemPrompt) {
    msgs.push({ role: 'system', content: state.settings.ai.systemPrompt });
  }
  for (const m of state.chatMsgs) {
    if (m.role === 'user' || m.role === 'assistant') {
      msgs.push({ role: m.role, content: m.content });
    }
  }
  if (state.chatUseNote && state.openNote) {
    msgs.splice(1, 0, {
      role: 'system',
      content: `The user's current note "${state.openNote.title || 'Untitled'}" — use it as context when relevant:\n---\n${state.openNote.content.slice(0, 12000)}\n---`
    });
    state.chatUseNote = false;
    updateChatComposer();
  }

  state.aiStreaming = true;
  state.aiReqId = 'req' + Date.now().toString(36) + Math.floor(Math.random() * 9999);
  state.aiStreamText = '';
  const placeholder = { id: '', role: 'assistant', content: '', createdAt: Date.now() };
  state.chatMsgs.push(placeholder);
  const box = $('#cv-messages');
  box.insertAdjacentHTML('beforeend', `
    <div class="cv-msg bot streaming" id="cv-streaming">
      <div class="cv-avatar">${frogSvg}</div>
      <div class="cv-msg-main">
        <div class="cv-bubble"><div class="cv-content"><span class="cv-typing"><i></i><i></i><i></i></span></div></div>
        <div class="cv-meta"><b>Nook AI</b><span>thinking…</span></div>
      </div>
    </div>`);
  chatScrollStick(box, true);
  updateChatComposer();

  if (!IS_TAURI) {
    // browser preview mock — fake a stream
    const reply = 'This is the browser preview — in the desktop app I answer through your own AI provider (OpenRouter, Z.ai, OpenAI, Groq, Gemini, Ollama…).';
    for (const w of reply.split(' ')) {
      await new Promise((r) => setTimeout(r, 40));
      state.aiStreamText += (state.aiStreamText ? ' ' : '') + w;
      const el = $('#cv-streaming .cv-content');
      if (el) el.innerHTML = renderMarkdown(state.aiStreamText) + '<span class="cv-cursor"></span>';
      chatScrollStick($('#cv-messages'));
    }
    finishChatStream();
    return;
  }

  try {
    await call('ai_chat', {
      requestId: state.aiReqId,
      baseUrl: p.url,
      apiKey: p.apiKey || null,
      model: p.model,
      messages: JSON.stringify(msgs)
    });
  } catch (err) {
    state.aiStreaming = false;
    const el = $('#cv-streaming');
    if (el) el.remove();
    state.chatMsgs.pop();
    renderChatMessages();
    updateChatComposer();
    toast(err.message, { icon: 'sparkle', ms: 6000 });
  }
}

function handleAiEvent(p) {
  if (!state.aiStreaming || p.id !== state.aiReqId) return;
  if (p.error) {
    state.aiStreaming = false;
    const el = $('#cv-streaming');
    if (el) el.remove();
    if (state.chatMsgs[state.chatMsgs.length - 1]?.role === 'assistant') state.chatMsgs.pop();
    renderChatMessages();
    updateChatComposer();
    toast(p.error, { icon: 'sparkle', ms: 7000 });
    return;
  }
  if (p.delta) {
    state.aiStreamText += p.delta;
    const el = $('#cv-streaming .cv-content');
    if (el) {
      el.innerHTML = renderMarkdown(state.aiStreamText) + '<span class="cv-cursor"></span>';
      chatScrollStick($('#cv-messages'));
    }
    return;
  }
  // done
  finishChatStream();
}

async function finishChatStream() {
  state.aiStreaming = false;
  const text = state.aiStreamText.trim();
  const el = $('#cv-streaming');
  if (el) el.remove();
  state.chatMsgs.pop(); // remove placeholder
  if (text) {
    const m = await call('add_chat_message', { chatId: state.chatId, role: 'assistant', content: text });
    state.chatMsgs.push(m);
  } else {
    toast('The model replied with nothing', { icon: 'sparkle' });
  }
  state.aiStreamText = '';
  renderChatMessages();
  updateChatComposer();
  if (text) {
    // browser-preview mock streams word by word — keep the follow-scroll alive
    chatScrollStick($('#cv-messages'), true);
  }
}

async function stopChatStream() {
  if (state.aiStreaming && state.aiReqId && IS_TAURI) {
    try { await call('ai_stop', { requestId: state.aiReqId }); } catch { /* ignore */ }
  }
  if (!IS_TAURI) finishChatStream();
}

function autoGrowChatInput() {
  const ta = $('#cv-input');
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`;
}

function wireChatView() {
  // v0.9 — chat header logo + send icon
  const logo = document.querySelector('.cv-logo');
  if (logo) logo.innerHTML = frogSvg;
  const sendBtn = $('#cv-send');
  if (sendBtn) sendBtn.innerHTML = ico('send');
  $('#cv-new').addEventListener('click', async () => {
    if (state.aiStreaming) { toast('Wait for the reply to finish (or press Stop)', { icon: 'sparkle' }); return; }
    const c = await call('create_chat', {});
    state.chats.unshift(c);
    state.chatId = c.id;
    state.chatMsgs = [];
    renderChatSelect();
    renderChatMessages();
    updateChatStatus();
    $('#cv-input').focus();
  });
  $('#cv-del').addEventListener('click', async () => {
    if (!state.chatId) return;
    const ok = await confirmModal({
      title: 'Delete this chat?',
      body: 'The whole conversation will be removed from this PC. There is no undo.',
      confirmLabel: 'Delete chat',
      danger: true
    });
    if (!ok) return;
    await call('delete_chat', { id: state.chatId });
    await refreshChats();
    state.chatId = state.chats[0]?.id || null;
    state.chatMsgs = state.chatId ? await call('get_chat_messages', { chatId: state.chatId }) : [];
    renderChatSelect();
    renderChatMessages();
    updateChatStatus();
  });
  $('#cv-chat-select').addEventListener('change', async (e) => {
    if (state.aiStreaming) return;
    state.chatId = e.target.value;
    state.chatMsgs = await call('get_chat_messages', { chatId: state.chatId });
    renderChatMessages();
  });
  $('#cv-composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });
  $('#cv-stop').addEventListener('click', stopChatStream);
  $('#cv-use-note').addEventListener('click', () => {
    if (!state.openNote) { toast('Open a note first — then I can use it as context', { icon: 'pencil' }); return; }
    state.chatUseNote = !state.chatUseNote;
    updateChatComposer();
    toast(state.chatUseNote ? 'Next message gets your note as context' : 'Note context off', { icon: 'all' });
  });
  const input = $('#cv-input');
  input.addEventListener('input', autoGrowChatInput);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });
}

// ==================================================================
// v0.7 — RIGHT-CLICK ANYWHERE (context-aware menus)
// ==================================================================

async function pasteInto(target) {
  try {
    const text = IS_TAURI
      ? await call('clipboard_read')
      : await navigator.clipboard.readText();
    const el = target;
    const s = el.selectionStart, e2 = el.selectionEnd;
    el.value = el.value.slice(0, s) + text + el.value.slice(e2);
    const np = s + text.length;
    el.setSelectionRange(np, np);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  } catch {
    toast('Clipboard is empty or blocked');
  }
}

function copySelectionOf(target) {
  const s = target.selectionStart, e2 = target.selectionEnd;
  const text = target.value.slice(s, e2);
  if (!text) { toast('Nothing selected'); return; }
  if (IS_TAURI) call('clipboard_write', { text }).then(() => toast('Copied')).catch(() => toast('Could not copy'));
  else navigator.clipboard.writeText(text).then(() => toast('Copied')).catch(() => toast('Could not copy'));
}

function cutSelectionOf(target) {
  const s = target.selectionStart, e2 = target.selectionEnd;
  const text = target.value.slice(s, e2);
  if (!text) { toast('Nothing selected'); return; }
  if (IS_TAURI) call('clipboard_write', { text }).catch(() => {});
  else navigator.clipboard.writeText(text).catch(() => {});
  target.value = target.value.slice(0, s) + target.value.slice(e2);
  target.setSelectionRange(s, s);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.focus();
}

function showContextualMenu(e) {
  const t = e.target;

  // ---- editor textarea ----
  if (t.id === 'ed-text') {
    const editable = state.openNote && !state.openNote.trashed && !state.preview;
    const items = [];
    if (editable) {
      items.push(
        { label: 'Cut', icon: 'copy', key: 'Ctrl+X', fn: () => cutSelectionOf(t) },
        { label: 'Copy', icon: 'copy', key: 'Ctrl+C', fn: () => copySelectionOf(t) },
        { label: 'Paste', icon: 'all', key: 'Ctrl+V', fn: () => pasteInto(t) },
        { sep: true }
      );
    }
    items.push(
      { label: 'Select all', icon: 'checkSq', key: 'Ctrl+A', fn: () => { t.focus(); t.select(); } }
    );
    if (editable) {
      items.push(
        { sep: true },
        { label: 'Insert date & time', icon: 'clock', fn: () => mdAction('timestamp') },
        { label: 'Insert image…', icon: 'image', fn: () => pickImages() },
        { label: 'Mention a note', icon: 'mention', fn: () => openMentionPicker(t) },
        { label: 'Slash commands', icon: 'pencil', fn: () => {
            const ta = t;
            ta.focus();
            const pos = ta.selectionStart;
            const before = ta.value.slice(0, pos);
            const ins = (pos === 0 || before.endsWith('\n') || /^\s*$/.test(before.split('\n').pop())) ? '/' : '\n/';
            ta.value = ta.value.slice(0, pos) + ins + ta.value.slice(pos);
            const caret = pos + ins.length;
            ta.setSelectionRange(caret, caret);
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            openSlash(ta);
            slashState.at = caret - 1; // position of the '/'
            renderSlash(ta);
          } },
        { label: state.preview ? 'Hide preview' : 'Markdown preview', icon: 'eye', key: 'Ctrl+E', fn: () => $('#btn-preview').click() },
        { label: 'Ask AI about this note', icon: 'sparkle', fn: () => openAiMenu() }
      );
    }
    showMenu(e.clientX, e.clientY, items);
    return;
  }

  // ---- chat composer ----
  if (t.id === 'cv-input') {
    showMenu(e.clientX, e.clientY, [
      { label: 'Cut', icon: 'copy', fn: () => cutSelectionOf(t) },
      { label: 'Copy', icon: 'copy', fn: () => copySelectionOf(t) },
      { label: 'Paste', icon: 'all', fn: () => pasteInto(t) },
      { sep: true },
      { label: 'Select all', icon: 'checkSq', fn: () => { t.focus(); t.select(); } }
    ]);
    return;
  }

  // ---- note list empty area / header ----
  if (t.closest('#note-list')) {
    const items = [
      { label: 'New note', icon: 'pencil', key: 'Ctrl+N', fn: () => createNote() },
      { label: 'New folder', icon: 'folder', fn: () => newFolder() }
    ];
    if (state.view.type === 'trash' && state.notes.length) {
      items.push({ sep: true }, { label: 'Empty trash', icon: 'trash', danger: true, fn: () => emptyTrash() });
    }
    items.push({ sep: true }, { label: 'Import .md / .txt files', icon: 'upload', fn: () => openSettings() });
    showMenu(e.clientX, e.clientY, items);
    return;
  }

  // ---- sidebar empty area ----
  if (t.closest('#sidebar')) {
    showMenu(e.clientX, e.clientY, [
      { label: 'New note', icon: 'pencil', key: 'Ctrl+N', fn: () => createNote() },
      { label: 'New folder', icon: 'folder', fn: () => newFolder() },
      { sep: true },
      { label: 'Settings', icon: 'settings', key: 'Ctrl+,', fn: () => openSettings() },
      { label: 'Guide', icon: 'book', fn: () => openGuide() }
    ]);
    return;
  }

  // ---- tabs bar empty space ----
  if (t.closest('#tabbar')) {
    showMenu(e.clientX, e.clientY, [
      { label: 'New note (new tab)', icon: 'pencil', key: 'Ctrl+N', fn: () => createNote() },
      { label: 'Close all tabs', icon: 'x', disabled: !state.tabs.length, fn: () => closeAllTabs() }
    ]);
    return;
  }

  // ---- tasks view ----
  if (t.closest('#tasks-view')) {
    showMenu(e.clientX, e.clientY, [
      { label: 'New task', icon: 'checkSq', fn: () => { $('#tv-input').focus(); } },
      { label: 'Clear completed', icon: 'trash', disabled: !state.tasks.some((x) => x.done), fn: async () => { await call('clear_done_tasks'); await refreshTasks(); renderTasks(); refreshStatsOnly(); } }
    ]);
    return;
  }

  // ---- board view ----
  if (t.closest('#board-view')) {
    showMenu(e.clientX, e.clientY, [
      { label: 'Refresh board', icon: 'all', fn: async () => { await refreshTasks(); renderBoard(); } },
      { label: 'Open Tasks list', icon: 'checkSq', fn: () => setView({ type: 'tasks' }) },
      { sep: true },
      { label: 'New card in To do', icon: 'board', fn: () => { document.querySelector('.bv-new[data-status="0"]').classList.remove('hidden'); document.querySelector('.bv-new[data-status="0"] input').focus(); } }
    ]);
    return;
  }

  // ---- recordings view ----
  if (t.closest('#rec-view')) {
    showMenu(e.clientX, e.clientY, [
      { label: $('#btn-rec').classList.contains('recording') ? 'Stop recording' : 'Start recording', icon: 'mic', fn: () => toggleRecording() },
      { label: 'Refresh list', icon: 'all', fn: () => renderRecordings() }
    ]);
    return;
  }

  // ---- AI chat view ----
  if (t.closest('#chat-view')) {
    showMenu(e.clientX, e.clientY, [
      { label: 'New chat', icon: 'sparkle', fn: () => $('#cv-new').click() },
      { label: 'Delete this chat', icon: 'trash', danger: true, disabled: !state.chatId, fn: () => $('#cv-del').click() },
      { sep: true },
      { label: 'AI settings', icon: 'settings', fn: () => openSettings('ai') }
    ]);
    return;
  }

  // ---- editor pane (title/toolbar/preview) ----
  if (t.closest('#ed-pane')) {
    if (state.openNote) {
      showMenu(e.clientX, e.clientY, [
        { label: state.openNote.pinned ? 'Unpin note' : 'Pin note', icon: 'pin', fn: () => togglePin() },
        { label: state.openNote.favorite ? 'Remove favorite' : 'Favorite', icon: 'star', fn: () => toggleFavorite() },
        { label: 'Duplicate note', icon: 'copy', key: 'Ctrl+D', fn: () => duplicateCurrent() },
        { label: 'Export as Markdown', icon: 'export', fn: () => exportCurrent() },
        { sep: true },
        { label: 'Ask AI about this note', icon: 'sparkle', fn: () => openAiMenu() },
        { sep: true },
        { label: 'Move to Trash', icon: 'trash', danger: true, fn: () => trashCurrent() }
      ]);
    } else {
      showMenu(e.clientX, e.clientY, [{ label: 'New note', icon: 'pencil', key: 'Ctrl+N', fn: () => createNote() }]);
    }
    return;
  }

  // ---- statusbar / anywhere else ----
  showMenu(e.clientX, e.clientY, [
    { label: 'New note', icon: 'pencil', key: 'Ctrl+N', fn: () => createNote() },
    { label: 'Quick find a note', icon: 'search', key: 'Ctrl+K', fn: () => openQuickSwitcher() },
    { sep: true },
    { label: 'Settings', icon: 'settings', key: 'Ctrl+,', fn: () => openSettings() },
    { label: 'Shortcuts', icon: 'all', key: 'Ctrl+/', fn: () => openShortcuts() }
  ]);
}

// ==================================================================
// v0.7 — QUICK SWITCHER (Ctrl+K)
// ==================================================================

let quickSwitchItems = [];

function openQuickSwitcher() {
  const root = $('#overlay-root');
  root.innerHTML = `
    <div class="overlay">
      <div class="modal" style="width:480px">
        <input type="text" id="qs-input" placeholder="Jump to a note… (type to filter, Enter to open)" spellcheck="false" autocomplete="off" />
        <div class="qs-list" id="qs-list"></div>
        <div class="modal-actions" style="justify-content:space-between">
          <span style="font-size:11px;color:var(--text-faint)">↑↓ navigate · Enter open · Esc close</span>
          <button class="btn primary" data-x="close">Close</button>
        </div>
      </div>
    </div>`;
  const done = () => closeModal();
  root.querySelector('[data-x="close"]').addEventListener('click', done);
  root.querySelector('.overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) done();
  });

  const input = root.querySelector('#qs-input');
  const list = root.querySelector('#qs-list');
  let sel = 0;

  const renderList = () => {
    const q = input.value.trim().toLowerCase();
    quickSwitchItems = state.allNotesCache
      .filter((n) => !q || (n.title || '').toLowerCase().includes(q) || (n.snippet || '').toLowerCase().includes(q))
      .slice(0, 12);
    sel = Math.min(sel, Math.max(0, quickSwitchItems.length - 1));
    if (!quickSwitchItems.length) {
      list.innerHTML = '<div class="qs-empty">No matching notes</div>';
      return;
    }
    list.innerHTML = quickSwitchItems.map((n, i) => `
      <button class="qs-item${i === sel ? ' sel' : ''}" data-i="${i}">
        <span class="qs-title">${esc(n.title.trim() || 'Untitled note')}</span>
        <span class="qs-snippet">${esc((n.snippet || '').slice(0, 60))}</span>
      </button>`).join('');
    list.querySelectorAll('.qs-item').forEach((b) => {
      b.addEventListener('click', () => pick(Number(b.dataset.i)));
    });
  };

  const pick = async (i) => {
    const n = quickSwitchItems[i];
    if (!n) return;
    closeModal();
    if (state.view.type === 'tasks' || state.view.type === 'recordings' || state.view.type === 'chat') {
      setView({ type: 'all' });
    }
    await selectNote(n.id);
  };

  input.addEventListener('input', () => { sel = 0; renderList(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = (sel + 1) % Math.max(1, quickSwitchItems.length); renderList(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = (sel - 1 + quickSwitchItems.length) % Math.max(1, quickSwitchItems.length); renderList(); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    else if (e.key === 'Escape') { e.preventDefault(); done(); }
  });
  setTimeout(() => input.focus(), 30);
  renderList();
}

// ==================================================================
// v0.6 — GUIDE
// ==================================================================

function openGuide() {
  const rows = [
    ['Basics', '<b>Ctrl+N</b> new note · <b>Ctrl+F</b> search · <b>Ctrl+K</b> jump to any note · everything autosaves as you type. <b>Right-click anywhere</b> — notes, folders, tabs, tasks, the editor, empty space — for quick actions. Drag a note onto a folder to file it. <b>Ctrl+Shift+F</b> is Zen mode — everything hides but your words.'],
    ['Slash commands', 'Type <b>/</b> at the start of an empty line in the editor — a Notion-style menu opens with headings, lists, to-dos, quotes, code, images and more. Filter by typing. At the bottom you\'ll find <b>Templates</b> — daily journal, meeting notes and weekly review, one click each.'],
    ['Images in notes', 'Paste an image straight into the editor (<b>Ctrl+V</b>), drag an image file onto the page, or use the 🖼️ button / <b>/image</b>. Images live inside your local database, render in preview, and click to zoom.'],
    ['Mention notes', 'Type <b>@</b> anywhere in a note to link another note — it becomes a [[wiki-link]]. Click one in preview to jump there. Below the editor you\'ll see <b>Linked from</b> — which notes point here.'],
    ['Board', 'Sidebar → <b>Board</b> — a Notion-style kanban. Drag cards between <b>To do · In progress · Done</b>, drop them in order, click a card to edit details in Tasks. Each column has its own + button. Card order sticks after restart.'],
    ['Tags', 'Under the editor there\'s a <b>+ tag</b> box — type a tag and press Enter. Tags show on note cards and in the sidebar; click one to filter. Backspace in the box removes the last tag.'],
    ['Find & Replace', 'Press <b>Ctrl+H</b> in any note — find with match counter, Enter/Shift+Enter to hop between matches, replace one or everything. Esc closes.'],
    ['Daily note', 'The <b>📅 Today</b> button in the list header opens (or creates) today\'s dated note, tagged <b>#daily</b> — one tidy page per day.'],
    ['Tabs', 'Open as many notes as you want — each gets a tab. Drag tabs to reorder, middle-click or × closes one. Right-click a tab to close others.'],
    ['Tasks & reminders', 'Add a task, press the ⌄ to open details: <b>due date</b>, <b>reminder</b>, <b>priority</b>, <b>repeat</b> and <b>subtasks</b>. Nook notifies you at reminder time.'],
    ['Meeting recorder', 'Sidebar → <b>Recordings</b>. Record meetings as .wav straight to this PC — no upload, no account. Start/stop never freezes the app, even if the mic is slow. Play, rename, export or delete anytime.'],
    ['AI chat & your own keys', 'Sidebar → <b>AI Chat</b>. Bring your own API key — OpenRouter, <b>Z.ai (GLM)</b>, OpenAI, Groq, Gemini, DeepSeek, Ollama, LM Studio or any custom endpoint (Settings → Nook AI). Paste your key and it saves instantly; models appear to click. The 📎 button gives the AI your current note as context. Keys stay on this PC.'],
    ['Note tools with AI', 'The ✨ button can <b>continue writing</b> where you stopped, summarize the open note, extract action items straight into Tasks, or suggest a title — through the same provider you configured.'],
    ['Markdown extras', 'Preview supports tables (<code>| a | b |</code> over <code>|---|---|</code>), <code>==highlight==</code>, <code>~~strikethrough~~</code>, checklists, code blocks and [[wiki-links]].'],
    ['Export', 'The ⬆️ button in the toolbar exports the open note as <b>Markdown</b> or as a <b>pretty web page</b> — images embedded, opens in any browser, ready to share.'],
    ['Themes', 'Settings → Look — <b>24 looks</b>, dark and light, grouped. Plus zoom, editor size/font/width/line-spacing, note density, default folder, opening view, autosave, spellcheck, trash auto-cleanup and start-with-Windows.'],
    ['Backup', 'Settings → Backup — export everything to a file and import it anywhere. Your images come along; API keys never do.'],
    ['Shortcuts', 'Press <b>Ctrl+/</b> anytime for the full list.']
  ];
  const root = $('#overlay-root');
  root.innerHTML = `
    <div class="overlay">
      <div class="modal" style="width:540px">
        <h3>${ico('book')} Nook in 2 minutes</h3>
        <div class="guide-grid">
          ${rows.map(([h, p]) => `<div class="guide-sec"><h4>${h}</h4><p>${p}</p></div>`).join('')}
        </div>
        <div class="modal-actions">
          <button class="btn primary" data-x="close">Got it</button>
        </div>
      </div>
    </div>`;
  root.querySelector('[data-x="close"]').addEventListener('click', closeModal);
  root.querySelector('.overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
}

// ------------------------------------------------------------------
// v0.10 — ONBOARDING: dreamy cloud sky, your name, your theme
// ------------------------------------------------------------------

let obStep = 0;

function obShow() {
  const ob = $('#onboarding');
  if (!ob) return;
  ob.classList.remove('hidden');
  document.body.classList.add('ob-lock');
  const grid = $('#ob-themes');
  grid.innerHTML = THEMES.map((t) => `
    <button class="ob-theme${state.settings.theme === t.id ? ' on' : ''}" data-t="${t.id}" title="${t.name}">
      <span class="ob-theme-dots"><i style="background:${t.dots[0]}"></i><i style="background:${t.dots[1]}"></i></span>
      <span>${t.name}</span>
    </button>`).join('');
  grid.querySelectorAll('.ob-theme').forEach((b) => {
    b.addEventListener('click', () => {
      state.settings.theme = b.dataset.t;
      setSetting('theme', b.dataset.t);
      applySettings();
      grid.querySelectorAll('.ob-theme').forEach((x) => x.classList.toggle('on', x === b));
    });
  });
  if (state.userName) $('#ob-name').value = state.userName;
  obGoto(0);
}

function obGoto(i) {
  obStep = i;
  const ob = $('#onboarding');
  ob.querySelectorAll('.ob-step').forEach((s) => s.classList.toggle('on', Number(s.dataset.step) === i));
  ob.querySelectorAll('.ob-progress i').forEach((d, j) => d.classList.toggle('on', j <= i));
  $('#ob-skip').classList.toggle('hidden', i === 3);
  if (i === 1) setTimeout(() => $('#ob-name').focus(), 260);
  if (i === 3) {
    $('#ob-done-title').textContent = state.userName ? `You're all set, ${state.userName}!` : "You're all set!";
  }
}

async function obDismiss({ celebrate = false } = {}) {
  const nameVal = ($('#ob-name').value || '').trim();
  if (nameVal && nameVal !== state.userName) {
    state.userName = nameVal;
    await setSetting('userName', nameVal);
  }
  await setSetting('onboarded', '1');
  const ob = $('#onboarding');
  ob.classList.add('bye');
  if (celebrate) {
    confettiBurst(window.innerWidth / 2, window.innerHeight / 2.4, 36);
    setTimeout(() => confettiBurst(window.innerWidth / 2.6, window.innerHeight / 2.1, 22), 160);
    setTimeout(() => confettiBurst(window.innerWidth / 1.6, window.innerHeight / 2.1, 22), 300);
  }
  setTimeout(() => {
    ob.classList.add('hidden');
    ob.classList.remove('bye');
    document.body.classList.remove('ob-lock');
  }, celebrate ? 620 : 420);
  applyGreeting();
  if (celebrate) {
    toast(state.userName ? `Salam, ${state.userName} — welcome to Nook!` : 'Welcome to Nook!', { icon: 'sparkle', ms: 4500 });
  }
}

function wireOnboarding() {
  const ob = $('#onboarding');
  if (!ob) return;
  ob.querySelectorAll('.ob-frog').forEach((f) => { f.innerHTML = frogSvg; });
  $('#ob-next0').addEventListener('click', () => obGoto(1));

  const nameInput = $('#ob-name');
  const next1 = $('#ob-next1');
  nameInput.addEventListener('input', () => { next1.disabled = !nameInput.value.trim(); });
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && nameInput.value.trim()) { e.preventDefault(); next1.click(); }
  });
  next1.addEventListener('click', async () => {
    state.userName = nameInput.value.trim();
    await setSetting('userName', state.userName);
    obGoto(2);
  });

  $('#ob-next2').addEventListener('click', () => obGoto(3));
  $('#ob-finish').addEventListener('click', () => obDismiss({ celebrate: true }));
  $('#ob-skip').addEventListener('click', () => obDismiss({ celebrate: false }));
}

async function maybeOnboarding() {
  const done = await call('get_setting', { key: 'onboarded' });
  if (done) return;
  obShow();
}

// ------------------------------------------------------------------ greeting row (v0.10) ----

function applyGreeting() {
  const sb = document.querySelector('.sb-bottom');
  if (!sb) return;
  let g = $('#sb-greet');
  if (!state.userName) { if (g) g.remove(); return; }
  if (!g) {
    g = document.createElement('div');
    g.id = 'sb-greet';
    sb.prepend(g);
  }
  g.innerHTML = `<div class="greet-hi">${greetingWord()},</div><div class="greet-name">${esc(state.userName)} <span class="greet-wave">👋</span></div>`;
}

// ------------------------------------------------------------------ boot ----

const WELCOME_CONTENT = `# Welcome to Nook 🐸

Your cozy little corner for notes and tasks — **100% offline**, everything stays on this PC.

## Quick tips
- Type **/** on an empty line — Notion-style commands appear
- Type **/** again for ready **templates** — daily journal, meeting notes, weekly review
- Type **@** anywhere — link another note with [[wiki-links]]
- **Paste or drop images** straight into a note
- Open many notes at once — each gets a **tab** (drag to reorder)
- **Right-click anywhere** — notes, folders, tabs, tasks, even empty space
- **Ctrl+K** jumps to any note in a heartbeat
- **Ctrl+Shift+F** = Zen mode — nothing but your words
- **Drag** a note onto a folder to file it
- Tasks have due dates, priorities, subtasks and **reminders** — tick one for confetti 🎉
- **Board** — a Notion-style kanban; drag cards across columns
- **Recordings** — record meetings straight to this PC
- **AI Chat** — add your own key (OpenRouter, Z.ai, OpenAI, Groq, Gemini…) in Settings
- **Export** any note as Markdown or as a pretty web page
- 24 themes in Settings. Press **Ctrl+/** for all shortcuts.

Cozy up and start writing. ☕`;

async function ensureWelcome() {
  const initialized = await call('get_setting', { key: 'initialized' });
  if (initialized) return;
  const note = await call('create_note', { folderId: null });
  await call('save_note', { id: note.id, title: 'Welcome to Nook 🐸', content: WELCOME_CONTENT });
  await call('set_setting', { key: 'initialized', value: '1' });
}

async function boot() {
  setIcons();
  wireTitlebar();
  wireEditor();
  wireShortcuts();
  wireReminderListener();
  wireChatView();
  wireOnboarding();

  // settings first so the theme applies before first paint of content
  await loadSettings();
  applySettings();

  await ensureWelcome();
  await refreshTasks();
  await refreshAll();

  renderTasks();
  renderTabs();
  renderStatusStats();
  applyGreeting();
  setSaveState('saved', 'Ready');
  state.bootDone = true;

  // land on the opening view chosen in Settings (v0.8)
  const dv = state.settings.defaultView;
  if ((dv === 'tasks' || dv === 'board') && state.view.type === 'all') {
    setView({ type: dv });
  } else if (dv === 'favorites' && state.stats && state.stats.favorites > 0 && state.view.type === 'all') {
    setView({ type: 'favorites' });
  }

  // land on the most recent note so the app never feels empty
  if (state.notes.length && state.view.type === 'all') {
    selectNote(state.notes[0].id);
  }

  // v0.10 — first run: the dreamy cloud get-started takes the stage
  maybeOnboarding();
}

boot().catch((err) => {
  console.error('NOOK BOOT FAILURE:', err.stack || err);
  document.body.innerHTML = `
    <div style="height:100vh;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;font-family:system-ui;color:#ece7f8;background:#171126">
      ${frogSvg}
      <h2 style="font-size:18px">Nook could not start</h2>
      <p style="font-size:13px;color:#a99cc9;max-width:420px;text-align:center;line-height:1.6">${esc(err.message)}</p>
    </div>`;
});
