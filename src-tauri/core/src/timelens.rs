//! Timelens — a local, private, lightweight desktop time tracker (ActivityWatch / RescueTime
//! in spirit). A low-priority background thread samples the foreground window every 5 s
//! (configurable, never faster), folds samples into spans (app, title, start, end, afk) and
//! batch-writes them to the `TimeSpan` table once a minute. While AFK / locked / paused it backs
//! off to a 30 s sleep (woken instantly by a config change). Nothing ever leaves the machine.
//!
//! The sampler is a trait so the tracker loop, merging, AFK handling, categories, goals and
//! retention are all unit-tested with a mock. The Windows sampler uses Win32
//! (GetForegroundWindow / GetWindowTextW / GetWindowThreadProcessId /
//! QueryFullProcessImageNameW / GetLastInputInfo); other platforms get a best-effort X11
//! fallback (xdotool + xprintidle when present) or nothing.

use crate::db::{new_id, now_ms, setting_get, setting_put, Db};
use chrono::{Datelike, Local, TimeZone, Timelike};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ------------------------------------------------------------------ sampling

/// One look at the desktop.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Sample {
    /// executable / process name, e.g. `Code.exe` or a full path
    pub exe: String,
    /// window title
    pub title: String,
    /// milliseconds since the last keyboard/mouse input
    pub idle_ms: u64,
    /// session locked / screensaver / sleeping
    pub locked: bool,
    /// process id of the foreground window (0 when unknown) — lets samplers cache exe lookups
    pub pid: u32,
    /// the foreground window handle as an integer (0 when unknown)
    pub hwnd: usize,
}

/// Anything that can look at the desktop. Mocked in tests.
pub trait Sampler: Send {
    fn sample(&mut self) -> Option<Sample>;
}

/// A merged stretch of identical activity.
#[derive(Debug, Clone, PartialEq)]
pub struct Span {
    pub app: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub afk: bool,
}

/// Folds consecutive samples into spans. Each sample stands for `interval_ms` of time; a gap
/// larger than `gap_ms` (sleep, suspended process) closes the span so the gap is not counted.
pub struct Merger {
    cur: Option<Span>,
    interval_ms: i64,
    gap_ms: i64,
}

impl Merger {
    pub fn new(interval_ms: i64) -> Self {
        Merger { cur: None, interval_ms, gap_ms: interval_ms * 3 }
    }
    /// Feed one sample at `ts`; returns the span that just closed, if any.
    pub fn push(&mut self, app: &str, title: &str, afk: bool, ts: i64) -> Option<Span> {
        self.push_for(app, title, afk, ts, self.interval_ms)
    }
    /// Like `push`, but the sample stands for `dur_ms` (the tracker sleeps longer while AFK, so
    /// one AFK sample covers the whole back-off sleep).
    pub fn push_for(&mut self, app: &str, title: &str, afk: bool, ts: i64, dur_ms: i64) -> Option<Span> {
        if let Some(c) = self.cur.as_mut() {
            if c.app == app && c.title == title && c.afk == afk && ts - c.end <= self.gap_ms - self.interval_ms && ts >= c.start {
                c.end = c.end.max(ts + dur_ms);
                return None;
            }
        }
        let closed = self.cur.take();
        self.cur = Some(Span { app: app.into(), title: title.into(), start: ts, end: ts + dur_ms, afk });
        closed
    }
    /// Close the open span (pause, exclusion, shutdown).
    pub fn close(&mut self) -> Option<Span> {
        self.cur.take()
    }
    pub fn current(&self) -> Option<&Span> {
        self.cur.as_ref()
    }
}

// ------------------------------------------------------------------ config

pub const CONFIG_KEY: &str = "timelens-config";

#[derive(Debug, Clone)]
pub struct Config {
    pub enabled: bool,
    pub paused: bool,
    pub afk_secs: u64,
    pub interval_secs: u64,
    pub exclude: Vec<String>,
    pub redact_titles: bool,
    pub retention_days: i64,
    pub rules: Vec<Value>,
    pub goals: Vec<Value>,
    pub auto_journal: bool,
    /// fetch https://<domain>/favicon.ico once per site (Privacy can turn it off)
    pub favicons: bool,
    /// apps excluded from the Apps tab (exact names; hidden from all history too)
    pub exclude_apps: Vec<String>,
    /// per-app category overrides (as exact-app rules) followed by the user's rules —
    /// what categorisation actually uses, so overrides re-categorise history
    pub all_rules: Vec<Value>,
}

/// Default sampling interval. 5 s keeps the tracker far below 0.1 % CPU; the minimum is 5.
pub const DEFAULT_INTERVAL_SECS: u64 = 5;
pub const MIN_INTERVAL_SECS: u64 = 5;
/// While AFK / locked / paused the tracker sleeps this long between looks.
pub const IDLE_SLEEP_SECS: u64 = 30;
/// Spans are written to SQLite in one batch at most this often.
pub const FLUSH_SECS: u64 = 60;

impl Default for Config {
    fn default() -> Self {
        Config {
            enabled: true,
            paused: false,
            afk_secs: 180,
            interval_secs: DEFAULT_INTERVAL_SECS,
            exclude: vec![],
            redact_titles: false,
            retention_days: 90,
            rules: vec![],
            goals: default_goals(),
            auto_journal: false,
            favicons: true,
            exclude_apps: vec![],
            all_rules: vec![],
        }
    }
}

fn default_goals() -> Vec<Value> {
    vec![
        json!({ "id": "g-prod", "target": "productive", "kind": "goal", "mins": 240 }),
        json!({ "id": "g-dist", "target": "distracting", "kind": "limit", "mins": 60 }),
    ]
}

pub fn load_config(c: &Connection) -> Config {
    let raw = setting_get(c, CONFIG_KEY).and_then(|s| serde_json::from_str::<Value>(&s).ok()).unwrap_or(Value::Null);
    let d = Config::default();
    let rules = raw["rules"].as_array().cloned().unwrap_or_default();
    let mut all_rules = crate::tlapps::override_rules(c);
    all_rules.extend(rules.iter().cloned());
    let strs = |v: &Value| v.as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.trim().to_string())).filter(|s| !s.is_empty()).collect::<Vec<_>>());
    Config {
        enabled: raw["enabled"].as_bool().unwrap_or(d.enabled),
        paused: raw["paused"].as_bool().unwrap_or(d.paused),
        afk_secs: raw["afkSecs"].as_u64().map(|v| v.clamp(30, 3600)).unwrap_or(d.afk_secs),
        // 1.1 sampled every 2 s; 1.2 never goes below 5 s (old configs are lifted on load)
        interval_secs: raw["intervalSecs"].as_u64().map(|v| v.clamp(MIN_INTERVAL_SECS, 60)).unwrap_or(d.interval_secs),
        exclude: strs(&raw["exclude"]).unwrap_or_default(),
        redact_titles: raw["redactTitles"].as_bool().unwrap_or(false),
        retention_days: raw["retentionDays"].as_i64().map(|v| v.clamp(1, 3650)).unwrap_or(d.retention_days),
        rules,
        goals: raw["goals"].as_array().cloned().unwrap_or(d.goals),
        auto_journal: raw["autoJournal"].as_bool().unwrap_or(false),
        favicons: raw["favicons"].as_bool().unwrap_or(true),
        exclude_apps: crate::tlapps::excluded_apps(c),
        all_rules,
    }
}

pub fn config_json(cfg: &Config) -> Value {
    json!({
        "enabled": cfg.enabled, "paused": cfg.paused, "afkSecs": cfg.afk_secs, "intervalSecs": cfg.interval_secs,
        "exclude": cfg.exclude, "redactTitles": cfg.redact_titles, "retentionDays": cfg.retention_days,
        "rules": cfg.rules, "goals": cfg.goals, "autoJournal": cfg.auto_journal, "favicons": cfg.favicons,
        "excludeApps": cfg.exclude_apps, "minIntervalSecs": MIN_INTERVAL_SECS,
        "defaultRules": default_rules(),
    })
}

/// Merge a partial patch into the stored config.
pub fn patch_config(c: &Connection, patch: &Map<String, Value>) -> Result<Config, String> {
    let mut cur = config_json(&load_config(c));
    if let Value::Object(m) = &mut cur {
        m.remove("defaultRules");
        m.remove("excludeApps");
        m.remove("minIntervalSecs");
        for k in ["enabled", "paused", "afkSecs", "intervalSecs", "exclude", "redactTitles", "retentionDays", "rules", "goals", "autoJournal", "favicons"] {
            if let Some(v) = patch.get(k) {
                m.insert(k.into(), v.clone());
            }
        }
    }
    setting_put(c, CONFIG_KEY, &cur.to_string())?;
    mark_config_dirty();
    Ok(load_config(c))
}

pub fn set_paused(c: &Connection, paused: Option<bool>) -> Result<bool, String> {
    let now = !load_config(c).paused;
    let p = paused.unwrap_or(now);
    let mut m = Map::new();
    m.insert("paused".into(), json!(p));
    patch_config(c, &m)?;
    Ok(p)
}

static CONFIG_DIRTY: AtomicBool = AtomicBool::new(true);
static TRACKER_THREAD: OnceLock<std::thread::Thread> = OnceLock::new();

/// Config (or app overrides) changed: the tracker reloads it and wakes from a long sleep now.
pub fn mark_config_dirty() {
    CONFIG_DIRTY.store(true, Ordering::SeqCst);
    if let Some(t) = TRACKER_THREAD.get() {
        t.unpark();
    }
}

