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
 * 2b. Typing keys — the honest replacement for the CHAT_FOCUS_COMPOSITION gap
 * ------------------------------------------------------------------------ */

/**
 * `KeyA`..`KeyZ`, derived rather than spelled out.
 *
 * The 26 entries are mechanical and a hand-written list of them is a list with
 * 26 chances to typo one — the kind of defect that produces a set which is
 * *almost* right and whose one missing member is a key that ships with no
 * warning. The tables in section 4 are written out because each entry carries
 * an independent decision (which glyph); these carry none.
 */
const LETTER_CODES: readonly string[] = Array.from(
  { length: 26 },
  (_, i) => `Key${String.fromCharCode("A".charCodeAt(0) + i)}`,
);

/** `Digit0`..`Digit9`. Derived for the same reason as {@link LETTER_CODES}. */
const DIGIT_CODES: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => `Digit${i}`,
);

/**
 * The punctuation positions of the main block, on a US layout.
 *
 * These twelve are also the twelve *punctuation* entries
 * {@link NAMED_KEY_LEGENDS} renders as a one-character glyph, and the test file
 * asserts that overlap in both directions. But the overlap is a consequence,
 * not the derivation.
 *
 * 🔴 That table is **not** a printability oracle, and an earlier version of
 * this comment claimed it was — that "its membership is already the answer to
 * which physical positions produce a printable character". It is a *keycap
 * legend* table, and it holds **sixteen** single-character legends: the twelve
 * below plus the four arrow glyphs (`ArrowUp: "↑"` and its three siblings).
 * Reading "has a one-character legend" as "types a character" is precisely the
 * reasoning that produced the arrow hole {@link COMPOSER_MOTION_CODES} exists
 * to close: `↑` is a glyph printed on a keycap that enters no text at all.
 * Membership here is therefore decided per position, on the one question that
 * matters — does pressing it put a character into a focused composer.
 *
 * Layout caveat: `code` names a position, and which glyph (or whether any) it
 * produces depends on the active layout. A position that types nothing on some
 * layout only costs the user a warning they did not need; the reverse — a
 * position that types and carries no warning — is the failure worth avoiding,
 * so the set errs toward inclusion.
 */
const PUNCTUATION_CODES: readonly string[] = [
  "Backquote",
  "Minus",
  "Equal",
  "BracketLeft",
  "BracketRight",
  "Backslash",
  "Semicolon",
  "Quote",
  "Comma",
  "Period",
  "Slash",
  "IntlBackslash",
];

/**
 * Main-block positions that type and that a US keyboard does not have.
 *
 * `IntlBackslash` — the extra key beside left Shift on an ISO board — is
 * already in {@link PUNCTUATION_CODES}, because it has a legend entry and came
 * along with the glyph-table reading corrected above. These two have no legend
 * entry, and that is the only reason they were missed:
 *
 * - `IntlRo` is the ABNT2 (Brazilian) and JIS position that types `/`.
 * - `IntlYen` is the JIS position that types `¥`, or `|` shifted.
 *
 * Both put a character into a focused composer, which is this set's whole test
 * for membership, so the "errs toward inclusion" rule in
 * {@link PUNCTUATION_CODES} decides them the same way it decided the twelve.
 * Neither string appeared anywhere in this repo before this group, so the
 * omission was a gap in coverage rather than a decision taken elsewhere — and
 * Sloga runs a Brazilian media node, which makes ABNT2 a real population and
 * not a hypothetical one.
 *
 * 🔴 No legend is added for either, deliberately. `formatKeyCode` has no entry
 * for them, so they render as the raw `code` — ugly but true, which is that
 * function's documented failure mode for a position it does not recognize.
 * Inventing `/` and `¥` legends would change `formatKeyCode`'s behavior, which
 * is pinned, and would assert an active layout this module refuses to guess.
 */
const INTL_TEXT_CODES: readonly string[] = ["IntlRo", "IntlYen"];

/**
 * The numpad positions that produce text with NumLock **on**.
 *
 * With NumLock off these same positions report navigation (`Numpad8` arrives
 * as `key: "ArrowUp"` — the case `IN_APP_COMPARABLE_CODES` cites for keeping
 * the numpad out of its one-to-one map). A binding is stored as a `code`, so
 * it cannot know which of the two a future press will be, and NumLock is a
 * per-machine state the renderer does not track. Included because the
 * NumLock-on reading is the one that types.
 *
 * `NumpadEnter` is not here: it belongs to the {@link ALWAYS_PRESSED_CODES}
 * group, whose justification is different.
 */
const NUMPAD_TEXT_CODES: readonly string[] = [
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  "NumpadDecimal",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadComma",
  "NumpadEqual",
];

