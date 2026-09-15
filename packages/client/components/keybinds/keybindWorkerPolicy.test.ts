/**
 * Run with:
 *
 *     node --conditions=browser --test components/keybinds/keybindWorkerPolicy.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests — without
 * it Node resolves solid-js's server build and effect-based specs silently
 * pass against broken code. This file is pure and unaffected, but one
 * invocation should cover it and the reactive suites together.)
 *
 * These are the decisions behind `@revolt/client/KeybindsWorker`, which is a
 * `.tsx` reaching `@revolt/rtc` and therefore loadable by no unit runner at
 * all. Each `describe` below names the decision and the production failure it
 * prevents.
 *
 * The tier filter, the held-set release-all and the suppression check each
 * have a known-bad control recorded in the lane report: removing any one of
 * them must turn a spec here red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type Binding,
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_TIER,
  MAX_BINDINGS,
} from "./globalKeybinds.ts";

import {
  UNPROBED_KEYBIND_ARM_STATE,
  applyKeybindHeldEvent,
  armStateFromResult,
  deriveNativeAvailable,
  matchDomKey,
  planKeybindArm,
} from "./keybindWorkerPolicy.ts";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

/** A chord, with `code` the only interesting field by default. */
function chord(code: string, mods: Partial<Binding> = {}): Binding {
  return { code, ctrl: false, shift: false, alt: false, ...mods };
}

/** Nothing bound — the shipped default (`defaultKeybinds()`). */
function noBindings(): Record<GlobalKeybindAction, Binding | null> {
  const bindings = {} as Record<GlobalKeybindAction, Binding | null>;
  for (const action of GLOBAL_KEYBIND_ACTIONS) bindings[action] = null;
  return bindings;
}

/** Nothing bound except the given rows. */
function bound(
  entries: Partial<Record<GlobalKeybindAction, Binding>>,
): Record<GlobalKeybindAction, Binding | null> {
  const bindings = noBindings();
  for (const [action, binding] of Object.entries(entries)) {
    bindings[action as GlobalKeybindAction] = binding;
  }
  return bindings;
}

/** A `KeyLikeEvent` from a chord, as a real press of it would arrive. */
function pressOf(binding: Binding) {
  return {
    code: binding.code,
    ctrlKey: binding.ctrl,
    shiftKey: binding.shift,
    altKey: binding.alt,
  };
}

/** Every action the tier table calls `"global"`, in declared order. */
const GLOBAL_TIER_ACTIONS = GLOBAL_KEYBIND_ACTIONS.filter(
  (action) => KEYBIND_TIER[action] === "global",
);

/** Every action the tier table calls `"in-app"`, in declared order. */
const IN_APP_TIER_ACTIONS = GLOBAL_KEYBIND_ACTIONS.filter(
  (action) => KEYBIND_TIER[action] === "in-app",
);

/* ------------------------------------------------------------------------ *
 * 1. planKeybindArm — the tier filter and index stability
 * ------------------------------------------------------------------------ */

