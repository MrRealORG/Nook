#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Nook — a real, native desktop notes app.
//!
//! Rust + Tauri 2 + SQLite. No servers, no Node.js, no loading screens.
//! Everything (notes, folders, tasks, settings) lives in a local SQLite
//! database inside the user's app-data directory. 100% offline.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Manager, State, WindowEvent};

type CmdResult<T> = Result<T, String>;

fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- state ----

struct Db(Mutex<Connection>);

fn db<'a>(state: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    state.0.lock().unwrap_or_else(|p| p.into_inner())
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn new_id(prefix: &str) -> String {
    static C: AtomicU32 = AtomicU32::new(0);
    let c = C.fetch_add(1, Ordering::Relaxed);
    format!("{}{:x}{:x}", prefix, now_ms(), c)
}

// ---------------------------------------------------------------- models ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Folder {
    id: String,
    name: String,
    created_at: i64,
    position: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteSummary {
    id: String,
    folder_id: Option<String>,
    title: String,
    snippet: String,
    pinned: bool,
    favorite: bool,
    trashed: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Note {
    id: String,
    folder_id: Option<String>,
    title: String,
    content: String,
    pinned: bool,
    favorite: bool,
    trashed: bool,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    title: String,
    done: bool,
    position: i64,
    created_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Stats {
    notes: i64,
    favorites: i64,
    open_tasks: i64,
    folders: i64,
    trash: i64,
}

// ---------------------------------------------------------------- schema ----

fn init_db(path: &PathBuf) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;

        CREATE TABLE IF NOT EXISTS folders (
            id         TEXT PRIMARY KEY,
            name       TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            position   INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS notes (
            id         TEXT PRIMARY KEY,
            folder_id  TEXT,
            title      TEXT NOT NULL DEFAULT '',
            content    TEXT NOT NULL DEFAULT '',
            pinned     INTEGER NOT NULL DEFAULT 0,
            favorite   INTEGER NOT NULL DEFAULT 0,
            trashed    INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_notes_list ON notes(trashed, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);

        CREATE TABLE IF NOT EXISTS tasks (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL,
            done       INTEGER NOT NULL DEFAULT 0,
            position   INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        "#,
    )?;
    Ok(conn)
}

fn get_kv(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |r| r.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

fn set_kv(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )
    .map(|_| ())
    .map_err(es)
}

fn make_snippet(content: &str) -> String {
    let flat: String = content
        .chars()
        .map(|c| if c == '\n' || c == '\r' || c == '\t' { ' ' } else { c })
        .collect();
    let squeezed: Vec<&str> = flat.split_whitespace().collect();
    let joined = squeezed.join(" ");
    let mut out: String = joined.chars().take(180).collect();
    if joined.chars().count() > 180 {
        out.push('…');
    }
    out
}

// --------------------------------------------------------------- folders ----

#[tauri::command]
fn list_folders(state: State<'_, Db>) -> CmdResult<Vec<Folder>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, position FROM folders ORDER BY position ASC, name COLLATE NOCASE ASC")
        .map_err(es)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                position: r.get(3)?,
            })
        })
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
fn create_folder(state: State<'_, Db>, name: String) -> CmdResult<Folder> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    let conn = db(&state);
    let pos: i64 = conn
        .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM folders", [], |r| r.get(0))
        .map_err(es)?;
    let f = Folder { id: new_id("fol"), name, created_at: now_ms(), position: pos };
    conn.execute(
        "INSERT INTO folders(id, name, created_at, position) VALUES(?1, ?2, ?3, ?4)",
        params![f.id, f.name, f.created_at, f.position],
    )
    .map_err(es)?;
    Ok(f)
}

