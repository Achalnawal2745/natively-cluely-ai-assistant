//! Windows screen capture via a GDI cascade.
//!
//! # Why this exists
//!
//! `desktopCapturer` (Electron) is the current capture path. It wraps
//! Chromium's Windows Graphics Capture, which on Windows has three failure
//! modes that show up in real sessions:
//!
//!   1. **Black frames on hardware-accelerated surfaces.** WGC hands back a
//!      black (or partly black) texture when the target surface is composited
//!      on a discrete GPU, during a display mode change, or right after a
//!      fullscreen app takes over. Natively already guards the macOS side of
//!      this bug class with `assertScreenRecordingPermission()`, which exists
//!      precisely because `getSources()` returns black thumbnails *silently*
//!      (issue #133).
//!   2. **Layered / transparent windows are dropped.** A plain `SRCCOPY` blit
//!      from the desktop DC skips `WS_EX_LAYERED` windows. `CAPTUREBLT` is
//!      required to include them.
//!   3. **DPI / thumbnail-ratio drift.** `ScreenshotHelper` carries a
//!      `MAX_THUMBNAIL_RATIO` guard and a shared `computeThumbnailCrop()`
//!      helper because the single-display and multi-display paths diverged on
//!      exactly this math. GDI has no such ambiguity: you ask for a rect in
//!      screen coordinates and you get those pixels.
//!
//! This module is an *alternative and fallback*, not a replacement. It reads
//! the composited desktop the same way the Print Screen key does, and it
//! validates every frame it produces before handing it back.
//!
//! # The cascade
//!
//!   1. `BitBlt` over the whole virtual screen with `SRCCOPY | CAPTUREBLT`
//!   2. if the frame is blank → `PrintWindow(PW_RENDERFULLCONTENT)` on the
//!      foreground window (asks the window to paint itself into our DC, which
//!      survives the GPU compositing that defeats a desktop blit)
//!   3. if still blank → `BitBlt` from the foreground window's own DC
//!
//! Every step's output goes through `frame_is_blank()`; a blank frame is
//! treated exactly like a failure and the next method is tried. That
//! validation loop is the single biggest robustness difference from a
//! single-method capture: the caller gets a usable frame or `None`, never a
//! silently black PNG.
//!
//! # What this deliberately does NOT do
//!
//!   * It never calls `SetWindowDisplayAffinity` on a window it does not own.
//!     Disabling another application's capture protection is not a capture
//!     technique, it is tampering. Natively's own `capture_exclusion.rs`
//!     touches only windows belonging to this process, and that boundary is
//!     respected here too.
//!   * It never enumerates windows by title to locate a specific application
//!     (no "find the browser/assessment window" logic). The only window
//!     lookup is `GetForegroundWindow()` — whatever the user is currently
//!     looking at, which is the only sane default for a capture the user
//!     triggered.
//!   * It does not read another application's accessibility / UIA tree.
//!
//! # Entry points
//!
//! `capture_region_gdi(rect, max_width)` is the one the app uses: it captures
//! a rectangle of the virtual screen, which is what `ScreenshotHelper` wants —
//! it captures one display or one cropper selection, not the whole virtual
//! screen. It runs the BitBlt step only, because a whole-window capture is a
//! different shape from the rect the caller asked for.
//!
//! `capture_screen_gdi` and `capture_foreground_window_gdi` capture the whole
//! virtual screen / the foreground window and run the full three-step cascade.
//! They are for the case where no rect is known.
//!
//! # Output format
//!
//! Raw **BGRA**, top-down, 32bpp — the byte layout `GetDIBits` produces and
//! the layout `nativeImage.toBitmap()` returns on Windows, which makes
//! `nativeImage.createFromBitmap()` its exact inverse. Note that
//! `sharp(buf, { raw: { channels: 4 } })` reads that same buffer as **RGBA**,
//! so it is *not* a drop-in here; see electron/ScreenshotGdi.ts. Encoding to
//! PNG happens in JS so we reuse the image stack already in the app instead of
//! shipping a second encoder.
//!
//! # Threading
//!
//! Main-thread only, like every other napi function in this crate. Each call
//! is synchronous and self-contained: every HDC/HBITMAP is released by a
//! `Drop` guard, including on the error paths, because GDI object leaks are
//! the classic way a long-running capture loop takes down a process.

