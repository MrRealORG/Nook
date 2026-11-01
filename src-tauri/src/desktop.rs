//! Desktop comforts: settings, tray, global hotkeys, the desktop widget window,
//! Mica/acrylic, autostart, deep links and the (opt-in) updater.

use crate::AppState;
use nook_core::Db;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutEvent, ShortcutState};

pub const HOTKEY_CAPTURE: &str = "CommandOrControl+Alt+N";
pub const HOTKEY_TOGGLE: &str = "CommandOrControl+Alt+H";
pub const HOTKEY_TIMELENS: &str = "CommandOrControl+Alt+P";
pub const HOTKEY_CLIPBOARD: &str = "CommandOrControl+Alt+V";
/// v1.4: start / stop a meeting recording from anywhere
pub const HOTKEY_MEETING: &str = "CommandOrControl+Alt+M";

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
    /// background-only CPU cap for the Nook process tree (Job Object), % of the machine, 5–50.
    /// Opt-in since 1.3.1 and only applied while no window is on screen.
    pub cpu_cap: u8,
    pub cpu_cap_on: bool,
    /// keep the desktop widget above other windows (otherwise it sits on the desktop)
    pub widget_on_top: bool,
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
            cpu_cap: crate::perf::DEFAULT_CAP_PCT,
            cpu_cap_on: false,
            widget_on_top: false,
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
        out.cpu_cap = crate::perf::clamp_cap(out.cpu_cap);
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
            window_state_changed(app);
        } else {
            show_main(app);
        }
    }
}

// ------------------------------------------------------------------ CPU budget

static BACKGROUND: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(2); // 2 = unknown

/// Main window shown/hidden/minimised/focused: tell the UI (it pauses all polling and animation
/// while not visible) and flip EcoQoS for the whole Nook tree when nothing is on screen.
pub fn window_state_changed(app: &AppHandle) {
    let (visible, focused, minimized) = app
        .get_webview_window("main")
        .map(|w| (w.is_visible().unwrap_or(false), w.is_focused().unwrap_or(false), w.is_minimized().unwrap_or(false)))
        .unwrap_or((false, false, false));
    let shown = visible && !minimized;
    let _ = app.emit_to("main", "nook://window-state", json!({ "visible": shown, "focused": focused }));
    let widget = app.get_webview_window("widget").map(|w| w.is_visible().unwrap_or(false)).unwrap_or(false);
    let bg = !(shown || widget);
    if BACKGROUND.swap(bg as u8, std::sync::atomic::Ordering::SeqCst) != bg as u8 {
        let h = app.clone();
        // a Toolhelp snapshot + a few syscalls: keep it off the event loop
        std::thread::spawn(move || {
            crate::perf::set_background(bg);
            let _ = h;
        });
    }
}

/// Re-check that every Nook child process (WebView2) is inside the capped job: a few times
/// right after start (WebView2 spawns its GPU/renderer processes lazily), then every 5 min.
pub fn start_perf_watch(_app: &AppHandle) {
    std::thread::Builder::new()
        .name("nook-perf".into())
        .spawn(|| {
            for secs in [3u64, 12, 45, 120] {
                std::thread::sleep(std::time::Duration::from_secs(secs));
                crate::perf::adopt_children();
            }
            loop {
                std::thread::sleep(std::time::Duration::from_secs(300));
                crate::perf::adopt_children();
            }
        })
        .ok();
}

// ------------------------------------------------------------------ tray

pub fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show / hide Nook", true, Some(HOTKEY_TOGGLE))?;
    let capture = MenuItem::with_id(app, "capture", "Quick capture", true, Some(HOTKEY_CAPTURE))?;
    let widget = MenuItem::with_id(app, "widget", "Toggle desktop widget", true, None::<&str>)?;
    let tl_status = MenuItem::with_id(app, "tl-status", "Timelens: starting…", false, None::<&str>)?;
    let tl_pause = MenuItem::with_id(app, "tl-pause", "Pause Timelens", true, Some(HOTKEY_TIMELENS))?;
    let meeting = MenuItem::with_id(app, "meeting", "Record / stop meeting", true, Some(HOTKEY_MEETING))?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Nook", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&show, &capture, &widget, &meeting, &sep3, &tl_status, &tl_pause, &sep, &settings, &sep2, &quit])?;
    app.manage(TrayItems { tl_status: tl_status.clone(), tl_pause: tl_pause.clone() });
    let mut tray = TrayIconBuilder::with_id("nook-tray")
        .tooltip("Nook")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "show" => toggle_main(app),
            "capture" => quick_capture(app),
            "tl-pause" => toggle_timelens(app),
            "meeting" => toggle_meeting(app),
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

