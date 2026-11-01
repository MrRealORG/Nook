//! Nook desktop shell (Tauri v2): windows, tray, global hotkeys, widget, deep links,
//! autostart, updater, keyring — and the bridge from the webview to `nook-core`.

mod applog;
mod desktop;
mod keystore;
pub mod perf;

use base64::Engine;
use desktop::DesktopSettings;
use nook_core::ai::{AiState, ChatMsg};
use nook_core::server::{self, ServerHandle, ServerOpts};
use nook_core::{ApiRequest, Body, Ctx, Db};
use serde::Serialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

pub struct AppState {
    pub ctx: Ctx,
    pub server: Mutex<Option<ServerHandle>>,
    pub server_error: std::sync::Mutex<Option<String>>,
    pub quitting: AtomicBool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RustResponse {
    status: u16,
    content_type: String,
    body: String,
    base64: bool,
}

/// The single bridge for every `/api/*` call the UI makes.
#[tauri::command]
async fn api(state: State<'_, AppState>, method: String, url: String, body: Option<Value>) -> Result<RustResponse, String> {
    let req = ApiRequest::new(&method, &url, body);
    let res = nook_core::handle(&state.ctx, req).await;
    Ok(match res.body {
        Body::Json(v) => RustResponse { status: res.status, content_type: "application/json".into(), body: v.to_string(), base64: false },
        Body::Html(h) => RustResponse { status: res.status, content_type: "text/html".into(), body: h, base64: false },
        Body::Empty => RustResponse { status: res.status, content_type: "text/plain".into(), body: String::new(), base64: false },
        Body::Bytes { mime, data, .. } => RustResponse { status: res.status, content_type: mime, body: base64::engine::general_purpose::STANDARD.encode(data), base64: true },
    })
}

/// Streaming chat completion — tokens are pushed through a Tauri channel.
#[tauri::command]
async fn ai_stream(state: State<'_, AppState>, messages: Vec<ChatMsg>, on_event: Channel<Value>) -> Result<Value, String> {
    let cfg = state.ctx.ai.config(&state.ctx.db);
    if !cfg.is_usable() {
        return Ok(json!({ "ok": false, "error": "not-configured" }));
    }
    let ch = on_event.clone();
    match state.ctx.ai.chat_stream(&cfg, &messages, move |d| {
        let _ = ch.send(json!({ "type": "delta", "text": d }));
    }).await {
        Ok(text) => {
            let _ = on_event.send(json!({ "type": "done", "text": text }));
            Ok(json!({ "ok": true, "text": text }))
        }
        Err(e) => {
            let _ = on_event.send(json!({ "type": "error", "error": e }));
            Ok(json!({ "ok": false, "error": e }))
        }
    }
}

/// Native "Save as…" dialog + write. Returns the chosen path (None = cancelled).
#[tauri::command]
async fn save_file(app: AppHandle, name: String, data_b64: String) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_b64.as_bytes()).map_err(|e| e.to_string())?;
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_string());
    let mut dlg = app.dialog().file().set_file_name(&name);
    if let Some(e) = ext.as_deref() {
        dlg = dlg.add_filter(e.to_uppercase(), &[e]);
    }
    let picked = tauri::async_runtime::spawn_blocking(move || dlg.blocking_save_file()).await.map_err(|e| e.to_string())?;
    let Some(fp) = picked else { return Ok(None) };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn app_info(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let s = DesktopSettings::load(&state.ctx.db);
    let port = state.server.lock().await.as_ref().map(|h| h.port());
    let data_dir = app.path().app_data_dir().map(|p| p.display().to_string()).unwrap_or_default();
    Ok(json!({
        "version": app.package_info().version.to_string(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "dataDir": data_dir,
        "dbPath": app.path().app_data_dir().map(|p| p.join("nook.db").display().to_string()).unwrap_or_default(),
        "exePath": std::env::current_exe().map(|p| p.display().to_string()).unwrap_or_default(),
        "mcpRunning": port.is_some(),
        "mcpPort": port.unwrap_or(s.mcp_port),
        "mcpError": state.server_error.lock().ok().and_then(|e| e.clone()),
        "lanIp": lan_ip(),
        "updaterConfigured": desktop::updater_configured(&app),
        "perf": perf::cap_status(),
        "settings": s,
    }))
}

/// Best-effort LAN address (no packets are sent: UDP connect only picks a route).
fn lan_ip() -> Option<String> {
    let sock = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("192.0.2.1:9").ok()?;
    let ip = sock.local_addr().ok()?.ip();
    (!ip.is_loopback() && !ip.is_unspecified()).then(|| ip.to_string())
}

#[tauri::command]
async fn desktop_settings_set(app: AppHandle, state: State<'_, AppState>, patch: Value) -> Result<Value, String> {
    let before = DesktopSettings::load(&state.ctx.db);
    let after = before.merge(&patch);
    after.save(&state.ctx.db)?;
    if before.mcp_enabled != after.mcp_enabled || before.mcp_port != after.mcp_port || before.lan_share != after.lan_share {
        restart_server(&app).await;
    }
    if before.widget != after.widget {
        desktop::set_widget(&app, after.widget);
    }
    if before.autostart != after.autostart {
        desktop::set_autostart(&app, after.autostart);
    }
    if before.hotkeys != after.hotkeys {
        desktop::register_hotkeys(&app, after.hotkeys);
    }
    if before.glass != after.glass {
        desktop::apply_glass(&app, &after.glass);
    }
    if before.cpu_cap != after.cpu_cap || before.cpu_cap_on != after.cpu_cap_on {
        let cap = after.cpu_cap_on.then_some(after.cpu_cap);
        if let Ok(dir) = app.path().app_data_dir() {
            perf::write_cap(&dir, cap);
        }
        perf::set_cap(cap);
        perf::adopt_children();
    }
    if before.widget_on_top != after.widget_on_top {
        desktop::set_widget_on_top(&app, after.widget_on_top);
    }
    app_info(app.clone(), state).await
}

#[tauri::command]
async fn widget_toggle(app: AppHandle, state: State<'_, AppState>, show: Option<bool>) -> Result<bool, String> {
    let mut s = DesktopSettings::load(&state.ctx.db);
    s.widget = show.unwrap_or(!s.widget);
    s.save(&state.ctx.db)?;
    desktop::set_widget(&app, s.widget);
    Ok(s.widget)
}

/// Deep links that arrived before the UI was listening (cold start via nook://…).
#[tauri::command]
fn pending_deep_links() -> Vec<String> {
    std::mem::take(&mut *desktop::pending_links().lock().unwrap_or_else(|e| e.into_inner()))
}

/// Bring the main window forward (from the widget or tray), optionally routing to a view.
#[tauri::command]
fn focus_main(app: AppHandle, route: Option<String>) {
    desktop::show_main(&app);
    if let Some(r) = route {
        let _ = app.emit_to("main", "nook://route", r);
    }
}

/// Tell every window that data changed (the widget refreshes, the main window re-syncs).
#[tauri::command]
fn broadcast(app: AppHandle, event: String, payload: Option<Value>) {
    let _ = app.emit(&format!("nook://{event}"), payload.unwrap_or(Value::Null));
}

#[tauri::command]
fn set_glass(app: AppHandle, mode: String) -> Result<String, String> {
    Ok(desktop::apply_glass(&app, &mode))
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Value, String> {
    desktop::check_update(&app).await
}

#[tauri::command]
async fn install_update(app: AppHandle, on_event: Channel<Value>) -> Result<(), String> {
    desktop::install_update(&app, on_event).await
}

// ------------------------------------------------------------------ 1.3.1: startup, logs, crash

static START_HIDDEN: AtomicBool = AtomicBool::new(false);
static READY: AtomicBool = AtomicBool::new(false);

/// The UI painted its first decided frame (onboarding OR the app — never both): show the window
/// now. A fallback in `setup` shows it anyway after a few seconds if the UI never calls this.
#[tauri::command]
fn app_ready(app: AppHandle) {
    if !READY.swap(true, Ordering::SeqCst) {
        log::info!("ui ready");
        if !START_HIDDEN.load(Ordering::SeqCst) {
            desktop::show_main(&app);
        }
        desktop::window_state_changed(&app);
    }
}

/// The web UI's log lines go to the same rotating file as Rust's.
#[tauri::command]
fn log_write(level: String, msg: String, source: Option<String>) {
    applog::write(&level, source.as_deref().unwrap_or("ui"), &msg);
}

#[tauri::command]
fn logs_since(since: u64) -> Vec<applog::Line> {
    applog::since(since)
}

#[tauri::command]
fn logs_clear() {
    applog::clear();
}

#[tauri::command]
fn logs_tail(max: Option<usize>) -> String {
    applog::tail(max.unwrap_or(64 * 1024))
}

#[tauri::command]
fn logs_set_verbose(on: bool) {
    applog::set_verbose(on);
    log::info!("verbose logging {}", if on { "on" } else { "off" });
}

#[tauri::command]
fn open_log_folder(app: AppHandle) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = applog::current_dir().ok_or("no log folder")?;
    app.opener().open_path(dir.display().to_string(), None::<&str>).map_err(|e| e.to_string())?;
    Ok(dir.display().to_string())
}

/// The previous run's panic, if it crashed (offered as a bug report on the next launch).
#[tauri::command]
fn take_crash() -> Option<String> {
    applog::take_crash()
}

/// OS / versions for bug reports (no settings, no secrets).
#[tauri::command]
fn system_info(app: AppHandle) -> Value {
    json!({
        "version": app.package_info().version.to_string(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "osVersion": os_version(),
        "webview": tauri::webview_version().unwrap_or_default(),
        "logDir": applog::current_dir().map(|p| p.display().to_string()),
        "perf": perf::cap_status(),
    })
}

fn os_version() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW: never flash a console window from the GUI app.
        std::process::Command::new("cmd").args(["/C", "ver"]).creation_flags(0x0800_0000).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default()
    }
    #[cfg(not(windows))]
    {
        std::fs::read_to_string("/etc/os-release").ok().and_then(|s| s.lines().find(|l| l.starts_with("PRETTY_NAME=")).map(|l| l[12..].trim_matches('"').to_string())).unwrap_or_default()
    }
}

