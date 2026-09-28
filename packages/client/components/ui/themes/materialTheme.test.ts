/**
 * Run with:
 *
 *     node --conditions=browser --test components/ui/themes/materialTheme.test.ts
 *
 * The Sloga preset's accent. Before it existed, picking a colour under the
 * default preset did nothing: the scheme was always seeded from the brand
 * blue and the swatches were hidden. These pin the three things the fix must
 * not break: the default look is byte-for-byte the hand-tuned brand tables,
 * a custom accent actually reaches the accent roles, and whatever the store
 * hands over comes out in a form the rest of the theme code can parse.
 *
 * Known-bad control: making `brandPins` return the brand tables for every
 * accent (the behaviour before the fix) turns every "a custom accent reaches
 * the accent roles" case red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BRAND_ACCENT,
  brandPins,
  createMaterialColourVariables,
  createMduiColourTriplets,
} from "./materialTheme.ts";

const common = {
  blur: true,
  interfaceFont: "Inter",
  monospaceFont: "Fira Code",
  messageSize: 14,
  messageGroupSpacing: 12,
  messageAvatarSize: 36,
  contrast: 0,
  variant: "tonal_spot",
} as const;

function colours(preset: "stoat" | "you", accent: string, darkMode: boolean) {
  return createMaterialColourVariables(
    { ...common, preset, accent, darkMode } as never,
    "",
  ) as Record<string, string>;
}

const SIX_DIGIT = /^#[0-9a-fA-F]{6}$/;

describe("the default look is unchanged", () => {
  it("brand blue renders the hand-tuned dark table", () => {
    const dark = colours("stoat", BRAND_ACCENT, true);
    assert.equal(dark.primary, "#00B2FF");
    assert.equal(dark["on-primary"], "#05090F");
    assert.equal(dark.surface, "#05090F");
  });

  it("brand blue renders the hand-tuned light table", () => {
    const light = colours("stoat", BRAND_ACCENT, false);
    assert.equal(light.primary, "#006492");
    assert.equal(light["on-primary"], "#ffffff");
  });

  it("brand blue is recognised whatever its case", () => {
    assert.deepEqual(brandPins("#00b2ff", true), brandPins(BRAND_ACCENT, true));
  });
});

describe("a custom accent reaches the accent roles", () => {
  it("dark mode fills with the colour as picked on the navy chrome", () => {
    const dark = colours("stoat", "#ff5733", true);
    assert.equal(dark.primary, "#ff5733");
    assert.equal(dark["primary-container"], "#ff5733");
    assert.equal(dark["on-primary"], "#05090F");
    assert.equal(dark.surface, "#05090F");
  });

  it("dark mode lifts a colour too dark to read as a button", () => {
    const dark = colours("stoat", "#1a1a40", true);
    assert.notEqual(dark.primary, "#1a1a40");
    assert.notEqual(dark.primary, "#00B2FF");
    assert.match(dark.primary, SIX_DIGIT);
  });

  it("light mode takes the colour at the tone that gives the brand #006492", () => {
    const light = colours("stoat", "#ff5733", false);
    assert.notEqual(light.primary, "#006492");
    assert.notEqual(light.primary, "#ff5733");
    assert.equal(light["on-primary"], "#ffffff");
  });
});

describe("the output stays parseable", () => {
  it("a three-digit accent comes out as six digits", () => {
    assert.match(colours("stoat", "#f00", true).primary, SIX_DIGIT);
    assert.match(colours("stoat", "#f00", false).primary, SIX_DIGIT);
  });

  it("the MDUI triplets do not throw on a three-digit accent", () => {
    assert.doesNotThrow(() =>
      createMduiColourTriplets(
        { ...common, preset: "stoat", accent: "#f00", darkMode: true } as never,
        "x-",
      ),
    );
  });
});

describe("Material You is untouched", () => {
  it("does not pin the brand tables", () => {
    assert.notEqual(colours("you", BRAND_ACCENT, true).primary, "#00B2FF");
    assert.notEqual(colours("you", BRAND_ACCENT, true).surface, "#05090F");
  });
});