/// v1.4: start / stop the meeting recorder (hotkey + tray). Opening the audio endpoints can take
/// a moment, so it runs off the main / shortcut thread; the recorder announces its state to every
/// window (`nook://meeting-state`), and failures (no mic, no output device) become a notification.
pub fn toggle_meeting(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let db = app.state::<AppState>().ctx.db.clone();
        let was = nook_core::meeting::is_recording();
        match nook_core::meeting::toggle(&db) {
            Ok(s) if !was => {
                let body = if s.warnings.is_empty() { "Press Ctrl+Alt+M again to stop.".to_string() } else { s.warnings.join(" ") };
                notify(&app, "Recording meeting", &body);
            }
            Ok(_) => notify(&app, "Meeting saved", "Open Meetings in Nook to transcribe and summarise it."),
            Err(e) => notify(&app, "Couldn't record the meeting", &e),
        }
        let _ = app.emit("nook://data-changed", json!({ "source": "meeting" }));
    });
}

/// Update the tray tooltip + Timelens entries.
pub fn refresh_tray(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (text, paused) = {
        let c = state.ctx.db.conn();
        (nook_core::timelens::tray_status(&c), nook_core::timelens::load_config(&c).paused)
    };
    static LAST: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());
    if let Ok(mut l) = LAST.lock() {
        let key = format!("{text}|{paused}");
        if *l == key {
            return;
        }
        *l = key;
    }
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
static FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

pub fn start_maintenance(app: &AppHandle) {
    let h = app.clone();
    std::thread::Builder::new()
        .name("nook-maintenance".into())
        .spawn(move || loop {
            // once a minute (the first pass 20 s after start)
            std::thread::sleep(std::time::Duration::from_secs(if FIRST.swap(false, std::sync::atomic::Ordering::SeqCst) { 20 } else { nook_core::ext::MAINTENANCE_SECS }));
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
    } else if shortcut.matches(tauri_plugin_global_shortcut::Modifiers::CONTROL | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyM)
        || shortcut.matches(tauri_plugin_global_shortcut::Modifiers::SUPER | tauri_plugin_global_shortcut::Modifiers::ALT, tauri_plugin_global_shortcut::Code::KeyM)
    {
        toggle_meeting(app);
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
    for k in [HOTKEY_CAPTURE, HOTKEY_TOGGLE, HOTKEY_TIMELENS, HOTKEY_CLIPBOARD, HOTKEY_MEETING] {
        if let Err(e) = gs.register(k) {
            // another app may own the combo — never fatal
            log::warn!("could not register {k}: {e}");
        }
    }
}

// ------------------------------------------------------------------ widget

/// Create/destroy the frameless, transparent desktop widget. Destroying (not hiding) it keeps
/// idle RAM low when it is off; the window-state plugin remembers its position and size.
///
/// v1.4 crash fix: the widget used to be destroyed synchronously from inside its *own* IPC
/// call (widget "close" button → `widget_toggle` → `w.destroy()`), and tray / hotkey / settings
/// could create and destroy it concurrently. On WebView2 that tears the webview down while it
/// is still dispatching the invoke → access violation. Now every caller only records the
/// *desired* state; one deferred job on the main thread applies the latest desired state under a
/// single mutex, so rapid toggles coalesce and a webview is never destroyed from its own call.
pub fn set_widget(app: &AppHandle, on: bool) {
    WIDGET_WANT.store(if on { 1 } else { 0 }, Ordering::SeqCst);
    if WIDGET_QUEUED.swap(true, Ordering::SeqCst) {
        return; // a job is already queued; it will read the newest desired state
    }
    let h = app.clone();
    // defer: let the current IPC call (possibly from the widget itself) return first
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(60));
        let h2 = h.clone();
        let r = h.run_on_main_thread(move || {
            WIDGET_QUEUED.store(false, Ordering::SeqCst);
            let on = WIDGET_WANT.load(Ordering::SeqCst) == 1;
            apply_widget(&h2, on);
        });
        if r.is_err() {
            WIDGET_QUEUED.store(false, Ordering::SeqCst);
        }
    });
}

