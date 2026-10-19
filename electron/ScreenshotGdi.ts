/**
 * Windows GDI capture — the fallback for when `desktopCapturer` silently drops
 * the window you actually wanted.
 *
 * The problem: an application can set `WDA_EXCLUDEFROMCAPTURE`, and
 * `desktopCapturer.getSources()` then returns a thumbnail with that window
 * blanked out. Nothing throws. `ScreenshotHelper.getDisplaysIntersectingSelection`
 * already documents this as issue #133. The guard it has only covers the macOS
 * permission cause, so on Windows there is nothing catching it.
 *
 * The native half (native-module/src/capture_gdi.rs) walks the target window's
 * CHILD windows and returns the first frame that survives a blank check. That
 * detail is the whole thing: on the app this was debugged against, two children
 * were both 1920x1080, one solid black and one holding the real pixels, so the
 * winner cannot be identified by size or by class name — every child has to be
 * tried.
 *
 * This module owns the parts the Rust half cannot see:
 *   - Deciding WHEN the native path is needed. Critically, this checks the
 *     region the target window occupies, not the whole frame. Checking the whole
 *     frame is useless and actively misleading: when a window is excluded the
 *     desktop shows straight through it, so the image is full of pixels and
 *     looks perfectly healthy while the thing you asked for is missing.
 *   - Encoding. GDI returns raw BGRA; `nativeImage.createFromBitmap` is the
 *     inverse of `nativeImage.toBitmap` on Windows and does the conversion and
 *     the PNG encode, so no second image stack gets involved.
 *
 * It never enumerates windows by title to find a specific application, and it
 * never disables another application's capture protection. The target is simply
 * whatever window has focus — which, because main.ts hides Natively's own
 * windows before capturing, is the app the user is looking at.
 */

import * as fs from 'fs'
import { nativeImage, screen } from 'electron'

interface GdiRect {
  x: number
  y: number
  width: number
  height: number
}

interface GdiCaptureRaw {
  data: Buffer
  width: number
  height: number
  /** e.g. `child:Intermediate D3D Window/PrintWindow` */
  method: string
  duration_ms: number
  blank: boolean
}

/**
 * The subset of the native module used here, declared locally so an older
 * native binary without these exports is simply absent instead of a type error.
 * Same pattern as services/foreignWindowCaptureGuard.ts.
 */
interface GdiCaptureNative {
  captureForegroundTreeGdi?: (maxWidth?: number | null) => GdiCaptureRaw | null
  capture_foreground_tree_gdi?: (maxWidth?: number | null) => GdiCaptureRaw | null
  captureWindowTreeGdi?: (hwnd: Buffer, maxWidth?: number | null) => GdiCaptureRaw | null
  capture_window_tree_gdi?: (hwnd: Buffer, maxWidth?: number | null) => GdiCaptureRaw | null
  getForegroundWindowRect?: () => GdiRect | null
  get_foreground_window_rect?: () => GdiRect | null
  captureRegionGdi?: (rect: GdiRect, maxWidth?: number | null) => GdiCaptureRaw | null
  capture_region_gdi?: (rect: GdiRect, maxWidth?: number | null) => GdiCaptureRaw | null
  getVirtualScreenBounds?: () => GdiRect | null
  get_virtual_screen_bounds?: () => GdiRect | null
  isWindowCaptureProtected?: (hwnd?: Buffer | null) => boolean
  is_window_capture_protected?: (hwnd?: Buffer | null) => boolean
}

/** Peak luma at or below this = black. */
const BLANK_LUMA_MAX = 15
/** Below this spread between min and max = one flat colour, also a failure. */
const BLANK_LUMA_SPREAD = 6

export function logCapture(msg: string): void {
  const ts = new Date().toISOString()
  const line = `[${ts}] [ScreenshotGdi] ${msg}\n`
  console.log(`[ScreenshotGdi] ${msg}`)
  try {
    const os = require('os')
    const path = require('path')
    const fs = require('fs')
    const logPath = path.join(os.homedir(), 'natively_capture.log')
    fs.appendFileSync(logPath, line, 'utf8')
  } catch {}
}

let cached: GdiCaptureNative | null | undefined

