/**
 * Pure state machine behind the screenshare privacy shield (see
 * screenShieldProcessor.ts for the pixels): decides WHEN the OS-toast corner
 * of an outgoing screenshare should be redacted, given a cheap per-sample
 * "how much of the corner just changed" fraction.
 *
 * The signature it hunts is a notification: an abrupt change landing on a
 * corner that was RECENTLY STABLE. That gate is what keeps the false-positive
 * rate civil — content that is constantly busy in the corner (a video, a
 * game) never satisfies the stability precondition, so it never triggers;
 * it only re-arms once the corner has been calm for a while.
 *
 * Costs are asymmetric and the tuning leans accordingly: a false trigger
 * pixelates a corner of the share for a few seconds (mildly annoying); a
 * miss broadcasts a message preview to the whole call (the thing the feature
 * exists to prevent). When in doubt, shield.
 */

/** Corner must be at least this calm, continuously, to arm. */
const CALM_FRACTION = 0.04;
/** Continuous calm needed before the trigger is armed. */
const STABLE_MS = 1500;
/** Armed + a change this large = something just appeared: shield. */
const TRIGGER_FRACTION = 0.1;
/** Minimum shield time once triggered (Windows toasts default ~5s). */
const HOLD_MS = 7000;

export type ShieldPhase = "arming" | "armed" | "shielding";

export class ScreenShieldDetector {
  #phase: ShieldPhase = "arming";
  #calmSinceMs: number | undefined;
  #holdUntilMs = 0;

  get phase(): ShieldPhase {
    return this.#phase;
  }

  /**
   * Feed one sample; returns whether the corner should be redacted right now.
   * `changedFraction` is the fraction of corner pixels that changed
   * meaningfully since the previous sample, `nowMs` any monotonic clock.
   */
  feed(changedFraction: number, nowMs: number): boolean {
    switch (this.#phase) {
      case "arming": {
        if (changedFraction < CALM_FRACTION) {
          this.#calmSinceMs ??= nowMs;
          if (nowMs - this.#calmSinceMs >= STABLE_MS) this.#phase = "armed";
        } else {
          // Busy corner: the stability clock starts over.
          this.#calmSinceMs = undefined;
        }
        return false;
      }
      case "armed": {
        if (changedFraction >= TRIGGER_FRACTION) {
          this.#phase = "shielding";
          this.#holdUntilMs = nowMs + HOLD_MS;
          return true;
        }
        return false;
      }
      case "shielding": {
        // Hold through the minimum, then stay shielded until the corner is
        // calm again — a toast that lingers (or a stack of them) must not
        // peek out just because the timer ran down.
        if (nowMs >= this.#holdUntilMs && changedFraction < CALM_FRACTION) {
          this.#phase = "arming";
          this.#calmSinceMs = nowMs;
          return false;
        }
        return true;
      }
    }
  }

  /** Back to square one (track restart / resolution change). */
  reset(): void {
    this.#phase = "arming";
    this.#calmSinceMs = undefined;
    this.#holdUntilMs = 0;
  }
}

/**
 * Fraction of pixels whose luma moved more than a threshold between two
 * equally-sized RGBA buffers (the downscaled corner). Pure so the specs can
 * feed synthetic frames.
 */
export function changedFraction(
  previous: Uint8ClampedArray,
  current: Uint8ClampedArray,
): number {
  const pixels = Math.min(previous.length, current.length) / 4;
  if (pixels === 0) return 0;
  let changed = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    // Integer luma approximation (BT.601-ish weights out of 16).
    const lumaPrev =
      (previous[o] * 5 + previous[o + 1] * 9 + previous[o + 2] * 2) >> 4;
    const lumaCur =
      (current[o] * 5 + current[o + 1] * 9 + current[o + 2] * 2) >> 4;
    if (Math.abs(lumaCur - lumaPrev) > 24) changed++;
  }
  return changed / pixels;
}
