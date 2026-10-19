//! Windows screen capture via GDI, with a window-tree cascade.
//!
//! # Why this exists
//!
//! `ScreenshotHelper` captures through Electron's `desktopCapturer`, which wraps
//! Chromium's Windows Graphics Capture. That is the right default — it is the
//! only path that respects the macOS Screen Recording gate — but on Windows it
//! has a failure mode with no error to catch: an application can set
//! `WDA_EXCLUDEFROMCAPTURE`, and `getSources()` then returns a thumbnail with
//! that window blanked out, silently. Nothing throws. The model is handed a
//! picture of the desktop and the answer is garbage, with no log line to
//! explain it. `ScreenshotHelper.getDisplaysIntersectingSelection` already
//! documents this as issue #133.
//!
//! This module is the fallback for that case.
//!
//! # The cascade, and the part that actually matters
//!
//! A GDI blit of the whole screen does NOT solve it — a window with
//! `WDA_EXCLUDEFROMCAPTURE` is blank in that too. What does solve it, on
//! Chromium-family apps, is the window TREE:
//!
//! ```text
//!   Chrome_WidgetWin_1                    <- top level, protected, black
//!     ├── Chrome_RenderWidgetHostHWND     <- black
//!     ├── Chrome_RenderWidgetHostHWND     <- black, SAME SIZE as the winner
//!     └── Intermediate D3D Window         <- holds the actual pixels
//! ```
//!
//! The protection is not applied uniformly across the tree, and one child still
//! holds the composited content.
//!
//! The catch — and this is the entire lesson from getting it wrong twice — is
//! that **size cannot tell you which child**. On the app this was debugged
//! against, two children were both 1920x1080; one was solid black and one was
//! the real frame. An implementation that picks `max(by area)` gets the black
//! one and gives up. So this walks EVERY child, tries two capture methods on
//! each, and returns the first frame that is not blank.
//!
//! Validation is the other half. Every frame goes through `frame_luma()`; a
//! near-black or single-flat-colour frame is treated as a failure and the next
//! attempt runs. A capture that returns "success" with black pixels is worse
//! than one that reports failure, because the caller cannot tell them apart.
//!
//! # What this deliberately does NOT do
//!
//!   * It never calls `SetWindowDisplayAffinity`. Disabling another
//!     application's capture protection is not a capture technique — and it
//!     does not work cross-process anyway, since Windows only permits the
//!     owning process to change it.
//!   * It never enumerates windows by title or class name to locate a specific
//!     application. The caller chooses the window; this only walks its
//!     children.
//!   * It does not inject into, or read the memory of, any other process.
//!   * It does not read another application's UI Automation tree.
//!
//! The boundary is the same one `capture_exclusion.rs` draws: this crate
//! touches only what the OS will serve through a documented capture call.
//!
//! # Output format
//!
//! Raw **BGRA**, top-down, 32bpp — the layout `GetDIBits` produces and the
//! layout `nativeImage.toBitmap()` returns on Windows, which makes
//! `nativeImage.createFromBitmap()` its exact inverse. Note `sharp(buf, { raw:
//! { channels: 4 } })` reads that as RGBA, so it is not a drop-in.
//!
//! # Threading
//!
//! Main-thread only, like every other napi function here. Every HDC/HBITMAP is
//! released by a `Drop` guard, including on error paths.

#![cfg(target_os = "windows")]

use std::time::Instant;

use napi::bindgen_prelude::*;
use windows::Win32::Foundation::{BOOL, FALSE, HWND, LPARAM, RECT, TRUE};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits, GetDC,
    GetWindowDC, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO, BITMAPINFOHEADER,
    DIB_RGB_COLORS, HALFTONE, HDC, HBITMAP, HGDIOBJ, ROP_CODE, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumChildWindows, GetClassNameW, GetForegroundWindow, GetSystemMetrics, GetWindowDisplayAffinity,
    GetWindowRect, IsIconic, IsWindow, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN,
};

/// Include layered/transparent windows in the blit. Without it, `WS_EX_LAYERED`
/// windows silently vanish from the capture.
const CAPTUREBLT: u32 = 0x4000_0000;

