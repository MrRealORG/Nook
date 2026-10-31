#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Nook — a real, native desktop notes app.
//!
//! Rust + Tauri 2 + SQLite. No servers, no Node.js, no loading screens.
//! Everything (notes, folders, tasks, settings) lives in a local SQLite
//! database inside the user's app-data directory. 100% offline.

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_autostart::ManagerExt as _AutostartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

pub mod ai;
mod recorder;

type CmdResult<T> = Result<T, String>;

pub fn es<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

// ---------------------------------------------------------------- state ----

struct Db(Mutex<Connection>);

fn db<'a>(state: &'a State<'_, Db>) -> MutexGuard<'a, Connection> {
    state.0.lock().unwrap_or_else(|p| p.into_inner())
}

pub fn now_ms() -> i64 {
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

#[derive(Serialize, Deserialize, Clone)]
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
    tags: String,
}

fn empty_tags() -> String {
    "[]".into()
}

#[derive(Serialize, Deserialize, Clone)]
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
    #[serde(default = "empty_tags")]
    tags: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Subtask {
    id: String,
    title: String,
    done: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Task {
    id: String,
    title: String,
    notes: String,
    done: bool,
    priority: i64,          // 0 none · 1 low · 2 medium · 3 high
    due_at: Option<i64>,    // due date+time (UTC ms)
    remind_at: Option<i64>, // reminder (UTC ms)
    repeat: String,         // none | daily | weekly | monthly
    subtasks: Vec<Subtask>,
    #[serde(default)]       // old backups have no labels — import them anyway
    labels: Vec<String>,    // v0.16 — board label color keys ("red","green",...)
    reminded: bool,
    position: i64,
    created_at: i64,
    completed_at: Option<i64>,
    status: i64,            // board column: 0 To do · 1 In progress · 2 Done
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ImageMeta {
    id: String,
    note_id: String,
    mime: String,
    name: String,
    bytes: i64,
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

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatSummary {
    id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ChatMsg {
    id: String,
    chat_id: String,
    role: String,
    content: String,
    created_at: i64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BackupImage {
    id: String,
    note_id: String,
    mime: String,
    name: String,
    data: String, // base64
    created_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    app: String,
    schema: i64,
    exported_at: i64,
    folders: Vec<Folder>,
    notes: Vec<Note>,
    tasks: Vec<Task>,
    settings: Vec<(String, String)>,
    #[serde(default)]
    images: Vec<BackupImage>,
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
            updated_at INTEGER NOT NULL,
            tags       TEXT NOT NULL DEFAULT '[]'
        );

        CREATE INDEX IF NOT EXISTS idx_notes_list ON notes(trashed, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_notes_folder ON notes(folder_id);

        CREATE TABLE IF NOT EXISTS tasks (
            id           TEXT PRIMARY KEY,
            title        TEXT NOT NULL,
            notes        TEXT NOT NULL DEFAULT '',
            done         INTEGER NOT NULL DEFAULT 0,
            priority     INTEGER NOT NULL DEFAULT 0,
            due_at       INTEGER,
            remind_at    INTEGER,
            repeat       TEXT NOT NULL DEFAULT 'none',
            subtasks     TEXT NOT NULL DEFAULT '[]',
            reminded     INTEGER NOT NULL DEFAULT 0,
            position     INTEGER NOT NULL DEFAULT 0,
            created_at   INTEGER NOT NULL,
            completed_at INTEGER
        );

        CREATE TABLE IF NOT EXISTS note_images (
            id         TEXT PRIMARY KEY,
            note_id    TEXT NOT NULL,
            mime       TEXT NOT NULL,
            name       TEXT NOT NULL DEFAULT '',
            bytes      BLOB NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_note_images ON note_images(note_id);

        CREATE TABLE IF NOT EXISTS settings (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chats (
            id         TEXT PRIMARY KEY,
            title      TEXT NOT NULL DEFAULT 'New chat',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS chat_messages (
            id         TEXT PRIMARY KEY,
            chat_id    TEXT NOT NULL,
            role       TEXT NOT NULL,
            content    TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_chat_msgs ON chat_messages(chat_id, created_at);
        "#,
    )?;
    Ok(conn)
}

/// Adds a column to an existing table if it is missing (in-place upgrade of
/// old v0.4 databases — user data is never touched).
fn ensure_column(conn: &Connection, table: &str, column: &str, decl: &str) {
    let present: i64 = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM pragma_table_info('{table}') WHERE name = ?1"),
            params![column],
            |r| r.get(0),
        )
        .unwrap_or(1); // if the pragma fails, pretend it's there and do nothing
    if present == 0 {
        let _ = conn.execute(
            &format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"),
            [],
        );
    }
}

fn migrate(conn: &Connection) {
    ensure_column(conn, "notes", "tags", "TEXT NOT NULL DEFAULT '[]'");
    ensure_column(conn, "tasks", "notes", "TEXT NOT NULL DEFAULT ''");
    ensure_column(conn, "tasks", "status", "INTEGER NOT NULL DEFAULT 0");
    ensure_column(conn, "tasks", "priority", "INTEGER NOT NULL DEFAULT 0");
    ensure_column(conn, "tasks", "due_at", "INTEGER");
    ensure_column(conn, "tasks", "remind_at", "INTEGER");
    ensure_column(conn, "tasks", "repeat", "TEXT NOT NULL DEFAULT 'none'");
    ensure_column(conn, "tasks", "subtasks", "TEXT NOT NULL DEFAULT '[]'");
    ensure_column(conn, "tasks", "labels", "TEXT NOT NULL DEFAULT '[]'");
    ensure_column(conn, "tasks", "reminded", "INTEGER NOT NULL DEFAULT 0");
    ensure_column(conn, "tasks", "completed_at", "INTEGER");
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
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .collect();
    let squeezed: Vec<&str> = flat.split_whitespace().collect();
    let joined = squeezed.join(" ");
    let mut out: String = joined.chars().take(180).collect();
    if joined.chars().count() > 180 {
        out.push('…');
    }
    out
}

// ----------------------------------------------------- date math (no chrono) ----

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap(y) {
                29
            } else {
                28
            }
        }
    }
}

/// Howard Hinnant's civil-from-days / days-from-civil algorithms.
pub fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// Next occurrence of a repeating task (UTC ms).
fn next_occurrence(ms: i64, repeat: &str) -> i64 {
    match repeat {
        "daily" => ms + 86_400_000,
        "weekly" => ms + 7 * 86_400_000,
        "monthly" => {
            let days = ms.div_euclid(86_400_000);
            let rem = ms.rem_euclid(86_400_000);
            let (y, m, d) = civil_from_days(days);
            let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
            let nd = d.min(days_in_month(ny, nm));
            days_from_civil(ny, nm, nd) * 86_400_000 + rem
        }
        _ => ms,
    }
}

// --------------------------------------------------------------- folders ----

#[tauri::command]
async fn list_folders(state: State<'_, Db>) -> CmdResult<Vec<Folder>> {
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
async fn create_folder(state: State<'_, Db>, name: String) -> CmdResult<Folder> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    let conn = db(&state);
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM folders",
            [],
            |r| r.get(0),
        )
        .map_err(es)?;
    let f = Folder {
        id: new_id("fol"),
        name,
        created_at: now_ms(),
        position: pos,
    };
    conn.execute(
        "INSERT INTO folders(id, name, created_at, position) VALUES(?1, ?2, ?3, ?4)",
        params![f.id, f.name, f.created_at, f.position],
    )
    .map_err(es)?;
    Ok(f)
}

#[tauri::command]
async fn rename_folder(state: State<'_, Db>, id: String, name: String) -> CmdResult<()> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("Folder name cannot be empty".into());
    }
    let conn = db(&state);
    conn.execute(
        "UPDATE folders SET name = ?2 WHERE id = ?1",
        params![id, name],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn delete_folder(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET folder_id = NULL WHERE folder_id = ?1",
        params![id],
    )
    .map_err(es)?;
    conn.execute("DELETE FROM folders WHERE id = ?1", params![id])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn folder_counts(state: State<'_, Db>) -> CmdResult<Vec<(String, i64)>> {
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
        tags: r.get(9).unwrap_or_else(|_| "[]".into()),
    })
}

const NOTE_COLS: &str =
    "id, folder_id, title, content, pinned, favorite, trashed, created_at, updated_at, tags";

fn row_to_note(r: &rusqlite::Row) -> rusqlite::Result<Note> {
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
        tags: r.get(9).unwrap_or_else(|_| "[]".into()),
    })
}

#[tauri::command]
async fn list_notes(
    state: State<'_, Db>,
    view: String,
    folder_id: Option<String>,
    query: Option<String>,
    sort: Option<String>,
    tag: Option<String>,
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
    let tag_like: Option<String> = tag
        .map(|t| t.trim().replace(['"', '%', '_'], ""))
        .filter(|t| !t.is_empty())
        .map(|t| format!("%\"{t}\"%"));

    if let Some(q) = &q {
        let like = format!(
            "%{}%",
            q.replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        let sql = if tag_like.is_some() {
            format!(
                "SELECT {NOTE_COLS} FROM notes
                 WHERE trashed = 0 AND (title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\')
                 AND tags LIKE ?2 ESCAPE '\\' {tail}"
            )
        } else {
            format!(
                "SELECT {NOTE_COLS} FROM notes
                 WHERE trashed = 0 AND (title LIKE ?1 ESCAPE '\\' OR content LIKE ?1 ESCAPE '\\')
                 {tail}"
            )
        };
        let mut stmt = conn.prepare(&sql).map_err(es)?;
        let rows = match &tag_like {
            Some(tl) => stmt.query_map(params![like, tl], row_to_summary).map_err(es)?,
            None => stmt.query_map(params![like], row_to_summary).map_err(es)?,
        };
        return Ok(rows.filter_map(|r| r.ok()).collect());
    }

    let mut sql: String;
    let mut bind_folder = false;

    match view.as_str() {
        "favorites" => {
            sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 0 AND favorite = 1")
        }
        "trash" => sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 1"),
        "folder" => {
            bind_folder = true;
            sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 0 AND folder_id IS ?1");
        }
        _ => sql = format!("SELECT {NOTE_COLS} FROM notes WHERE trashed = 0"),
    }
    if let Some(tl) = &tag_like {
        if bind_folder {
            sql = sql.replace("WHERE ", "WHERE tags LIKE ?2 AND ");
        } else {
            sql = sql.replace("WHERE ", "WHERE tags LIKE ?1 AND ");
        }
    }
    sql = format!("{sql} {tail}");

    let mut stmt = conn.prepare(&sql).map_err(es)?;
    let rows = match (&tag_like, bind_folder) {
        (Some(tl), true) => {
            stmt.query_map(params![folder_id, tl], row_to_summary).map_err(es)?
        }
        (Some(tl), false) => stmt.query_map(params![tl], row_to_summary).map_err(es)?,
        (None, true) => {
            stmt.query_map(params![folder_id], row_to_summary).map_err(es)?
        }
        (None, false) => stmt.query_map([], row_to_summary).map_err(es)?,
    };
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
async fn get_note(state: State<'_, Db>, id: String) -> CmdResult<Option<Note>> {
    let conn = db(&state);
    let note = conn
        .query_row(
            &format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"),
            params![id],
            row_to_note,
        )
        .optional()
        .map_err(es)?;
    Ok(note)
}

#[tauri::command]
async fn create_note(state: State<'_, Db>, folder_id: Option<String>) -> CmdResult<Note> {
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
        tags: empty_tags(),
    };
    conn.execute(
        "INSERT INTO notes(id, folder_id, title, content, pinned, favorite, trashed, created_at, updated_at, tags)
         VALUES(?1, ?2, ?3, ?4, 0, 0, 0, ?5, ?6, '[]')",
        params![n.id, n.folder_id, n.title, n.content, n.created_at, n.updated_at],
    )
    .map_err(es)?;
    Ok(n)
}

#[tauri::command]
async fn save_note(
    state: State<'_, Db>,
    id: String,
    title: String,
    content: String,
    tags: Option<String>,
) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET title = ?2, content = ?3, updated_at = ?4,
         tags = COALESCE(?5, tags) WHERE id = ?1",
        params![id, title, content, now_ms(), tags],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn duplicate_note(state: State<'_, Db>, id: String) -> CmdResult<Option<Note>> {
    let conn = db(&state);
    let src = conn
        .query_row(
            &format!("SELECT {NOTE_COLS} FROM notes WHERE id = ?1"),
            params![id],
            row_to_note,
        )
        .optional()
        .map_err(es)?;
    let Some(src) = src else { return Ok(None) };
    let n = Note {
        id: new_id("note"),
        folder_id: src.folder_id,
        title: format!("{} (copy)", src.title),
        content: src.content,
        tags: src.tags.clone(),
        pinned: false,
        favorite: false,
        trashed: false,
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO notes(id, folder_id, title, content, pinned, favorite, trashed, created_at, updated_at, tags)
         VALUES(?1, ?2, ?3, ?4, 0, 0, 0, ?5, ?6, ?7)",
        params![n.id, n.folder_id, n.title, n.content, n.created_at, n.updated_at, n.tags],
    )
    .map_err(es)?;
    Ok(Some(n))
}

#[tauri::command]
async fn pin_note(state: State<'_, Db>, id: String, pinned: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET pinned = ?2 WHERE id = ?1",
        params![id, pinned as i64],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn favorite_note(state: State<'_, Db>, id: String, favorite: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET favorite = ?2 WHERE id = ?1",
        params![id, favorite as i64],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn move_note(state: State<'_, Db>, id: String, folder_id: Option<String>) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET folder_id = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, folder_id, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn trash_note(state: State<'_, Db>, id: String, trashed: bool) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "UPDATE notes SET trashed = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, trashed as i64, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn delete_note_forever(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM notes WHERE id = ?1", params![id])
        .map_err(es)?;
    purge_orphan_images(&conn);
    Ok(())
}

#[tauri::command]
async fn empty_trash(state: State<'_, Db>) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM notes WHERE trashed = 1", [])
        .map_err(es)?;
    purge_orphan_images(&conn);
    Ok(())
}

// ----------------------------------------------------------------- tasks ----

const TASK_COLS: &str = "id, title, notes, done, priority, due_at, remind_at, repeat, subtasks, labels, reminded, position, created_at, completed_at, status";

fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    let subtasks_raw: String = r.get(8)?;
    let subtasks: Vec<Subtask> = serde_json::from_str(&subtasks_raw).unwrap_or_default();
    let labels_raw: String = r.get(9)?;
    let labels: Vec<String> = serde_json::from_str(&labels_raw).unwrap_or_default();
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        notes: r.get(2)?,
        done: r.get::<_, i64>(3)? != 0,
        priority: r.get(4)?,
        due_at: r.get(5)?,
        remind_at: r.get(6)?,
        repeat: r.get(7)?,
        subtasks,
        labels,
        reminded: r.get::<_, i64>(10)? != 0,
        position: r.get(11)?,
        created_at: r.get(12)?,
        completed_at: r.get(13)?,
        status: r.get::<_, i64>(14).unwrap_or(0),
    })
}

