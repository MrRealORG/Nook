//! Desktop comforts: settings, tray, global hotkeys, the desktop widget window,
//! Mica/acrylic, autostart, deep links and the (opt-in) updater.

use crate::AppState;
use nook_core::Db;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

pub const HOTKEY_CAPTURE: &str = "CommandOrControl+Alt+N";
pub const HOTKEY_TOGGLE: &str = "CommandOrControl+Alt+H";
pub const HOTKEY_TIMELENS: &str = "CommandOrControl+Alt+P";
pub const HOTKEY_CLIPBOARD: &str = "CommandOrControl+Alt+V";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct DesktopSettings {
    pub mcp_enabled: bool,
    pub mcp_port: u16,
    /// bind the local server on all interfaces so teammates/workers on the LAN can reach
    /// share links and the team room (MCP then really wants a token)
    pub lan_share: bool,
    pub widget: bool,
    pub autostart: bool,
    pub hotkeys: bool,
    pub close_to_tray: bool,
    /// "off" | "mica" | "acrylic"
    pub glass: String,
    pub auto_update: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        DesktopSettings {
            mcp_enabled: true,
            mcp_port: nook_core::mcp::DEFAULT_PORT,
            lan_share: false,
            widget: false,
            autostart: false,
            hotkeys: true,
            close_to_tray: true,
            glass: "off".into(),
            auto_update: false,
        }
    }
}

impl DesktopSettings {
    pub fn load(db: &Db) -> Self {
        db.setting_get("desktop").and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
    }
    pub fn save(&self, db: &Db) -> Result<(), String> {
        db.setting_put("desktop", &serde_json::to_string(self).map_err(|e| e.to_string())?)
    }
    pub fn merge(&self, patch: &Value) -> Self {
        let mut v = serde_json::to_value(self).unwrap_or(json!({}));
        if let (Some(obj), Some(p)) = (v.as_object_mut(), patch.as_object()) {
            for (k, val) in p {
                obj.insert(k.clone(), val.clone());
            }
        }
        let mut out: DesktopSettings = serde_json::from_value(v).unwrap_or_else(|_| self.clone());
        if out.mcp_port < 1024 {
            out.mcp_port = nook_core::mcp::DEFAULT_PORT;
        }
        if !["off", "mica", "acrylic"].contains(&out.glass.as_str()) {
            out.glass = "off".into();
        }
        out
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn toggle_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
            let _ = w.hide();
        } else {
            show_main(app);
        }
    }
}

// ------------------------------------------------------------------ tray

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show / hide Nook", true, Some(HOTKEY_TOGGLE))?;
    let capture = MenuItem::with_id(app, "capture", "Quick capture", true, Some(HOTKEY_CAPTURE))?;
    let widget = MenuItem::with_id(app, "widget", "Toggle desktop widget", true, None::<&str>)?;
    let tl_status = MenuItem::with_id(app, "tl-status", "Timelens: starting…", false, None::<&str>)?;
    let tl_pause = MenuItem::with_id(app, "tl-pause", "Pause Timelens", true, Some(HOTKEY_TIMELENS))?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Nook", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &capture, &widget, &sep3, &tl_status, &tl_pause, &sep, &settings, &sep2, &quit])?;
    app.manage(TrayItems { tl_status: tl_status.clone(), tl_pause: tl_pause.clone() });
    let mut tray = TrayIconBuilder::with_id("nook-tray")
        .tooltip("Nook")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => toggle_main(app),
            "capture" => quick_capture(app),
            "tl-pause" => toggle_timelens(app),
            "widget" => {
                let state = app.state::<AppState>();
                let mut s = DesktopSettings::load(&state.ctx.db);
                s.widget = !s.widget;
                let _ = s.save(&state.ctx.db);
                set_widget(app, s.widget);
                let _ = app.emit("nook://desktop-settings", ());
            }
            "settings" => {
                show_main(app);
                let _ = app.emit_to("main", "nook://route", "settings:desktop");
            }
            "quit" => {
                app.state::<AppState>().quitting.store(true, std::sync::atomic::Ordering::SeqCst);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                toggle_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

/// Tray entries refreshed by the maintenance loop.
pub struct TrayItems {
    pub tl_status: MenuItem<tauri::Wry>,
    pub tl_pause: MenuItem<tauri::Wry>,
}

/// Pause/resume Timelens from the tray or the hotkey; tells every window.
pub fn toggle_timelens(app: &AppHandle) {
    let state = app.state::<AppState>();
    let paused = nook_core::timelens::set_paused(&state.ctx.db.conn(), None).unwrap_or(false);
    refresh_tray(app);
    let _ = app.emit("nook://data-changed", json!({ "source": "tray", "timelens": true }));
    notify(app, if paused { "Timelens paused" } else { "Timelens resumed" }, if paused { "Nothing is being recorded." } else { "Tracking your day again." });
}

/// Update the tray tooltip + Timelens entries.
pub fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (text, paused) = {
        let c = state.ctx.db.conn();
        (nook_core::timelens::tray_status(&c), nook_core::timelens::load_config(&c).paused)
    };
    if let Some(items) = app.try_state::<TrayItems>() {
        let _ = items.tl_status.set_text(&text);
        let _ = items.tl_pause.set_text(if paused { "Resume Timelens" } else { "Pause Timelens" });
    }
    if let Some(tray) = app.tray_by_id("nook-tray") {
        let _ = tray.set_tooltip(Some(format!("Nook — {text}")));
    }
}