/**
 * 🔴 The deliberate widening past "printable": `Enter`, `NumpadEnter`, `Tab`.
 *
 * None of these types a character, so a set named for printable keys would
 * exclude all three. They are in anyway, and the reason is that the warning is
 * about *typing*, not about text: these are the keys a user's hands are on
 * constantly while composing. Bare `Enter` **sends** the message in the
 * composer and bare `Tab` moves focus out of it, so a global binding on either
 * fires in the middle of ordinary chat — which is exactly the failure the
 * warning exists to name.
 *
 * `Enter` is the sharpest case and the reason this group is not optional. It is
 * present in `IN_APP_COMPARABLE_CODES`, so `findBindingConflict` genuinely
 * *does* compare it against the in-app registry — and bare `Enter` is not an
 * entry in `IN_APP_DEFAULT_SEQUENCES`, so that comparison returns `null`. A
 * bare `Enter` binding therefore draws a checked, confident "no conflict"
 * today. Without this group it would ship with no caution of any kind.
 *
 * `NumpadEnter` rides along because it activates the composer the same way
 * (`key: "Enter"`) while being a distinct `code` that the in-app path cannot
 * reach at all.
 */
const ALWAYS_PRESSED_CODES: readonly string[] = ["Enter", "NumpadEnter", "Tab"];

/**
 * 🔴 The four bare arrows.
 *
 * # Why a group of its own, rather than three more entries in
 * {@link ALWAYS_PRESSED_CODES}
 *
 * That group's justification is "types nothing, but the hands are on it while
 * composing", and its sharpest case is `Enter`. The arrows qualify under that
 * sentence too, but they were *excluded* for a specific stated reason, and a
 * silent move into an existing list would leave that reason unaddressed. The
 * correction is the rationale, so it gets its own place to live.
 *
 * # Why they were excluded, and why that reason was false
 *
 * The exclusion list below used to read: "Arrows are also where the real in-app
 * conflicts live, so they are already covered honestly by
 * `findBindingConflict`." Measured against the real functions, that is false —
 * and false *by construction*, not by accident:
 *
 * - {@link isTypingChord} only ever evaluates **modifier-less** chords. It
 *   returns `false` the instant any of ctrl/shift/alt is set, before it reads
 *   the code at all.
 * - Every arrow entry in `IN_APP_DEFAULT_SEQUENCES` carries a modifier:
 *   `Alt+ArrowDown`, `Ctrl+Alt+ArrowUp`, `Ctrl+Alt+ArrowDown`. `ArrowLeft` and
 *   `ArrowRight` appear in that list not at all. The only modifier-less entry
 *   in the whole list is bare `Escape`, which is unbindable anyway.
 * - `findBindingConflict` matches with `bindingsEqual`, on the **full** chord,
 *   modifiers included.
 *
 * So the in-app conflict path and this predicate have **disjoint domains**
 * where the arrows are concerned: no modified sequence can ever match a chord
 * this predicate looks at, which makes "already covered by
 * `findBindingConflict`" not merely optimistic but unreachable. Confirmed by
 * driving the functions: bare `ArrowUp`, `ArrowDown`, `ArrowLeft` and
 * `ArrowRight` each come back `conflict: null`. A bare arrow binding shipped
 * with **no caution of any kind** — no conflict note, and no typing warning.
 *
 * That is verbatim the argument {@link ALWAYS_PRESSED_CODES} uses to *include*
 * `Enter`, and the arrows are the same shape of case, only worse: they are in
 * `IN_APP_COMPARABLE_CODES`, so the `null` presents to the UI as a checked,
 * confident "no conflict" — while the chords actually checked are never the
 * chord the user bound.
 *
 * # And the collision is concrete
 *
 * Bare `ArrowUp` on an **empty** composer runs edit-last-message: the
 * `key: "ArrowUp"` keymap in `../features/texteditor/TextEditor2.tsx` (its
 * `arrowUpKeymap`) calls `onPreviousContext()` whenever the document is empty.
 * The arrows also drive selection in every autocomplete popout. Those are keys
 * a user's hands are on while composing, which is {@link TYPING_CODES}' actual
 * test for membership.
 */
