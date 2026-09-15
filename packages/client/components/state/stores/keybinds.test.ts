/**
 * Run with:
 *
 *     node --conditions=browser --test components/state/stores/keybinds.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests — without it
 * Node resolves solid-js's server build and effect-based specs silently pass
 * against broken code.)
 *
 * What these exist to prevent is not a crash. `./Keybinds.ts`' `clean()`
 * shipped as `return {}`, and `clean()` is the only migration mechanism this
 * store family has: `State.hydrate()` (`../index.tsx`) runs the blob off
 * localforage through it and writes the result back when it differs. A
 * `clean()` that drops what it was given therefore deletes every binding the
 * user set, on disk, on the next boot, with no error anywhere. The round-trip
 * and "valid siblings survive" specs below are the ones that catch that, and
 * the known-bad control for this file is to restore `return {}` and watch them
 * go red.
 *
 * # Why this file loads the module through a resolver hook
 *
 * `./voiceOverlay.ts`' header records the constraint: a store class imports
 * `State`, which reaches the whole app, "so the store class cannot be loaded
 * by `node --test`". Its answer was to split the pure clamps into a separate
 * import-free module. That answer is not available here — the persisted shape
 * and its validation are `./Keybinds.ts`' own content and this lane owns
 * exactly that file and this one, so a third leaf module is out of scope.
 *
 * `./Keybinds.ts` gets as close as it can on its own: its `State` import is
 * `import type`, which Node's type-stripping erases. What remains is
 * `import { AbstractStore } from "."`, a value import that must stay (the
 * class has to extend it — `State.iterStores()` finds stores by a private
 * field on `AbstractStore`, so a `Keybinds` that did not extend it would never
 * have `default()` called and the key would be absent from the store
 * entirely). Node cannot load that import: `"."` is a directory specifier
 * (`ERR_UNSUPPORTED_DIR_IMPORT`), and giving it the explicit `./index.ts`
 * spelling does not help either, because `./index.ts` itself does
 * `import { State } from ".."` — a bare value-syntax import that stripping
 * does NOT elide, into another directory. Both were checked, not assumed.
 *
 * So the one specifier is substituted with a minimal stand-in, in-process, via
 * `module.registerHooks`. The substitution is narrow on purpose: it matches
 * one specifier from one parent file, and everything else — including
 * `globalKeybinds.ts` and `./Keybinds.ts` itself — loads normally from disk.
 * If the hook ever stops matching, the dynamic import throws and this file
 * fails loudly; it cannot degrade into a silent pass.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { describe, it } from "node:test";

import {
  type Binding,
  GLOBAL_KEYBIND_ACTIONS,
  MAX_BINDINGS,
  RESERVED_COMBO,
} from "../../keybinds/globalKeybinds.ts";

// Type-only, so this statement is erased before Node sees it and does not
// drag `./Keybinds.ts` in ahead of the hook registration below.
import type { TypeKeybinds } from "./Keybinds.ts";

const ABSTRACT_STORE_STUB = "keybinds-test:abstract-store";

/**
 * Enough of `AbstractStore` for `Keybinds` to extend and drive: the two-arg
 * constructor, and the `get` / `set` pair that forward to the injected state.
 * Written to match `./index.ts`' real shapes — `set(...args)` forwards with
 * the store key prepended, which is what makes `this.set("bindings", next)`
 * arrive at the fake state as `set("keybinds", "bindings", next)`.
 */