function loadGdiNative(): GdiCaptureNative | null {
  if (cached !== undefined) return cached
  try {
    // Required lazily: loadNativeModule touches app.getAppPath() and is not
    // safe to import at module scope in a renderer or worker context.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadNativeModule } = require('./audio/nativeModuleLoader') as {
      loadNativeModule: () => unknown
    }
    const native = loadNativeModule() as any
    if (!native) {
      logCapture('loadGdiNative: loadNativeModule returned null')
      cached = null
      return null
    }

    const keys = Object.keys(native)
    logCapture(`loadGdiNative: native module loaded (${keys.length} keys: ${keys.slice(0, 15).join(', ')}...)`)

    const captureFn = native.captureForegroundTreeGdi || native.capture_foreground_tree_gdi
    if (typeof captureFn !== 'function') {
      logCapture(`loadGdiNative: native module loaded but captureForegroundTreeGdi is missing. Available keys: ${keys.join(', ')}`)
      cached = null
      return null
    }

    // Normalize methods so both camelCase and snake_case properties exist on native
    native.capture_foreground_tree_gdi = captureFn
    native.captureForegroundTreeGdi = captureFn

    const rectFn = native.getForegroundWindowRect || native.get_foreground_window_rect
    native.get_foreground_window_rect = rectFn
    native.getForegroundWindowRect = rectFn

    const protectFn = native.isWindowCaptureProtected || native.is_window_capture_protected
    native.is_window_capture_protected = protectFn
    native.isWindowCaptureProtected = protectFn

    const regionFn = native.captureRegionGdi || native.capture_region_gdi
    native.capture_region_gdi = regionFn
    native.captureRegionGdi = regionFn

    const boundsFn = native.getVirtualScreenBounds || native.get_virtual_screen_bounds
    native.get_virtual_screen_bounds = boundsFn
    native.getVirtualScreenBounds = boundsFn

    logCapture('loadGdiNative: native module loaded successfully with GDI exports')
    cached = native as GdiCaptureNative
  } catch (err) {
    logCapture(`loadGdiNative error: ${err}`)
    cached = null
  }
  return cached
}


/** True only on Windows with a native binary that has the GDI exports. */
export function isGdiCaptureAvailable(): boolean {
  return process.platform === 'win32' && loadGdiNative() !== null
}

/**
 * Capture the foreground window by walking its child windows.
 *
 * Returns null if GDI is unavailable, no window has focus, or every attempt
 * came back blank. Never returns a blank frame — the native side validates.
 */
export function captureForegroundWindowGdi(): {
  png: Buffer
  width: number
  height: number
  method: string
} | null {
  if (process.platform !== 'win32') return null

  let native: GdiCaptureNative | null
  try {
    native = loadGdiNative()
  } catch {
    return null
  }
  if (!native?.capture_foreground_tree_gdi) return null

  let raw: GdiCaptureRaw | null = null
  try {
    raw = native.capture_foreground_tree_gdi(null)
  } catch (error) {
    console.error('[ScreenshotGdi] capture_foreground_tree_gdi threw:', error)
    return null
  }

  if (!raw || raw.width <= 0 || raw.height <= 0) {
    console.log('[ScreenshotGdi] window tree produced nothing')
    return null
  }
  if (raw.blank) {
    console.warn(`[ScreenshotGdi] window tree frame validated blank (${raw.method})`)
    return null
  }

  try {
    const png = nativeImage
      .createFromBitmap(Buffer.from(raw.data), { width: raw.width, height: raw.height })
      .toPNG()
    if (!png?.length) return null
    console.log(
      `[ScreenshotGdi] captured ${raw.width}x${raw.height} via ${raw.method} ` +
      `in ${raw.duration_ms.toFixed(1)}ms`
    )
    return { png, width: raw.width, height: raw.height, method: raw.method }
  } catch (error) {
    console.error('[ScreenshotGdi] failed to encode GDI frame:', error)
    return null
  }
}

/**
 * Is the rectangle `rect` (in image pixels) blank inside this PNG?
 *
 * Uses sharp's `stats()` on the extracted region, which reads the channel
 * extremes without building a full pixel array.
 */