const COMPOSER_MOTION_CODES: readonly string[] = [
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

/**
 * Physical keys a user presses while typing into Sloga.
 *
 * # What this set is for
 *
 * The DOM transport for global keybinds has **no editable-target filter**, and
 * adding one is not an option: the native transport has no DOM to consult, so a
 * renderer-side filter would make the two transports disagree about whether a
 * binding fired. Binding bare `KeyM` therefore genuinely means that typing "m"
 * in the composer mutes the user. That is allowed — the pinned decision is that
 * capture accepts such a binding and the settings row **warns** about it — and
 * this set is how a caller recognizes one.
 *
 * # Why it is not `findBindingConflict`'s job
 *
 * `globalKeybinds.ts` documents the hole: the in-app registry's
 * `CHAT_FOCUS_COMPOSITION` is bound to the regex `/^[^ ]$/` — any single
 * non-space character, unmodified — which **cannot be expressed** in `Binding`
 * space, because no code in `IN_APP_COMPARABLE_CODES` yields a single-character
 * `key` and adding letter codes to that map would require the layout guess it
 * refuses. So `IN_APP_DEFAULT_SEQUENCES` omits it and the `"in-app"` conflict
 * path can never warn about a printable key. This predicate is the honest
 * replacement for that gap, sitting beside the conflict machinery rather than
 * inside it: a `code`-space membership test claims only what it can check, and
 * makes no assertion about which character the key types.
 *
 * Note that the regex excludes space, so `Space` is doubly uncovered by the
 * in-app path — hence its presence here.
 *
 * # Shape
 *
 * A `ReadonlySet` rather than the `readonly string[]` used by
 * {@link MODIFIER_CODES} and {@link CLEAR_CODES}. Those hold 8 and 2 entries
 * and are scanned once per keydown; this holds 75 and is read per rendered
 * row, where a linear scan is the wrong default. It stays iterable, which the
 * consistency assertions in the test file depend on.
 *
 * # What is deliberately NOT a member
 *
 * - `Escape`, `Delete`, `Backspace` — {@link CANCEL_CODE} and
 *   {@link CLEAR_CODES}. They are the control gestures of the capture widget,
 *   so no `Binding` can ever hold them and a member here would be unreachable.
 * - Everything in {@link MODIFIER_CODES} — never the subject of a chord, and
 *   never reachable as `binding.code`.
 * - `F1`..`F24` — not typed into a composer, which is what makes them the
 *   keys this widget's own history steers users toward (the one-off it replaces
 *   captured F13).
 * - The navigation and lock cluster **minus the arrows**: `Home`, `End`,
 *   `PageUp`, `PageDown`, `Insert`, `CapsLock`, `NumLock`, `ScrollLock`,
 *   `PrintScreen`, `Pause`, `ContextMenu`. These move a caret or flip a lock
 *   rather than entering text, and — unlike the arrows — none of them is wired
 *   to a composer action anywhere in this app.
 *
 *   🔴 The four arrows are **members**, through
 *   {@link COMPOSER_MOTION_CODES}. They were excluded here on the claim that
 *   the real in-app arrow conflicts already covered them through
 *   `findBindingConflict`. That claim was measurably false: every arrow entry
 *   in `IN_APP_DEFAULT_SEQUENCES` is a **modified** chord, `bindingsEqual`
 *   compares modifiers, and this predicate only ever sees modifier-less
 *   chords — so that coverage could never intersect this one. The two domains
 *   are disjoint, and bare arrows drew no conflict and no warning. The
 *   measurement is in that group's comment.
 *
 * The exclusions are asserted against this set programmatically in
 * `./keyCapturePolicy.test.ts`; that assertion is what stops a later edit
 * re-adding one.
 */
export const TYPING_CODES: ReadonlySet<string> = new Set<string>([
  ...LETTER_CODES,
  ...DIGIT_CODES,
  ...PUNCTUATION_CODES,
  ...INTL_TEXT_CODES,
  // A focused composer takes a space. `CHAT_FOCUS_COMPOSITION`'s `/^[^ ]$/`
  // explicitly excludes space, so the in-app conflict path could not have
  // covered this one even if it were expressible.
  "Space",
  ...NUMPAD_TEXT_CODES,
  ...ALWAYS_PRESSED_CODES,
  ...COMPOSER_MOTION_CODES,
]);

/**
 * Will this binding also fire while the user is typing inside Sloga?
 *
 * `true` **only** for a chord with no modifier held whose key is in
 * {@link TYPING_CODES}. The caller's settings row is expected to warn on
 * `true`; nothing is refused, and {@link decideCapture} does not consult this
 * at all — see below.
 *
 * # 🔴 The modifier condition
 *
 * Any one of `ctrl` / `shift` / `alt` makes this `false`. `Ctrl+KeyM` is
 * `false`; bare `KeyM` is `true`. `Shift+KeyM` is also `false`, and that is the
 * specified behavior rather than an oversight: Shift+M does type "M", but the
 * pinned decision is about **modifier-less** bindings, and a shifted chord is
 * not one the composer produces by accident the way a bare letter is. The
 * predicate is exactly as specified; widening it to Shift is a separate
 * decision and not one this module may take on its own.
 *
 * Meta is not consulted because {@link Binding} has no `meta` bit — a
 * Meta-held chord is not representable and `decideCapture` ignores the press
 * rather than storing one.
 *
 * # 🔴 Why a predicate over a stored `Binding`, and not a `CaptureDecision`
 * field
 *
 * The warning is a property of the **stored binding**, not of the capture
 * event: a bare `KeyM` bound yesterday still fires while typing today, so a row
 * rendered after a reload — with no capture event anywhere in the past — owes
 * the same warning. Deriving it in the row from the store is what makes that
 * work. Returning it from {@link decideCapture} would additionally be a change
 * to the {@link CaptureDecision} shape, which is pinned.
 *
 * This module produces no prose for the warning; all copy belongs to the
 * caller, for the reason in the `TODO(i18n)` note at the bottom of this file.
 */
export function isTypingChord(binding: Binding): boolean {
  if (binding.ctrl || binding.shift || binding.alt) return false;
  return TYPING_CODES.has(binding.code);
}

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