/// Open the vault, retrying briefly: on Windows a previous instance that is still shutting down
/// (or an antivirus scan) can hold the file for a moment.
fn open_vault(path: &std::path::Path) -> Result<Db, String> {
    let mut last = String::new();
    for attempt in 0..5 {
        match Db::open(path) {
            Ok(db) => return Ok(db),
            Err(e) => {
                last = e.to_string();
                log::warn!("vault open attempt {} failed: {last}", attempt + 1);
                std::thread::sleep(std::time::Duration::from_millis(300 * (attempt + 1)));
            }
        }
    }
    Err(last)
}

#[tauri::command]
fn quit_app(app: AppHandle, state: State<'_, AppState>) {
    state.quitting.store(true, Ordering::SeqCst);
    app.exit(0);
}

pub async fn restart_server(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(h) = state.server.lock().await.take() {
        h.stop().await;
    }
    let s = DesktopSettings::load(&state.ctx.db);
    if let Ok(mut e) = state.server_error.lock() {
        *e = None;
    }
    if !s.mcp_enabled {
        return;
    }
    let opts = ServerOpts { host: if s.lan_share { "0.0.0.0".into() } else { "127.0.0.1".into() }, port: s.mcp_port, full_api: false, any_origin: false };
    match server::start(state.ctx.clone(), opts).await {
        Ok(h) => *state.server.lock().await = Some(h),
        Err(e) => {
            log::error!("local server failed: {e}");
            if let Ok(mut slot) = state.server_error.lock() {
                *slot = Some(e);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `nook --mcp-stdio` turns the app binary into the MCP stdio bridge (no window, no tray).
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--mcp-stdio") {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
        rt.block_on(nook_core::bridge::run_stdio(args.into_iter().skip(1).filter(|a| a != "--mcp-stdio").collect()));
        return;
    }
    let start_hidden = args.iter().any(|a| a == "--hidden");
    START_HIDDEN.store(start_hidden, Ordering::SeqCst);

    // CPU budget FIRST: when the (opt-in, background-only) cap is enabled the Job Object must
    // exist before Tauri creates the webview so the WebView2 processes are born inside it. The
    // setting lives in a tiny file next to the vault because the vault is opened later.
    let early_dir = perf::early_data_dir("com.realhackers.nook");
    applog::init(early_dir.as_deref());
    log::info!("Nook {} starting ({} {})", env!("CARGO_PKG_VERSION"), std::env::consts::OS, std::env::consts::ARCH);
    let cap = if std::env::var_os("NOOK_NO_CPU_CAP").is_some() { None } else { early_dir.as_deref().and_then(perf::read_cap) };
    perf::apply_at_startup(cap, false);

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            desktop::show_main(app);
            if let Some(url) = argv.iter().find(|a| a.starts_with("nook://")) {
                let _ = app.emit_to("main", "nook://deep-link", url.clone());
            }
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::default().with_denylist(&["quick"]).build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().with_handler(desktop::on_shortcut).build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        // pubkey + GitHub Releases endpoint come from tauri.conf.json `plugins.updater`
        .plugin(tauri_plugin_updater::Builder::new().build());

    let result = builder
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            if let Err(e) = std::fs::create_dir_all(&dir) {
                log::error!("cannot create app data dir {}: {e}", dir.display());
            }
            // v1.4 meetings: recordings live next to the vault (%APPDATA%/com.realhackers.nook/meetings),
            // never in %TEMP% where disk cleanup could delete them before they are transcribed
            nook_core::meeting::set_dir(dir.join("meetings"));
            let db = match open_vault(&dir.join("nook.db")) {
                Ok(db) => db,
                Err(e) => {
                    log::error!("vault failed to open: {e}");
                    use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
                    app.dialog()
                        .message(format!("Nook couldn't open your vault:\n{e}\n\nLogs: {}", applog::current_dir().map(|p| p.display().to_string()).unwrap_or_default()))
                        .title("Nook")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                    return Err(format!("vault: {e}").into());
                }
            };
            nook_core::tlapps::set_icon_dir(dir.join("icons"));
            let keys = keystore::OsKeyStore::new(dir.clone());
            let ctx = Ctx::new(db, Arc::new(AiState::new(Box::new(keys))));
            app.manage(AppState { ctx, server: Mutex::new(None), server_error: std::sync::Mutex::new(None), quitting: AtomicBool::new(false) });

            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { restart_server(&handle).await });

            let s = DesktopSettings::load(&app.state::<AppState>().ctx.db);
            desktop::build_tray(app.handle())?;
            desktop::register_hotkeys(app.handle(), s.hotkeys);
            desktop::apply_glass(app.handle(), &s.glass);
            if s.widget {
                desktop::set_widget(app.handle(), true);
            }
            desktop::register_deep_links(app.handle());
            // Timelens: the background tracker + the minute maintenance loop (reminders, goals, backups)
            // v1.4: forward tracker events (`timelens-live` on a foreground change, `shield-bounce`
            // / `shield-nudge` when a rule fires) to every window as `nook://<kind>` so Timelens,
            // Rules and the widget update live instead of polling.
            {
                let h = app.handle().clone();
                nook_core::timelens::set_listener(move |kind, v| {
                    let _ = h.emit(&format!("nook://{kind}"), v);
                });
            }
            nook_core::timelens::start(app.state::<AppState>().ctx.db.clone(), nook_core::timelens::platform_sampler());
            desktop::start_maintenance(app.handle());
            desktop::start_perf_watch(app.handle());
            // The window starts hidden (tauri.conf `visible: false`); the UI calls `app_ready` after
            // its first decided frame so the user never sees the app flash before onboarding.
            // Fallback: show it anyway if the UI has not said so within 6 s.
            if !start_hidden {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    if !READY.load(Ordering::SeqCst) {
                        log::warn!("ui did not report ready within 6 s; showing the window anyway");
                        let h2 = h.clone();
                        let _ = h.run_on_main_thread(move || desktop::show_main(&h2));
                    }
                });
            }
            desktop::window_state_changed(app.handle());
            log::info!("setup done");
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Focused(_) | tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Destroyed) {
                desktop::window_state_changed(window.app_handle());
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    let state = window.app_handle().state::<AppState>();
                    let close_to_tray = DesktopSettings::load(&state.ctx.db).close_to_tray;
                    if close_to_tray && !state.quitting.load(Ordering::SeqCst) {
                        api.prevent_close();
                        let _ = window.hide();
                        desktop::window_state_changed(window.app_handle());
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            api,
            ai_stream,
            save_file,
            app_info,
            desktop_settings_set,
            widget_toggle,
            pending_deep_links,
            focus_main,
            broadcast,
            set_glass,
            check_update,
            install_update,
            quit_app,
            app_ready,
            log_write,
            logs_since,
            logs_clear,
            logs_tail,
            logs_set_verbose,
            open_log_folder,
            take_crash,
            system_info
        ])
        .run(tauri::generate_context!());
    if let Err(e) = result {
        log::error!("Nook exited with an error: {e}");
        eprintln!("error while running Nook: {e}");
        std::process::exit(1);
    }
}
