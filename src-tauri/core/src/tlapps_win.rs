//! Windows icon extraction (exe → 32-bit BGRA → PNG). Own file so `wincheck` can type-check it
//! verbatim against x86_64-pc-windows-msvc.
//!
//! v1.3: several methods, best first, each validated (a blank / all-transparent bitmap counts as
//! a failure so the next method gets a turn):
//!
//! 1. `IShellItemImageFactory::GetImage` (ICONONLY, 48 px) — what Explorer itself draws; works for
//!    classic exes, Store/UWP apps and shortcuts, returns a 32-bit premultiplied DIB section.
//! 2. `SHGetFileInfoW(SHGFI_ICON | SHGFI_LARGEICON)`
//! 3. `ExtractIconExW` (first large icon in the file)
//! 4. `PrivateExtractIconsW` at 48×48 (picks the best size from the icon group)
//! 5. `SHDefExtractIconW` (the 1.2 method)
//!
//! Shell APIs require COM on the calling thread — the 1.2 code ran `SHGetFileInfoW` on the
//! Timelens sampler thread with COM never initialised, so the fallback silently failed. Every
//! extraction now runs inside a [`ComScope`].

use super::bgra_icon_png;
use std::ffi::c_void;
use windows_sys::core::{GUID, HRESULT};
use windows_sys::Win32::Foundation::SIZE;
use windows_sys::Win32::Graphics::Gdi::{CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC};
use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows_sys::Win32::UI::Shell::{ExtractIconExW, SHCreateItemFromParsingName, SHDefExtractIconW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, PrivateExtractIconsW, HICON, ICONINFO};

/// IID_IShellItemImageFactory {bcc18b79-ba16-442f-80c4-8a59c30c463b}
const IID_SHELL_ITEM_IMAGE_FACTORY: GUID = GUID::from_u128(0xbcc18b79_ba16_442f_80c4_8a59c30c463b);
const SIIGBF_BIGGERSIZEOK: i32 = 0x1;
const SIIGBF_ICONONLY: i32 = 0x4;

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// COM for the current thread for the duration of one extraction (balanced on drop).
struct ComScope(bool);
impl ComScope {
    fn enter() -> Self {
        // SAFETY: plain COM init; S_OK / S_FALSE must be balanced with CoUninitialize, an
        // RPC_E_CHANGED_MODE (COM already up in another mode) must not be.
        let hr = unsafe { CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32) };
        ComScope(hr >= 0)
    }
}
impl Drop for ComScope {
    fn drop(&mut self) {
        if self.0 {
            // SAFETY: balances the successful CoInitializeEx above on the same thread.
            unsafe { CoUninitialize() };
        }
    }
}

/// Read a bitmap as top-down 32-bit BGRA.
unsafe fn dib_bits(hdc: HDC, hbm: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    let mut bi: BITMAPINFO = std::mem::zeroed();
    bi.bmiHeader = BITMAPINFOHEADER {
        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
        biWidth: w,
        biHeight: -h, // top-down
        biPlanes: 1,
        biBitCount: 32,
        biCompression: BI_RGB,
        biSizeImage: 0,
        biXPelsPerMeter: 0,
        biYPelsPerMeter: 0,
        biClrUsed: 0,
        biClrImportant: 0,
    };
    let mut buf = vec![0u8; (w * h * 4) as usize];
    let n = GetDIBits(hdc, hbm, 0, h as u32, buf.as_mut_ptr().cast(), &mut bi, DIB_RGB_COLORS);
    (n == h).then_some(buf)
}

unsafe fn bitmap_size(hbm: HBITMAP) -> Option<(i32, i32)> {
    let mut bm: BITMAP = std::mem::zeroed();
    let ok = GetObjectW(hbm, std::mem::size_of::<BITMAP>() as i32, (&mut bm as *mut BITMAP).cast()) != 0;
    (ok && bm.bmWidth > 0 && bm.bmHeight > 0 && bm.bmWidth <= 512 && bm.bmHeight <= 512).then_some((bm.bmWidth, bm.bmHeight.abs()))
}

/// HBITMAP (32-bit, e.g. a DIB section from the shell) → PNG.
///
/// # Safety
/// `hbm` must be a valid bitmap handle not selected into any DC. It is not freed here.
pub unsafe fn hbitmap_to_png(hbm: HBITMAP, premultiplied: bool) -> Option<Vec<u8>> {
    let (w, h) = bitmap_size(hbm)?;
    let hdc = CreateCompatibleDC(std::ptr::null_mut());
    if hdc.is_null() {
        return None;
    }
    let out = dib_bits(hdc, hbm, w, h).and_then(|bgra| bgra_icon_png(w as u32, h as u32, &bgra, None, premultiplied));
    DeleteDC(hdc);
    out
}