/// Ask the window to render its full content, including hardware-accelerated
/// surfaces. Exported as `PW_CLIENTONLY`; the crate does not export this one.
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(0x0002);

/// At or below this peak luma, a frame is considered black.
const BLANK_LUMA_MAX: u32 = 15;
/// Below this spread between min and max luma, a frame is one flat colour.
const BLANK_LUMA_SPREAD: u32 = 6;

/// Minimum size for a child window to be worth trying.
const MIN_CHILD_EDGE: i32 = 50;

#[napi(object)]
pub struct CaptureRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// One captured frame.
#[napi(object)]
pub struct GdiCaptureResult {
    /// Raw BGRA pixels, top-down, 4 bytes per pixel, tightly packed.
    pub data: Buffer,
    pub width: u32,
    pub height: u32,
    /// Which attempt produced it, e.g. `child:Intermediate D3D Window/PrintWindow`.
    pub method: String,
    pub duration_ms: f64,
    /// `true` when the frame validated as blank. Callers must treat this as a
    /// failure and fall back — never send it on.
    pub blank: bool,
}

// ── RAII guards ─────────────────────────────────────────────────────────────

/// Owns an HDC from `CreateCompatibleDC`; deletes it on drop.
struct MemDc(HDC);
impl MemDc {
    fn new(screen: HDC) -> Option<Self> {
        let hdc = unsafe { CreateCompatibleDC(screen) };
        if hdc.is_invalid() {
            None
        } else {
            Some(MemDc(hdc))
        }
    }
}
impl Drop for MemDc {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteDC(self.0);
        }
    }
}

/// Owns an HBITMAP; deletes it on drop.
struct Bitmap(HBITMAP);
impl Bitmap {
    fn new(hdc: HDC, w: i32, h: i32) -> Option<Self> {
        let bmp = unsafe { CreateCompatibleBitmap(hdc, w, h) };
        if bmp.is_invalid() {
            None
        } else {
            Some(Bitmap(bmp))
        }
    }
}
impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0);
        }
    }
}

/// Unselects an object from an HDC when dropped. In Win32 GDI, calling
/// DeleteObject on a bitmap while it is selected into a DC fails silently
/// and leaks the GDI handle in the Windows kernel table.
struct SelectGuard {
    hdc: HDC,
    old: HGDIOBJ,
}
impl Drop for SelectGuard {
    fn drop(&mut self) {
        unsafe {
            let _ = SelectObject(self.hdc, self.old);
        }
    }
}

/// Owns a DC obtained with `GetDC(hwnd)`; releases it on drop.
struct DcGuard {
    hdc: HDC,
    hwnd: HWND,
}
impl DcGuard {
    /// The screen DC (the whole virtual screen) when `hwnd` is null.
    fn screen() -> Option<Self> {
        let hdc = unsafe { GetDC(HWND(0)) };
        if hdc.is_invalid() {
            None
        } else {
            Some(DcGuard { hdc, hwnd: HWND(0) })
        }
    }
    /// A window's DC via `GetDC` (client area) or `GetWindowDC` (whole window).
    fn window(hwnd: HWND, whole_window: bool) -> Option<Self> {
        let hdc = if whole_window {
            unsafe { GetWindowDC(hwnd) }
        } else {
            unsafe { GetDC(hwnd) }
        };
        if hdc.is_invalid() {
            None
        } else {
            Some(DcGuard { hdc, hwnd })
        }
    }
}
impl Drop for DcGuard {
    fn drop(&mut self) {
        unsafe {
            _ = ReleaseDC(self.hwnd, self.hdc);
        }
    }
}

// ── Pixel validation ────────────────────────────────────────────────────────

