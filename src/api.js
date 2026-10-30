// Tauri IPC layer with an in-browser mock so the UI can be previewed
// (and tested) outside the desktop shell.

import { invoke } from '@tauri-apps/api/core';

export const IS_TAURI =
  typeof window !== 'undefined' &&
  ('__TAURI_INTERNALS__' in window || '__TAURI__' in window);

// ------------------------------------------------------------ mock store ----

let mock = null;

// Images live on `window` so every module instance (and every vite HMR
// generation) sees the same store in the browser preview.
function mockImages() {
  if (!window.__nookMockImages) window.__nookMockImages = {};
  return window.__nookMockImages;
}

function seedMock() {
  const now = Date.now();
  const day = 86400000;
  mock = {
    folders: [
      { id: 'fol-1', name: 'Personal', createdAt: now - 900000, position: 1 },
      { id: 'fol-2', name: 'Work', createdAt: now - 800000, position: 2 },
      { id: 'fol-3', name: 'Ideas', createdAt: now - 700000, position: 3 }
    ],
    notes: [
      {
        id: 'note-1', folderId: 'fol-2', title: 'Nook v0.4 — release notes',
        content:
`# Nook v0.4

The whole app is now **native Rust** — no servers, no waiting.

- Starts instantly
- Everything saved in a local SQLite database
- Works fully offline`,
        pinned: true, favorite: true, trashed: false,
        createdAt: now - 3600000, updatedAt: now - 120000
      },
      {
        id: 'note-2', folderId: null, title: 'Grocery list',
        content: '- eggs\n- chai leaves\n- tomatoes\n- biscuits for the frog',
        pinned: false, favorite: false, trashed: false,
        createdAt: now - 2 * day, updatedAt: now - day
      },
      {
        id: 'note-3', folderId: 'fol-3', title: 'App ideas',
        content: '1. A tiny pomodoro frog\n2. Markdown slides\n3. habit tracker with stars',
        pinned: false, favorite: true, trashed: false,
        createdAt: now - 5 * day, updatedAt: now - 3 * day
      },
      {
        id: 'note-4', folderId: 'fol-1', title: 'Old draft',
        content: 'delete me someday',
        pinned: false, favorite: false, trashed: true,
        createdAt: now - 9 * day, updatedAt: now - 6 * day
      }
    ],
    tasks: [
      {
        id: 'task-1', title: 'Water the plants', notes: '', done: false, priority: 1,
        dueAt: now + 3600000, remindAt: now + 1800000, repeat: 'daily', status: 0,
        subtasks: [
          { id: 's1', title: 'Balcony pots', done: true },
          { id: 's2', title: 'Fern', done: false }
        ],
        reminded: false, position: 1, createdAt: now - 400000, completedAt: null
      },
      {
        id: 'task-2', title: 'Ship the new release', notes: 'Tag the repo, check CI, upload to Gofile.',
        done: true, priority: 3, dueAt: now - 7200000, remindAt: null, repeat: 'none', status: 2,
        subtasks: [], reminded: true, position: 2, createdAt: now - 380000, completedAt: now - 600000
      },
      {
        id: 'task-3', title: 'Call the electrician', notes: '', done: false, priority: 2,
        dueAt: now - 86400000, remindAt: null, repeat: 'none', subtasks: [], status: 1,
        reminded: false, position: 3, createdAt: now - 300000, completedAt: null
      }
    ],
    settings: { theme: 'midnight', fontSize: '15', editorFont: 'sans', editorWidth: 'normal', closeToTray: '0', autosave: '1', spellcheck: '0', density: 'cozy', defaultFolder: '', initialized: '1', edLine: '1.6', defaultView: 'all', zoom: '100', trashDays: '0' },
    stats: { notes: 3, favorites: 2, openTasks: 2, folders: 3, trash: 1 },
    recordings: [
      { name: 'rec-20261029-101500.wav', path: 'C:\\recordings\\rec-20261029-101500.wav', bytes: 1875000, durationMs: 93500, createdAt: now - 86400000 },
      { name: 'rec-20261028-154500.wav', path: 'C:\\recordings\\rec-20261028-154500.wav', bytes: 945000, durationMs: 47000, createdAt: now - 2 * 86400000 }
    ],
    recTimerStart: null,
    boardFilter: 'all'
  };
}

