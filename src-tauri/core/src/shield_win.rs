//! Windows side of the Shield: minimise / close / kill a window's app, or close the browser tab
//! (Ctrl+W) — always re-checking that the target is STILL the foreground window right before
//! acting, so a keystroke never lands in the wrong app. Own file so `wincheck` can type-check it
//! verbatim against x86_64-pc-windows-msvc.

use super::{AppAction, Enforcer, SiteAction};
use windows_sys::Win32::Foundation::{CloseHandle, HWND};
use windows_sys::Win32::System::Threading::{GetCurrentProcessId, OpenProcess, TerminateProcess, PROCESS_TERMINATE};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL, VK_W};
use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId, IsWindow, PostMessageW, ShowWindow, SW_MINIMIZE, WM_CLOSE};

pub struct WinEnforcer;

fn hwnd_of(h: usize) -> HWND {
    h as HWND
}

fn still_foreground(h: usize) -> bool {
    // SAFETY: plain queries on a window handle value.
    unsafe { h != 0 && GetForegroundWindow() as usize == h && IsWindow(hwnd_of(h)) != 0 }
}

fn key(vk: u16, up: bool) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: if up { KEYEVENTF_KEYUP } else { 0 }, time: 0, dwExtraInfo: 0 } },
    }
}

fn minimize(hwnd: usize) -> bool {
    // SAFETY: ShowWindow on a validated handle; the return value is the previous visibility.
    unsafe { ShowWindow(hwnd_of(hwnd), SW_MINIMIZE) };
    true
}

impl Enforcer for WinEnforcer {
    fn bounce_app(&mut self, hwnd: usize, pid: u32, action: AppAction) -> bool {
        if !still_foreground(hwnd) {
            return false;
        }
        // SAFETY: the window handle was just validated; the process handle is checked and closed.
        unsafe {
            let mut owner = 0u32;
            GetWindowThreadProcessId(hwnd_of(hwnd), &mut owner);
            let me = GetCurrentProcessId();
            if owner == me {
                return false; // never Nook itself
            }
            match action {
                AppAction::Minimize => minimize(hwnd),
                AppAction::Close => PostMessageW(hwnd_of(hwnd), WM_CLOSE, 0, 0) != 0,
                AppAction::Kill => {
                    let target = if pid != 0 { pid } else { owner };
                    if target == 0 || target == me {
                        return false;
                    }
                    let h = OpenProcess(PROCESS_TERMINATE, 0, target);
                    if h.is_null() {
                        // elevated / protected process: fall back to minimising
                        return minimize(hwnd);
                    }
                    let ok = TerminateProcess(h, 1) != 0;
                    CloseHandle(h);
                    ok
                }
            }
        }
    }

    fn bounce_tab(&mut self, hwnd: usize, action: SiteAction) -> bool {
        if !still_foreground(hwnd) {
            return false;
        }
        match action {
            SiteAction::Minimize => minimize(hwnd),
            SiteAction::CloseTab => {
                let inputs = [key(VK_CONTROL, false), key(VK_W, false), key(VK_W, true), key(VK_CONTROL, true)];
                // SAFETY: a stack array of fully-initialised INPUT structs; size passed as declared.
                let sent = unsafe { SendInput(inputs.len() as u32, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32) };
                sent as usize == inputs.len()
            }
        }
    }
}