#![cfg(target_os = "windows")]

use std::time::Instant;

use napi::bindgen_prelude::*;
use windows::Win32::Foundation::{HWND, RECT};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDIBits,
    GetDC, ReleaseDC, SelectObject, SetStretchBltMode, StretchBlt, BITMAPINFO,
    BITMAPINFOHEADER, DIB_RGB_COLORS, HALFTONE, HDC, HBITMAP, HGDIOBJ, ROP_CODE, SRCCOPY,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetSystemMetrics, GetWindowRect, IsIconic, IsWindow,
    SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN,
};

/// `CAPTUREBLT` — include layered/transparent windows in the blit.
/// Declared locally: the `windows` crate does not export this one.
const CAPTUREBLT: u32 = 0x4000_0000;

/// `PW_RENDERFULLCONTENT` — ask the window to render its full content,
/// including hardware-accelerated surfaces, rather than only what the DWM
/// compositor would hand us. The crate exports `PW_CLIENTONLY` (1) but not
/// this value (2).
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(0x0002);

/// Frames at or below this mean luminance count as blank. A real desktop is
/// never this dark; a failed GPU blit is exactly this dark.
const BLANK_LUMA_THRESHOLD: u32 = 8;

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
    /// Which cascade step produced this frame: bitblt | printwindow | windowdc
    pub method: String,
    pub duration_ms: f64,
    /// `true` when the frame validated as blank — callers should fall back.
    pub blank: bool,
}

// ── RAII guards ─────────────────────────────────────────────────────────────

/// Owns an HDC from `CreateCompatibleDC`; deletes it on drop.
struct MemDc(HDC);

impl MemDc {
    fn new(screen: HDC) -> Option<Self> {
        let hdc = unsafe { CreateCompatibleDC(screen) };
        (!hdc.is_invalid()).then_some(MemDc(hdc))
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
        let handle = unsafe { CreateCompatibleBitmap(hdc, w, h) };
        (!handle.is_invalid()).then_some(Bitmap(handle))
    }
}

impl Drop for Bitmap {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.0);
        }
    }
}

/// Owns an HDC from `GetDC`/`GetWindowDC`; releases it on drop.
struct ScreenDc {
    hdc: HDC,
    hwnd: HWND,
}

impl Drop for ScreenDc {
    fn drop(&mut self) {
        unsafe {
            _ = ReleaseDC(self.hwnd, self.hdc);
        }
    }
}

// ── Public API ──────────────────────────────────────────────────────────────

/// Bounding box of every monitor, in screen coordinates.
///
/// `x`/`y` can be negative — a monitor arranged above or left of the primary
/// has negative virtual-screen coordinates, and callers that clamp to `>= 0`
/// silently crop those displays out.
#[napi]
pub fn get_virtual_screen_bounds() -> CaptureRect {
    let (x, y, w, h) = virtual_screen();
    CaptureRect { x, y, width: w, height: h }
}

/// Capture an explicit rectangle of the virtual screen.
///
/// Coordinates are in virtual-screen space, which is NOT "display space": on a
/// multi-monitor layout where a secondary display sits left of or above the
/// primary, `x`/`y` are negative. Electron's `Display.bounds` and
/// `screen.getCursorScreenPoint()` are already in this space, so
/// `preferredDisplay.bounds` can be handed over unchanged.
///
/// The rect is clamped to the virtual screen, so one that overhangs an edge (a
/// display bounds rounded past the edge, or a cropper selection dragged
/// off-screen) yields the intersecting part instead of failing. The returned
/// `width`/`height` are the real captured size — callers that care should
/// compare them against what they asked for.
///
/// Unlike `capture_screen_gdi`, no PrintWindow cascade runs: the caller asked
/// for a region, and a whole-window capture is a different shape, so a blank
/// frame here is reported with `blank: true` rather than substituted.
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

    let mut result = capture_region(x1, y1, w, h, max_width)?;
    result.method = "bitblt".to_string();
    result.duration_ms = elapsed_ms(started);
    Some(result)
}

