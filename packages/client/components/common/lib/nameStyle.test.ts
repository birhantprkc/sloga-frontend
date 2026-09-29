// Specs for personal name styles — run with Node's built-in runner:
//   node --conditions=browser --test components/common/lib/nameStyle.test.ts
//
// Everything here is pure except the stylesheet check, which swaps in a
// minimal fake `document` for the duration of one test.
import assert from "node:assert/strict";
import { test } from "node:test";

import { type NameFont, type NameStyle, UserPerks } from "stoat.js";

import {
  ensureNameStyleSheet,
  loadNameFont,
  NAME_EFFECTS,
  NAME_FONT_FAMILIES,
  NAME_FONTS,
  nameStyleClass,
  permittedNameStyle,
} from "./nameStyle.ts";

const FULL: NameStyle = { colour: "#ff0000", font: "Serif", effect: "Glow" };
const ALL_PERKS =
  UserPerks.NameColour | UserPerks.NameFont | UserPerks.NameEffect;

test("undefined perks trusts the server-filtered style as-is", () => {
  assert.equal(permittedNameStyle(FULL), FULL);
  assert.equal(permittedNameStyle(FULL, undefined), FULL);
  assert.deepEqual(permittedNameStyle(FULL), {
    colour: "#ff0000",
    font: "Serif",
    effect: "Glow",
  });
});

test("another user's perks (always 0) never gate their style", () => {
  const other = { perks: 0, nameStyle: FULL };
  // Render paths pass no perks argument, so the 0 on the object is ignored.
  assert.deepEqual(permittedNameStyle(other.nameStyle), FULL);
  assert.equal(
    nameStyleClass(other.nameStyle, undefined, true),
    "sloga-name-font-serif sloga-name-fx-glow",
  );
});

test("a perk bitfield drops each part whose bit is missing", () => {
  assert.deepEqual(permittedNameStyle(FULL, 0), {});
  assert.deepEqual(permittedNameStyle(FULL, UserPerks.NameColour), {
    colour: "#ff0000",
  });
  assert.deepEqual(permittedNameStyle(FULL, UserPerks.NameFont), {
    font: "Serif",
  });
  assert.deepEqual(permittedNameStyle(FULL, UserPerks.NameEffect), {
    effect: "Glow",
  });
  assert.deepEqual(
    permittedNameStyle(FULL, UserPerks.NameFont | UserPerks.NameEffect),
    { font: "Serif", effect: "Glow" },
  );
  assert.deepEqual(permittedNameStyle(FULL, ALL_PERKS), FULL);
  // Unrelated bits grant nothing.
  assert.deepEqual(
    permittedNameStyle(FULL, UserPerks.UploadPerk | UserPerks.CustomBadge),
    {},
  );
});

test("a perk bitfield never invents absent parts", () => {
  assert.deepEqual(permittedNameStyle({ font: "Mono" }, ALL_PERKS), {
    font: "Mono",
  });
  assert.equal(permittedNameStyle(undefined, ALL_PERKS), undefined);
});

test("class list for each font", () => {
  const expected = {
    Serif: "sloga-name-font-serif",
    Mono: "sloga-name-font-mono",
    Rounded: "sloga-name-font-rounded",
    Script: "sloga-name-font-script",
    Pixel: "sloga-name-font-pixel",
  } as const;
  for (const font of NAME_FONTS) {
    assert.equal(nameStyleClass({ font }, undefined, true), expected[font]);
    assert.equal(nameStyleClass({ font }, undefined, false), expected[font]);
  }
});

test("class list for each effect, animated and static", () => {
  const expected = {
    Shimmer: "sloga-name-fx-shimmer",
    Glow: "sloga-name-fx-glow",
    Rainbow: "sloga-name-fx-rainbow",
  } as const;
  for (const effect of NAME_EFFECTS) {
    assert.equal(nameStyleClass({ effect }, undefined, true), expected[effect]);
    assert.equal(
      nameStyleClass({ effect }, undefined, false),
      `${expected[effect]} sloga-name-fx-static`,
    );
  }
});

test("font and effect combine; color is never a class", () => {
  assert.equal(
    nameStyleClass(
      { colour: "#00ff00", font: "Pixel", effect: "Rainbow" },
      undefined,
      false,
    ),
    "sloga-name-font-pixel sloga-name-fx-rainbow sloga-name-fx-static",
  );
  assert.equal(nameStyleClass({ colour: "#00ff00" }, undefined, true), "");
});

test("perks passed to nameStyleClass filter the classes", () => {
  assert.equal(nameStyleClass(FULL, 0, true), "");
  assert.equal(
    nameStyleClass(FULL, UserPerks.NameFont, false),
    "sloga-name-font-serif",
  );
  assert.equal(
    nameStyleClass(FULL, UserPerks.NameEffect, false),
    "sloga-name-fx-glow sloga-name-fx-static",
  );
});

test("empty string for an undefined or empty style", () => {
  assert.equal(nameStyleClass(undefined, undefined, true), "");
  assert.equal(nameStyleClass(undefined, undefined, false), "");
  assert.equal(nameStyleClass({}, undefined, true), "");
  assert.equal(nameStyleClass({}, undefined, false), "");
});