/// Native (Windows toast) notification.
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    use tauri_plugin_notification::NotificationExt;
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Every minute: reminders, Timelens goals/limits, auto-backup → native notifications.
pub fn start_maintenance(app: &AppHandle) {
    let h = app.clone();
    std::thread::Builder::new()
        .name("nook-maintenance".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(20));
            let events = {
                let state = h.state::<AppState>();
                nook_core::ext::maintenance_db(&state.ctx.db)
            };
            let mut reminders = false;
            for e in &events {
                notify(&h, e["title"].as_str().unwrap_or("Nook"), e["body"].as_str().unwrap_or(""));
                reminders |= e["kind"] == "reminder";
            }
            if reminders {
                let _ = h.emit("nook://data-changed", json!({ "source": "reminders" }));
            }
            refresh_tray(&h);
            std::thread::sleep(std::time::Duration::from_secs(40));
        })
        .ok();
}

// ------------------------------------------------------------------ hotkeys

pub fn quick_capture(app: &AppHandle) {
    let state = app.state::<AppState>();
    if DesktopSettings::load(&state.ctx.db).widget {
        set_widget(app, true);
        if let Some(w) = app.get_webview_window("widget") {
            let _ = w.show();
            let _ = w.set_focus();
        }
        let _ = app.emit_to("widget", "nook://capture", ());
    } else {
        show_main(app);
        let _ = app.emit_to("main", "nook://capture", ());
    }
}

pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
    if event.state() != ShortcutState::Pressed {
        return;
    }
    if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyN)
        || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::SUPER | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyN)
    {
        quick_capture(app);
    } else if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyP)
        || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::SUPER | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyP)
    {
        toggle_timelens(app);
    } else if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyV)
        || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::SUPER | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyV)
    {
        // clipboard quick-capture: the UI reads the clipboard (it has the permission prompt-free API)
        quick_capture(app);
        let target = if DesktopSettings::load(&app.state::<AppState>().ctx.db).widget { "widget" } else { "main" };
        let _ = app.emit_to(target, "nook://capture-clipboard", ());
    } else {
        toggle_main(app);
    }
}

pub fn register_hotkeys(app: &AppHandle, on: bool) {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    if !on {
        return;
    }
    for k in [HOTKEY_CAPTURE, HOTKEY_TOGGLE, HOTKEY_TIMELENS, HOTKEY_CLIPBOARD] {
        if let Err(e) = gs.register(k) {
            // another app may own the combo — never fatal
            log::warn!("could not register {k}: {e}");
        }
    }
}

// ------------------------------------------------------------------ widget

/// Create/destroy the frameless, transparent desktop widget. Destroying (not hiding) it keeps
/// idle RAM low when it is off; the window-state plugin remembers its position and size.
pub fn set_widget(app: &AppHandle, on: bool) {
    let existing = app.get_webview_window("widget");
    match (on, existing) {
        (true, Some(w)) => {
            let _ = w.show();
        }
        (true, None) => {
            let b = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("widget.html".into()))
                .title("Nook widget")
                .inner_size(340.0, 540.0)
                .min_inner_size(260.0, 320.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(true)
                .skip_taskbar(true)
                .always_on_bottom(true)
                .visible_on_all_workspaces(true)
                .disable_drag_drop_handler();
            match b.build() {
                Ok(w) => {
                    use tauri_plugin_window_state::{StateFlags, WindowExt};
                    let _ = w.restore_state(StateFlags::POSITION | StateFlags::SIZE);
                    // remember where it was dragged/resized right away (not only on clean exit)
                    let h = app.clone();
                    let last = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
                    w.on_window_event(move |ev| {
                        if matches!(ev, tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) {
                            let now = nook_core::db::now_ms();
                            if now - last.swap(now, std::sync::atomic::Ordering::SeqCst) > 400 {
                                use tauri_plugin_window_state::AppHandleExt;
                                let _ = h.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
                            }
                        }
                    });
                }
                Err(e) => log::error!("widget window failed: {e}"),
            }
        }
        (false, Some(w)) => {
            use tauri_plugin_window_state::{AppHandleExt, StateFlags};
            let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
            let _ = w.destroy();
        }
        (false, None) => {}
    }
}

