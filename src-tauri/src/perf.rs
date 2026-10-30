//! Nook's CPU budget.
//!
//! * **Hard cap (Windows):** at the very start of `run()` — before Tauri creates any window, so
//!   before WebView2 spawns `msedgewebview2.exe` — the process is put in a Job Object with
//!   `JOBOBJECT_CPU_RATE_CONTROL_INFORMATION { ENABLE | HARD_CAP, CpuRate = pct × 100 }`.
//!   Children inherit job membership, so the WebView2 browser/GPU/renderer processes are capped
//!   together with Nook (the cap is for the whole tree, as a share of the whole machine).
//! * **Escape check:** WebView2's runtime is launched by our process, so it inherits the job. If
//!   the runtime is ever started outside it (a pre-existing shared browser process, a broker that
//!   relaunches a child), `adopt_children` periodically enumerates our descendant processes
//!   (Toolhelp snapshot, parent-PID walk) and assigns any that are not in the job.
//! * **Priority:** the process runs at BELOW_NORMAL (inherited by children), and EcoQoS
//!   (`ProcessPowerThrottling`) is switched on for the whole tree while no Nook window is visible.
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

/// `<pct>` or `off`. Missing/garbage → the default 10 %.
pub fn read_cap(data_dir: &std::path::Path) -> Option<u8> {
    match std::fs::read_to_string(cap_file(data_dir)).map(|s| s.trim().to_lowercase()) {
        Ok(s) if s == "off" => None,
        Ok(s) => Some(s.parse::<u8>().map(clamp_cap).unwrap_or(DEFAULT_CAP_PCT)),
        Err(_) => Some(DEFAULT_CAP_PCT),
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

/// Call first thing in `run()`: job object + hard cap + BELOW_NORMAL. `cap = None` → no cap.
pub fn apply_at_startup(cap: Option<u8>, below_normal: bool) {
    #[cfg_attr(not(windows), allow(unused_mut))]
    let mut st = CapStatus { supported: cfg!(windows), cap_pct: cap.unwrap_or(0), ..Default::default() };
    #[cfg(windows)]
    {
        if below_normal {
            st.below_normal = win::set_below_normal();
        }
        if let Some(pct) = cap {
            match win::create_capped_job(cpu_rate(pct)) {
                Ok(()) => st.applied = true,
                Err(e) => st.error = Some(e),
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

/// Change the cap at runtime (Settings slider). `None` lifts it (rate 100 %).
pub fn set_cap(cap: Option<u8>) -> CapStatus {
    #[cfg(windows)]
    {
        let r = match cap {
            Some(p) => win::update_rate(Some(cpu_rate(p))),
            None => win::update_rate(None),
        };
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

/// EcoQoS for the whole Nook tree while it is in the background (no visible window).
pub fn set_background(eco: bool) {
    #[cfg(windows)]
    {
        let me = std::process::id();
        let mut pids = vec![me];
        pids.extend(descendants(me, &win::process_list()));
        win::set_eco(&pids, eco);
    }
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
        assert_eq!(read_cap(&d), Some(DEFAULT_CAP_PCT));
        write_cap(&d, Some(25));
        assert_eq!(read_cap(&d), Some(25));
        write_cap(&d, Some(99));
        assert_eq!(read_cap(&d), Some(MAX_CAP_PCT));
        write_cap(&d, None);
        assert_eq!(read_cap(&d), None);
        let _ = std::fs::remove_dir_all(&d);
        // no-op platforms still report sensibly
        apply_at_startup(Some(10), true);
        assert_eq!(cap_status().cap_pct, 10);
        assert_eq!(cap_status().supported, cfg!(windows));
    }
}