/// Capture the whole virtual screen, running the cascade internally.
///
/// `max_width`: when non-zero and smaller than the capture width, the frame is
/// downscaled with `StretchBlt` (HALFTONE) so the long edge is at most this
/// many pixels. Downscaling in GDI costs microseconds; doing it in JS would
/// mean dragging a 4K BGRA buffer across the napi boundary first.
///
/// Returns `None` only if every method failed outright. If the cascade ran but
/// produced only blank frames, the last frame is returned with
/// `blank: true` so the caller can fall back rather than losing the
/// diagnostic.
#[napi]
pub fn capture_screen_gdi(max_width: Option<u32>) -> Option<GdiCaptureResult> {
    let started = Instant::now();
    let (x, y, w, h) = virtual_screen();
    if w <= 0 || h <= 0 {
        return None;
    }

    // Step 1 — desktop blit with CAPTUREBLT.
    if let Some(mut result) = capture_region(x, y, w, h, max_width) {
        if !result.blank {
            result.method = "bitblt".to_string();
            result.duration_ms = elapsed_ms(started);
            return Some(result);
        }
    }

    // Step 2 — ask the foreground window to render itself.
    if let Some(mut result) = capture_foreground_window_inner(max_width, false) {
        if !result.blank {
            result.duration_ms = elapsed_ms(started);
            return Some(result);
        }
    }

    // Step 3 — blit from the foreground window's own DC.
    if let Some(mut result) = capture_foreground_window_inner(max_width, true) {
        if !result.blank {
            result.duration_ms = elapsed_ms(started);
            return Some(result);
        }
    }

    // Nothing usable. Return the desktop frame flagged blank so the caller can
    // fall back to desktopCapturer with evidence of what went wrong.
    capture_region(x, y, w, h, max_width).map(|mut result| {
        result.method = "bitblt".to_string();
        result.blank = true;
        result.duration_ms = elapsed_ms(started);
        result
    })
}

/// Capture only the foreground window, bypassing the desktop compositor.
///
/// Used when the caller already knows the desktop blit returns black for this
/// window (a GPU-composited fullscreen app, typically) and wants to skip
/// straight to the reliable method.
#[napi]
pub fn capture_foreground_window_gdi(max_width: Option<u32>) -> Option<GdiCaptureResult> {
    let started = Instant::now();
    let mut result = capture_foreground_window_inner(max_width, false)
        .filter(|r| !r.blank)
        .or_else(|| capture_foreground_window_inner(max_width, true))?;
    result.duration_ms = elapsed_ms(started);
    Some(result)
}

/// Native handle of the window the user is currently interacting with.
///
/// Returned as a `Buffer` holding one pointer-sized integer, matching the
/// convention used elsewhere in this crate so JS can pass it straight back in.
#[napi]
pub fn get_foreground_window_handle() -> Option<Buffer> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0 == 0 {
        return None;
    }
    let raw = hwnd.0 as usize;
    Some(raw.to_ne_bytes().as_ref().into())
}

/// True when a BGRA frame is effectively black.
///
/// Samples on a stride rather than every pixel: a 4K frame is 8 MP and we only
/// need to know whether *anything* is lit. Checking ~64k pixels is
/// indistinguishable in practice and keeps this well under a millisecond.
#[napi]
pub fn is_frame_blank(data: Buffer, width: u32, height: u32) -> bool {
    frame_is_blank(data.as_ref(), width, height)
}

