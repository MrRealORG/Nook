//! Nook's CPU budget.
//!
//! * **Background cap (Windows, opt-in, OFF by default since 1.3.1):** when the user enables it,
//!   the process is put in a Job Object at the start of `run()` (so WebView2 children are born
//!   inside it) but with NO rate limit. The `HARD_CAP` rate is only switched on while no Nook
//!   window is on screen (hidden to tray / minimised) and lifted the moment a window shows.
//!   1.3.0 hard-capped the whole tree — WebView2 renderer + GPU process included — at 10 % all
//!   the time, which starved the compositor: stutter, stale tiles ("ghost" rectangles), frozen
//!   onboarding and hangs. Foreground work (and therefore onboarding) is never capped now.
//! * **Escape check:** WebView2's runtime is launched by our process, so it inherits the job. If
//!   the runtime is ever started outside it (a pre-existing shared browser process, a broker that
//!   relaunches a child), `adopt_children` periodically enumerates our descendant processes
//!   (Toolhelp snapshot, parent-PID walk) and assigns any that are not in the job.
//! * **Priority:** normal while visible (BELOW_NORMAL was inherited by the renderer and made the
//!   UI lag under load); EcoQoS (`ProcessPowerThrottling`) is switched on for the whole tree
//!   while no Nook window is visible.
//! * Elsewhere every call is a no-op so Linux/macOS CI builds the same code.

use serde::Serialize;
use std::collections::{HashMap, HashSet};

pub const DEFAULT_CAP_PCT: u8 = 10;
pub const MIN_CAP_PCT: u8 = 5;
pub const MAX_CAP_PCT: u8 = 50;

/// Clamp a user value to the slider range.
pub fn clamp_cap(pct: u8) -> u8 {
    pct.clamp(MIN_CAP_PCT, MAX_CAP_PCT)
}

/// `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION.CpuRate` is in 1/100 of a percent: 10 % → 1000.
pub fn cpu_rate(pct: u8) -> u32 {
    clamp_cap(pct) as u32 * 100
}

/// Every descendant of `root` in a (pid, parent pid) process list. Guards against PID reuse
/// cycles (a parent PID that was recycled can point "down" the tree).
pub fn descendants(root: u32, procs: &[(u32, u32)]) -> Vec<u32> {
    let mut kids: HashMap<u32, Vec<u32>> = HashMap::new();
    for &(pid, ppid) in procs {
        if pid != ppid {
            kids.entry(ppid).or_default().push(pid);
        }
    }
    let mut seen = HashSet::from([root]);
    let mut out = vec![];
    let mut stack = vec![root];
    while let Some(p) = stack.pop() {
        for &k in kids.get(&p).map(Vec::as_slice).unwrap_or(&[]) {
            if seen.insert(k) {
                out.push(k);
                stack.push(k);
            }
        }
    }
    out
}

/// What the cap actually did, for Settings → Performance.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapStatus {
    pub supported: bool,
    pub applied: bool,
    pub cap_pct: u8,
    pub below_normal: bool,
    pub eco: bool,
    /// descendant processes found in the job / adopted into it on the last check
    pub children_in_job: usize,
    pub children_adopted: usize,
    pub error: Option<String>,
}

fn status() -> &'static std::sync::Mutex<CapStatus> {
    static S: std::sync::OnceLock<std::sync::Mutex<CapStatus>> = std::sync::OnceLock::new();
    S.get_or_init(|| std::sync::Mutex::new(CapStatus::default()))
}

pub fn cap_status() -> CapStatus {
    status().lock().map(|s| s.clone()).unwrap_or_default()
}

/// The cap must be known before the vault opens (the job has to exist before WebView2 starts),
/// so it is mirrored in a tiny file next to the vault: `<app data>/cpu-cap`.
pub fn cap_file(data_dir: &std::path::Path) -> std::path::PathBuf {
    data_dir.join("cpu-cap")
}

/// `<pct>` or `off`. Missing → off (1.3.1: the cap is opt-in); garbage → the default 10 %.
pub fn read_cap(data_dir: &std::path::Path) -> Option<u8> {
    match std::fs::read_to_string(cap_file(data_dir)).map(|s| s.trim().to_lowercase()) {
        Ok(s) if s == "off" || s.is_empty() => None,
        Ok(s) => Some(s.parse::<u8>().map(clamp_cap).unwrap_or(DEFAULT_CAP_PCT)),
        Err(_) => None,
    }
}

/// The cap the user enabled (None = off). The rate is only applied while in the background.
static CAP: std::sync::atomic::AtomicU8 = std::sync::atomic::AtomicU8::new(0);
static IN_BACKGROUND: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn enabled_cap() -> Option<u8> {
    match CAP.load(std::sync::atomic::Ordering::SeqCst) {
        0 => None,
        p => Some(p),
    }
}

/// The rate the job should have right now: capped only in the background, never in the foreground.
pub fn effective_rate(cap: Option<u8>, background: bool) -> Option<u32> {
    match (cap, background) {
        (Some(p), true) => Some(cpu_rate(p)),
        _ => None,
    }
}

pub fn write_cap(data_dir: &std::path::Path, cap: Option<u8>) {
    let _ = std::fs::create_dir_all(data_dir);
    let _ = std::fs::write(cap_file(data_dir), cap.map(|c| clamp_cap(c).to_string()).unwrap_or_else(|| "off".into()));
}

