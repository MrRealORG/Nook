//! v1.4 — the Rules "Shield", enforced in the Rust background tracker (not in the webview).
//!
//! 1.3 evaluated rules only inside the webview's 60 s activity tick, against an in-app "current
//! app" that the desktop build never set — and even then it only showed a toast. So a blocked app
//! kept running and the Rules page said "Shield mode is down" (it defaulted to off).
//!
//! Now the Timelens thread judges every foreground sample (1 s tick + instant wake on a
//! foreground change) against the rulebook stored in the vault (`activity-rules`, written by the
//! Rules page):
//!
//! * **blocked apps / sites** — a block word matches the app name, its exe, or the browser tab's
//!   domain (from the address bar, else the title). Apps are minimised (or closed / killed, per
//!   the setting); browser tabs get Ctrl+W (or the window is minimised);
//! * **daily limits** — once today's tracked time for an app/site passes its budget it is bounced
//!   like a block;
//! * **quiet hours** — distracting apps/sites are bounced inside the window (neutral ones get a
//!   nudge only);
//! * optional **hosts file** entries for blocked domains (opt-in; needs Nook to run as admin).
//!
//! The matching is pure and unit-tested; the side effects go through [`Enforcer`] (Win32 on
//! Windows, a recorder in tests). Nook itself, Explorer, Task Manager and the lock screen are
//! never touched.

use crate::db::setting_get;
use crate::sites::{domain_matches, host_of};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;