const ABSTRACT_STORE_SOURCE = `
export class AbstractStore {
  constructor(state, key) {
    this.state = state;
    this.key = key;
  }
  getKey() {
    return this.key;
  }
  get() {
    return this.state.get(this.key);
  }
  set(...args) {
    this.state.set(this.key, ...args);
  }
}
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === "." &&
      typeof context.parentURL === "string" &&
      context.parentURL.endsWith("/state/stores/Keybinds.ts")
    ) {
      return { url: ABSTRACT_STORE_STUB, shortCircuit: true };
    }

    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === ABSTRACT_STORE_STUB) {
      return {
        format: "module",
        shortCircuit: true,
        source: ABSTRACT_STORE_SOURCE,
      };
    }

    return nextLoad(url, context);
  },
});

// Dynamic, so the hooks above are installed first. Top-level await in an ESM
// spec file; the static `import type` of `TypeKeybinds` is erased and does not
// front-run it.
const { Keybinds, cleanKeybinds, defaultKeybinds } =
  await import("./Keybinds.ts");

/**
 * Feed `clean()` a blob shaped like what IndexedDB can actually hold. Its
 * parameter type is a compile-time promise about data that came off disk, so
 * every spec that exercises the validation has to get past it; the casts are
 * kept here rather than sprayed across the assertions.
 */
function cleanRaw(raw: unknown): TypeKeybinds {
  return cleanKeybinds(raw as Partial<TypeKeybinds>);
}

const ALT_M: Binding = { code: "KeyM", ctrl: false, shift: false, alt: true };
const CTRL_ALT_M: Binding = {
  code: "KeyM",
  ctrl: true,
  shift: false,
  alt: true,
};
const F13: Binding = { code: "F13", ctrl: false, shift: false, alt: false };

/** Actions used by the ordering specs, in `GLOBAL_KEYBIND_ACTIONS` order. */
const EARLIER = "toggle-mute";
const LATER = "disconnect-call";

/** A fake `State` plus a real `Keybinds` over it. */
function makeStore() {
  let value: TypeKeybinds = defaultKeybinds();

  const state = {
    get: () => value,
    set: (_key: string, field: "bindings", next: TypeKeybinds["bindings"]) => {
      value = { ...value, [field]: next };
    },
  };

  return new Keybinds(state as never);
}

describe("declared surface", () => {
  it("resolves the real module, not a stub of it", () => {
    // The hook substitutes one import of one file. If it ever widened to
    // swallow `./Keybinds.ts` itself, every spec below would pass against
    // nothing, so pin that the module under test is the real one.
    assert.equal(typeof cleanKeybinds, "function");
    assert.equal(typeof defaultKeybinds, "function");
    assert.equal(Keybinds.name, "Keybinds");
  });

  it("orders EARLIER before LATER, as the duplicate specs assume", () => {
    const actions: readonly string[] = GLOBAL_KEYBIND_ACTIONS;
    assert.ok(actions.indexOf(EARLIER) < actions.indexOf(LATER));
  });

  it("leaves room under MAX_BINDINGS for every action at once", () => {
    // Tripwire, not decoration. The cap is a native limit and the store
    // enforces it; it is unreachable while there are 12 actions and room for
    // 16. A lane that grows the action list past the cap makes the store
    // start silently refusing the last rows, and this is where that surfaces.
    assert.ok(
      GLOBAL_KEYBIND_ACTIONS.length <= MAX_BINDINGS,
      `${GLOBAL_KEYBIND_ACTIONS.length} actions exceeds MAX_BINDINGS=${MAX_BINDINGS}`,
    );
  });
});

describe("defaultKeybinds", () => {
  it("lists every action, every one unbound", () => {
    const { bindings } = defaultKeybinds();

    assert.deepEqual(
      Object.keys(bindings).sort(),
      [...GLOBAL_KEYBIND_ACTIONS].sort(),
    );
    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      assert.equal(bindings[action], null, `${action} should ship unbound`);
    }
  });

  it("returns a fresh object each call (no shared mutable default)", () => {
    const first = defaultKeybinds();
    first.bindings["toggle-mute"] = ALT_M;

    assert.equal(defaultKeybinds().bindings["toggle-mute"], null);
  });
});

describe("cleanKeybinds — absent and malformed containers", () => {
  it("fills every key from the defaults on {}", () => {
    assert.deepEqual(cleanKeybinds({}), defaultKeybinds());
  });

  it("survives undefined", () => {
    assert.deepEqual(cleanKeybinds(undefined), defaultKeybinds());
  });

  it("survives a null bindings map", () => {
    assert.deepEqual(cleanRaw({ bindings: null }), defaultKeybinds());
  });

  it("survives an array where the map should be", () => {
    // `typeof [] === "object"` and indexing it is legal, so this needs its own
    // `Array.isArray` arm rather than falling out of the null check.
    //
    // 🔴 The array has to CARRY something for that arm to be observable. A
    // bare `[]` reads `undefined` at every action id whether the guard runs or
    // not, so it cannot tell a guarded `clean()` from an unguarded one — this
    // spec asserted against its own setup until the shape below replaced it.
    // An array with a string-keyed property is what distinguishes them, and it
    // is a reachable shape rather than a contrivance: `structuredClone` (the
    // algorithm IndexedDB stores through) preserves non-index own properties
    // on an array, so a build that once wrote `bindings` as an array with
    // action ids hung off it round-trips exactly this. Drop the
    // `Array.isArray` arm and the chord below is accepted verbatim.
    const arr: unknown[] = [];
    (arr as unknown as Record<string, unknown>)[EARLIER] = ALT_M;

    assert.deepEqual(cleanRaw({ bindings: arr }), defaultKeybinds());
  });

  it("survives a primitive where the map should be", () => {
    // 🔴 Scope, stated because the obvious reading is wrong: this pins that a
    // primitive yields the defaults and does NOT THROW (a throw here aborts
    // `State.hydrate()`'s loop and takes every store after `keybinds` with
    // it). It does not, and cannot, pin the guard's `typeof raw !== "object"`
    // arm. A property read on a primitive resolves against the wrapper
    // prototype, which has no action id on it, so `"KeyM"`, `7` and `true`
    // all yield `undefined` at every action id with the arm present or
    // absent — all three were run against both and are indistinguishable.
    //
    // Boxing it does not rescue the spec either, and was checked rather than
    // assumed: `new String("KeyM")` with an action-id property is `typeof
    // "object"`, not an array and not null, so it PASSES the real guard and
    // reaches the per-entry loop — the opposite of what a boxed-primitive
    // spec would be claiming. (Harmless in practice: `structuredClone` drops
    // the extra property off a boxed primitive, so that shape cannot arrive
    // from disk.) The only input that does exercise the arm is a callable,
    // which `structuredClone` refuses outright and `JSON.parse` cannot
    // produce, so no reachable input covers it; the arm stands as
    // defense-in-depth and this spec does not pretend to prove it.
    assert.deepEqual(cleanRaw({ bindings: "KeyM" }), defaultKeybinds());
  });

  it("survives a null blob", () => {
    // `Sync.merge` hands `clean()` the output of `JSON.parse`, which can be
    // `null`.
    assert.deepEqual(cleanKeybinds(null), defaultKeybinds());
  });

  it("ignores keys it does not own", () => {
    assert.deepEqual(
      cleanRaw({ bindings: {}, pushToTalkKey: "Space", version: 3 }),
      defaultKeybinds(),
    );
  });
});

