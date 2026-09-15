/**
 * Run with:
 *
 *     node --conditions=browser --test components/ui/components/design/keyCapturePolicy.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests — without it
 * Node resolves solid-js's server build and effect-based specs silently pass
 * against broken code. This file is pure and unaffected, but one invocation
 * should cover it and the reactive suites together.)
 *
 * These are the decisions behind the shared key-capture control. The failures
 * they exist to prevent are the five defects of the 14-line one-off this
 * widget replaces (`settings/user/voice/VoiceProcessingOptions.tsx`): a chord
 * that binds its own modifier, an Escape that binds "Escape" instead of
 * cancelling, no way to unbind, no conflict detection, and a formatter whose
 * arrow branch was unreachable.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Binding,
  RESERVED_COMBO,
} from "../../../keybinds/globalKeybinds.ts";

import {
  type CaptureDecision,
  type CaptureKeyEvent,
  type ConflictMode,
  CANCEL_CODE,
  CHORD_SEPARATOR,
  CLEAR_CODES,
  decideCapture,
  formatBinding,
  formatKeyCode,
  isHardConflict,
  isTypingChord,
  MODIFIER_CODES,
  // Path import only — deliberately not on the `design/index.ts` barrel. It is
  // here so the converse glyph assertion below quantifies over the real table.
  NAMED_KEY_LEGENDS,
  TYPING_CODES,
} from "./keyCapturePolicy.ts";

/** A keydown with nothing held. */
function press(
  code: string,
  held: Partial<Omit<CaptureKeyEvent, "code">> = {},
): CaptureKeyEvent {
  return {
    code,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    repeat: false,
    ...held,
  };
}

function binding(code: string, mods: Partial<Omit<Binding, "code">> = {}) {
  return { code, ctrl: false, shift: false, alt: false, ...mods };
}

/* ------------------------------------------------------------------ *
 * The chord reduction — defect 2
 * ------------------------------------------------------------------ */

describe("decideCapture — chord reduction", () => {
  it("reduces a bare key to a binding with no modifiers", () => {
    const decision = decideCapture(press("KeyM"));
    assert.deepEqual(decision, {
      kind: "commit",
      binding: binding("KeyM"),
      conflict: null,
    });
  });

  it("carries every held modifier onto the binding", () => {
    const decision = decideCapture(
      press("F13", { ctrlKey: true, shiftKey: true, altKey: true }),
    );
    assert.equal(decision.kind, "commit");
    assert.deepEqual(
      decision.kind === "commit" ? decision.binding : null,
      binding("F13", { ctrl: true, shift: true, alt: true }),
    );
  });

  it("keys on the PHYSICAL code, never a layout-dependent key", () => {
    // The whole point of `Binding.code`: an AZERTY user pressing the key
    // labelled A reports code "KeyQ", and that is what must be stored.
    const decision = decideCapture(press("KeyQ"));
    assert.equal(
      decision.kind === "commit" ? decision.binding.code : null,
      "KeyQ",
    );
  });

  /**
   * 🔴 Defect 2. The one-off bound the first keydown it saw, so Shift+F13
   * stored "ShiftLeft" — the modifier, not the key.
   */
  it("does not bind a modifier as the key", () => {
    for (const code of [
      "ShiftLeft",
      "ShiftRight",
      "ControlLeft",
      "ControlRight",
      "AltLeft",
      "AltRight",
      "MetaLeft",
      "MetaRight",
    ]) {
      assert.deepEqual(
        decideCapture(press(code, { shiftKey: true })),
        { kind: "ignore", reason: "modifier-only" },
        `${code} must not be capturable as the bound key`,
      );
    }
  });

  it("stays armed through the modifier then commits on the real key", () => {
    // The exact Shift+F13 sequence the one-off got wrong, in order.
    assert.equal(
      decideCapture(press("ShiftLeft", { shiftKey: true })).kind,
      "ignore",
    );
    const decision = decideCapture(press("F13", { shiftKey: true }));
    assert.deepEqual(decision, {
      kind: "commit",
      binding: binding("F13", { shift: true }),
      conflict: null,
    });
  });

  it("ignores auto-repeat", () => {
    assert.deepEqual(decideCapture(press("KeyM", { repeat: true })), {
      kind: "ignore",
      reason: "repeat",
    });
  });

  it("CapsLock is a normal, bindable key", () => {
    assert.equal(decideCapture(press("CapsLock")).kind, "commit");
  });

  /**
   * `Binding` has no `meta` bit (the pinned `keybinds_arm` payload has no
   * field for one), so Win+M could only be stored as bare "KeyM" — a binding
   * that fires on a chord the user never chose and shadows plain M.
   */
  it("refuses to silently drop a held Meta", () => {
    assert.deepEqual(decideCapture(press("KeyM", { metaKey: true })), {
      kind: "ignore",
      reason: "meta-held",
    });
  });
});

/* ------------------------------------------------------------------ *
 * Cancel and clear — defect 3
 * ------------------------------------------------------------------ */