static WIDGET_WANT: AtomicU8 = AtomicU8::new(0);
static WIDGET_QUEUED: AtomicBool = AtomicBool::new(false);
static WIDGET_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Windows parks minimised windows at (-32000, -32000); multi-monitor setups can also leave a
/// stale position that is on no screen any more. Never save or restore those.
pub fn sane_widget_pos(x: i32, y: i32) -> bool {
    x > -16_000 && y > -16_000 && x < 32_000 && y < 32_000
}

fn on_some_monitor(w: &tauri::WebviewWindow) -> bool {
    let Ok(pos) = w.outer_position() else { return false };
    if !sane_widget_pos(pos.x, pos.y) {
        return false;
    }
    match w.available_monitors() {
        Ok(ms) if !ms.is_empty() => ms.iter().any(|m| {
            let (mp, sz) = (m.position(), m.size());
            // at least the top-left 40 px of the widget must be on a monitor
            pos.x + 40 > mp.x && pos.y + 20 > mp.y && pos.x < mp.x + sz.width as i32 - 40 && pos.y < mp.y + sz.height as i32 - 20
        }),
        _ => true,
    }
}

fn save_widget_state(app: &AppHandle) {
    use tauri_plugin_window_state::{AppHandleExt, StateFlags};
    if let Some(w) = app.get_webview_window("widget") {
        if w.is_minimized().unwrap_or(false) || !on_some_monitor(&w) {
            return;
        }
    }
    let _ = app.save_window_state(StateFlags::POSITION | StateFlags::SIZE);
}

fn apply_widget(app: &AppHandle, on: bool) {
    let _g = WIDGET_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let existing = app.get_webview_window("widget");
    match (on, existing) {
        (true, Some(w)) => {
            let _ = w.show();
        }
        (true, None) => {
            let on_top = DesktopSettings::load(&app.state::<AppState>().ctx.db).widget_on_top;
            // small by default (300×380); the UI can collapse it to a 220×52 pill, so the
            // minimum size has to allow that
            let b = WebviewWindowBuilder::new(app, "widget", WebviewUrl::App("widget.html".into()))
                .title("Nook widget")
                .inner_size(WIDGET_W, WIDGET_H)
                .min_inner_size(WIDGET_PILL_W, WIDGET_PILL_H)
                .max_inner_size(720.0, 1000.0)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .resizable(true)
                .skip_taskbar(true)
                .always_on_top(on_top)
                .always_on_bottom(!on_top)
                .visible_on_all_workspaces(true)
                .background_color(tauri::window::Color(0, 0, 0, 0))
                .disable_drag_drop_handler();
            match b.build() {
                Ok(w) => {
                    use tauri_plugin_window_state::{StateFlags, WindowExt};
                    let _ = w.restore_state(StateFlags::POSITION | StateFlags::SIZE);
                    if !on_some_monitor(&w) {
                        // saved at -32000 (minimised) or on a monitor that is gone → bring it back
                        let _ = w.center();
                    }
                    // remember where it was dragged/resized (throttled to 1 save / 1.5 s, trailing
                    // save after the drag stops; minimised / off-screen coordinates are ignored)
                    let h = app.clone();
                    let last = std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0));
                    let gen = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
                    w.on_window_event(move |ev| match ev {
                        tauri::WindowEvent::Moved(p) if !sane_widget_pos(p.x, p.y) => {}
                        tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                            let now = nook_core::db::now_ms();
                            let g = gen.fetch_add(1, Ordering::SeqCst) + 1;
                            if now - last.load(Ordering::SeqCst) > 1_500 {
                                last.store(now, Ordering::SeqCst);
                                save_widget_state(&h);
                            } else {
                                let (h, gen, last) = (h.clone(), gen.clone(), last.clone());
                                std::thread::spawn(move || {
                                    std::thread::sleep(std::time::Duration::from_millis(1_600));
                                    if gen.load(Ordering::SeqCst) == g {
                                        last.store(nook_core::db::now_ms(), Ordering::SeqCst);
                                        save_widget_state(&h);
                                    }
                                });
                            }
                        }
                        tauri::WindowEvent::CloseRequested { api, .. } => {
                            // Alt+F4 on the widget: go through the same deferred path
                            api.prevent_close();
                            let state = h.state::<AppState>();
                            let mut s = DesktopSettings::load(&state.ctx.db);
                            s.widget = false;
                            let _ = s.save(&state.ctx.db);
                            set_widget(&h, false);
                            let _ = h.emit("nook://desktop-settings", ());
                        }
                        _ => {}
                    });
                }
                Err(e) => log::error!("widget window failed: {e}"),
            }
        }
        (false, Some(w)) => {
            save_widget_state(app);
            // let the widget drop its event listeners first, then destroy on the next turn
            let _ = w.emit("nook://widget-closing", ());
            let _ = w.hide();
            let w2 = w.clone();
            let h = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(150));
                let _ = h.run_on_main_thread(move || {
                    let _g = WIDGET_LOCK.lock().unwrap_or_else(|e| e.into_inner());
                    // re-enabled in the meantime? keep it
                    if WIDGET_WANT.load(Ordering::SeqCst) == 1 {
                        let _ = w2.show();
                    } else {
                        let _ = w2.destroy();
                    }
                });
            });
        }
        (false, None) => {}
    }
}