// ------------------------------------------------------------------ glass (Mica / acrylic)

/// Apply a native backdrop to the main window. Returns the mode actually in effect.
pub fn apply_glass(app: &AppHandle, mode: &str) -> String {
    let Some(w) = app.get_webview_window("main") else { return "off".into() };
    let applied = glass_impl(&w, mode);
    let _ = app.emit_to("main", "nook://glass", applied.clone());
    applied
}

#[cfg(windows)]
fn glass_impl(w: &tauri::WebviewWindow, mode: &str) -> String {
    use window_vibrancy::{apply_acrylic, apply_mica, clear_acrylic, clear_mica};
    let _ = clear_mica(w);
    let _ = clear_acrylic(w);
    match mode {
        "mica" => match apply_mica(w, None) {
            Ok(_) => "mica".into(),
            // Windows 10 has no Mica → fall back to acrylic
            Err(_) => match apply_acrylic(w, Some((18, 18, 22, 160))) {
                Ok(_) => "acrylic".into(),
                Err(_) => "off".into(),
            },
        },
        "acrylic" => match apply_acrylic(w, Some((18, 18, 22, 160))) {
            Ok(_) => "acrylic".into(),
            Err(_) => "off".into(),
        },
        _ => "off".into(),
    }
}

#[cfg(not(windows))]
fn glass_impl(_w: &tauri::WebviewWindow, _mode: &str) -> String {
    "off".into()
}

// ------------------------------------------------------------------ autostart

pub fn set_autostart(app: &AppHandle, on: bool) {
    use tauri_plugin_autostart::ManagerExt;
    let al = app.autolaunch();
    let r = if on { al.enable() } else { al.disable() };
    if let Err(e) = r {
        log::warn!("autostart toggle failed: {e}");
    }
}

// ------------------------------------------------------------------ deep links

pub fn register_deep_links(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    #[cfg(any(windows, target_os = "linux"))]
    {
        // registers nook:// for the installed exe (no-op when already registered)
        let _ = app.deep_link().register_all();
    }
    let h = app.clone();
    app.deep_link().on_open_url(move |ev| {
        for url in ev.urls() {
            show_main(&h);
            let _ = h.emit_to("main", "nook://deep-link", url.to_string());
        }
    });
    // cold start via a link: the webview isn't listening yet, so park the URLs until the UI
    // asks for them (`pending_deep_links`) — emitting here alone would lose them
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        let mut p = pending_links().lock().unwrap_or_else(|e| e.into_inner());
        p.extend(urls.iter().map(|u| u.to_string()));
    }
}

pub fn pending_links() -> &'static std::sync::Mutex<Vec<String>> {
    static P: std::sync::OnceLock<std::sync::Mutex<Vec<String>>> = std::sync::OnceLock::new();
    P.get_or_init(|| std::sync::Mutex::new(Vec::new()))
}

// ------------------------------------------------------------------ updater

/// Public key baked in at build time (`NOOK_UPDATER_PUBKEY`). Without it the updater stays
/// disabled — unsigned builds can never self-update.
pub fn updater_pubkey() -> Option<String> {
    option_env!("NOOK_UPDATER_PUBKEY").map(str::trim).filter(|k| !k.is_empty()).map(String::from)
}

pub const UPDATE_ENDPOINT: &str = "https://github.com/MrRealORG/Nook/releases/latest/download/latest.json";

pub async fn check_update(app: &AppHandle) -> Result<Value, String> {
    if updater_pubkey().is_none() {
        return Ok(json!({ "configured": false }));
    }
    use tauri_plugin_updater::UpdaterExt;
    let url = tauri::Url::parse(UPDATE_ENDPOINT).map_err(|e| e.to_string())?;
    let up = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
    match up.check().await.map_err(|e| e.to_string())? {
        Some(u) => Ok(json!({ "configured": true, "available": true, "version": u.version, "notes": u.body, "date": u.date.map(|d| d.to_string()) })),
        None => Ok(json!({ "configured": true, "available": false })),
    }
}

pub async fn install_update(app: &AppHandle) -> Result<(), String> {
    if updater_pubkey().is_none() {
        return Err("updates are not configured for this build".into());
    }
    use tauri_plugin_updater::UpdaterExt;
    let url = tauri::Url::parse(UPDATE_ENDPOINT).map_err(|e| e.to_string())?;
    let up = app.updater_builder().endpoints(vec![url]).map_err(|e| e.to_string())?.build().map_err(|e| e.to_string())?;
    let Some(u) = up.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
    u.download_and_install(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    app.restart();
}
