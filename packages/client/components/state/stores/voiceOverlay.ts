/**
 * In-game voice overlay settings: the six keys, their defaults, and their
 * validation.
 *
 * Split out of `Voice.ts` deliberately, for two reasons:
 *
 * 1. **It is unit-testable in isolation.** `Voice.ts` imports the `State`
 *    class, which reaches the whole app — the store class cannot be loaded by
 *    `node --test`. This module has no imports at all, so the clamps can be
 *    specified directly rather than through a running store.
 * 2. **The bounds live in one place.** The settings sliders, the store's
 *    `clean()` and the overlay renderer all have to agree about 0.1–1 and
 *    0.6–2; three copies of a range is three chances to drift. (The opacity
 *    slider used to hardcode its own `min` and did exactly that when the
 *    floor moved from 0.2 to 0.1 — it reads the constant now.)
 *
 * The enum lists are duplicated from `@revolt/rtc/overlay/protocol` rather
 * than imported, matching how the face-filter ids are handled: the rtc module
 * imports this store, so importing back would be a runtime cycle. A test pins
 * the two copies together.
 */

export type OverlayDisplayModeName = "avatars" | "avatars-names" | "names";

export const OverlayDisplayModeNames: OverlayDisplayModeName[] = [
  "avatars",
  "avatars-names",
  "names",
];

export type OverlayCornerName =
  | "top-left"
  | "top-right"
  | "middle-left"
  | "middle-right"
  | "bottom-left"
  | "bottom-right";

export const OverlayCornerNames: OverlayCornerName[] = [
  "top-left",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-right",
];

export const OVERLAY_OPACITY_MIN = 0.1;
export const OVERLAY_OPACITY_MAX = 1;
export const OVERLAY_SCALE_MIN = 0.6;
export const OVERLAY_SCALE_MAX = 2;

/**
 * The overlay's slice of the voice settings. LOCAL PER-DEVICE: the voice
 * store is not in the synced set (Sync.ts), which is right for these —
 * the corner that keeps clear of your game HUD on the desktop is not the one
 * you want on the laptop, and a purely local window-management preference is
 * no reason to widen the server's write surface.
 */
export interface TypeVoiceOverlay {
  overlayEnabled: boolean;
  /** 0.1–1 */
  overlayOpacity: number;
  /** 0.6–2 */
  overlayScale: number;
  overlayDisplayMode: OverlayDisplayModeName;
  overlayShowLatency: boolean;
  overlayCorner: OverlayCornerName;
}

export function defaultOverlaySettings(): TypeVoiceOverlay {
  return {
    overlayEnabled: false,
    overlayOpacity: 0.85,
    overlayScale: 1,
    overlayDisplayMode: "avatars-names",
    overlayShowLatency: false,
    // Top-left keeps clear of the remote-control indicator's territory
    // (top-centre of the primary monitor). Overlapping would be harmless
    // anyway — the overlay is click-through, so the indicator's Stop button
    // stays reachable through it — but not overlapping is better.
    overlayCorner: "top-left",
  };
}

/**
 * Clamp a persisted number into range.
 *
 * CLAMP rather than reject: a value outside the slider's range is a settings
 * file written by a different build, not an attack, and snapping it to the
 * nearest legal value is what the user meant. NaN and Infinity are rejected
 * outright though — `Math.max`/`Math.min` propagate NaN silently, and an
 * opacity of NaN renders the overlay invisible with nothing on screen to
 * explain why.
 */
function clampNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

/**
 * Validate the overlay keys out of persisted (untrusted) settings.
 */
export function cleanOverlaySettings(
  input: Partial<TypeVoiceOverlay>,
): TypeVoiceOverlay {
  const data = defaultOverlaySettings();

  if (typeof input.overlayEnabled === "boolean") {
    data.overlayEnabled = input.overlayEnabled;
  }

  data.overlayOpacity = clampNumber(
    input.overlayOpacity,
    OVERLAY_OPACITY_MIN,
    OVERLAY_OPACITY_MAX,
    data.overlayOpacity,
  );

  data.overlayScale = clampNumber(
    input.overlayScale,
    OVERLAY_SCALE_MIN,
    OVERLAY_SCALE_MAX,
    data.overlayScale,
  );

  if (
    input.overlayDisplayMode &&
    OverlayDisplayModeNames.includes(input.overlayDisplayMode)
  ) {
    data.overlayDisplayMode = input.overlayDisplayMode;
  }

  if (typeof input.overlayShowLatency === "boolean") {
    data.overlayShowLatency = input.overlayShowLatency;
  }

  if (input.overlayCorner && OverlayCornerNames.includes(input.overlayCorner)) {
    data.overlayCorner = input.overlayCorner;
  }

  return data;
}