pub const RULES_KEY: &str = "activity-rules";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppAction {
    /// minimise the window (default, gentle)
    Minimize,
    /// ask the window to close (WM_CLOSE)
    Close,
    /// terminate the process
    Kill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SiteAction {
    /// send Ctrl+W to the browser (closes the tab)
    CloseTab,
    /// minimise the browser window
    Minimize,
}

#[derive(Debug, Clone)]
pub struct Rules {
    pub on: bool,
    /// enabled block words, normalised (`https://www.reddit.com/` → `reddit.com`)
    pub blocks: Vec<String>,
    /// (key, minutes/day)
    pub limits: Vec<(String, i64)>,
    /// quiet window (from, to) in local hours, wraps midnight when from > to
    pub quiet: Option<(u32, u32)>,
    pub app_action: AppAction,
    pub site_action: SiteAction,
    pub hosts_file: bool,
}

impl Default for Rules {
    fn default() -> Self {
        Rules { on: false, blocks: vec![], limits: vec![], quiet: None, app_action: AppAction::Minimize, site_action: SiteAction::CloseTab, hosts_file: false }
    }
}

impl Rules {
    pub fn has_rules(&self) -> bool {
        !self.blocks.is_empty() || !self.limits.is_empty() || self.quiet.is_some()
    }
    /// Is there anything to enforce right now?
    pub fn active(&self) -> bool {
        self.on && self.has_rules()
    }
}

/// `reddit`, `Reddit.com`, `https://www.reddit.com/r/x` → `reddit` / `reddit.com`
pub fn norm_match(m: &str) -> String {
    let t = m.trim().to_lowercase();
    if t.contains('.') || t.contains("://") {
        if let Some(h) = host_of(&t) {
            return h;
        }
    }
    t
}

/// Parse the rulebook the Rules page saves (`RulesState` in `src/lib/rules.ts`).
pub fn parse(v: &Value) -> Rules {
    let blocks: Vec<String> = v["blocklist"]
        .as_array()
        .map(|a| a.iter().filter(|b| b["enabled"].as_bool().unwrap_or(true)).filter_map(|b| b["match"].as_str()).map(norm_match).filter(|m| m.len() >= 2).collect())
        .unwrap_or_default();
    let limits: Vec<(String, i64)> = v["limits"]
        .as_object()
        .map(|o| o.iter().filter_map(|(k, m)| Some((norm_match(k), m.as_i64().or_else(|| m.as_f64().map(|f| f as i64))?))).filter(|(k, m)| !k.is_empty() && *m > 0).collect())
        .unwrap_or_default();
    let q = &v["quiet"];
    let quiet = (q["enabled"].as_bool() == Some(true)).then(|| (q["from"].as_u64().unwrap_or(9).min(23) as u32, q["to"].as_u64().unwrap_or(12).min(23) as u32)).filter(|(f, t)| f != t);
    Rules {
        on: v["shieldOn"].as_bool().unwrap_or(false),
        blocks,
        limits,
        quiet,
        app_action: match v["appAction"].as_str() {
            Some("close") => AppAction::Close,
            Some("kill") => AppAction::Kill,
            _ => AppAction::Minimize,
        },
        site_action: match v["siteAction"].as_str() {
            Some("minimize") => SiteAction::Minimize,
            _ => SiteAction::CloseTab,
        },
        hosts_file: v["hostsFile"].as_bool().unwrap_or(false),
    }
}

pub fn load(c: &Connection) -> Rules {
    setting_get(c, RULES_KEY).and_then(|s| serde_json::from_str::<Value>(&s).ok()).map(|v| parse(&v)).unwrap_or_default()
}

/// What is in front of the user right now.
#[derive(Debug, Clone, Default)]
pub struct Fg {
    /// pretty app name (`Discord`, `Chrome`)
    pub app: String,
    /// exe path or file name
    pub exe: String,
    /// browser tab domain, when the foreground app is a browser and the site is known
    pub domain: Option<String>,
    pub browser: bool,
    /// effective Timelens category of this app/site
    pub cat: &'static str,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Reason {
    Blocked(String),
    Limit { key: String, mins: i64, used_secs: i64 },
    Quiet,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    Allow,
    /// bounce it
    Bounce(Reason),
    /// tell the user, don't act (neutral apps during quiet hours)
    Nudge(Reason),
}

const PROTECTED: &[&str] = &[
    "nook", "explorer", "lock screen", "lockapp", "taskmgr", "task manager", "searchhost", "searchapp", "shellexperiencehost", "startmenuexperiencehost", "systemsettings",
    "applicationframehost", "dwm", "winlogon", "consent", "logonui", "csrss",
];

fn exe_stem(exe: &str) -> String {
    let f = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase();
    f.strip_suffix(".exe").unwrap_or(&f).to_string()
}

pub fn is_protected(fg: &Fg) -> bool {
    let a = fg.app.to_lowercase();
    let e = exe_stem(&fg.exe);
    a.is_empty() || a == "afk" || PROTECTED.iter().any(|p| a == *p || e == *p)
}

/// The registrable label of a domain-looking match: `discord.com` → `discord` (so blocking the
/// site also blocks the desktop app of the same name).
fn label_of(m: &str) -> &str {
    if m.contains('.') {
        let parts: Vec<&str> = m.split('.').collect();
        if parts.len() >= 2 {
            return parts[parts.len() - 2];
        }
    }
    m
}

/// Does rule word `m` hit the foreground thing? Browsers: by site domain (and the browser's own
/// name, so `chrome` blocks Chrome); apps: by app name or exe.
pub fn hits(m: &str, fg: &Fg) -> bool {
    if m.is_empty() {
        return false;
    }
    let app = fg.app.to_lowercase();
    let exe = exe_stem(&fg.exe);
    if fg.browser {
        if let Some(d) = fg.domain.as_deref() {
            if m.contains('.') {
                if domain_matches(d, m) {
                    return true;
                }
            } else if d.split('.').any(|label| label == m) || (m.len() >= 4 && d.contains(m)) {
                return true;
            }
        }
        return app == m || exe == m;
    }
    let word = label_of(m);
    word.len() >= 2 && (app.contains(word) || exe.contains(word))
}

fn in_quiet(hour: u32, (from, to): (u32, u32)) -> bool {
    if from <= to {
        hour >= from && hour < to
    } else {
        hour >= from || hour < to
    }
}

/// Today's tracked seconds per app (lower-case name) and per domain.
#[derive(Debug, Clone, Default)]
pub struct Usage {
    pub day: String,
    pub apps: HashMap<String, i64>,
    pub domains: HashMap<String, i64>,
}

impl Usage {
    pub fn add(&mut self, app: &str, domain: Option<&str>, secs: i64) {
        *self.apps.entry(app.to_lowercase()).or_default() += secs;
        if let Some(d) = domain {
            *self.domains.entry(d.to_string()).or_default() += secs;
        }
    }
    /// Seconds today that a limit key covers (an app name/word or a domain).
    pub fn used_for(&self, key: &str) -> i64 {
        let mut s = 0;
        if key.contains('.') {
            s += self.domains.iter().filter(|(d, _)| domain_matches(d, key)).map(|(_, v)| *v).sum::<i64>();
            let w = label_of(key);
            if !w.is_empty() {
                s += self.apps.iter().filter(|(a, _)| a.contains(w)).map(|(_, v)| *v).sum::<i64>();
            }
        } else {
            s += self.apps.iter().filter(|(a, _)| a.as_str() == key || (key.len() >= 3 && a.contains(key))).map(|(_, v)| *v).sum::<i64>();
            s += self.domains.iter().filter(|(d, _)| d.split('.').any(|l| l == key)).map(|(_, v)| *v).sum::<i64>();
        }
        s
    }
}

/// The verdict for the foreground thing. Pure.
pub fn judge(rules: &Rules, fg: &Fg, usage: &Usage, hour: u32) -> Verdict {
    if !rules.active() || is_protected(fg) {
        return Verdict::Allow;
    }
    if let Some(m) = rules.blocks.iter().find(|m| hits(m, fg)) {
        return Verdict::Bounce(Reason::Blocked(m.clone()));
    }
    for (key, mins) in &rules.limits {
        if hits(key, fg) {
            let used = usage.used_for(key);
            if used >= mins * 60 {
                return Verdict::Bounce(Reason::Limit { key: key.clone(), mins: *mins, used_secs: used });
            }
        }
    }
    if let Some(q) = rules.quiet {
        if in_quiet(hour, q) {
            match fg.cat {
                "distracting" => return Verdict::Bounce(Reason::Quiet),
                "neutral" => return Verdict::Nudge(Reason::Quiet),
                _ => {}
            }
        }
    }
    Verdict::Allow
}

/// Side effects. `hwnd`/`pid` identify the foreground window.
pub trait Enforcer: Send {
    fn bounce_app(&mut self, hwnd: usize, pid: u32, action: AppAction) -> bool;
    fn bounce_tab(&mut self, hwnd: usize, action: SiteAction) -> bool;
}

/// Records what it was asked to do (tests, non-Windows).
#[derive(Default)]
pub struct NoopEnforcer {
    pub log: Vec<String>,
}

impl Enforcer for NoopEnforcer {
    fn bounce_app(&mut self, hwnd: usize, _pid: u32, action: AppAction) -> bool {
        self.log.push(format!("app {hwnd} {action:?}"));
        false
    }
    fn bounce_tab(&mut self, hwnd: usize, action: SiteAction) -> bool {
        self.log.push(format!("tab {hwnd} {action:?}"));
        false
    }
}

#[cfg(windows)]
#[path = "shield_win.rs"]
pub mod win;

pub fn platform_enforcer() -> Box<dyn Enforcer> {
    #[cfg(windows)]
    {
        Box::new(win::WinEnforcer)
    }
    #[cfg(not(windows))]
    {
        Box::new(NoopEnforcer::default())
    }
}

/// Engine state kept by the tracker: cooldowns so one bounce isn't repeated every tick (Ctrl+W
/// twice would close two tabs), plus counters for the Rules page.
#[derive(Default)]
pub struct Engine {
    pub rules: Rules,
    last: HashMap<(usize, String), i64>,
    nudged: HashMap<String, i64>,
    pub bounced_today: i64,
    pub last_event: Option<Value>,
}

/// After a bounce the same window/target is left alone this long.
pub const COOLDOWN_MS: i64 = 2_500;
pub const NUDGE_EVERY_MS: i64 = 5 * 60_000;

impl Engine {
    /// Judge + enforce one foreground sample. Returns an event for the UI when something happened.
    #[allow(clippy::too_many_arguments)]
    pub fn step(&mut self, fg: &Fg, hwnd: usize, pid: u32, usage: &Usage, hour: u32, now: i64, enforcer: &mut dyn Enforcer) -> Option<Value> {
        let v = judge(&self.rules, fg, usage, hour);
        let target = fg.domain.clone().filter(|_| fg.browser).unwrap_or_else(|| fg.app.clone());
        let (reason, bounce) = match v {
            Verdict::Allow => return None,
            Verdict::Bounce(r) => (r, true),
            Verdict::Nudge(r) => (r, false),
        };
        if !bounce {
            let last = self.nudged.get(&target).copied().unwrap_or(i64::MIN / 2);
            if now - last < NUDGE_EVERY_MS {
                return None;
            }
            self.nudged.insert(target.clone(), now);
            return Some(event("nudge", fg, &target, &reason, "none", false));
        }
        let key = (hwnd, target.clone());
        if let Some(t) = self.last.get(&key) {
            if now - t < COOLDOWN_MS {
                return None;
            }
        }
        self.last.insert(key, now);
        if self.last.len() > 64 {
            self.last.retain(|_, t| now - *t < 60_000);
        }
        let (done, action) = if fg.browser && fg.domain.is_some() {
            let a = match self.rules.site_action {
                SiteAction::CloseTab => "close-tab",
                SiteAction::Minimize => "minimize",
            };
            (enforcer.bounce_tab(hwnd, self.rules.site_action), a)
        } else {
            let a = match self.rules.app_action {
                AppAction::Minimize => "minimize",
                AppAction::Close => "close",
                AppAction::Kill => "kill",
            };
            (enforcer.bounce_app(hwnd, pid, self.rules.app_action), a)
        };
        self.bounced_today += 1;
        let ev = event("bounce", fg, &target, &reason, action, done);
        self.last_event = Some(ev.clone());
        Some(ev)
    }
}

fn event(kind: &str, fg: &Fg, target: &str, reason: &Reason, action: &str, done: bool) -> Value {
    let (why, rule, mins, used) = match reason {
        Reason::Blocked(m) => ("blocked", m.clone(), 0, 0),
        Reason::Limit { key, mins, used_secs } => ("limit", key.clone(), *mins, *used_secs),
        Reason::Quiet => ("quiet", String::new(), 0, 0),
    };
    let label = if fg.browser && fg.domain.is_some() { target.to_string() } else { fg.app.clone() };
    let text = match why {
        "blocked" => format!("{label} is blocked by your rules"),
        "limit" => format!("{label} is over its {mins} min daily limit"),
        _ if kind == "nudge" => format!("Quiet hours — {label} isn't productive"),
        _ => format!("Quiet hours — {label} is a distraction"),
    };
    json!({ "type": kind, "app": fg.app, "domain": fg.domain, "target": target, "reason": why, "rule": rule, "mins": mins, "usedSecs": used, "action": action, "done": done, "text": text, "at": crate::db::now_ms() })
}

// ------------------------------------------------------------------ hosts file (opt-in)

pub const HOSTS_BEGIN: &str = "# >>> Nook Shield (managed by Nook - do not edit inside this block)";
pub const HOSTS_END: &str = "# <<< Nook Shield";

/// The hosts file with Nook's block replaced by entries for `domains` (or removed when empty).
pub fn hosts_with(current: &str, domains: &[String]) -> String {
    let mut out: Vec<&str> = vec![];
    let mut skip = false;
    for line in current.lines() {
        if line.trim() == HOSTS_BEGIN {
            skip = true;
            continue;
        }
        if skip {
            if line.trim() == HOSTS_END {
                skip = false;
            }
            continue;
        }
        out.push(line);
    }
    while out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
        out.pop();
    }
    let mut s = out.join("\r\n");
    if !domains.is_empty() {
        if !s.is_empty() {
            s.push_str("\r\n\r\n");
        }
        s.push_str(HOSTS_BEGIN);
        s.push_str("\r\n");
        for d in domains {
            s.push_str(&format!("0.0.0.0 {d}\r\n0.0.0.0 www.{d}\r\n"));
        }
        s.push_str(HOSTS_END);
    }
    s.push_str("\r\n");
    s
}