// ------------------------------------------------------------- images (b64) ----

fn b64_encode(data: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(s.trim())
        .map_err(|e| format!("Could not decode image data: {e}"))
}

const IMAGE_MAX_BYTES: usize = 10 * 1024 * 1024; // 10 MB per image

#[tauri::command]
async fn list_tasks(state: State<'_, Db>) -> CmdResult<Vec<Task>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {TASK_COLS} FROM tasks ORDER BY done ASC, position ASC, created_at ASC"
        ))
        .map_err(es)?;
    let rows = stmt.query_map([], row_to_task).map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
async fn create_task(
    state: State<'_, Db>,
    title: String,
    priority: Option<i64>,
    due_at: Option<i64>,
    remind_at: Option<i64>,
    status: Option<i64>,
) -> CmdResult<Task> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Task cannot be empty".into());
    }
    let conn = db(&state);
    let pos: i64 = conn
        .query_row(
            "SELECT COALESCE(MAX(position), 0) + 1 FROM tasks",
            [],
            |r| r.get(0),
        )
        .map_err(es)?;
    let status = status.unwrap_or(0).clamp(0, 2);
    let t = Task {
        id: new_id("task"),
        title,
        notes: String::new(),
        done: status == 2,
        priority: priority.unwrap_or(0).clamp(0, 3),
        due_at,
        remind_at,
        repeat: "none".into(),
        subtasks: vec![],
        labels: vec![],
        reminded: false,
        position: pos,
        created_at: now_ms(),
        completed_at: if status == 2 { Some(now_ms()) } else { None },
        status,
    };
    conn.execute(
        &format!(
            "INSERT INTO tasks({TASK_COLS}) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, 'none', '[]', '[]', 0, ?8, ?9, ?10, ?11)"
        ),
        params![
            t.id, t.title, t.notes, t.done as i64, t.priority, t.due_at, t.remind_at,
            t.position, t.created_at, t.completed_at, t.status
        ],
    )
    .map_err(es)?;
    Ok(t)
}