/// Returns (min, max, mean) luma for a top-down BGRA buffer.
///
/// Stride-sampled: we only need to know whether a frame is blank, not produce a
/// histogram, and a full pass over a 4K frame on every attempt would be slow.
fn frame_luma(data: &[u8], width: u32, height: u32) -> (u32, u32, f64) {
    if data.is_empty() || width == 0 || height == 0 {
        return (0, 0, 0.0);
    }
    let w = width as usize;
    let h = height as usize;
    let row_step = (h / 400).max(1);
    let col_step = (w / 400).max(1);

    let mut lo = 255u32;
    let mut hi = 0u32;
    let mut total = 0u64;
    let mut count = 0u64;

    for y in (0..h).step_by(row_step) {
        let base = y * w * 4;
        for x in (0..w).step_by(col_step) {
            let i = base + x * 4;
            if i + 2 >= data.len() {
                break;
            }
            let b = data[i] as u32;
            let g = data[i + 1] as u32;
            let r = data[i + 2] as u32;
            // Rec. 601 luma.
            let luma = (r * 299 + g * 587 + b * 114) / 1000;
            lo = lo.min(luma);
            hi = hi.max(luma);
            total += luma as u64;
            count += 1;
        }
    }
    if count == 0 {
        return (0, 0, 0.0);
    }
    (lo, hi, total as f64 / count as f64)
}

/// A frame is blank if it is near-black OR one flat colour.
///
/// The flat-colour case matters: some failures produce a solid plate rather
/// than pure black, and a max-only test passes those.
fn is_blank(lo: u32, hi: u32) -> bool {
    hi <= BLANK_LUMA_MAX || hi.saturating_sub(lo) < BLANK_LUMA_SPREAD
}

// ── Pixel readback ──────────────────────────────────────────────────────────

/// Read the bitmap back as top-down BGRA, optionally downscaling first.
fn read_back(
    src_hdc: HDC,
    mem: &MemDc,
    bitmap: &Bitmap,
    w: i32,
    h: i32,
    max_width: Option<u32>,
) -> Option<Vec<u8>> {
    let (out_w, out_h) = downscale_target(w, h, max_width);

    if (out_w, out_h) != (w, h) {
        let dst = MemDc::new(src_hdc)?;
        let scaled = Bitmap::new(src_hdc, out_w, out_h)?;
        let _guard = SelectGuard {
            hdc: dst.0,
            old: unsafe { SelectObject(dst.0, scaled.0) },
        };
        unsafe {
            SetStretchBltMode(dst.0, HALFTONE);
            let stretched = StretchBlt(
                dst.0, 0, 0, out_w, out_h,
                mem.0, 0, 0, w, h,
                ROP_CODE(SRCCOPY.0 | CAPTUREBLT),
            );
            if !stretched.as_bool() {
                return None;
            }
        }
        read_dibits(dst.0, &scaled, out_w, out_h)
    } else {
        read_dibits(mem.0, bitmap, w, h)
    }
}

fn downscale_target(w: i32, h: i32, max_width: Option<u32>) -> (i32, i32) {
    match max_width {
        Some(cap) if cap > 0 && w > cap as i32 => {
            let scale = cap as f64 / w as f64;
            let out_w = (w as f64 * scale) as i32;
            let out_h = (h as f64 * scale) as i32;
            (out_w.max(1), out_h.max(1))
        }
        _ => (w, h),
    }
}

fn read_dibits(hdc: HDC, bitmap: &Bitmap, w: i32, h: i32) -> Option<Vec<u8>> {
    if w <= 0 || h <= 0 {
        return None;
    }
    let mut pixels = vec![0u8; (w as usize) * (h as usize) * 4];

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // Negative height = top-down, so no vertical flip is needed.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            ..Default::default()
        },
        ..Default::default()
    };

    let got = unsafe {
        GetDIBits(
            hdc,
            bitmap.0,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut std::ffi::c_void),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };
    if got != h {
        return None;
    }
    Some(pixels)
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn virtual_screen() -> (i32, i32, i32, i32) {
    unsafe {
        (
            GetSystemMetrics(SM_XVIRTUALSCREEN),
            GetSystemMetrics(SM_YVIRTUALSCREEN),
            GetSystemMetrics(SM_CXVIRTUALSCREEN),
            GetSystemMetrics(SM_CYVIRTUALSCREEN),
        )
    }
}