// ------------------------------------------------------------------ naming + categories

const BROWSERS: &[(&str, &str)] = &[
    ("chrome", "Chrome"), ("msedge", "Edge"), ("firefox", "Firefox"), ("brave", "Brave"), ("opera", "Opera"), ("vivaldi", "Vivaldi"), ("arc", "Arc"),
];
const PRETTY: &[(&str, &str)] = &[
    ("code", "VS Code"), ("devenv", "Visual Studio"), ("explorer", "Explorer"), ("windowsterminal", "Terminal"), ("wt", "Terminal"), ("powershell", "PowerShell"),
    ("pwsh", "PowerShell"), ("cmd", "Command Prompt"), ("winword", "Word"), ("excel", "Excel"), ("powerpnt", "PowerPoint"), ("outlook", "Outlook"), ("ms-teams", "Teams"),
    ("teams", "Teams"), ("slack", "Slack"), ("discord", "Discord"), ("spotify", "Spotify"), ("notepad", "Notepad"), ("notepad++", "Notepad++"), ("nook", "Nook"),
    ("figma", "Figma"), ("obsidian", "Obsidian"), ("notion", "Notion"), ("steam", "Steam"), ("vlc", "VLC"), ("idea64", "IntelliJ IDEA"), ("pycharm64", "PyCharm"),
    ("sublime_text", "Sublime Text"), ("lockapp", "Lock screen"),
];

/// `C:\Program Files\Microsoft VS Code\Code.exe` → `VS Code`
pub fn app_name(exe: &str) -> String {
    let file = exe.rsplit(['\\', '/']).next().unwrap_or(exe);
    let stem = file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file);
    let key = stem.to_lowercase();
    if let Some((_, n)) = BROWSERS.iter().find(|(k, _)| *k == key) {
        return n.to_string();
    }
    if let Some((_, n)) = PRETTY.iter().find(|(k, _)| *k == key) {
        return n.to_string();
    }
    let mut ch = stem.chars();
    match ch.next() {
        Some(f) if !stem.is_empty() => f.to_uppercase().collect::<String>() + ch.as_str(),
        _ => "Unknown".into(),
    }
}

pub fn is_browser(app: &str) -> bool {
    BROWSERS.iter().any(|(_, n)| *n == app)
}

/// Browser tab titles: `Lo-fi beats - YouTube - Google Chrome` → (`Lo-fi beats - YouTube`, `YouTube`).
pub fn parse_browser_title(title: &str) -> (String, String) {
    let norm = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let parts: Vec<&str> = norm
        .split(" - ")
        .flat_map(|p| p.split(" — "))
        .map(|p| match p.find(" and ") {
            // Edge: "Bing and 3 more pages"
            Some(i) if p[i..].contains("more page") => &p[..i],
            _ => p,
        })
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .collect();
    let noise = ["google chrome", "microsoft edge", "microsoft\u{200b} edge", "mozilla firefox", "firefox", "brave", "opera", "vivaldi", "arc"];
    let kept: Vec<&str> = parts
        .iter()
        .copied()
        .filter(|p| {
            let l = p.to_lowercase();
            !noise.iter().any(|n| l == *n) && !l.starts_with("profile ") && !l.starts_with("personal") && !(l.starts_with("and ") && l.contains("more page"))
        })
        .collect();
    let page = kept.join(" - ");
    let site = kept.last().map(|s| s.to_string()).unwrap_or_default();
    (page, site)
}

pub fn default_rules() -> Vec<Value> {
    let p = |m: &str, f: &str| json!({ "match": m, "field": f, "cat": "productive" });
    let d = |m: &str, f: &str| json!({ "match": m, "field": f, "cat": "distracting" });
    let n = |m: &str, f: &str| json!({ "match": m, "field": f, "cat": "neutral" });
    vec![
        d("youtube", "title"), d("netflix", "any"), d("reddit", "title"), d("twitter", "title"), d("x.com", "title"), d("instagram", "title"),
        d("tiktok", "title"), d("facebook", "title"), d("twitch", "any"), d("steam", "app"), d("9gag", "title"),
        p("vs code", "app"), p("visual studio", "app"), p("intellij", "app"), p("pycharm", "app"), p("sublime", "app"), p("terminal", "app"),
        p("powershell", "app"), p("command prompt", "app"), p("nook", "app"), p("obsidian", "app"), p("notion", "any"), p("figma", "any"),
        p("word", "app"), p("excel", "app"), p("powerpoint", "app"), p("github", "title"), p("stack overflow", "title"), p("docs", "title"),
        p("chatgpt", "title"), p("focus", "app"),
        n("slack", "app"), n("teams", "app"), n("outlook", "app"), n("discord", "app"), n("spotify", "app"), n("explorer", "app"), n("gmail", "title"),
    ]
}

/// Category for one span: user rules first, then defaults. `productive` | `neutral` | `distracting`.
pub fn categorize(app: &str, title: &str, user_rules: &[Value]) -> &'static str {
    let a = app.to_lowercase();
    let t = title.to_lowercase();
    let site = if is_browser(app) { parse_browser_title(title).1.to_lowercase() } else { String::new() };
    static DEFAULTS: OnceLock<Vec<Value>> = OnceLock::new();
    let defaults = DEFAULTS.get_or_init(default_rules);
    for r in user_rules.iter().chain(defaults.iter()) {
        let m = r["match"].as_str().unwrap_or("").trim().to_lowercase();
        if m.is_empty() {
            continue;
        }
        let hit = match r["field"].as_str().unwrap_or("any") {
            "appexact" => a == m,
            "app" => a.contains(&m),
            "title" => t.contains(&m) || site.contains(&m),
            _ => a.contains(&m) || t.contains(&m),
        };
        if hit {
            return match r["cat"].as_str().unwrap_or("neutral") {
                "productive" => "productive",
                "distracting" | "distraction" => "distracting",
                _ => "neutral",
            };
        }
    }
    "neutral"
}

pub fn excluded(cfg: &Config, app: &str, title: &str) -> bool {
    if cfg.exclude_apps.iter().any(|x| x.eq_ignore_ascii_case(app)) {
        return true;
    }
    let a = app.to_lowercase();
    let t = title.to_lowercase();
    cfg.exclude.iter().any(|x| {
        let x = x.to_lowercase();
        a.contains(&x) || t.contains(&x)
    })
}

/// Turn a raw sample into what gets stored: `(app, title, afk)` or None when excluded.
pub fn classify_sample(cfg: &Config, s: &Sample) -> Option<(String, String, bool)> {
    let app = app_name(&s.exe);
    let afk = s.locked || app == "Lock screen" || s.idle_ms >= cfg.afk_secs * 1000;
    if afk {
        return Some(("AFK".into(), String::new(), true));
    }
    if excluded(cfg, &app, &s.title) {
        return None;
    }
    let title = if cfg.redact_titles {
        if is_browser(&app) {
            parse_browser_title(&s.title).1
        } else {
            String::new()
        }
    } else {
        crate::util::take(s.title.trim(), 300)
    };
    Some((app, title, false))
}

// ------------------------------------------------------------------ storage

