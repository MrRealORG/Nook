//! Win32 side of `perf.rs` (Job Object background CPU cap, priority, EcoQoS, child adoption).
//! Its own file so the standalone `wincheck` crate type-checks it verbatim for
//! x86_64-pc-windows-msvc.

use std::sync::atomic::{AtomicUsize, Ordering};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob, JobObjectCpuRateControlInformation, SetInformationJobObject, JOBOBJECT_CPU_RATE_CONTROL_INFORMATION,
    JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0, JOB_OBJECT_CPU_RATE_CONTROL_ENABLE, JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, OpenProcess, ProcessPowerThrottling, SetPriorityClass, SetProcessInformation, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_POWER_THROTTLING_CURRENT_VERSION,
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED, PROCESS_POWER_THROTTLING_STATE, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
};

/// The job handle, kept for the life of the process (closing it would drop the cap).
static JOB: AtomicUsize = AtomicUsize::new(0);

fn job() -> HANDLE {
    JOB.load(Ordering::SeqCst) as HANDLE
}

unsafe fn set_rate(job: HANDLE, rate: Option<u32>) -> bool {
    let info = JOBOBJECT_CPU_RATE_CONTROL_INFORMATION {
        ControlFlags: if rate.is_some() { JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP } else { 0 },
        Anonymous: JOBOBJECT_CPU_RATE_CONTROL_INFORMATION_0 { CpuRate: rate.unwrap_or(10_000) },
    };
    SetInformationJobObject(
        job,
        JobObjectCpuRateControlInformation,
        (&info as *const JOBOBJECT_CPU_RATE_CONTROL_INFORMATION).cast(),
        std::mem::size_of::<JOBOBJECT_CPU_RATE_CONTROL_INFORMATION>() as u32,
    ) != 0
}

/// Create an anonymous job (optionally with a hard CPU-rate cap) and put this process in it. Run
/// before any child process exists so every child (WebView2) inherits membership.
pub fn create_job(rate: Option<u32>) -> Result<(), String> {
    // SAFETY: anonymous job, default security; the handle is kept open for the process lifetime.
    unsafe {
        let j = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if j.is_null() {
            return Err(format!("CreateJobObjectW failed ({})", std::io::Error::last_os_error()));
        }
        if rate.is_some() && !set_rate(j, rate) {
            let e = std::io::Error::last_os_error();
            CloseHandle(j);
            return Err(format!("CPU rate control unavailable ({e})"));
        }
        if AssignProcessToJobObject(j, GetCurrentProcess()) == 0 {
            // e.g. a parent job that forbids nesting (pre-Windows 8 semantics)
            let e = std::io::Error::last_os_error();
            CloseHandle(j);
            return Err(format!("AssignProcessToJobObject failed ({e})"));
        }
        JOB.store(j as usize, Ordering::SeqCst);
    }
    Ok(())
}

/// Change (or lift, with None) the rate of the job. `want_job` creates the job when the user
/// enabled the cap after startup (existing children are adopted by `adopt` on the next pass).
/// Returns whether a rate is in effect.
pub fn update_rate(rate: Option<u32>, want_job: bool) -> Result<bool, String> {
    let j = job();
    if j.is_null() {
        return if want_job { create_job(rate).map(|_| rate.is_some()) } else { Ok(false) };
    }
    // SAFETY: `j` is our live job handle.
    if unsafe { set_rate(j, rate) } {
        Ok(rate.is_some())
    } else {
        Err(format!("SetInformationJobObject failed ({})", std::io::Error::last_os_error()))
    }
}

pub fn set_below_normal() -> bool {
    // SAFETY: pseudo-handle of the current process.
    unsafe { SetPriorityClass(GetCurrentProcess(), BELOW_NORMAL_PRIORITY_CLASS) != 0 }
}

/// (pid, parent pid) for every process (one Toolhelp snapshot).
pub fn process_list() -> Vec<(u32, u32)> {
    let mut out = vec![];
    // SAFETY: snapshot handle checked and closed; entry struct sized per the API contract.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE_VALUE {
            return out;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut e) != 0 {
            loop {
                out.push((e.th32ProcessID, e.th32ParentProcessID));
                if Process32NextW(snap, &mut e) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
    }
    out
}

/// Put every given pid that is not yet in our job into it. Returns (in job, newly adopted).
pub fn adopt(pids: &[u32]) -> (usize, usize) {
    let j = job();
    if j.is_null() {
        return (0, 0);
    }
    let (mut in_job, mut adopted) = (0, 0);
    for &pid in pids {
        // SAFETY: handle checked for null and always closed.
        unsafe {
            let h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                continue;
            }
            let mut inside: BOOL = 0;
            if IsProcessInJob(h, j, &mut inside) != 0 && inside != 0 {
                in_job += 1;
            } else if AssignProcessToJobObject(j, h) != 0 {
                in_job += 1;
                adopted += 1;
            }
            CloseHandle(h);
        }
    }
    (in_job, adopted)
}

/// EcoQoS on/off for each pid (Windows 11 efficiency mode; ignored by older Windows).
pub fn set_eco(pids: &[u32], on: bool) {
    let st = PROCESS_POWER_THROTTLING_STATE {
        Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        StateMask: if on { PROCESS_POWER_THROTTLING_EXECUTION_SPEED } else { 0 },
    };
    for &pid in pids {
        // SAFETY: handle checked for null and closed; struct passed with its exact size.
        unsafe {
            let h = if pid == std::process::id() { GetCurrentProcess() } else { OpenProcess(PROCESS_SET_INFORMATION, 0, pid) };
            if h.is_null() {
                continue;
            }
            SetProcessInformation(h, ProcessPowerThrottling, (&st as *const PROCESS_POWER_THROTTLING_STATE).cast(), std::mem::size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32);
            if pid != std::process::id() {
                CloseHandle(h);
            }
        }
    }
}