/// Build a result, validating the frame before handing it back.
fn finish(
    pixels: Vec<u8>,
    w: i32,
    h: i32,
    method: &str,
    started: Instant,
) -> Option<GdiCaptureResult> {
    let (lo, hi, _mean) = frame_luma(&pixels, w as u32, h as u32);
    let blank = is_blank(lo, hi);
    Some(GdiCaptureResult {
        data: pixels.into(),
        width: w as u32,
        height: h as u32,
        method: method.to_string(),
        duration_ms: elapsed_ms(started),
        blank,
    })
}

// ── Screen capture ──────────────────────────────────────────────────────────

#[napi]
pub fn get_virtual_screen_bounds() -> CaptureRect {
    let (x, y, w, h) = virtual_screen();
    CaptureRect { x, y, width: w, height: h }
}

/// Capture a rectangle of the virtual screen with `SRCCOPY | CAPTUREBLT`.
///
/// Coordinates are virtual-screen space, which is negative on multi-monitor
/// layouts where a display sits left of or above the primary. Electron's
/// `Display.bounds` is already in this space. The rect is clamped, so an
/// overhanging rect yields the intersection rather than failing.
#[napi]
pub fn capture_region_gdi(rect: CaptureRect, max_width: Option<u32>) -> Option<GdiCaptureResult> {
    let started = Instant::now();
    let (vx, vy, vw, vh) = virtual_screen();
    if vw <= 0 || vh <= 0 {
        return None;
    }

    let x1 = rect.x.max(vx);
    let y1 = rect.y.max(vy);
    let x2 = rect.x.saturating_add(rect.width).min(vx.saturating_add(vw));
    let y2 = rect.y.saturating_add(rect.height).min(vy.saturating_add(vh));
    let w = x2 - x1;
    let h = y2 - y1;
    if w <= 0 || h <= 0 {
        return None;
    }

    let screen = DcGuard::screen()?;
    let mem = MemDc::new(screen.hdc)?;
    let bitmap = Bitmap::new(screen.hdc, w, h)?;
    let _guard = SelectGuard {
        hdc: mem.0,
        old: unsafe { SelectObject(mem.0, bitmap.0) },
    };

    let blitted = unsafe {
        BitBlt(
            mem.0, 0, 0, w, h,
            screen.hdc, x1, y1,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT),
        )
    };
    if blitted.is_err() {
        return None;
    }

    let pixels = read_back(screen.hdc, &mem, &bitmap, w, h, max_width)?;
    let (pw, ph) = downscale_target(w, h, max_width);
    finish(pixels, pw, ph, "screen/bitblt", started)
}

// ── Window tree capture ─────────────────────────────────────────────────────

/// One way of pulling pixels out of a child window.
type ChildCaptureFn = fn(&ChildInfo, Option<u32>) -> Option<Vec<u8>>;

struct ChildInfo {
    hwnd: HWND,
    class: String,
    width: i32,
    height: i32,
}

unsafe extern "system" fn enum_child_proc(hwnd: HWND, lparam: LPARAM) -> windows::Win32::Foundation::BOOL {
    let list = &mut *(lparam.0 as *mut Vec<ChildInfo>);

    let mut name = [0u16; 256];
    let len = GetClassNameW(hwnd, &mut name);
    let class = String::from_utf16_lossy(&name[..len.max(0) as usize]);

    let mut rect = RECT::default();
    if GetWindowRect(hwnd, &mut rect).is_ok() {
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w > MIN_CHILD_EDGE && h > MIN_CHILD_EDGE {
            list.push(ChildInfo { hwnd, class, width: w, height: h });
        }
    }
    TRUE
}

/// Turn a Node `Buffer` (from `BrowserWindow.getNativeWindowHandle()`) into an HWND.
fn buffer_to_hwnd(buf: &Buffer) -> HWND {
    if buf.len() >= 8 {
        let mut b = [0u8; 8];
        b.copy_from_slice(&buf[..8]);
        HWND(i64::from_le_bytes(b) as isize)
    } else if buf.len() >= 4 {
        let mut b = [0u8; 4];
        b.copy_from_slice(&buf[..4]);
        HWND(i32::from_le_bytes(b) as isize)
    } else {
        HWND(0)
    }
}

