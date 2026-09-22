/**
 * Run with:
 *
 *     node --conditions=browser --test components/app/interface/settings/user/keybindRowPolicy.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests — without
 * it Node resolves solid-js's server build and effect-based specs silently
 * pass against broken code. This file is pure and unaffected, but one
 * invocation should cover it and the reactive suites together.)
 *
 * These are the decisions behind the global keybinds settings page
 * (`./Keybinds.tsx`), which is a `.tsx` reaching `solid-js`, `@revolt/ui` and
 * `@revolt/state` and therefore loadable by no unit runner at all. Each
 * `describe` below names the decision and the production failure it prevents.
 *
 * The one that matters most is pinned by name: **"zero bindings on a bridged
 * shell leaves every global row unclaimed and capture open"**. That is the
 * shipped default, and the page used to read it as "no native hook here" and
 * lock every global row on every platform — so no first key could ever be
 * bound to produce the evidence that would have unlocked them.
 *
 * The bridge check, the `submitted > 0` separation and the refusal-first
 * order each have a known-bad control recorded in the lane report: removing
 * any one of them must turn a spec here red.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_TIER,
} from "../../../../keybinds/globalKeybinds.ts";
import {
  type KeybindArmState,
  UNPROBED_KEYBIND_ARM_STATE,
} from "../../../../keybinds/keybindWorkerPolicy.ts";

import {
  type GlobalTierStatus,
  type KeybindRowStatus,
  GLOBAL_TIER_ACTIONS,
  IN_APP_TIER_ACTIONS,
  blocksCapture,
  blocksClear,
  globalTierStatus,
  keybindRowStatus,
} from "./keybindRowPolicy.ts";

/* ------------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------------ */

/**
 * An arm state, starting from the BRIDGED DISARM — the shipped default with
 * zero bindings on a shell that has an invoke bridge.
 *
 * The base is a full literal typed as `KeybindArmState`, so a field the type
 * gains later is a compile error here rather than a silent `undefined` that
 * every spec would read as falsy.
 */
function arm(overrides: Partial<KeybindArmState> = {}): KeybindArmState {
  const base: KeybindArmState = {
    probed: true,
    nativeAvailable: false,
    bridge: true,
    submitted: 0,
    armed: [],
    unsupported: [],
    refused: [],
  };
  return { ...base, ...overrides };
}

/** The first action on each side of the split; the guard below proves both exist. */
const GLOBAL_ACTION = GLOBAL_TIER_ACTIONS[0] as GlobalKeybindAction;
const IN_APP_ACTION = IN_APP_TIER_ACTIONS[0] as GlobalKeybindAction;

/** Every row status, so an enumeration cannot silently miss one. */
const EVERY_ROW_STATUS: readonly KeybindRowStatus[] = [
  "unsupported",
  "refused",
  "probing",
  "unavailable",
  "armed",
  "unclaimed",
];

/* ------------------------------------------------------------------------ *
 * The tier split
 * ------------------------------------------------------------------------ */

describe("tier lists: derived from KEYBIND_TIER, not written twice", () => {
  it("has both tiers populated, or the rest of this suite proves nothing", () => {
    assert.ok(GLOBAL_TIER_ACTIONS.length > 0, "no global-tier action");
    assert.ok(IN_APP_TIER_ACTIONS.length > 0, "no in-app-tier action");
  });

  it("agrees with the tier table member by member", () => {
    for (const action of GLOBAL_TIER_ACTIONS) {
      assert.equal(KEYBIND_TIER[action], "global", action);
    }
    for (const action of IN_APP_TIER_ACTIONS) {
      assert.equal(KEYBIND_TIER[action], "in-app", action);
    }
  });

  it("is disjoint", () => {
    for (const action of GLOBAL_TIER_ACTIONS) {
      assert.ok(!IN_APP_TIER_ACTIONS.includes(action), action);
    }
  });

  it("covers GLOBAL_KEYBIND_ACTIONS exactly, as a set", () => {
    const union = new Set([...GLOBAL_TIER_ACTIONS, ...IN_APP_TIER_ACTIONS]);
    assert.deepEqual(union, new Set(GLOBAL_KEYBIND_ACTIONS));
    assert.equal(
      GLOBAL_TIER_ACTIONS.length + IN_APP_TIER_ACTIONS.length,
      GLOBAL_KEYBIND_ACTIONS.length,
    );
  });

  it("keeps GLOBAL_KEYBIND_ACTIONS order within each list", () => {
    const indexOf = (action: GlobalKeybindAction) =>
      GLOBAL_KEYBIND_ACTIONS.indexOf(action);
    for (const list of [GLOBAL_TIER_ACTIONS, IN_APP_TIER_ACTIONS]) {
      for (let i = 1; i < list.length; i++) {
        assert.ok(indexOf(list[i - 1]) < indexOf(list[i]), list[i]);
      }
    }
  });
});

