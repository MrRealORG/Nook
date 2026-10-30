//! Windows icon extraction (exe → HICON → 32-bit DIB → PNG). Own file so `wincheck`
//! can type-check it verbatim against x86_64-pc-windows-msvc.

use super::{bgra_to_rgba, encode_png};
use windows_sys::Win32::Graphics::Gdi::{CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetObjectW, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS};
use windows_sys::Win32::UI::Shell::{SHDefExtractIconW, SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
use windows_sys::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, HICON, ICONINFO};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Read a bitmap as top-down 32-bit BGRA.
unsafe fn dib_bits(hdc: windows_sys::Win32::Graphics::Gdi::HDC, hbm: windows_sys::Win32::Graphics::Gdi::HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
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

/// HICON → PNG bytes. Handles 32-bit alpha icons and legacy mask-only transparency.
pub unsafe fn hicon_to_png(icon: HICON) -> Option<Vec<u8>> {
    let mut ii: ICONINFO = std::mem::zeroed();
    if GetIconInfo(icon, &mut ii) == 0 {
        return None;
    }
    let mut out = None;
    if !ii.hbmColor.is_null() {
        let mut bm: BITMAP = std::mem::zeroed();
        if GetObjectW(ii.hbmColor, std::mem::size_of::<BITMAP>() as i32, (&mut bm as *mut BITMAP).cast()) != 0 && bm.bmWidth > 0 && bm.bmHeight > 0 && bm.bmWidth <= 256 {
            let (w, h) = (bm.bmWidth, bm.bmHeight);
            let hdc = CreateCompatibleDC(std::ptr::null_mut());
            if !hdc.is_null() {
                if let Some(bgra) = dib_bits(hdc, ii.hbmColor, w, h) {
                    // AND mask: black (0) = opaque. Only consulted when the colour bitmap has no alpha.
                    let mask = if ii.hbmMask.is_null() { None } else { dib_bits(hdc, ii.hbmMask, w, h).map(|m| m.chunks(4).map(|p| p[0] == 0).collect::<Vec<bool>>()) };
                    let rgba = bgra_to_rgba(&bgra, mask.as_deref());
                    out = Some(encode_png(w as u32, h as u32, &rgba));
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

/// The exe's main icon at `size` px (falls back to the shell's large icon for the file).
pub fn exe_icon_png(exe: &str, size: u32) -> Option<Vec<u8>> {
    let path = wide(exe);
    // SAFETY: Win32 calls with valid, NUL-terminated buffers; every HICON we get is destroyed.
    unsafe {
        let mut large: HICON = std::ptr::null_mut();
        let hr = SHDefExtractIconW(path.as_ptr(), 0, 0, &mut large, std::ptr::null_mut(), size & 0xFFFF);
        if hr == 0 && !large.is_null() {
            let png = hicon_to_png(large);
            DestroyIcon(large);
            if png.is_some() {
                return png;
            }
        }
        let mut sfi: SHFILEINFOW = std::mem::zeroed();
        let r = SHGetFileInfoW(path.as_ptr(), 0, &mut sfi, std::mem::size_of::<SHFILEINFOW>() as u32, SHGFI_ICON | SHGFI_LARGEICON);
        if r != 0 && !sfi.hIcon.is_null() {
            let png = hicon_to_png(sfi.hIcon);
            DestroyIcon(sfi.hIcon);
            return png;
        }
    }
    None
}