describe("planKeybindArm: the tier filter", () => {
  it("has both tiers populated, or the rest of this suite proves nothing", () => {
    assert.ok(
      IN_APP_TIER_ACTIONS.length > 0,
      "KEYBIND_TIER has no in-app actions; the filter specs below are vacuous",
    );
    assert.ok(GLOBAL_TIER_ACTIONS.length > 0);
    assert.equal(
      GLOBAL_TIER_ACTIONS.length + IN_APP_TIER_ACTIONS.length,
      GLOBAL_KEYBIND_ACTIONS.length,
    );
  });

  it("submits every global-tier binding and NO in-app-tier binding", () => {
    // Every action bound, each to its own chord, so nothing is dropped as a
    // duplicate and only the tier can explain an absence.
    const bindings = bound(
      Object.fromEntries(
        GLOBAL_KEYBIND_ACTIONS.map((action, index) => [
          action,
          chord(`F${index + 1}`),
        ]),
      ),
    );

    const plan = planKeybindArm(bindings);
    assert.equal(plan.kind, "arm");
    if (plan.kind !== "arm") return;

    const submitted = plan.bindings.map((entry) => entry.id);
    assert.deepEqual(submitted, GLOBAL_TIER_ACTIONS);
    for (const action of IN_APP_TIER_ACTIONS) {
      assert.ok(
        !submitted.includes(action),
        `in-app action ${action} was submitted to keybinds_arm; the native ` +
          `hook has no transient user activation to give it, and its ` +
          `failure is silent`,
      );
    }
  });

  it("keeps the submitted array DENSE, so no action_id shifts", () => {
    // The native `action_id` is the position in the submitted array. An
    // in-app action excluded by blanking rather than skipping would leave a
    // hole, and every later binding would fire under the wrong name.
    const bindings = bound(
      Object.fromEntries(
        GLOBAL_KEYBIND_ACTIONS.map((action, index) => [
          action,
          chord(`F${index + 1}`),
        ]),
      ),
    );

    const plan = planKeybindArm(bindings);
    if (plan.kind !== "arm") throw new Error("expected an arm plan");

    for (const [index, entry] of plan.bindings.entries()) {
      assert.ok(entry, `index ${index} is a hole`);
      assert.equal(typeof entry.id, "string");
      assert.equal(KEYBIND_TIER[entry.id], "global");
    }
    assert.equal(plan.bindings.length, GLOBAL_TIER_ACTIONS.length);
  });

  it("pins each submitted index to the action whose chord sits there", () => {
    // The sharper form of the same invariant: the chord at index N must be
    // the chord the user bound to the action named at index N. A blanked
    // entry passes the density check above (the array is still full) but
    // fails this one.
    const bindings = noBindings();
    for (const [index, action] of GLOBAL_KEYBIND_ACTIONS.entries()) {
      bindings[action] = chord(`F${index + 1}`);
    }

    const plan = planKeybindArm(bindings);
    if (plan.kind !== "arm") throw new Error("expected an arm plan");

    for (const entry of plan.bindings) {
      const expected = bindings[entry.id];
      assert.ok(expected);
      assert.equal(entry.code, expected.code, `code drifted for ${entry.id}`);
    }
  });

  it("an in-app binding ALONE plans a disarm, not an empty arm", () => {
    // The in-app action still works — the DOM transport carries it — but
    // there is nothing for the native hook to hold, so the hook must go.
    const plan = planKeybindArm(
      bound({ [IN_APP_TIER_ACTIONS[0]]: chord("F13") }),
    );
    assert.equal(plan.kind, "disarm");
  });

  it("no bindings at all plans a disarm", () => {
    assert.equal(planKeybindArm(noBindings()).kind, "disarm");
  });

  it("carries only the five KeybindSpec fields", () => {
    const smuggled = {
      ...chord("KeyM", { ctrl: true }),
      meta: true,
    } as unknown as Binding;
    const plan = planKeybindArm(bound({ [GLOBAL_TIER_ACTIONS[0]]: smuggled }));
    if (plan.kind !== "arm") throw new Error("expected an arm plan");

    assert.deepEqual(Object.keys(plan.bindings[0]).sort(), [
      "alt",
      "code",
      "ctrl",
      "id",
      "shift",
    ]);
  });

  it("survives an undefined entry the type says cannot exist", () => {
    const bindings = noBindings();
    bindings[GLOBAL_TIER_ACTIONS[0]] = chord("KeyM");
    // A hand-edited or future blob; `cleanKeybinds` would have replaced it,
    // but this must not become a `{ code: undefined }` spec.
    (bindings as Record<string, unknown>)[GLOBAL_TIER_ACTIONS[1]] = undefined;

    const plan = planKeybindArm(bindings);
    if (plan.kind !== "arm") throw new Error("expected an arm plan");
    assert.deepEqual(
      plan.bindings.map((entry) => entry.id),
      [GLOBAL_TIER_ACTIONS[0]],
    );
  });

  it("never submits more than the native ceiling can hold", () => {
    // Unreachable today (twelve actions, a cap of sixteen), pinned so a
    // thirteenth-plus action cannot silently produce a truncated arm.
    const bindings = bound(
      Object.fromEntries(
        GLOBAL_KEYBIND_ACTIONS.map((action, index) => [
          action,
          chord(`F${index + 1}`),
        ]),
      ),
    );
    const plan = planKeybindArm(bindings);
    if (plan.kind !== "arm") throw new Error("expected an arm plan");
    assert.ok(plan.bindings.length <= MAX_BINDINGS);
  });
});

/* ------------------------------------------------------------------------ *
 * 2. nativeAvailable — the honest derivation
 * ------------------------------------------------------------------------ */

describe("deriveNativeAvailable: an all-empty result is NOT success", () => {
  const empty = { armed: [], unsupported: [], refused: [] };

  it("is false for the off-Windows default result", () => {
    // `keybinds_arm` returns `KeybindsArmResult::default()` off Windows —
    // all three lists empty, AND NO ERROR. A caller that only checked for a
    // throw would show every row as working while nothing fires.
    assert.equal(deriveNativeAvailable(3, empty), false);
  });

  it("is false when nothing was submitted, however the result looks", () => {
    assert.equal(deriveNativeAvailable(0, empty), false);
    assert.equal(
      deriveNativeAvailable(0, { ...empty, armed: ["toggle-mute"] }),
      false,
    );
  });

  it("is true on positive armed membership", () => {
    assert.equal(
      deriveNativeAvailable(1, { ...empty, armed: ["toggle-mute"] }),
      true,
    );
  });

  it("is true when the only reply is unsupported or refused", () => {
    // Both lists are produced only by the Windows implementation walking the
    // submitted specs, so an id in either proves native read the payload. A
    // shell where every bound key happens to be unbindable is still a shell
    // with a keybind layer.
    assert.equal(
      deriveNativeAvailable(1, { ...empty, unsupported: ["toggle-mute"] }),
      true,
    );
    assert.equal(
      deriveNativeAvailable(1, { ...empty, refused: ["toggle-mute"] }),
      true,
    );
  });
});