describe("cleanKeybinds — round trip", () => {
  it("does not come back empty when given valid bindings", () => {
    // 🔴 Regression spec for the shipped bug: `clean()` was
    // `return {}` unconditionally. With the real type in place that erases
    // every binding the user set, and `State.hydrate()` then writes the empty
    // result back to disk.
    const stored = {
      bindings: { [EARLIER]: ALT_M, [LATER]: F13 },
    };

    const cleaned = cleanRaw(stored);

    assert.notDeepEqual(cleaned, defaultKeybinds());
    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
    assert.deepEqual(cleaned.bindings[LATER], F13);
  });

  it("preserves a binding field for field", () => {
    const stored = { bindings: { "toggle-overlay": CTRL_ALT_M } };

    assert.deepEqual(cleanRaw(stored).bindings["toggle-overlay"], {
      code: "KeyM",
      ctrl: true,
      shift: false,
      alt: true,
    });
  });

  it("is idempotent, so hydrate() does not rewrite the blob every boot", () => {
    // `State.hydrate()` compares `equal(data, cleanData)` and writes back on a
    // difference. A `clean()` whose output was not a fixed point would dirty
    // the store on every single boot.
    const once = cleanRaw({ bindings: { [EARLIER]: ALT_M, [LATER]: F13 } });

    assert.deepEqual(cleanKeybinds(once), once);
  });

  it("accepts a full house — every action bound to a distinct chord", () => {
    const bindings: Record<string, Binding> = {};
    GLOBAL_KEYBIND_ACTIONS.forEach((action, index) => {
      bindings[action] = {
        code: `F${index + 13}`,
        ctrl: false,
        shift: false,
        alt: false,
      };
    });

    const cleaned = cleanRaw({ bindings });

    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      assert.deepEqual(cleaned.bindings[action], bindings[action]);
    }
  });
});

