//! 1.3.1 — persistent app log + crash capture.
//!
//! * A `log::Log` implementation for the whole Rust side (shell + `nook-core`): every record goes
//!   to `<log dir>/nook.log` with size rotation (`nook.log` → `nook.1.log` … `nook.4.log`,
//!   5 files × 1 MB) and into a small in-memory ring the Settings ▸ Logs viewer tails.
//! * The web UI appends its own lines through the `log_write` command, so one file holds both.
//! * A panic hook writes the panic + location to the log and to `last-crash.txt`; the next launch
//!   offers a bug report from it (`take_crash`).
//! * Log dir: `%APPDATA%\Nook\logs` on Windows, `<app data>/logs` elsewhere.
//!
//! Verbose (debug-level) logging is off by default and toggled at runtime.

use serde::Serialize;
use std::collections::VecDeque;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;

pub const MAX_BYTES: u64 = 1024 * 1024;
pub const MAX_FILES: usize = 5;
const RING: usize = 600;

#[derive(Debug, Clone, Serialize)]
pub struct Line {
    pub id: u64,
    pub t: i64,
    pub level: String,
    pub source: String,
    pub msg: String,
}

struct Inner {
    dir: Option<PathBuf>,
    ring: VecDeque<Line>,
}

static INNER: Mutex<Inner> = Mutex::new(Inner { dir: None, ring: VecDeque::new() });
static SEQ: AtomicU64 = AtomicU64::new(1);
static VERBOSE: AtomicBool = AtomicBool::new(false);

/// `%APPDATA%\Nook\logs` (Windows) or `<data_dir>/logs`.
pub fn log_dir(data_dir: Option<&Path>) -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(a) = std::env::var_os("APPDATA") {
            return Some(PathBuf::from(a).join("Nook").join("logs"));
        }
    }
    data_dir.map(|d| d.join("logs"))
}

pub fn current_dir() -> Option<PathBuf> {
    INNER.lock().ok().and_then(|i| i.dir.clone())
}

pub fn set_verbose(on: bool) {
    VERBOSE.store(on, Ordering::SeqCst);
    log::set_max_level(if on { log::LevelFilter::Debug } else { log::LevelFilter::Info });
}

pub fn verbose() -> bool {
    VERBOSE.load(Ordering::SeqCst)
}

/// Rotate `nook.log` when it would exceed `max` bytes: `nook.(n-1).log` is dropped, the rest
/// shift up by one. Pure file ops so it is unit-testable.
pub fn rotate_if_needed(dir: &Path, incoming: u64, max: u64, files: usize) {
    let cur = dir.join("nook.log");
    let size = std::fs::metadata(&cur).map(|m| m.len()).unwrap_or(0);
    if size == 0 || size + incoming <= max {
        return;
    }
    let _ = std::fs::remove_file(dir.join(format!("nook.{}.log", files - 1)));
    for i in (1..files - 1).rev() {
        let _ = std::fs::rename(dir.join(format!("nook.{i}.log")), dir.join(format!("nook.{}.log", i + 1)));
    }
    let _ = std::fs::rename(&cur, dir.join("nook.1.log"));
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn stamp(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms).map(|d| d.format("%Y-%m-%d %H:%M:%S%.3f UTC").to_string()).unwrap_or_default()
}

/// Record one line (ring + file). Never panics, never blocks for long (the file write is tiny).
pub fn write(level: &str, source: &str, msg: &str) {
    let msg: String = msg.chars().take(4000).collect();
    let line = Line { id: SEQ.fetch_add(1, Ordering::SeqCst), t: now_ms(), level: level.to_lowercase(), source: source.into(), msg };
    let Ok(mut inner) = INNER.lock() else { return };
    if let Some(dir) = inner.dir.clone() {
        let text = format!("{} {:<5} [{}] {}\n", stamp(line.t), line.level.to_uppercase(), line.source, line.msg);
        rotate_if_needed(&dir, text.len() as u64, MAX_BYTES, MAX_FILES);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("nook.log")) {
            let _ = f.write_all(text.as_bytes());
        }
    }
    if inner.ring.len() >= RING {
        inner.ring.pop_front();
    }
    inner.ring.push_back(line);
}