describe("armStateFromResult", () => {
  it("marks the state probed even when the invoke produced nothing", () => {
    const state = armStateFromResult([{}, {}], undefined, true);
    assert.equal(state.probed, true);
    assert.equal(state.nativeAvailable, false);
    assert.deepEqual(state.armed, []);
    assert.deepEqual(state.unsupported, []);
    assert.deepEqual(state.refused, []);
  });

  it("publishes the three lists narrowed to known actions", () => {
    const state = armStateFromResult(
      [{}, {}, {}],
      {
        armed: ["toggle-mute", "not-an-action", 7, null],
        unsupported: ["toggle-deafen"],
        refused: ["toggle-camera"],
      },
      true,
    );
    assert.deepEqual(state.armed, ["toggle-mute"]);
    assert.deepEqual(state.unsupported, ["toggle-deafen"]);
    assert.deepEqual(state.refused, ["toggle-camera"]);
    assert.equal(state.nativeAvailable, true);
  });

  it("drops an id from a stale arm this build no longer knows", () => {
    // The race `isGlobalKeybindAction` exists for: a stale `keybinds_arm`
    // echoing an action a later build dropped. Carried into the published
    // state it would index KEYBIND_TIER to `undefined` in the settings page.
    const state = armStateFromResult(
      [{}],
      { armed: ["toggle-telepathy"] },
      true,
    );
    assert.deepEqual(state.armed, []);
    assert.equal(state.nativeAvailable, false);
  });

  it("tolerates a non-array list and a non-object result", () => {
    const fromString = armStateFromResult([{}], { armed: "toggle-mute" }, true);
    assert.deepEqual(fromString.armed, []);

    const fromScalar = armStateFromResult([{}], 42, true);
    assert.equal(fromScalar.probed, true);
    assert.deepEqual(fromScalar.armed, []);
  });

  it("collapses a duplicated id", () => {
    const state = armStateFromResult(
      [{}, {}],
      { armed: ["toggle-mute", "toggle-mute"] },
      true,
    );
    assert.deepEqual(state.armed, ["toggle-mute"]);
  });

  it("carries `bridge` through verbatim, true and false", () => {
    // The page's one entitled negative. It is not derived from the result —
    // a bridged invoke that throws still had a bridge — so the caller's
    // answer must survive untouched in both directions.
    const bridged = armStateFromResult([{}], { armed: ["toggle-mute"] }, true);
    assert.equal(bridged.bridge, true);

    const unbridged = armStateFromResult(
      [{}],
      { armed: ["toggle-mute"] },
      false,
    );
    assert.equal(unbridged.bridge, false);
  });

  it("publishes `submitted` as the length of the array it was handed", () => {
    assert.equal(armStateFromResult([], undefined, true).submitted, 0);
    assert.equal(armStateFromResult([{}], undefined, true).submitted, 1);
    assert.equal(
      armStateFromResult([{}, {}, {}], { armed: ["toggle-mute"] }, true)
        .submitted,
      3,
    );
  });

  it("🔴 the bridged disarm is the UNKNOWN shape, not a negative", () => {
    // The shipped default: zero bindings, so the worker disarms and publishes
    // this. `nativeAvailable` is honestly `false` (nothing was submitted, so
    // nothing could prove a layer), but `bridge: true` with `submitted: 0`
    // is what tells the page there is no evidence YET — reading it as
    // "absent" locked every row's capture on every platform and made the
    // first global key unbindable, Windows desktop included.
    const state = armStateFromResult([], undefined, true);
    assert.equal(state.probed, true);
    assert.equal(state.nativeAvailable, false);
    assert.equal(state.bridge, true);
    assert.equal(state.submitted, 0);
  });

  it("an unbridged disarm publishes `bridge: false` — proven absent", () => {
    // No invoke bridge at all (a plain browser tab): nothing can ever arm
    // from this build, and the page may say so outright.
    const state = armStateFromResult([], undefined, false);
    assert.equal(state.probed, true);
    assert.equal(state.nativeAvailable, false);
    assert.equal(state.bridge, false);
    assert.equal(state.submitted, 0);
  });

  it("is distinguishable from the unprobed constant", () => {
    assert.equal(UNPROBED_KEYBIND_ARM_STATE.probed, false);
    assert.equal(UNPROBED_KEYBIND_ARM_STATE.nativeAvailable, false);
    assert.equal(UNPROBED_KEYBIND_ARM_STATE.bridge, false);
    assert.equal(UNPROBED_KEYBIND_ARM_STATE.submitted, 0);
    assert.notEqual(
      armStateFromResult([], undefined, true).probed,
      UNPROBED_KEYBIND_ARM_STATE.probed,
    );
  });
});