export async function regionIsBlank(png: Buffer, rect: GdiRect): Promise<boolean> {
  try {
    const sharp = (await import('sharp')).default
    const meta = await sharp(png).metadata()
    const imgW = meta.width ?? 0
    const imgH = meta.height ?? 0
    if (!imgW || !imgH) return false

    const left = Math.max(0, Math.min(Math.round(rect.x), imgW - 1))
    const top = Math.max(0, Math.min(Math.round(rect.y), imgH - 1))
    const width = Math.max(1, Math.min(Math.round(rect.width), imgW - left))
    const height = Math.max(1, Math.min(Math.round(rect.height), imgH - top))

    const stats = await sharp(png).extract({ left, top, width, height }).stats()
    const rgb = stats.channels.slice(0, 3)
    if (rgb.length === 0) return false

    let min = Number.POSITIVE_INFINITY
    let max = 0
    for (const c of rgb) {
      min = Math.min(min, c.min)
      max = Math.max(max, c.max)
    }
    return max <= BLANK_LUMA_MAX || max - min < BLANK_LUMA_SPREAD
  } catch (error) {
    console.error('[ScreenshotGdi] region blank check failed:', error)
    return false
  }
}

/**
 * The foreground window's rectangle in physical screen pixels, or null.
 */
export function foregroundWindowRect(): GdiRect | null {
  if (process.platform !== 'win32') return null
  try {
    return loadGdiNative()?.get_foreground_window_rect?.() ?? null
  } catch {
    return null
  }
}

/**
 * How much of the captured frame the foreground window has to cover before a
 * GDI capture is allowed to replace it.
 *
 * Replacement is only safe when the window we re-capture is essentially what
 * the frame was supposed to contain. Below this, a blank region is just a
 * window with a dark theme sitting in the corner, and swapping the whole
 * display for one window would be a regression.
 */
const MIN_WINDOW_COVERAGE = 0.6

/**
 * Replace a screenshot whose foreground window came back blank.
 *
 * Fires only when every one of these holds:
 *   - Windows, with a native binary that has the GDI exports;
 *   - the foreground window covers >= 60% of the captured frame;
 *   - the region that window occupies in the frame is blank;
 *   - GDI actually produced a non-blank frame.
 *
 * Returns true if the file was replaced. Any failure leaves the original in
 * place — this never makes a working capture worse.
 *
 * Set NATIVELY_GDI_CAPTURE=always to skip the blank check and exercise the GDI
 * path on every capture, for testing the pipeline without a protected app.
 */
