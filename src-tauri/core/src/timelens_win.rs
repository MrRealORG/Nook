//! Windows sampler for Timelens (Win32). Kept in its own file so the standalone
//! `wincheck` crate can type-check it verbatim against x86_64-pc-windows-msvc.
//!
//! v1.4:
//! * browsers: the tab's real address is read from the address bar with UI Automation — only when
//!   the window title changes, with the address-bar element cached per window (a UIA search of a
//!   browser window costs a few ms; a cached element read is ~0.1 ms);
//! * a `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` thread wakes the tracker the moment the user
//!   switches windows (out-of-context hook, no DLL injection, a blocking `GetMessageW` loop that
//!   costs nothing while idle).

use super::{ExeCache, Sample, Sampler};
use windows_sys::Win32::Foundation::{CloseHandle, BOOL, HWND, LPARAM};
use windows_sys::Win32::System::SystemInformation::GetTickCount;
use windows_sys::Win32::System::Threading::{
    GetCurrentThread, OpenProcess, QueryFullProcessImageNameW, SetThreadInformation, SetThreadPriority, ThreadPowerThrottling, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, THREAD_POWER_THROTTLING_CURRENT_VERSION, THREAD_POWER_THROTTLING_EXECUTION_SPEED, THREAD_POWER_THROTTLING_STATE,
    THREAD_PRIORITY_LOWEST,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};
use windows_sys::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, EnumChildWindows, GetForegroundWindow, GetMessageW, GetWindowTextW, GetWindowThreadProcessId, TranslateMessage, EVENT_SYSTEM_FOREGROUND, MSG, WINEVENT_OUTOFCONTEXT,
    WINEVENT_SKIPOWNPROCESS,
};

#[derive(Default)]
pub struct WinSampler {
    cache: ExeCache,
    url: UrlReader,
}

// ------------------------------------------------------------------ foreground hook

static WAKE_FN: std::sync::OnceLock<fn()> = std::sync::OnceLock::new();

unsafe extern "system" fn on_foreground(_hook: HWINEVENTHOOK, _event: u32, _hwnd: HWND, _id_object: i32, _id_child: i32, _thread: u32, _time: u32) {
    if let Some(f) = WAKE_FN.get() {
        f();
    }
}

/// Start the foreground-change hook on its own thread (once). `wake` unparks the tracker.
pub fn start_foreground_hook(wake: fn()) {
    if WAKE_FN.set(wake).is_err() {
        return;
    }
    let _ = std::thread::Builder::new().name("timelens-hook".into()).spawn(|| {
        // SAFETY: the hook and the message loop live on this thread for the life of the process;
        // the callback only calls a plain fn pointer.
        unsafe {
            let hook = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, std::ptr::null_mut(), Some(on_foreground), 0, 0, WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS);
            if hook.is_null() {
                log::warn!("timelens: SetWinEventHook failed; falling back to the 1 s tick");
                return;
            }
            let mut msg: MSG = std::mem::zeroed();
            while GetMessageW(&mut msg, std::ptr::null_mut(), 0, 0) > 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            UnhookWinEvent(hook);
        }
    });
}

// ------------------------------------------------------------------ browser address bar (UIA)

const BROWSER_EXES: &[&str] = &["chrome", "msedge", "brave", "firefox", "opera", "vivaldi", "arc", "chromium", "launcher"];

fn is_browser_exe(exe: &str) -> bool {
    let f = exe.rsplit(['\\', '/']).next().unwrap_or(exe).to_lowercase();
    let stem = f.strip_suffix(".exe").unwrap_or(&f);
    // Opera GX's exe is "opera.exe" too; "launcher" only counts inside an Opera folder
    BROWSER_EXES.iter().any(|b| *b == stem) && (stem != "launcher" || exe.to_lowercase().contains("opera"))
}

/// Reads a browser window's address bar via UI Automation, cached per (window, title).
#[derive(Default)]
pub struct UrlReader {
    com: bool,
    uia: Option<windows::Win32::UI::Accessibility::IUIAutomation>,
    /// window → its address-bar element
    edits: std::collections::HashMap<usize, windows::Win32::UI::Accessibility::IUIAutomationElement>,
    /// (window, title) → url of the last read
    last: Option<(usize, String, String)>,
    /// UIA failed to start: stop trying (title mapping still works)
    broken: bool,
}

