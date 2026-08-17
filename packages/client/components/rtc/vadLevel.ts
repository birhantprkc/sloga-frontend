/**
 * Shared microphone-level and voice-activity arithmetic.
 *
 * ONE definition of "level" for the VAD gate (state.tsx `#startVAD`), the
 * Voice-settings sensitivity meter and the input-level test, so a threshold
 * the user sets against the meter is exactly the threshold the call gate
 * compares against. Byte-frequency average × 2.5, clamped to 0–100.
 */

/** Analyser configuration every consumer must use for the numbers to agree. */
export const VAD_FFT_SIZE = 512;

/** 0–100 loudness from an analyser's byte-frequency snapshot. */
export function levelFromFrequencyData(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i];
  const avg = buf.length ? sum / buf.length : 0;
  return Math.min(100, avg * 2.5);
}

/** Threshold bounds in automatic mode (same 0–100 scale as the level). */
export const AUTO_THRESHOLD_MIN = 12;
export const AUTO_THRESHOLD_MAX = 60;
/** How far above the tracked noise floor the gate opens. */
export const AUTO_THRESHOLD_MARGIN = 12;

/** Threshold implied by a given ambient noise floor. */
export function autoThresholdFor(noiseFloor: number): number {
  // Margin grows with the floor: a noisy room needs more headroom above its
  // average than a quiet one, because its peaks sit further above it.
  return Math.min(
    AUTO_THRESHOLD_MAX,
    Math.max(
      AUTO_THRESHOLD_MIN,
      noiseFloor + AUTO_THRESHOLD_MARGIN + noiseFloor * 0.5,
    ),
  );
}

/**
 * Adaptive noise-floor tracker for "automatically adjust input sensitivity".
 *
 * The floor is a SMOOTHED estimate of the ambient level, not its minimum:
 * a raw minimum locks onto the near-zero frames every room produces between
 * sounds and then the ordinary hiss opens the gate. It settles downward in
 * about a second (rate 0.03/frame at 60 fps) and rises only slowly (0.003),
 * so a pause between phrases pulls it back to the real room noise while
 * sustained speech barely moves it. `update()` returns the current auto
 * threshold.
 */
export function createNoiseFloorTracker() {
  let floor = 100;
  return {
    update(level: number): number {
      const rate = level < floor ? 0.03 : 0.003;
      floor += (level - floor) * rate;
      return autoThresholdFor(floor);
    },
    get floor() {
      return floor;
    },
    reset() {
      floor = 100;
    },
  };
}
