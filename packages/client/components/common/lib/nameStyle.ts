/**
 * Personal name styles: color, font and animated effect.
 *
 * The server serializes only the parts of a user's `name_style` that their
 * perks allow, for every viewer, and `User.perks` is only real for the session
 * user (it is 0 for everyone else). Rendering therefore trusts the style it is
 * given and passes `perks === undefined`; only the owner's editor preview
 * passes a perk bitfield, to show what their current perks would allow.
 *
 * Fonts and effects are plain global classes from one injected stylesheet so
 * that any name site can apply them without a Panda recipe. Color is not a
 * class: callers hand `permittedNameStyle(...)?.colour` to ColouredText.
 *
 * No framework imports, and every `document` access is guarded, so the
 * module loads under node's native TypeScript type-stripping.
 */
import {
  type NameEffect,
  type NameFont,
  type NameStyle,
  UserPerks,
} from "stoat.js";

export const NAME_FONTS: readonly NameFont[] = [
  "Serif",
  "Mono",
  "Rounded",
  "Script",
  "Pixel",
];

export const NAME_EFFECTS: readonly NameEffect[] = [
  "Shimmer",
  "Glow",
  "Rainbow",
];

/** Full `font-family` stack for each name font, generic fallback last. */
export const NAME_FONT_FAMILIES: Record<NameFont, string> = {
  Serif: '"Playfair Display", serif',
  Mono: '"Space Mono", monospace',
  Rounded: '"Nunito", sans-serif',
  Script: '"Pacifico", cursive',
  Pixel: '"Press Start 2P", monospace',
};

const FONT_CLASSES: Record<NameFont, string> = {
  Serif: "sloga-name-font-serif",
  Mono: "sloga-name-font-mono",
  Rounded: "sloga-name-font-rounded",
  Script: "sloga-name-font-script",
  Pixel: "sloga-name-font-pixel",
};

const EFFECT_CLASSES: Record<NameEffect, string> = {
  Shimmer: "sloga-name-fx-shimmer",
  Glow: "sloga-name-fx-glow",
  Rainbow: "sloga-name-fx-rainbow",
};

const STATIC_CLASS = "sloga-name-fx-static";

const SHEET_ID = "sloga-name-styles";

/**
 * Weight each bundled font ships in; also what `document.fonts.load` asks for.
 */
const FONT_WEIGHTS: Record<NameFont, number> = {
  Serif: 700,
  Mono: 700,
  Rounded: 700,
  Script: 400,
  Pixel: 400,
};

// Server enums may grow ahead of this client, so membership is checked
// against the known lists rather than trusted (and never looked up on a
// plain object, where "toString" would resolve to a prototype method).
function isNameFont(value: unknown): value is NameFont {
  return NAME_FONTS.includes(value as NameFont);
}

function isNameEffect(value: unknown): value is NameEffect {
  return NAME_EFFECTS.includes(value as NameEffect);
}

/**
 * Style parts the given perk bits allow. `perks === undefined` trusts the
 * style as-is (the server already filtered it) — every render path passes
 * undefined; only the owner's editor preview passes a number.
 */
export function permittedNameStyle(
  style: NameStyle | undefined,
  perks?: number,
): NameStyle | undefined {
  if (!style) return undefined;
  if (perks === undefined) return style;

  const permitted: NameStyle = {};
  if (style.colour !== undefined && perks & UserPerks.NameColour) {
    permitted.colour = style.colour;
  }
  if (style.font !== undefined && perks & UserPerks.NameFont) {
    permitted.font = style.font;
  }
  if (style.effect !== undefined && perks & UserPerks.NameEffect) {
    permitted.effect = style.effect;
  }
  return permitted;
}

/**
 * Space-separated class list for the font and effect (color is NOT a class —
 * callers pass `permittedNameStyle(...)?.colour` to ColouredText). Returns ""
 * when nothing applies. `animate = false` gives the static variant of the
 * effect. Injects the stylesheet and starts loading the font when a class is
 * emitted.
 */
export function nameStyleClass(
  style: NameStyle | undefined,
  perks: number | undefined,
  animate: boolean,
): string {
  const permitted = permittedNameStyle(style, perks);
  const classes: string[] = [];

  const font = permitted?.font;
  if (isNameFont(font)) {
    classes.push(FONT_CLASSES[font]);
    void loadNameFont(font);
  }

  const effect = permitted?.effect;
  if (isNameEffect(effect)) {
    classes.push(EFFECT_CLASSES[effect]);
    if (!animate) classes.push(STATIC_CLASS);
  }

  if (classes.length) ensureNameStyleSheet();
  return classes.join(" ");
}

const fontLoads = new Map<NameFont, Promise<void>>();

async function importFontFace(font: NameFont): Promise<void> {
  // Literal specifiers so the bundler can split each font into its own chunk.
  switch (font) {
    case "Serif":
      await import("@fontsource/playfair-display/700.css");
      break;
    case "Mono":
      await import("@fontsource/space-mono/700.css");
      break;
    case "Rounded":
      await import("@fontsource/nunito/700.css");
      break;
    case "Script":
      await import("@fontsource/pacifico/400.css");
      break;
    case "Pixel":
      await import("@fontsource/press-start-2p/400.css");
      break;
    default:
      return;
  }

  // The @font-face rules only register the font; ask for the file itself so
  // the promise settles once the glyphs are actually usable.
  await document.fonts?.load(
    `${FONT_WEIGHTS[font]} 1em ${NAME_FONT_FAMILIES[font]}`,
  );
}