/// Blocked words that are real domains (only those can go in the hosts file).
pub fn hosts_domains(rules: &Rules) -> Vec<String> {
    if !(rules.on && rules.hosts_file) {
        return vec![];
    }
    let mut d: Vec<String> = rules.blocks.iter().filter(|m| m.contains('.') && crate::tlapps::valid_domain(m)).cloned().collect();
    d.sort();
    d.dedup();
    d
}

pub fn hosts_path() -> std::path::PathBuf {
    if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(|| std::path::PathBuf::from("C:\\Windows"));
        root.join("System32").join("drivers").join("etc").join("hosts")
    } else {
        std::path::PathBuf::from("/etc/hosts")
    }
}

/// Write (or clean up) the hosts block. Returns a status string for the Rules page. Only touches
/// the file when Nook's block would change; a missing permission is reported, never fatal.
pub fn sync_hosts(rules: &Rules, path: &std::path::Path) -> String {
    let domains = hosts_domains(rules);
    let current = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => return if domains.is_empty() { "off".into() } else { format!("error: can't read the hosts file ({e})") },
    };
    if domains.is_empty() && !current.contains(HOSTS_BEGIN) {
        return "off".into();
    }
    let ok = || if domains.is_empty() { "off".to_string() } else { format!("ok: {} domains", domains.len()) };
    let next = hosts_with(&current, &domains);
    if next == current {
        return ok();
    }
    match std::fs::write(path, next) {
        Ok(_) => ok(),
        Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => "needs-admin: run Nook as administrator once to write the hosts file".into(),
        Err(e) => format!("error: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fg(app: &str, exe: &str, domain: Option<&str>, cat: &'static str) -> Fg {
        let browser = crate::timelens::is_browser(app);
        Fg { app: app.into(), exe: exe.into(), domain: domain.map(String::from), browser, cat }
    }
    fn rules(v: Value) -> Rules {
        parse(&v)
    }

    #[test]
    fn parses_the_rules_page_state() {
        let r = rules(json!({
            "shieldOn": true,
            "blocklist": [{ "match": "https://www.Reddit.com/r/all", "enabled": true }, { "match": "steam", "enabled": false }, { "match": "discord", "enabled": true }],
            "limits": { "youtube.com": 30, "chrome": 0 },
            "quiet": { "enabled": true, "from": 22, "to": 7 },
            "appAction": "kill", "siteAction": "minimize", "hostsFile": true,
        }));
        assert!(r.active());
        assert_eq!(r.blocks, vec!["reddit.com".to_string(), "discord".to_string()]);
        assert_eq!(r.limits, vec![("youtube.com".to_string(), 30)]);
        assert_eq!(r.quiet, Some((22, 7)));
        assert_eq!((r.app_action, r.site_action, r.hosts_file), (AppAction::Kill, SiteAction::Minimize, true));
        assert!(!parse(&json!({ "blocklist": [{ "match": "xy", "enabled": true }] })).active(), "shield off by default");
    }

    #[test]
    fn block_matching_apps_and_sites() {
        let r = rules(json!({ "shieldOn": true, "blocklist": [{ "match": "reddit", "enabled": true }, { "match": "discord.com", "enabled": true }, { "match": "steam", "enabled": true }] }));
        let u = Usage::default();
        assert!(matches!(judge(&r, &fg("Chrome", "chrome.exe", Some("reddit.com"), "distracting"), &u, 10), Verdict::Bounce(Reason::Blocked(_))));
        assert!(matches!(judge(&r, &fg("Chrome", "chrome.exe", Some("old.reddit.com"), "distracting"), &u, 10), Verdict::Bounce(_)));
        assert_eq!(judge(&r, &fg("Chrome", "chrome.exe", Some("github.com"), "productive"), &u, 10), Verdict::Allow);
        assert_eq!(judge(&r, &fg("Chrome", "chrome.exe", None, "neutral"), &u, 10), Verdict::Allow, "a browser itself is not blocked by a site word");
        // a domain rule blocks the site AND the desktop app of the same name
        assert!(matches!(judge(&r, &fg("Chrome", "chrome.exe", Some("discord.com"), "neutral"), &u, 10), Verdict::Bounce(_)));
        assert!(matches!(judge(&r, &fg("Discord", "C:\\x\\Discord.exe", None, "neutral"), &u, 10), Verdict::Bounce(_)));
        assert!(matches!(judge(&r, &fg("Steam", "steam.exe", None, "distracting"), &u, 10), Verdict::Bounce(_)));
        assert_eq!(judge(&r, &fg("VS Code", "Code.exe", None, "productive"), &u, 10), Verdict::Allow);
        // never Nook / Explorer / Task Manager
        let all = rules(json!({ "shieldOn": true, "blocklist": [{ "match": "ex", "enabled": true }, { "match": "nook", "enabled": true }, { "match": "explorer", "enabled": true }, { "match": "task", "enabled": true }] }));
        assert_eq!(judge(&all, &fg("Nook", "nook.exe", None, "productive"), &u, 10), Verdict::Allow);
        assert_eq!(judge(&all, &fg("Explorer", "explorer.exe", None, "neutral"), &u, 10), Verdict::Allow);
        assert_eq!(judge(&all, &fg("Taskmgr", "Taskmgr.exe", None, "neutral"), &u, 10), Verdict::Allow);
        // shield down → nothing
        let off = Rules { on: false, ..r.clone() };
        assert_eq!(judge(&off, &fg("Steam", "steam.exe", None, "distracting"), &u, 10), Verdict::Allow);
    }

    #[test]
    fn limits_and_quiet_hours() {
        let r = rules(json!({ "shieldOn": true, "limits": { "youtube.com": 30, "spotify": 10 }, "quiet": { "enabled": true, "from": 22, "to": 7 } }));
        let mut u = Usage::default();
        u.add("Chrome", Some("youtube.com"), 29 * 60);
        let yt = fg("Chrome", "chrome.exe", Some("youtube.com"), "distracting");
        assert_eq!(judge(&r, &yt, &u, 12), Verdict::Allow, "under budget");
        u.add("Chrome", Some("m.youtube.com"), 61);
        assert!(matches!(judge(&r, &yt, &u, 12), Verdict::Bounce(Reason::Limit { mins: 30, .. })));
        u.add("Spotify", None, 600);
        assert!(matches!(judge(&r, &fg("Spotify", "Spotify.exe", None, "neutral"), &u, 12), Verdict::Bounce(Reason::Limit { .. })));
        // quiet hours wrap midnight: distracting bounces, neutral nudges, productive passes
        let x = fg("Chrome", "chrome.exe", Some("x.com"), "distracting");
        assert_eq!(judge(&r, &x, &u, 23), Verdict::Bounce(Reason::Quiet));
        assert_eq!(judge(&r, &x, &u, 3), Verdict::Bounce(Reason::Quiet));
        assert_eq!(judge(&r, &x, &u, 12), Verdict::Allow);
        assert_eq!(judge(&r, &fg("Slack", "slack.exe", None, "neutral"), &u, 23), Verdict::Nudge(Reason::Quiet));
        assert_eq!(judge(&r, &fg("VS Code", "Code.exe", None, "productive"), &u, 23), Verdict::Allow);
    }

    #[test]
    fn engine_enforces_with_cooldown() {
        let mut e = Engine { rules: rules(json!({ "shieldOn": true, "blocklist": [{ "match": "reddit", "enabled": true }, { "match": "steam", "enabled": true }] })), ..Default::default() };
        let mut enf = NoopEnforcer::default();
        let u = Usage::default();
        let tab = fg("Chrome", "chrome.exe", Some("reddit.com"), "distracting");
        let ev = e.step(&tab, 7, 1, &u, 10, 1_000, &mut enf).unwrap();
        assert_eq!((ev["type"].as_str(), ev["reason"].as_str(), ev["action"].as_str()), (Some("bounce"), Some("blocked"), Some("close-tab")));
        assert!(e.step(&tab, 7, 1, &u, 10, 2_000, &mut enf).is_none(), "cooldown: never two Ctrl+W in a row");
        assert!(e.step(&tab, 7, 1, &u, 10, 1_000 + COOLDOWN_MS, &mut enf).is_some());
        e.step(&fg("Steam", "steam.exe", None, "distracting"), 9, 2, &u, 10, 5_000, &mut enf).unwrap();
        assert_eq!(enf.log, vec!["tab 7 CloseTab", "tab 7 CloseTab", "app 9 Minimize"]);
        assert_eq!(e.bounced_today, 3);
    }

    #[test]
    fn hosts_block_is_added_replaced_and_removed() {
        let base = "127.0.0.1 localhost\r\n# my entry\r\n";
        let r = rules(json!({ "shieldOn": true, "hostsFile": true, "blocklist": [{ "match": "reddit.com", "enabled": true }, { "match": "steam", "enabled": true }] }));
        let d = hosts_domains(&r);
        assert_eq!(d, vec!["reddit.com".to_string()]);
        let with = hosts_with(base, &d);
        assert!(with.contains("0.0.0.0 reddit.com") && with.contains("0.0.0.0 www.reddit.com") && with.starts_with("127.0.0.1 localhost"));
        assert_eq!(hosts_with(&with, &d), with, "idempotent");
        let cleaned = hosts_with(&with, &[]);
        assert!(!cleaned.contains("Nook Shield") && cleaned.contains("# my entry"));
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("hosts");
        std::fs::write(&p, base).unwrap();
        assert!(sync_hosts(&r, &p).starts_with("ok"));
        assert!(std::fs::read_to_string(&p).unwrap().contains("reddit.com"));
        assert_eq!(sync_hosts(&Rules { hosts_file: false, ..r }, &p), "off");
        assert!(!std::fs::read_to_string(&p).unwrap().contains("reddit.com"));
    }
}