pub const WIDGET_W: f64 = 300.0;
pub const WIDGET_H: f64 = 380.0;
pub const WIDGET_PILL_W: f64 = 200.0;
pub const WIDGET_PILL_H: f64 = 48.0;

pub fn set_widget_on_top(app: &AppHandle, on: bool) {
    if let Some(w) = app.get_webview_window("widget") {
        let _ = w.set_always_on_bottom(!on);
        let _ = w.set_always_on_top(on);
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

/// The updater is configured in tauri.conf.json (`plugins.updater`: minisign public key +
/// the GitHub Releases `latest.json` endpoint). Builds without a key never self-update.
pub fn updater_configured(app: &AppHandle) -> bool {
    app.config().plugins.0.get("updater").and_then(|u| u.get("pubkey")).and_then(|k| k.as_str()).map(|k| !k.trim().is_empty()).unwrap_or(false)
}


/// Map an updater error to "nothing to do" for the expected cases (offline, no release yet,
/// no latest.json): those are logged and reported as `available: false` + `quietError`.
pub fn classify_update_error(e: &str) -> &'static str {
    let l = e.to_lowercase();
    if l.contains("404") || l.contains("not found") || l.contains("could not fetch a valid release json") {
        "no-release"
    } else if l.contains("dns") || l.contains("connect") || l.contains("timed out") || l.contains("network") || l.contains("error sending request") {
        "offline"
    } else {
        "error"
    }
}

pub async fn check_update(app: &AppHandle) -> Result<Value, String> {
    if !updater_configured(app) {
        return Ok(json!({ "configured": false }));
    }
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    let up = app.updater().map_err(|e| e.to_string())?;
    match up.check().await {
        Ok(Some(u)) => Ok(json!({ "configured": true, "available": true, "current": current, "version": u.version, "notes": u.body, "date": u.date.map(|d| d.to_string()) })),
        Ok(None) => Ok(json!({ "configured": true, "available": false, "current": current })),
        Err(e) => {
            let e = e.to_string();
            let kind = classify_update_error(&e);
            log::info!("update check: {kind} ({e})");
            Ok(json!({ "configured": true, "available": false, "current": current, "quietError": kind, "error": e }))
        }
    }
}

/// Download (progress pushed through `on_event`) + install, then relaunch.
pub async fn install_update(app: &AppHandle, on_event: tauri::ipc::Channel<Value>) -> Result<(), String> {
    if !updater_configured(app) {
        return Err("updates are not configured for this build".into());
    }
    use tauri_plugin_updater::UpdaterExt;
    let up = app.updater().map_err(|e| e.to_string())?;
    let Some(u) = up.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
    log::info!("installing update {}", u.version);
    let mut got: u64 = 0;
    let ch = on_event.clone();
    u.download_and_install(
        move |chunk, total| {
            got += chunk as u64;
            let _ = ch.send(json!({ "type": "progress", "downloaded": got, "total": total }));
        },
        || log::info!("update downloaded"),
    )
    .await
    .map_err(|e| {
        log::error!("update install failed: {e}");
        e.to_string()
    })?;
    let _ = on_event.send(json!({ "type": "installed" }));
    app.restart();
}

#[cfg(test)]
mod update_tests {
    use super::classify_update_error;

    #[test]
    fn expected_update_failures_are_quiet() {
        assert_eq!(classify_update_error("Could not fetch a valid release JSON from the remote"), "no-release");
        assert_eq!(classify_update_error("http status 404 Not Found"), "no-release");
        assert_eq!(classify_update_error("error sending request for url: dns error"), "offline");
        assert_eq!(classify_update_error("signature verification failed"), "error");
    }
}