/// Lines newer than `since` (id), oldest first.
pub fn since(since: u64) -> Vec<Line> {
    INNER.lock().map(|i| i.ring.iter().filter(|l| l.id > since).cloned().collect()).unwrap_or_default()
}

pub fn clear() {
    if let Ok(mut i) = INNER.lock() {
        i.ring.clear();
        if let Some(d) = i.dir.clone() {
            let _ = std::fs::write(d.join("nook.log"), b"");
        }
    }
}

/// The tail of the on-disk log (for bug reports), at most `max` bytes.
pub fn tail(max: usize) -> String {
    let Some(d) = current_dir() else { return String::new() };
    let s = std::fs::read_to_string(d.join("nook.log")).unwrap_or_default();
    if s.len() <= max {
        return s;
    }
    let mut cut = s.len() - max;
    while !s.is_char_boundary(cut) {
        cut += 1;
    }
    s[cut..].to_string()
}

struct Logger;

impl log::Log for Logger {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info || (verbose() && m.level() <= log::Level::Debug)
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        // keep noisy dependency chatter out unless verbose
        let target = r.target();
        let ours = target.starts_with("nook");
        if !ours && !verbose() && r.level() > log::Level::Warn {
            return;
        }
        write(r.level().as_str(), if ours { "rust" } else { target }, &r.args().to_string());
    }
    fn flush(&self) {}
}

static LOGGER: Logger = Logger;

/// Install the logger + panic hook. Call once, first thing in `run()`.
pub fn init(data_dir: Option<&Path>) {
    let dir = log_dir(data_dir);
    if let Some(d) = &dir {
        if let Err(e) = std::fs::create_dir_all(d) {
            eprintln!("nook: cannot create log dir {}: {e}", d.display());
        }
    }
    if let Ok(mut i) = INNER.lock() {
        i.dir = dir.filter(|d| d.is_dir());
    }
    let _ = log::set_logger(&LOGGER);
    set_verbose(false);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let loc = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        let payload = info.payload().downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| info.payload().downcast_ref::<String>().cloned()).unwrap_or_else(|| "panic".into());
        let thread = std::thread::current().name().unwrap_or("?").to_string();
        let msg = format!("PANIC in thread '{thread}' at {loc}: {payload}");
        write("error", "panic", &msg);
        if let Some(d) = current_dir() {
            let _ = std::fs::write(d.join("last-crash.txt"), format!("{}\n{msg}\n", stamp(now_ms())));
        }
        prev(info);
    }));
}

/// The crash recorded by the previous run, removed once read.
pub fn take_crash() -> Option<String> {
    let p = current_dir()?.join("last-crash.txt");
    let s = std::fs::read_to_string(&p).ok()?;
    let _ = std::fs::remove_file(&p);
    (!s.trim().is_empty()).then_some(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotation_keeps_at_most_n_files() {
        let d = std::env::temp_dir().join(format!("nook-logrot-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        for round in 0..8 {
            std::fs::write(d.join("nook.log"), vec![b'x'; 900]).unwrap();
            rotate_if_needed(&d, 200, 1000, 5);
            assert!(!d.join("nook.log").exists(), "round {round}: current rotated away");
        }
        let n = std::fs::read_dir(&d).unwrap().count();
        assert_eq!(n, 4, "nook.1..4.log kept, nothing older");
        assert!(!d.join("nook.5.log").exists());
        // small writes do not rotate
        std::fs::write(d.join("nook.log"), b"abc").unwrap();
        rotate_if_needed(&d, 10, 1000, 5);
        assert!(d.join("nook.log").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn ring_and_tail() {
        write("info", "test", "hello ring");
        let l = since(0);
        assert!(l.iter().any(|x| x.msg == "hello ring" && x.level == "info"));
        let last = l.last().unwrap().id;
        assert!(since(last).is_empty());
    }
}
