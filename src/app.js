// Nook — main application logic.
// v0.5: fixed window dragging, real task manager (due dates, priorities,
// subtasks, repeat, reminders), 8 themes, realtime autosave, backup,
// markdown toolbar, close-to-tray.

import { call, IS_TAURI } from './api.js';
import { renderMarkdown } from './markdown.js';
import { frogSvg, ico, setIcons } from './art.js';

const $ = (sel) => document.querySelector(sel);
const DAY = 86400000;

const THEMES = [
  { id: 'midnight', name: 'Cozy Midnight', dots: ['#171126', '#8fe3a0'], light: false },
  { id: 'oled',     name: 'OLED Black',    dots: ['#000000', '#3ddc97'], light: false },
  { id: 'forest',   name: 'Forest Night',  dots: ['#0f1a13', '#7ddb8a'], light: false },
  { id: 'ocean',    name: 'Ocean Deep',    dots: ['#0c1726', '#5ec8f8'], light: false },
  { id: 'sunset',   name: 'Sunset Ember',  dots: ['#211318', '#ff9e7d'], light: false },
  { id: 'paper',    name: 'Paper Light',   dots: ['#f5f2ea', '#379d55'], light: true },
  { id: 'sepia',    name: 'Warm Sepia',    dots: ['#f4ecdc', '#a4762e'], light: true },
  { id: 'mint',     name: 'Mint Day',      dots: ['#eef6f0', '#2f9e6e'], light: true }
];
const LIGHT_THEMES = THEMES.filter((t) => t.light).map((t) => t.id);

const PRIO_LABEL = ['', 'Low', 'Medium', 'High'];
const REPEAT_LABEL = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

const state = {
  folders: [],
  folderCountMap: {},   // folderId -> live note count
  notes: [],            // summaries for the current view
  tasks: [],
  stats: null,
  view: { type: 'all' }, // all | favorites | trash | folder | tasks | search
  sort: localStorage.getItem('nook.sort') || 'updated',
  taskFilter: localStorage.getItem('nook.taskFilter') || 'all',
  taskSort: localStorage.getItem('nook.taskSort') || 'manual',
  expandedTask: null,
  currentNoteId: null,
  openNote: null,       // full note object being edited
  preview: false,
  query: '',
  settings: { theme: 'midnight', fontSize: '15', editorFont: 'sans', closeToTray: '0' },
  saveTimer: null,
  taskSaveTimer: null,
  saving: false,
  bootDone: false
};

// The keystrokes typed since the last completed save. queueSave() fills it,
// flushSave() persists it and clears it. NEVER compare the DB copy against
// the DOM after mutating it first — that made v0.4 autosave a no-op.
let pending = null;

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
  { type: 'trash', label: 'Trash', icon: 'trash' }
];