function mockSnippet(content) {
  const flat = content.replace(/[\n\r\t]/g, ' ');
  const squeezed = flat.split(/\s+/).join(' ');
  return squeezed.length > 180 ? squeezed.slice(0, 180) + '…' : squeezed;
}

function mockStats() {
  mock.stats = {
    notes: mock.notes.filter((n) => !n.trashed).length,
    favorites: mock.notes.filter((n) => !n.trashed && n.favorite).length,
    openTasks: mock.tasks.filter((t) => !t.done).length,
    folders: mock.folders.length,
    trash: mock.notes.filter((n) => n.trashed).length
  };
  return { ...mock.stats };
}

function mockCall(cmd, args) {
  if (!mock) seedMock();
  const a = args || {};
  switch (cmd) {
    case 'list_folders':
      return Promise.resolve([...mock.folders].sort((x, y) => x.position - y.position));
    case 'create_folder': {
      const f = {
        id: 'fol-' + Date.now(),
        name: (a.name || '').trim(),
        createdAt: Date.now(),
        position: mock.folders.length + 1
      };
      mock.folders.push(f);
      return Promise.resolve({ ...f });
    }
    case 'rename_folder': {
      const f = mock.folders.find((x) => x.id === a.id);
      if (f) f.name = (a.name || '').trim();
      return Promise.resolve();
    }
    case 'delete_folder':
      mock.notes.forEach((n) => { if (n.folderId === a.id) n.folderId = null; });
      mock.folders = mock.folders.filter((f) => f.id !== a.id);
      return Promise.resolve();
    case 'folder_counts': {
      const counts = {};
      mock.notes.forEach((n) => {
        if (!n.trashed && n.folderId) counts[n.folderId] = (counts[n.folderId] || 0) + 1;
      });
      return Promise.resolve(Object.entries(counts).map(([id, c]) => [id, c]));
    }
    case 'list_notes': {
      let list = mock.notes.slice();
      const q = (a.query || '').trim().toLowerCase();
      if (q) {
        list = list.filter(
          (n) => !n.trashed &&
            (n.title.toLowerCase().includes(q) || n.content.toLowerCase().includes(q))
        );
      } else if (a.view === 'favorites') {
        list = list.filter((n) => !n.trashed && n.favorite);
      } else if (a.view === 'trash') {
        list = list.filter((n) => n.trashed);
      } else if (a.view === 'folder') {
        list = list.filter((n) => !n.trashed && n.folderId === (a.folderId || null));
      } else {
        list = list.filter((n) => !n.trashed);
      }
      if (a.tag) {
        list = list.filter((n) => (n.tags || []).includes(a.tag));
      }
      const sort = a.sort || 'updated';
      list.sort((x, y) => {
        if (x.pinned !== y.pinned) return x.pinned ? -1 : 1;
        if (sort === 'created') return y.createdAt - x.createdAt;
        if (sort === 'alpha') return x.title.localeCompare(y.title);
        return y.updatedAt - x.updatedAt;
      });
      return Promise.resolve(
        list.map((n) => ({
          id: n.id, folderId: n.folderId, title: n.title,
          snippet: mockSnippet(n.content), pinned: n.pinned, favorite: n.favorite,
          trashed: n.trashed, createdAt: n.createdAt, updatedAt: n.updatedAt,
          tags: JSON.stringify(n.tags || [])
        }))
      );
    }
    case 'get_note': {
      const n = mock.notes.find((x) => x.id === a.id);
      return Promise.resolve(n ? { ...n } : null);
    }
    case 'create_note': {
      const n = {
        id: 'note-' + Date.now(), folderId: a.folderId || null, title: '', content: '',
        pinned: false, favorite: false, trashed: false,
        createdAt: Date.now(), updatedAt: Date.now()
      };
      mock.notes.unshift(n);
      return Promise.resolve({ ...n });
    }
    case 'duplicate_note': {
      const src = mock.notes.find((x) => x.id === a.id);
      if (!src) return Promise.resolve(null);
      const n = {
        id: 'note-' + Date.now(), folderId: src.folderId, title: src.title + ' (copy)',
        content: src.content, pinned: false, favorite: false, trashed: false,
        createdAt: Date.now(), updatedAt: Date.now()
      };
      mock.notes.unshift(n);
      return Promise.resolve({ ...n });
    }
    case 'save_note': {
      const n = mock.notes.find((x) => x.id === a.id);
      if (n) {
        n.title = a.title;
        n.content = a.content;
        n.updatedAt = Date.now();
        if (a.tags) {
          try { n.tags = JSON.parse(a.tags); } catch { /* keep old */ }
        }
      }
      return Promise.resolve();
    }
    case 'pin_note': {
      const n = mock.notes.find((x) => x.id === a.id);
      if (n) n.pinned = !!a.pinned;
      return Promise.resolve();
    }
    case 'favorite_note': {
      const n = mock.notes.find((x) => x.id === a.id);
      if (n) n.favorite = !!a.favorite;
      return Promise.resolve();
    }
    case 'move_note': {
      const n = mock.notes.find((x) => x.id === a.id);
      if (n) { n.folderId = a.folderId || null; n.updatedAt = Date.now(); }
      return Promise.resolve();
    }
    case 'trash_note': {
      const n = mock.notes.find((x) => x.id === a.id);
      if (n) { n.trashed = !!a.trashed; n.updatedAt = Date.now(); }
      return Promise.resolve();
    }
    case 'delete_note_forever':
      mock.notes = mock.notes.filter((x) => x.id !== a.id);
      return Promise.resolve();
    case 'empty_trash':
      mock.notes = mock.notes.filter((x) => !x.trashed);
      return Promise.resolve();
    case 'list_tasks':
      return Promise.resolve(mock.tasks.slice().sort((x, y) => (x.done - y.done) || (x.position - y.position)));
    case 'insert_note_image': {
      const id = 'img-' + Date.now().toString(36) + Math.floor(Math.random() * 999);
      mockImages()[id] = { mime: a.mime, name: a.name || 'image', dataUrl: `data:${a.mime};base64,${a.data}`, noteId: a.noteId, createdAt: Date.now(), bytes: Math.round((a.data || '').length * 0.75) };
      return Promise.resolve({ id, noteId: a.noteId, mime: a.mime, name: a.name || 'image', bytes: mockImages()[id].bytes, createdAt: Date.now() });
    }
    case 'delete_note_image':
      delete mockImages()[a.id];
      return Promise.resolve();
    case 'note_images':
      return Promise.resolve(Object.entries(mockImages()).filter(([, v]) => v.noteId === a.noteId).map(([id, v]) => ({ id, noteId: v.noteId, mime: v.mime, name: v.name, bytes: v.bytes, createdAt: v.createdAt })));
    case 'get_note_image_data': {
      const im = mockImages()[a.id];
      if (!im) return Promise.resolve(null);
      const b64 = (im.dataUrl || '').split(',')[1] || '';
      return Promise.resolve({ mime: im.mime, data: b64 });
    }
    case 'note_backlinks': {
      const me = mock.notes.find((x) => x.id === a.id);
      if (!me) return Promise.resolve([]);
      const t = (me.title || '').trim();
      if (!t) return Promise.resolve([]);
      return Promise.resolve(
        mock.notes
          .filter((n) => n.id !== a.id && !n.trashed && (n.content || '').includes(`[[${t}]]`))
          .map((n) => ({ id: n.id, folderId: n.folderId, title: n.title, snippet: mockSnippet(n.content), pinned: n.pinned, favorite: n.favorite, trashed: n.trashed, createdAt: n.createdAt, updatedAt: n.updatedAt, tags: JSON.stringify(n.tags || []) }))
      );
    }
    case 'create_task': {
      const t = {
        id: 'task-' + Date.now(), title: (a.title || '').trim(), notes: '',
        done: (a.status || 0) === 2, priority: a.priority || 0, dueAt: a.dueAt || null,
        remindAt: a.remindAt || null, repeat: 'none', subtasks: [],
        status: a.status || 0,
        reminded: false, position: mock.tasks.length + 1,
        createdAt: Date.now(), completedAt: (a.status || 0) === 2 ? Date.now() : null
      };
      mock.tasks.push(t);
      return Promise.resolve({ ...t });
    }
    case 'update_task': {
      const t = mock.tasks.find((x) => x.id === a.id);
      if (!t) return Promise.reject(new Error('task not found'));
      if (a.title !== undefined) t.title = a.title;
      if (a.notes !== undefined) t.notes = a.notes;
      if (a.priority !== undefined) t.priority = a.priority;
      if (a.dueAt !== undefined) t.dueAt = a.dueAt;
      if (a.remindAt !== undefined) t.remindAt = a.remindAt;
      if (a.repeat !== undefined) t.repeat = a.repeat;
      if (a.subtasks !== undefined) t.subtasks = a.subtasks;
      if (a.status !== undefined) {
        t.status = Math.max(0, Math.min(2, Number(a.status) || 0));
        t.done = t.status === 2;
        t.completedAt = t.done ? Date.now() : null;
      }
      if (a.position !== undefined && a.position !== null) t.position = a.position;
      if (t.remindAt && t.remindAt > Date.now()) t.reminded = false;
      return Promise.resolve();
    }
    case 'set_task': {
      const t = mock.tasks.find((x) => x.id === a.id);
      if (!t) return Promise.resolve(null);
      if (a.done && t.repeat && t.repeat !== 'none') {
        const day = 86400000;
        const base = t.dueAt || Date.now();
        t.dueAt = t.repeat === 'daily' ? base + day : t.repeat === 'weekly' ? base + 7 * day : base + 30 * day;
        t.reminded = false;
        t.status = 0;
        return Promise.resolve({ ...t });
      }
      t.done = !!a.done;
      t.status = t.done ? 2 : (t.status === 2 ? 0 : t.status);
      t.completedAt = t.done ? Date.now() : null;
      return Promise.resolve({ ...t });
    }
    case 'delete_task':
      mock.tasks = mock.tasks.filter((x) => x.id !== a.id);
      return Promise.resolve();
    case 'clear_done_tasks':
      mock.tasks = mock.tasks.filter((x) => !x.done);
      return Promise.resolve();
    case 'get_setting':
      return Promise.resolve(mock.settings[a.key] ?? null);
    case 'set_setting':
      mock.settings[a.key] = a.value;
      return Promise.resolve();
    case 'export_backup':
      return Promise.resolve('C:\\Users\\demo\\Documents\\nook-backup.json');
    case 'import_backup':
      return Promise.resolve(mockStats());
    case 'recorder_devices':
      return Promise.resolve(['Default — Built-in microphone', 'USB Microphone (Realtek)']);
    case 'recorder_status':
      return Promise.resolve({
        recording: !!mock.recTimerStart,
        elapsedMs: mock.recTimerStart ? Date.now() - mock.recTimerStart : 0,
        error: null
      });
    case 'recorder_start':
      mock.recTimerStart = Date.now();
      return Promise.resolve();
    case 'recorder_stop': {
      if (!mock.recTimerStart) return Promise.resolve(null);
      const ms = Date.now() - mock.recTimerStart;
      mock.recTimerStart = null;
      const name = 'rec-' + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '.wav';
      const info = { name, path: 'C:\\recordings\\' + name, bytes: Math.round(ms * 17), durationMs: ms, createdAt: Date.now() };
      mock.recordings.unshift(info);
      return Promise.resolve(info);
    }
    case 'list_recordings':
      return Promise.resolve(mock.recordings.slice());
    case 'rename_recording': {
      const r = mock.recordings.find((x) => x.name === a.from);
      if (r) { r.name = a.to; r.path = 'C:\\recordings\\' + a.to; }
      return Promise.resolve();
    }
    case 'delete_recording':
      mock.recordings = mock.recordings.filter((x) => x.name !== a.name);
      return Promise.resolve();
    case 'export_recording':
      return Promise.resolve('C:\\Users\\demo\\Desktop\\' + a.name);
    case 'ai_list_models':
      return Promise.resolve(['openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet', 'meta-llama/llama-3.2-70b']);
    case 'ai_complete':
      return Promise.resolve(
        '• This is a mock AI response from the browser preview.\n• In the real app this comes from your own AI provider.\n• Your key stays on this PC.'
      );
    case 'ai_chat':
      return Promise.resolve();
    case 'ai_stop':
      return Promise.resolve();
    case 'ai_test':
      return Promise.resolve('Connected — model replied: OK (mock)');
    case 'list_chats':
      return Promise.resolve(mock.chats || []);
    case 'create_chat': {
      mock.chats = mock.chats || [];
      const c = { id: 'chat-' + Date.now(), title: (a.title || 'New chat').trim() || 'New chat', createdAt: Date.now(), updatedAt: Date.now() };
      mock.chats.unshift(c);
      return Promise.resolve({ ...c });
    }
    case 'rename_chat': {
      const c = (mock.chats || []).find((x) => x.id === a.id);
      if (c) c.title = a.title;
      return Promise.resolve();
    }
    case 'delete_chat':
      mock.chats = (mock.chats || []).filter((x) => x.id !== a.id);
      mock.chatMsgs = Object.fromEntries(Object.entries(mock.chatMsgs || {}).filter(([k]) => k !== a.id));
      return Promise.resolve();
    case 'get_chat_messages':
      return Promise.resolve((mock.chatMsgs || {})[a.chatId] || []);
    case 'add_chat_message': {
      mock.chatMsgs = mock.chatMsgs || {};
      const arr = mock.chatMsgs[a.chatId] = mock.chatMsgs[a.chatId] || [];
      const m = { id: 'msg-' + Date.now(), chatId: a.chatId, role: a.role, content: a.content, createdAt: Date.now() };
      arr.push(m);
      return Promise.resolve({ ...m });
    }
    case 'clear_chat_messages':
      if (mock.chatMsgs) mock.chatMsgs[a.chatId] = [];
      return Promise.resolve();
    case 'import_notes':
      return Promise.resolve(2);
    case 'autostart_get':
      return Promise.resolve(false);
    case 'autostart_set':
      return Promise.resolve();
    case 'clipboard_write':
      return Promise.resolve();
    case 'clipboard_read':
      return Promise.resolve('clipboard mock text');
    case 'get_stats':
      return Promise.resolve(mockStats());
    case 'data_dir':
      return Promise.resolve('C:\\Users\\demo\\AppData\\Roaming\\Nook');
    case 'export_note':
      return Promise.resolve('C:\\Users\\demo\\Documents\\note.md');
    case 'open_url':
      if (typeof window !== 'undefined') window.open(a.url, '_blank');
      return Promise.resolve();
    case 'reveal_data_dir':
      return Promise.resolve();
    default:
      return Promise.reject(new Error('mock: unknown command ' + cmd));
  }
}

// Browser-mock image resolver: nookimg://id -> data URL (sync, for markdown)
export function mockImageSrc(id) {
  const store = (typeof window !== 'undefined' && window.__nookMockImages) || {};
  return store[id] ? store[id].dataUrl : '';
}

// ---------------------------------------------------------------- bridge ----

export async function call(cmd, args = {}) {
  if (!IS_TAURI) return mockCall(cmd, args);
  try {
    return await invoke(cmd, args);
  } catch (err) {
    const msg = typeof err === 'string' ? err : err && err.message ? err.message : String(err);
    throw new Error(msg);
  }
}
