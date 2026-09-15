/**
 * Run with:
 *
 *     node --conditions=browser --test components/keybinds/globalKeybinds.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests. This file is
 * pure — `globalKeybinds.ts` is a dependency-free leaf and imports nothing — so
 * nothing here resolves solid-js at all, but one invocation should cover it and
 * the reactive suites together.)
 *
 * # Why this file exists
 *
 * `globalKeybinds.ts` is a contract module: at the time of writing, most of its
 * exports have no consumer yet, so nothing else in the tree would notice if a
 * value changed. Worse, the `Record<GlobalKeybindAction, …>` annotations on
 * `KEYBIND_TIER` and `KEYBIND_REQUIREMENT` **widen** the table values —
 * `KEYBIND_TIER["screenshare-start"]` has type `KeybindTier`, not `"in-app"` —
 * so the compiler will happily accept `"global"` there. A per-action value can
 * only be pinned by a runtime assertion, which is what most of this file is.
 *
 * The headline invariant is the press/release asymmetry (§ "press vs release"):
 * a chord matches a PRESS only on exact modifier equality and a RELEASE on
 * physical key identity alone. Collapsing the two is the bug that leaves a
 * microphone open after the user has let go, and a typecheck cannot see it
 * because both predicates have the same shape.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Binding,
  type KeyLikeEvent,
  GLOBAL_KEYBIND_ACTIONS,
  IN_APP_COMPARABLE_CODES,
  IN_APP_DEFAULT_SEQUENCES,
  KEYBIND_MIN_INTERVAL_MS,
  KEYBIND_REQUIREMENT,
  KEYBIND_TIER,
  MAX_BINDINGS,
  RESERVED_COMBO,
  bindingMatchesPress,
  bindingMatchesRelease,
  bindingsEqual,
  findBindingConflict,
  isGlobalKeybindAction,
  isReservedCombo,
} from "./globalKeybinds.ts";

/** A `Binding` from a terse spelling, so the chords below stay readable. */
function chord(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): Binding {
  return {
    code,
    ctrl: mods.ctrl ?? false,
    shift: mods.shift ?? false,
    alt: mods.alt ?? false,
  };
}