#[tauri::command]
async fn update_task(
    state: State<'_, Db>,
    id: String,
    title: String,
    notes: String,
    priority: i64,
    due_at: Option<i64>,
    remind_at: Option<i64>,
    repeat: String,
    subtasks: Vec<Subtask>,
    labels: Option<Vec<String>>,
    status: Option<i64>,
    position: Option<i64>,
) -> CmdResult<()> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Err("Task cannot be empty".into());
    }
    let repeat = match repeat.as_str() {
        "daily" | "weekly" | "monthly" => repeat,
        _ => "none".to_string(),
    };
    let subs = serde_json::to_string(&subtasks).unwrap_or_else(|_| "[]".into());
    let labels_json = serde_json::to_string(&labels.unwrap_or_default()).unwrap_or_else(|_| "[]".into());
    let conn = db(&state);
    // a newly-set future reminder must fire again
    let rearm = match remind_at {
        Some(t) if t > now_ms() => 0,
        _ => 1, // keep the old reminded flag (SQL below keeps old value when rearm = 1)
    };
    conn.execute(
        &format!(
            "UPDATE tasks SET title = ?2, notes = ?3, priority = ?4, due_at = ?5,
             remind_at = ?6, repeat = ?7, subtasks = ?8, labels = COALESCE(?11, labels),
             position = COALESCE(?10, position),
             reminded = CASE WHEN ?9 = 0 THEN 0 ELSE reminded END
             WHERE id = ?1"
        ),
        params![
            id,
            title,
            notes,
            priority.clamp(0, 3),
            due_at,
            remind_at,
            repeat,
            subs,
            rearm,
            position,
            labels_json
        ],
    )
    .map_err(es)?;
    // board status (v0.8): dropping a card on a column updates done/completed too
    if let Some(st) = status {
        let st = st.clamp(0, 2);
        let done_i = (st == 2) as i64;
        conn.execute(
            "UPDATE tasks SET status = ?2, done = ?3, completed_at = CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END WHERE id = ?1",
            params![id, st, done_i, now_ms()],
        )
        .map_err(es)?;
    }
    Ok(())
}

// ---------------------------------------------- note image bytes (v0.9) ----

/// One note image as base64 — the preview renderer turns these into data:
/// URLs in the webview. This replaces the old scheme where <img> tags pulled
/// every image through the nookimg:// protocol on the UI thread, which could
/// stall the whole window while a save held the database lock (the v0.8
/// "click preview and everything freezes" bug).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ImageData {
    mime: String,
    data: String,
}