/// HICON → PNG bytes. Icon bitmaps carry straight alpha; when the colour bitmap has no alpha at
/// all, the AND mask decides transparency. Blank results return None.
///
/// # Safety
/// `icon` must be a valid icon handle owned by the caller for the duration of the call.
/// The function only reads from it; the bitmaps returned by `GetIconInfo` are freed here.
pub unsafe fn hicon_to_png(icon: HICON) -> Option<Vec<u8>> {
    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(icon, &mut ii) == 0 {
        return None;
    }
    let mut out = None;
    if !ii.hbmColor.is_null() {
        if let Some((w, h)) = bitmap_size(ii.hbmColor) {
            let hdc = CreateCompatibleDC(std::ptr::null_mut());
            if !hdc.is_null() {
                if let Some(bgra) = dib_bits(hdc, ii.hbmColor, w, h) {
                    // AND mask: black (0) = opaque. Only consulted when the colour bitmap has no alpha.
                    let mask = if ii.hbmMask.is_null() { None } else { dib_bits(hdc, ii.hbmMask, w, h).map(|m| m.chunks(4).map(|p| p[0] == 0).collect::<Vec<bool>>()) };
                    out = bgra_icon_png(w as u32, h as u32, &bgra, mask.as_deref(), false);
                }
                DeleteDC(hdc);
            }
        }
    }
    if !ii.hbmColor.is_null() {
        DeleteObject(ii.hbmColor);
    }
    if !ii.hbmMask.is_null() {
        DeleteObject(ii.hbmMask);
    }
    out
}

/// Convert and destroy an HICON we own.
unsafe fn take_icon(icon: HICON) -> Option<Vec<u8>> {
    if icon.is_null() {
        return None;
    }
    let png = hicon_to_png(icon);
    DestroyIcon(icon);
    png
}

#[repr(C)]
struct ImageFactoryVtbl {
    query_interface: usize,
    add_ref: usize,
    release: unsafe extern "system" fn(*mut c_void) -> u32,
    get_image: unsafe extern "system" fn(*mut c_void, SIZE, i32, *mut HBITMAP) -> HRESULT,
}

/// Method 1: `IShellItemImageFactory::GetImage` — the shell's own icon for the file.
pub fn shell_image(path: &[u16], size: i32) -> Option<Vec<u8>> {
    // SAFETY: the interface pointer comes from SHCreateItemFromParsingName with the IID of the
    // vtable layout declared above; it is released exactly once; the HBITMAP is ours to delete.
    unsafe {
        let mut obj: *mut c_void = std::ptr::null_mut();
        let hr = SHCreateItemFromParsingName(path.as_ptr(), std::ptr::null_mut(), &IID_SHELL_ITEM_IMAGE_FACTORY, &mut obj);
        if hr < 0 || obj.is_null() {
            return None;
        }
        let vtbl = &**(obj as *mut *const ImageFactoryVtbl);
        let mut hbm: HBITMAP = std::ptr::null_mut();
        let hr = (vtbl.get_image)(obj, SIZE { cx: size, cy: size }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK, &mut hbm);
        (vtbl.release)(obj);
        if hr < 0 || hbm.is_null() {
            return None;
        }
        let png = hbitmap_to_png(hbm, true);
        DeleteObject(hbm);
        png
    }
}

/// Method 2: `SHGetFileInfoW` large icon.
pub fn shell_file_info(path: &[u16]) -> Option<Vec<u8>> {
    // SAFETY: valid NUL-terminated path, struct sized as declared, icon destroyed by take_icon.
    unsafe {
        let mut sfi: SHFILEINFOW = std::mem::zeroed();
        let r = SHGetFileInfoW(path.as_ptr(), 0, &mut sfi, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON);
        if r == 0 {
            return None;
        }
        take_icon(sfi.hIcon)
    }
}

/// Method 3: `ExtractIconExW`, first large icon.
pub fn extract_icon_ex(path: &[u16]) -> Option<Vec<u8>> {
    // SAFETY: asks for exactly one large icon into a single HICON slot.
    unsafe {
        let mut large: HICON = std::ptr::null_mut();
        let n = ExtractIconExW(path.as_ptr(), 0, &mut large, std::ptr::null_mut(), 1);
        if n == 0 || n == u32::MAX {
            return None;
        }
        take_icon(large)
    }
}

/// Method 4: `PrivateExtractIconsW` at `size`×`size` (best match from the icon group).
pub fn private_extract(path: &[u16], size: i32) -> Option<Vec<u8>> {
    // SAFETY: one HICON slot, one id slot, nicons = 1.
    unsafe {
        let mut icon: HICON = std::ptr::null_mut();
        let mut id = 0u32;
        let n = PrivateExtractIconsW(path.as_ptr(), 0, size, size, &mut icon, &mut id, 1, 0);
        if n == 0 || n == u32::MAX {
            return None;
        }
        take_icon(icon)
    }
}

/// Method 5 (1.2's only method): `SHDefExtractIconW`.
pub fn def_extract(path: &[u16], size: u32) -> Option<Vec<u8>> {
    // SAFETY: valid path; the large icon (if any) is destroyed by take_icon.
    unsafe {
        let mut large: HICON = std::ptr::null_mut();
        let hr = SHDefExtractIconW(path.as_ptr(), 0, 0, &mut large, std::ptr::null_mut(), size & 0xFFFF);
        if hr != 0 {
            return None;
        }
        take_icon(large)
    }
}

/// The exe's icon at `size` px, trying every method best-first.
pub fn exe_icon_png(exe: &str, size: u32) -> Option<Vec<u8>> {
    if exe.is_empty() {
        return None;
    }
    let path = wide(exe);
    let _com = ComScope::enter();
    let px = size.clamp(16, 256) as i32;
    shell_image(&path, px)
        .or_else(|| shell_file_info(&path))
        .or_else(|| extract_icon_ex(&path))
        .or_else(|| private_extract(&path, px))
        .or_else(|| def_extract(&path, px as u32))
}
