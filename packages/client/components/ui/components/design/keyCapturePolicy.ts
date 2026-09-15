/**
 * The pure half of `./KeyCapture.tsx`: the chord→{@link Binding} reduction,
 * the cancel/clear/refusal decisions, and the display formatter.
 *
 * # Why `…Policy`, and not `keyCapture.ts`
 *
 * A leaf named `keyCapture.ts` would differ from its own component,
 * `KeyCapture.tsx`, only by case. That resolves fine on this Linux worktree
 * and is ambiguous on the case-insensitive filesystems this repo also builds
 * on (the Windows dev box, the macOS shell builder), where `./keyCapture`
 * could bind to the `.tsx`. `…Policy` follows the existing
 * `features/voice/minigame/minigamePolicy.ts` ← `MinigameChip.tsx` pairing,
 * which is the same component/pure-leaf split under a name that cannot
 * collide.
 *
 * # Why this is a separate module from the component
 *
 * `node --test` cannot load a `.tsx` at all — Node's type-stripping handles
 * `.ts`/`.mts`/`.cts` and throws `ERR_UNKNOWN_FILE_EXTENSION` on `.tsx`,
 * because stripping types is not the same as transforming JSX. So logic that
 * lives in the component file is logic that cannot be unit-tested. Every
 * `*.test.ts` in this package imports a pure `.ts` leaf for exactly this
 * reason (`../../rtc/transcription/transcriptExport.ts`,
 * `../../state/stores/voiceOverlay.ts`, and the sibling
 * `./minigamePolicy.ts` next door in `features/voice/minigame`, which a
 * `.tsx` chip imports the same way this one is imported).
 *
 * The split is drawn so that **every decision** is here and the component
 * only owns listener lifetime and markup. A decision the component made
 * inline would be a decision with no test.
 */

// Relative specifier with an explicit `.ts`, not the `@revolt/keybinds` alias,
// for the reason spelled out in `../../../state/stores/Keybinds.ts`: the alias
// is a tsconfig `paths` / vite entry that `node --test` does not resolve, and
// this module is unit-tested.
//
// 🔴 The type-only names carry inline `type` markers because Node's
// type-stripping does not elide import specifiers: left unmarked, `Binding`
// would survive into the emitted import list and fail at runtime as a missing
// export. Same note as `Keybinds.ts`.
import {
  type Binding,
  type BindingConflict,
  type KeyLikeEvent,
  findBindingConflict,
} from "../../../keybinds/globalKeybinds.ts";

/* ------------------------------------------------------------------------ *
 * 1. The event shape capture needs
 * ------------------------------------------------------------------------ */

/**
 * What {@link decideCapture} reads off a keydown.
 *
 * Widens the contract's {@link KeyLikeEvent} by the two fields a *capture*
 * needs and a *match* does not:
 *
 * - `metaKey`, because {@link Binding} has no `meta` bit (the pinned
 *   `keybinds_arm` payload has no field for one). A chord held with Meta is
 *   therefore not representable, and capture has to notice rather than drop
 *   the bit — see {@link decideCapture}.
 * - `repeat`, because capture listens on a focused DOM `keydown`, which
 *   auto-repeats. The native hook collapses repeat twice before it ever emits
 *   an edge, so the matching predicates never see one; a DOM listener does.
 *
 * Duck-typed rather than taking `KeyboardEvent`, matching `KeyLikeEvent`'s own
 * rationale: it keeps this callable from `node --test` with a plain object.
 */
export type CaptureKeyEvent = KeyLikeEvent & {
  metaKey: boolean;
  repeat: boolean;
};

/* ------------------------------------------------------------------------ *
 * 2. Key classification
 * ------------------------------------------------------------------------ */

/**
 * Physical keys that are only ever part of a chord, never its subject.
 *
 * 🔴 This set is the fix for defect 2 of the one-off in
 * `settings/user/voice/VoiceProcessingOptions.tsx`: that capture bound the
 * first `keydown` it saw, so pressing Shift+F13 stored `"ShiftLeft"` — the
 * modifier, not the key. Skipping these is what lets a chord accumulate until
 * a real key lands.
 *
 * `MetaLeft`/`MetaRight` are listed even though {@link Binding} cannot express
 * Meta: they must not be captured *as* the bound key either, and the Meta-held
 * refusal in {@link decideCapture} covers the other half.
 *
 * `CapsLock` is deliberately absent — it is a normal key to the native scan
 * table and binding it is legal.
 */
export const MODIFIER_CODES: readonly string[] = [
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
];

/**
 * Cancels capture without binding, at any modifier state.
 *
 * Modifiers are deliberately not consulted. Escape is unbindable either way —
 * both bare `Escape` and `Shift+Escape` are in-app default sequences
 * (`IN_APP_DEFAULT_SEQUENCES`), so every Escape chord would be reported as a
 * conflict — which means there is no combination where swallowing Escape as a
 * cancel costs the user a binding they could have had.
 */
export const CANCEL_CODE = "Escape";