/// Where Tauri keeps app data on this OS (`app_data_dir()` without needing an AppHandle):
/// `%APPDATA%\com.realhackers.nook` on Windows.
pub fn early_data_dir(identifier: &str) -> Option<std::path::PathBuf> {
    #[cfg(windows)]
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from);
    #[cfg(target_os = "macos")]
    let base = std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join("Library/Application Support"));
    #[cfg(all(unix, not(target_os = "macos")))]
    let base = std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).or_else(|| std::env::var_os("HOME").map(|h| std::path::PathBuf::from(h).join(".local/share")));
    base.map(|b| b.join(identifier))
}

/// Call first thing in `run()`. `cap = Some(pct)` creates the (uncapped) job so WebView2 is born
/// inside it; the rate itself is only applied by `set_background(true)`. `cap = None` → no job.
pub fn apply_at_startup(cap: Option<u8>, below_normal: bool) {
    CAP.store(cap.map(clamp_cap).unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut st = CapStatus { supported: cfg!(windows), cap_pct: cap.map(clamp_cap).unwrap_or(0), ..Default::default() };
    #[cfg(windows)]
    {
        if below_normal {
            st.below_normal = win::set_below_normal();
        }
        if cap.is_some() {
            if let Err(e) = win::create_job(None) {
                st.error = Some(e);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = below_normal;
    }
    if let Ok(mut s) = status().lock() {
        *s = st;
    }
}

/// Change the cap at runtime (Settings slider). `None` turns it off. Applied immediately only
/// when Nook is already in the background.
pub fn set_cap(cap: Option<u8>) -> CapStatus {
    CAP.store(cap.map(clamp_cap).unwrap_or(0), std::sync::atomic::Ordering::SeqCst);
    #[cfg(windows)]
    {
        let r = win::update_rate(effective_rate(cap, IN_BACKGROUND.load(std::sync::atomic::Ordering::SeqCst)), cap.is_some());
        if let Ok(mut s) = status().lock() {
            s.cap_pct = cap.unwrap_or(0);
            match r {
                Ok(applied) => {
                    s.applied = applied;
                    s.error = None;
                }
                Err(e) => s.error = Some(e),
            }
        }
    }
    #[cfg(not(windows))]
    {
        if let Ok(mut s) = status().lock() {
            s.cap_pct = cap.unwrap_or(0);
        }
    }
    cap_status()
}

/// Assign any descendant process that escaped the job (see module docs). Cheap: one Toolhelp
/// snapshot. Run a few times after startup, then every few minutes.
pub fn adopt_children() {
    #[cfg(windows)]
    {
        let me = std::process::id();
        let procs = win::process_list();
        let kids = descendants(me, &procs);
        let (in_job, adopted) = win::adopt(&kids);
        if let Ok(mut s) = status().lock() {
            s.children_in_job = in_job;
            s.children_adopted += adopted;
        }
    }
}

/// EcoQoS (+ the opt-in hard cap) for the whole Nook tree while it is in the background (no
/// visible window). Both are lifted as soon as a window is on screen again.
pub fn set_background(eco: bool) {
    IN_BACKGROUND.store(eco, std::sync::atomic::Ordering::SeqCst);
    #[cfg(windows)]
    {
        let cap = enabled_cap();
        if cap.is_some() {
            let r = win::update_rate(effective_rate(cap, eco), true);
            if let Ok(mut s) = status().lock() {
                match r {
                    Ok(applied) => {
                        s.applied = applied;
                        s.error = None;
                    }
                    Err(e) => s.error = Some(e),
                }
            }
        }
        let me = std::process::id();
        let mut pids = vec![me];
        pids.extend(descendants(me, &win::process_list()));
        win::set_eco(&pids, eco);
    }
    #[cfg(not(windows))]
    let _ = enabled_cap();
    if let Ok(mut s) = status().lock() {
        s.eco = eco;
    }
}

#[cfg(windows)]
#[path = "perf_win.rs"]
mod win;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cap_math_and_clamping() {
        assert_eq!(cpu_rate(10), 1000);
        assert_eq!(cpu_rate(1), 500);
        assert_eq!(cpu_rate(90), 5000);
        assert_eq!(clamp_cap(33), 33);
    }

    #[test]
    fn descendants_walk_the_tree_and_survive_cycles() {
        // 100 → 200 (webview browser) → 300, 301 (renderer, gpu); 400 unrelated; 500 ↔ 501 cycle
        let procs = [(200, 100), (300, 200), (301, 200), (400, 1), (500, 501), (501, 500), (100, 100)];
        let mut d = descendants(100, &procs);
        d.sort();
        assert_eq!(d, vec![200, 300, 301]);
        assert!(descendants(500, &procs).contains(&501));
        assert_eq!(descendants(999, &procs), Vec::<u32>::new());
    }

    #[test]
    fn cap_file_roundtrip() {
        let d = std::env::temp_dir().join(format!("nook-cap-{}", std::process::id()));
        // 1.3.1: no file → off
        assert_eq!(read_cap(&d), None);
        write_cap(&d, Some(25));
        assert_eq!(read_cap(&d), Some(25));
        write_cap(&d, Some(99));
        assert_eq!(read_cap(&d), Some(MAX_CAP_PCT));
        write_cap(&d, None);
        assert_eq!(read_cap(&d), None);
        let _ = std::fs::remove_dir_all(&d);
        // no-op platforms still report sensibly
        apply_at_startup(Some(10), false);
        assert_eq!(cap_status().cap_pct, 10);
        assert_eq!(cap_status().supported, cfg!(windows));
    }

    #[test]
    fn never_capped_in_the_foreground() {
        assert_eq!(effective_rate(Some(10), false), None);
        assert_eq!(effective_rate(None, true), None);
        assert_eq!(effective_rate(Some(10), true), Some(1000));
        assert_eq!(effective_rate(Some(1), true), Some(500));
    }
}