/// `PrintWindow(PW_RENDERFULLCONTENT)` against a child, using its window DC.
fn child_printwindow(child: &ChildInfo, max_width: Option<u32>) -> Option<Vec<u8>> {
    let dc = DcGuard::window(child.hwnd, true)?;
    let mem = MemDc::new(dc.hdc)?;
    let bitmap = Bitmap::new(dc.hdc, child.width, child.height)?;
    let _guard = SelectGuard {
        hdc: mem.0,
        old: unsafe { SelectObject(mem.0, bitmap.0) },
    };

    let ok = unsafe { PrintWindow(child.hwnd, mem.0, PW_RENDERFULLCONTENT) };
    if !ok.as_bool() {
        // Some apps return FALSE here; the buffer may still hold something, so
        // read it back and let the luma check decide rather than bailing out.
    }

    read_back(dc.hdc, &mem, &bitmap, child.width, child.height, max_width)
}

/// `GetWindowDC(child)` + `BitBlt` — the entire window DC (ShadowMind's method2).
fn child_window_dc(child: &ChildInfo, max_width: Option<u32>) -> Option<Vec<u8>> {
    let dc = DcGuard::window(child.hwnd, true)?;
    let mem = MemDc::new(dc.hdc)?;
    let bitmap = Bitmap::new(dc.hdc, child.width, child.height)?;
    let _guard = SelectGuard {
        hdc: mem.0,
        old: unsafe { SelectObject(mem.0, bitmap.0) },
    };

    let ok = unsafe {
        BitBlt(
            mem.0, 0, 0, child.width, child.height,
            dc.hdc, 0, 0,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT),
        )
    };
    if ok.is_err() {
        return None;
    }

    read_back(dc.hdc, &mem, &bitmap, child.width, child.height, max_width)
}

/// `GetDC(child)` + `BitBlt` — the client DC, a different source than
/// `GetWindowDC` and a different one again from the screen DC.
fn child_client_dc(child: &ChildInfo, max_width: Option<u32>) -> Option<Vec<u8>> {
    let dc = DcGuard::window(child.hwnd, false)?;
    let mem = MemDc::new(dc.hdc)?;
    let bitmap = Bitmap::new(dc.hdc, child.width, child.height)?;
    let _guard = SelectGuard {
        hdc: mem.0,
        old: unsafe { SelectObject(mem.0, bitmap.0) },
    };

    let ok = unsafe {
        BitBlt(
            mem.0, 0, 0, child.width, child.height,
            dc.hdc, 0, 0,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT),
        )
    };
    if ok.is_err() {
        return None;
    }

    read_back(dc.hdc, &mem, &bitmap, child.width, child.height, max_width)
}

/// Capture a window by testing both the parent window itself AND all of its
/// child windows (like ShadowMind's multi-method approach).
///
/// For every candidate, tries:
///   1. `PrintWindow(PW_RENDERFULLCONTENT)`
///   2. `GetWindowDC + BitBlt(CAPTUREBLT)`
///   3. `GetDC + BitBlt(CAPTUREBLT)`
///
/// Returns the first frame that is not blank/flat.
#[napi]
pub fn capture_window_tree_gdi(
    hwnd: Buffer,
    max_width: Option<u32>,
) -> Option<GdiCaptureResult> {
    let started = Instant::now();
    let parent = buffer_to_hwnd(&hwnd);
    if parent.0 == 0 {
        return None;
    }

    let mut targets: Vec<ChildInfo> = Vec::new();

    // 1. Always include the parent window itself first (so non-Chromium apps and
    //    top-level windows are captured directly without needing children).
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(parent, &mut rect) }.is_ok() {
        let w = rect.right - rect.left;
        let h = rect.bottom - rect.top;
        if w > 0 && h > 0 {
            let mut name = [0u16; 256];
            let len = unsafe { GetClassNameW(parent, &mut name) };
            let class = String::from_utf16_lossy(&name[..len.max(0) as usize]);
            targets.push(ChildInfo { hwnd: parent, class, width: w, height: h });
        }
    }

    // 2. Enumerate all child windows (for Chromium/Electron apps where the child
    //    window like `Intermediate D3D Window` holds the unmasked pixels).
    let mut children: Vec<ChildInfo> = Vec::new();
    unsafe {
        let _ = EnumChildWindows(
            parent,
            Some(enum_child_proc),
            LPARAM(&mut children as *mut Vec<ChildInfo> as isize),
        );
    }
    children.sort_by_key(|c| -((c.width as i64) * (c.height as i64)));
    targets.extend(children);

    if targets.is_empty() {
        return None;
    }

    for target in &targets {
        let attempts: [(&str, ChildCaptureFn); 3] = [
            ("PrintWindow", child_printwindow),
            ("WindowDC+BitBlt", child_window_dc),
            ("ClientDC+BitBlt", child_client_dc),
        ];

        for (label, capture) in attempts {
            if let Some(pixels) = capture(target, max_width) {
                let (ow, oh) = downscale_target(target.width, target.height, max_width);
                let (lo, hi, _mean) = frame_luma(&pixels, ow as u32, oh as u32);
                if !is_blank(lo, hi) {
                    return finish(
                        pixels,
                        ow,
                        oh,
                        &format!("target:{}/{}", target.class, label),
                        started,
                    );
                }
            }
        }
    }

    None
}

