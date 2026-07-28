/**
 * Coordinate mapping for the remote-control capture surface.
 *
 * A dependency-free leaf, on the `mlsDrainPolicy.ts` precedent, so it can be
 * exercised by Node's built-in test runner without dragging in Solid, LiveKit
 * or the path aliases. That is not tidiness: this is the one piece of the
 * feature whose being wrong makes remote control feel BROKEN rather than
 * laggy, and it fails systematically — every click lands the same distance
 * off, which reads as "remote control doesn't work".
 */

/**
 * Map a viewport point to normalized `[0,1]` coordinates of a video's
 * CONTENT BOX, or `undefined` if it falls outside the picture.
 *
 * `object-fit: contain` letterboxes — a 16:9 stream in a non-16:9 tile has
 * bars that are part of the element rect but not part of the picture — so the
 * naive `(clientX - rect.left) / rect.width` is both offset and mis-scaled,
 * and every click lands tens to hundreds of pixels off target.
 *
 * @param rect element bounds, from `getBoundingClientRect()` (viewport coords)
 * @param dims INTRINSIC video dimensions (`videoWidth`/`videoHeight`), never
 *        element dimensions
 */
export function normalizeToContentBox(
  rect: { left: number; top: number; width: number; height: number },
  dims: { width: number; height: number },
  point: { clientX: number; clientY: number },
): { x: number; y: number } | undefined {
  // The tile's `videoDims` is per-tile state and resets to {0,0} on the
  // remount a focus toggle causes, until the next `resize` repopulates it.
  // Dividing by zero there yields NaN, which native clamps into the monitor
  // rect — i.e. the sharer's pointer would jump to a corner on every toggle.
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  if (dims.width <= 0 || dims.height <= 0) return undefined;

  const scale = Math.min(rect.width / dims.width, rect.height / dims.height);
  const contentWidth = dims.width * scale;
  const contentHeight = dims.height * scale;
  const left = rect.left + (rect.width - contentWidth) / 2;
  const top = rect.top + (rect.height - contentHeight) / 2;

  const x = (point.clientX - left) / contentWidth;
  const y = (point.clientY - top) / contentHeight;
  // Reject rather than extrapolate: a point in a letterbox bar is not a point
  // on the sharer's desktop, and guessing one sends their pointer somewhere
  // nobody pointed — off the top of their screen, or onto a monitor they are
  // not sharing.
  if (x < 0 || x > 1 || y < 0 || y > 1) return undefined;
  return { x, y };
}

/** `WHEEL_DELTA` — one wheel notch, as `WM_MOUSEWHEEL` counts them. */
const WHEEL_DELTA = 120;

/**
 * Chromium's pixel-mode delta for one physical wheel notch on Windows.
 * The reference the other `deltaMode`s are expressed against.
 */
const PIXELS_PER_NOTCH = 100;

/**
 * Convert one axis of a DOM wheel delta into `WHEEL_DELTA` multiples, which
 * is what native injects and what `WM_MOUSEWHEEL` means.
 *
 * Forwarding raw DOM deltas is wrong in three separate ways: a Chromium
 * notch is ~100 px against a `WHEEL_DELTA` of 120 (so scrolling runs ~17%
 * short), other `deltaMode`s count lines or pages rather than pixels, and a
 * trackpad emits small fractional deltas that truncate to zero — scrolling
 * nothing at all in applications that do not accumulate sub-notch deltas.
 *
 * `carry` holds the sub-notch remainder BETWEEN events, so a slow trackpad
 * swipe accumulates into a notch instead of being discarded a fraction at a
 * time. Thread the returned `carry` back in on the next event, per axis.
 *
 * Sign is the CALLER'S problem: DOM `deltaY` is positive downward and
 * `MOUSEEVENTF_WHEEL` is positive forward (i.e. upward), so the vertical
 * axis has to be negated on the way in. `deltaX` matches as-is.
 */
export function wheelNotches(
  delta: number,
  deltaMode: number,
  carry: number,
): { whole: number; carry: number } {
  const notches =
    deltaMode === 1 // DOM_DELTA_LINE — three lines per notch, by convention
      ? delta / 3
      : deltaMode === 2 // DOM_DELTA_PAGE — a page is a screenful; native clamps at 16
        ? delta * 16
        : delta / PIXELS_PER_NOTCH;
  const scaled = carry + notches * WHEEL_DELTA;
  // Truncate toward zero so the carry never changes sign: rounding here
  // would let a reversal of direction cancel out a notch the user already
  // scrolled.
  const whole = Math.trunc(scaled / WHEEL_DELTA) * WHEEL_DELTA;
  return { whole, carry: scaled - whole };
}

/**
 * §3's "two paths" decision for one keyboard event: does it travel as TEXT
 * (`beforeinput` → `KEYEVENTF_UNICODE`) or as a SCAN CODE?
 *
 * A scan code resolves through the SHARER'S keyboard layout, so it is right
 * for positional semantics and wrong for textual intent — a QWERTY
 * controller pressing `KeyZ` types `w` on an AZERTY sharer, and accented
 * characters, dead-key composition and IME candidates are unreachable by
 * scan code at all. So anything that produces a character goes by text, and
 * control/navigation/modifier keys and accelerator chords go by scan code.
 *
 * `"text"` — `key` is a single character and no accelerator modifier is
 * down. AltGr counts as text, not as an accelerator: Windows browsers report
 * it as Ctrl+Alt, and it exists precisely to produce characters (AZERTY
 * AltGr+E is `€`).
 *
 * `"scan"` — everything else: named keys (`Enter`, `Backspace`, arrows,
 * function keys, the modifiers themselves) and Ctrl/Alt/Meta chords, which
 * must arrive as the chord (`Ctrl+C`), never as its character.
 *
 * Composition (`isComposing`, `Dead`, `Process`) is deliberately NOT this
 * function's concern — the capture surface skips those events entirely and
 * lets `compositionend` deliver the composed text.
 */
export function classifyKey(event: {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** `getModifierState("AltGraph")` where available. */
  altGraph?: boolean;
}): "text" | "scan" {
  if ([...event.key].length !== 1) return "scan";
  if (event.altGraph || (event.ctrlKey && event.altKey)) return "text";
  if (event.ctrlKey || event.altKey || event.metaKey) return "scan";
  return "text";
}