/* ------------------------------------------------------------------------ *
 * globalTierStatus
 * ------------------------------------------------------------------------ */

describe("globalTierStatus: every branch, in contract order", () => {
  /**
   * The four fields the function reads, written out in full on every row so
   * the precedence being proved is visible in the spec, not hidden in
   * `arm()`'s defaults. The three lists are left at their defaults: the
   * function does not read them (proved last).
   */
  function expectTier(
    state: Pick<
      KeybindArmState,
      "probed" | "bridge" | "nativeAvailable" | "submitted"
    >,
    expected: GlobalTierStatus,
  ) {
    assert.equal(globalTierStatus(arm(state)), expected);
  }

  it("unprobed → probing", () => {
    expectTier(
      { probed: false, bridge: true, nativeAvailable: false, submitted: 0 },
      "probing",
    );
  });

  it("unprobed with no bridge → probing (probed precedes bridge)", () => {
    expectTier(
      { probed: false, bridge: false, nativeAvailable: false, submitted: 0 },
      "probing",
    );
  });

  it("unprobed with stale evidence → probing (probed precedes everything)", () => {
    expectTier(
      { probed: false, bridge: true, nativeAvailable: true, submitted: 3 },
      "probing",
    );
  });

  it("no bridge, nothing submitted → unavailable", () => {
    expectTier(
      { probed: true, bridge: false, nativeAvailable: false, submitted: 0 },
      "unavailable",
    );
  });

  it("no bridge with evidence → unavailable (bridge precedes evidence)", () => {
    expectTier(
      { probed: true, bridge: false, nativeAvailable: true, submitted: 3 },
      "unavailable",
    );
  });

  it("no bridge, submitted → unavailable", () => {
    expectTier(
      { probed: true, bridge: false, nativeAvailable: false, submitted: 3 },
      "unavailable",
    );
  });

  it("bridged, nothing submitted, no evidence → unproven", () => {
    expectTier(
      { probed: true, bridge: true, nativeAvailable: false, submitted: 0 },
      "unproven",
    );
  });

  it("bridged, submitted, no evidence → unavailable", () => {
    expectTier(
      { probed: true, bridge: true, nativeAvailable: false, submitted: 2 },
      "unavailable",
    );
  });

  it("bridged, submitted, evidence → available", () => {
    expectTier(
      { probed: true, bridge: true, nativeAvailable: true, submitted: 2 },
      "available",
    );
  });

  it("bridged, evidence with a zero count → available (evidence precedes count)", () => {
    expectTier(
      { probed: true, bridge: true, nativeAvailable: true, submitted: 0 },
      "available",
    );
  });

  it("reads the pre-mount constant as probing", () => {
    assert.equal(globalTierStatus(UNPROBED_KEYBIND_ARM_STATE), "probing");
  });

  it("🔴 reads the bridged disarm — the shipped default — as unproven, never unavailable", () => {
    // `arm()` with no overrides IS the bridged disarm; spelled out anyway so
    // this spec does not depend on the fixture's defaults staying that way.
    const disarm = arm({
      probed: true,
      bridge: true,
      nativeAvailable: false,
      submitted: 0,
      armed: [],
      unsupported: [],
      refused: [],
    });
    assert.equal(globalTierStatus(disarm), "unproven");
  });

  it("ignores the three lists entirely — evidence is `nativeAvailable`, not list length", () => {
    // A torn state: names in a list but `nativeAvailable` false. The worker
    // derives `nativeAvailable` FROM the lists, so this cannot happen from
    // `armStateFromResult`; the point is that this function does not
    // re-derive it, so there is one place that decides what evidence is.
    const torn = arm({
      probed: true,
      bridge: true,
      nativeAvailable: false,
      submitted: 0,
      armed: [GLOBAL_ACTION],
    });
    assert.equal(globalTierStatus(torn), "unproven");
  });
});

/* ------------------------------------------------------------------------ *
 * keybindRowStatus
 * ------------------------------------------------------------------------ */

