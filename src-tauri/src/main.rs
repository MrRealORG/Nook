#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Nook desktop shell (Tauri v2 + Rust).
//!
//! Architecture: the Next.js app keeps running exactly as before (SSR pages,
//! API routes + Prisma + SQLite), but embedded: this Rust binary spawns the
//! Next.js standalone server on a free localhost port and opens a WebView2
//! window (Windows) / native webview (macOS/Linux) pointing at it.
//! Prisma's DATABASE_URL points at a writable app data dir so notes, pet and
//! arcade state survive across launches:
//!   Windows: %LOCALAPPDATA%\Nook\custom.db
//!   macOS:   ~/Library/Application Support/Nook/custom.db
//!   Linux:   ~/.local/share/Nook/custom.db

use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{copy, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::Duration;
use tauri::{
    generate_handler, Builder, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent, AppHandle,
};
use tauri::image::Image;
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use url::Url;

const SINGLE_INSTANCE_PORT: u16 = 17422;
const MAIN_LABEL: &str = "main";
const DATA_SUBDIR: &str = "Nook";
const SEED_DB_RESOURCE: &str = "resources/db/custom.db";

// Node runtime shipped INSIDE the installer (CI stages node.exe here), so the
// app no longer depends on Node.js being installed on the user's machine.
#[cfg(windows)]
const NODE_RUNTIME_REL: &str = "resources/node-runtime/node.exe";
#[cfg(not(windows))]
const NODE_RUNTIME_REL: &str = "resources/node-runtime/node";

/// Where the Next.js standalone build is staged inside the bundle.
const APP_STAGE_REL: &str = "resources/app";

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static SERVER_CHILD: OnceLock<Mutex<Option<std::process::Child>>> = OnceLock::new();
static WINDOW_STATE: OnceLock<Mutex<Option<WindowState>>> = OnceLock::new();
static MINIMIZE_TO_TRAY: OnceLock<Mutex<bool>> = OnceLock::new();
static SERVER_PORT: OnceLock<Mutex<u16>> = OnceLock::new();
static ALWAYS_ON_TOP: OnceLock<Mutex<bool>> = OnceLock::new();

const DESKTOP_PREFS_FILE: &str = "desktop-prefs.json";

#[derive(Clone, Serialize, Deserialize, Default)]
struct WindowState {
    maximized: bool,
    width: i32,
    height: i32,
}

#[derive(Clone, Serialize, Deserialize)]
struct WindowStatePayload {
    maximized: bool,
    width: i32,
    height: i32,
}

// ---------------------------------------------------------------------------
// Commands (callable from the frontend via `window.__TAURI__.core.invoke`)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_data_dir(app: AppHandle) -> Result<String, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|_| "could not resolve data dir".to_string())?
        .join(DATA_SUBDIR);
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn load_window_state() -> WindowState {
    WINDOW_STATE
        .get()
        .and_then(|s| s.lock().ok())
        .map(|g| g.clone().unwrap_or_default())
        .unwrap_or_default()
}

#[tauri::command]
fn save_window_state(state: WindowStatePayload) -> Result<(), String> {
    let dir = data_dir_path()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("window-state.json");
    let json = serde_json::to_string(&state).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    if let Ok(mut g) = WINDOW_STATE.get().unwrap().lock() {
        *g = Some(WindowState {
            maximized: state.maximized,
            width: state.width,
            height: state.height,
        });
    }
    Ok(())
}

#[tauri::command]
fn is_maximized(window: WebviewWindow) -> Result<bool, String> {
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn set_minimize_to_tray(on: bool) -> Result<(), String> {
    let mut g = MINIMIZE_TO_TRAY.get().unwrap().lock().unwrap();
    *g = on;
    Ok(())
}

#[tauri::command]
fn get_minimize_to_tray() -> bool {
    MINIMIZE_TO_TRAY.get().unwrap().lock().unwrap().clone()
}

#[tauri::command]
fn minimize_window(window: WebviewWindow) -> Result<(), String> {
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_window(window: WebviewWindow) -> Result<(), String> {
    window
        .unminimize()
        .and_then(|_| window.show())
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_maximize(window: WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|e| e.to_string())
    } else {
        window.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn close_window(app: AppHandle) -> Result<(), String> {
    // With "minimize to tray" enabled, the [X] button parks Nook in the
    // notification area instead of quitting (standard Windows tray-app
    // behaviour). Quit lives in the appearance menu / Ctrl+Q with tray off.
    let to_tray = MINIMIZE_TO_TRAY
        .get()
        .map(|s| s.lock().map(|g| *g).unwrap_or(false))
        .unwrap_or(false);
    if to_tray {
        if let Some(w) = app.get_webview_window(MAIN_LABEL) {
            let _ = w.hide();
            return Ok(());
        }
    }
    stop_server();
    app.exit(0);
    Ok(())
}

/// Open the Nook data folder (%LOCALAPPDATA%\Nook) in the file explorer —
/// used by the boot screen's "Open logs folder" button.
#[tauri::command]
fn open_data_folder() -> Result<(), String> {
    let dir = data_dir_path()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new("explorer");
        c.arg(&dir).creation_flags(0x00000008); // CREATE_NO_WINDOW
        c.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Command::new("xdg-open").arg(&dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        Command::new("cmd")
            .args(["/c", "start", "", &url])
            .creation_flags(0x00000008)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(&url).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
}

#[tauri::command]
fn set_auto_start(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let exe = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .to_string_lossy()
            .replace('\\', "\\\\");
        // Bind the Command to a local first: `Command::new(..).args(..)` returns
        // a &mut borrowed from a temporary, which would be dropped before `run`
        // is used below (E0716).
        let mut run = if enable {
            let mut c = Command::new("reg");
            c.args([
                "add",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Nook",
                "/t",
                "REG_SZ",
                "/d",
                &exe,
                "/f",
            ]);
            c
        } else {
            let mut c = Command::new("reg");
            c.args([
                "delete",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Nook",
                "/f",
            ]);
            c
        };
        run.creation_flags(0x00000008) // CREATE_NO_WINDOW
            .output()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Ok(())
    }
}

#[tauri::command]
fn get_desktop_prefs() -> Result<serde_json::Value, String> {
    let dir = data_dir_path()?;
    let path = dir.join(DESKTOP_PREFS_FILE);
    let txt = fs::read_to_string(path).unwrap_or_else(|_| "{}".to_string());
    let v: serde_json::Value = serde_json::from_str(&txt).unwrap_or(serde_json::json!({}));
    Ok(v)
}

#[tauri::command]
fn save_desktop_prefs(prefs: serde_json::Value) -> Result<(), String> {
    let dir = data_dir_path()?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join(DESKTOP_PREFS_FILE);
    // `merged` must be mut for as_object_mut(), and the fallback Map needs a
    // binding that outlives `obj` — an inline `&mut Map::new()` is a temporary
    // that would be dropped while still borrowed (E0596 + E0716).
    let mut merged: serde_json::Value = match fs::read_to_string(&path) {
        Ok(txt) => serde_json::from_str(&txt).unwrap_or(serde_json::json!({})),
        Err(_) => serde_json::json!({}),
    };
    let mut fallback = serde_json::Map::new();
    let obj = merged.as_object_mut().unwrap_or(&mut fallback);
    if let Some(map) = prefs.as_object() {
        for (k, v) in map {
            obj.insert(k.clone(), v.clone());
        }
    }
    let json = serde_json::to_string(&merged).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())?;
    // mirror the flags the Rust shell acts on
    if let Some(b) = prefs.get("minimizeToTray").and_then(|v| v.as_bool()) {
        let mut g = MINIMIZE_TO_TRAY.get().unwrap().lock().unwrap();
        *g = b;
    }
    if let Some(b) = prefs.get("alwaysOnTop").and_then(|v| v.as_bool()) {
        let mut g = ALWAYS_ON_TOP.get().unwrap().lock().unwrap();
        *g = b;
        if let Some(handle) = APP_HANDLE.get() {
            if let Some(window) = handle.get_webview_window(MAIN_LABEL) {
                let _ = window.set_always_on_top(b);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn set_always_on_top(on: bool) -> Result<(), String> {
    let mut g = ALWAYS_ON_TOP.get().unwrap().lock().unwrap();
    *g = on;
    if let Some(handle) = APP_HANDLE.get() {
        if let Some(window) = handle.get_webview_window(MAIN_LABEL) {
            window.set_always_on_top(on).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn get_always_on_top() -> bool {
    ALWAYS_ON_TOP.get().unwrap().lock().unwrap().clone()
}

#[tauri::command]
fn get_mcp_info() -> Result<serde_json::Value, String> {
    let port = SERVER_PORT
        .get()
        .and_then(|s| s.lock().ok().map(|g| *g))
        .unwrap_or(0);
    Ok(serde_json::json!({
        "port": port,
        "url": format!("http://127.0.0.1:{port}/api/mcp"),
        "tokenSet": true,
    }))
}

#[tauri::command]
fn get_auto_start() -> bool {
    #[cfg(windows)]
    {
        Command::new("reg")
            .args([
                "query",
                r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                "/v",
                "Nook",
            ])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

// ---------------------------------------------------------------------------
// Paths, database seeding, embedded Next.js server
// ---------------------------------------------------------------------------

fn app_handle() -> Result<AppHandle, String> {
    APP_HANDLE.get().cloned().ok_or_else(|| "app not ready".to_string())
}

fn data_dir_path() -> Result<PathBuf, String> {
    app_handle()?
        .path()
        .app_data_dir()
        .map_err(|_| "no data dir".to_string())
        .map(|d| d.join(DATA_SUBDIR))
}

fn resource_path(name: &str) -> Result<PathBuf, String> {
    app_handle()?
        .path()
        .resource_dir()
        .map_err(|_| format!("resource {name} not found"))?
        .join(name)
        .canonicalize()
        .map_err(|_| format!("resource {name} not found"))
}

/// Resolve the Node.js runtime that runs the embedded Next.js server.
/// Prefers the copy bundled inside the app (works on machines without Node),
/// then the resource dir, and finally whatever `node` is on PATH.
fn node_exe() -> String {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join(NODE_RUNTIME_REL));
        }
    }
    if let Ok(handle) = app_handle() {
        if let Ok(rd) = handle.path().resource_dir() {
            if !rd.as_os_str().is_empty() {
                candidates.push(rd.join(NODE_RUNTIME_REL));
                // Some layouts strip the "resources/" prefix when installing.
                let alt = rd
                    .join("node-runtime")
                    .join(Path::new(NODE_RUNTIME_REL).file_name().unwrap_or_default());
                candidates.push(alt);
            }
        }
    }
    for c in &candidates {
        if c.exists() {
            return c.to_string_lossy().into_owned();
        }
    }
    "node".to_string()
}

/// Push a message onto the boot splash (public/splash.html).
fn boot_state(text: &str) {
    if let Ok(js) = serde_json::to_string(text) {
        if let Some(w) = APP_HANDLE.get().and_then(|h| h.get_webview_window(MAIN_LABEL)) {
            let _ = w.eval(&format!(
                "window.__NOOK_BOOT__ && window.__NOOK_BOOT__.state({js}, true);"
            ));
        }
    }
}

/// Engine healthy — fade the splash out and load the real app.
fn boot_done(port: u16) {
    if let Some(w) = APP_HANDLE.get().and_then(|h| h.get_webview_window(MAIN_LABEL)) {
        let _ = w.eval(&format!(
            "window.__NOOK_BOOT__ && window.__NOOK_BOOT__.done({port});"
        ));
    }
}

/// Engine failed after every retry — show the friendly error card.
fn boot_fail(text: &str, hint: Option<&str>) {
    let msg = serde_json::to_string(text).unwrap_or_else(|_| "\"Nook could not start\"".into());
    let hint_js = hint
        .and_then(|h| serde_json::to_string(h).ok())
        .unwrap_or_else(|| "null".to_string());
    if let Some(w) = APP_HANDLE.get().and_then(|h| h.get_webview_window(MAIN_LABEL)) {
        let _ = w.eval(&format!(
            "window.__NOOK_BOOT__ && window.__NOOK_BOOT__.fail({msg}, {hint_js});"
        ));
    }
}

/// Where the embedded Next.js server lives. The installer now stages the whole
/// standalone build under `resources/app/` (see scripts/copy-standalone.mjs),
/// so the normal layout is `<install>/resources/app/.next/standalone/server.js`.
fn install_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let mut candidates: Vec<PathBuf> = vec![
        // staged bundle resources (the normal case)
        exe_dir.join(APP_STAGE_REL).join(".next/standalone/server.js"),
        exe_dir.join(".next/standalone/server.js"), // dev layout: files beside the exe
    ];
    if let Ok(Ok(resource_dir)) = app_handle().map(|a| a.path().resource_dir()) {
        if !resource_dir.as_os_str().is_empty() {
            candidates.push(resource_dir.join(APP_STAGE_REL).join(".next/standalone/server.js"));
            candidates.push(resource_dir.join(".next/standalone/server.js"));
            candidates.push(resource_dir.parent().map(|p| p.join(APP_STAGE_REL).join(".next/standalone/server.js")).unwrap_or_default());
        }
    }
    for c in &candidates {
        if c.as_os_str().is_empty() {
            continue;
        }
        if c.exists() {
            return Ok(c.parent().unwrap().to_path_buf());
        }
    }
    Ok(exe_dir)
}

fn stop_server() {
    if let Some(slot) = SERVER_CHILD.get() {
        if let Ok(mut g) = slot.lock() {
            if let Some(mut child) = g.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn spawn_server(port: u16) -> Result<(), String> {
    let dir = install_dir()?;
    let data_dir = data_dir_path()?;
    let db_path = data_dir.join("custom.db");

    fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;

    // Seed the SQLite vault on first run (notes, pet Mochi, folders, marketplace).
    if !db_path.exists() {
        if let Ok(seed) = resource_path(SEED_DB_RESOURCE) {
            let _ = fs::copy(&seed, &db_path);
        }
    }

    let database_url = format!("file:{}", db_path.to_string_lossy());

    #[cfg(windows)]
    use std::os::windows::process::CommandExt;

    // keep server.log from growing forever
    let log_path = data_dir.join("server.log");
    if let Ok(meta) = fs::metadata(&log_path) {
        if meta.len() > 2_000_000 {
            let _ = fs::write(&log_path, b"");
        }
    }

    let node = node_exe();
    let mut cmd = Command::new(&node);
    cmd.arg(".next/standalone/server.js")
        .current_dir(&dir)
        .env("DATABASE_URL", &database_url)
        .env("NODE_ENV", "production")
        .env("PORT", port.to_string())
        .env("NEXT_TELEMETRY_DISABLED", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x00000008); // CREATE_NO_WINDOW: no flashing console
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| {
            if node == "node" {
                format!("could not start the embedded Node runtime (`node` not found on PATH): {e}")
            } else {
                format!("could not start the bundled Node runtime at {node}: {e}")
            }
        })?;

    if let (Some(mut out), Some(mut err)) = (child.stdout.take(), child.stderr.take()) {
        let out_log = log_path.clone();
        thread::spawn(move || -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(out_log)?;
            copy(&mut out, &mut file)?;
            Ok(())
        });
        let err_log = log_path;
        thread::spawn(move || -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(err_log)?;
            copy(&mut err, &mut file)?;
            Ok(())
        });
    }

    SERVER_CHILD.get().unwrap().lock().unwrap().replace(child);
    Ok(())
}

fn find_free_port() -> u16 {
    TcpListener::bind(("127.0.0.1", 0))
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(3000)
}

fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.write_all(
        format!(
            "GET /api/health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
        )
        .as_bytes(),
    );
    let mut buf = [0u8; 512];
    match stream.read(&mut buf) {
        Ok(n) => String::from_utf8_lossy(&buf[..n]).contains(" 200 "),
        Err(_) => false,
    }
}

fn wait_for_server(port: u16) -> bool {
    for _ in 0..300 {
        // ~30 seconds per attempt
        if health_ok(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    false
}

/// Full boot sequence with automatic retries: start the embedded server,
/// wait for /api/health, then hand the webview from the splash to the app.
/// If the engine dies or never comes up, the splash shows a friendly error
/// card (with retry + open-logs buttons) instead of a raw WebView error page.
fn boot_sequence(mut port: u16) {
    for attempt in 1..=3u32 {
        boot_state("Warming up your cozy corner");
        match spawn_server(port) {
            Ok(()) => {
                if wait_for_server(port) {
                    if let Some(slot) = SERVER_PORT.get() {
                        if let Ok(mut g) = slot.lock() {
                            *g = port;
                        }
                    }
                    boot_done(port);
                    if let Some(handle) = APP_HANDLE.get() {
                        let _ = handle.emit("nook:ready", serde_json::json!({ "port": port }));
                    }
                    return;
                }
                // server never became healthy — kill it and retry
                boot_state("The engine is taking longer than usual — retrying");
            }
            Err(e) => {
                boot_state(&format!("Engine hiccup ({e}) — retrying"));
            }
        }
        stop_server();
        if attempt < 3 {
            thread::sleep(Duration::from_millis(900));
            // ports can end up in a weird TIME_WAIT state after a crash —
            // grab a fresh free port for the next attempt
            port = find_free_port();
        }
    }
    boot_fail(
        "Nook's engine didn't start after 3 attempts. Your notes are safe — try again, or open the logs folder to see what happened.",
        None,
    );
}

fn show_main_window() {
    if let Some(handle) = APP_HANDLE.get() {
        if let Some(window) = handle.get_webview_window(MAIN_LABEL) {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn main() {
    // ---- single instance: one Nook window at a time ----
    // A second launch pings the first one to focus its window, then exits.
    let listener = match TcpListener::bind(("127.0.0.1", SINGLE_INSTANCE_PORT)) {
        Ok(l) => l,
        Err(_) => {
            let _ = TcpStream::connect(("127.0.0.1", SINGLE_INSTANCE_PORT))
                .and_then(|mut s| s.write_all(b"focus-nook"));
            return;
        }
    };

    thread::spawn(move || {
        for mut stream in listener.incoming().flatten() {
            let _ = stream.read(&mut [0u8; 16]);
            show_main_window();
        }
    });

    Builder::default()
        .invoke_handler(generate_handler![
            get_data_dir,
            app_version,
            load_window_state,
            save_window_state,
            is_maximized,
            set_minimize_to_tray,
            get_minimize_to_tray,
            minimize_window,
            restore_window,
            toggle_maximize,
            close_window,
            open_data_folder,
            open_external,
            get_desktop_prefs,
            save_desktop_prefs,
            set_always_on_top,
            get_always_on_top,
            get_mcp_info,
            set_auto_start,
            get_auto_start,
        ])
        .setup(|app| {
            let _ = APP_HANDLE.set(app.handle().clone());
            let _ = SERVER_CHILD.set(Mutex::new(None));
            let _ = WINDOW_STATE.set(Mutex::new(None));
            let _ = MINIMIZE_TO_TRAY.set(Mutex::new(false));
            let _ = SERVER_PORT.set(Mutex::new(0));
            let _ = ALWAYS_ON_TOP.set(Mutex::new(false));

            // Data directory + seeded SQLite database.
            let data_dir = data_dir_path()?;
            fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
            if !data_dir.join("custom.db").exists() {
                if let Ok(seed) = resource_path(SEED_DB_RESOURCE) {
                    let _ = fs::copy(&seed, data_dir.join("custom.db"));
                }
            }

            // Remembered window size / maximized state.
            let mut state = WindowState::default();
            if let Ok(txt) = fs::read_to_string(data_dir.join("window-state.json")) {
                if let Ok(parsed) = serde_json::from_str::<WindowStatePayload>(&txt) {
                    state = WindowState {
                        maximized: parsed.maximized,
                        width: parsed.width.clamp(960, 3840),
                        height: parsed.height.clamp(640, 2160),
                    };
                }
            }

            // Apply persisted desktop prefs (tray + always-on-top).
            if let Ok(txt) = fs::read_to_string(data_dir.join(DESKTOP_PREFS_FILE)) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&txt) {
                    if let Some(b) = v.get("minimizeToTray").and_then(|x| x.as_bool()) {
                        let _ = MINIMIZE_TO_TRAY
                            .get()
                            .unwrap()
                            .lock()
                            .map(|mut g| *g = b);
                    }
                    if let Some(b) = v.get("alwaysOnTop").and_then(|x| x.as_bool()) {
                        let _ = ALWAYS_ON_TOP
                            .get()
                            .unwrap()
                            .lock()
                            .map(|mut g| *g = b);
                        if let Some(window) = app.get_webview_window(MAIN_LABEL) {
                            let _ = window.set_always_on_top(b);
                        }
                    }
                }
            }

            // Embedded Next.js server on a free localhost port. The webview
            // loads a branded splash first (public/splash.html, embedded via
            // frontendDist) and is handed over to the real app once the server
            // answers /api/health — see boot_sequence().
            let port = find_free_port();
            let _ = SERVER_PORT.get().unwrap().lock().map(|mut g| *g = port);

            // In dev (`cargo tauri dev`) load the Next dev server directly;
            // in release builds load the splash so the window shows instantly.
            let boot_url = if cfg!(debug_assertions) {
                WebviewUrl::External(Url::parse("http://localhost:3000").map_err(|e| e.to_string())?)
            } else {
                WebviewUrl::App("splash.html".into())
            };

            // The builder's returned handle is managed by the app runtime; the
            // local binding is intentionally not used here.
            WebviewWindowBuilder::new(app, MAIN_LABEL, boot_url)
                .title("Nook")
                .decorations(false) // the in-app title bar IS the window chrome now
                .inner_size(state.width as f64, state.height as f64)
                .min_inner_size(960.0, 640.0)
                .maximized(state.maximized)
                .resizable(true)
                .visible(true)
                .build()?;

            // Tray icon (Windows notification area / minimize-to-tray).
            let tray_icon =
                Image::from_bytes(include_bytes!("../icons/icon.png")).map_err(|e| e.to_string())?;
            TrayIconBuilder::with_id("nook-tray")
                .icon(tray_icon)
                .on_tray_icon_event(|_tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window();
                    }
                })
                .build(app)?;

            thread::spawn(move || {
                boot_sequence(port);
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(move |_app, event| {
            match event {
                RunEvent::ExitRequested { .. } => {
                    stop_server();
                }
                RunEvent::WindowEvent { label, event, .. }
                    if label == MAIN_LABEL =>
                {
                    match event {
                        // Hide to tray instead of keeping a minimized taskbar entry.
                        WindowEvent::Resized(_) => {
                            let to_tray = MINIMIZE_TO_TRAY
                                .get()
                                .map(|s| s.lock().map(|g| *g).unwrap_or(false))
                                .unwrap_or(false);
                            if to_tray {
                                if let Some(window) = _app.get_webview_window(MAIN_LABEL) {
                                    if window.is_minimized().unwrap_or(false) {
                                        let _ = window.hide();
                                    }
                                }
                            }
                        }
                        WindowEvent::Destroyed => {
                            stop_server();
                            _app.exit(0);
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        });
}
