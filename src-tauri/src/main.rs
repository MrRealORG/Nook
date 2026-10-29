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
    stop_server();
    app.exit(0);
    Ok(())
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

/// Where the installable app lives: next to the exe (Windows MSI layout) or in
/// the bundle resource dir (macOS). Ship `.next/`, `public/` and prod
/// `node_modules/` alongside `Nook.exe` — see docs/DESKTOP.md.
fn install_dir() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe_dir = exe.parent().unwrap_or(Path::new(".")).to_path_buf();
    let mut candidates: Vec<PathBuf> = vec![
        exe_dir.join(".next/standalone/server.js"),
        exe_dir.join("resources/app/.next/standalone/server.js"),
    ];
    if let Ok(Ok(resource_dir)) = app_handle()
        .map(|a| a.path().resource_dir())
    {
        if !resource_dir.as_os_str().is_empty() {
            candidates.push(resource_dir.join(".next/standalone/server.js"));
        }
    }
    for c in &candidates {
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

    let mut cmd = Command::new("node");
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
        .map_err(|e| format!("could not start Nook server — is Node.js installed and on PATH? ({e})"))?;

    let log_path = data_dir.join("server.log");
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

fn wait_for_server(port: u16) {
    for _ in 0..300 {
        // ~30 seconds
        if health_ok(port) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
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

            // Embedded Next.js server on a free localhost port.
            let port = find_free_port();
            let _ = SERVER_PORT.get().unwrap().lock().map(|mut g| *g = port);
            spawn_server(port)?;

            let url = Url::parse(&format!("http://127.0.0.1:{port}")).map_err(|e| e.to_string())?;

            // The builder's returned handle is managed by the app runtime; the
            // window is shown later via show_main_window() once /api/health
            // answers, so the local binding is intentionally not used here.
            WebviewWindowBuilder::new(app, MAIN_LABEL, WebviewUrl::External(url))
                .title("Nook")
                .inner_size(state.width as f64, state.height as f64)
                .min_inner_size(960.0, 640.0)
                .maximized(state.maximized)
                .resizable(true)
                .visible(false) // hidden until /api/health answers
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

            let handle = app.handle().clone();
            thread::spawn(move || {
                wait_for_server(port);
                show_main_window();
                let _ = handle.emit("nook:ready", serde_json::json!({ "port": port }));
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