/**
 * Clears the binding, at any modifier state. Same reasoning as
 * {@link CANCEL_CODE}: these are the control gestures, so they are not
 * bindable, so no modifier state needs to be distinguished.
 */
export const CLEAR_CODES: readonly string[] = ["Delete", "Backspace"];

/* ------------------------------------------------------------------------ *
 * 3. The capture decision
 * ------------------------------------------------------------------------ */

/**
 * What the component should do about one keydown seen while listening.
 *
 * `ignore` is the only non-terminal outcome: capture stays armed and the user
 * keeps building the chord. Every other kind ends the capture.
 */
export type CaptureDecision =
  /** Not a chord yet (or not capturable). Stay listening. */
  | { kind: "ignore"; reason: "repeat" | "modifier-only" | "meta-held" }
  /** Escape. End capture, change nothing. */
  | { kind: "cancel" }
  /** Delete/Backspace. End capture, unbind. */
  | { kind: "clear" }
  /**
   * A usable chord. `conflict` is non-null for a soft collision the UI should
   * warn about but still accept — see {@link isHardConflict}.
   */
  | { kind: "commit"; binding: Binding; conflict: BindingConflict | null }
  /** A chord that provably cannot work. End capture, bind nothing. */
  | { kind: "refuse"; binding: Binding; conflict: BindingConflict };

/**
 * Should a conflict block the binding, or only warn about it?
 *
 * Straight off `BindingConflict`'s own doc: `"reserved"` and `"push-to-talk"`
 * are hard refusals because the binding provably cannot work as the user
 * expects, while `"in-app"` is "a genuine collision the UI may present as a
 * warning rather than a block". Blocking an in-app collision would refuse
 * chords the user is entitled to — the in-app registry is focused-only, and a
 * global-tier binding shadowing it is a choice, not an error.
 */
export function isHardConflict(conflict: BindingConflict): boolean {
  return conflict.kind === "reserved" || conflict.kind === "push-to-talk";
}

/**
 * Reduce one keydown to a decision. The whole policy of the widget.
 *
 * @param event the keydown, duck-typed
 * @param pushToTalkKey the caller's current `voice.pushToTalkKey`, or
 * `undefined` when push-to-talk is off. Threaded through to
 * `findBindingConflict` rather than read here — this module must not reach
 * `@revolt/state`, and the widget must not either.
 *
 * Check order is load-bearing:
 *
 * 1. **`repeat` first.** A held key would otherwise re-decide ~20×/s. It also
 *    closes a concrete hole: activating the trigger with the keyboard fires
 *    `keydown`→`click`, so a user who holds Enter to press the button has the
 *    listener installed *underneath their still-held Enter*, and the next
 *    repeat would capture Enter as the binding.
 * 2. **Cancel and clear before anything else**, so they cannot be captured.
 * 3. **Modifier-only**, so the chord can accumulate.
 * 4. **Meta held.** `Binding` has no `meta` bit, so `Win+KeyM` could only be
 *    stored as bare `KeyM` — a binding that fires on a chord the user never
 *    chose, and that shadows plain M. Dropping the bit silently is the
 *    unacceptable option, so the press is ignored and capture stays armed:
 *    the user releases Meta and presses again, which is the recovery that
 *    needs no new UI copy. 🔴 Not a `refuse` — refusing would end the capture
 *    and report a `BindingConflict`, and Meta is not one of that type's three
 *    kinds; inventing a fourth is a change to the pinned contract file.
 */
export function decideCapture(
  event: CaptureKeyEvent,
  pushToTalkKey?: string,
): CaptureDecision {
  if (event.repeat) return { kind: "ignore", reason: "repeat" };

  if (event.code === CANCEL_CODE) return { kind: "cancel" };
  if (CLEAR_CODES.includes(event.code)) return { kind: "clear" };

  if (MODIFIER_CODES.includes(event.code)) {
    return { kind: "ignore", reason: "modifier-only" };
  }

  if (event.metaKey) return { kind: "ignore", reason: "meta-held" };

  const binding: Binding = {
    code: event.code,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
    alt: event.altKey,
  };

  // `findBindingConflict` already runs `isReservedCombo` as its first and
  // highest-severity test, so calling that predicate separately here would be
  // a second, redundant comparison that could only drift from it. The reserved
  // combo arrives as `{ kind: "reserved" }`, which `isHardConflict` refuses.
  //
  // 🔴 This refusal is a cheap early check, NOT a guarantee. `isReservedCombo`
  // is documented as a deliberate *subset* of the native arm-side refusal: it
  // tests the physical `KeyQ` position, while native also refuses the key
  // LABELLED Q under the active layout, which is `KeyA` on AZERTY and is not
  // computable in the renderer. So a reserved chord can still pass this and
  // come back in `KeybindsArmResult.refused`. The caller owes that row an
  // unbindable state; this widget cannot promise one.
  const conflict = findBindingConflict(binding, pushToTalkKey);

  if (conflict !== null && isHardConflict(conflict)) {
    return { kind: "refuse", binding, conflict };
  }

  return { kind: "commit", binding, conflict };
}