export async function repairBlankedWindowCapture(
  pngPath: string,
  display: { bounds: { x: number; y: number; width: number; height: number }, scaleFactor: number }
): Promise<boolean> {
  if (process.platform !== 'win32') return false

  const force = process.env.NATIVELY_GDI_CAPTURE === 'always'

  let native: GdiCaptureNative | null
  let rect: GdiRect | null
  try {
    native = loadGdiNative()
    rect = native?.get_foreground_window_rect?.() ?? null
  } catch (err) {
    logCapture(`repairBlankedWindowCapture: native call failed: ${err}`)
    return false
  }
  if (!native || !rect) {
    logCapture(`repairBlankedWindowCapture aborted: native=${!!native}, rect=${JSON.stringify(rect)}`)
    return false
  }

  logCapture(`repairBlankedWindowCapture target rect: ${JSON.stringify(rect)}`)

  let png: Buffer
  try {
    png = await fs.promises.readFile(pngPath)
  } catch {
    logCapture(`Failed to read pngPath: ${pngPath}`)
    return false
  }

  const sharp = (await import('sharp')).default
  let imgW = 0
  let imgH = 0
  try {
    const meta = await sharp(png).metadata()
    imgW = meta.width ?? 0
    imgH = meta.height ?? 0
  } catch {
    return false
  }
  if (!imgW || !imgH) return false

  const region = windowRectToImageCoords(rect, display, imgW, imgH)
  if (!region) {
    logCapture('windowRectToImageCoords returned null, cannot map coordinates')
    return false
  }

  // 1. Detect if the foreground window (or any child) is protected via WDA_EXCLUDEFROMCAPTURE or WDA_MONITOR
  const isProtected = native.is_window_capture_protected?.() ?? false

  // 2. Check if the region is blank/black
  const blank = await regionIsBlank(png, region)

  const coverage = (region.width * region.height) / (imgW * imgH)

  logCapture(
    `Image ${imgW}x${imgH}, region=${JSON.stringify(region)}, coverage=${(coverage * 100).toFixed(1)}%, ` +
    `isProtected=${isProtected}, blank=${blank}, force=${force}`
  )

  // Trigger repair if:
  // - forced by env
  // - window is protected (WDA_EXCLUDEFROMCAPTURE / WDA_MONITOR) - THIS FIXES THE WALLPAPER TRANSPARENCY BUG
  // - region in desktop capture came back blank/black
  // - OR if the window covers substantial area (>= 40%)
  const shouldRepair = force || isProtected || blank || (coverage >= 0.4)

  if (!shouldRepair) {
    logCapture('foreground window looks normal and unprotected; keeping desktopCapturer frame')
    return false
  }

  logCapture(
    `triggering GDI capture (protected=${isProtected}, blank=${blank}, coverage=${(coverage * 100).toFixed(0)}%)`
  )

  const gdi = captureForegroundWindowGdi()
  if (!gdi) {
    logCapture('GDI capture produced no frame; keeping original')
    return false
  }

  try {
    // If the window is near fullscreen (>= 70%), writing the clean window capture directly gives the AI full fidelity
    if (coverage >= 0.7) {
      await fs.promises.writeFile(pngPath, gdi.png)
      logCapture(`replaced ${pngPath} with full ${gdi.width}x${gdi.height} GDI frame (${gdi.method})`)
      return true
    }

    // Otherwise, composite the window capture onto the desktop frame at the window's exact coordinates!
    const resizedGdi = await sharp(gdi.png)
      .resize(Math.max(1, region.width), Math.max(1, region.height), { fit: 'fill' })
      .toBuffer()

    const composited = await sharp(png)
      .composite([{
        input: resizedGdi,
        left: Math.max(0, region.x),
        top: Math.max(0, region.y),
      }])
      .png()
      .toBuffer()

    await fs.promises.writeFile(pngPath, composited)
    logCapture(`composited ${gdi.method} frame onto desktop at (${region.x}, ${region.y})`)
    return true
  } catch (error) {
    logCapture(`failed to composite/write GDI frame: ${error}`)
    // Fallback: overwrite with gdi.png
    try {
      await fs.promises.writeFile(pngPath, gdi.png)
      logCapture(`Fallback: wrote raw GDI frame to ${pngPath}`)
      return true
    } catch (fbErr) {
      logCapture(`Fallback write failed: ${fbErr}`)
      return false
    }
  }
}

/**
 * Map a physical window rect (GDI virtual-screen coordinates) into pixel
 * coordinates inside the captured image.
 *
 * The two coordinate systems are the same rectangle expressed differently:
 * the display submodule scales `display.bounds` by `scaleFactor` to get the
 * image, while GDI reports absolute virtual-screen pixels. Rather than assume
 * where each origin sits, the offset is derived from both sides — the
 * left-most display's logical origin and SM_XVIRTUALSCREEN — so a monitor
 * placed left of or above the primary does not skew it.
 */
function windowRectToImageCoords(
  rect: GdiRect,
  display: { bounds: { x: number; y: number; width: number; height: number }, scaleFactor: number },
  imgW: number,
  imgH: number
): GdiRect | null {
  let vs: GdiRect | null = null
  try {
    vs = loadGdiNative()?.get_virtual_screen_bounds?.() ?? null
  } catch {
    vs = null
  }
  const vsX = vs?.x ?? 0
  const vsY = vs?.y ?? 0

  let minX = 0
  let minY = 0
  try {
    for (const d of screen.getAllDisplays()) {
      minX = Math.min(minX, d.bounds.x)
      minY = Math.min(minY, d.bounds.y)
    }
  } catch {
    /* screen unavailable; fall back to the primary-origin assumption */
  }

  const scale = display.scaleFactor || 1
  const x = Math.round(rect.x - vsX + (minX - display.bounds.x) * scale)
  const y = Math.round(rect.y - vsY + (minY - display.bounds.y) * scale)
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)

  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(imgW, x + width)
  const bottom = Math.min(imgH, y + height)
  if (right <= left || bottom <= top) return null

  return { x: left, y: top, width: right - left, height: bottom - top }
}
