// Nook — main application logic.

import { call, IS_TAURI } from './api.js';
import { renderMarkdown } from './markdown.js';
import { frogSvg, ico, setIcons } from './art.js';

const $ = (sel) => document.querySelector(sel);

const state = {
  folders: [],
  folderCountMap: {},   // folderId -> live note count
  notes: [],            // summaries for the current view
  tasks: [],
  stats: null,
  view: { type: 'all' }, // all | favorites | trash | folder | tasks | search
  sort: localStorage.getItem('nook.sort') || 'updated',
  currentNoteId: null,
  openNote: null,       // full note object being edited
  preview: false,
  query: '',
  settings: { theme: 'dark', fontSize: '15' },
  saveTimer: null,
  saving: false,
  bootDone: false
};

// ------------------------------------------------------------------ utils ----

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = startOfDay(now) - startOfDay(d);
  if (diff <= 0) return 'Today';
  if (diff <= 86400000) return 'Yesterday';
  if (diff < 7 * 86400000) return d.toLocaleDateString(undefined, { weekday: 'short' });
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

function toast(msg, opts = {}) {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.innerHTML = `<span class="t-ico">${ico('check')}</span><span>${esc(msg)}</span>`;
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

function wireTitlebar() {
  const w = () => window.__TAURI_WINDOW__ || null;
  const min = $('#win-min');
  const max = $('#win-max');
  const close = $('#win-close');

  const updateMaxIcon = async () => {
    if (!IS_TAURI) return;
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      const isMax = await win.isMaximized();
      max.querySelector('.ico-max').classList.toggle('hidden', isMax);
      max.querySelector('.ico-restore').classList.toggle('hidden', !isMax);
    } catch {
      /* non-tauri or early boot */
    }
  };
  window.__nookUpdateMax = updateMaxIcon;
  updateMaxIcon();

  min.addEventListener('click', async () => {
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().minimize();
  });

  max.addEventListener('click', async () => {
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.toggleMaximize();
    setTimeout(updateMaxIcon, 120);
  });

  close.addEventListener('click', async () => {
    if (!IS_TAURI) return;
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().close();
  });

  if (IS_TAURI) {
    import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      window.__TAURI_WINDOW__ = getCurrentWindow();
      getCurrentWindow().onResized(() => updateMaxIcon());
    });
  }

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
  $('#btn-preview').innerHTML = ico('eye');
  $('#btn-preview').classList.toggle('on', state.preview);
  $('#btn-export').innerHTML = ico('export');
  $('#btn-trash').innerHTML = ico('trash');

  ['#btn-pin', '#btn-fav', '#btn-preview', '#btn-export', '#btn-trash'].forEach((s) => {
    $(s).style.display = editable ? '' : 'none';
  });
  $('.ed-folder-wrap').style.display = editable ? '' : 'none';
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
}

function updateWordCount() {
  if (!state.openNote) {
    $('#stats-right').textContent = '';
    return;
  }
  const text = state.openNote.content;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const chars = text.length;
  $('#stats-right').textContent = `${words} words · ${chars} chars`;
}

// ------------------------------------------------------------------ tasks ----

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

  const list = $('#tv-list');
  if (!total) {
    list.innerHTML = `<div class="tv-empty">${frogSvg}<div>Nothing to do — enjoy the quiet. ☕</div></div>`;
  } else {
    list.innerHTML = state.tasks
      .map(
        (t) => `
      <li class="tv-item${t.done ? ' done' : ''}" data-tid="${esc(t.id)}">
        <button class="tv-check" title="Toggle">${ico('check')}</button>
        <span class="tv-title">${esc(t.title)}</span>
        <button class="tv-del" title="Delete task">&times;</button>
      </li>`
      )
      .join('');

    list.querySelectorAll('.tv-item').forEach((item) => {
      const tid = item.dataset.tid;
      item.querySelector('.tv-check').addEventListener('click', async () => {
        const t = state.tasks.find((x) => x.id === tid);
        await call('set_task', { id: tid, done: !t.done });
        t.done = !t.done;
        state.tasks.sort((x, y) => (x.done - y.done) || (x.position - y.position));
        renderTasks();
        refreshStatsOnly();
      });
      item.querySelector('.tv-del').addEventListener('click', async () => {
        await call('delete_task', { id: tid });
        state.tasks = state.tasks.filter((x) => x.id !== tid);
        renderTasks();
        refreshStatsOnly();
      });
    });
  }

  $('#btn-clear-done').classList.toggle('hidden', done === 0);
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
    $('#stats-right').textContent =
      `${state.stats.notes} notes · ${state.stats.openTasks} open tasks`;
  }
}