/// Convenience: walk the window and child tree of whatever window has focus.
#[napi]
pub fn capture_foreground_tree_gdi(max_width: Option<u32>) -> Option<GdiCaptureResult> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0 == 0 {
        return None;
    }
    let buf: Buffer = {
        let bytes = (hwnd.0 as i64).to_le_bytes();
        bytes.to_vec().into()
    };
    capture_window_tree_gdi(buf, max_width)
}

unsafe extern "system" fn check_child_affinity_proc(
    hwnd: HWND,
    lparam: LPARAM,
) -> BOOL {
    let mut affinity = 0u32;
    if GetWindowDisplayAffinity(hwnd, &mut affinity).is_ok() && affinity != 0 {
        let found = &mut *(lparam.0 as *mut bool);
        *found = true;
        return FALSE;
    }
    TRUE
}

/// Checks whether the foreground window (or any of its children) has set
/// `WDA_EXCLUDEFROMCAPTURE` or `WDA_MONITOR`.
#[napi]
pub fn is_window_capture_protected(hwnd: Option<Buffer>) -> bool {
    let target = match hwnd {
        Some(buf) => buffer_to_hwnd(&buf),
        None => unsafe { GetForegroundWindow() },
    };
    if target.0 == 0 {
        return false;
    }

    let mut affinity = 0u32;
    if unsafe { GetWindowDisplayAffinity(target, &mut affinity) }.is_ok() && affinity != 0 {
        return true;
    }

    let mut child_protected = false;
    unsafe {
        let _ = EnumChildWindows(
            target,
            Some(check_child_affinity_proc),
            LPARAM(&mut child_protected as *mut bool as isize),
        );
    }
    child_protected
}

/// The foreground window's rectangle, in physical screen pixels.
///
/// Exists so the caller can measure that region inside a `desktopCapturer`
/// frame and tell whether the window actually made it into the capture.
/// Checking the whole image instead is useless here: when a window is excluded
/// the desktop shows through it, so the frame is full of pixels and looks
/// healthy while the thing you wanted is missing.
#[napi]
pub fn get_foreground_window_rect() -> Option<CaptureRect> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0 == 0 {
        return None;
    }
    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return None;
    }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w <= 0 || h <= 0 {
        return None;
    }
    Some(CaptureRect { x: rect.left, y: rect.top, width: w, height: h })
}

/// Is this window usable as a capture target at all?
#[napi]
pub fn is_capturable_window(hwnd: Buffer) -> bool {
    let h = buffer_to_hwnd(&hwnd);
    if h.0 == 0 {
        return false;
    }
    unsafe {
        if !IsWindow(h).as_bool() {
            return false;
        }
        // A minimised window has nothing to capture.
        if IsIconic(h).as_bool() {
            return false;
        }
    }
    true
}