// ── Internals ───────────────────────────────────────────────────────────────

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

fn capture_region(
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    max_width: Option<u32>,
) -> Option<GdiCaptureResult> {
    if w <= 0 || h <= 0 {
        return None;
    }

    let screen = ScreenDc { hdc: unsafe { GetDC(HWND(0)) }, hwnd: HWND(0) };
    if screen.hdc.is_invalid() {
        return None;
    }

    let mem = MemDc::new(screen.hdc)?;
    let bitmap = Bitmap::new(screen.hdc, w, h)?;
    let _old: HGDIOBJ = unsafe { SelectObject(mem.0, bitmap.0) };

    let blitted = unsafe {
        BitBlt(
            mem.0,
            0,
            0,
            w,
            h,
            screen.hdc,
            x,
            y,
            ROP_CODE(SRCCOPY.0 | CAPTUREBLT),
        )
    };
    if blitted.is_err() {
        return None;
    }

    read_back(screen.hdc, mem.0, bitmap.0, w, h, max_width)
}

fn capture_foreground_window_inner(
    max_width: Option<u32>,
    use_window_dc: bool,
) -> Option<GdiCaptureResult> {
    let hwnd = unsafe { GetForegroundWindow() };
    if hwnd.0 == 0 {
        return None;
    }
    // Null handle can mean "another session" or "the shell is still starting".
    if !unsafe { IsWindow(hwnd) }.as_bool() {
        return None;
    }
    // A minimised window renders nothing useful.
    if unsafe { IsIconic(hwnd) }.as_bool() {
        return None;
    }

    let mut rect = RECT::default();
    if unsafe { GetWindowRect(hwnd, &mut rect) }.is_err() {
        return None;
    }
    let w = rect.right - rect.left;
    let h = rect.bottom - rect.top;
    if w < 16 || h < 16 {
        return None;
    }

    let screen = ScreenDc { hdc: unsafe { GetDC(hwnd) }, hwnd };
    if screen.hdc.is_invalid() {
        return None;
    }

    let mem = MemDc::new(screen.hdc)?;
    let bitmap = Bitmap::new(screen.hdc, w, h)?;
    let _old: HGDIOBJ = unsafe { SelectObject(mem.0, bitmap.0) };

    let ok = if use_window_dc {
        unsafe {
            BitBlt(
                mem.0,
                0,
                0,
                w,
                h,
                screen.hdc,
                0,
                0,
                ROP_CODE(SRCCOPY.0 | CAPTUREBLT),
            )
        }
        .is_ok()
    } else {
        unsafe { PrintWindow(hwnd, mem.0, PW_RENDERFULLCONTENT) }.as_bool()
    };

    if !ok {
        return None;
    }

    let mut result = read_back(screen.hdc, mem.0, bitmap.0, w, h, max_width)?;
    result.method = if use_window_dc { "windowdc" } else { "printwindow" }.to_string();
    Some(result)
}

