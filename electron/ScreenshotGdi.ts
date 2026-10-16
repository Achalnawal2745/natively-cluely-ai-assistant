/**
 * Windows GDI screen capture.
 *
 * Natively captures the screen with Electron's `desktopCapturer`, which is the
 * right call on macOS (it is the only API that goes through the Screen
 * Recording TCC gate) but is a known source of trouble on Windows:
 * `getSources()` can return black thumbnails *silently* instead of failing —
 * the behaviour `getDisplaysIntersectingSelection` already documents as issue
 * #133. When that happens the model is handed a black rectangle, the answer is
 * garbage, and there is nothing in the logs to explain why.
 *
 * The native half (native-module/src/capture_gdi.rs) does what the ShadowMind
 * capture path does: a `BitBlt` of the composited desktop with `CAPTUREBLT`
 * set, then a validation pass over the returned pixels that treats an
 * all-black frame as a failure rather than a result. GDI needs no OS
 * permission and returns the frame directly.
 *
 * This module owns the JS-side concerns the Rust half cannot see:
 *   - DPI. Electron hands us `Display.bounds` in DIP (logical) units; GDI works
 *     in physical pixels. We derive the mapping from the GDI virtual screen and
 *     *decline* (return null) whenever that mapping is not well defined —
 *     mixed-DPI multi-monitor layouts, absurd ratios, stale display lists.
 *     Declining is the safe outcome: the caller then runs the existing
 *     desktopCapturer path unchanged, so a wrong screenshot is never
 *     substituted for a missing one.
 *   - Encoding. GDI returns raw BGRA; `nativeImage.createFromBitmap` is the
 *     inverse of `nativeImage.toBitmap` on Windows and does the conversion, and
 *     it emits the PNG so no second image encoder gets involved.
 *   - Output size. The desktopCapturer path requests a logical-resolution
 *     thumbnail, so we downscale to the same width. A GDI frame arriving 2x
 *     larger than the path it replaces would silently change what the vision
 *     models are billed for.
 *
 * Nothing here enumerates windows by title, reads another process's UI tree, or
 * touches a window it does not own — the same boundary
 * native-module/src/capture_exclusion.rs draws.
 */

import { nativeImage, screen } from 'electron'

/** Raw result shape returned by capture_gdi.rs (napi snake_case). */
interface GdiCaptureRaw {
  data: Buffer
  width: number
  height: number
  /** Which cascade step produced the frame. */
  method: string
  duration_ms: number
  /** true when the frame validated as blank — the caller should fall back. */
  blank: boolean
}

interface GdiRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The subset of the native module this module uses, declared here rather than
 * in nativeModuleLoader.ts so an older native binary without these exports is
 * simply absent instead of a type error. Same pattern as
 * services/foreignWindowCaptureGuard.ts.
 */
interface GdiCaptureNative {
  get_virtual_screen_bounds?: () => GdiRect | null
  capture_region_gdi?: (rect: GdiRect, maxWidth?: number | null) => GdiCaptureRaw | null
}

export interface GdiCaptureOutcome {
  png: Buffer
  width: number
  height: number
  method: string
  durationMs: number
}

/** Widest physical/DIP scale we will accept as real; anything else is a bug. */
const MAX_PLAUSIBLE_SCALE = 5
/** Two displays within this much of each other count as the same scale. */
const SCALE_EPSILON = 0.01

function loadGdiNative(): GdiCaptureNative | null {
  try {
    // Required lazily: loadNativeModule touches app.getAppPath() and is not
    // safe to import at module scope in a renderer or worker context.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { loadNativeModule } = require('./audio/nativeModuleLoader') as {
      loadNativeModule: () => unknown
    }
    const native = loadNativeModule() as GdiCaptureNative | null
    if (!native || typeof native.capture_region_gdi !== 'function') {
      return null
    }
    return native
  } catch {
    return null
  }
}

/**
 * Maps a DIP rectangle into GDI physical pixels.
 *
 * Returns null when the mapping is not well defined. The caller must treat null
 * as "use the other capture path", never as "use an approximate rect".
 */
