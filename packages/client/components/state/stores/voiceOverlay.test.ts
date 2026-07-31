/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/voiceOverlay.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests — without it
 * Node resolves solid-js's server build and effect-based specs silently pass
 * against broken code. This file is pure and unaffected, but one invocation
 * should cover it and the reactive suites together.)
 *
 * These are the persisted-settings clamps. The failure they exist to prevent
 * is not a crash — it is an overlay that is invisible, off-screen or
 * unreadably huge on top of someone's game, with no in-window UI to fix it
 * from, because the overlay is click-through and has no controls at all.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OVERLAY_CORNERS,
  OVERLAY_DISPLAY_MODES,
} from "../../rtc/overlay/protocol.ts";

import {
  OverlayCornerNames,
  OverlayDisplayModeNames,
  cleanOverlaySettings,
  defaultOverlaySettings,
} from "./voiceOverlay.ts";

describe("store list ↔ wire list", () => {
  // The two copies exist because the rtc module imports this store, so
  // importing back would be a runtime cycle (same reason the face-filter ids
  // are duplicated). Duplication is fine; DRIFT is not — a mode the store
  // accepts but the renderer cannot draw is a blank overlay.
  it("display modes match", () => {
    assert.deepEqual(OverlayDisplayModeNames, OVERLAY_DISPLAY_MODES);
  });

  it("corners match", () => {
    assert.deepEqual(OverlayCornerNames, OVERLAY_CORNERS);
  });
});

describe("defaults", () => {
  it("is OFF by default", () => {
    assert.equal(defaultOverlaySettings().overlayEnabled, false);
  });

  it("anchors top-left, clear of the remote-control indicator", () => {
    assert.equal(defaultOverlaySettings().overlayCorner, "top-left");
  });

  it("returns a fresh object each call (no shared mutable default)", () => {
    const first = defaultOverlaySettings();
    first.overlayScale = 99;
    assert.equal(defaultOverlaySettings().overlayScale, 1);
  });
});

describe("cleanOverlaySettings — empty and unknown input", () => {
  it("fills every key from the defaults", () => {
    assert.deepEqual(cleanOverlaySettings({}), defaultOverlaySettings());
  });

  it("ignores keys it does not own", () => {
    const result = cleanOverlaySettings({
      nonsense: true,
    } as unknown as Partial<ReturnType<typeof defaultOverlaySettings>>);
    assert.deepEqual(result, defaultOverlaySettings());
  });
});

describe("cleanOverlaySettings — opacity", () => {
  it("keeps an in-range value", () => {
    assert.equal(
      cleanOverlaySettings({ overlayOpacity: 0.5 }).overlayOpacity,
      0.5,
    );
  });

  it("clamps below the floor rather than rejecting", () => {
    assert.equal(
      cleanOverlaySettings({ overlayOpacity: 0 }).overlayOpacity,
      0.2,
    );
    assert.equal(
      cleanOverlaySettings({ overlayOpacity: -5 }).overlayOpacity,
      0.2,
    );
  });

  it("clamps above the ceiling", () => {
    assert.equal(cleanOverlaySettings({ overlayOpacity: 4 }).overlayOpacity, 1);
  });

  it("rejects NaN and Infinity instead of propagating them", () => {
    // Math.max/min pass NaN straight through; an opacity of NaN is an
    // invisible overlay with nothing on screen to explain why.
    assert.equal(
      cleanOverlaySettings({ overlayOpacity: NaN }).overlayOpacity,
      0.85,
    );
    assert.equal(
      cleanOverlaySettings({ overlayOpacity: Infinity }).overlayOpacity,
      0.85,
    );
  });

  it("rejects a non-number", () => {
    assert.equal(
      cleanOverlaySettings({ overlayOpacity: "0.5" as unknown as number })
        .overlayOpacity,
      0.85,
    );
  });
});

describe("cleanOverlaySettings — scale", () => {
  it("keeps an in-range value", () => {
    assert.equal(cleanOverlaySettings({ overlayScale: 1.5 }).overlayScale, 1.5);
  });

  it("clamps to 0.6–2", () => {
    assert.equal(cleanOverlaySettings({ overlayScale: 0.1 }).overlayScale, 0.6);
    assert.equal(cleanOverlaySettings({ overlayScale: 100 }).overlayScale, 2);
  });

  it("rejects NaN", () => {
    assert.equal(cleanOverlaySettings({ overlayScale: NaN }).overlayScale, 1);
  });
});

describe("cleanOverlaySettings — enums", () => {
  it("accepts every declared display mode", () => {
    for (const mode of OverlayDisplayModeNames) {
      assert.equal(
        cleanOverlaySettings({ overlayDisplayMode: mode }).overlayDisplayMode,
        mode,
      );
    }
  });

  it("accepts every declared corner", () => {
    for (const corner of OverlayCornerNames) {
      assert.equal(
        cleanOverlaySettings({ overlayCorner: corner }).overlayCorner,
        corner,
      );
    }
  });

  it("falls back on an unknown display mode", () => {
    assert.equal(
      cleanOverlaySettings({
        overlayDisplayMode: "holograms" as never,
      }).overlayDisplayMode,
      "avatars-names",
    );
  });

  it("falls back on an unknown corner — an off-screen anchor is unrecoverable", () => {
    assert.equal(
      cleanOverlaySettings({ overlayCorner: "middle" as never }).overlayCorner,
      "top-left",
    );
  });
});

describe("cleanOverlaySettings — booleans", () => {
  it("accepts real booleans", () => {
    assert.equal(
      cleanOverlaySettings({ overlayEnabled: true }).overlayEnabled,
      true,
    );
    assert.equal(
      cleanOverlaySettings({ overlayShowLatency: true }).overlayShowLatency,
      true,
    );
  });

  it("does not coerce truthy junk into enabling the overlay", () => {
    assert.equal(
      cleanOverlaySettings({ overlayEnabled: "yes" as unknown as boolean })
        .overlayEnabled,
      false,
    );
    assert.equal(
      cleanOverlaySettings({ overlayEnabled: 1 as unknown as boolean })
        .overlayEnabled,
      false,
    );
  });
});