/// Pull pixels out of a bitmap, optionally downscaling first.
///
/// `bitmap` must be the bitmap currently selected into `mem_hdc` — `GetDIBits`
/// reads from the bitmap, not the DC, so passing the wrong handle silently
/// yields an all-zero buffer (which then correctly reports as blank, but for
/// the wrong reason).
fn read_back(
    screen_hdc: HDC,
    mem_hdc: HDC,
    bitmap: HBITMAP,
    w: i32,
    h: i32,
    max_width: Option<u32>,
) -> Option<GdiCaptureResult> {
    if downscale_target(w, h, max_width) == (w, h) {
        let pixels = read_dibits(mem_hdc, bitmap, w, h)?;
        let blank = frame_is_blank(&pixels, w as u32, h as u32);
        return Some(GdiCaptureResult {
            data: pixels.into(),
            width: w as u32,
            height: h as u32,
            method: "bitblt".to_string(),
            duration_ms: 0.0,
            blank,
        });
    }

    // Downscale in GDI. `small_dc` / `small_bmp` must outlive the GetDIBits
    // call below, so they stay in scope until after it returns; the Drop
    // guards then release them in reverse declaration order.
    let (dw, dh) = downscale_target(w, h, max_width);
    let small_dc = MemDc::new(screen_hdc)?;
    let small_bmp = Bitmap::new(screen_hdc, dw, dh)?;
    let _old: HGDIOBJ = unsafe { SelectObject(small_dc.0, small_bmp.0) };
    unsafe {
        SetStretchBltMode(small_dc.0, HALFTONE);
    }
    let stretched = unsafe {
        StretchBlt(
            small_dc.0,
            0,
            0,
            dw,
            dh,
            mem_hdc,
            0,
            0,
            w,
            h,
            ROP_CODE(SRCCOPY.0),
        )
    };
    if !stretched.as_bool() {
        return None;
    }

    let pixels = read_dibits(small_dc.0, small_bmp.0, dw, dh)?;
    let blank = frame_is_blank(&pixels, dw as u32, dh as u32);
    Some(GdiCaptureResult {
        data: pixels.into(),
        width: dw as u32,
        height: dh as u32,
        method: "bitblt".to_string(),
        duration_ms: 0.0,
        blank,
    })
}

fn downscale_target(w: i32, h: i32, max_width: Option<u32>) -> (i32, i32) {
    match max_width {
        Some(limit) if limit > 0 && w > limit as i32 => {
            let scale = limit as f64 / w as f64;
            let dh = (h as f64 * scale).round() as i32;
            (limit as i32, dh.max(1))
        }
        _ => (w, h),
    }
}

/// `GetDIBits` into a fresh `Vec<u8>`, top-down, 32bpp.
fn read_dibits(hdc: HDC, bitmap: HBITMAP, w: i32, h: i32) -> Option<Vec<u8>> {
    if w <= 0 || h <= 0 {
        return None;
    }
    let stride = (w as usize) * 4;
    let mut pixels = vec![0u8; stride * (h as usize)];

    let mut info = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            // Negative height = top-down DIB. Omitting the sign yields a
            // bottom-up image and the capture comes out vertically flipped —
            // which is exactly the kind of bug that survives a glance at a
            // screenshot of a mostly-uniform desktop.
            biHeight: -h,
            biPlanes: 1,
            biBitCount: 32,
            biCompression: 0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: [Default::default()],
    };

    let lines = unsafe {
        GetDIBits(
            hdc,
            bitmap,
            0,
            h as u32,
            Some(pixels.as_mut_ptr() as *mut std::ffi::c_void),
            &mut info,
            DIB_RGB_COLORS,
        )
    };
    if lines != h {
        return None;
    }
    Some(pixels)
}

/// Mean-luminance blank check on a stride-sampled subset.
fn frame_is_blank(data: &[u8], width: u32, height: u32) -> bool {
    if data.is_empty() || width == 0 || height == 0 {
        return true;
    }
    let expected = (width as usize) * (height as usize) * 4;
    if data.len() < expected {
        return true;
    }

    let pixels = (width as u64) * (height as u64);
    // Sample at most ~65k pixels, evenly strided.
    let step = ((pixels / 65_536).max(1)) as usize;
    let total_pixels = (width as usize) * (height as usize);
    let mut total: u64 = 0;
    let mut count: u64 = 0;
    let mut index = 0usize;

    while index < total_pixels {
        let base = index * 4;
        // BGRA layout. Any channel being lit is enough, so the max of B/G/R
        // is the cheapest "is something there" test.
        let b = data[base] as u32;
        let g = data[base + 1] as u32;
        let r = data[base + 2] as u32;
        total += b.max(g).max(r) as u64;
        count += 1;
        index += step;
    }

    if count == 0 {
        return true;
    }
    (total / count) as u32 <= BLANK_LUMA_THRESHOLD
}