describe("cleanKeybinds — per-entry validation keeps valid siblings", () => {
  /**
   * Every spec here pairs one bad entry with one good one. A `clean()` that
   * threw the whole map away on any fault would satisfy "the bad entry is
   * gone" and still be the bug; only the surviving sibling distinguishes them.
   */
  function survives(bad: unknown) {
    const cleaned = cleanRaw({
      bindings: { [EARLIER]: bad, [LATER]: F13 },
    });

    assert.equal(cleaned.bindings[EARLIER], null);
    assert.deepEqual(cleaned.bindings[LATER], F13);
  }

  it("drops a non-string code", () => {
    survives({ code: 77, ctrl: false, shift: false, alt: false });
  });

  it("drops an empty code — a row that looks bound and can never fire", () => {
    survives({ code: "", ctrl: false, shift: false, alt: false });
  });

  it("drops a non-boolean modifier rather than coercing it", () => {
    // Coercing `"true"` to `true` would be worse than dropping: it stores a
    // DIFFERENT chord from the one the user chose, and modifier matching is
    // exact, so it fires on a keystroke they never picked.
    survives({ code: "KeyM", ctrl: "true", shift: false, alt: false });
  });

  it("drops a missing modifier", () => {
    survives({ code: "KeyM", ctrl: false, shift: false });
  });

  it("drops a null entry", () => {
    survives(null);
  });

  it("drops a non-object entry", () => {
    survives("Alt+KeyM");
  });

  it("drops an unknown action id and keeps the known siblings", () => {
    // A future version's id round-tripping through this build would arm an
    // action it cannot dispatch, and would read `undefined` out of
    // `KEYBIND_REQUIREMENT` as "no precondition".
    const cleaned = cleanRaw({
      bindings: { "toggle-hologram": ALT_M, [LATER]: F13 },
    });

    assert.deepEqual(cleaned.bindings[LATER], F13);
    assert.ok(!("toggle-hologram" in cleaned.bindings));
    assert.deepEqual(
      Object.keys(cleaned.bindings).sort(),
      [...GLOBAL_KEYBIND_ACTIONS].sort(),
    );
  });

  it("strips a property the pinned native payload has no field for", () => {
    const cleaned = cleanRaw({
      bindings: {
        [EARLIER]: { ...ALT_M, meta: true, id: "toggle-mute" },
      },
    });

    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
  });
});

describe("cleanKeybinds — reserved combo", () => {
  it("rejects the remote-control panic combo", () => {
    const cleaned = cleanRaw({
      bindings: { [EARLIER]: RESERVED_COMBO, [LATER]: F13 },
    });

    assert.equal(cleaned.bindings[EARLIER], null);
    assert.deepEqual(cleaned.bindings[LATER], F13);
  });

  it("keeps a partial chord on the reserved key", () => {
    // `isReservedCombo` is an exact match on all three modifiers;
    // `Ctrl+Alt+KeyQ` arms normally and must not be collateral.
    const partial: Binding = {
      code: "KeyQ",
      ctrl: true,
      shift: false,
      alt: true,
    };

    assert.deepEqual(
      cleanRaw({ bindings: { [EARLIER]: partial } }).bindings[EARLIER],
      partial,
    );
  });
});

describe("cleanKeybinds — duplicate policy", () => {
  it("keeps the first holder in declared order and nulls the later", () => {
    const cleaned = cleanRaw({
      bindings: { [EARLIER]: ALT_M, [LATER]: ALT_M },
    });

    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
    assert.equal(cleaned.bindings[LATER], null);
  });

  it("ignores the persisted object's own key order", () => {
    // Object key order is insertion order, and IndexedDB round-trips it. If
    // the tie-break read that instead of `GLOBAL_KEYBIND_ACTIONS`, this and
    // the previous spec would disagree — and `clean()` would rewrite the blob
    // on every boot.
    const cleaned = cleanRaw({
      bindings: { [LATER]: ALT_M, [EARLIER]: ALT_M },
    });

    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
    assert.equal(cleaned.bindings[LATER], null);
  });

  it("keeps both when only the physical key matches", () => {
    // Full-chord comparison, deliberately not `code` identity: press matching
    // is exact on all three modifiers, so `Alt+KeyM` and `Ctrl+Alt+KeyM`
    // never both fire on a press and nulling one would be loss with no
    // double-fire to prevent.
    const cleaned = cleanRaw({
      bindings: { [EARLIER]: ALT_M, [LATER]: CTRL_ALT_M },
    });

    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
    assert.deepEqual(cleaned.bindings[LATER], CTRL_ALT_M);
  });

  it("nulls every later holder, not just the second", () => {
    const cleaned = cleanRaw({
      bindings: {
        [EARLIER]: ALT_M,
        [LATER]: ALT_M,
        "toggle-theater": ALT_M,
      },
    });

    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
    assert.equal(cleaned.bindings[LATER], null);
    assert.equal(cleaned.bindings["toggle-theater"], null);
  });
});