#[tauri::command]
async fn get_note_image_data(state: State<'_, Db>, id: String) -> CmdResult<Option<ImageData>> {
    let conn = db(&state);
    let row = conn
        .query_row(
            "SELECT mime, bytes FROM note_images WHERE id = ?1",
            params![id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)),
        )
        .optional()
        .map_err(es)?;
    Ok(row.map(|(mime, bytes)| ImageData {
        mime,
        data: b64_encode(&bytes),
    }))
}

/// v0.9 hygiene — image blobs whose note is gone are dead weight in the DB.
fn purge_orphan_images(conn: &Connection) {
    let _ = conn.execute(
        "DELETE FROM note_images WHERE note_id NOT IN (SELECT id FROM notes)",
        [],
    );
}

#[tauri::command]
async fn set_task(state: State<'_, Db>, id: String, done: bool) -> CmdResult<Option<Task>> {
    let conn = db(&state);
    if done {
        // fetch the task — repeating tasks spring to their next occurrence
        let current = conn
            .query_row(
                &format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"),
                params![id],
                row_to_task,
            )
            .optional()
            .map_err(es)?;
        let Some(t) = current else { return Ok(None) };
        if t.repeat != "none" {
            let base = t.due_at.unwrap_or_else(now_ms);
            let next = next_occurrence(base, &t.repeat);
            conn.execute(
                "UPDATE tasks SET done = 0, reminded = 0, due_at = ?2, completed_at = NULL, status = 0 WHERE id = ?1",
                params![id, next],
            )
            .map_err(es)?;
        } else {
            conn.execute(
                "UPDATE tasks SET done = 1, completed_at = ?2, status = 2 WHERE id = ?1",
                params![id, now_ms()],
            )
            .map_err(es)?;
        }
    } else {
        conn.execute(
            "UPDATE tasks SET done = 0, completed_at = NULL, status = CASE WHEN status = 2 THEN 0 ELSE status END WHERE id = ?1",
            params![id],
        )
        .map_err(es)?;
    }
    let updated = conn
        .query_row(
            &format!("SELECT {TASK_COLS} FROM tasks WHERE id = ?1"),
            params![id],
            row_to_task,
        )
        .optional()
        .map_err(es)?;
    Ok(updated)
}

#[tauri::command]
async fn delete_task(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM tasks WHERE id = ?1", params![id])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn clear_done_tasks(state: State<'_, Db>) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM tasks WHERE done = 1", [])
        .map_err(es)?;
    Ok(())
}

// ------------------------------------------------------ note images (v0.8) ----

