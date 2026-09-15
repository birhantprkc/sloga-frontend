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
  type CaptureKeyEvent,
  CHORD_SEPARATOR,
  decideCapture,
  formatBinding,
  formatKeyCode,
  isHardConflict,
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