describe("Keybinds — store surface", () => {
  it("default() and clean() delegate to the free functions", () => {
    const store = makeStore();

    assert.deepEqual(store.default(), defaultKeybinds());
    assert.deepEqual(
      store.clean({ bindings: { [EARLIER]: ALT_M } } as Partial<TypeKeybinds>),
      cleanRaw({ bindings: { [EARLIER]: ALT_M } }),
    );
  });

  it("clean() does not come back empty either", () => {
    // 🔴 Deliberately duplicates the free-function regression spec through the
    // class. `Keybinds.clean()` is where `return {}` actually shipped and is
    // the only entry point `State.hydrate()` and `Sync.merge` ever call, so a
    // suite that only drove `cleanKeybinds` would leave the real bug site
    // guarded by nothing but the delegation spec above. Restoring the bug to
    // the method rather than the function was run as a control and confirmed
    // that gap before this was added.
    const store = makeStore();

    const cleaned = store.clean({
      bindings: { [EARLIER]: ALT_M },
    } as Partial<TypeKeybinds>);

    assert.deepEqual(cleaned.bindings[EARLIER], ALT_M);
    assert.notDeepEqual(cleaned, defaultKeybinds());
  });

  it("binds and reads back", () => {
    const store = makeStore();

    assert.equal(store.setBinding(EARLIER, ALT_M), true);
    assert.deepEqual(store.binding(EARLIER), ALT_M);
    assert.equal(store.binding(LATER), null);
  });

  it("refuses the panic combo instead of storing a dead row", () => {
    const store = makeStore();

    assert.equal(store.setBinding(EARLIER, RESERVED_COMBO), false);
    assert.equal(store.binding(EARLIER), null);
  });

  it("takes the chord from another holder so at most one action has it", () => {
    const store = makeStore();
    store.setBinding(EARLIER, ALT_M);

    assert.equal(store.setBinding(LATER, ALT_M), true);
    assert.equal(store.binding(EARLIER), null);
    assert.deepEqual(store.binding(LATER), ALT_M);
  });

  it("reports the conflicting action, and does not report itself", () => {
    const store = makeStore();
    store.setBinding(EARLIER, ALT_M);

    assert.equal(store.conflictingAction(ALT_M), EARLIER);
    assert.equal(store.conflictingAction(ALT_M, EARLIER), null);
    assert.equal(store.conflictingAction(F13), null);
  });

  it("narrows an action id arriving off the wire", () => {
    const store = makeStore();
    store.setBinding(EARLIER, ALT_M);

    assert.deepEqual(store.bindingForId(EARLIER), ALT_M);
    assert.equal(store.bindingForId("toggle-hologram"), null);
    assert.equal(store.bindingForId(""), null);

    // 🔴 The two unknown ids above do NOT exercise `isGlobalKeybindAction`,
    // and a spec that stopped there would pass with the predicate deleted:
    // `binding()` ends in `?? null`, so an id that is merely absent reads
    // `undefined` off the record and is laundered into `null` either way.
    //
    // An id that resolves on the PROTOTYPE CHAIN is what separates them.
    // `bindings` is a plain object literal, so `bindings["constructor"]` is
    // `Object` — truthy, so `?? null` returns it — and an unguarded
    // `bindingForId` therefore hands the dispatch lane a FUNCTION where its
    // signature promises `Binding | null`. `keybind:down` / `keybind:up`
    // carry `{ id: string }` stringified by the native side, so these are
    // reachable strings and not contrivances; `isGlobalKeybindAction` is an
    // `Array.includes` membership test, which is why it rejects them.
    for (const inherited of [
      "constructor",
      "toString",
      "valueOf",
      "__proto__",
    ]) {
      assert.equal(
        store.bindingForId(inherited),
        null,
        `${inherited} must not resolve off the prototype chain`,
      );
    }
  });

  it("clears one action without touching the others", () => {
    const store = makeStore();
    store.setBinding(EARLIER, ALT_M);
    store.setBinding(LATER, F13);

    store.clearBinding(EARLIER);

    assert.equal(store.binding(EARLIER), null);
    assert.deepEqual(store.binding(LATER), F13);
  });

  it("resets to the shipped default", () => {
    const store = makeStore();
    store.setBinding(EARLIER, ALT_M);

    store.resetBindings();

    assert.deepEqual(store.bindings(), defaultKeybinds().bindings);
  });
});