/* ------------------------------------------------------------------------ *
 * 3. The held-set
 * ------------------------------------------------------------------------ */

describe("applyKeybindHeldEvent: down/up edges", () => {
  const ACTION: GlobalKeybindAction = "toggle-mute";
  const OTHER: GlobalKeybindAction = "toggle-deafen";

  it("dispatches a first down and records it as held", () => {
    const verdict = applyKeybindHeldEvent(new Set(), {
      kind: "down",
      id: ACTION,
    });
    assert.equal(verdict.dispatch, ACTION);
    assert.equal(verdict.reason, null);
    assert.deepEqual([...verdict.held], [ACTION]);
  });

  it("drops a second down for an action already held", () => {
    // Auto-repeat on the DOM transport, and the second transport's copy of a
    // press made while focused.
    const verdict = applyKeybindHeldEvent(new Set([ACTION]), {
      kind: "down",
      id: ACTION,
    });
    assert.equal(verdict.dispatch, null);
    assert.equal(verdict.reason, "already-down");
    assert.deepEqual([...verdict.held], [ACTION]);
  });

  it("clears the record on an up for a held action", () => {
    const verdict = applyKeybindHeldEvent(new Set([ACTION, OTHER]), {
      kind: "up",
      id: ACTION,
    });
    assert.equal(verdict.reason, "press-edge-only");
    assert.deepEqual([...verdict.held], [OTHER]);
  });

  it("dispatches NOTHING on an up — every action is press-edge", () => {
    // `Voice.dispatchKeybind()` takes an action and no edge, and
    // `#runKeybind` routes all twelve to a toggle or a one-shot. Dispatching
    // on the release would fire each keybind twice per press, and past
    // KEYBIND_MIN_INTERVAL_MS the rate limit would not absorb it: mute, then
    // unmute.
    const verdict = applyKeybindHeldEvent(new Set([ACTION]), {
      kind: "up",
      id: ACTION,
    });
    assert.equal(verdict.dispatch, null);
  });

  it("🔴 drops an up for an action never recorded down", () => {
    // `bindingMatchesRelease` compares the physical key ALONE, so one
    // release matches every binding on that key — including ones pressed
    // with the wrong modifiers that never matched. Without this gate that
    // release would emit an up for a binding that was never pressed.
    const verdict = applyKeybindHeldEvent(new Set([OTHER]), {
      kind: "up",
      id: ACTION,
    });
    assert.equal(verdict.dispatch, null);
    assert.equal(verdict.reason, "not-down");
    assert.deepEqual([...verdict.held], [OTHER]);
  });

  it("gives an up-after-teardown no second edge", () => {
    const released = applyKeybindHeldEvent(new Set([ACTION]), {
      kind: "up",
      id: ACTION,
    });
    const again = applyKeybindHeldEvent(released.held, {
      kind: "up",
      id: ACTION,
    });
    assert.equal(again.reason, "not-down");
  });

  it("drops an unknown id on both edges without touching the set", () => {
    // A stale `keybinds_arm` can name an action this build dropped. Indexing
    // KEYBIND_REQUIREMENT with it reads `undefined` as "no precondition".
    for (const kind of ["down", "up"] as const) {
      const verdict = applyKeybindHeldEvent(new Set([ACTION]), {
        kind,
        id: "toggle-telepathy",
      });
      assert.equal(verdict.dispatch, null);
      assert.equal(verdict.reason, "unknown-id");
      assert.deepEqual([...verdict.held], [ACTION]);
    }
  });

  it("drops a malformed empty id", () => {
    const verdict = applyKeybindHeldEvent(new Set(), { kind: "down", id: "" });
    assert.equal(verdict.dispatch, null);
    assert.equal(verdict.reason, "unknown-id");
  });

  it("never mutates the set it was given", () => {
    const held = new Set<GlobalKeybindAction>([ACTION]);
    applyKeybindHeldEvent(held, { kind: "down", id: OTHER });
    applyKeybindHeldEvent(held, { kind: "up", id: ACTION });
    applyKeybindHeldEvent(held, { kind: "release-all" });
    assert.deepEqual([...held], [ACTION]);
  });
});