function dipRectToPhysical(rect: GdiRect, native: GdiCaptureNative): GdiRect | null {
  const vs = native.get_virtual_screen_bounds?.()
  if (!vs || vs.width <= 0 || vs.height <= 0) {
    return null
  }

  const displays = screen.getAllDisplays()
  if (displays.length === 0) {
    return null
  }

  // A single global scale is the only case where one number maps the whole
  // virtual screen. With per-monitor DPI the mapping is per-display and a
  // single factor would shear the rect, so we decline instead of guessing.
  const first = displays[0].scaleFactor
  const uniformScale = displays.every((d) => Math.abs(d.scaleFactor - first) <= SCALE_EPSILON)
  if (!uniformScale) {
    console.log('[ScreenshotGdi] mixed-DPI displays; declining GDI capture')
    return null
  }

  let dipLeft = Infinity
  let dipTop = Infinity
  let dipRight = -Infinity
  let dipBottom = -Infinity
  for (const d of displays) {
    dipLeft = Math.min(dipLeft, d.bounds.x)
    dipTop = Math.min(dipTop, d.bounds.y)
    dipRight = Math.max(dipRight, d.bounds.x + d.bounds.width)
    dipBottom = Math.max(dipBottom, d.bounds.y + d.bounds.height)
  }
  const dipWidth = dipRight - dipLeft
  const dipHeight = dipBottom - dipTop
  if (dipWidth <= 0 || dipHeight <= 0) {
    return null
  }

  // Derive the scale from the real GDI virtual screen rather than trusting
  // scaleFactor: it is the one number both sides agree on.
  const scaleX = vs.width / dipWidth
  const scaleY = vs.height / dipHeight
  if (
    !isFinite(scaleX) ||
    !isFinite(scaleY) ||
    scaleX <= 0 ||
    scaleY <= 0 ||
    Math.abs(scaleX - scaleY) > SCALE_EPSILON ||
    scaleX > MAX_PLAUSIBLE_SCALE
  ) {
    console.log(
      `[ScreenshotGdi] implausible DIP scale (${scaleX.toFixed(3)} x ${scaleY.toFixed(3)}); ` +
        'declining GDI capture'
    )
    return null
  }

  return {
    x: Math.round(vs.x + (rect.x - dipLeft) * scaleX),
    y: Math.round(vs.y + (rect.y - dipTop) * scaleX),
    width: Math.round(rect.width * scaleX),
    height: Math.round(rect.height * scaleX),
  }
}

/**
 * Captures `display` (or an arbitrary DIP rect on that display) with GDI and
 * returns a PNG buffer, or null if GDI declined or failed.
 *
 * `targetDipWidth`, when given, is the width the caller wants back; the Rust
 * side downscales with HALFTONE before the pixels cross the napi boundary.
 */
export function captureGdiToPng(
  rectDip: GdiRect,
  targetDipWidth?: number
): GdiCaptureOutcome | null {
  if (process.platform !== 'win32') {
    return null
  }

  const native = loadGdiNative()
  if (!native) {
    return null
  }

  const physical = dipRectToPhysical(rectDip, native)
  if (!physical || physical.width <= 0 || physical.height <= 0) {
    return null
  }

  let raw: GdiCaptureRaw | null = null
  try {
    raw = native.capture_region_gdi!(physical, targetDipWidth ?? null)
  } catch (error) {
    console.error('[ScreenshotGdi] capture_region_gdi threw:', error)
    return null
  }

  if (!raw || raw.width <= 0 || raw.height <= 0) {
    console.log('[ScreenshotGdi] GDI capture returned nothing; falling back')
    return null
  }

  if (raw.blank) {
    // The whole point of the port: a black frame is a failure, not a result.
    console.warn(
      `[ScreenshotGdi] GDI frame validated as blank (${raw.width}x${raw.height}); falling back`
    )
    return null
  }

  try {
    const image = nativeImage.createFromBitmap(Buffer.from(raw.data), {
      width: raw.width,
      height: raw.height,
    })
    const png = image.toPNG()
    if (!png || png.length === 0) {
      console.error('[ScreenshotGdi] nativeImage produced an empty PNG')
      return null
    }
    console.log(
      `[ScreenshotGdi] captured ${raw.width}x${raw.height} via ${raw.method} ` +
        `in ${raw.duration_ms.toFixed(1)}ms`
    )
    return {
      png,
      width: raw.width,
      height: raw.height,
      method: raw.method,
      durationMs: raw.duration_ms,
    }
  } catch (error) {
    console.error('[ScreenshotGdi] failed to encode GDI frame:', error)
    return null
  }
}