test("unknown font and effect strings are ignored", () => {
  const unknown = {
    font: "Gothic",
    effect: "Sparkle",
  } as unknown as NameStyle;
  assert.equal(nameStyleClass(unknown, undefined, true), "");
  assert.equal(nameStyleClass(unknown, undefined, false), "");

  // Prototype keys must not resolve to anything either.
  const proto = {
    font: "toString",
    effect: "constructor",
  } as unknown as NameStyle;
  assert.equal(nameStyleClass(proto, undefined, false), "");

  // A known part still applies next to an unknown one.
  assert.equal(
    nameStyleClass(
      { font: "Mono", effect: "Sparkle" } as unknown as NameStyle,
      undefined,
      false,
    ),
    "sloga-name-font-mono",
  );
  assert.equal(
    nameStyleClass(
      { font: "Gothic", effect: "Glow" } as unknown as NameStyle,
      undefined,
      true,
    ),
    "sloga-name-fx-glow",
  );
});

test("font and effect lists are pinned", () => {
  assert.deepEqual(
    [...NAME_FONTS],
    ["Serif", "Mono", "Rounded", "Script", "Pixel"],
  );
  assert.deepEqual([...NAME_EFFECTS], ["Shimmer", "Glow", "Rainbow"]);
  assert.deepEqual(NAME_FONT_FAMILIES, {
    Serif: '"Playfair Display", serif',
    Mono: '"Space Mono", monospace',
    Rounded: '"Nunito", sans-serif',
    Script: '"Pacifico", cursive',
    Pixel: '"Press Start 2P", monospace',
  });
});

test("font loading and the stylesheet are no-ops without a document", async () => {
  assert.equal(typeof document, "undefined");
  for (const font of NAME_FONTS) {
    assert.equal(await loadNameFont(font), undefined);
  }
  assert.equal(await loadNameFont("Gothic" as unknown as NameFont), undefined);
  assert.doesNotThrow(() => ensureNameStyleSheet());
});

test("stylesheet is injected once with every class and keyframe", () => {
  const appended: { id: string; textContent: string }[] = [];
  const fake = {
    getElementById: (id: string) => appended.find((el) => el.id === id) ?? null,
    createElement: () => ({ id: "", textContent: "" }),
    head: {
      appendChild: (el: { id: string; textContent: string }) => {
        appended.push(el);
      },
    },
  };

  const global = globalThis as { document?: unknown };
  global.document = fake;
  try {
    ensureNameStyleSheet();
    ensureNameStyleSheet();
    // An effect-only style injects through nameStyleClass too, without
    // touching the font loader.
    nameStyleClass({ effect: "Shimmer" }, undefined, true);
  } finally {
    delete global.document;
  }

  assert.equal(appended.length, 1);
  const [sheet] = appended;
  assert.equal(sheet.id, "sloga-name-styles");
  const css = sheet.textContent;

  for (const cls of [
    "sloga-name-font-serif",
    "sloga-name-font-mono",
    "sloga-name-font-rounded",
    "sloga-name-font-script",
    "sloga-name-font-pixel",
    "sloga-name-fx-shimmer",
    "sloga-name-fx-glow",
    "sloga-name-fx-rainbow",
    "sloga-name-fx-static",
  ]) {
    assert.ok(css.includes(`.${cls}`), `missing .${cls}`);
  }
  for (const frames of [
    "sloga-name-shimmer",
    "sloga-name-glow",
    "sloga-name-rainbow",
  ]) {
    assert.ok(css.includes(`@keyframes ${frames}`), `missing ${frames}`);
  }
  for (const family of Object.values(NAME_FONT_FAMILIES)) {
    assert.ok(css.includes(`font-family: ${family};`), `missing ${family}`);
  }
  assert.match(css, /\.sloga-name-font-pixel \{[^}]*font-size: 0\.8em;/);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[^@]*animation: none !important;/,
  );
  assert.match(css, /\.sloga-name-fx-static[^{]*\{\s*animation: none/);
  assert.ok(!css.includes("url("), "the sheet must not reference url()");
});

/** Inject the sheet into a fresh fake document and return its text. */
function injectedSheet(): string {
  let text = "";
  const fake = {
    getElementById: () => null,
    createElement: () => ({ id: "", textContent: "" }),
    head: {
      appendChild: (el: { textContent: string }) => {
        text = el.textContent;
      },
    },
  };

  const global = globalThis as { document?: unknown };
  global.document = fake;
  try {
    ensureNameStyleSheet();
  } finally {
    delete global.document;
  }
  return text;
}

test("gradient colors get a glow and shimmer that work over clipped text", () => {
  const css = injectedSheet();

  // Glow: a text shadow would paint over gradient glyphs, so a gradient
  // span swaps it for a pulsing drop-shadow filter.
  const glow = css.match(
    /\.sloga-name-fx-glow \[style\*="gradient"\] \{([^}]*)\}/,
  );
  assert.ok(glow, "missing the glow rule for gradient colors");
  assert.match(glow[1], /text-shadow: none !important;/);
  assert.match(glow[1], /filter: drop-shadow\(0 0 4px currentColor\);/);
  assert.match(glow[1], /animation: sloga-name-glow-filter /);
  assert.match(
    css,
    /@keyframes sloga-name-glow-filter \{[^@]*filter: drop-shadow\(/,
  );
  // Still frames stop the pulse but keep the drop-shadow.
  assert.doesNotMatch(css, /filter:\s*none/);

  // Shimmer: the inline background shorthand resets the size, which has to
  // be widened again for the gradient to sweep.
  assert.match(
    css,
    /\.sloga-name-fx-shimmer \[style\*="gradient"\] \{\s*background-size: 250% 100% !important;/,
  );
  // Still frames show the whole gradient again.
  assert.match(
    css,
    /\.sloga-name-fx-shimmer\.sloga-name-fx-static \[style\*="gradient"\] \{\s*background-size: auto !important;/,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.sloga-name-fx-shimmer \[style\*="gradient"\] \{\s*background-size: auto !important;/,
  );
});