#[tauri::command]
fn rename_folder(state: State<'_, Db>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    let conn = db(&state);
    conn.execute("UPDATE folders SET name = ?2 WHERE id = ?1", params![id, name])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn delete_folder(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("UPDATE notes SET folder_id = NULL WHERE folder_id = ?1", params![id])
        .map_err(es)?;
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn folder_counts(state: State<'_, Db>) -> CmdResult<Vec<(String, i64)>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare("SELECT folder_id, COUNT(*) FROM notes WHERE trashed = 0 AND folder_id IS NOT NULL GROUP BY folder_id")
        .map_err(es)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// ----------------------------------------------------------------- notes ----

fn row_to_summary(r: &rusqlite::Row) -> rusqlite::Result<NoteSummary> {
    let content: String = r.get(3)?;
    Ok(NoteSummary {
        id: r.get(0)?,
        folder_id: r.get(1)?,
        title: r.get(2)?,
        snippet: make_snippet(&content),
        pinned: r.get::<_, i64>(4)? != 0,
        favorite: r.get::<_, i64>(5)? != 0,
        trashed: r.get::<_, i64>(6)? != 0,
        created_at: r.get(7)?,
        updated_at: r.get(8)?,
    })
}

const NOTE_COLS: &str =
    "id, folder_id, title, content, pinned, favorite, trashed, created_at, updated_at";

#[tauri::command]
fn list_notes(
    state: State<'_, Db>,
    view: String,
    folder_id: Option<String>,
    query: Option<String>,
    sort: Option<String>,
) -> CmdResult<Vec<NoteSummary>> {
    let conn = db(&state);
    let order = match sort.as_deref().unwrap_or("updated") {
        "created" => "created_at DESC",
        "alpha" => "title COLLATE NOCASE ASC",
        _ => "updated_at DESC",
    };
    let tail = format!("ORDER BY pinned DESC, {}", order);
    let q = query
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let sql: String;
    let mut bind_folder = false;

    if let Some(q) = &q {
        sql = format!(
            "SELECT {NOTE_COLS} FROM notes
             WHERE trashed = 0 AND (title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\')
             {tail}"
        );
        let like = format!(
            "%{}%",
            q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
        );
        let mut stmt = conn.prepare(&sql).map_err(es)?;
        let rows = stmt
            .query_map(params![like], row_to_summary)
            .map_err(es)?;
        return Ok(rows.filter_map(|r| r.ok()).collect());
    }

    match view.as_str() {
        "favorites" => sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 0 AND favorite = 1 {tail}"),
        "trash" => sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 1 {tail}"),
        "folder" => {
            bind_folder = true;
            sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 0 AND folder_id IS ?1 {tail}");
        }
        _ => sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 0 {tail}"),
    }

    let mut stmt = conn.prepare(&sql).map_err(es)?;
    let rows = if bind_folder {
        stmt.query_map(params![folder_id], row_to_summary).map_err(es)?
    } else {
        stmt.query_map([], row_to_summary).map_err(es)?
    };
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
fn get_note(state: State<'_, Db>, id: String) -> CmdResult<Option<Note>> {
    let conn = db(&state);
    let note = conn
        .query_row(
            &format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"),
            params![id],
            |r| {
                Ok(Note {
                    id: r.get(0)?,
                    folder_id: r.get(1)?,
                    title: r.get(2)?,
                    content: r.get(3)?,
                    pinned: r.get::<_, i64>(4)? != 0,
                    favorite: r.get::<_, i64>(5)? != 0,
                    trashed: r.get::<_, i64>(6)? != 0,
                    created_at: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            },
        )
        .optional()
        .map_err(es)?;
    Ok(note)
}

#[tauri::command]
fn create_note(state: State<'_, Db>, folder_id: Option<String>) -> CmdResult<Note> {
    let conn = db(&state);
    let n = Note {
        id: new_id("note"),
        folder_id,
        title: String::new(),
        content: String::new(),
        pinned: false,
        favorite: false,
        trashed: false,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO notes(id, folder_id, title, content, pinned, favorite, trashed, created_at, updated_at)
         VALUES(?1, ?2, ?3, ?4, 0, 0, 0, ?5, ?6)",
        params![n.id, n.folder_id, n.title, n.content, n.created_at, n.updated_at],
    )
    .map_err(es)?;
    Ok(n)
}

#[tauri::command]
fn save_note(state: State<'_, Db>, id: String, title: String, content: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4 WHERE id = ?1",
        params![id, title, content, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn pin_note(state: State<'_, Db>, id: String, pinned: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("UPDATE notes SET pinned = ?2 WHERE id = ?1", params![id, pinned as i64])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn favorite_note(state: State<'_, Db>, id: String, favorite: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn move_note(state: State<'_, Db>, id: String, folder_id: Option<String>) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET folder_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, folder_id, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn trash_note(state: State<'_, Db>, id: String, trashed: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET trashed = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, trashed as i64, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn delete_note_forever(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
fn empty_trash(state: State<'_, Db>) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM notes WHERE trashed = 1", []).map_err(es)?;
    Ok(())
}

// ----------------------------------------------------------------- tasks ----

#[tauri::command]
fn list_tasks(state: State<'_, Db>) -> CmdResult<Vec<Task>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare("SELECT id, title, done, position, created_at FROM tasks ORDER BY done ASC, position ASC, created_at ASC")
        .map_err(es)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Task {
                id: r.get(0)?,
                title: r.get(1)?,
                done: r.get::<_, i64>(2)? != 0,
                position: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
fn create_task(state: State<'_, Db>, title: String) -> CmdResult<Task> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Task cannot be empty".into());
    }
    let conn = db(&state);
    let pos: i64 = conn
        .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM tasks", [], |r| r.get(0))
        .map_err(es)?;
    let t = Task { id: new_id("task"), title, done: false, position: pos, created_at: now_ms() };
    conn.execute(
        "INSERT INTO tasks(id, title, done, position, created_at) VALUES(?1, ?2, 0, ?3, ?4)",
        params![t.id, t.title, t.position, t.created_at],
    )
    .map_err(es)?;
    Ok(t)
}

#[tauri::command]
fn set_task(state: State<'_, Db>, id: String, done: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("UPDATE tasks SET done = ?2 WHERE id = ?1", params![id, done as i64])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
fn delete_task(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id]).map_err(es)?;
    Ok(())
}

#[tauri::command]
fn clear_done_tasks(state: State<'_, Db>) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM tasks WHERE done = 1", []).map_err(es)?;
    Ok(())
}

// -------------------------------------------------------------- settings ----

#[tauri::command]
fn get_setting(state: State<'_, Db>, key: String) -> Option<String> {
    let conn = db(&state);
    get_kv(&conn, &key)
}

#[tauri::command]
fn set_setting(state: State<'_, Db>, key: String, value: String) -> CmdResult<()> {
    let conn = db(&state);
    set_kv(&conn, &key, &value)
}

#[tauri::command]
fn get_stats(state: State<'_, Db>) -> CmdResult<Stats> {
    let conn = db(&state);
    let stats = conn
        .query_row(
            r#"SELECT
                (SELECT COUNT(*) FROM notes WHERE trashed = 0),
                (SELECT COUNT(*) FROM notes WHERE trashed = 0 AND favorite = 1),
                (SELECT COUNT(*) FROM tasks WHERE done = 0),
                (SELECT COUNT(*) FROM folders),
                (SELECT COUNT(*) FROM notes WHERE trashed = 1)"#,
            [],
            |r| {
                Ok(Stats {
                    notes: r.get(0)?,
                    favorites: r.get(1)?,
                    open_tasks: r.get(2)?,
                    folders: r.get(3)?,
                    trash: r.get(4)?,
                })
            },
        )
        .map_err(es)?;
    Ok(stats)
}

// ------------------------------------------------------------- desktop os ----

#[tauri::command]
fn data_dir(app: AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn sanitize_filename(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            '\u{0}'..='\u{1f}' => '-',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_end_matches('.').trim();
    if trimmed.is_empty() {
        "note".to_string()
    } else {
        trimmed.chars().take(60).collect()
    }
}

#[tauri::command]
fn export_note(app: AppHandle, state: State<'_, Db>, id: String) -> CmdResult<Option<String>> {
    let _ = app;
    let conn = db(&state);
    let (title, content): (String, String) = conn
        .query_row(
            "SELECT title, content FROM notes WHERE id = ?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(es)?
        .ok_or_else(|| "note not found".to_string())?;

    let file_name = format!("{}.md", sanitize_filename(&title));
    let path = rfd::FileDialog::new()
        .set_title("Export note as Markdown")
        .set_file_name(&file_name)
        .add_filter("Markdown", &["md", "txt"])
        .save_file();

    match path {
        Some(p) => {
            std::fs::write(&p, content.as_bytes()).map_err(es)?;
            Ok(Some(p.to_string_lossy().into_owned()))
        }
        None => Ok(None),
    }
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("Only http(s) links are allowed".into());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(es)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&url).spawn().map_err(es)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&url).spawn().map_err(es)?;
    }
    Ok(())
}

#[tauri::command]
fn reveal_data_dir(app: AppHandle) -> CmdResult<()> {
    let dir: PathBuf = app.path().app_data_dir().map_err(es)?;
    std::fs::create_dir_all(&dir).map_err(es)?;
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(es)?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(&dir).spawn().map_err(es)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open").arg(&dir).spawn().map_err(es)?;
    }
    Ok(())
}

// -------------------------------------------------------- window geometry ----

fn persist_window_state(win: &tauri::Window) {
    let maximized = win.is_maximized().unwrap_or(false);
    let (x, y) = match win.outer_position() {
        Ok(p) => (p.x, p.y),
        Err(_) => return,
    };
    let (w, h) = match win.inner_size() {
        Ok(s) => (s.width as i64, s.height as i64),
        Err(_) => return,
    };
    let val = if maximized {
        format!("maximized,0,0,{w},{h}")
    } else {
        format!("normal,{x},{y},{w},{h}")
    };
    let state = win.app_handle().state::<Db>();
    let conn = db(&state);
    let _ = set_kv(&conn, "window_bounds", &val);
}

fn apply_window_state(win: &tauri::WebviewWindow, raw: Option<String>) {
    let Some(s) = raw else { return };
    let parts: Vec<&str> = s.split(',').collect();
    if parts.len() != 5 {
        return;
    }
    let w: i64 = parts[3].parse().unwrap_or(0);
    let h: i64 = parts[4].parse().unwrap_or(0);
    if !(300..=20000).contains(&w) || !(300..=20000).contains(&h) {
        return;
    }
    let _ = win.set_size(tauri::PhysicalSize::new(w as u32, h as u32));
    if parts[0] == "normal" {
        if let (Ok(x), Ok(y)) = (parts[1].parse::<i32>(), parts[2].parse::<i32>()) {
            if x.abs() < 20000 && y.abs() < 20000 {
                let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
            }
        }
    } else if parts[0] == "maximized" {
        let _ = win.maximize();
    }
}

// ------------------------------------------------------------------ main ----

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("Nook: cannot resolve app data directory");
            std::fs::create_dir_all(&dir)?;
            let conn = init_db(&dir.join("nook.db")).expect("Nook: cannot open database");

            let saved_bounds = get_kv(&conn, "window_bounds");

            app.manage(Db(Mutex::new(conn)));

            let win = app
                .get_webview_window("main")
                .expect("Nook: main window missing");
            apply_window_state(&win, saved_bounds);
            let _ = win.show();
            let _ = win.set_focus();
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { .. } = event {
                persist_window_state(window);
            }
        })
        .invoke_handler(tauri::generate_handler![
            list_folders,
            create_folder,
            rename_folder,
            delete_folder,
            folder_counts,
            list_notes,
            get_note,
            create_note,
            save_note,
            pin_note,
            favorite_note,
            move_note,
            trash_note,
            delete_note_forever,
            empty_trash,
            list_tasks,
            create_task,
            set_task,
            delete_task,
            clear_done_tasks,
            get_setting,
            set_setting,
            get_stats,
            data_dir,
            export_note,
            open_url,
            reveal_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nook");
}