function renderSidebar() {
  const s = state.stats || { notes: 0, favorites: 0, openTasks: 0, trash: 0 };

  const viewsEl = $('#sb-views');
  viewsEl.innerHTML = VIEW_META.map((v) => {
    const active = state.view.type === v.type ? ' active' : '';
    const count = v.type === 'all' ? s.notes : v.type === 'favorites' ? s.favorites : v.type === 'tasks' ? s.openTasks : s.trash;
    const showCount = v.type !== 'tasks' || s.openTasks > 0;
    return `
      <button class="sb-row${active}" data-view="${v.type}">
        <span class="sb-ico">${ico(v.icon)}</span>
        <span class="sb-name">${v.label}</span>
        ${showCount ? `<span class="sb-count">${count}</span>` : ''}
      </button>`;
  }).join('');

  viewsEl.querySelectorAll('[data-view]').forEach((el) => {
    el.addEventListener('click', () => setView({ type: el.dataset.view }));
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
  switch (state.view.type) {
    case 'favorites': return 'Favorites';
    case 'trash': return 'Trash';
    case 'tasks': return 'Tasks';
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
  $('#nl-count').textContent = state.view.type === 'tasks' ? '' : `${state.notes.length}`;
  $('#nl-sort').value = state.sort;
  $('#nl-sort').style.display = state.view.type === 'tasks' ? 'none' : '';
  const emptyBtn = $('#btn-empty-trash');
  emptyBtn.classList.toggle('hidden', !(state.view.type === 'trash' && state.notes.length > 0));
}

function renderNoteList() {
  renderListHeader();
  const el = $('#nl-items');

  if (state.view.type === 'tasks') {
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
    .map((n) => {
      const selected = n.id === state.currentNoteId ? ' selected' : '';
      const folder = state.folders.find((f) => f.id === n.folderId);
      const flags = [];
      if (n.pinned) flags.push(`<span class="f-pin" title="Pinned">${ico('pin')}</span>`);
      if (n.favorite) flags.push(`<span class="f-fav" title="Favorite">${ico('starFill')}</span>`);
      const titleText = n.title.trim() || 'Untitled note';
      return `
      <div class="note-card${selected}" data-nid="${esc(n.id)}">
        <div class="nc-title">${esc(titleText)}${
          flags.length ? `<span class="nc-flags">${flags.join('')}</span>` : ''
        }</div>
        <div class="nc-snippet">${esc(n.snippet || 'No content yet')}</div>
        <div class="nc-meta">
          <span>${fmtDate(n.updatedAt)}</span>
          ${folder ? `<span>·</span><span class="nc-folder-name">${esc(folder.name)}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  el.querySelectorAll('.note-card').forEach((card) => {
    card.addEventListener('click', () => selectNote(card.dataset.nid));
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
  $('#btn-preview').innerHTML = ico('eye');
  $('#btn-preview').classList.toggle('on', state.preview);
  $('#btn-export').innerHTML = ico('export');
  $('#btn-trash').innerHTML = ico('trash');

  ['#btn-pin', '#btn-fav', '#btn-duplicate', '#btn-preview', '#btn-export', '#btn-trash'].forEach((s) => {
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
  applyPreviewMode();
  updateWordCount();
}

function applyPreviewMode() {
  const showPreview = state.preview;
  $('#ed-text').classList.toggle('hidden', showPreview);
  const pv = $('#ed-preview');
  pv.classList.toggle('hidden', !showPreview);
  if (showPreview) pv.innerHTML = renderMarkdown(state.openNote ? state.openNote.content : '');
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
  } else {
    // line-prefix actions: h1, h2, ul, check, quote
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e);
    if (le === -1) le = v.length;
    const block = v.slice(ls, le);
    const prefix = { h1: '# ', h2: '## ', ul: '- ', check: '- [ ] ', quote: '> ' }[kind] || '';
    const lines = block.split('\n').map((l) => prefix + l.replace(/^(#{1,4} |> |- \[[ xX]\] |- )/, ''));
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

  item.querySelector('.tv-check').addEventListener('click', async () => {
    const task = t();
    if (!task) return;
    try {
      const res = await call('set_task', { id: tid, done: !task.done });
      const idx = state.tasks.findIndex((x) => x.id === tid);
      if (idx !== -1 && res) state.tasks[idx] = res;
      if (res && !task.done && task.repeat !== 'none' && res.done === false) {
        toast(`Repeats ${task.repeat} — next: ${dueLabel(res.dueAt) || 'scheduled'}`, { icon: 'repeat' });
      }
      renderTasks();
      refreshStatsOnly();
    } catch (err) {
      toast('Could not update task: ' + err.message);
    }
  });

  item.querySelector('.tv-del').addEventListener('click', async () => {
    await call('delete_task', { id: tid });
    if (state.expandedTask === tid) state.expandedTask = null;
    state.tasks = state.tasks.filter((x) => x.id !== tid);
    renderTasks();
    refreshStatsOnly();
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
  if (state.view.type === 'search') {
    state.notes = await call('list_notes', {
      view: 'all',
      query: state.query.trim()
    });
  } else if (state.view.type === 'folder') {
    state.notes = await call('list_notes', {
      view: 'folder',
      folderId: state.view.folderId,
      sort: state.sort
    });
  } else {
    state.notes = await call('list_notes', { view: state.view.type, sort: state.sort });
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
  if (view.type === 'tasks') {
    state.currentNoteId = null;
    state.openNote = null;
  }
  renderSidebar();
  refreshNotes().then(() => {
    renderNoteList();
    if (view.type === 'tasks') {
      renderTasks();
    } else {
      $('#tasks-view').classList.add('hidden');
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
  renderNoteList();
  renderEditor();
  renderStatusStats();
  setSaveState('saved', 'Saved');
  $('#ed-title').focus();
}

async function createNote() {
  await flushSave();
  const folderId = state.view.type === 'folder' ? state.view.folderId : null;
  const note = await call('create_note', { folderId });
  state.openNote = note;
  state.currentNoteId = note.id;
  state.preview = false;
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
  setSaveState('saving', 'Saving…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 250);
}

async function flushSave() {
  clearTimeout(state.saveTimer);
  const n = state.openNote;
  if (!n || !pending) return;
  const { title, content } = pending;
  pending = null;
  if (n.title === title && n.content === content) {
    return; // nothing new since the last save
  }
  n.title = title;
  n.content = content;
  state.saving = true;
  try {
    await call('save_note', { id: n.id, title, content });
  } catch (err) {
    setSaveState('error', 'Save failed');
    toast('Could not save: ' + err.message);
    state.saving = false;
    return;
  }
  state.saving = false;

  // sync summary in the list
  const s = state.notes.find((x) => x.id === n.id);
  if (s) {
    s.title = title;
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
    renderNoteList();
  } else {
    refreshNotes().then(renderNoteList);
  }
  setSaveState('saved', 'Saved');
  renderStatusStats();
}

// ------------------------------------------------------------------ actions ----

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
  state.notes = state.notes.filter((x) => x.id !== n.id);
  state.currentNoteId = null;
  state.openNote = null;
  renderNoteList();
  renderEditor();
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
  state.notes = state.notes.filter((x) => x.id !== n.id);
  state.currentNoteId = null;
  state.openNote = null;
  renderNoteList();
  renderEditor();
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
  await call('empty_trash');
  state.currentNoteId = null;
  state.openNote = null;
  await refreshAll();
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

async function openSettings() {
  const dataPath = await call('data_dir');
  const root = $('#overlay-root');
  const theme = state.settings.theme;
  const fs = state.settings.fontSize;
  const ef = state.settings.editorFont;
  const ctt = state.settings.closeToTray === '1';

  root.innerHTML = `
    <div class="overlay">
      <div class="modal wide">
        <h3>Settings</h3>

        <div class="set-row" style="display:block">
          <div class="set-label">Theme</div>
          <div class="set-sub">Eight cozy looks — pick your mood.</div>
          <div class="theme-grid" id="theme-grid">
            ${THEMES.map((t) => `
              <button class="theme-chip${theme === t.id ? ' on' : ''}" data-t="${t.id}" title="${t.name}">
                <span class="theme-dots"><i style="background:${t.dots[0]}"></i><i style="background:${t.dots[1]}"></i></span>
                <span class="t-name">${t.name}</span>
              </button>`).join('')}
          </div>
        </div>

        <div class="set-row">
          <div>
            <div class="set-label">Editor text size</div>
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
            <div class="set-label">Backup</div>
            <div class="set-sub">Save everything to a file, or restore it on another PC.</div>
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
          <div class="ab-text"><b>Nook v0.5.0</b> — a real native desktop app.<br>Rust + Tauri · SQLite · 100% offline. Made cozy for Mr Real 🐸</div>
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

  root.querySelectorAll('#theme-grid .theme-chip').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.theme = b.dataset.t;
      root.querySelectorAll('#theme-grid .theme-chip').forEach((x) => x.classList.toggle('on', x === b));
      await call('set_setting', { key: 'theme', value: b.dataset.t });
      applySettings();
    });
  });

  root.querySelectorAll('#seg-font button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.fontSize = b.dataset.v;
      root.querySelectorAll('#seg-font button').forEach((x) => x.classList.toggle('on', x === b));
      await call('set_setting', { key: 'fontSize', value: b.dataset.v });
      applySettings();
    });
  });

  root.querySelectorAll('#seg-edfont button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.editorFont = b.dataset.v;
      root.querySelectorAll('#seg-edfont button').forEach((x) => x.classList.toggle('on', x === b));
      await call('set_setting', { key: 'editorFont', value: b.dataset.v });
      applySettings();
    });
  });

  root.querySelector('#set-ctt').addEventListener('change', async (e) => {
    state.settings.closeToTray = e.target.checked ? '1' : '0';
    await call('set_setting', { key: 'closeToTray', value: state.settings.closeToTray });
    toast(e.target.checked ? 'Nook will hide to the tray' : 'Nook will quit when closed');
  });

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
    ['Save now', 'Ctrl + S'],
    ['Preview markdown', 'Ctrl + E'],
    ['Bold / Italic', 'Ctrl + B / I'],
    ['Duplicate note', 'Ctrl + D'],
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
  state.settings.closeToTray = (await call('get_setting', { key: 'closeToTray' })) || '0';
}

function applySettings() {
  const t = LIGHT_THEMES.includes(state.settings.theme) ? state.settings.theme : state.settings.theme;
  document.body.dataset.theme = t;
  document.body.classList.toggle('light', LIGHT_THEMES.includes(t));
  document.documentElement.style.setProperty('--font-size', `${state.settings.fontSize}px`);
  document.body.dataset.edfont = state.settings.editorFont || 'sans';
}

// ------------------------------------------------------------------ shortcuts ----

function wireShortcuts() {
  window.addEventListener('keydown', (e) => {
    const ctrl = e.ctrlKey || e.metaKey;
    if (!ctrl) {
      if (e.key === 'Escape') {
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
      case '/':
        e.preventDefault();
        openShortcuts();
        break;
      case '\\':
        e.preventDefault();
        document.body.classList.toggle('zen');
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
  $('#btn-pin').addEventListener('click', togglePin);
  $('#btn-fav').addEventListener('click', toggleFavorite);
  $('#btn-duplicate').addEventListener('click', duplicateCurrent);
  $('#btn-trash').addEventListener('click', trashCurrent);
  $('#btn-restore').addEventListener('click', restoreCurrent);
  $('#btn-purge').addEventListener('click', purgeCurrent);
  $('#btn-export').addEventListener('click', exportCurrent);
  $('#btn-preview').addEventListener('click', () => {
    state.preview = !state.preview;
    applyPreviewMode();
    renderEditorToolbar();
  });
  $('#ed-folder').addEventListener('change', (e) => moveCurrentNote(e.target.value || null));
  $('#ed-preview').addEventListener('click', (e) => {
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
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-empty-trash').addEventListener('click', emptyTrash);

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

// ------------------------------------------------------------------ boot ----

const WELCOME_CONTENT = `# Welcome to Nook 🐸

Your cozy little corner for notes and tasks — **100% offline**, everything stays on this PC.

## Quick tips
- Press **Ctrl+N** to start a new note, **Ctrl+F** to search
- **Tasks** now have due dates, priorities, checklists and repeat
- Set a **reminder** on any task — Nook will notify you
- Try the **8 themes** in Settings (Ctrl+,)

## What's inside
- **Notes** — Markdown with a formatting toolbar, pin, favorite, duplicate
- **Folders** — keep things tidy from the sidebar
- **Tasks** — due dates, priorities, subtasks, repeat, reminders
- **Backup** — export/import everything as a file
- **Trash** — deleted notes rest here until you empty it

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

  // settings first so the theme applies before first paint of content
  await loadSettings();
  applySettings();

  await ensureWelcome();
  await refreshTasks();
  await refreshAll();

  renderTasks();
  renderStatusStats();
  setSaveState('saved', 'Ready');
  state.bootDone = true;

  // land on the most recent note so the app never feels empty
  if (state.notes.length && state.view.type === 'all') {
    selectNote(state.notes[0].id);
  }
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