describe("applyKeybindHeldEvent: release-all is the arm/disarm contract", () => {
  it("empties the set whatever was held", () => {
    const verdict = applyKeybindHeldEvent(
      new Set<GlobalKeybindAction>(["toggle-mute", "toggle-deafen"]),
      { kind: "release-all" },
    );
    assert.equal(verdict.dispatch, null);
    assert.equal(verdict.reason, null);
    assert.deepEqual([...verdict.held], []);
  });

  it("🔴 a key held across an arm does NOT stay logically down", () => {
    // `keybinds_arm` clears the whole native down-word and emits no
    // synthetic `keybind:up`, so the release is never coming. Without the
    // release-all the action stays recorded as down and its NEXT press is
    // dropped as "already-down" — a keybind dead for the session because the
    // settings page saved an unrelated row while the key was held.
    const held = new Set<GlobalKeybindAction>(["toggle-mute"]);

    const afterArm = applyKeybindHeldEvent(held, { kind: "release-all" });
    assert.deepEqual([...afterArm.held], []);

    const nextPress = applyKeybindHeldEvent(afterArm.held, {
      kind: "down",
      id: "toggle-mute",
    });
    assert.equal(
      nextPress.dispatch,
      "toggle-mute",
      "the press after a re-arm must dispatch; a stale held bit makes the " +
        "keybind permanently dead",
    );
  });

  it("is idempotent, so an arm and a disarm can both send it", () => {
    const once = applyKeybindHeldEvent(new Set(["toggle-mute"]), {
      kind: "release-all",
    });
    const twice = applyKeybindHeldEvent(once.held, { kind: "release-all" });
    assert.deepEqual([...twice.held], []);
  });

  it("leaves the native up that never comes with nothing to clear", () => {
    const afterArm = applyKeybindHeldEvent(new Set(["toggle-mute"]), {
      kind: "release-all",
    });
    const strayUp = applyKeybindHeldEvent(afterArm.held, {
      kind: "up",
      id: "toggle-mute",
    });
    assert.equal(strayUp.reason, "not-down");
    assert.equal(strayUp.dispatch, null);
  });
});

/* ------------------------------------------------------------------------ *
 * 4. The DOM match
 * ------------------------------------------------------------------------ */