#[tauri::command]
async fn insert_note_image(
    state: State<'_, Db>,
    note_id: String,
    mime: String,
    name: String,
    data: String,
) -> CmdResult<ImageMeta> {
    let mime = mime.trim().to_lowercase();
    if !mime.starts_with("image/") {
        return Err("Only image files can be embedded".into());
    }
    let raw = b64_decode(&data)?;
    if raw.len() > IMAGE_MAX_BYTES {
        return Err("Image is too large (max 10 MB)".into());
    }
    if raw.is_empty() {
        return Err("Image file is empty".into());
    }
    let conn = db(&state);
    let meta = ImageMeta {
        id: new_id("img"),
        note_id: note_id.clone(),
        mime,
        name: name.trim().chars().take(120).collect(),
        bytes: raw.len() as i64,
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO note_images(id, note_id, mime, name, bytes, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
        params![meta.id, meta.note_id, meta.mime, meta.name, raw, meta.created_at],
    )
    .map_err(es)?;
    Ok(meta)
}

#[tauri::command]
async fn delete_note_image(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM note_images WHERE id = ?1", params![id])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn note_images(state: State<'_, Db>, note_id: String) -> CmdResult<Vec<ImageMeta>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare(
            "SELECT id, note_id, mime, name, LENGTH(bytes), created_at
             FROM note_images WHERE note_id = ?1 ORDER BY created_at",
        )
        .map_err(es)?;
    let rows = stmt
        .query_map(params![note_id], |r| {
            Ok(ImageMeta {
                id: r.get(0)?,
                note_id: r.get(1)?,
                mime: r.get(2)?,
                name: r.get(3)?,
                bytes: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

/// Notes whose content links to this note with [[Title]] — "backlinks".
#[tauri::command]
async fn note_backlinks(state: State<'_, Db>, id: String) -> CmdResult<Vec<NoteSummary>> {
    let conn = db(&state);
    let title: String = conn
        .query_row("SELECT title FROM notes WHERE id = ?1", params![id], |r| r.get(0))
        .optional()
        .map_err(es)?
        .unwrap_or_default();
    let title = title.trim().to_string();
    if title.is_empty() {
        return Ok(vec![]);
    }
    let like = format!(
        "%[[{}]]%",
        title
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let sql = format!(
        "SELECT {NOTE_COLS} FROM notes\n         WHERE trashed = 0 AND id != ?1 AND content LIKE ?2 ESCAPE '\\'\n         ORDER BY updated_at DESC LIMIT 50"
    );
    let mut stmt = conn.prepare(&sql).map_err(es)?;
    let rows = stmt
        .query_map(params![id, like], row_to_summary)
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

// -------------------------------------------------------------- settings ----

#[tauri::command]
async fn get_setting(state: State<'_, Db>, key: String) -> CmdResult<Option<String>> {
    let conn = db(&state);
    Ok(get_kv(&conn, &key))
}

#[tauri::command]
async fn set_setting(state: State<'_, Db>, key: String, value: String) -> CmdResult<()> {
    let conn = db(&state);
    set_kv(&conn, &key, &value)
}

// -------------------------------------------------------------- ai chats ----

#[tauri::command]
async fn list_chats(state: State<'_, Db>) -> CmdResult<Vec<ChatSummary>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare("SELECT id, title, created_at, updated_at FROM chats ORDER BY updated_at DESC")
        .map_err(es)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(ChatSummary {
                id: r.get(0)?,
                title: r.get(1)?,
                created_at: r.get(2)?,
                updated_at: r.get(3)?,
            })
        })
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
async fn create_chat(state: State<'_, Db>, title: Option<String>) -> CmdResult<ChatSummary> {
    let conn = db(&state);
    let c = ChatSummary {
        id: new_id("chat"),
        title: title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "New chat".into()),
        created_at: now_ms(),
        updated_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO chats(id, title, created_at, updated_at) VALUES(?1, ?2, ?3, ?4)",
        params![c.id, c.title, c.created_at, c.updated_at],
    )
    .map_err(es)?;
    Ok(c)
}

#[tauri::command]
async fn rename_chat(state: State<'_, Db>, id: String, title: String) -> CmdResult<()> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Title cannot be empty".into());
    }
    let conn = db(&state);
    conn.execute(
        "UPDATE chats SET title = ?2, updated_at = ?3 WHERE id = ?1",
        params![id, title, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn delete_chat(state: State<'_, Db>, id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute("DELETE FROM chat_messages WHERE chat_id = ?1", params![id])
        .map_err(es)?;
    conn.execute("DELETE FROM chats WHERE id = ?1", params![id])
        .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn get_chat_messages(state: State<'_, Db>, chat_id: String) -> CmdResult<Vec<ChatMsg>> {
    let conn = db(&state);
    let mut stmt = conn
        .prepare(
            "SELECT id, chat_id, role, content, created_at FROM chat_messages
             WHERE chat_id = ?1 ORDER BY created_at ASC, id ASC",
        )
        .map_err(es)?;
    let rows = stmt
        .query_map(params![chat_id], |r| {
            Ok(ChatMsg {
                id: r.get(0)?,
                chat_id: r.get(1)?,
                role: r.get(2)?,
                content: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(es)?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
async fn add_chat_message(
    state: State<'_, Db>,
    chat_id: String,
    role: String,
    content: String,
) -> CmdResult<ChatMsg> {
    let role = match role.as_str() {
        "user" | "assistant" | "system" => role,
        _ => "user".to_string(),
    };
    let conn = db(&state);
    let m = ChatMsg {
        id: new_id("msg"),
        chat_id: chat_id.clone(),
        role,
        content,
        created_at: now_ms(),
    };
    conn.execute(
        "INSERT INTO chat_messages(id, chat_id, role, content, created_at) VALUES(?1, ?2, ?3, ?4, ?5)",
        params![m.id, m.chat_id, m.role, m.content, m.created_at],
    )
    .map_err(es)?;
    // bump the chat + auto-title from the first user message
    let auto_title: Option<String> = conn
        .query_row(
            "SELECT title FROM chats WHERE id = ?1",
            params![chat_id],
            |r| r.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten();
    let needs_title = matches!(auto_title.as_deref(), None | Some("New chat") | Some(""));
    if m.role == "user" && needs_title {
        let t: String = m.content.chars().take(42).collect();
        let t = t.trim();
        if !t.is_empty() {
            let _ = conn.execute(
                "UPDATE chats SET title = ?2 WHERE id = ?1",
                params![chat_id, t],
            );
        }
    }
    conn.execute(
        "UPDATE chats SET updated_at = ?2 WHERE id = ?1",
        params![chat_id, now_ms()],
    )
    .map_err(es)?;
    Ok(m)
}

#[tauri::command]
async fn clear_chat_messages(state: State<'_, Db>, chat_id: String) -> CmdResult<()> {
    let conn = db(&state);
    conn.execute(
        "DELETE FROM chat_messages WHERE chat_id = ?1",
        params![chat_id],
    )
    .map_err(es)?;
    conn.execute(
        "UPDATE chats SET title = 'New chat', updated_at = ?2 WHERE id = ?1",
        params![chat_id, now_ms()],
    )
    .map_err(es)?;
    Ok(())
}

#[tauri::command]
async fn get_stats(state: State<'_, Db>) -> CmdResult<Stats> {
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

// ---------------------------------------------------------------- insights ----
// v0.17 — one command that powers the whole Insights view. The frontend passes
// its own local midnight (startOfToday()) so day bucketing needs no timezone
// logic here: (ts - today_start).div_euclid(86_400_000) is 0 for today,
// -1 for yesterday and so on, in the user's own timezone.

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TagCount {
    tag: String,
    count: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Insights {
    notes: i64,
    words: i64,
    favorites: i64,
    folders: i64,
    tasks_open: i64,
    tasks_done: i64,
    done_7: i64,
    created_7: i64,
    chats: i64,
    msgs: i64,
    streak: i64,
    notes_14: Vec<i64>,
    tasks_14: Vec<i64>,
    top_tags: Vec<TagCount>,
}

#[tauri::command]
async fn get_insights(state: State<'_, Db>, today_start: i64) -> CmdResult<Insights> {
    let conn = db(&state);
    const DAY: i64 = 86_400_000;
    let day_idx = |ts: i64| -> i64 { (ts - today_start).div_euclid(DAY) };

    let notes: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE trashed = 0", [], |r| r.get(0))
        .map_err(es)?;
    let favorites: i64 = conn
        .query_row("SELECT COUNT(*) FROM notes WHERE trashed = 0 AND favorite = 1", [], |r| r.get(0))
        .map_err(es)?;
    let folders: i64 = conn
        .query_row("SELECT COUNT(*) FROM folders", [], |r| r.get(0))
        .map_err(es)?;
    let tasks_open: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks WHERE done = 0", [], |r| r.get(0))
        .map_err(es)?;
    let tasks_done: i64 = conn
        .query_row("SELECT COUNT(*) FROM tasks WHERE done = 1", [], |r| r.get(0))
        .map_err(es)?;
    let chats: i64 = conn
        .query_row("SELECT COUNT(*) FROM chats", [], |r| r.get(0))
        .map_err(es)?;
    let msgs: i64 = conn
        .query_row("SELECT COUNT(*) FROM chat_messages", [], |r| r.get(0))
        .map_err(es)?;

    // words written across every live note
    let mut words: i64 = 0;
    {
        let mut stmt = conn.prepare("SELECT content FROM notes WHERE trashed = 0").map_err(es)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(es)?;
        for row in rows {
            words += row.map_err(es)?.split_whitespace().count() as i64;
        }
    }

    let week_ago = today_start - 6 * DAY; // 7 days including today

    // 14-day activity: notes touched per day (updated_at) + tasks completed per day
    let mut note_days: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut notes_14 = vec![0i64; 14];
    {
        let mut stmt = conn
            .prepare("SELECT updated_at FROM notes WHERE trashed = 0")
            .map_err(es)?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).map_err(es)?;
        for row in rows {
            let ts: i64 = row.map_err(es)?;
            let idx = day_idx(ts);
            if (-13..=0).contains(&idx) {
                notes_14[(idx + 13) as usize] += 1;
            }
            note_days.insert(idx);
        }
    }
    let mut task_days: std::collections::HashSet<i64> = std::collections::HashSet::new();
    let mut tasks_14 = vec![0i64; 14];
    let mut done_7: i64 = 0;
    {
        let mut stmt = conn
            .prepare("SELECT completed_at FROM tasks WHERE done = 1 AND completed_at IS NOT NULL")
            .map_err(es)?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0)).map_err(es)?;
        for row in rows {
            let ts: i64 = row.map_err(es)?;
            let idx = day_idx(ts);
            if (-13..=0).contains(&idx) {
                tasks_14[(idx + 13) as usize] += 1;
            }
            if ts >= week_ago {
                done_7 += 1;
            }
            task_days.insert(idx);
        }
    }
    let created_7: i64 = {
        let mut stmt = conn
            .prepare("SELECT COUNT(*) FROM notes WHERE trashed = 0 AND created_at >= ?1")
            .map_err(es)?;
        stmt.query_row([week_ago], |r| r.get(0)).map_err(es)?
    };

    // writing streak — consecutive days (ending today, or yesterday if today is
    // still empty) with any note edit or completed task
    let mut streak: i64 = 0;
    let active: std::collections::HashSet<i64> = note_days.union(&task_days).copied().collect();
    let mut cursor = if active.contains(&0) {
        0
    } else if active.contains(&-1) {
        -1
    } else {
        1 // loop below won't run — streak stays 0
    };
    while active.contains(&cursor) {
        streak += 1;
        cursor -= 1;
    }

    // top tags across live notes (tags column is a JSON array of strings)
    let mut tag_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT tags FROM notes WHERE trashed = 0").map_err(es)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(es)?;
        for row in rows {
            let raw: String = row.map_err(es)?;
            if let Ok(serde_json::Value::Array(arr)) = serde_json::from_str::<serde_json::Value>(&raw) {
                for v in arr {
                    if let Some(t) = v.as_str() {
                        let t = t.trim();
                        if !t.is_empty() {
                            *tag_map.entry(t.to_string()).or_insert(0) += 1;
                        }
                    }
                }
            }
        }
    }
    let mut top_tags: Vec<TagCount> = tag_map
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect();
    top_tags.sort_by(|a, b| b.count.cmp(&a.count).then(a.tag.cmp(&b.tag)));
    top_tags.truncate(8);

    Ok(Insights {
        notes,
        words,
        favorites,
        folders,
        tasks_open,
        tasks_done,
        done_7,
        created_7,
        chats,
        msgs,
        streak,
        notes_14,
        tasks_14,
        top_tags,
    })
}

// ---------------------------------------------------------------- backup ----

fn read_backup_data(conn: &Connection) -> Result<Backup, String> {
    let mut stmt = conn
        .prepare("SELECT id, name, created_at, position FROM folders ORDER BY position")
        .map_err(es)?;
    let folders = stmt
        .query_map([], |r| {
            Ok(Folder {
                id: r.get(0)?,
                name: r.get(1)?,
                created_at: r.get(2)?,
                position: r.get(3)?,
            })
        })
        .map_err(es)?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = conn
        .prepare(&format!("SELECT {NOTE_COLS} FROM notes"))
        .map_err(es)?;
    let notes = stmt
        .query_map([], row_to_note)
        .map_err(es)?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = conn
        .prepare(&format!("SELECT {TASK_COLS} FROM tasks ORDER BY position"))
        .map_err(es)?;
    let tasks = stmt
        .query_map([], row_to_task)
        .map_err(es)?
        .filter_map(|r| r.ok())
        .collect();

    let mut stmt = conn
        .prepare("SELECT id, note_id, mime, name, bytes, created_at FROM note_images")
        .map_err(es)?;
    let mut images: Vec<BackupImage> = stmt
        .query_map([], |r| {
            let bytes: Vec<u8> = r.get(4)?;
            Ok(BackupImage {
                id: r.get(0)?,
                note_id: r.get(1)?,
                mime: r.get(2)?,
                name: r.get(3)?,
                data: b64_encode(&bytes),
                created_at: r.get(5)?,
            })
        })
        .map_err(es)?
        .filter_map(|r| r.ok())
        .collect();
    // keep backups sane — cap the embedded image payload at 64 MB total
    let total: usize = images.iter().map(|i| i.data.len()).sum();
    if total > 64 * 1024 * 1024 {
        let mut kept: usize = 0;
        images.retain(|i| {
            let keep = kept + i.data.len() <= 64 * 1024 * 1024;
            if keep {
                kept += i.data.len();
            }
            keep
        });
    }

    let mut stmt = conn
        .prepare(
            "SELECT key, value FROM settings
             WHERE key != 'window_bounds' AND key NOT LIKE 'aiProv%'",
        )
        .map_err(es)?;
    let settings = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .map_err(es)?
        .filter_map(|r| r.ok())
        .collect();

    Ok(Backup {
        app: "nook".into(),
        schema: 1,
        exported_at: now_ms(),
        folders,
        notes,
        tasks,
        settings,
        images,
    })
}

#[tauri::command]
async fn export_backup(state: State<'_, Db>) -> CmdResult<Option<String>> {
    // DB read first (quick), then hand the dialog + file IO to a worker thread
    // so the window never freezes while the save dialog is open.
    let json = {
        let conn = db(&state);
        let backup = read_backup_data(&conn)?;
        serde_json::to_string_pretty(&backup).map_err(es)?
    };
    let stamp = {
        let (y, m, d) = civil_from_days(now_ms().div_euclid(86_400_000));
        format!("{y:04}-{m:02}-{d:02}")
    };
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("Save Nook backup")
            .set_file_name(&format!("nook-backup-{stamp}.json"))
            .add_filter("Nook backup (JSON)", &["json"])
            .save_file();
        match path {
            Some(p) => {
                std::fs::write(&p, json.as_bytes()).map_err(es)?;
                Ok(Some(p.to_string_lossy().into_owned()))
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| es(e))?
}

#[tauri::command]
async fn import_backup(app: AppHandle, state: State<'_, Db>) -> CmdResult<Option<Stats>> {
    // dialog + file read + parse run on a worker thread — never block the UI
    let picked = tauri::async_runtime::spawn_blocking(|| -> Result<Option<Backup>, String> {
        let path = rfd::FileDialog::new()
            .set_title("Choose a Nook backup file")
            .add_filter("Nook backup (JSON)", &["json"])
            .pick_file();
        let Some(path) = path else { return Ok(None) };
        let raw = std::fs::read_to_string(&path).map_err(es)?;
        let data: Backup = serde_json::from_str(&raw)
            .map_err(|e| format!("Not a valid Nook backup file: {e}"))?;
        if data.app != "nook" {
            return Err("This file is not a Nook backup".to_string());
        }
        Ok(Some(data))
    })
    .await
    .map_err(|e| es(e))??;
    let Some(data) = picked else { return Ok(None) };

    let stats = {
        let mut conn = db(&state);
        let bounds = get_kv(&conn, "window_bounds");
        let tx = match conn.transaction() {
            Ok(t) => t,
            Err(e) => return Err(es(e)),
        };
        let _ = tx.execute("DELETE FROM folders", []);
        let _ = tx.execute("DELETE FROM notes", []);
        let _ = tx.execute("DELETE FROM tasks", []);
        let _ = tx.execute("DELETE FROM settings", []);

        for f in &data.folders {
            let _ = tx.execute(
                "INSERT INTO folders(id, name, created_at, position) VALUES(?1, ?2, ?3, ?4)",
                params![f.id, f.name, f.created_at, f.position],
            );
        }
        for n in &data.notes {
            let _ = tx.execute(
                &format!(
                    "INSERT INTO notes({NOTE_COLS}) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)"
                ),
                params![
                    n.id,
                    n.folder_id,
                    n.title,
                    n.content,
                    n.pinned as i64,
                    n.favorite as i64,
                    n.trashed as i64,
                    n.created_at,
                    n.updated_at,
                    n.tags
                ],
            );
        }
        for t in &data.tasks {
            let subs = serde_json::to_string(&t.subtasks).unwrap_or_else(|_| "[]".into());
            let labels = serde_json::to_string(&t.labels).unwrap_or_else(|_| "[]".into());
            let _ = tx.execute(
            &format!(
                "INSERT INTO tasks({TASK_COLS}) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
            ),
            params![t.id, t.title, t.notes, t.done as i64, t.priority, t.due_at, t.remind_at, t.repeat, subs, labels, t.reminded as i64, t.position, t.created_at, t.completed_at, t.status],
        );
        }
        for img in &data.images {
            let Ok(raw) = b64_decode(&img.data) else { continue };
            if raw.is_empty() || raw.len() > IMAGE_MAX_BYTES {
                continue;
            }
            let _ = tx.execute(
                "INSERT OR REPLACE INTO note_images(id, note_id, mime, name, bytes, created_at) VALUES(?1, ?2, ?3, ?4, ?5, ?6)",
                params![img.id, img.note_id, img.mime, img.name, raw, img.created_at],
            );
        }
        for (k, v) in &data.settings {
            if k == "window_bounds" || k.starts_with("aiProv") {
                continue;
            }
            let _ = tx.execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![k, v],
            );
        }
        if let Some(b) = bounds {
            let _ = tx.execute(
                "INSERT INTO settings(key, value) VALUES('window_bounds', ?1)",
                params![b],
            );
        }
        tx.commit().map_err(es)?;
        get_stats_inner(&conn)?
    };

    // theme may have changed with the import — tell the UI to re-apply
    let _ = app.emit("settings-changed", ());
    Ok(Some(stats))
}

fn get_stats_inner(conn: &Connection) -> Result<Stats, String> {
    conn.query_row(
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
    .map_err(es)
}

// ------------------------------------------------------------- desktop os ----

pub fn app_data_dir_of(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(es)
}

#[tauri::command]
async fn data_dir(app: AppHandle) -> CmdResult<String> {
    Ok(app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default())
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
async fn export_note(_app: AppHandle, state: State<'_, Db>, id: String) -> CmdResult<Option<String>> {
    let content = {
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
        (sanitize_filename(&title), content)
    };
    let (file_name, content) = (format!("{}.md", content.0), content.1);
    tauri::async_runtime::spawn_blocking(move || {
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
    })
    .await
    .map_err(|e| es(e))?
}

#[tauri::command]
async fn export_note_html(title: String, html: String) -> CmdResult<Option<String>> {
    let file_name = format!("{}.html", sanitize_filename(&title));
    tauri::async_runtime::spawn_blocking(move || {
        let path = rfd::FileDialog::new()
            .set_title("Export note as web page")
            .set_file_name(&file_name)
            .add_filter("Web page", &["html"])
            .save_file();
        match path {
            Some(p) => {
                std::fs::write(&p, html.as_bytes()).map_err(es)?;
                Ok(Some(p.to_string_lossy().into_owned()))
            }
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| es(e))?
}

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[tauri::command]
async fn open_url(url: String) -> CmdResult<()> {
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
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(es)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(es)?;
    }
    Ok(())
}

#[tauri::command]
async fn reveal_data_dir(app: AppHandle) -> CmdResult<()> {
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
        std::process::Command::new("open")
            .arg(&dir)
            .spawn()
            .map_err(es)?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(es)?;
    }
    Ok(())
}

// --------------------------------------------------------- extras (v0.7) ----

/// Imports .md / .txt files from disk as new notes (title = file name).
#[tauri::command]
async fn import_notes(state: State<'_, Db>) -> CmdResult<Option<usize>> {
    // dialog + file reads on a worker thread — the window stays buttery
    let files = tauri::async_runtime::spawn_blocking(|| -> Result<Option<Vec<(String, String)>>, String> {
        let paths = rfd::FileDialog::new()
            .set_title("Choose Markdown or text files to import")
            .add_filter("Notes (Markdown & text)", &["md", "markdown", "txt"])
            .pick_files();
        let Some(paths) = paths else { return Ok(None) };
        let mut out: Vec<(String, String)> = Vec::new(); // (stem, raw)
        for p in paths {
            let Ok(raw) = std::fs::read_to_string(&p) else { continue };
            if raw.trim().is_empty() {
                continue;
            }
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Imported note".into());
            out.push((stem, raw));
        }
        Ok(Some(out))
    })
    .await
    .map_err(|e| es(e))??;
    let Some(files) = files else { return Ok(None) };
    if files.is_empty() {
        return Ok(None);
    }

    let conn = db(&state);
    let mut imported = 0usize;
    for (stem, raw) in files {
        let mut title = sanitize_filename(&stem);
        if title.is_empty() {
            title = "Imported note".into();
        }
        let (first_line, rest) = match raw.split_once('\n') {
            Some((a, b)) => (a.trim(), b.to_string()),
            None => (raw.trim(), String::new()),
        };
        // if the file starts with a markdown H1, prefer it as the title
        let (title, content) = if let Some(h) = first_line.strip_prefix("# ") {
            (h.trim().to_string(), rest.trim_start().to_string())
        } else {
            (title, raw)
        };
        let now = now_ms();
        conn.execute(
            "INSERT INTO notes(id, folder_id, title, content, pinned, favorite, trashed, created_at, updated_at)
             VALUES(?1, NULL, ?2, ?3, 0, 0, 0, ?4, ?5)",
            params![new_id("note"), title, content, now, now],
        )
        .map_err(es)?;
        imported += 1;
    }
    if imported == 0 {
        return Err("No readable notes found in the selected files".into());
    }
    Ok(Some(imported))
}

#[tauri::command]
async fn autostart_get(app: AppHandle) -> CmdResult<bool> {
    Ok(app.autolaunch().is_enabled().unwrap_or(false))
}

#[tauri::command]
async fn autostart_set(app: AppHandle, enabled: bool) -> CmdResult<()> {
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(es)
    } else {
        al.disable().map_err(es)
    }
}

#[tauri::command]
async fn clipboard_write(app: AppHandle, text: String) -> CmdResult<()> {
    app.clipboard().write_text(text).map_err(es)
}

#[tauri::command]
async fn clipboard_read(app: AppHandle) -> CmdResult<String> {
    app.clipboard().read_text().map_err(es)
}

// -------------------------------------------------------- reminder engine ----

/// Background loop: every 15 s it checks for tasks whose reminder time has
/// arrived, fires an OS notification and tells the UI. Works while Nook is
/// open (including minimized to the tray).
fn spawn_reminder_engine(app: AppHandle, db_path: PathBuf) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(15));
        let Ok(conn) = Connection::open(&db_path) else {
            continue;
        };
        let _ = conn.execute_batch("PRAGMA journal_mode = WAL;");
        let now = now_ms();
        let due: Vec<(String, String)> = match conn
            .prepare(
                "SELECT id, title FROM tasks
                 WHERE done = 0 AND reminded = 0 AND remind_at IS NOT NULL AND remind_at <= ?1",
            )
            .and_then(|mut s| {
                s.query_map(params![now], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map(|rows| rows.filter_map(|x| x.ok()).collect::<Vec<_>>())
            }) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for (id, title) in due {
            let _ = conn.execute("UPDATE tasks SET reminded = 1 WHERE id = ?1", params![id]);
            let _ = app
                .notification()
                .builder()
                .title("Nook — task reminder")
                .body(&title)
                .show();
            let _ = app.emit("reminder", serde_json::json!({ "id": id, "title": title }));
        }
    });
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

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ------------------------------------------------------------------ main ----

fn main() {
    tauri::Builder::default()
        // nookimg:// — serves note images straight from the local SQLite db.
        // <img src="nookimg://<id>"> in the preview never touches the disk
        // outside the app's own database.
        .register_asynchronous_uri_scheme_protocol("nookimg", |ctx, request, responder| {
            // v0.9: runs fully off the main thread now. Before, every image in
            // the preview locked the DB on the UI thread — clicking Preview
            // while anything else touched the database froze the whole window.
            let app = ctx.app_handle().clone();
            std::thread::spawn(move || {
                let id = request
                    .uri()
                    .path()
                    .trim_start_matches('/')
                    .to_string();
                let not_found = || -> tauri::http::Response<Cow<'static, [u8]>> {
                    tauri::http::Response::builder()
                        .status(404)
                        .header("Content-Type", "text/plain")
                        .body(Cow::Borrowed("image not found".as_bytes()))
                        .unwrap()
                };
                let response = if id.is_empty() || id.contains("..") || id.contains('/') {
                    not_found()
                } else {
                    let state = app.state::<Db>();
                    let guard = state.0.lock().unwrap_or_else(|p| p.into_inner());
                    let row = guard
                        .query_row(
                            "SELECT mime, bytes FROM note_images WHERE id = ?1",
                            params![id],
                            |r| Ok((r.get::<_, String>(0)?, r.get::<_, Vec<u8>>(1)?)),
                        )
                        .optional()
                        .ok()
                        .flatten();
                    drop(guard);
                    match row {
                        Some((mime, bytes)) => tauri::http::Response::builder()
                            .header("Content-Type", mime)
                            .header("Cache-Control", "max-age=31536000, immutable")
                            .body(Cow::Owned(bytes))
                            .unwrap(),
                        None => not_found(),
                    }
                };
                responder.respond(response);
            });
        })
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("Nook: cannot resolve app data directory");
            std::fs::create_dir_all(&dir)?;
            let db_path = dir.join("nook.db");
            let conn = init_db(&db_path).expect("Nook: cannot open database");
            migrate(&conn);

            let saved_bounds = get_kv(&conn, "window_bounds");

            app.manage(Db(Mutex::new(conn)));
            app.manage(recorder::RecorderState::new());
            app.manage(ai::AiState::new());

            let win = app
                .get_webview_window("main")
                .expect("Nook: main window missing");
            apply_window_state(&win, saved_bounds);
            let _ = win.show();
            let _ = win.set_focus();

            // tray icon — Show Nook / Quit
            let show_i = MenuItem::with_id(app, "open", "Show Nook", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit Nook", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;
            let mut tray = TrayIconBuilder::with_id("nook-tray")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            // reminders
            spawn_reminder_engine(app.handle().clone(), db_path);

            // v0.9: trash auto-cleanup — notes in the trash older than the
            // chosen number of days are removed on startup (setting: trashDays,
            // '0' = keep forever).
            {
                let state = app.state::<Db>();
                let conn = db(&state);
                let days: i64 = get_kv(&conn, "trashDays")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0);
                if days > 0 {
                    let cutoff = now_ms() - days * 86_400_000;
                    let _ = conn.execute(
                        "DELETE FROM notes WHERE trashed = 1 AND updated_at < ?1",
                        params![cutoff],
                    );
                    purge_orphan_images(&conn);
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                persist_window_state(window);
                let app = window.app_handle();
                let state: State<Db> = app.state();
                let close_to_tray = {
                    let conn = db(&state);
                    get_kv(&conn, "closeToTray").as_deref() == Some("1")
                };
                if close_to_tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
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
            duplicate_note,
            pin_note,
            favorite_note,
            move_note,
            trash_note,
            delete_note_forever,
            empty_trash,
            list_tasks,
            create_task,
            update_task,
            set_task,
            delete_task,
            clear_done_tasks,
            insert_note_image,
            delete_note_image,
            note_images,
            get_note_image_data,
            note_backlinks,
            get_setting,
            set_setting,
            get_stats,
            get_insights,
            export_backup,
            import_backup,
            list_chats,
            create_chat,
            rename_chat,
            delete_chat,
            get_chat_messages,
            add_chat_message,
            clear_chat_messages,
            import_notes,
            autostart_get,
            autostart_set,
            clipboard_write,
            clipboard_read,
            recorder::recorder_devices,
            recorder::recorder_status,
            recorder::recorder_start,
            recorder::recorder_stop,
            recorder::list_recordings,
            recorder::rename_recording,
            recorder::delete_recording,
            recorder::export_recording,
            ai::ai_list_models,
            ai::ai_complete,
            ai::ai_chat,
            ai::ai_stop,
            ai::ai_test,
            data_dir,
            export_note,
            export_note_html,
            open_url,
            reveal_data_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nook");
}