impl UrlReader {
    fn ensure(&mut self) -> Option<&windows::Win32::UI::Accessibility::IUIAutomation> {
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Accessibility::{CUIAutomation, IUIAutomation, IUIAutomation2};
        use windows::core::Interface;
        if self.broken {
            return None;
        }
        if !self.com {
            // SAFETY: COM init on the tracker thread (STA, matching the icon extractor's ComScope)
            let _ = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            self.com = true;
        }
        if self.uia.is_none() {
            // SAFETY: standard CoCreateInstance of the UIA client object.
            match unsafe { CoCreateInstance::<_, IUIAutomation>(&CUIAutomation, None, CLSCTX_INPROC_SERVER) } {
                Ok(u) => {
                    // a hung browser must not stall the tracker: short UIA timeouts
                    if let Ok(u2) = u.cast::<IUIAutomation2>() {
                        // SAFETY: setters on a live interface.
                        unsafe {
                            let _ = u2.SetConnectionTimeout(700);
                            let _ = u2.SetTransactionTimeout(700);
                        }
                    }
                    self.uia = Some(u);
                }
                Err(e) => {
                    log::warn!("timelens: UI Automation unavailable ({e}); websites use tab titles");
                    self.broken = true;
                    return None;
                }
            }
        }
        self.uia.as_ref()
    }

    fn find_edit(&mut self, hwnd: usize) -> Option<windows::Win32::UI::Accessibility::IUIAutomationElement> {
        use windows::Win32::Foundation::HWND as WHWND;
        use windows::Win32::System::Variant::VARIANT;
        use windows::Win32::UI::Accessibility::{TreeScope_Descendants, UIA_ControlTypePropertyId, UIA_EditControlTypeId};
        if let Some(e) = self.edits.get(&hwnd) {
            return Some(e.clone());
        }
        let uia = self.ensure()?.clone();
        // SAFETY: UIA client calls on a live interface; the handle is the foreground window.
        let edit = unsafe {
            let root = uia.ElementFromHandle(WHWND(hwnd as *mut std::ffi::c_void)).ok()?;
            let cond = uia.CreatePropertyCondition(UIA_ControlTypePropertyId, &VARIANT::from(UIA_EditControlTypeId.0)).ok()?;
            root.FindFirst(TreeScope_Descendants, &cond).ok()?
        };
        if self.edits.len() > 32 {
            self.edits.clear();
        }
        self.edits.insert(hwnd, edit.clone());
        Some(edit)
    }

    fn value_of(edit: &windows::Win32::UI::Accessibility::IUIAutomationElement) -> Option<String> {
        use windows::Win32::UI::Accessibility::{IUIAutomationValuePattern, UIA_ValuePatternId};
        // SAFETY: UIA client calls on a live element.
        unsafe {
            let p: IUIAutomationValuePattern = edit.GetCurrentPatternAs(UIA_ValuePatternId).ok()?;
            let v = p.CurrentValue().ok()?;
            Some(v.to_string())
        }
    }

    /// The address-bar text of browser window `hwnd`, read again only when its title changed.
    pub fn read(&mut self, hwnd: usize, exe: &str, title: &str) -> String {
        if hwnd == 0 || !is_browser_exe(exe) {
            return String::new();
        }
        if let Some((h, t, u)) = &self.last {
            if *h == hwnd && t == title {
                return u.clone();
            }
        }
        let mut url = String::new();
        for attempt in 0..2 {
            let Some(edit) = self.find_edit(hwnd) else { break };
            match Self::value_of(&edit) {
                Some(v) => {
                    url = v;
                    break;
                }
                // stale cached element (tab strip rebuilt, window re-created): search once more
                None if attempt == 0 => {
                    self.edits.remove(&hwnd);
                }
                None => {}
            }
        }
        self.last = Some((hwnd, title.to_string(), url.clone()));
        url
    }
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
                return Some(Sample { exe: String::new(), title: String::new(), idle_ms, locked: true, pid: 0, hwnd: 0, url: String::new() });
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
            // only while the user is active: no UIA traffic at all when idle / AFK
            let url = if idle_ms < 60_000 { self.url.read(key, &exe, &title) } else { String::new() };
            Some(Sample { exe, title, idle_ms, locked, pid, hwnd: key, url })
        }
    }
}