describe("matchDomKey: suppression", () => {
  const MUTE = chord("KeyM", { alt: true });
  const bindings = bound({ "toggle-mute": MUTE });

  it("🔴 matches nothing while a remote-control session owns the keyboard", () => {
    // Injected input reaches the webview as an ordinary keydown — the native
    // path filters it by `RC_INJECT_EXTRA`, this one cannot. Without the
    // check a remote controller typing on the sharer's machine can hang up
    // the sharer's call.
    const verdict = matchDomKey({
      bindings,
      event: pressOf(MUTE),
      edge: "down",
      suppressed: true,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, []);
    assert.equal(verdict.reason, "suppressed");
  });

  it("suppresses the release edge too", () => {
    const verdict = matchDomKey({
      bindings,
      event: pressOf(MUTE),
      edge: "up",
      suppressed: true,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, []);
    assert.equal(verdict.reason, "suppressed");
  });

  it("matches the same press once suppression lifts", () => {
    const verdict = matchDomKey({
      bindings,
      event: pressOf(MUTE),
      edge: "down",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, ["toggle-mute"]);
    assert.equal(verdict.reason, null);
  });
});

describe("matchDomKey: presses match modifiers EXACTLY", () => {
  const MUTE = chord("KeyM", { alt: true });
  const bindings = bound({ "toggle-mute": MUTE });

  it("matches the exact chord", () => {
    assert.deepEqual(
      matchDomKey({
        bindings,
        event: pressOf(MUTE),
        edge: "down",
        suppressed: false,
        repeat: false,
      }).actions,
      ["toggle-mute"],
    );
  });

  it("does not fire on a SUPERSET chord", () => {
    // Bind Alt+KeyM loosely and it would also fire on Ctrl+Alt+Shift+KeyM,
    // which belongs to whatever the user is actually typing into.
    for (const extra of [
      { ctrlKey: true },
      { shiftKey: true },
      { ctrlKey: true, shiftKey: true },
    ]) {
      const verdict = matchDomKey({
        bindings,
        event: { ...pressOf(MUTE), ...extra },
        edge: "down",
        suppressed: false,
        repeat: false,
      });
      assert.deepEqual(verdict.actions, []);
    }
  });

  it("does not fire with a modifier missing", () => {
    const verdict = matchDomKey({
      bindings,
      event: { ...pressOf(MUTE), altKey: false },
      edge: "down",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, []);
  });

  it("does not fire on a different physical key", () => {
    const verdict = matchDomKey({
      bindings,
      event: { ...pressOf(MUTE), code: "KeyN" },
      edge: "down",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, []);
  });

  it("drops an auto-repeat press", () => {
    // A focused keydown repeats at the OS rate (~20/s past a ~250 ms delay).
    // The native transport collapses repeat twice; this one has to.
    const verdict = matchDomKey({
      bindings,
      event: pressOf(MUTE),
      edge: "down",
      suppressed: false,
      repeat: true,
    });
    assert.deepEqual(verdict.actions, []);
    assert.equal(verdict.reason, "auto-repeat");
  });

  it("matches nothing when nothing is bound", () => {
    const verdict = matchDomKey({
      bindings: noBindings(),
      event: pressOf(MUTE),
      edge: "down",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, []);
    assert.equal(verdict.reason, null);
  });

  it("carries NO tier filter — in-app actions are this transport's job", () => {
    // The only path that can give `getDisplayMedia` / `requestFullscreen`
    // transient user activation. A tier filter copied here from
    // `planKeybindArm` would make those bindings dead everywhere.
    const action = IN_APP_TIER_ACTIONS[0];
    const verdict = matchDomKey({
      bindings: bound({ [action]: MUTE }),
      event: pressOf(MUTE),
      edge: "down",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, [action]);
  });
});

describe("matchDomKey: releases match on `code` ALONE", () => {
  const MUTE = chord("KeyM", { ctrl: true });
  const bindings = bound({ "toggle-mute": MUTE });

  it("🔴 matches a release whose modifiers were freed first", () => {
    // Users unroll a chord in whatever order their hand does, and letting go
    // of Ctrl before the letter is the common one. Under exact equality this
    // release fails the comparison and the action never gets its up edge —
    // it latches down.
    const verdict = matchDomKey({
      bindings,
      event: { code: "KeyM", ctrlKey: false, shiftKey: false, altKey: false },
      edge: "up",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, ["toggle-mute"]);
  });

  it("does not match a release of a different physical key", () => {
    const verdict = matchDomKey({
      bindings,
      event: { code: "KeyN", ctrlKey: true, shiftKey: false, altKey: false },
      edge: "up",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, []);
  });

  it("ignores `repeat` on a release", () => {
    const verdict = matchDomKey({
      bindings,
      event: pressOf(MUTE),
      edge: "up",
      suppressed: false,
      repeat: true,
    });
    assert.deepEqual(verdict.actions, ["toggle-mute"]);
  });

  it("ends BOTH bindings sharing one physical key", () => {
    // The residual `../state/stores/Keybinds.ts` records as known and
    // accepted: `Alt+KeyM` alongside `Ctrl+Alt+KeyM` is a legitimate pair
    // (press matching is exact, so they never both fire on a press), and
    // releasing the letter ends both. The held-set is what keeps the
    // never-pressed one from emitting a spurious up.
    const verdict = matchDomKey({
      bindings: bound({
        "toggle-mute": chord("KeyM", { alt: true }),
        "toggle-deafen": chord("KeyM", { ctrl: true, alt: true }),
      }),
      event: { code: "KeyM", ctrlKey: false, shiftKey: false, altKey: false },
      edge: "up",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, ["toggle-mute", "toggle-deafen"]);
  });

  it("reports matches in declared action order", () => {
    // Deterministic because GLOBAL_KEYBIND_ACTIONS drives the walk, never
    // the record's own key order.
    const verdict = matchDomKey({
      bindings: bound({
        "toggle-deafen": chord("KeyM", { ctrl: true }),
        "toggle-mute": chord("KeyM", { alt: true }),
      }),
      event: { code: "KeyM", ctrlKey: false, shiftKey: false, altKey: false },
      edge: "up",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(verdict.actions, ["toggle-mute", "toggle-deafen"]);
  });
});

/* ------------------------------------------------------------------------ *
 * 5. The two transports end-to-end, over the pure decisions
 * ------------------------------------------------------------------------ */

describe("both transports, one held-set", () => {
  const MUTE = chord("KeyM", { alt: true });
  const bindings = bound({ "toggle-mute": MUTE });

  /** Feed a DOM keystroke through both decisions, as the worker does. */
  function domEdge(
    held: ReadonlySet<GlobalKeybindAction>,
    edge: "down" | "up",
    suppressed = false,
    repeat = false,
  ) {
    const { actions } = matchDomKey({
      bindings,
      event: pressOf(MUTE),
      edge,
      suppressed,
      repeat,
    });
    let dispatched: GlobalKeybindAction[] = [];
    let next = held;
    for (const action of actions) {
      const verdict = applyKeybindHeldEvent(next, { kind: edge, id: action });
      next = verdict.held;
      if (verdict.dispatch) dispatched = [...dispatched, verdict.dispatch];
    }
    return { held: next, dispatched };
  }

  it("dispatches a focused press exactly once", () => {
    const pressed = domEdge(new Set(), "down");
    assert.deepEqual(pressed.dispatched, ["toggle-mute"]);
    assert.deepEqual([...pressed.held], ["toggle-mute"]);
  });

  it("🔴 dispatches nothing while suppressed, even on a real chord", () => {
    const suppressedPress = domEdge(new Set(), "down", true);
    assert.deepEqual(
      suppressedPress.dispatched,
      [],
      "a remote controller's keystroke reached voice.dispatchKeybind",
    );
    assert.deepEqual([...suppressedPress.held], []);
  });

  it("collapses the native copy of a press the DOM path already took", () => {
    const pressed = domEdge(new Set(), "down");
    const nativeCopy = applyKeybindHeldEvent(pressed.held, {
      kind: "down",
      id: "toggle-mute",
    });
    assert.equal(nativeCopy.dispatch, null);
    assert.equal(nativeCopy.reason, "already-down");
  });

  it("lets a DOM release clear a native-originated hold", () => {
    // Pressed while unfocused (native down), released after alt-tabbing INTO
    // Sloga: the hook is blind while focused so no native up is coming, and
    // the shared held-set is what lets the DOM keyup clear it. With two sets
    // this hold would latch and the action would be dead.
    const nativeDown = applyKeybindHeldEvent(new Set(), {
      kind: "down",
      id: "toggle-mute",
    });
    assert.deepEqual([...nativeDown.held], ["toggle-mute"]);

    const domRelease = domEdge(nativeDown.held, "up");
    assert.deepEqual([...domRelease.held], []);

    const nextPress = domEdge(domRelease.held, "down");
    assert.deepEqual(nextPress.dispatched, ["toggle-mute"]);
  });

  it("recovers from a suppression edge taken mid-hold", () => {
    // Held going into a remote-control session: the release is swallowed, so
    // the worker's release-all on the suppression edge is the only thing
    // that stops the action being dead afterwards.
    const pressed = domEdge(new Set(), "down");
    const cleared = applyKeybindHeldEvent(pressed.held, {
      kind: "release-all",
    });
    const afterSession = domEdge(cleared.held, "down");
    assert.deepEqual(afterSession.dispatched, ["toggle-mute"]);
  });

  it("recovers from a blur taken mid-hold", () => {
    // A DOM keyup goes only to the focused window, and the native hook
    // emitted no down while we were focused, so neither edge is coming.
    const pressed = domEdge(new Set(), "down");
    const cleared = applyKeybindHeldEvent(pressed.held, {
      kind: "release-all",
    });
    assert.deepEqual([...cleared.held], []);
    assert.deepEqual(domEdge(cleared.held, "down").dispatched, ["toggle-mute"]);
  });

  it("drops an auto-repeat run to a single dispatch", () => {
    let held: ReadonlySet<GlobalKeybindAction> = new Set();
    const dispatched: GlobalKeybindAction[] = [];

    const first = domEdge(held, "down");
    held = first.held;
    dispatched.push(...first.dispatched);
    for (let i = 0; i < 20; i++) {
      const repeatEdge = domEdge(held, "down", false, true);
      held = repeatEdge.held;
      dispatched.push(...repeatEdge.dispatched);
    }
    assert.deepEqual(dispatched, ["toggle-mute"]);
  });
});

/* ------------------------------------------------------------------------ *
 * 6. A modifier as the bound key
 * ------------------------------------------------------------------------ */

describe("matchDomKey: a modifier as the bound key", () => {
  // `bindingMatchesPress` skips the ONE flag the binding's own key sets
  // (`selfModifier` in ./globalKeybinds.ts) and compares the other two
  // exactly. `matchDomKey` calls it unchanged on the "down" edge, so this
  // transport inherits the rule with no change of its own — which is why it
  // is pinned here as well: a leaf that stopped delegating would keep the
  // predicate's own specs green and make every modifier-keyed binding dead
  // on the focused transport.
  const BARE_SHIFT = chord("ShiftLeft");
  const CTRL_SHIFT = chord("ShiftLeft", { ctrl: true });
  const SHIFT_CTRL = chord("ControlLeft", { shift: true });

  /** A `ShiftLeft` keydown as the DOM delivers it: its own flag is set. */
  const SHIFT_DOWN = {
    code: "ShiftLeft",
    ctrlKey: false,
    shiftKey: true,
    altKey: false,
  };

  function press(
    bindings: Record<GlobalKeybindAction, Binding | null>,
    event: ReturnType<typeof pressOf>,
    repeat = false,
  ) {
    return matchDomKey({
      bindings,
      event,
      edge: "down",
      suppressed: false,
      repeat,
    });
  }

  it("🔴 a bare Shift binding matches the keydown Shift itself sends", () => {
    // A modifier's own keydown always carries its flag — ShiftLeft arrives
    // with `shiftKey: true` — while the stored binding is the normalized
    // `{ shift: false }`. Under exact equality on all three flags that is a
    // mismatch, and a bare Shift binding can never fire on its own key.
    const verdict = press(bound({ "toggle-mute": BARE_SHIFT }), SHIFT_DOWN);
    assert.deepEqual(verdict.actions, ["toggle-mute"]);
    assert.equal(verdict.reason, null);
  });

  it("matches the same binding with its own flag clear too", () => {
    // The own flag is not compared at all — not "compared as true". A
    // keydown that omits it still matches.
    const verdict = press(bound({ "toggle-mute": BARE_SHIFT }), {
      ...SHIFT_DOWN,
      shiftKey: false,
    });
    assert.deepEqual(verdict.actions, ["toggle-mute"]);
  });

  it("🔴 Ctrl+Shift needs Ctrl held and refuses Alt, whatever shiftKey says", () => {
    const bindings = bound({ "toggle-mute": CTRL_SHIFT });
    for (const shiftKey of [true, false]) {
      assert.deepEqual(
        press(bindings, { ...SHIFT_DOWN, shiftKey, ctrlKey: true }).actions,
        ["toggle-mute"],
        `ctrlKey held, shiftKey ${shiftKey}`,
      );
      assert.deepEqual(
        press(bindings, { ...SHIFT_DOWN, shiftKey, ctrlKey: false }).actions,
        [],
        `ctrlKey missing, shiftKey ${shiftKey}`,
      );
      assert.deepEqual(
        press(bindings, {
          ...SHIFT_DOWN,
          shiftKey,
          ctrlKey: true,
          altKey: true,
        }).actions,
        [],
        `altKey extra, shiftKey ${shiftKey}`,
      );
    }
  });

  it("🔴 bare Shift and Ctrl+Shift on two actions: Ctrl picks exactly one", () => {
    // The two flags that ARE compared keep the press exact, so the bare one
    // never fires under Ctrl and the chorded one never fires without it —
    // one action per press, as for any other pair of chords on one key.
    const bindings = bound({
      "toggle-mute": BARE_SHIFT,
      "toggle-deafen": CTRL_SHIFT,
    });
    assert.deepEqual(press(bindings, SHIFT_DOWN).actions, ["toggle-mute"]);
    assert.deepEqual(
      press(bindings, { ...SHIFT_DOWN, ctrlKey: true }).actions,
      ["toggle-deafen"],
    );
  });

  it("🔴 Ctrl+Shift and Shift+Ctrl are two bindings, each on its own gesture", () => {
    // The key of a modifier-keyed chord is the modifier pressed LAST, so the
    // same two keys held produce two different keydowns depending on the
    // order, and each binding answers exactly one of them.
    const bindings = bound({
      "toggle-mute": SHIFT_CTRL,
      "toggle-deafen": CTRL_SHIFT,
    });
    // Ctrl held, then Shift pressed.
    assert.deepEqual(
      press(bindings, { ...SHIFT_DOWN, ctrlKey: true }).actions,
      ["toggle-deafen"],
    );
    // Shift held, then Ctrl pressed.
    assert.deepEqual(
      press(bindings, {
        code: "ControlLeft",
        ctrlKey: true,
        shiftKey: true,
        altKey: false,
      }).actions,
      ["toggle-mute"],
    );
  });

  it("a regular key still refuses a press with an extra modifier", () => {
    // The relaxation is for the binding's OWN key only. A bare KeyM binding
    // under Shift is still the superset case: exact on all three flags.
    const verdict = press(bound({ "toggle-mute": chord("KeyM") }), {
      code: "KeyM",
      ctrlKey: false,
      shiftKey: true,
      altKey: false,
    });
    assert.deepEqual(verdict.actions, []);
    assert.equal(verdict.reason, null);
  });

  it("releases a modifier key on `code` alone, whatever the flags", () => {
    const bindings = bound({ "toggle-mute": CTRL_SHIFT });
    for (const flags of [
      { ctrlKey: false, shiftKey: false, altKey: false },
      { ctrlKey: true, shiftKey: true, altKey: true },
      { ctrlKey: false, shiftKey: true, altKey: false },
    ]) {
      const verdict = matchDomKey({
        bindings,
        event: { code: "ShiftLeft", ...flags },
        edge: "up",
        suppressed: false,
        repeat: false,
      });
      assert.deepEqual(verdict.actions, ["toggle-mute"]);
      assert.equal(verdict.reason, null);
    }
  });

  it("drops an auto-repeat modifier press like any other key", () => {
    // A held Shift repeats its keydown at the OS rate exactly as a letter
    // does; nothing about being a modifier exempts it from the collapse.
    const verdict = press(
      bound({ "toggle-mute": BARE_SHIFT }),
      SHIFT_DOWN,
      true,
    );
    assert.deepEqual(verdict.actions, []);
    assert.equal(verdict.reason, "auto-repeat");
  });

  it("walks the held-set as a letter does: dispatch on down, none on up", () => {
    const bindings = bound({ "toggle-mute": BARE_SHIFT });

    const pressed = press(bindings, SHIFT_DOWN);
    assert.deepEqual(pressed.actions, ["toggle-mute"]);
    const down = applyKeybindHeldEvent(new Set(), {
      kind: "down",
      id: "toggle-mute",
    });
    assert.equal(down.dispatch, "toggle-mute");
    assert.equal(down.reason, null);
    assert.deepEqual([...down.held], ["toggle-mute"]);

    // Shift's own keyup arrives with `shiftKey: false`.
    const released = matchDomKey({
      bindings,
      event: { ...SHIFT_DOWN, shiftKey: false },
      edge: "up",
      suppressed: false,
      repeat: false,
    });
    assert.deepEqual(released.actions, ["toggle-mute"]);
    const up = applyKeybindHeldEvent(down.held, {
      kind: "up",
      id: "toggle-mute",
    });
    assert.equal(up.dispatch, null);
    assert.equal(up.reason, "press-edge-only");
    assert.deepEqual([...up.held], []);
  });
});