describe("decideCapture — cancel and clear", () => {
  /** 🔴 Defect 3. The one-off bound "Escape". */
  it("Escape cancels and is never bound", () => {
    const decision = decideCapture(press("Escape"));
    assert.deepEqual(decision, { kind: "cancel" });
  });

  it("Escape cancels under every modifier state", () => {
    for (const held of [
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      /**
       * 🔴 `metaKey` is in this matrix deliberately, and it is the only thing
       * pinning a load-bearing order. The cancel/clear pair sits ABOVE the
       * Meta-held refusal in `decideCapture`; move the pair below it and
       * Meta+Escape returns `{ ignore, meta-held }` instead of `{ cancel }`.
       * Escape would then stop cancelling while Meta is held, leaving the
       * control armed and swallowing every keystroke in the window with no
       * exit the user can reach — the trigger is the only other way out and
       * it is behind the capture. Every other spec in this file passes under
       * that reordering.
       */
      { metaKey: true },
      { ctrlKey: true, shiftKey: true, altKey: true },
      { ctrlKey: true, shiftKey: true, altKey: true, metaKey: true },
    ]) {
      assert.deepEqual(
        decideCapture(press("Escape", held)),
        { kind: "cancel" },
        `Escape+${JSON.stringify(held)} must cancel, not bind`,
      );
    }
  });

  it("Delete and Backspace clear, and are never bound", () => {
    assert.deepEqual(decideCapture(press("Delete")), { kind: "clear" });
    assert.deepEqual(decideCapture(press("Backspace")), { kind: "clear" });
  });

  it("clear wins over a held modifier rather than binding a chord", () => {
    assert.deepEqual(decideCapture(press("Delete", { ctrlKey: true })), {
      kind: "clear",
    });

    // Meta too, for the same ordering reason spelled out in the Escape matrix
    // above: below the Meta-held refusal these would come back as
    // `{ ignore, meta-held }` and there would be no way to unbind while a
    // Meta key happened to be down.
    assert.deepEqual(decideCapture(press("Delete", { metaKey: true })), {
      kind: "clear",
    });
    assert.deepEqual(decideCapture(press("Backspace", { metaKey: true })), {
      kind: "clear",
    });
  });

  it("a cancel or clear never produces a binding", () => {
    for (const code of ["Escape", "Delete", "Backspace"]) {
      const decision = decideCapture(press(code));
      assert.ok(!("binding" in decision), `${code} must not carry a binding`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Refusal and conflict — defect 4
 * ------------------------------------------------------------------ */

describe("decideCapture — conflicts", () => {
  it("refuses the reserved panic combo", () => {
    const decision = decideCapture(
      press(RESERVED_COMBO.code, {
        ctrlKey: true,
        shiftKey: true,
        altKey: true,
      }),
    );
    assert.equal(decision.kind, "refuse");
    assert.deepEqual(decision.kind === "refuse" ? decision.conflict : null, {
      kind: "reserved",
    });
  });

  it("a partial chord on the reserved key is NOT reserved", () => {
    // `isReservedCombo` is an exact match on all three modifiers, so
    // Ctrl+Alt+Q arms normally. Refusing it would take a binding the user is
    // entitled to.
    const decision = decideCapture(
      press("KeyQ", { ctrlKey: true, altKey: true }),
    );
    assert.equal(decision.kind, "commit");
  });

  it("refuses the push-to-talk key, modifiers or not", () => {
    // Push-to-talk is matched by a bare `e.code` with no modifier comparison
    // in `@revolt/rtc/state.tsx`, so adding modifiers does not dodge it.
    for (const held of [{}, { ctrlKey: true }, { shiftKey: true }]) {
      const decision = decideCapture(press("Space", held), "Space");
      assert.equal(decision.kind, "refuse", "Space must collide with PTT");
      assert.deepEqual(decision.kind === "refuse" ? decision.conflict : null, {
        kind: "push-to-talk",
        code: "Space",
      });
    }
  });

  it("does not check push-to-talk when it is off", () => {
    // `undefined` means the key is configured but inert — nothing to collide
    // with.
    assert.equal(decideCapture(press("Space")).kind, "commit");
  });

  it("an in-app collision is accepted WITH a warning, not blocked", () => {
    // Alt+ArrowDown is NAVIGATION_CHANNEL_DOWN. `BindingConflict`'s doc calls
    // this a collision the UI may warn about rather than block.
    const decision = decideCapture(press("ArrowDown", { altKey: true }));
    assert.equal(decision.kind, "commit");
    assert.deepEqual(
      decision.kind === "commit" ? decision.conflict : undefined,
      { kind: "in-app", sequence: binding("ArrowDown", { alt: true }) },
    );
  });

  it("a free chord commits with no conflict", () => {
    const decision = decideCapture(press("ArrowUp", { altKey: true }));
    assert.deepEqual(decision, {
      kind: "commit",
      binding: binding("ArrowUp", { alt: true }),
      conflict: null,
    });
  });
});

/* ------------------------------------------------------------------ *
 * conflictMode — the push-to-talk-row defect
 * ------------------------------------------------------------------ */

/**
 * The defect: `decideCapture` always judged a chord with the chord-wise
 * `findBindingConflict`, but the push-to-talk row
 * (`settings/user/voice/VoiceProcessingOptions.tsx`) stores only
 * `binding.code` and its runtime matchers compare bare `e.code`. So bare
 * `ArrowDown` captured there drew no notice, yet `Alt+ArrowDown` (channel
 * navigation) opened the mic — while `Alt+ArrowDown` captured deliberately
 * warned and then stored the very same bare code. The verdict described a
 * chord the consumer threw away.
 *
 * The fix is a `conflictMode` parameter selecting the finder. The axis is the
 * consumer's runtime matcher, not the action kind: a code-storing consumer
 * passes `"code"`, everything else takes the `"chord"` default — and the
 * default path has to be exactly what it was, which the first spec pins.
 */
describe("decideCapture — conflictMode", () => {
  const MODES: readonly ConflictMode[] = ["chord", "code"];

  /**
   * 🔴 The default path is byte-identical to before the parameter existed:
   * omitting the argument and passing `"chord"` explicitly both give the
   * decisions every spec above already pins, for a chord-conflict candidate
   * and for a clean one. A mutant that inverted the modes fails here.
   */
  it('omitted and explicit "chord" give today\'s decisions', () => {
    const collision = press("ArrowDown", { altKey: true });
    const expectedCollision: CaptureDecision = {
      kind: "commit",
      binding: binding("ArrowDown", { alt: true }),
      conflict: {
        kind: "in-app",
        sequence: binding("ArrowDown", { alt: true }),
      },
    };
    assert.deepEqual(decideCapture(collision), expectedCollision);
    assert.deepEqual(decideCapture(collision, undefined), expectedCollision);
    assert.deepEqual(
      decideCapture(collision, undefined, "chord"),
      expectedCollision,
    );

    const clean = press("ArrowUp", { altKey: true });
    const expectedClean: CaptureDecision = {
      kind: "commit",
      binding: binding("ArrowUp", { alt: true }),
      conflict: null,
    };
    assert.deepEqual(decideCapture(clean), expectedClean);
    assert.deepEqual(decideCapture(clean, undefined, "chord"), expectedClean);
  });

  /**
   * 🔴 The defect itself, named. Bare `ArrowDown` is the chord the push-to-talk
   * row stores; chord-wise it matches no in-app sequence (every arrow entry
   * carries a modifier), and the `null` presents as a checked, confident "no
   * conflict". Code-wise it is the same physical key as `Alt+ArrowDown` —
   * NAVIGATION_CHANNEL_DOWN, the first `ArrowDown` entry in
   * `IN_APP_DEFAULT_SEQUENCES` — and that is the collision the row's runtime
   * actually has. A mutant that ignored the mode fails here.
   */
  it('"code" on bare ArrowDown reports the Alt+ArrowDown collision', () => {
    const chordWise = decideCapture(press("ArrowDown"), undefined, "chord");
    assert.deepEqual(chordWise, {
      kind: "commit",
      binding: binding("ArrowDown"),
      conflict: null,
    });

    const codeWise = decideCapture(press("ArrowDown"), undefined, "code");
    assert.deepEqual(codeWise, {
      kind: "commit",
      binding: binding("ArrowDown"),
      conflict: {
        kind: "in-app",
        sequence: binding("ArrowDown", { alt: true }),
      },
    });
  });

  /**
   * Reserved is evaluated on the EFFECTIVE bare binding in code mode: a
   * code-storing consumer throws the modifiers away, so what it will actually
   * match is bare `KeyQ`, which is not the panic combo. The stored binding is
   * still the full chord — the reduction does not change with the mode.
   */
  it('"code" does not refuse the reserved chord — bare KeyQ is not reserved', () => {
    const chord = press("KeyQ", {
      ctrlKey: true,
      shiftKey: true,
      altKey: true,
    });
    const chordWise = decideCapture(chord, undefined, "chord");
    assert.equal(chordWise.kind, "refuse");
    assert.deepEqual(chordWise.kind === "refuse" ? chordWise.conflict : null, {
      kind: "reserved",
    });

    assert.deepEqual(decideCapture(chord, undefined, "code"), {
      kind: "commit",
      binding: binding("KeyQ", { ctrl: true, shift: true, alt: true }),
      conflict: null,
    });
  });

  /** The push-to-talk arm is already code-wise, so the modes agree on it. */
  it("the push-to-talk hard refusal survives in both modes", () => {
    for (const mode of MODES) {
      const decision = decideCapture(
        press("Space", { ctrlKey: true }),
        "Space",
        mode,
      );
      assert.equal(decision.kind, "refuse", `${mode}: Ctrl+Space drives PTT`);
      assert.deepEqual(decision.kind === "refuse" ? decision.conflict : null, {
        kind: "push-to-talk",
        code: "Space",
      });
    }
  });

  /**
   * Everything decided before the finder runs cannot depend on the mode. The
   * table runs each case under both modes and under the omitted default.
   */
  it("repeat, cancel, clear, modifier-only and meta-held are mode-independent", () => {
    const cases: readonly [
      CaptureKeyEvent,
      string | undefined,
      CaptureDecision,
    ][] = [
      [
        press("KeyM", { repeat: true }),
        undefined,
        { kind: "ignore", reason: "repeat" },
      ],
      [press("Escape", { altKey: true }), undefined, { kind: "cancel" }],
      // Escape configured as the push-to-talk key still cancels.
      [press("Escape"), "Escape", { kind: "cancel" }],
      [press("Delete"), undefined, { kind: "clear" }],
      [press("Backspace", { ctrlKey: true }), "Backspace", { kind: "clear" }],
      [
        press("ShiftLeft", { shiftKey: true }),
        undefined,
        { kind: "ignore", reason: "modifier-only" },
      ],
      [
        press("KeyM", { metaKey: true }),
        undefined,
        { kind: "ignore", reason: "meta-held" },
      ],
    ];
    for (const [event, pushToTalkKey, expected] of cases) {
      for (const mode of MODES) {
        assert.deepEqual(
          decideCapture(event, pushToTalkKey, mode),
          expected,
          `${mode}: ${event.code} must decide the same way in every mode`,
        );
      }
      assert.deepEqual(decideCapture(event, pushToTalkKey), expected);
    }
  });
});

describe("isHardConflict", () => {
  it("blocks reserved and push-to-talk, warns on in-app", () => {
    assert.equal(isHardConflict({ kind: "reserved" }), true);
    assert.equal(isHardConflict({ kind: "push-to-talk", code: "Space" }), true);
    assert.equal(
      isHardConflict({ kind: "in-app", sequence: binding("Escape") }),
      false,
    );
  });

  it("agrees with what decideCapture actually did", () => {
    // The two must not drift: a conflict `isHardConflict` calls hard has to be
    // the one that produced a `refuse`.
    const reserved = decideCapture(
      press("KeyQ", { ctrlKey: true, shiftKey: true, altKey: true }),
    );
    assert.equal(reserved.kind, "refuse");
    if (reserved.kind === "refuse") {
      assert.equal(isHardConflict(reserved.conflict), true);
    }

    const soft = decideCapture(press("ArrowDown", { altKey: true }));
    assert.equal(soft.kind, "commit");
    if (soft.kind === "commit" && soft.conflict) {
      assert.equal(isHardConflict(soft.conflict), false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Typing keys — the CHAT_FOCUS_COMPOSITION gap
 * ------------------------------------------------------------------ */

/**
 * One representative per documented group of `TYPING_CODES`, so the
 * modifier-direction matrix below runs against all of them rather than only
 * against a letter.
 *
 * The four non-US numpad positions are listed individually rather than through
 * one representative: each was added as its own decision (see the
 * `NUMPAD_TEXT_CODES` doc), and a single stand-in would let any one of the
 * other three drop out of the set with no spec noticing.
 */
const TYPING_REPRESENTATIVES: readonly string[] = [
  "KeyM", // letters
  "Digit1", // digits
  "Semicolon", // main-block punctuation
  "Space", // the one CHAT_FOCUS_COMPOSITION's regex cannot even cover
  "IntlRo", // the international text positions (ABNT2/JIS)
  "Numpad1", // numpad digits, NumLock on
  "NumpadAdd", // numpad operators
  "NumpadParenLeft", // the non-US numpad positions, each its own decision
  "NumpadParenRight",
  "NumpadHash",
  "NumpadStar",
  "Enter", // the deliberate widening
  "NumpadEnter",
  "Tab",
  "ArrowUp", // composer motion — edit-last-message / autocomplete selection
];

/**
 * Every code the module's doc comment names as deliberately excluded.
 *
 * 🔴 This list is duplicated prose→code on purpose: it is the assertion that
 * the exclusions in the doc comment are the exclusions in the set. If someone
 * adds `Home` to `TYPING_CODES` without amending the comment, this fails.
 *
 * 🔴 The four arrows used to be in this list, under "navigation and locks", and
 * removing them is the most load-bearing edit in this file. The module excluded
 * them on the claim that `findBindingConflict` already covered them; the claim
 * was false by construction (every arrow entry in `IN_APP_DEFAULT_SEQUENCES` is
 * a *modified* chord and `isTypingChord` only ever sees modifier-less ones), so
 * a bare arrow drew no conflict and no warning. Pinning them here turned that
 * gap into a **defended** gap: a later lane could not have closed it without
 * editing a test, and the test encoded the false claim as if it were a
 * decision. A list of exclusions is only worth having if each entry is
 * re-derivable from something true — so an entry that stops being true has to
 * leave, not be re-justified. The arrows' positive coverage is in
 * `TYPING_REPRESENTATIVES` and in "a bare arrow draws no conflict" below.
 */
const DOCUMENTED_EXCLUSIONS: readonly string[] = [
  // Control gestures of the capture widget — unreachable as a binding.
  "Escape",
  "Delete",
  "Backspace",
  // Modifiers.
  ...MODIFIER_CODES,
  // Function keys.
  "F1",
  "F13",
  "F24",
  // Navigation and locks, MINUS the four arrows — see the note above.
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Insert",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "PrintScreen",
  "Pause",
  "ContextMenu",
];

/**
 * The twelve US-layout main-block punctuation positions, as
 * `PUNCTUATION_CODES` specifies them.
 */
const GLYPH_PUNCTUATION: readonly string[] = [
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
 * Every physical position this module can plausibly be handed, enumerated.
 *
 * Exists for the converse direction of the glyph assertion below, which has to
 * quantify over "every code" and cannot: `formatKeyCode` accepts any string, so
 * the real domain is unbounded and only a stated roster can be checked. Kept
 * deliberately wider than `TYPING_CODES` — it includes the modifiers, the
 * control gestures, the whole nav/lock cluster, the F range and two codes this
 * module recognizes not at all — because a roster that only listed members
 * could not detect a non-member that renders as a glyph, which is exactly the
 * bug it is here to catch.
 */
const CODE_ROSTER: readonly string[] = [
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  "NumpadDecimal",
  "NumpadAdd",
  "NumpadSubtract",
  "NumpadMultiply",
  "NumpadDivide",
  "NumpadComma",
  "NumpadEqual",
  "NumpadEnter",
  "NumpadParenLeft",
  "NumpadParenRight",
  "NumpadHash",
  "NumpadStar",
  ...GLYPH_PUNCTUATION,
  "IntlRo",
  "IntlYen",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Space",
  "Tab",
  "Enter",
  ...DOCUMENTED_EXCLUSIONS,
  // Codes with no legend and no pattern — the pass-through path.
  "MediaTrackNext",
  "Lang1",
];

describe("isTypingChord", () => {
  it("flags a bare member of every documented group", () => {
    for (const code of TYPING_REPRESENTATIVES) {
      assert.equal(
        isTypingChord(binding(code)),
        true,
        `bare ${code} is typed with and must warn`,
      );
    }
  });

  /**
   * 🔴 The load-bearing half. The pinned decision is about MODIFIER-LESS
   * bindings: Ctrl+M cannot be typed into the composer by accident, so warning
   * about it would be noise on every row a user deliberately chorded.
   *
   * Each modifier is set individually, not only all three together — a
   * predicate that consulted just `ctrl` would pass an all-three matrix.
   */
  it("does not flag a chord with any single modifier held", () => {
    for (const code of TYPING_REPRESENTATIVES) {
      for (const mods of [
        { ctrl: true },
        { shift: true },
        { alt: true },
        { ctrl: true, shift: true },
        { ctrl: true, shift: true, alt: true },
      ]) {
        assert.equal(
          isTypingChord(binding(code, mods)),
          false,
          `${JSON.stringify(mods)}+${code} is not a modifier-less binding`,
        );
      }
    }
  });

  it("flips on the modifier bits for one and the same code", () => {
    // The two directions side by side, which is what a mutant ignoring the
    // modifier bits fails and an unconditional `false` also fails.
    assert.equal(isTypingChord(binding("KeyM")), true);
    assert.equal(isTypingChord(binding("KeyM", { ctrl: true })), false);
    assert.equal(isTypingChord(binding("KeyM", { shift: true })), false);
    assert.equal(isTypingChord(binding("KeyM", { alt: true })), false);
  });

  it("does not flag any documented exclusion, bare", () => {
    for (const code of DOCUMENTED_EXCLUSIONS) {
      assert.equal(
        isTypingChord(binding(code)),
        false,
        `${code} is documented as excluded and must not warn`,
      );
    }
  });

  it("does not flag an unknown code", () => {
    // Same failure direction as the formatter's pass-through: claim nothing
    // about a code this module does not recognize.
    assert.equal(isTypingChord(binding("MediaTrackNext")), false);
    assert.equal(isTypingChord(binding("Lang1")), false);
  });
});

describe("TYPING_CODES — internal consistency", () => {
  /**
   * 🔴 This is the assertion that stops a later edit re-adding a control
   * gesture or a modifier to the typing set. Those codes can never reach
   * `binding.code` (`decideCapture` intercepts them above the commit), so a
   * member would be dead weight that reads as intent, and `isTypingChord`
   * would start disagreeing with what the widget can actually store.
   */
  it("shares no member with the modifier or control-gesture lists", () => {
    for (const code of MODIFIER_CODES) {
      assert.equal(
        TYPING_CODES.has(code),
        false,
        `${code} is a modifier and is never a bound key`,
      );
    }
    for (const code of CLEAR_CODES) {
      assert.equal(
        TYPING_CODES.has(code),
        false,
        `${code} clears the binding and is never bindable`,
      );
    }
    assert.equal(
      TYPING_CODES.has(CANCEL_CODE),
      false,
      `${CANCEL_CODE} cancels capture and is never bindable`,
    );
  });

  /**
   * Pins the derived groups. `LETTER_CODES` and the numpad/digit ranges are
   * built with `Array.from`, where an off-by-one produces a set that is almost
   * right — and whose one missing member is a key that ships with no warning.
   */
  it("covers the full letter, digit and numpad ranges", () => {
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      assert.equal(
        TYPING_CODES.has(`Key${letter}`),
        true,
        `Key${letter} missing`,
      );
    }
    for (let d = 0; d <= 9; d++) {
      assert.equal(TYPING_CODES.has(`Digit${d}`), true, `Digit${d} missing`);
      assert.equal(TYPING_CODES.has(`Numpad${d}`), true, `Numpad${d} missing`);
    }
    // The bounds, from the other side: the ranges must not run over.
    for (const code of ["Key[", "Digit10", "Numpad10", "KeyAA"]) {
      assert.equal(
        TYPING_CODES.has(code),
        false,
        `${code} must not be a member`,
      );
    }
  });

  /**
   * 🔴 Both directions, and the second one is the one that matters.
   *
   * The forward half — each of the twelve punctuation positions formats to a
   * one-character legend and is in the typing set — is all this test used to
   * assert, under the title "includes **exactly** the glyph-rendering
   * punctuation positions". It never asserted the converse the word "exactly"
   * promises, and it passed at full green while the four arrows sat outside the
   * set: `formatKeyCode("ArrowUp")` is `"↑"`, one character, and `ArrowUp` was
   * not a member. Written in the direction its own title claimed, this test
   * would have caught the arrow hole on the day it was introduced. It is
   * written that way now.
   *
   * # The coupling this creates, taken deliberately
   *
   * The converse half is really "anything `NAMED_KEY_LEGENDS` gives a
   * one-character legend must be in `TYPING_CODES`", enforced through
   * `formatKeyCode`'s observable output — and quantified over the real table
   * (imported by path for exactly this) unioned with the roster, so a glyph
   * legend added for a position the roster never listed cannot slip past by
   * omission. That is a real coupling, and it has a foreseeable false alarm:
   * adding a glyph legend for a non-typing position (`Home: "⌂"`, say) would
   * fail this test on a change that is not itself wrong.
   *
   * It is kept anyway, because that failure is the feature and not the cost.
   * The operator rule for this set is "errs toward inclusion", so the only two
   * ways past the failure are to add the position to `TYPING_CODES` or to
   * record why it is exempt — both deliberate decisions, forced at the moment
   * the glyph is added, which is the moment someone is actually looking at the
   * question. What the one-directional form bought instead was silence: a
   * glyph-rendering position outside the set, with nothing failing anywhere.
   *
   * The narrower alternative — assert only that the four arrows are members —
   * was rejected. It would close this bug and nothing else, which is how this
   * bug happened: a set that was right about the cases someone thought of.
   */
  it("includes every position whose legend is a single glyph", () => {
    // Forward: the twelve US-layout punctuation positions.
    for (const code of GLYPH_PUNCTUATION) {
      assert.equal(formatKeyCode(code).length, 1, `${code} is not a glyph`);
      assert.equal(TYPING_CODES.has(code), true, `${code} missing`);
    }

    // Converse, over the enumerated roster AND every key of the real legend
    // table, so a glyph legend for a position the roster forgot still lands in
    // `singles`.
    const singles = [
      ...new Set([...CODE_ROSTER, ...Object.keys(NAMED_KEY_LEGENDS)]),
    ].filter((code) => formatKeyCode(code).length === 1);

    /**
     * Anti-vacuity, in two ways. An empty or arrow-less `singles` would let
     * the `for` below pass while asserting nothing, and that is not a
     * hypothetical failure mode — a roster built by filtering `TYPING_CODES`
     * would do exactly that. The arrows are named because they are the precise
     * codes the one-directional form missed.
     */
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      assert.ok(
        singles.includes(code),
        `${code} must render as a glyph and be in the roster`,
      );
    }
    /**
     * 26 letters + 10 digits + 12 punctuation + 4 arrows = 52, re-derived
     * over the widened quantification. Nothing else in the union renders as
     * one character: `Enter` (a roster member since the follow-up) renders
     * "Enter"; the four non-US numpad positions have no `NUMPAD_LEGENDS`
     * entry and fall through the generic numpad branch as "Num ParenLeft" and
     * siblings (see "leaves the four non-US numpad positions unlegended"
     * below); and every remaining `NAMED_KEY_LEGENDS` entry is a
     * multi-character abbreviation ("Esc", "PgUp", …), all of which the roster
     * already lists — true today by enumeration, not asserted: the next spec
     * quantifies only over the single-glyph entries.
     */
    assert.equal(singles.length, 26 + 10 + 12 + 4);
    assert.equal(singles.length, 52, "the roster's glyph count drifted");

    for (const code of singles) {
      assert.equal(
        TYPING_CODES.has(code),
        true,
        `${code} renders as the single glyph "${formatKeyCode(code)}" but is not in TYPING_CODES`,
      );
    }
  });

  /**
   * The structural form of the property the converse relies on: the legend
   * table may name a position the roster does not list only when that legend
   * is multi-character. A single-glyph legend for an unlisted position would
   * be a typing key the roster cannot see — the union above catches it in the
   * converse, and this spec additionally makes the roster's own enumeration
   * honest by forcing the position onto it.
   */
  it("gives no single-glyph legend to a position outside the roster", () => {
    const glyphs = Object.entries(NAMED_KEY_LEGENDS).filter(
      ([, legend]) => legend.length === 1,
    );
    // Anti-vacuity: the table holds the twelve punctuation glyphs and the
    // four arrows, and nothing else that short.
    assert.equal(glyphs.length, 12 + 4);
    for (const [code, legend] of glyphs) {
      assert.ok(
        CODE_ROSTER.includes(code),
        `${code} has the glyph legend "${legend}" but the roster does not list it`,
      );
    }
  });

  /**
   * 🔴 The count is pinned so the consuming settings row (lane A2) is pinned
   * to a known set. 26 letters + 10 digits + 12 punctuation + 2 international
   * + Space + 21 numpad (10 digits + 7 operators + the 4 non-US positions)
   * + 3 always-pressed + 4 arrows.
   */
  it("holds exactly the 79 documented codes", () => {
    assert.equal(TYPING_CODES.size, 26 + 10 + 12 + 2 + 1 + 21 + 3 + 4);
    assert.equal(TYPING_CODES.size, 79);
  });
});

describe("the gap isTypingChord exists to cover", () => {
  /**
   * 🔴 The justification for `Enter` being in the set, asserted rather than
   * claimed in a comment. `Enter` IS in `IN_APP_COMPARABLE_CODES`, so
   * `findBindingConflict` genuinely compares it against the in-app registry —
   * and bare `Enter` is not an entry in `IN_APP_DEFAULT_SEQUENCES`, so that
   * comparison returns a checked, confident `null`. Without `isTypingChord`,
   * bare Enter — which SENDS the composer message — would ship with no
   * caution of any kind.
   */
  it("bare Enter draws no conflict, and is still flagged", () => {
    const decision = decideCapture(press("Enter"));
    assert.deepEqual(decision, {
      kind: "commit",
      binding: binding("Enter"),
      conflict: null,
    });
    assert.equal(isTypingChord(binding("Enter")), true);
  });

  /**
   * The printable-key hole itself: `CHAT_FOCUS_COMPOSITION` is bound to
   * `/^[^ ]$/` and cannot be expressed in `Binding` space, so the `"in-app"`
   * path can never report a bare letter. This is the honest replacement.
   */
  it("a bare letter draws no conflict, and is still flagged", () => {
    const decision = decideCapture(press("KeyM"));
    assert.equal(decision.kind, "commit");
    assert.equal(
      decision.kind === "commit" ? decision.conflict : undefined,
      null,
    );
    assert.equal(isTypingChord(binding("KeyM")), true);
  });

  /**
   * 🔴 The arrow hole, pinned from both sides — the regression this fix lane
   * exists for.
   *
   * The exclusion it replaces claimed the in-app conflict path already covered
   * the arrows. It cannot, by construction: every arrow entry in
   * `IN_APP_DEFAULT_SEQUENCES` is a *modified* chord (`Alt+ArrowDown`,
   * `Ctrl+Alt+ArrowUp`, `Ctrl+Alt+ArrowDown`, with `ArrowLeft`/`ArrowRight`
   * absent entirely), `bindingsEqual` compares the full chord, and
   * `isTypingChord` returns `false` before reading the code whenever a modifier
   * is set. The two coverages have disjoint domains.
   *
   * This is the same assertion shape as "bare Enter draws no conflict, and is
   * still flagged" directly above, because it is the same case: a code that IS
   * in `IN_APP_COMPARABLE_CODES`, so the `null` presents as a checked,
   * confident "no conflict" rather than an unchecked one.
   */
  it("a bare arrow draws no conflict, and is still flagged", () => {
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      assert.deepEqual(
        decideCapture(press(code)),
        { kind: "commit", binding: binding(code), conflict: null },
        `bare ${code} must commit with a checked, null conflict`,
      );
      assert.equal(
        isTypingChord(binding(code)),
        true,
        `bare ${code} drives edit-last-message and autocomplete and must warn`,
      );
    }

    /**
     * The other half of the measurement: the arrow chords that ARE in-app
     * sequences all carry modifiers, so they land outside this predicate and
     * are covered by the conflict note instead. Both halves together are what
     * make "disjoint domains" an assertion rather than a claim — and they are
     * why adding the arrows costs no double warning on the chords that already
     * had one.
     */
    const alt = decideCapture(press("ArrowDown", { altKey: true }));
    assert.equal(alt.kind, "commit");
    assert.deepEqual(
      alt.kind === "commit" ? alt.conflict : undefined,
      { kind: "in-app", sequence: binding("ArrowDown", { alt: true }) },
      "Alt+ArrowDown is the in-app conflict the old exclusion pointed at",
    );
    assert.equal(isTypingChord(binding("ArrowDown", { alt: true })), false);
    assert.equal(
      isTypingChord(binding("ArrowUp", { ctrl: true, alt: true })),
      false,
    );
  });

  /**
   * The international text positions. Both type, neither has a keycap legend,
   * and neither string existed anywhere in this repo before the group that
   * added them — so nothing else was covering them.
   */
  it("flags IntlRo and IntlYen, which have no legend to lean on", () => {
    for (const code of ["IntlRo", "IntlYen"]) {
      assert.equal(isTypingChord(binding(code)), true, `${code} types`);
      assert.equal(decideCapture(press(code)).kind, "commit");

      /**
       * Pinned as a pass-through, not as a glyph. `formatKeyCode` has no entry
       * for these, so they render as the raw code — this module's documented
       * honest failure for an unrecognized position. The assertion is here so
       * that a later lane adding `IntlRo: "/"` sees it is changing
       * `formatKeyCode`'s behavior, which is pinned, rather than only adding a
       * table row.
       */
      assert.equal(formatKeyCode(code), code);
    }

    // `IntlBackslash`, a member since the punctuation group, DOES have one.
    assert.equal(formatKeyCode("IntlBackslash"), "\\");
    assert.equal(TYPING_CODES.has("IntlBackslash"), true);
  });

  /**
   * The four non-US numpad positions, decided the same way as the Intl pair:
   * members because each types on hardware that has it, and deliberately
   * unlegended. They fall through `formatKeyCode`'s generic numpad branch as
   * the raw suffix — pinned here so a later lane adding `ParenLeft: "("` to
   * `NUMPAD_LEGENDS` sees it is changing pinned output. `NumpadStar` is the
   * sharp case: `"Num *"` is already `NumpadMultiply`'s legend, and two
   * distinct positions must not read the same.
   */
  it("leaves the four non-US numpad positions unlegended", () => {
    for (const suffix of ["ParenLeft", "ParenRight", "Hash", "Star"]) {
      const code = `Numpad${suffix}`;
      assert.equal(TYPING_CODES.has(code), true, `${code} types`);
      assert.equal(isTypingChord(binding(code)), true);
      assert.equal(decideCapture(press(code)).kind, "commit");
      assert.equal(formatKeyCode(code), `Num ${suffix}`);
    }
    assert.notEqual(
      formatKeyCode("NumpadStar"),
      formatKeyCode("NumpadMultiply"),
    );
  });

  /**
   * Space is doubly uncovered — the regex excludes it — but only while
   * push-to-talk is off. With PTT on it is a hard refusal, and the warning
   * never arises because the binding is never stored.
   */
  it("Space is flagged, and is separately a PTT refusal when PTT is on", () => {
    assert.equal(decideCapture(press("Space")).kind, "commit");
    assert.equal(isTypingChord(binding("Space")), true);
    assert.equal(decideCapture(press("Space"), "Space").kind, "refuse");
  });

  /**
   * The predicate is a warning, never a block: nothing about a typing chord
   * changes `decideCapture`'s outcome. Pinned because the operator decision is
   * explicitly "capture accepts it; nothing is refused".
   */
  it("never blocks — a typing chord still commits", () => {
    for (const code of TYPING_REPRESENTATIVES) {
      const decision = decideCapture(press(code));
      assert.equal(
        decision.kind,
        "commit",
        `${code} must still be bindable, only warned about`,
      );
    }
  });
});

/* ------------------------------------------------------------------ *
 * The formatter — defect 5
 * ------------------------------------------------------------------ */

describe("formatKeyCode", () => {
  /**
   * 🔴 Defect 5. The one-off wrote
   * `.replace("Arrow", "↑↓←→".includes(code) ? "" : "Arrow ")`, which tests
   * whether the whole code string ("ArrowUp") appears inside "↑↓←→" — always
   * false. The arrow branch was dead and every arrow rendered "Arrow Up".
   */
  it("renders arrows as glyphs", () => {
    assert.equal(formatKeyCode("ArrowUp"), "↑");
    assert.equal(formatKeyCode("ArrowDown"), "↓");
    assert.equal(formatKeyCode("ArrowLeft"), "←");
    assert.equal(formatKeyCode("ArrowRight"), "→");
  });

  it("never emits the word Arrow", () => {
    for (const code of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
      assert.ok(
        !formatKeyCode(code).includes("Arrow"),
        `${code} still renders as prose`,
      );
    }
  });

  it("strips the Key and Digit prefixes", () => {
    assert.equal(formatKeyCode("KeyM"), "M");
    assert.equal(formatKeyCode("KeyQ"), "Q");
    assert.equal(formatKeyCode("Digit1"), "1");
    assert.equal(formatKeyCode("Digit0"), "0");
  });

  it("passes function keys through", () => {
    assert.equal(formatKeyCode("F1"), "F1");
    assert.equal(formatKeyCode("F13"), "F13");
    assert.equal(formatKeyCode("F24"), "F24");

    /**
     * Out-of-range F codes pass through unchanged too.
     *
     * 🔴 These pin the OUTPUT and they do NOT pin the F-range pattern, and
     * recording that is the honest result rather than a control proof this
     * file cannot deliver. Widening `/^F([1-9]|1[0-9]|2[0-4])$/` to
     * `/^F([0-9]+)$/` is an **equivalent mutant**: the branch returns `code`,
     * which is exactly what the fallthrough at the end of `formatKeyCode`
     * returns, and no pattern in between can intercept an F-prefixed code (the
     * only one left is `/^Numpad(.+)$/`). So for every possible input the
     * branch and the fallthrough produce the same string, and no assertion on
     * `formatKeyCode`'s return value can distinguish the two regexes.
     * Confirmed by probe: under that mutation F0, F25, F100 and F1..F24 all
     * render identically to baseline.
     *
     * The branch stays as documented intent, and it becomes load-bearing the
     * moment the fallthrough stops being a plain pass-through — at which point
     * the F1/F13/F24 cases above are the specs that kill it.
     */
    assert.equal(formatKeyCode("F0"), "F0");
    assert.equal(formatKeyCode("F25"), "F25");
    assert.equal(formatKeyCode("F100"), "F100");
  });

  it("uses keycap legends for the named keys", () => {
    assert.equal(formatKeyCode("Escape"), "Esc");
    assert.equal(formatKeyCode("Space"), "Space");
    assert.equal(formatKeyCode("PageDown"), "PgDn");
    assert.equal(formatKeyCode("Delete"), "Del");
  });

  it("renders punctuation as its glyph", () => {
    assert.equal(formatKeyCode("Semicolon"), ";");
    assert.equal(formatKeyCode("BracketLeft"), "[");
    assert.equal(formatKeyCode("Slash"), "/");
    assert.equal(formatKeyCode("Backquote"), "`");
  });

  it("labels the numpad distinctly from the main block", () => {
    // NumpadEnter and Enter are different physical keys and must not read the
    // same — the contract's IN_APP_COMPARABLE_CODES note turns on exactly this.
    assert.equal(formatKeyCode("Numpad1"), "Num 1");
    assert.equal(formatKeyCode("NumpadEnter"), "Num Enter");
    assert.equal(formatKeyCode("NumpadAdd"), "Num +");
    assert.notEqual(formatKeyCode("NumpadEnter"), formatKeyCode("Enter"));
  });

  /**
   * The one-off's `.replace("Key", "")` was unanchored, so any code merely
   * containing "Key" was mangled. Anchored patterns pass an unknown code
   * through instead: ugly but true, rather than a legend naming the wrong key.
   */
  it("passes an unrecognized code through untouched", () => {
    assert.equal(formatKeyCode("MediaTrackNext"), "MediaTrackNext");
    assert.equal(formatKeyCode("BrowserHome"), "BrowserHome");
    assert.equal(formatKeyCode("Lang1"), "Lang1");
  });

  it("does not half-match a code that merely contains a prefix", () => {
    assert.equal(formatKeyCode("KeyboardLayoutSelect"), "KeyboardLayoutSelect");

    /**
     * 🔴 "KeyboardLayoutSelect" cannot pin the anchors on its own, which is
     * why the cases below exist. The character after "Key" in it is lowercase
     * `b`, so `/^Key([A-Z])$/` and an unanchored `/Key([A-Z])/` BOTH miss it
     * and the fixture passes either way — the test named for the anchoring was
     * blind to the mutation it names.
     *
     * These flip. Unanchored, "KeyMM" and "XKeyM" both render "M": a legend
     * that confidently names the wrong physical key.
     */
    assert.equal(formatKeyCode("KeyMM"), "KeyMM");
    assert.equal(formatKeyCode("XKeyM"), "XKeyM");

    // Same hole on the digit pattern: unanchored, "Digit12" and "XDigit1"
    // both render "1".
    assert.equal(formatKeyCode("Digit12"), "Digit12");
    assert.equal(formatKeyCode("XDigit1"), "XDigit1");
  });
});

describe("formatBinding", () => {
  it("renders a bare key", () => {
    assert.equal(formatBinding(binding("KeyM")), "M");
  });

  it("renders modifiers in Ctrl, Shift, Alt order", () => {
    assert.equal(
      formatBinding(binding("KeyQ", { ctrl: true, shift: true, alt: true })),
      ["Ctrl", "Shift", "Alt", "Q"].join(CHORD_SEPARATOR),
    );
  });

  it("emits only the modifiers that are set", () => {
    assert.equal(
      formatBinding(binding("F13", { shift: true })),
      `Shift${CHORD_SEPARATOR}F13`,
    );
    assert.equal(
      formatBinding(binding("ArrowDown", { alt: true })),
      `Alt${CHORD_SEPARATOR}↓`,
    );
  });

  it("renders the reserved combo the way the contract file names it", () => {
    // RESERVED_COMBO's doc calls it "Ctrl+Shift+Alt+Q"; the displayed order
    // must match so a user reading the UI recognizes the documented combo.
    assert.equal(
      formatBinding(RESERVED_COMBO),
      ["Ctrl", "Shift", "Alt", "Q"].join(CHORD_SEPARATOR),
    );
  });

  it("round-trips a captured chord into display", () => {
    const decision = decideCapture(
      press("Digit1", { ctrlKey: true, altKey: true }),
    );
    assert.equal(decision.kind, "commit");
    if (decision.kind === "commit") {
      assert.equal(
        formatBinding(decision.binding),
        `Ctrl${CHORD_SEPARATOR}Alt${CHORD_SEPARATOR}1`,
      );
    }
  });
});