/// Insert spans, extending the last stored row when it continues seamlessly.
pub fn write_spans(c: &Connection, spans: &[Span]) -> Result<(), String> {
    if spans.is_empty() {
        return Ok(());
    }
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    for s in spans {
        if s.end <= s.start {
            continue;
        }
        let last: Option<(i64, String, String, i64, i64)> = tx
            .query_row(r#"SELECT "id","app","title","end","afk" FROM "TimeSpan" WHERE "focus"=0 ORDER BY "end" DESC LIMIT 1"#, [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
            .optional()
            .map_err(|e| e.to_string())?;
        match last {
            Some((id, app, title, end, afk)) if app == s.app && title == s.title && (afk != 0) == s.afk && s.start >= end - 1 && s.start - end <= 10_000 => {
                tx.execute(r#"UPDATE "TimeSpan" SET "end"=?1 WHERE "id"=?2"#, params![s.end.max(end), id]).map_err(|e| e.to_string())?;
            }
            _ => {
                tx.execute(r#"INSERT INTO "TimeSpan" ("app","title","start","end","afk","focus") VALUES (?1,?2,?3,?4,?5,0)"#, params![s.app, s.title, s.start, s.end, s.afk as i64])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    tx.commit().map_err(|e| e.to_string())
}

pub fn add_focus(c: &Connection, start: i64, end: i64, label: &str) -> Result<(), String> {
    if end <= start {
        return Err("end must be after start".into());
    }
    c.execute(r#"INSERT INTO "TimeSpan" ("app","title","start","end","afk","focus") VALUES ('Focus',?1,?2,?3,0,1)"#, params![crate::util::take(label, 120), start, end])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Delete everything older than `days`.
pub fn prune(c: &Connection, days: i64, now: i64) -> usize {
    c.execute(r#"DELETE FROM "TimeSpan" WHERE "end" < ?1"#, params![now - days * 86_400_000]).unwrap_or(0)
}

/// Delete a time range, clipping spans that straddle its edges.
pub fn delete_range(c: &Connection, from: i64, to: i64) -> Result<usize, String> {
    if to <= from {
        return Err("bad range".into());
    }
    let n = c.execute(r#"DELETE FROM "TimeSpan" WHERE "start" >= ?1 AND "end" <= ?2"#, params![from, to]).map_err(|e| e.to_string())?;
    // span covering the whole range → split in two
    let covering: Vec<(i64, String, String, i64, i64, i64)> = {
        let mut st = c.prepare(r#"SELECT "id","app","title","end","afk","focus" FROM "TimeSpan" WHERE "start" < ?1 AND "end" > ?2"#).map_err(|e| e.to_string())?;
        let rows = st.query_map(params![from, to], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?))).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (id, app, title, end, afk, focus) in covering {
        c.execute(r#"UPDATE "TimeSpan" SET "end"=?1 WHERE "id"=?2"#, params![from, id]).map_err(|e| e.to_string())?;
        c.execute(r#"INSERT INTO "TimeSpan" ("app","title","start","end","afk","focus") VALUES (?1,?2,?3,?4,?5,?6)"#, params![app, title, to, end, afk, focus]).map_err(|e| e.to_string())?;
    }
    c.execute(r#"UPDATE "TimeSpan" SET "end"=?1 WHERE "start" < ?1 AND "end" > ?1 AND "end" <= ?2"#, params![from, to]).map_err(|e| e.to_string())?;
    c.execute(r#"UPDATE "TimeSpan" SET "start"=?2 WHERE "start" >= ?1 AND "start" < ?2 AND "end" > ?2"#, params![from, to]).map_err(|e| e.to_string())?;
    Ok(n)
}

#[derive(Debug, Clone)]
pub struct Row {
    pub app: String,
    pub title: String,
    pub start: i64,
    pub end: i64,
    pub afk: bool,
    pub focus: bool,
}

/// Spans overlapping [from, to), clipped to it. Includes the live (unflushed) span.
pub fn spans_in(c: &Connection, from: i64, to: i64) -> Vec<Row> {
    let mut out: Vec<Row> = vec![];
    if let Ok(mut st) = c.prepare(r#"SELECT "app","title","start","end","afk","focus" FROM "TimeSpan" WHERE "end" > ?1 AND "start" < ?2 ORDER BY "start" ASC"#) {
        if let Ok(rows) = st.query_map(params![from, to], |r| {
            Ok(Row { app: r.get(0)?, title: r.get(1)?, start: r.get(2)?, end: r.get(3)?, afk: r.get::<_, i64>(4)? != 0, focus: r.get::<_, i64>(5)? != 0 })
        }) {
            out = rows.filter_map(|r| r.ok()).collect();
        }
    }
    if let Some(l) = live().lock().ok().and_then(|g| g.pending.clone()) {
        let last_end = out.iter().filter(|r| !r.focus).map(|r| r.end).max().unwrap_or(i64::MIN);
        if l.end > from && l.start < to {
            let start = l.start.max(last_end);
            if l.end > start {
                out.push(Row { app: l.app, title: l.title, start, end: l.end, afk: l.afk, focus: false });
            }
        }
    }
    for r in out.iter_mut() {
        r.start = r.start.max(from);
        r.end = r.end.min(to);
    }
    out.retain(|r| r.end > r.start);
    out
}

// ------------------------------------------------------------------ live state

#[derive(Debug, Clone, Default)]
pub struct Live {
    pub app: String,
    pub title: String,
    pub afk: bool,
    pub since: i64,
    pub running: bool,
    /// the open span not yet written to SQLite
    pub pending: Option<Span>,
}

pub fn live() -> &'static Mutex<Live> {
    static L: OnceLock<Mutex<Live>> = OnceLock::new();
    L.get_or_init(|| Mutex::new(Live::default()))
}

// ------------------------------------------------------------------ local time helpers

pub fn local_day_start(ts: i64) -> i64 {
    let dt = Local.timestamp_millis_opt(ts).single().unwrap_or_else(Local::now);
    let d = dt.date_naive().and_hms_opt(0, 0, 0).unwrap_or_default();
    Local.from_local_datetime(&d).earliest().map(|x| x.timestamp_millis()).unwrap_or(ts - ts.rem_euclid(86_400_000))
}
pub fn local_day_key(ts: i64) -> String {
    Local.timestamp_millis_opt(ts).single().map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default()
}
fn local_hour(ts: i64) -> usize {
    Local.timestamp_millis_opt(ts).single().map(|d| d.hour() as usize).unwrap_or(0)
}
fn local_weekday(ts: i64) -> usize {
    Local.timestamp_millis_opt(ts).single().map(|d| d.weekday().num_days_from_monday() as usize).unwrap_or(0)
}
pub fn fmt_secs(s: i64) -> String {
    let m = s / 60;
    if m >= 60 {
        format!("{}h {}m", m / 60, m % 60)
    } else {
        format!("{m}m")
    }
}

// ------------------------------------------------------------------ stats

/// A stretch of uninterrupted productive work at least this long counts as "focused".
pub const FOCUS_BLOCK_MIN_SECS: i64 = 10 * 60;

/// Focused time: Pomodoro/focus sessions plus productive stretches of ≥ 10 min where nothing
/// distracting (and no AFK) interrupts; neutral blips under a minute don't break a stretch.
pub fn focused_secs(rows: &[(i64, i64, &'static str)], focus_sessions: &[(i64, i64)]) -> (i64, Vec<(i64, i64)>) {
    let mut blocks: Vec<(i64, i64)> = vec![];
    let mut cur: Option<(i64, i64)> = None;
    for &(start, end, cat) in rows {
        let breaks = cat == "distracting" || cat == "afk" || (cat == "neutral" && end - start >= 60_000);
        match (cur.as_mut(), breaks, cat == "productive") {
            (Some(c), false, _) if start - c.1 <= 60_000 => {
                if cat == "productive" {
                    c.1 = end;
                }
            }
            _ => {
                if let Some(c) = cur.take() {
                    if c.1 - c.0 >= FOCUS_BLOCK_MIN_SECS * 1000 {
                        blocks.push(c);
                    }
                }
                if !breaks && cat == "productive" {
                    cur = Some((start, end));
                }
            }
        }
    }
    if let Some(c) = cur.take() {
        if c.1 - c.0 >= FOCUS_BLOCK_MIN_SECS * 1000 {
            blocks.push(c);
        }
    }
    blocks.extend(focus_sessions.iter().copied());
    blocks.sort();
    // union of overlapping blocks
    let mut merged: Vec<(i64, i64)> = vec![];
    for b in blocks {
        match merged.last_mut() {
            Some(l) if b.0 <= l.1 => l.1 = l.1.max(b.1),
            _ => merged.push(b),
        }
    }
    (merged.iter().map(|(a, b)| (b - a) / 1000).sum(), merged)
}

/// Full stats for [from, to).
pub fn summary(c: &Connection, from: i64, to: i64) -> Value {
    let cfg = load_config(c);
    let rows: Vec<Row> = spans_in(c, from, to).into_iter().filter(|r| r.focus || r.afk || !excluded(&cfg, &r.app, &r.title)).collect();
    let mut per_app: HashMap<String, (i64, &'static str)> = HashMap::new();
    let mut per_title: HashMap<(String, String), i64> = HashMap::new();
    let mut per_site: HashMap<String, (i64, &'static str, String)> = HashMap::new();
    let mut cats: HashMap<&'static str, i64> = HashMap::from([("productive", 0), ("neutral", 0), ("distracting", 0)]);
    let mut hourly = [0i64; 24];
    let mut hourly_prod = [0i64; 24];
    let (mut active, mut afk, mut focus) = (0i64, 0i64, 0i64);
    let mut timeline: Vec<Value> = vec![];
    let mut cat_rows: Vec<(i64, i64, &'static str)> = vec![];
    let mut focus_sessions: Vec<(i64, i64)> = vec![];
    let (mut first, mut last) = (i64::MAX, i64::MIN);
    for r in &rows {
        let secs = (r.end - r.start) / 1000;
        if r.focus {
            focus += secs;
            focus_sessions.push((r.start, r.end));
            timeline.push(json!({ "app": "Focus", "title": r.title, "start": r.start, "end": r.end, "afk": false, "focus": true, "cat": "productive" }));
            continue;
        }
        if r.afk {
            afk += secs;
            cat_rows.push((r.start, r.end, "afk"));
            timeline.push(json!({ "app": "AFK", "title": "", "start": r.start, "end": r.end, "afk": true, "focus": false, "cat": "afk" }));
            continue;
        }
        first = first.min(r.start);
        last = last.max(r.end);
        let cat = categorize(&r.app, &r.title, &cfg.all_rules);
        cat_rows.push((r.start, r.end, cat));
        active += secs;
        *cats.entry(cat).or_default() += secs;
        let e = per_app.entry(r.app.clone()).or_insert((0, cat));
        e.0 += secs;
        let browser = is_browser(&r.app);
        let label = if browser { parse_browser_title(&r.title).1 } else { crate::util::take(&r.title, 80) };
        if browser && !label.is_empty() {
            let e = per_site.entry(label.clone()).or_insert((0, cat, r.app.clone()));
            e.0 += secs;
        }
        *per_title.entry((r.app.clone(), label)).or_default() += secs;
        // hourly buckets (split across hour edges)
        let mut t = r.start;
        while t < r.end {
            let next_hour = (t / 3_600_000 + 1) * 3_600_000;
            let seg_end = next_hour.min(r.end);
            let h = local_hour(t);
            hourly[h] += (seg_end - t) / 1000;
            if cat == "productive" {
                hourly_prod[h] += (seg_end - t) / 1000;
            }
            t = seg_end;
        }
        match timeline.last_mut() {
            Some(last) if last["app"] == r.app.as_str() && last["end"].as_i64().unwrap_or(0) >= r.start - 5_000 && !last["focus"].as_bool().unwrap_or(false) => {
                last["end"] = json!(r.end);
            }
            _ => timeline.push(json!({ "app": r.app, "title": r.title, "start": r.start, "end": r.end, "afk": false, "focus": false, "cat": cat })),
        }
    }
    cat_rows.sort_by_key(|r| r.0);
    let (focused, focus_blocks) = focused_secs(&cat_rows, &focus_sessions);
    let mut apps: Vec<Value> = per_app.into_iter().map(|(app, (secs, cat))| json!({ "app": app, "secs": secs, "cat": cat })).collect();
    apps.sort_by(|a, b| b["secs"].as_i64().cmp(&a["secs"].as_i64()));
    let mut titles: Vec<Value> = per_title.into_iter().filter(|((_, t), _)| !t.is_empty()).map(|((app, title), secs)| json!({ "app": app, "title": title, "secs": secs })).collect();
    titles.sort_by(|a, b| b["secs"].as_i64().cmp(&a["secs"].as_i64()));
    titles.truncate(15);
    let mut sites: Vec<Value> = per_site
        .into_iter()
        .map(|(site, (secs, cat, browser))| json!({ "site": site, "domain": crate::tlapps::domain_for_site(&site), "secs": secs, "cat": cat, "browser": browser }))
        .collect();
    sites.sort_by(|a, b| b["secs"].as_i64().cmp(&a["secs"].as_i64()));
    let score = score_of(cats["productive"], cats["neutral"], active);
    if timeline.len() > 1500 {
        let step = timeline.len() / 1500 + 1;
        timeline = timeline.into_iter().step_by(step).collect();
    }
    let peak = hourly.iter().enumerate().max_by_key(|(_, v)| **v).filter(|(_, v)| **v > 0).map(|(h, _)| h as i64);
    let l = live().lock().map(|g| g.clone()).unwrap_or_default();
    json!({
        "from": from, "to": to, "activeSecs": active, "afkSecs": afk, "focusSecs": focus,
        "totalSecs": active + afk, "productiveSecs": cats["productive"], "focusedSecs": focused,
        "focusBlocks": focus_blocks.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
        "firstActivity": if first == i64::MAX { Value::Null } else { json!(first) },
        "lastActivity": if last == i64::MIN { Value::Null } else { json!(last) },
        "categories": { "productive": cats["productive"], "neutral": cats["neutral"], "distracting": cats["distracting"] },
        "score": score, "apps": apps, "titles": titles, "sites": sites, "hourly": hourly.to_vec(), "hourlyProductive": hourly_prod.to_vec(),
        "timeline": timeline, "topApp": apps.first().map(|a| a["app"].clone()).unwrap_or(Value::Null), "peakHour": peak,
        "current": { "app": l.app, "title": if cfg.redact_titles { String::new() } else { l.title }, "afk": l.afk, "since": l.since, "running": l.running },
        "paused": cfg.paused, "enabled": cfg.enabled, "intervalSecs": cfg.interval_secs,
    })
}

pub fn score_of(prod: i64, neutral: i64, active: i64) -> i64 {
    if active <= 0 {
        return 0;
    }
    (((prod as f64) + 0.5 * neutral as f64) / active as f64 * 100.0).round() as i64
}

/// Per-day totals for the last `days` days (local days, oldest first) + weekday×hour heatmap.
pub fn history(c: &Connection, days: i64, now: i64) -> Value {
    let cfg = load_config(c);
    let today = local_day_start(now);
    let days = days.clamp(1, 366);
    let from = local_day_start(today - (days - 1) * 86_400_000 + 3_600_000);
    let rows = spans_in(c, from, now.max(today + 1));
    let mut by_day: Vec<(String, i64, i64, i64, i64)> = vec![];
    let mut idx: HashMap<String, usize> = HashMap::new();
    let mut d = from;
    for _ in 0..days {
        let k = local_day_key(d + 3_600_000);
        idx.insert(k.clone(), by_day.len());
        by_day.push((k, 0, 0, 0, 0));
        d = local_day_start(d + 26 * 3_600_000);
    }
    let mut heat = vec![vec![0i64; 24]; 7];
    for r in rows.iter().filter(|r| !r.afk && !r.focus && !excluded(&cfg, &r.app, &r.title)) {
        let cat = categorize(&r.app, &r.title, &cfg.all_rules);
        let secs = (r.end - r.start) / 1000;
        if let Some(i) = idx.get(&local_day_key(r.start)) {
            let e = &mut by_day[*i];
            e.1 += secs;
            match cat {
                "productive" => e.2 += secs,
                "distracting" => e.4 += secs,
                _ => e.3 += secs,
            }
        }
        heat[local_weekday(r.start)][local_hour(r.start)] += secs;
    }
    let list: Vec<Value> = by_day
        .iter()
        .map(|(day, a, p, n, ds)| json!({ "day": day, "activeSecs": a, "productive": p, "neutral": n, "distracting": ds, "score": score_of(*p, *n, *a), "productiveDay": is_productive_day(*p, *n, *a) }))
        .collect();
    json!({ "days": list, "heatmap": heat, "streak": streak_from(&list) })
}

pub fn is_productive_day(prod: i64, neutral: i64, active: i64) -> bool {
    active >= 30 * 60 && score_of(prod, neutral, active) >= 60
}

/// Consecutive productive days ending today (or yesterday when today isn't there yet).
pub fn streak_from(days: &[Value]) -> i64 {
    let flags: Vec<bool> = days.iter().map(|d| d["productiveDay"].as_bool().unwrap_or(false)).collect();
    let mut i = flags.len();
    if i == 0 {
        return 0;
    }
    if !flags[i - 1] {
        i -= 1; // today not (yet) productive — streak may still be alive from yesterday
    }
    let mut n = 0;
    while i > 0 && flags[i - 1] {
        n += 1;
        i -= 1;
    }
    n
}

/// Goal / limit progress for today.
pub fn goals_status(c: &Connection, now: i64) -> Vec<Value> {
    let cfg = load_config(c);
    let s = summary(c, local_day_start(now), now + 1);
    cfg.goals
        .iter()
        .map(|g| {
            let target = g["target"].as_str().unwrap_or("").to_string();
            let mins = g["mins"].as_i64().unwrap_or(60).max(1);
            let used = match target.as_str() {
                "productive" | "neutral" | "distracting" => s["categories"][&target].as_i64().unwrap_or(0),
                t => s["apps"].as_array().map(|a| a.iter().filter(|x| x["app"].as_str().unwrap_or("").eq_ignore_ascii_case(t)).map(|x| x["secs"].as_i64().unwrap_or(0)).sum()).unwrap_or(0),
            } / 60;
            let kind = if g["kind"].as_str() == Some("goal") { "goal" } else { "limit" };
            json!({ "id": g["id"], "target": target, "kind": kind, "mins": mins, "usedMins": used, "pct": ((used as f64 / mins as f64) * 100.0).round(),
                    "exceeded": kind == "limit" && used >= mins, "achieved": kind == "goal" && used >= mins })
        })
        .collect()
}

/// Limits crossed today that haven't been announced yet (marks them announced).
pub fn new_goal_alerts(c: &Connection, now: i64) -> Vec<Value> {
    let day = local_day_key(now);
    let mut seen: Value = setting_get(c, "timelens-alerted").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    if seen["day"].as_str() != Some(day.as_str()) {
        seen = json!({ "day": day, "keys": [] });
    }
    let mut keys: Vec<String> = seen["keys"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
    let mut out = vec![];
    for g in goals_status(c, now) {
        let flag = if g["exceeded"].as_bool().unwrap_or(false) { "over" } else if g["achieved"].as_bool().unwrap_or(false) { "done" } else { continue };
        let key = format!("{}:{flag}", g["id"].as_str().unwrap_or(""));
        if keys.contains(&key) {
            continue;
        }
        keys.push(key);
        let t = g["target"].as_str().unwrap_or("");
        let text = if flag == "over" { format!("You've passed your {}-minute limit for {t} today.", g["mins"]) } else { format!("Goal reached: {} minutes of {t} today!", g["mins"]) };
        out.push(json!({ "kind": "timelens", "title": if flag == "over" { "Timelens limit" } else { "Timelens goal" }, "body": text }));
    }
    let _ = setting_put(c, "timelens-alerted", &json!({ "day": day, "keys": keys }).to_string());
    out
}

/// Pet XP + coins for productive days not yet rewarded (yesterday and today).
pub fn claim_rewards(c: &Connection, now: i64) -> Value {
    let h = history(c, 2, now);
    let mut rewarded: Vec<String> = setting_get(c, "timelens-rewarded").and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok()).unwrap_or_default();
    let mut xp = 0;
    let mut coins = 0;
    let mut days = vec![];
    for d in h["days"].as_array().cloned().unwrap_or_default() {
        let k = d["day"].as_str().unwrap_or("").to_string();
        if d["productiveDay"].as_bool().unwrap_or(false) && !rewarded.contains(&k) {
            rewarded.push(k.clone());
            xp += 30;
            coins += 15;
            days.push(k);
        }
    }
    if xp > 0 {
        let streak = h["streak"].as_i64().unwrap_or(0);
        let bonus = (streak.min(7)) * 2;
        coins += bonus;
        let _ = c.execute(r#"UPDATE "Pet" SET "xp"="xp"+?1, "coins"="coins"+?2"#, params![xp, coins]);
        if rewarded.len() > 60 {
            let cut = rewarded.len() - 60;
            rewarded.drain(0..cut);
        }
        let _ = setting_put(c, "timelens-rewarded", &serde_json::to_string(&rewarded).unwrap_or_default());
    }
    json!({ "ok": true, "xp": xp, "coins": coins, "days": days, "streak": h["streak"] })
}

/// Plain-language insights from the numbers (the offline brain; the cloud model gets this as context).
pub fn insights(c: &Connection, from: i64, to: i64, label: &str) -> String {
    let s = summary(c, from, to);
    let active = s["activeSecs"].as_i64().unwrap_or(0);
    if active == 0 {
        return format!("## Timelens — {label}\n\nNothing tracked yet. Leave Timelens running and check back later.");
    }
    let cats = &s["categories"];
    let mut out = format!("## Timelens — {label}\n\n");
    out.push_str(&format!(
        "- **Active:** {} · AFK {} · focus sessions {}\n- **Productivity score:** {}/100 (productive {}, neutral {}, distracting {})\n",
        fmt_secs(active),
        fmt_secs(s["afkSecs"].as_i64().unwrap_or(0)),
        fmt_secs(s["focusSecs"].as_i64().unwrap_or(0)),
        s["score"],
        fmt_secs(cats["productive"].as_i64().unwrap_or(0)),
        fmt_secs(cats["neutral"].as_i64().unwrap_or(0)),
        fmt_secs(cats["distracting"].as_i64().unwrap_or(0)),
    ));
    let top: Vec<String> = s["apps"].as_array().map(|a| a.iter().take(5).map(|x| format!("{} {}", x["app"].as_str().unwrap_or(""), fmt_secs(x["secs"].as_i64().unwrap_or(0)))).collect()).unwrap_or_default();
    out.push_str(&format!("- **Top apps:** {}\n", top.join(", ")));
    if let Some(h) = s["peakHour"].as_i64() {
        out.push_str(&format!("- **Peak hour:** {h:02}:00\n"));
    }
    let dist = cats["distracting"].as_i64().unwrap_or(0);
    let score = s["score"].as_i64().unwrap_or(0);
    out.push_str("\n**Insight:** ");
    out.push_str(if score >= 75 {
        "a strong, focused stretch — protect the same hours tomorrow."
    } else if dist * 4 > active {
        "distractions took over a quarter of your time. Try a focus session or a site limit for the worst offender."
    } else if score >= 50 {
        "a balanced day. One more deep-work block would tip it into a great one."
    } else {
        "lots of neutral time. Pick one important task and timebox it first thing."
    });
    out.push('\n');
    out
}

pub fn export(c: &Connection, from: i64, to: i64, format: &str) -> (String, String) {
    let cfg = load_config(c);
    let rows = spans_in(c, from, to);
    if format == "json" {
        let v: Vec<Value> = rows
            .iter()
            .map(|r| json!({ "app": r.app, "title": r.title, "start": r.start, "end": r.end, "secs": (r.end - r.start) / 1000, "afk": r.afk, "focus": r.focus, "category": if r.afk { "afk" } else { categorize(&r.app, &r.title, &cfg.all_rules) } }))
            .collect();
        return ("application/json".into(), serde_json::to_string_pretty(&v).unwrap_or_default());
    }
    let esc = |x: &str| format!("\"{}\"", x.replace('"', "\"\""));
    let mut out = String::from("app,title,start,end,secs,afk,focus,category\n");
    for r in rows {
        let cat = if r.afk { "afk" } else { categorize(&r.app, &r.title, &cfg.all_rules) };
        out.push_str(&format!("{},{},{},{},{},{},{},{}\n", esc(&r.app), esc(&r.title), crate::db::iso(r.start), crate::db::iso(r.end), (r.end - r.start) / 1000, r.afk, r.focus, cat));
    }
    ("text/csv".into(), out)
}

/// Demo day so a fresh install (and the e2e suite) has something to look at.
pub fn seed_demo(c: &Connection, now: i64) -> Result<usize, String> {
    let day = local_day_start(now);
    let plan: &[(&str, &str, i64, i64)] = &[
        ("VS Code", "timelens.rs — nook — Visual Studio Code", 9 * 60, 75),
        ("Chrome", "tauri docs - Tauri - Google Chrome", 10 * 60 + 15, 20),
        ("Slack", "#team-realhackers", 10 * 60 + 35, 15),
        ("VS Code", "Editor.tsx — nook", 10 * 60 + 50, 70),
        ("AFK", "", 12 * 60, 45),
        ("Chrome", "Lo-fi beats to code to - YouTube - Google Chrome", 12 * 60 + 45, 25),
        ("Nook", "Nook — Daily note", 13 * 60 + 10, 30),
        ("Terminal", "cargo test", 13 * 60 + 40, 25),
        ("Chrome", "r/rust - Reddit - Google Chrome", 14 * 60 + 5, 15),
        ("Figma", "Nook widget — Figma", 14 * 60 + 20, 40),
        ("Spotify", "Spotify Premium", 15 * 60, 10),
    ];
    // The plan covers 09:00–15:10. Early in the day (or just after midnight) it is shifted / scaled
    // so the whole demo day always lies within [midnight, now] — the seed never depends on the clock.
    let plan_start = 9 * 60i64;
    let plan_len = (15 * 60 + 10 - plan_start) as f64; // minutes
    let avail = ((now - day) as f64 / 60_000.0 - 1.0).max(1.0);
    let (base, scale) = if avail >= plan_start as f64 + plan_len { (plan_start as f64, 1.0) } else if avail >= plan_len { (avail - plan_len, 1.0) } else { (0.0, avail / plan_len) };
    let at = |m: i64| day + ((base + (m - plan_start) as f64 * scale) * 60_000.0) as i64;
    let mut spans = vec![];
    for (app, title, start_min, mins) in plan {
        let start = at(*start_min);
        let end = at(start_min + mins);
        if start >= now || end <= start {
            continue;
        }
        spans.push(Span { app: app.to_string(), title: title.to_string(), start, end: end.min(now), afk: *app == "AFK" });
    }
    let n = spans.len();
    write_spans(c, &spans)?;
    // demo app registry with generated icons (stand-ins for the real exe icons on Windows)
    let demo: &[(&str, &str, [u8; 3])] = &[
        ("VS Code", "C:\\Users\\demo\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe", [0x23, 0x7a, 0xcc]),
        ("Chrome", "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", [0xe8, 0x45, 0x3c]),
        ("Slack", "C:\\Users\\demo\\AppData\\Local\\slack\\slack.exe", [0x4a, 0x15, 0x4b]),
        ("Figma", "C:\\Users\\demo\\AppData\\Local\\Figma\\Figma.exe", [0xa2, 0x59, 0xff]),
        ("Terminal", "C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal\\WindowsTerminal.exe", [0x2b, 0x2b, 0x2b]),
        ("Spotify", "C:\\Users\\demo\\AppData\\Roaming\\Spotify\\Spotify.exe", [0x1d, 0xb9, 0x54]),
    ];
    for (app, exe, rgb) in demo {
        let png = demo_icon(*rgb);
        let _ = c.execute(
            r#"INSERT INTO "TimelensApp" ("app","exe","icon","iconAt","firstSeen","lastSeen") VALUES (?1,?2,?3,?4,?4,?4)
               ON CONFLICT("app") DO UPDATE SET "exe"=excluded."exe", "icon"=CASE WHEN "TimelensApp"."icon"='' THEN excluded."icon" ELSE "TimelensApp"."icon" END"#,
            params![app, exe, crate::tlapps::data_url("image/png", &png), now],
        );
    }
    let _ = c.execute(r#"INSERT OR IGNORE INTO "TimelensApp" ("app","firstSeen","lastSeen") VALUES ('Nook',?1,?1)"#, params![now]);
    // a focus session + a productive yesterday for the streak
    let _ = add_focus(c, at(9 * 60), at(9 * 60 + 25), "Pomodoro");
    let y = local_day_start(day - 3_600_000);
    write_spans(c, &[Span { app: "VS Code".into(), title: "yesterday — nook".into(), start: y + 10 * 3_600_000, end: y + 13 * 3_600_000, afk: false }])?;
    Ok(n)
}

/// A 32×32 rounded square with a soft highlight — the demo vault's stand-in app icons.
fn demo_icon(rgb: [u8; 3]) -> Vec<u8> {
    let n = 32u32;
    let mut px = Vec::with_capacity((n * n * 4) as usize);
    for y in 0..n {
        for x in 0..n {
            let (dx, dy) = ((x as i32 - 15).abs().max(9) - 9, (y as i32 - 15).abs().max(9) - 9);
            let inside = dx * dx + dy * dy <= 49;
            let lift = if y < 14 { 18 } else { 0 };
            px.extend_from_slice(&[rgb[0].saturating_add(lift), rgb[1].saturating_add(lift), rgb[2].saturating_add(lift), if inside { 255 } else { 0 }]);
        }
    }
    crate::tlapps::encode_png(n, n, &px)
}

pub fn tray_status(c: &Connection) -> String {
    let cfg = load_config(c);
    if !cfg.enabled {
        return "Timelens off".into();
    }
    if cfg.paused {
        return "Timelens paused".into();
    }
    let now = now_ms();
    let s = summary(c, local_day_start(now), now + 1);
    format!("Timelens: {} today · {}", fmt_secs(s["activeSecs"].as_i64().unwrap_or(0)), s["topApp"].as_str().unwrap_or("—"))
}

// ------------------------------------------------------------------ the tracker thread

pub struct Tracker {
    pub merger: Merger,
    pub buffer: Vec<Span>,
    last_flush: Instant,
    cfg: Config,
    ticks: u64,
    /// apps seen since the last flush: (app, exe, ts) — registered (and icons extracted) in the batch
    pub seen: Vec<(String, String, i64)>,
    /// app → exe already registered this session (so steady state does no DB work per sample)
    known: HashMap<String, String>,
    /// how long the last step asked to sleep (ms)
    pub next_sleep_ms: i64,
}

impl Tracker {
    pub fn new(cfg: Config) -> Self {
        Tracker {
            merger: Merger::new(cfg.interval_secs as i64 * 1000),
            buffer: vec![],
            last_flush: Instant::now(),
            cfg,
            ticks: 0,
            seen: vec![],
            known: HashMap::new(),
            next_sleep_ms: DEFAULT_INTERVAL_SECS as i64 * 1000,
        }
    }

    fn interval_ms(&self) -> i64 {
        self.cfg.interval_secs.max(MIN_INTERVAL_SECS) as i64 * 1000
    }

    /// One sampling step at time `ts`. Pure apart from the sampler — unit-tested with a mock.
    /// Sets `next_sleep_ms`: the normal interval while active, a long back-off while AFK,
    /// locked, paused or disabled.
    pub fn step(&mut self, sampler: &mut dyn Sampler, ts: i64) {
        self.ticks += 1;
        let interval = self.interval_ms();
        if !self.cfg.enabled || self.cfg.paused {
            if let Some(s) = self.merger.close() {
                self.buffer.push(s);
            }
            if let Ok(mut l) = live().lock() {
                l.running = false;
                l.pending = None;
            }
            self.next_sleep_ms = IDLE_SLEEP_SECS as i64 * 1000;
            return;
        }
        let raw = sampler.sample();
        let idle_long = raw.as_ref().map(|s| s.locked || s.idle_ms >= self.cfg.afk_secs * 1000).unwrap_or(false);
        // AFK / locked: back off. One AFK sample stands for the whole sleep so nothing is lost.
        let dur = if idle_long { (IDLE_SLEEP_SECS as i64 * 1000).max(interval) } else { interval };
        self.next_sleep_ms = dur;
        if let Some(s) = raw.as_ref() {
            let app = app_name(&s.exe);
            if !s.exe.is_empty() && app != "Lock screen" && self.known.get(&app) != Some(&s.exe) {
                self.known.insert(app.clone(), s.exe.clone());
                self.seen.push((app, s.exe.clone(), ts));
            }
        }
        let classified = raw.and_then(|s| classify_sample(&self.cfg, &s));
        match classified {
            Some((app, title, afk)) => {
                if let Some(s) = self.merger.push_for(&app, &title, afk, ts, dur) {
                    self.buffer.push(s);
                }
                if let Ok(mut l) = live().lock() {
                    if l.app != app || l.afk != afk {
                        l.since = ts;
                    }
                    l.app = app;
                    l.title = title;
                    l.afk = afk;
                    l.running = true;
                    l.pending = self.merger.current().cloned();
                }
            }
            None => {
                if let Some(s) = self.merger.close() {
                    self.buffer.push(s);
                }
                if let Ok(mut l) = live().lock() {
                    l.pending = None;
                }
            }
        }
    }

    /// Batch writes: once a minute (or when a lot piled up). Never per sample.
    pub fn should_flush(&self) -> bool {
        let due = self.last_flush.elapsed() >= Duration::from_secs(FLUSH_SECS);
        self.buffer.len() >= 240 || (due && (!self.buffer.is_empty() || !self.seen.is_empty()))
    }

    pub fn flush(&mut self, db: &Db) {
        self.flush_with(db, &crate::tlapps::PlatformIcons);
    }

    pub fn flush_with(&mut self, db: &Db, icons: &dyn crate::tlapps::IconSource) {
        if !self.seen.is_empty() {
            // new apps: registry rows + one icon extraction per new exe (a few ms, once)
            let seen = std::mem::take(&mut self.seen);
            let c = db.conn();
            crate::tlapps::register(&c, &seen, icons);
        }
        if self.buffer.is_empty() {
            self.last_flush = Instant::now();
            return;
        }
        let spans = std::mem::take(&mut self.buffer);
        let c = db.conn();
        if write_spans(&c, &spans).is_err() {
            log::warn!("timelens: write failed, dropping {} spans", spans.len());
        }
        self.last_flush = Instant::now();
    }
}

static STARTED: AtomicBool = AtomicBool::new(false);

/// Start the background tracker (once per process). The thread runs at the lowest priority
/// (and EcoQoS on Windows 11) and parks between samples; `mark_config_dirty` wakes it.
pub fn start(db: Db, mut sampler: Box<dyn Sampler>) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::Builder::new()
        .name("timelens".into())
        .spawn(move || {
            let _ = TRACKER_THREAD.set(std::thread::current());
            lower_this_thread();
            let mut tracker = Tracker::new(load_config(&db.conn()));
            loop {
                if CONFIG_DIRTY.swap(false, Ordering::SeqCst) {
                    let cfg = load_config(&db.conn());
                    if cfg.interval_secs != tracker.cfg.interval_secs {
                        if let Some(s) = tracker.merger.close() {
                            tracker.buffer.push(s);
                        }
                        tracker.merger = Merger::new(cfg.interval_secs.max(MIN_INTERVAL_SECS) as i64 * 1000);
                    }
                    tracker.cfg = cfg;
                }
                tracker.step(sampler.as_mut(), now_ms());
                if tracker.should_flush() || (tracker.cfg.paused && !tracker.buffer.is_empty()) {
                    tracker.flush(&db);
                }
                // park (not sleep) so a config change / resume wakes us immediately
                let deadline = Instant::now() + Duration::from_millis(tracker.next_sleep_ms.max(1000) as u64);
                while !CONFIG_DIRTY.load(Ordering::SeqCst) {
                    let now = Instant::now();
                    if now >= deadline {
                        break;
                    }
                    std::thread::park_timeout(deadline - now);
                }
            }
        })
        .ok();
}

/// Lowest thread priority + EcoQoS for the sampling thread (no-op off Windows).
fn lower_this_thread() {
    #[cfg(windows)]
    win::lower_current_thread();
}

/// The platform's real sampler.
pub fn platform_sampler() -> Box<dyn Sampler> {
    #[cfg(windows)]
    {
        Box::new(win::WinSampler::default())
    }
    #[cfg(not(windows))]
    {
        Box::new(x11::X11Sampler::default())
    }
}

/// Small bounded cache: window/process → exe path. Keeps the steady-state sample to two cheap
/// calls (GetForegroundWindow + GetWindowTextW); OpenProcess/QueryFullProcessImageNameW only
/// run when the foreground process changes.
#[derive(Default)]
pub struct ExeCache {
    map: HashMap<(usize, u32), String>,
}

impl ExeCache {
    pub fn get_or(&mut self, hwnd: usize, pid: u32, f: impl FnOnce() -> String) -> String {
        if let Some(e) = self.map.get(&(hwnd, pid)) {
            return e.clone();
        }
        if self.map.len() >= 256 {
            self.map.clear();
        }
        let exe = f();
        self.map.insert((hwnd, pid), exe.clone());
        exe
    }
    pub fn len(&self) -> usize {
        self.map.len()
    }
    pub fn is_empty(&self) -> bool {
        self.map.is_empty()
    }
}

#[cfg(windows)]
#[path = "timelens_win.rs"]
mod win;

#[cfg(not(windows))]
mod x11 {
    use super::{Sample, Sampler};
    use std::process::Command;

    /// Best-effort X11 fallback: `xdotool` for the active window, `xprintidle` for idle time.
    /// Returns None (nothing recorded) when there is no display or the tools are missing.
    #[derive(Default)]
    pub struct X11Sampler {
        missing: bool,
    }

    fn run(cmd: &str, args: &[&str]) -> Option<String> {
        let out = Command::new(cmd).args(args).output().ok()?;
        out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
    }

    impl Sampler for X11Sampler {
        fn sample(&mut self) -> Option<Sample> {
            if self.missing || std::env::var_os("DISPLAY").is_none() {
                return None;
            }
            let Some(title) = run("xdotool", &["getactivewindow", "getwindowname"]) else {
                self.missing = true;
                return None;
            };
            let pid = run("xdotool", &["getactivewindow", "getwindowpid"]).unwrap_or_default();
            let exe = std::fs::read_link(format!("/proc/{pid}/exe")).map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
            let idle_ms = run("xprintidle", &[]).and_then(|s| s.parse().ok()).unwrap_or(0);
            Some(Sample { exe, title, idle_ms, locked: false, pid: pid.parse().unwrap_or(0), hwnd: 0 })
        }
    }
}

// ------------------------------------------------------------------ API

/// Every app (registered or seen in spans) with its time in [from, to) and effective category.
pub fn apps_in(c: &Connection, from: i64, to: i64) -> Vec<Value> {
    let cfg = load_config(c);
    let mut secs: HashMap<String, i64> = HashMap::new();
    let mut titles: HashMap<String, String> = HashMap::new();
    for r in spans_in(c, from, to).into_iter().filter(|r| !r.afk && !r.focus) {
        *secs.entry(r.app.clone()).or_default() += (r.end - r.start) / 1000;
        titles.entry(r.app.clone()).or_insert(r.title);
    }
    let cat_of = |app: &str| categorize(app, titles.get(app).map(String::as_str).unwrap_or(""), &cfg.all_rules);
    crate::tlapps::apps_list(c, &secs, &cat_of)
}

pub fn now_range(q: &HashMap<String, String>, now: i64) -> (i64, i64) {
    let from = q.get("from").and_then(|v| v.parse::<i64>().ok()).unwrap_or_else(|| local_day_start(now));
    let to = q.get("to").and_then(|v| v.parse::<i64>().ok()).unwrap_or(now + 1);
    (from, to.max(from + 1))
}

/// `/api/timelens/*`
pub fn route(c: &Connection, m: &str, rest: &[&str], b: &Map<String, Value>, q: &HashMap<String, String>) -> Option<crate::api::ApiResponse> {
    use crate::api::{ApiResponse as R, Body};
    let now = now_ms();
    Some(match (m, rest) {
        ("GET", ["summary"]) | ("GET", []) => {
            let (f, t) = now_range(q, now);
            R::json(summary(c, f, t))
        }
        ("GET", ["history"]) => R::json(history(c, q.get("days").and_then(|d| d.parse().ok()).unwrap_or(7), now)),
        ("GET", ["goals"]) => R::json(json!(goals_status(c, now))),
        ("GET", ["config"]) => R::json(config_json(&load_config(c))),
        ("PUT", ["config"]) | ("PATCH", ["config"]) => match patch_config(c, b) {
            Ok(cfg) => R::json(config_json(&cfg)),
            Err(e) => R::err(400, &e),
        },
        ("POST", ["pause"]) => match set_paused(c, b.get("paused").and_then(|v| v.as_bool())) {
            Ok(p) => R::json(json!({ "ok": true, "paused": p })),
            Err(e) => R::err(500, &e),
        },
        ("POST", ["focus"]) => {
            let start = b.get("start").and_then(|v| v.as_i64()).unwrap_or(now - 25 * 60_000);
            let end = b.get("end").and_then(|v| v.as_i64()).unwrap_or(now);
            match add_focus(c, start, end, b.get("label").and_then(|v| v.as_str()).unwrap_or("Focus session")) {
                Ok(_) => R::ok(),
                Err(e) => R::err(400, &e),
            }
        }
        ("POST", ["spans"]) => {
            // manual/imported spans: [{app,title,start,end,afk}]
            let spans: Vec<Span> = b
                .get("spans")
                .and_then(|v| v.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| Some(Span { app: x["app"].as_str()?.to_string(), title: x["title"].as_str().unwrap_or("").to_string(), start: x["start"].as_i64()?, end: x["end"].as_i64()?, afk: x["afk"].as_bool().unwrap_or(false) }))
                        .collect()
                })
                .unwrap_or_default();
            match write_spans(c, &spans) {
                Ok(_) => R::json(json!({ "ok": true, "written": spans.len() })),
                Err(e) => R::err(500, &e),
            }
        }
        ("DELETE", ["spans"]) => {
            let from = q.get("from").and_then(|v| v.parse().ok()).unwrap_or(0);
            let to = q.get("to").and_then(|v| v.parse().ok()).unwrap_or(0);
            match delete_range(c, from, to) {
                Ok(n) => R::json(json!({ "ok": true, "deleted": n })),
                Err(e) => R::err(400, &e),
            }
        }
        ("POST", ["prune"]) => R::json(json!({ "ok": true, "deleted": prune(c, load_config(c).retention_days, now) })),
        ("POST", ["reward"]) => R::json(claim_rewards(c, now)),
        ("POST", ["seed"]) => match seed_demo(c, now) {
            Ok(n) => R::json(json!({ "ok": true, "spans": n })),
            Err(e) => R::err(500, &e),
        },
        ("GET", ["insights"]) => {
            let (f, t) = now_range(q, now);
            R::json(json!({ "text": insights(c, f, t, q.get("label").map(String::as_str).unwrap_or("today")) }))
        }
        ("GET", ["export"]) => {
            let (f, t) = if q.contains_key("from") { now_range(q, now) } else { (0, now + 1) };
            let fmt = q.get("format").map(String::as_str).unwrap_or("csv");
            let (mime, data) = export(c, f, t, fmt);
            let name = format!("timelens-{}.{}", local_day_key(now), if fmt == "json" { "json" } else { "csv" });
            R { status: 200, body: Body::Bytes { mime, name, data: data.into_bytes() } }
        }
        ("GET", ["status"]) => R::json(json!({ "text": tray_status(c), "paused": load_config(c).paused })),
        // ---- 1.2: app registry, icons, websites
        ("GET", ["apps"]) => {
            let (f, t) = if q.contains_key("from") { now_range(q, now) } else { (local_day_start(now) - (q.get("days").and_then(|d| d.parse::<i64>().ok()).unwrap_or(30).clamp(1, 366) - 1) * 86_400_000, now + 1) };
            R::json(json!(apps_in(c, f, t)))
        }
        ("PATCH", ["apps", app]) | ("PUT", ["apps", app]) => match crate::tlapps::patch_app(c, app, b) {
            Ok(v) => R::json(v),
            Err(e) => R::err(400, &e),
        },
        ("GET", ["icons"]) => R::json(crate::tlapps::icons_map(c)),
        ("GET", ["favicons"]) => R::json(crate::tlapps::favicons_map(c)),
        ("GET", ["sites"]) => {
            let (f, t) = now_range(q, now);
            R::json(summary(c, f, t)["sites"].clone())
        }
        _ => return None,
    })
}

/// Maintenance: retention + goal alerts + streak rewards + auto journal. Returns notifications.
pub fn maintenance(c: &Connection, now: i64) -> Vec<Value> {
    let cfg = load_config(c);
    let _ = prune(c, cfg.retention_days, now);
    let mut out = new_goal_alerts(c, now);
    // rewards are claimed by the UI (so the webview's pet state never overwrites them);
    // here we only nudge once a day when a productive day is waiting
    let h = history(c, 2, now);
    let rewarded: Vec<String> = setting_get(c, "timelens-rewarded").and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
    let waiting = h["days"].as_array().map(|a| a.iter().any(|d| d["productiveDay"].as_bool().unwrap_or(false) && !rewarded.iter().any(|r| d["day"].as_str() == Some(r.as_str())))).unwrap_or(false);
    let today = local_day_key(now);
    if waiting && setting_get(c, "timelens-nudged").as_deref() != Some(today.as_str()) {
        let _ = setting_put(c, "timelens-nudged", &today);
        out.push(json!({ "kind": "timelens", "title": "Productive day!", "body": format!("Your pet has a reward waiting in Timelens. Streak: {} days.", h["streak"]) }));
    }
    if cfg.auto_journal {
        let yday_start = local_day_start(local_day_start(now) - 3_600_000);
        let key = local_day_key(yday_start + 3_600_000);
        if setting_get(c, "timelens-journaled").as_deref() != Some(key.as_str()) {
            let text = insights(c, yday_start, local_day_start(now), &key);
            if crate::ext::append_daily(c, &key, &text).is_ok() {
                let _ = setting_put(c, "timelens-journaled", &key);
            }
        }
    }
    out
}

pub fn id_for_tests() -> String {
    new_id()
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Mock(Vec<Sample>, usize);
    impl Sampler for Mock {
        fn sample(&mut self) -> Option<Sample> {
            let s = self.0.get(self.1).cloned();
            self.1 += 1;
            s
        }
    }
    struct NoIcons;
    impl crate::tlapps::IconSource for NoIcons {
        fn icon_png(&self, _exe: &str) -> Option<Vec<u8>> {
            None
        }
    }

    #[test]
    fn config_lifts_old_fast_intervals_and_overrides_recategorise_history() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        setting_put(&c, CONFIG_KEY, r#"{"intervalSecs":2}"#).unwrap();
        assert_eq!(load_config(&c).interval_secs, MIN_INTERVAL_SECS);
        let base = local_day_start(now_ms()) + 3_600_000;
        write_spans(&c, &[Span { app: "VS Code".into(), title: "x".into(), start: base, end: base + 600_000, afk: false }]).unwrap();
        assert_eq!(summary(&c, base, base + 700_000)["categories"]["productive"], 600);
        let mut b = Map::new();
        b.insert("category".into(), json!("distracting"));
        crate::tlapps::patch_app(&c, "VS Code", &b).unwrap();
        let s = summary(&c, base, base + 700_000);
        assert_eq!(s["categories"]["distracting"], 600, "override applies retroactively");
        let mut b = Map::new();
        b.insert("excluded".into(), json!(true));
        crate::tlapps::patch_app(&c, "VS Code", &b).unwrap();
        assert_eq!(summary(&c, base, base + 700_000)["activeSecs"], 0, "excluded apps vanish from history");
    }

    #[test]
    fn focused_time_counts_long_productive_stretches_and_sessions() {
        let m = 60_000;
        let rows = vec![(0, 12 * m, "productive"), (12 * m, 12 * m + 30_000, "neutral"), (12 * m + 30_000, 20 * m, "productive"), (20 * m, 25 * m, "distracting"), (25 * m, 30 * m, "productive")];
        let (secs, blocks) = focused_secs(&rows, &[(40 * m, 65 * m)]);
        assert_eq!(blocks.len(), 2);
        assert_eq!(secs, 20 * 60 + 25 * 60);
        let mut cache = ExeCache::default();
        let mut calls = 0;
        for _ in 0..5 {
            cache.get_or(1, 2, || {
                calls += 1;
                "a.exe".into()
            });
        }
        assert_eq!((calls, cache.len()), (1, 1), "exe looked up once per window/process");
    }

    fn smp(exe: &str, title: &str, idle: u64) -> Sample {
        Sample { exe: exe.into(), title: title.into(), idle_ms: idle, locked: false, pid: 1, hwnd: 1 }
    }

    #[test]
    fn merges_consecutive_samples_and_splits_on_change_and_gaps() {
        let mut m = Merger::new(2000);
        assert!(m.push("A", "t", false, 0).is_none());
        assert!(m.push("A", "t", false, 2000).is_none());
        assert!(m.push("A", "t", false, 4000).is_none());
        let s = m.push("B", "t", false, 6000).unwrap();
        assert_eq!((s.app.as_str(), s.start, s.end), ("A", 0, 6000));
        // a long gap (sleep) closes the span: the gap is not counted
        let s = m.push("B", "t", false, 60_000).unwrap();
        assert_eq!((s.start, s.end), (6000, 8000));
        assert_eq!(m.close().unwrap().start, 60_000);
    }

    #[test]
    fn afk_lock_and_exclusion_and_redaction() {
        let mut cfg = Config { afk_secs: 60, exclude: vec!["keepass".into()], ..Default::default() };
        assert_eq!(classify_sample(&cfg, &smp("C:\\x\\Code.exe", "main.rs", 0)).unwrap(), ("VS Code".into(), "main.rs".into(), false));
        assert!(classify_sample(&cfg, &smp("Code.exe", "x", 61_000)).unwrap().2);
        assert!(classify_sample(&cfg, &Sample { locked: true, ..smp("Code.exe", "x", 0) }).unwrap().2);
        assert!(classify_sample(&cfg, &smp("LockApp.exe", "", 0)).unwrap().2);
        assert!(classify_sample(&cfg, &smp("KeePass.exe", "vault", 0)).is_none());
        cfg.redact_titles = true;
        assert_eq!(classify_sample(&cfg, &smp("Code.exe", "secret.rs", 0)).unwrap().1, "");
        assert_eq!(classify_sample(&cfg, &smp("chrome.exe", "Inbox - Gmail - Google Chrome", 0)).unwrap().1, "Gmail");
    }

    #[test]
    fn browser_titles_and_categories() {
        assert_eq!(parse_browser_title("Lo-fi beats - YouTube - Google Chrome"), ("Lo-fi beats - YouTube".into(), "YouTube".into()));
        assert_eq!(parse_browser_title("Rust docs — Mozilla Firefox").1, "Rust docs");
        assert_eq!(parse_browser_title("Bing and 3 more pages - Personal - Microsoft Edge").1, "Bing");
        assert_eq!(categorize("VS Code", "x", &[]), "productive");
        assert_eq!(categorize("Chrome", "cats - YouTube - Google Chrome", &[]), "distracting");
        assert_eq!(categorize("Slack", "", &[]), "neutral");
        assert_eq!(categorize("Mystery", "", &[]), "neutral");
        let user = vec![json!({ "match": "youtube", "field": "title", "cat": "productive" })];
        assert_eq!(categorize("Chrome", "Rust talk - YouTube - Google Chrome", &user), "productive");
        assert_eq!(app_name("/usr/bin/firefox"), "Firefox");
        assert_eq!(app_name("C:\\Tools\\mytool.exe"), "Mytool");
    }

    #[test]
    fn tracker_with_mock_sampler_writes_merged_spans() {
        let db = Db::open_in_memory().unwrap();
        let samples = vec![smp("Code.exe", "a", 0), smp("Code.exe", "a", 0), smp("Code.exe", "a", 0), smp("chrome.exe", "YouTube - Google Chrome", 0), smp("Code.exe", "a", 999_999)];
        let mut mock = Mock(samples, 0);
        let mut t = Tracker::new(Config::default());
        assert_eq!(t.interval_ms(), 5000, "1.2 samples every 5 s by default");
        let base = local_day_start(now_ms()) + 3_600_000;
        for i in 0..5 {
            t.step(&mut mock, base + i * 5000);
        }
        assert_eq!(t.next_sleep_ms, IDLE_SLEEP_SECS as i64 * 1000, "AFK backs off to a long sleep");
        if let Some(s) = t.merger.close() {
            t.buffer.push(s);
        }
        assert_eq!(t.seen.len(), 2, "two distinct apps registered once each");
        t.flush_with(&db, &NoIcons);
        let c = db.conn();
        let rows = spans_in(&c, base - 1, base + 120_000);
        assert_eq!(rows.iter().filter(|r| !r.focus).count(), 3);
        assert_eq!(rows[0].app, "VS Code");
        assert_eq!(rows[0].end - rows[0].start, 15_000);
        assert!(rows[2].afk);
        assert_eq!(rows[2].end - rows[2].start, 30_000, "one AFK sample covers the whole back-off sleep");
        let s = summary(&c, base - 1, base + 120_000);
        assert_eq!(s["activeSecs"], 20);
        assert_eq!(s["categories"]["distracting"], 5);
        assert_eq!(s["topApp"], "VS Code");
        assert_eq!(s["sites"][0]["site"], "YouTube");
        assert_eq!(s["sites"][0]["domain"], "youtube.com");
        let apps = apps_in(&c, base - 1, base + 120_000);
        assert!(apps.iter().any(|a| a["app"] == "VS Code" && a["exe"] == "Code.exe"));
        // paused tracker records nothing new and sleeps long
        t.cfg.paused = true;
        t.step(&mut Mock(vec![smp("Code.exe", "b", 0)], 0), base + 60_000);
        assert_eq!(t.next_sleep_ms, IDLE_SLEEP_SECS as i64 * 1000);
        t.flush_with(&db, &NoIcons);
        assert_eq!(spans_in(&c, base - 1, base + 120_000).len(), 3);
    }

    #[test]
    fn write_spans_extends_continuing_rows() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let s = |a: &str, st: i64, en: i64| Span { app: a.into(), title: String::new(), start: st, end: en, afk: false };
        write_spans(&c, &[s("A", 1000, 2000)]).unwrap();
        write_spans(&c, &[s("A", 2000, 5000), s("B", 5000, 6000)]).unwrap();
        let n: i64 = c.query_row(r#"SELECT COUNT(*) FROM "TimeSpan""#, [], |r| r.get(0)).unwrap();
        assert_eq!(n, 2);
    }

    #[test]
    fn goals_alerts_retention_delete_range_and_rewards() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let now = now_ms();
        let day = local_day_start(now);
        let start = (now - 3 * 3_600_000).max(day);
        let dist = Span { app: "Chrome".into(), title: "x - YouTube - Google Chrome".into(), start, end: (start + 70 * 60_000).min(now), afk: false };
        write_spans(&c, std::slice::from_ref(&dist)).unwrap();
        let goals = goals_status(&c, now);
        let lim = goals.iter().find(|g| g["target"] == "distracting").unwrap();
        if dist.end - dist.start >= 60 * 60_000 {
            assert_eq!(lim["exceeded"], true);
            assert_eq!(new_goal_alerts(&c, now).len(), 1);
            assert_eq!(new_goal_alerts(&c, now).len(), 0, "alert fires once per day");
        }
        // retention
        write_spans(&c, &[Span { app: "Old".into(), title: String::new(), start: now - 100 * 86_400_000, end: now - 100 * 86_400_000 + 1000, afk: false }]).unwrap();
        assert_eq!(prune(&c, 90, now), 1);
        // delete range clips
        delete_range(&c, dist.start + 60_000, dist.start + 120_000).unwrap();
        let rows = spans_in(&c, 0, now + 1);
        assert_eq!(rows.len(), 2);
        // rewards: a productive yesterday → XP once
        let y = local_day_start(day - 3_600_000);
        write_spans(&c, &[Span { app: "VS Code".into(), title: String::new(), start: y + 3_600_000, end: y + 4 * 3_600_000, afk: false }]).unwrap();
        let xp0: i64 = c.query_row(r#"SELECT "xp" FROM "Pet""#, [], |r| r.get(0)).unwrap();
        let r = claim_rewards(&c, now);
        assert!(r["xp"].as_i64().unwrap() >= 30);
        let xp1: i64 = c.query_row(r#"SELECT "xp" FROM "Pet""#, [], |r| r.get(0)).unwrap();
        assert!(xp1 > xp0);
        assert_eq!(claim_rewards(&c, now)["xp"], 0);
        assert!(history(&c, 7, now)["streak"].as_i64().unwrap() >= 1);
    }

    #[test]
    fn streak_logic() {
        let d = |p: bool| json!({ "productiveDay": p });
        assert_eq!(streak_from(&[d(true), d(true), d(false)]), 2);
        assert_eq!(streak_from(&[d(true), d(true), d(true)]), 3);
        assert_eq!(streak_from(&[d(true), d(false), d(false)]), 0);
    }

    #[test]
    fn api_routes_and_export() {
        let db = Db::open_in_memory().unwrap();
        let c = db.conn();
        let q = HashMap::new();
        let b = Map::new();
        assert!(route(&c, "POST", &["seed"], &b, &q).is_some());
        let s = route(&c, "GET", &["summary"], &b, &q).unwrap();
        assert_eq!(s.status, 200);
        let mut pb = Map::new();
        pb.insert("paused".into(), json!(true));
        let p = route(&c, "POST", &["pause"], &pb, &q).unwrap();
        assert_eq!(p.json_value().unwrap()["paused"], true);
        assert!(load_config(&c).paused);
        let (mime, csv) = export(&c, 0, now_ms() + 1, "csv");
        assert_eq!(mime, "text/csv");
        assert!(csv.starts_with("app,title"));
        assert!(route(&c, "GET", &["nope"], &b, &q).is_none());
    }
}