/**
 * Lazy-load the bundled font for a NameFont; idempotent; resolves when loaded,
 * never throws. A failed load is forgotten so a later call can retry it.
 */
export function loadNameFont(font: NameFont): Promise<void> {
  if (typeof document === "undefined" || !isNameFont(font)) {
    return Promise.resolve();
  }

  let pending = fontLoads.get(font);
  if (!pending) {
    pending = importFontFace(font).catch(() => {
      fontLoads.delete(font);
    });
    fontLoads.set(font, pending);
  }
  return pending;
}

const FONT_RULES = NAME_FONTS.map((font) => {
  const pixel = font === "Pixel" ? " font-size: 0.8em;" : "";
  return `.${FONT_CLASSES[font]} { font-family: ${NAME_FONT_FAMILIES[font]}; font-weight: ${FONT_WEIGHTS[font]};${pixel} }`;
}).join("\n");

// Effects cover descendants as well as the element: the color usually sits
// on an inner ColouredText span, so `currentColor` has to resolve there.
// Rainbow replaces the color fill outright, so inner backgrounds (gradient
// role colors) are cleared to let the rainbow show through.
//
// A gradient color is an inline `background` clipped to the text with a
// transparent fill. A text shadow paints over those glyphs, so Glow uses a
// drop-shadow filter there instead; it follows the painted text and takes the
// inherited text color, since the transparent fill leaves `color` alone. The
// inline shorthand also resets `background-size`, which Shimmer needs for the
// gradient to sweep; the still frames hand it back so the whole gradient shows.
const EFFECT_RULES = `
.sloga-name-fx-shimmer,
.sloga-name-fx-shimmer * {
  background-image: linear-gradient(110deg, currentColor 40%, #fff 50%, currentColor 60%);
  background-image: linear-gradient(110deg, currentColor 40%, color-mix(in srgb, currentColor 35%, #fff) 50%, currentColor 60%);
  background-size: 250% 100%;
  background-position: 60% 0;
  background-repeat: no-repeat;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: sloga-name-shimmer 3.5s ease-in-out infinite;
}

.sloga-name-fx-shimmer [style*="gradient"] {
  background-size: 250% 100% !important;
}

.sloga-name-fx-glow,
.sloga-name-fx-glow * {
  text-shadow: 0 0 6px currentColor;
  animation: sloga-name-glow 2.4s ease-in-out infinite;
}

.sloga-name-fx-glow [style*="gradient"] {
  text-shadow: none !important;
  filter: drop-shadow(0 0 4px currentColor);
  animation: sloga-name-glow-filter 2.4s ease-in-out infinite;
}

.sloga-name-fx-rainbow {
  background-image: linear-gradient(90deg, #ff5f6d, #ffc371, #47e891, #3ec5ff, #b36bff, #ff5f6d);
  background-size: 200% 100%;
  background-position: 0 0;
  background-repeat: repeat-x;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: sloga-name-rainbow 4s linear infinite;
}

.sloga-name-fx-rainbow * {
  background: none !important;
  -webkit-text-fill-color: transparent;
}

.sloga-name-fx-static,
.sloga-name-fx-static * {
  animation: none !important;
}

.sloga-name-fx-shimmer.sloga-name-fx-static [style*="gradient"] {
  background-size: auto !important;
}

@keyframes sloga-name-shimmer {
  0% { background-position: 100% 0; }
  70%, 100% { background-position: 0% 0; }
}

@keyframes sloga-name-glow {
  0%, 100% { text-shadow: 0 0 2px currentColor; }
  50% { text-shadow: 0 0 10px currentColor; }
}

@keyframes sloga-name-glow-filter {
  0%, 100% { filter: drop-shadow(0 0 2px currentColor); }
  50% { filter: drop-shadow(0 0 8px currentColor); }
}

@keyframes sloga-name-rainbow {
  from { background-position: 0% 0; }
  to { background-position: 200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .sloga-name-fx-shimmer,
  .sloga-name-fx-shimmer *,
  .sloga-name-fx-glow,
  .sloga-name-fx-glow *,
  .sloga-name-fx-rainbow {
    animation: none !important;
  }

  .sloga-name-fx-shimmer [style*="gradient"] {
    background-size: auto !important;
  }
}
`;

const SHEET = `${FONT_RULES}\n${EFFECT_RULES}`;

/**
 * Inject the name-style stylesheet once (id "sloga-name-styles"); no-op
 * without a document. The still frames come from the base declarations, which
 * is what shows once an animation is removed.
 */
export function ensureNameStyleSheet(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SHEET_ID)) return;

  const sheet = document.createElement("style");
  sheet.id = SHEET_ID;
  sheet.textContent = SHEET;
  document.head.appendChild(sheet);
}