describe("keybindRowStatus: the deadlock", () => {
  it("🔴 zero bindings on a bridged shell leaves every global row unclaimed and capture open", () => {
    // The disarm path publishes exactly this: probed, bridge present,
    // nothing submitted, no evidence. It is the state of every fresh
    // install, on every platform, including the Windows desktop app whose
    // native layer is fully working and has simply not been asked yet.
    const disarm = arm({
      probed: true,
      bridge: true,
      nativeAvailable: false,
      submitted: 0,
      armed: [],
      unsupported: [],
      refused: [],
    });
    for (const action of GLOBAL_TIER_ACTIONS) {
      const status = keybindRowStatus(action, disarm);
      assert.equal(status, "unclaimed", action);
      assert.equal(blocksCapture(status), false, action);
    }
  });

  it("no bridge locks every global row", () => {
    const unbridged = arm({ probed: true, bridge: false, submitted: 0 });
    for (const action of GLOBAL_TIER_ACTIONS) {
      const status = keybindRowStatus(action, unbridged);
      assert.equal(status, "unavailable", action);
      assert.equal(blocksCapture(status), true, action);
    }
  });

  it("a bridged arm that submitted and produced no evidence locks every global row", () => {
    const silent = arm({
      probed: true,
      bridge: true,
      nativeAvailable: false,
      submitted: 2,
    });
    for (const action of GLOBAL_TIER_ACTIONS) {
      const status = keybindRowStatus(action, silent);
      assert.equal(status, "unavailable", action);
      assert.equal(blocksCapture(status), true, action);
    }
  });

  it("an unprobed state leaves every global row probing, and open", () => {
    for (const action of GLOBAL_TIER_ACTIONS) {
      const status = keybindRowStatus(action, UNPROBED_KEYBIND_ARM_STATE);
      assert.equal(status, "probing", action);
      assert.equal(blocksCapture(status), false, action);
    }
  });

  it("an available tier leaves an unarmed global row unclaimed, and open", () => {
    const [named, ...rest] = GLOBAL_TIER_ACTIONS;
    const available = arm({
      probed: true,
      bridge: true,
      nativeAvailable: true,
      submitted: 1,
      armed: [named],
    });
    for (const action of rest) {
      const status = keybindRowStatus(action, available);
      assert.equal(status, "unclaimed", action);
      assert.equal(blocksCapture(status), false, action);
    }
  });
});

describe("keybindRowStatus: refusals win over everything", () => {
  it("🔴 unsupported wins over probing", () => {
    const state = arm({ probed: false, unsupported: [GLOBAL_ACTION] });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "unsupported");
  });

  it("🔴 refused wins over probing", () => {
    const state = arm({ probed: false, refused: [GLOBAL_ACTION] });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "refused");
  });

  it("unsupported wins over an unbridged (unavailable) tier", () => {
    const state = arm({ bridge: false, unsupported: [GLOBAL_ACTION] });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "unsupported");
  });

  it("refused wins over a silent (unavailable) tier", () => {
    const state = arm({ submitted: 2, refused: [GLOBAL_ACTION] });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "refused");
  });

  it("unsupported wins over armed membership", () => {
    const state = arm({
      nativeAvailable: true,
      submitted: 1,
      armed: [GLOBAL_ACTION],
      unsupported: [GLOBAL_ACTION],
    });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "unsupported");
  });

  it("unsupported wins over refused", () => {
    const state = arm({
      nativeAvailable: true,
      submitted: 1,
      unsupported: [GLOBAL_ACTION],
      refused: [GLOBAL_ACTION],
    });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "unsupported");
  });

  it("reports an in-app id in a refusal list rather than filtering it by tier", () => {
    // An in-app action must never be submitted, so its id in a result is a
    // bug in the arming lane — and the row must show it, not hide it.
    assert.equal(
      keybindRowStatus(IN_APP_ACTION, arm({ unsupported: [IN_APP_ACTION] })),
      "unsupported",
    );
    assert.equal(
      keybindRowStatus(IN_APP_ACTION, arm({ refused: [IN_APP_ACTION] })),
      "refused",
    );
  });
});

describe("keybindRowStatus: the in-app tier never consults the probe", () => {
  /** Every in-app row is unclaimed and open under this arm state. */
  function expectInAppOpen(state: KeybindArmState) {
    for (const action of IN_APP_TIER_ACTIONS) {
      const status = keybindRowStatus(action, state);
      assert.equal(status, "unclaimed", action);
      assert.equal(blocksCapture(status), false, action);
    }
  }

  it("is never probing: unprobed", () => {
    expectInAppOpen(UNPROBED_KEYBIND_ARM_STATE);
  });

  it("is never unavailable: no bridge", () => {
    expectInAppOpen(arm({ bridge: false }));
  });

  it("is unclaimed on the bridged disarm", () => {
    expectInAppOpen(arm());
  });

  it("is never unavailable: silent arm", () => {
    expectInAppOpen(arm({ submitted: 2 }));
  });

  it("is unclaimed on an available tier that armed a global row", () => {
    expectInAppOpen(
      arm({ nativeAvailable: true, submitted: 1, armed: [GLOBAL_ACTION] }),
    );
  });

  it("is armed when the arm names it — surfacing the arming-lane bug", () => {
    const state = arm({
      nativeAvailable: true,
      submitted: 1,
      armed: [IN_APP_ACTION],
    });
    assert.equal(keybindRowStatus(IN_APP_ACTION, state), "armed");
  });
});