/* ------------------------------------------------------------------------ *
 * 4. Display
 * ------------------------------------------------------------------------ */

/**
 * Keycap legends for the physical keys whose `code` is not already readable.
 *
 * TODO(i18n): these are untranslated, and deliberately so — see the note at
 * the bottom of this file. They are keycap legends and glyphs, not prose.
 *
 * Arrows are glyphs, which is the correction to defect 5 of the one-off
 * formatter: it wrote
 * `.replace("Arrow", "↑↓←→".includes(code) ? "" : "Arrow ")`, testing whether
 * the *whole* code string (`"ArrowUp"`) appeared inside `"↑↓←→"`. That is
 * always false, so the arrow branch was dead and every arrow rendered as
 * "Arrow Up". (Its adjacent `.replace("Space", "Space")` was a no-op, and the
 * bare `.replace("Key", "")` would also have mangled any code merely
 * *containing* "Key".) The fix is a lookup plus anchored patterns, not a chain
 * of substring replacements.
 */
const NAMED_KEY_LEGENDS: Readonly<Record<string, string>> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",

  Escape: "Esc",
  Enter: "Enter",
  Space: "Space",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Del",
  Insert: "Ins",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  CapsLock: "Caps",
  PrintScreen: "PrtSc",
  ScrollLock: "ScrLk",
  Pause: "Pause",
  NumLock: "NumLk",
  ContextMenu: "Menu",

  // Punctuation renders as the glyph it produces on a US layout. Wrong on
  // other layouts — but so is every alternative, because `code` names a
  // physical position and the legend on that key is layout-dependent. A glyph
  // is at least what the majority of users see printed on the key, and the
  // honest alternative ("Semicolon") is not more correct, only longer.
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  IntlBackslash: "\\",
};

/** Numpad suffixes whose bare form would read wrong. */
const NUMPAD_LEGENDS: Readonly<Record<string, string>> = {
  Add: "+",
  Subtract: "-",
  Multiply: "*",
  Divide: "/",
  Decimal: ".",
  Comma: ",",
  Equal: "=",
  Enter: "Enter",
};

/** Modifier legends, in the order {@link formatBinding} emits them. */
const CTRL_LEGEND = "Ctrl";
const SHIFT_LEGEND = "Shift";
const ALT_LEGEND = "Alt";

/** Joins the parts of a chord. */
export const CHORD_SEPARATOR = " + ";

/**
 * Render one `KeyboardEvent.code` as a keycap legend.
 *
 * Patterns are **anchored**, so a code is either recognized exactly or passed
 * through untouched. Passing an unknown code through is the right failure: the
 * raw `code` is ugly but true, whereas a partial substring rewrite produces
 * something that looks like a legend and names the wrong key.
 */
export function formatKeyCode(code: string): string {
  const named = NAMED_KEY_LEGENDS[code];
  if (named !== undefined) return named;

  // "KeyM" → "M". Anchored, so "NumpadKey"-shaped codes cannot half-match.
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];

  // "Digit1" → "1".
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];

  // "F1".."F24" are already their own legend.
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;

  // "Numpad1" → "Num 1", "NumpadEnter" → "Num Enter".
  const numpad = /^Numpad(.+)$/.exec(code);
  if (numpad) {
    const suffix = numpad[1];
    return `Num ${NUMPAD_LEGENDS[suffix] ?? suffix}`;
  }

  return code;
}

/**
 * Render a whole chord, e.g. `"Ctrl + Shift + M"`.
 *
 * Modifier order is Ctrl, Shift, Alt — matching both {@link Binding}'s field
 * order and the way the contract file writes the reserved combo
 * ("Ctrl+Shift+Alt+Q"), so a chord the user reads here matches the chord the
 * docs name.
 */
export function formatBinding(binding: Binding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push(CTRL_LEGEND);
  if (binding.shift) parts.push(SHIFT_LEGEND);
  if (binding.alt) parts.push(ALT_LEGEND);
  parts.push(formatKeyCode(binding.code));
  return parts.join(CHORD_SEPARATOR);
}

/*
 * TODO(i18n): the legends above ("Ctrl", "Shift", "Alt", "Esc", "Space",
 * "Num", …) are the only user-visible strings this widget produces, and they
 * are not wrapped in a lingui macro.
 *
 * This is deliberate and it is called out rather than hidden. This repo's
 * lingui `extract` is broken and the catalogs are hand-maintained, so a new
 * msgid invented here would be a msgid no catalog has. Every other string the
 * widget shows is taken from the caller as a prop (`KeyCaptureCopy`) for that
 * reason. These stayed behind because they are *keycap legends* — the text
 * physically printed on the key — which this class of UI conventionally does
 * not translate, and because the glyph forms (↑ ` [ /) need no translation at
 * all.
 *
 * If a later lane decides the modifier legends should be localized, they are
 * the four constants above and `NAMED_KEY_LEGENDS`; they must become props or
 * take real msgids at that point, not be macro-wrapped in place.
 */
