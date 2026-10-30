//! Background-CPU bench for the Rust side of Nook: runs the real Timelens tracker thread
//! (with a synthetic sampler standing in for Win32) plus the minute maintenance loop the
//! desktop shell runs, against a temp vault, and reports the process CPU time used.
//!   cargo run --release -p nook-core --bin nook-bgbench -- [--secs 60] [--db path]
//! Linux only for the numbers (/proc/self/task/*/schedstat); prints 0 elsewhere.

use nook_core::timelens::{self, Sample, Sampler};
use nook_core::Db;
use std::time::{Duration, Instant};

/// Cycles through a few apps like a real desktop; every sample costs roughly what the
/// Win32 path costs in string work (no syscalls are simulated).
struct Synthetic(u64);
impl Sampler for Synthetic {
    fn sample(&mut self) -> Option<Sample> {
        self.0 += 1;
        let apps = [("C:\\Program Files\\Microsoft VS Code\\Code.exe", "main.rs — nook"), ("C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", "Rust docs - Google Chrome"), ("C:\\Windows\\explorer.exe", "Downloads")];
        let (exe, title) = apps[(self.0 / 7) as usize % apps.len()];
        Some(Sample { exe: exe.into(), title: title.into(), idle_ms: 500, locked: false, pid: 4242, hwnd: 0x1234 })
    }
}

fn cpu_ns() -> u64 {
    // sum of on-CPU nanoseconds of every thread (/proc/self/task/*/schedstat, field 1)
    std::fs::read_dir("/proc/self/task")
        .map(|d| {
            d.filter_map(|e| e.ok())
                .filter_map(|e| std::fs::read_to_string(e.path().join("schedstat")).ok())
                .filter_map(|s| s.split_whitespace().next()?.parse::<u64>().ok())
                .sum()
        })
        .unwrap_or(0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let get = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).cloned();
    let secs: u64 = get("--secs").and_then(|s| s.parse().ok()).unwrap_or(60);
    let dir = std::env::temp_dir().join(format!("nook-bgbench-{}", std::process::id()));
    let path = get("--db").map(std::path::PathBuf::from).unwrap_or_else(|| dir.join("nook.db"));
    let db = Db::open(&path).expect("vault");
    timelens::seed_demo(&db.conn(), nook_core::db::now_ms()).ok();
    let t0 = Instant::now();
    let c0 = cpu_ns();
    timelens::start(db.clone(), Box::new(Synthetic(0)));
    // the desktop shell's maintenance loop (reminders, goals, tray text) — same cadence
    let mdb = db.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(nook_core::ext::MAINTENANCE_SECS));
        let _ = nook_core::ext::maintenance_db(&mdb);
        let _ = timelens::tray_status(&mdb.conn());
    });
    std::thread::sleep(Duration::from_secs(secs));
    let wall = t0.elapsed().as_secs_f64();
    let cpu_s = (cpu_ns() - c0) as f64 / 1e9;
    println!(
        "{{\"secs\":{wall:.1},\"cpuSecs\":{cpu_s:.5},\"cpuPct\":{:.4},\"intervalSecs\":{}}}",
        cpu_s / wall * 100.0,
        timelens::load_config(&db.conn()).interval_secs
    );
    let _ = std::fs::remove_dir_all(&dir);
}