describe("keybindRowStatus: armed is the only positive, and only past the gate", () => {
  it("is armed on an available tier", () => {
    const state = arm({
      nativeAvailable: true,
      submitted: 1,
      armed: [GLOBAL_ACTION],
    });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "armed");
  });

  it("falls through to armed on an unproven tier (torn state, gate open)", () => {
    const state = arm({
      nativeAvailable: false,
      submitted: 0,
      armed: [GLOBAL_ACTION],
    });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "armed");
  });

  it("is probing, not armed, while unprobed — the gate short-circuits", () => {
    const state = arm({ probed: false, armed: [GLOBAL_ACTION] });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "probing");
  });

  it("is unavailable, not armed, with no bridge — the gate short-circuits", () => {
    const state = arm({
      bridge: false,
      nativeAvailable: true,
      submitted: 1,
      armed: [GLOBAL_ACTION],
    });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "unavailable");
  });

  it("🔴 three empty lists are not a positive", () => {
    const state = arm({ nativeAvailable: true, submitted: 1 });
    assert.equal(keybindRowStatus(GLOBAL_ACTION, state), "unclaimed");
  });
});

/* ------------------------------------------------------------------------ *
 * blocksCapture
 * ------------------------------------------------------------------------ */

describe("blocksCapture: true for exactly one status", () => {
  it("unsupported → false (the row the user needs to re-bind)", () => {
    assert.equal(blocksCapture("unsupported"), false);
  });

  it("refused → false (the row the user needs to re-bind)", () => {
    assert.equal(blocksCapture("refused"), false);
  });

  it("probing → false (the store is authoritative; arms when the answer lands)", () => {
    assert.equal(blocksCapture("probing"), false);
  });

  it("unavailable → true", () => {
    assert.equal(blocksCapture("unavailable"), true);
  });

  it("armed → false", () => {
    assert.equal(blocksCapture("armed"), false);
  });

  it("unclaimed → false", () => {
    assert.equal(blocksCapture("unclaimed"), false);
  });

  it("is true for exactly one of the six, and nothing above missed one", () => {
    assert.equal(EVERY_ROW_STATUS.length, 6);
    assert.equal(new Set(EVERY_ROW_STATUS).size, 6);
    assert.deepEqual(
      EVERY_ROW_STATUS.filter((status) => blocksCapture(status)),
      ["unavailable"],
    );
  });
});

/* ------------------------------------------------------------------------ *
 * blocksClear
 * ------------------------------------------------------------------------ */

describe("blocksClear: never true, for any status", () => {
  for (const status of EVERY_ROW_STATUS) {
    it(`${status} → false`, () => {
      assert.equal(blocksClear(status), false);
    });
  }

  it("is false for all six, so no status is a one-way door", () => {
    assert.deepEqual(
      EVERY_ROW_STATUS.filter((status) => blocksClear(status)),
      [],
    );
  });
});

describe("the macOS lock trap: capture closes, clearing does not", () => {
  /**
   * The shape macOS actually produces. `keybinds_arm` is Windows-only; off
   * Windows it returns three empty lists and NO error, so the probe completes
   * with a bridge present, the binding submitted, and no positive evidence of
   * a native hook. `deriveNativeAvailable` is a positive test by design, so
   * "no evidence" is not "present" — the tier is correctly `"unavailable"`.
   *
   * What was NOT correct was wiring the clear control to that same verdict:
   * the user's first system-wide binding locked every global row INCLUDING its
   * own clear, and the only escape was the page-level reset that wipes every
   * binding they have.
   */
  const bridgedNoEvidence = arm({
    probed: true,
    bridge: true,
    submitted: 1,
    nativeAvailable: false,
  });

  it("every global row reads unavailable", () => {
    for (const action of GLOBAL_TIER_ACTIONS) {
      assert.equal(
        keybindRowStatus(action, bridgedNoEvidence),
        "unavailable",
        action,
      );
    }
  });

  it("capture is blocked on every global row", () => {
    for (const action of GLOBAL_TIER_ACTIONS) {
      const status = keybindRowStatus(action, bridgedNoEvidence);
      assert.equal(blocksCapture(status), true, action);
    }
  });

  it("clearing is NOT blocked on any global row — this is the regression", () => {
    for (const action of GLOBAL_TIER_ACTIONS) {
      const status = keybindRowStatus(action, bridgedNoEvidence);
      assert.equal(blocksClear(status), false, action);
    }
  });
});