/** The DOM-event shape `bindingMatchesPress` duck-types. */
function ev(
  code: string,
  mods: { ctrl?: boolean; shift?: boolean; alt?: boolean } = {},
): KeyLikeEvent {
  return {
    code,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

/* ======================================================================== *
 * Tier + requirement, per action, by value
 *
 * One `it` per action rather than a table-driven loop, so a flipped value
 * names the action that broke rather than a row index. The two completeness
 * tests below are what stop a NEW action from slipping in with no per-action
 * test: adding one is already a compile error until both tables are extended,
 * and the key-set assertions then fail until it is listed here too.
 * ======================================================================== */

describe("KEYBIND_TIER / KEYBIND_REQUIREMENT, per action", () => {
  it("toggle-mute: global, no precondition", () => {
    assert.equal(KEYBIND_TIER["toggle-mute"], "global");
    assert.equal(KEYBIND_REQUIREMENT["toggle-mute"], "none");
  });

  it("toggle-deafen: global, no precondition", () => {
    assert.equal(KEYBIND_TIER["toggle-deafen"], "global");
    assert.equal(KEYBIND_REQUIREMENT["toggle-deafen"], "none");
  });

  it("toggle-camera: global, needs a room", () => {
    assert.equal(KEYBIND_TIER["toggle-camera"], "global");
    assert.equal(KEYBIND_REQUIREMENT["toggle-camera"], "room");
  });

  // Split from `screenshare-start` precisely so stopping keeps the unfocused
  // tier: it is a `setScreenShareEnabled(false)` on an already-granted
  // capture and needs no transient activation.
  it("screenshare-stop: global, needs a room", () => {
    assert.equal(KEYBIND_TIER["screenshare-stop"], "global");
    assert.equal(KEYBIND_REQUIREMENT["screenshare-stop"], "room");
  });

  // `getDisplayMedia()` requires transient user activation, which a native
  // hook callback cannot supply, and a canceled picker's `NotAllowedError` is
  // swallowed by `Voice.onErr` — so an unfocused press would be silent.
  it("screenshare-start: IN-APP only, needs a room", () => {
    assert.equal(KEYBIND_TIER["screenshare-start"], "in-app");
    assert.equal(KEYBIND_REQUIREMENT["screenshare-start"], "room");
  });

  it("disconnect-call: global, no precondition", () => {
    assert.equal(KEYBIND_TIER["disconnect-call"], "global");
    assert.equal(KEYBIND_REQUIREMENT["disconnect-call"], "none");
  });

  // "incoming-call", not "room": these two need a RINGING call and
  // specifically need there to be no room yet.
  it("accept-call: global, needs a ringing call", () => {
    assert.equal(KEYBIND_TIER["accept-call"], "global");
    assert.equal(KEYBIND_REQUIREMENT["accept-call"], "incoming-call");
  });

  it("dismiss-call: global, needs a ringing call", () => {
    assert.equal(KEYBIND_TIER["dismiss-call"], "global");
    assert.equal(KEYBIND_REQUIREMENT["dismiss-call"], "incoming-call");
  });

  it("toggle-window: global, no precondition", () => {
    assert.equal(KEYBIND_TIER["toggle-window"], "global");
    assert.equal(KEYBIND_REQUIREMENT["toggle-window"], "none");
  });

  it("toggle-overlay: global, no precondition", () => {
    assert.equal(KEYBIND_TIER["toggle-overlay"], "global");
    assert.equal(KEYBIND_REQUIREMENT["toggle-overlay"], "none");
  });

  // `Element.requestFullscreen()` requires transient user activation.
  it("toggle-fullscreen: IN-APP only, no precondition", () => {
    assert.equal(KEYBIND_TIER["toggle-fullscreen"], "in-app");
    assert.equal(KEYBIND_REQUIREMENT["toggle-fullscreen"], "none");
  });

  // Inherits fullscreen's tier; "none" because with no call mounted the
  // toggle is inert rather than throwing.
  it("toggle-theater: IN-APP only, no precondition", () => {
    assert.equal(KEYBIND_TIER["toggle-theater"], "in-app");
    assert.equal(KEYBIND_REQUIREMENT["toggle-theater"], "none");
  });

  // Sorted, not in declaration order: the ORDER of GLOBAL_KEYBIND_ACTIONS is
  // the settings UI's render order and is load-bearing, but the key order of
  // these two tables is not, so reordering a table must not fail a test.
  // Missing or extra keys must.
  const sortedActions = [...GLOBAL_KEYBIND_ACTIONS].sort();

  it("KEYBIND_TIER covers exactly the declared actions", () => {
    assert.deepEqual(Object.keys(KEYBIND_TIER).sort(), sortedActions);
  });

  it("KEYBIND_REQUIREMENT covers exactly the declared actions", () => {
    assert.deepEqual(Object.keys(KEYBIND_REQUIREMENT).sort(), sortedActions);
  });

  // Aggregate restatement of the three per-action assertions above. The point
  // is the COUNT: an action quietly promoted to "global" to make an unfocused
  // demo work would pass every other test in this file.
  it("exactly three actions are activation-gated to the in-app tier", () => {
    const inApp = GLOBAL_KEYBIND_ACTIONS.filter(
      (action) => KEYBIND_TIER[action] === "in-app",
    );
    assert.deepEqual(inApp, [
      "screenshare-start",
      "toggle-fullscreen",
      "toggle-theater",
    ]);
  });
});

/* ======================================================================== *
 * Action ids
 * ======================================================================== */

describe("isGlobalKeybindAction", () => {
  it("accepts every declared action", () => {
    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      assert.equal(isGlobalKeybindAction(action), true, action);
    }
    // Guard the loop itself: if the array were ever emptied this test would
    // otherwise pass vacuously.
    assert.equal(GLOBAL_KEYBIND_ACTIONS.length, 12);
  });

  it("rejects plausible near-misses", () => {
    // `toggle-screenshare` is the single toggle this module deliberately
    // split in two; a stale arm naming it is the realistic wire failure.
    for (const nearMiss of [
      "toggle-screenshare",
      "screenshare-toggle",
      "toggleMute",
      "toggle_mute",
      "toggle-mute ",
      "TOGGLE-MUTE",
      "mute",
      "",
    ]) {
      assert.equal(isGlobalKeybindAction(nearMiss), false, nearMiss);
    }
  });

  it("declares no duplicate ids", () => {
    // The native side identifies an action by its ARRAY INDEX, so two entries
    // with one id would arm two slots the events cannot tell apart.
    assert.equal(
      new Set<string>(GLOBAL_KEYBIND_ACTIONS).size,
      GLOBAL_KEYBIND_ACTIONS.length,
    );
  });

  it("fits inside MAX_BINDINGS even if the user binds every action", () => {
    // Tripwire, not a coincidence: the capture UI refuses a 17th binding, and
    // native refuses overflow by id while still arming the first 16. A 17th
    // ACTION would make "bind everything" silently partial.
    assert.ok(
      GLOBAL_KEYBIND_ACTIONS.length <= MAX_BINDINGS,
      `${GLOBAL_KEYBIND_ACTIONS.length} actions > MAX_BINDINGS ${MAX_BINDINGS}`,
    );
  });
});

/* ======================================================================== *
 * press vs release — THE HEADLINE INVARIANT
 *
 * A press matches on exact `(ctrl, shift, alt)` equality; a release matches on
 * `code` alone. Both predicates take the same argument shape, so nothing but a
 * runtime test distinguishes them — and collapsing them in either direction is
 * a real, shipped-bug-shaped failure:
 *
 *  - release made exact  → the up edge never arrives, the action latches down,
 *                          push-to-mute holds the microphone open;
 *  - press made loose    → the binding steals every superset chord from the
 *                          focused application.
 * ======================================================================== */

describe("press vs release asymmetry", () => {
  const ctrlM = chord("KeyM", { ctrl: true });

  it("press matches the exact chord", () => {
    assert.equal(bindingMatchesPress(ctrlM, ev("KeyM", { ctrl: true })), true);
  });

  it("press does NOT match a superset chord", () => {
    // Bind Ctrl+M loosely and it would also fire on Ctrl+Shift+Alt+M, which
    // belongs to whatever the user is typing into.
    assert.equal(
      bindingMatchesPress(ctrlM, ev("KeyM", { ctrl: true, shift: true })),
      false,
    );
    assert.equal(
      bindingMatchesPress(
        ctrlM,
        ev("KeyM", { ctrl: true, shift: true, alt: true }),
      ),
      false,
    );
  });

  it("press does NOT match with a modifier missing", () => {
    assert.equal(bindingMatchesPress(ctrlM, ev("KeyM")), false);
  });

  it("press does NOT match a different physical key", () => {
    assert.equal(bindingMatchesPress(ctrlM, ev("KeyN", { ctrl: true })), false);
  });

  // 🔴 THE CASE THE ASYMMETRY EXISTS FOR. The user lets go of Ctrl first and
  // then the letter, so the keyup that arrives carries NO modifiers at all.
  // Under exact equality this release is dropped and the action latches down.
  it("release still matches when the modifier was released FIRST", () => {
    const modifierReleasedFirst: KeyLikeEvent = ev("KeyM");
    assert.equal(bindingMatchesRelease(ctrlM, modifierReleasedFirst), true);
  });

  // The two predicates side by side on ONE event, which is what makes the
  // asymmetry visible rather than merely asserted.
  it("the very event a press rejects is the event a release must accept", () => {
    const modifierReleasedFirst: KeyLikeEvent = ev("KeyM");
    assert.equal(bindingMatchesPress(ctrlM, modifierReleasedFirst), false);
    assert.equal(bindingMatchesRelease(ctrlM, modifierReleasedFirst), true);
  });

  it("release matches with spurious extra modifiers held", () => {
    // The mirror of the case above: releasing the letter of a BARE binding
    // while Ctrl happens to be down must still end the action.
    const bareM = chord("KeyM");
    const extraModifiers: KeyLikeEvent = ev("KeyM", {
      ctrl: true,
      shift: true,
      alt: true,
    });
    assert.equal(bindingMatchesRelease(bareM, extraModifiers), true);
  });

  it("release does NOT match a different physical key", () => {
    // Physical key identity is the one thing a release DOES compare; without
    // this, "modifiers are not compared" would slide into "nothing is".
    assert.equal(
      bindingMatchesRelease(ctrlM, ev("KeyN", { ctrl: true })),
      false,
    );
  });
});

/* ======================================================================== *
 * bindingsEqual
 * ======================================================================== */

describe("bindingsEqual", () => {
  it("is field-wise, not by reference", () => {
    assert.equal(
      bindingsEqual(
        chord("KeyM", { ctrl: true, alt: true }),
        chord("KeyM", { ctrl: true, alt: true }),
      ),
      true,
    );
  });

  it("distinguishes the physical key", () => {
    assert.equal(bindingsEqual(chord("KeyM"), chord("KeyN")), false);
  });

  it("distinguishes each modifier independently", () => {
    const bare = chord("KeyM");
    assert.equal(bindingsEqual(bare, chord("KeyM", { ctrl: true })), false);
    assert.equal(bindingsEqual(bare, chord("KeyM", { shift: true })), false);
    assert.equal(bindingsEqual(bare, chord("KeyM", { alt: true })), false);
  });
});

/* ======================================================================== *
 * isReservedCombo
 *
 * 🔴 These assertions pin a DELIBERATELY NARROW predicate. The native refusal
 * is a strict superset: it refuses `code === "KeyQ"` OR the key LABELLED Q
 * under the active layout (`is_reserved_combo` resolves the panic virtual
 * key's scan code at arm time), which on AZERTY is physical `KeyA`. The
 * `KeyA` case below asserts that this predicate does NOT catch that — the
 * limitation is pinned as a fact so it cannot be "fixed" by a guess, and so
 * the only complete signal stays `KeybindsArmResult.refused`.
 * ======================================================================== */

describe("isReservedCombo", () => {
  it("catches Ctrl+Shift+Alt+KeyQ", () => {
    assert.equal(
      isReservedCombo(chord("KeyQ", { ctrl: true, shift: true, alt: true })),
      true,
    );
    assert.equal(isReservedCombo({ ...RESERVED_COMBO }), true);
  });

  it("is not fooled by one modifier short", () => {
    assert.equal(
      isReservedCombo(chord("KeyQ", { ctrl: true, shift: true })),
      false,
    );
    assert.equal(
      isReservedCombo(chord("KeyQ", { ctrl: true, alt: true })),
      false,
    );
    assert.equal(
      isReservedCombo(chord("KeyQ", { shift: true, alt: true })),
      false,
    );
  });

  it("does not treat a bare KeyQ as reserved", () => {
    assert.equal(isReservedCombo(chord("KeyQ")), false);
  });

  it("does NOT catch KeyA — the AZERTY labelled-Q position", () => {
    // Documented narrowness, asserted on purpose. On an AZERTY layout the key
    // labelled Q is physical `KeyA`, the native arm refuses it via its
    // resolved-scan test, and this renderer-side predicate cannot know the
    // layout. A user on AZERTY therefore saves a row that looks bound and
    // never fires unless the caller reads the arm result's `refused` list.
    assert.equal(
      isReservedCombo(chord("KeyA", { ctrl: true, shift: true, alt: true })),
      false,
    );
  });
});

/* ======================================================================== *
 * findBindingConflict
 * ======================================================================== */

describe("findBindingConflict", () => {
  it("reports the reserved combo", () => {
    assert.deepEqual(
      findBindingConflict(
        chord("KeyQ", { ctrl: true, shift: true, alt: true }),
      ),
      { kind: "reserved" },
    );
  });

  it("puts reserved ahead of push-to-talk", () => {
    // Descending severity: a user whose push-to-talk key IS Q must be told
    // the combo is reserved, not that it clashes with their own PTT.
    assert.deepEqual(
      findBindingConflict(
        chord("KeyQ", { ctrl: true, shift: true, alt: true }),
        "KeyQ",
      ),
      { kind: "reserved" },
    );
  });

  // 🔴 Verified against `@revolt/rtc/state.tsx`, whose PTT keydown/keyup
  // handlers gate on a bare `if (e.code !== this.#settings.pushToTalkKey)
  // return;` with NO modifier comparison. So Ctrl+Space really does drive
  // push-to-talk, and a candidate that merely adds modifiers to the PTT key
  // still collides. Comparing modifiers here would miss it.
  it("matches push-to-talk on the physical key, ignoring modifiers", () => {
    assert.deepEqual(findBindingConflict(chord("Space"), "Space"), {
      kind: "push-to-talk",
      code: "Space",
    });
    assert.deepEqual(
      findBindingConflict(chord("Space", { ctrl: true }), "Space"),
      { kind: "push-to-talk", code: "Space" },
    );
    assert.deepEqual(
      findBindingConflict(
        chord("Space", { ctrl: true, shift: true, alt: true }),
        "Space",
      ),
      { kind: "push-to-talk", code: "Space" },
    );
  });

  it("reports no push-to-talk conflict when the key differs", () => {
    assert.equal(findBindingConflict(chord("KeyM"), "Space"), null);
  });

  it("reports no push-to-talk conflict when push-to-talk is off", () => {
    // `undefined` is the caller's signal for `voice.pushToTalk === false`:
    // the key is configured but inert, so there is nothing to collide with.
    assert.equal(findBindingConflict(chord("Space")), null);
    assert.equal(findBindingConflict(chord("Space"), undefined), null);
  });

  it("reports the in-app collision on bare Escape", () => {
    assert.deepEqual(findBindingConflict(chord("Escape")), {
      kind: "in-app",
      sequence: chord("Escape"),
    });
  });

  it("reports the in-app collision on Shift+Escape", () => {
    assert.deepEqual(findBindingConflict(chord("Escape", { shift: true })), {
      kind: "in-app",
      sequence: chord("Escape", { shift: true }),
    });
  });

  it("reports the in-app collision on Ctrl+Alt+ArrowDown", () => {
    assert.deepEqual(
      findBindingConflict(chord("ArrowDown", { ctrl: true, alt: true })),
      {
        kind: "in-app",
        sequence: chord("ArrowDown", { ctrl: true, alt: true }),
      },
    );
  });

  it("does not report an in-app collision on a near-miss chord", () => {
    // Ctrl+Escape is not a default sequence; the in-app arm IS exact.
    assert.equal(findBindingConflict(chord("Escape", { ctrl: true })), null);
    // Alt+ArrowUp is free because `keybindSequences` binds
    // NAVIGATION_CHANNEL_UP to Alt+ArrowDown too (an upstream typo this
    // module restates as-is rather than fixing).
    assert.equal(findBindingConflict(chord("ArrowUp", { alt: true })), null);
  });

  // The partial-map blind spot, pinned. `null` here means "no conflict this
  // check can SEE", never "no conflict" — a letter key is not cross-checked
  // against the in-app registry at all, because `code` → `key` depends on the
  // active layout and the shift state.
  it("returns null for a code outside IN_APP_COMPARABLE_CODES", () => {
    assert.equal("KeyM" in IN_APP_COMPARABLE_CODES, false);
    assert.equal("KeyQ" in IN_APP_COMPARABLE_CODES, false);
    assert.equal(findBindingConflict(chord("KeyM")), null);
    assert.equal(findBindingConflict(chord("KeyM", { ctrl: true })), null);
  });

  it("IN_APP_COMPARABLE_CODES maps each code to itself", () => {
    // The map's whole justification is that these are the keys whose `code`
    // and `key` are the same string on every layout. An entry that mapped to
    // anything else would be a layout guess.
    for (const [code, key] of Object.entries(IN_APP_COMPARABLE_CODES)) {
      assert.equal(key, code);
    }
    assert.equal(Object.keys(IN_APP_COMPARABLE_CODES).length, 6);
  });

  it("every in-app default sequence uses a comparable code", () => {
    // `findBindingConflict` searches IN_APP_DEFAULT_SEQUENCES with no
    // "is this comparable" pre-check, on the grounds that every entry uses a
    // comparable code BY CONSTRUCTION. That is the construction.
    for (const sequence of IN_APP_DEFAULT_SEQUENCES) {
      assert.ok(
        sequence.code in IN_APP_COMPARABLE_CODES,
        `${sequence.code} is not in IN_APP_COMPARABLE_CODES`,
      );
    }
    assert.equal(IN_APP_DEFAULT_SEQUENCES.length, 5);
  });
});

/* ======================================================================== *
 * Rate limit
 * ======================================================================== */

describe("KEYBIND_MIN_INTERVAL_MS", () => {
  it("is 300 ms — the publish-gate floor, not an auto-repeat floor", () => {
    // Native collapses auto-repeat twice on its own (the `key_busy` pre-scan
    // and the per-slot `fetch_or` gate), so the global tier sees exactly one
    // press edge per hold. This value exists for the publish-gate sweep's
    // one-round margin, and it doubles as the in-app tier's DOM-repeat floor.
    assert.equal(KEYBIND_MIN_INTERVAL_MS, 300);
    assert.ok(KEYBIND_MIN_INTERVAL_MS > 250);
  });
});
