//! Windows sampler for Timelens (Win32). Kept in its own file so the standalone
//! `wincheck` crate can type-check it verbatim against x86_64-pc-windows-msvc.

use super::{ExeCache, Sample, Sampler};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{
    GetCurrentThread, OpenProcess, QueryFullProcessImageNameW, SetThreadInformation, SetThreadPriority, ThreadPowerThrottling, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, THREAD_POWER_THROTTLING_CURRENT_VERSION, THREAD_POWER_THROTTLING_EXECUTION_SPEED, THREAD_POWER_THROTTLING_STATE,
    THREAD_PRIORITY_LOWEST,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::WindowsAndMessaging::{EnumChildWindows, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId};

#[derive(Default)]
pub struct WinSampler {
    cache: ExeCache,
}

pub fn lower_current_thread() {
    // SAFETY: pseudo-handle of the current thread; the struct is sized as the API expects.
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_LOWEST);
        let st = THREAD_POWER_THROTTLING_STATE {
            Version: THREAD_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
            StateMask: THREAD_POWER_THROTTLING_EXECUTION_SPEED,
        };
        SetThreadInformation(GetCurrentThread(), ThreadPowerThrottling, (&st as *const THREAD_POWER_THROTTLING_STATE).cast(), std::mem::size_of::<THREAD_POWER_THROTTLING_STATE>() as u32);
    }
}

fn exe_of(pid: u32) -> String {
    let mut exe = String::new();
    if pid == 0 {
        return exe;
    }
    // SAFETY: handle checked for null and closed; buffer length passed in/out.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if !h.is_null() {
            let mut path = [0u16; 1024];
            let mut len = path.len() as u32;
            if QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut len) != 0 {
                exe = String::from_utf16_lossy(&path[..len as usize]);
            }
            CloseHandle(h);
        }
    }
    exe
}

struct Find {
    host: u32,
    found: u32,
}

unsafe extern "system" fn child_proc(hwnd: HWND, lp: LPARAM) -> BOOL {
    let f = &mut *(lp as *mut Find);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, &mut pid);
    if pid != 0 && pid != f.host {
        f.found = pid;
        return 0; // stop
    }
    1
}

/// UWP apps are hosted by ApplicationFrameHost.exe: the real app owns a child window.
fn uwp_child_pid(hwnd: HWND, host: u32) -> u32 {
    let mut f = Find { host, found: 0 };
    // SAFETY: `f` outlives the synchronous enumeration.
    unsafe {
        EnumChildWindows(hwnd, Some(child_proc), &mut f as *mut Find as LPARAM);
    }
    f.found
}

impl Sampler for WinSampler {
    fn sample(&mut self) -> Option<Sample> {
        // SAFETY: plain Win32 calls with stack buffers sized as declared.
        unsafe {
            let mut lii = LASTINPUTINFO { cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32, dwTime: 0 };
            let idle_ms = if GetLastInputInfo(&mut lii) != 0 { GetTickCount().wrapping_sub(lii.dwTime) as u64 } else { 0 };
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                // no foreground window: secure desktop (lock screen / UAC) or sleeping
                return Some(Sample { exe: String::new(), title: String::new(), idle_ms, locked: true, pid: 0, hwnd: 0 });
            }
            let mut buf = [0u16; 512];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32);
            let title = String::from_utf16_lossy(&buf[..n.max(0) as usize]);
            let mut pid: u32 = 0;
            GetWindowThreadProcessId(hwnd, &mut pid);
            let key = hwnd as usize;
            let exe = self.cache.get_or(key, pid, || {
                let e = exe_of(pid);
                if e.to_lowercase().ends_with("applicationframehost.exe") {
                    let child = uwp_child_pid(hwnd, pid);
                    if child != 0 {
                        let real = exe_of(child);
                        if !real.is_empty() {
                            return real;
                        }
                    }
                }
                e
            });
            // a UWP frame whose app had not attached yet: don't keep the host name forever
            if exe.to_lowercase().ends_with("applicationframehost.exe") {
                self.cache.map.remove(&(key, pid));
            }
            let locked = exe.to_lowercase().ends_with("lockapp.exe");
            Some(Sample { exe, title, idle_ms, locked, pid, hwnd: key })
        }
    }
}