function setView(view, opts = {}) {
  state.view = view;
  if (view.type !== 'search') {
    // leaving search clears the box
    const inp = $('#search-input');
    if (!opts.keepQuery) {
      // keep input text if we're entering search, clear when leaving
      if (view.type !== 'search' && state.query && !opts.fromSearch) {
        // no-op: input stays as typed until Esc
      }
    }
  }
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

// -------- autosave --------

function queueSave() {
  if (!state.openNote) return;
  state.openNote.title = $('#ed-title').value;
  state.openNote.content = $('#ed-text').value;
  updateWordCount();
  setSaveState('saving', 'Saving…');
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(flushSave, 450);
}

async function flushSave() {
  clearTimeout(state.saveTimer);
  const n = state.openNote;
  if (!n) return;
  const title = $('#ed-title').value;
  const content = $('#ed-text').value;
  if (n.title === title && n.content === content && !state.saving) {
    return;
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
  root.innerHTML = `
    <div class="overlay">
      <div class="modal" style="width:480px">
        <h3>Settings</h3>
        <div class="set-row">
          <div>
            <div class="set-label">Theme</div>
            <div class="set-sub">Cozy Midnight or Paper Light.</div>
          </div>
          <div class="seg" id="seg-theme">
            <button data-v="dark" class="${theme !== 'light' ? 'on' : ''}">Cozy Midnight</button>
            <button data-v="light" class="${theme === 'light' ? 'on' : ''}">Paper Light</button>
          </div>
        </div>
        <div class="set-row">
          <div>
            <div class="set-label">Editor text size</div>
            <div class="set-sub">Comfortable reading, your call.</div>
          </div>
          <div class="seg" id="seg-font">
            ${['14', '15', '16', '18'].map((v) => `<button data-v="${v}" class="${fs === v ? 'on' : ''}">${v}px</button>`).join('')}
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
          <div class="ab-text"><b>Nook v0.4.0</b> — a real native desktop app.<br>Rust + Tauri · SQLite · 100% offline. Made cozy for Mr Real 🐸</div>
        </div>
        <div class="modal-actions">
          <button class="btn primary" data-x="close">Done</button>
        </div>
      </div>
    </div>`;

  const done = () => closeModal();
  root.querySelector('[data-x="close"]').addEventListener('click', done);
  root.querySelector('.overlay').addEventListener('mousedown', (e) => {
    if (e.target === e.currentTarget) done();
  });
  root.querySelector('#btn-open-data').addEventListener('click', () => call('reveal_data_dir'));

  root.querySelectorAll('#seg-theme button').forEach((b) => {
    b.addEventListener('click', async () => {
      state.settings.theme = b.dataset.v;
      root.querySelectorAll('#seg-theme button').forEach((x) => x.classList.toggle('on', x === b));
      await call('set_setting', { key: 'theme', value: b.dataset.v });
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
}

function applySettings() {
  document.body.classList.toggle('light', state.settings.theme === 'light');
  document.documentElement.style.setProperty('--font-size', `${state.settings.fontSize}px`);
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
      case 's':
        e.preventDefault();
        flushSave().then(() => toast('Saved'));
        break;
      default:
        break;
    }
  });
}

// ------------------------------------------------------------------ boot ----

const WELCOME_CONTENT = `# Welcome to Nook 🐸

Your cozy little corner for notes and tasks — **100% offline**, everything stays on this PC.

## Quick tips
- Press **Ctrl+N** to start a new note
- **Ctrl+F** searches every note instantly
- Hit the **pin** to keep a note on top, the **star** to favorite it
- Everything **auto-saves** while you type — no save button needed

## What's inside
- **Notes** — write in Markdown, tap the eye to preview
- **Folders** — keep things tidy from the sidebar
- **Tasks** — your little to-do desk
- **Trash** — deleted notes rest here until you empty it

Cozy up and start writing. ☕`;

async function ensureWelcome() {
  const initialized = await call('get_setting', { key: 'initialized' });
  if (initialized) return;
  const note = await call('create_note', { folderId: null });
  await call('save_note', { id: note.id, title: 'Welcome to Nook 🐸', content: WELCOME_CONTENT });
  await call('set_setting', { key: 'initialized', value: '1' });
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

  // tasks
  $('#tv-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#tv-input');
    const title = input.value.trim();
    if (!title) return;
    await call('create_task', { title });
    input.value = '';
    await refreshTasks();
    renderTasks();
    refreshStatsOnly();
  });
  $('#btn-clear-done').addEventListener('click', async () => {
    await call('clear_done_tasks');
    await refreshTasks();
    renderTasks();
    refreshStatsOnly();
  });

  // flush pending save when the window loses focus / closes
  window.addEventListener('blur', () => {
    if (state.saving) return;
    flushSave();
  });
  window.addEventListener('beforeunload', () => {
    if (state.openNote) {
      const title = $('#ed-title').value;
      const content = $('#ed-text').value;
      if (state.openNote.title !== title || state.openNote.content !== content) {
        // fire and forget — best effort on close
        call('save_note', { id: state.openNote.id, title, content });
      }
    }
  });
}

async function boot() {
  setIcons();
  wireTitlebar();
  wireEditor();
  wireShortcuts();

  // settings first so the theme applies before first paint of content
  state.settings.theme = (await call('get_setting', { key: 'theme' })) || 'dark';
  state.settings.fontSize = (await call('get_setting', { key: 'fontSize' })) || '15';
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
