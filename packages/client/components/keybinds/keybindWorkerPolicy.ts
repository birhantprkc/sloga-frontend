/**
 * Every DECISION behind `KeybindsWorker` (`@revolt/client/KeybindsWorker`):
 * what gets submitted to the native arm, what an arm result actually proves,
 * which held-set transition an edge causes, and whether a focused DOM
 * keystroke matches a binding.
 *
 * # Why this is a separate module
 *
 * `KeybindsWorker.tsx` is a `.tsx`, and `node --test` refuses one outright
 * (`ERR_UNKNOWN_FILE_EXTENSION` — Node's type-stripping handles `.ts`/`.mts`/
 * `.cts` and does not transform JSX). It also reaches `@revolt/rtc`, which
 * pulls `livekit-client/e2ee-worker?worker` and four other Vite-only or
 * aliased specifiers. So a decision left inline in the component is a
 * decision with no test at all — and the decisions here are the ones that
 * decide whether a keypress the user made in ANOTHER application reaches the
 * voice stack.
 *
 * This is the same component/pure-leaf split as `@revolt/rtc`'s
 * `keybindDispatchPolicy`, `joinRefusalPolicy`, `pauseVerdict` and
 * `vadGatePolicy`, and `@revolt/ui`'s `keyCapturePolicy`, drawn the same way:
 * **every decision is here**, and the component keeps only the mutable state
 * (the held-set reference, the arm generation), the signal reads that feed
 * this, and the side effects (`invoke`, `listen`, `addEventListener`,
 * `voice.dispatchKeybind`).
 *
 * # 🔴 This is NOT the dispatch policy, and does not duplicate it
 *
 * `@revolt/rtc/keybindDispatchPolicy` owns the five preconditions (in-flight,
 * rate limit, `KEYBIND_REQUIREMENT`, push-to-talk hold, fullscreen) and they
 * are already applied inside `Voice.dispatchKeybind()`. Nothing here re-checks
 * any of them: two copies of a precondition drift, and the drift is invisible
 * because both copies look right in isolation. The split is by QUESTION, not
 * by severity — this module answers "is this a real edge for a real binding on
 * a transport that may carry it", and the dispatch policy answers "may this
 * action run right now".
 *
 * # Dependency-free apart from the vocabulary
 *
 * No framework import, deliberately: `solid-js` here would put this right back
 * out of reach of `node --test`. The one import is
 * `./globalKeybinds.ts`, by relative specifier with an explicit `.ts` and
 * inline `type` markers, for the reason `keybindDispatchPolicy.ts` and
 * `../state/stores/Keybinds.ts` both record — the `@revolt/keybinds` alias is
 * a tsconfig `paths` entry the test runner does not resolve, and Node's
 * type-stripping does not elide import SPECIFIERS, so an unmarked type name
 * would survive into the emitted import list and fail at runtime as a missing
 * export.
 *
 * `./armState.ts` deliberately imports FROM here rather than the other way
 * round: it calls `createSignal` at module scope, so a dependency on it would
 * cost this module its testability and put a side-effecting init on the import
 * path of every consumer. {@link KeybindArmState} is therefore declared here
 * and re-exported there, which is the name the settings page reads.
 */
import {
  type ArmedBinding,
  type Binding,
  type GlobalKeybindAction,
  type KeyLikeEvent,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_TIER,
  bindingMatchesPress,
  bindingMatchesRelease,
  isGlobalKeybindAction,
} from "./globalKeybinds.ts";

/* ------------------------------------------------------------------------ *
 * 1. What the native arm reported
 * ------------------------------------------------------------------------ */

/**
 * The renderer's published view of the native keybind hook.
 *
 * Read by the settings page to mark a row unbindable instead of showing it as
 * bound and never firing — the obligation `KeybindsArmResult` in
 * `./globalKeybinds.ts` puts on the renderer. Written only by
 * `KeybindsWorker`.
 */
export type KeybindArmState = {
  /**
   * The native arm has been attempted at least once, so the other six
   * fields mean something. `false` is the pre-mount state: the page must not
   * read an empty `armed` as "nothing took" before anything was tried.
   */
  probed: boolean;
  /**
   * 🔴 **"Proven to exist", never "proven absent".**
   *
   * Off Windows `keybinds_arm` returns `KeybindsArmResult::default()` — all
   * three lists empty, **and no error** — so "the call resolved and refused
   * nothing" is the exact shape of total failure. See
   * {@link deriveNativeAvailable} for the positive test that is used instead.
   *
   * A `false` here therefore means "this run produced no evidence of a native
   * layer": no shell bridge, a throwing/ACL-refused invoke, a non-Windows
   * shell, or nothing submitted to learn from. 🔴 On its own it is NOT a
   * negative, and the page must not read it as one: with nothing bound the
   * disarm path publishes exactly this `false`, and a page that treats it as
   * "absent" locks every row's capture before a first key can ever be bound
   * to produce the evidence — on the Windows desktop app included. The two
   * facts that separate "no evidence yet" from "proven absent" are `bridge`
   * and `submitted` below.
   */
  nativeAvailable: boolean;
  /**
   * A shell invoke bridge (`tauriInvoke()` non-undefined) existed when this
   * state was derived.
   *
   * `false` means nothing can ever arm from this build, because the native
   * arm is only reachable through that bridge: PROVEN ABSENT, the one
   * negative the page is entitled to state outright.
   */
  bridge: boolean;
  /**
   * How many bindings the arm carried; `0` on the disarm path.
   *
   * With `bridge` true and `submitted` `0` the state is UNKNOWN, not
   * negative — the page must keep capture open so the first bind can produce
   * evidence.
   */
  submitted: number;
  /**
   * Installed — a global hook is live for these. The **only** positive signal
   * that a binding took.
   */
  armed: GlobalKeybindAction[];
  /** The native scan table cannot express the key; retrying will not help. */
  unsupported: GlobalKeybindAction[];
  /** Reserved combo, or past `MAX_BINDINGS`. */
  refused: GlobalKeybindAction[];
};

/**
 * The one shared empty list.
 *
 * Frozen, and the cast is the price of that: {@link KeybindArmState}'s three
 * lists are mutable arrays (the shape the settings page and
 * {@link armStateFromResult} both want), and a frozen value is not assignable
 * to one without it. Worth paying here and nowhere else — this is the only
 * list in the module that is SHARED rather than built fresh per call, and it
 * is handed straight out of the signal, so a consumer that pushed onto it
 * would mutate every future reader's "nothing probed yet".
 */
const NO_ACTIONS = Object.freeze([]) as unknown as GlobalKeybindAction[];

/** Before the first arm. */
export const UNPROBED_KEYBIND_ARM_STATE: KeybindArmState = Object.freeze({
  probed: false,
  nativeAvailable: false,
  bridge: false,
  submitted: 0,
  armed: NO_ACTIONS,
  unsupported: NO_ACTIONS,
  refused: NO_ACTIONS,
});

/**
 * Narrow one list off a `keybinds_arm` result.
 *
 * 🔴 The three lists are declared `GlobalKeybindAction[]` in
 * `./globalKeybinds.ts` but native types them `Vec<String>` and echoes back
 * whatever it was armed with, so what crosses the boundary is untyped JSON. A
 * stale `keybinds_arm` racing a rebuild can echo an id this build has dropped
 * — the same race `isGlobalKeybindAction` exists for — and an unknown id put
 * into the published state would index `KEYBIND_TIER` to `undefined` in the
 * settings page. Everything is re-checked here, including the array-ness of
 * the container, so no consumer downstream needs to re-check anything.
 *
 * Duplicates are collapsed. Native pushes each submitted id to exactly one
 * list once, so this cannot fire against today's shell; it costs one
 * `includes` on a list of at most sixteen and keeps a row lookup in the page
 * from depending on that.
 */
function narrowActionList(value: unknown): GlobalKeybindAction[] {
  if (!Array.isArray(value)) return [];

  const out: GlobalKeybindAction[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!isGlobalKeybindAction(entry)) continue;
    if (out.includes(entry)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * Does this arm result prove a native keybind layer exists?
 *
 * 🔴 **The test is positive, and it has to be.** Off Windows the command
 * resolves with every list empty and no error, which is byte-identical to
 * "submitted nothing" and indistinguishable from success to anything that
 * only checks for a thrown error. So "no refusals" is not evidence of
 * anything, and the derivation is: bindings were submitted AND at least one
 * of them came back named.
 *
 * `unsupported` and `refused` count as evidence alongside `armed`: both are
 * produced only by the Windows implementation walking the submitted specs
 * (a scan-table miss, the reserved combo, a `MAX_BINDINGS` overflow), so an
 * id in either one proves the native side read the payload. A shell where
 * every submitted key happens to be unbindable is still a shell with a
 * keybind layer, and reporting it as absent would send the settings page to
 * "install the desktop app" for a user who already has it.
 *
 * @param submittedCount how many bindings the arm carried
 * @param result the narrowed result
 */
export function deriveNativeAvailable(
  submittedCount: number,
  result: Pick<KeybindArmState, "armed" | "unsupported" | "refused">,
): boolean {
  // Nothing submitted, so nothing could be reported back: no evidence either
  // way. `false` is the fail-closed reading of "unknown" — see
  // `KeybindArmState.nativeAvailable`.
  if (submittedCount <= 0) return false;

  return (
    result.armed.length > 0 ||
    result.unsupported.length > 0 ||
    result.refused.length > 0
  );
}

/**
 * Turn one arm attempt into the state the settings page reads.
 *
 * `raw` is whatever the invoke produced, and `undefined` is a first-class
 * input rather than an error path: no shell bridge, a throwing or ACL-refused
 * invoke, and a shell with no `keybinds_arm` command all land here, and all
 * three mean the same thing to the page — probed, nothing armed, nothing
 * proven. Routing them through one function is what keeps a failure from
 * being published as a different shape than a refusal.
 *
 * @param submitted the bindings the arm carried (its length is the evidence
 * base for {@link deriveNativeAvailable} and is published as `submitted`, so
 * pass the real array — an empty one on the disarm path)
 * @param raw the resolved `KeybindsArmResult`, or `undefined`
 * @param bridge whether a shell invoke bridge existed for this attempt;
 * published verbatim as `bridge`. Pass the real answer on every path,
 * including the disarm and the failure ones — `false` is the one negative the
 * page may state outright, so a caller that defaults it would turn "no
 * evidence yet" into "proven absent"
 */
export function armStateFromResult(
  submitted: readonly unknown[],
  raw: unknown,
  bridge: boolean,
): KeybindArmState {
  const container =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};

  const result = {
    armed: narrowActionList(container.armed),
    unsupported: narrowActionList(container.unsupported),
    refused: narrowActionList(container.refused),
  };

  return {
    probed: true,
    nativeAvailable: deriveNativeAvailable(submitted.length, result),
    bridge,
    submitted: submitted.length,
    ...result,
  };
}

/* ------------------------------------------------------------------------ *
 * 2. What to submit
 * ------------------------------------------------------------------------ */

/**
 * Arm this exact array, or drop the hook entirely.
 *
 * 🔴 `"disarm"` is a real instruction, not "skip the arm". A user with no
 * global bindings must end up with **no system-wide keyboard hook installed**
 * — that is the default state of the feature, and leaving a previous arm
 * standing after the last binding is cleared would keep a hook alive for
 * someone who has opted all the way out. `keybinds_disarm` is idempotent and
 * takes no arguments, so calling it on every such pass is free.
 */
export type KeybindArmPlan =
  | { readonly kind: "arm"; readonly bindings: readonly ArmedBinding[] }
  | { readonly kind: "disarm" };

/**
 * Build the `keybinds_arm` payload from the persisted set.
 *
 * # 🔴 The tier filter runs BEFORE the array is built
 *
 * The native side identifies an action by its **array index** — `action_id`
 * is the position in the submitted array, and `id` is carried only so the
 * events can name it back. So an `"in-app"`-tier action cannot be excluded by
 * blanking its entry: a hole shifts every later index, and every later
 * binding then fires under the wrong action's name. Skipping before the
 * `push` is what keeps the array dense, and iterating
 * `GLOBAL_KEYBIND_ACTIONS` (never the record's own keys) is what makes the
 * order deterministic rather than insertion-order-dependent.
 *
 * # 🔴 Why `"in-app"` actions must not be armed at all
 *
 * There is **no second line of defense**. `decideKeybindDispatch` has no tier
 * guard — the tier is not one of its five inputs — so an `"in-app"` action
 * arriving off the native transport passes every precondition and reaches
 * `getDisplayMedia()` / `requestFullscreen()` with no transient user
 * activation. `getDisplayMedia` then rejects with `NotAllowedError`, which
 * `Voice.onErr` drops WITHOUT a modal (deliberately, so a canceled picker is
 * not reported as a fault). The observable result of arming one is a key that
 * does nothing, reports nothing, and logs nothing.
 *
 * Note that the DOM path in `KeybindsWorker` applies NO tier filter, and that
 * asymmetry is the whole design: the focused keystroke is the only transport
 * that can carry an `"in-app"` action, and it is a necessary second transport
 * for `"global"` ones because the native hook is measurably blind while this
 * app owns the foreground.
 *
 * # What is NOT filtered here
 *
 * The reserved combo and the `MAX_BINDINGS` ceiling. Both are already
 * enforced on the way INTO the store (`cleanKeybinds` / `Keybinds.setBinding`
 * in `../state/stores/Keybinds.ts`), and the authoritative signal for both is
 * the arm result's `refused` list, which is read regardless. Re-checking them
 * here would add a second, layout-blind copy of a check whose complete form
 * only the native side can make — see `isReservedCombo`'s comment on AZERTY.
 *
 * @param bindings `state.keybinds.bindings()` — a total record
 */
export function planKeybindArm(
  bindings: Record<GlobalKeybindAction, Binding | null>,
): KeybindArmPlan {
  const armed: ArmedBinding[] = [];

  for (const action of GLOBAL_KEYBIND_ACTIONS) {
    // 🔴 BEFORE the push, never by blanking an entry — see the header.
    if (KEYBIND_TIER[action] !== "global") continue;

    const binding = bindings[action];
    // `?? null` is not enough: a hand-edited or future blob can carry
    // `undefined` for a key the type says is present.
    if (!binding) continue;

    // Rebuilt field by field rather than spread, exactly as `validBinding`
    // in `../state/stores/Keybinds.ts` does, so any extra property a future
    // build persisted is dropped before it crosses the Tauri boundary. The
    // native `KeybindSpec` is `{ id, code, ctrl, shift, alt }` and ignores
    // anything else, so smuggling (say) a `meta` bit would produce a payload
    // that looks honored and is not.
    armed.push({
      id: action,
      code: binding.code,
      ctrl: binding.ctrl,
      shift: binding.shift,
      alt: binding.alt,
    });
  }

  if (armed.length === 0) return { kind: "disarm" };
  return { kind: "arm", bindings: armed };
}

/* ------------------------------------------------------------------------ *
 * 3. The held-set
 * ------------------------------------------------------------------------ */

/**
 * An edge, or a wholesale release.
 *
 * `id` is `string` on both edges because both arrive unnarrowed: the native
 * `keybind:down` / `keybind:up` payload is `{ id: string }` off the wire, and
 * the DOM path supplies an id it matched itself. One entry point for both
 * means the narrowing cannot be forgotten on one of them.
 */
export type KeybindHeldEvent =
  | { readonly kind: "down"; readonly id: string }
  | { readonly kind: "up"; readonly id: string }
  | { readonly kind: "release-all" };

/**
 * Why an edge produced no dispatch.
 *
 * - `"unknown-id"` — not a `GlobalKeybindAction`; a stale arm naming an
 *   action this build dropped.
 * - `"already-down"` — this action is already held, so the edge is a repeat
 *   or the second transport's copy of one press.
 * - `"not-down"` — an up for an action the held-set does not record as down.
 * - `"press-edge-only"` — a legitimate release, recorded and cleared. All
 *   twelve actions today are dispatched on the PRESS edge and none has
 *   momentary semantics, so there is nothing to invoke on the up.
 */
export type KeybindHeldDropReason =
  | "unknown-id"
  | "already-down"
  | "not-down"
  | "press-edge-only";

/**
 * The action to dispatch (or none), and the held-set that replaces the one
 * passed in.
 *
 * `held` is ALWAYS a fresh set, including on a drop, so the caller can assign
 * it unconditionally and can never hold a reference this function mutated
 * underneath it.
 */
export type KeybindHeldVerdict = {
  readonly dispatch: GlobalKeybindAction | null;
  readonly held: ReadonlySet<GlobalKeybindAction>;
  readonly reason: KeybindHeldDropReason | null;
};

/**
 * THE held-set transition for every keybind edge, from either transport.
 *
 * # 🔴 No down, no up
 *
 * Native posts an up **only where the slot's down bit was actually set**
 * (`BINDING_DOWN.fetch_and(!bit) & bit != 0`), so on that transport "an up is
 * emitted exactly for the downs that were emitted, and never otherwise". The
 * DOM transport owes the same gate and cannot get it from a predicate:
 * `bindingMatchesRelease` compares the physical key ALONE (deliberately — a
 * chord released modifier-first would otherwise never get its up edge), so
 * one physical release matches every binding on that key, including ones that
 * were never pressed because their modifiers did not match. The held-set is
 * that gate.
 *
 * # 🔴 Both arm and disarm are release-alls
 *
 * `keybinds_arm` clears the whole `BINDING_DOWN` word as it installs the new
 * table and `keybinds_disarm` clears it as it drops the lease, and **neither
 * emits a synthetic `keybind:up`** — this is the documented behaviour of the
 * calls, not a race between their steps. So the caller must send
 * `"release-all"` unconditionally on every arm (including a re-arm it
 * considers a no-op — native clears regardless of whether the table changed)
 * and before or as every disarm.
 *
 * **The failure that prevents is a permanently dead keybind, today.** With no
 * momentary action in the set, a stale held bit does not strand a microphone
 * — it makes every later press of that action arrive as `"already-down"` and
 * be dropped, forever, with nothing the user can see or do about it short of
 * a reload. Hold a mute key, let the settings page save any other binding
 * (which re-arms), and the mute key is dead for the session.
 *
 * # Why a down for an already-held action is dropped
 *
 * On the native transport a held key contributes exactly one press edge —
 * `keyboard_proc` collapses auto-repeat twice, in the `key_busy` pre-scan and
 * in the per-slot `fetch_or` gate. The DOM transport gives no such guarantee:
 * a focused `keydown` repeats at the OS rate (~20/s past a ~250 ms delay), so
 * the `"in-app"` tier needs the collapse for real. `KeyboardEvent.repeat` is
 * the cheap first check (see {@link matchDomKey}); this is the
 * transport-independent one, and it also absorbs the second transport's copy
 * of a press made while focused.
 *
 * @param held the current held-set; never mutated
 * @param event the edge
 */
export function applyKeybindHeldEvent(
  held: ReadonlySet<GlobalKeybindAction>,
  event: KeybindHeldEvent,
): KeybindHeldVerdict {
  if (event.kind === "release-all") {
    // Unconditional and total. Not "clear the ones we think native cleared":
    // native cleared all of them, and a set difference computed against a
    // table we are in the middle of replacing is exactly the reasoning that
    // leaves one bit behind.
    return { dispatch: null, held: new Set(), reason: null };
  }

  // Bound to a `const` before the guard so the type predicate narrows it:
  // narrowing `event.id` in place would not survive the property read below.
  const id = event.id;
  if (!isGlobalKeybindAction(id)) {
    return { dispatch: null, held: new Set(held), reason: "unknown-id" };
  }

  if (event.kind === "down") {
    if (held.has(id)) {
      return { dispatch: null, held: new Set(held), reason: "already-down" };
    }
    const next = new Set(held);
    next.add(id);
    return { dispatch: id, held: next, reason: null };
  }

  if (!held.has(id)) {
    return { dispatch: null, held: new Set(held), reason: "not-down" };
  }

  // Recorded as released. 🔴 Nothing is dispatched: `Voice.dispatchKeybind()`
  // is a PRESS entry point — it takes an action and no edge, and
  // `#runKeybind` routes every one of the twelve to a toggle or a one-shot.
  // Calling it again on the release would fire each keybind TWICE per press,
  // and for a hold longer than `KEYBIND_MIN_INTERVAL_MS` the rate limit would
  // not even absorb it: mute, then unmute. The gate is implemented and the
  // record is cleared so that a momentary action added later has one place to
  // grow an up-edge target, and so the "no down, no up" invariant above holds
  // when it does.
  const next = new Set(held);
  next.delete(id);
  return { dispatch: null, held: next, reason: "press-edge-only" };
}

/* ------------------------------------------------------------------------ *
 * 4. The focused DOM listener
 * ------------------------------------------------------------------------ */

/** Which edge a DOM keystroke is. */
export type KeybindEdge = "down" | "up";

/**
 * Why a DOM keystroke was not matched at all.
 *
 * - `"suppressed"` — a remote-control session owns the keyboard.
 * - `"auto-repeat"` — `KeyboardEvent.repeat`, on a press.
 */
export type DomKeyDropReason = "suppressed" | "auto-repeat";

/**
 * The actions a DOM keystroke matched, and why it matched none.
 *
 * A list rather than a single action because a RELEASE legitimately matches
 * more than one: `bindingMatchesRelease` compares the physical key alone, and
 * the store deliberately permits `Alt+KeyM` alongside `Ctrl+Alt+KeyM` (press
 * matching is exact, so those two never both fire on a press). Releasing that
 * letter ends both, which `../state/stores/Keybinds.ts` records as known and
 * accepted. Presses yield at most one by the store's one-action-per-chord
 * invariant, but this function does not rely on that — native's dispatch loop
 * has no early break either, so a torn state produces the same answer on both
 * transports rather than two different ones.
 */
export type DomKeyMatch = {
  readonly actions: readonly GlobalKeybindAction[];
  readonly reason: DomKeyDropReason | null;
};

/** Inputs to {@link matchDomKey}. */
export type DomKeyInput = {
  /** `state.keybinds.bindings()`. */
  readonly bindings: Record<GlobalKeybindAction, Binding | null>;
  /** The keystroke; duck-typed so a spec can pass an object literal. */
  readonly event: KeyLikeEvent;
  readonly edge: KeybindEdge;
  /** `keybindsSuppressed()` from `./suppress`. */
  readonly suppressed: boolean;
  /** `KeyboardEvent.repeat`; ignored on a release. */
  readonly repeat: boolean;
};

/**
 * Match a FOCUSED keystroke against the persisted bindings.
 *
 * # 🔴 Suppression is checked first, before any matching
 *
 * While a remote-control session has the capture surface live, every
 * keystroke the controller types is meant for the SHARER'S machine. The
 * native path is already immune — `keyboard_proc` excludes injected input
 * carrying `RC_INJECT_EXTRA` from every match — but the DOM path is not:
 * injected input reaches the webview as an ordinary `keydown`, which is the
 * entire reason `./suppress.ts` exists. Without this check a remote
 * controller typing on the sharer's machine can hang up the sharer's call.
 *
 * The check is here, in the pure decision, rather than as an early `return`
 * in the listener, for the reason `./suppress.ts` gives for putting it inside
 * `keybindFilter` rather than at the capture surface: correctness that
 * depends on listener order or DOM focus is correctness that breaks on the
 * next remount.
 *
 * 🔴 A suppression EDGE is a separate obligation this function cannot
 * discharge — a key held across one loses its release, so the caller must
 * also send `"release-all"` on both edges of the flag. See the effect in
 * `KeybindsWorker`, and note that `registerActiveKeyReset` is NOT the way to
 * do it: that is a single-slot registration already held by `KeybindContext`
 * (`./keybindHandler.tsx`), and a second caller silently clobbers the in-app
 * handler's own `activeKeys` reset — the latch that module documents.
 *
 * # 🔴 Presses match exactly; releases match on `code` alone
 *
 * `bindingMatchesPress` compares all three modifiers, so a global binding
 * cannot steal every superset chord out from under the focused application.
 * `bindingMatchesRelease` compares the physical key only, because users
 * unroll a chord in whatever order their hand does and letting go of Ctrl
 * first is the common one — under exact equality the release of `Ctrl+KeyM`
 * arrives as `{ code: "KeyM", ctrlKey: false }`, fails the comparison, and
 * the action never gets its up edge. The asymmetry is also the native
 * contract, so a renderer using exact equality on release would DISAGREE with
 * the native layer about which actions are held.
 *
 * # No tier filter, and no editable-target filter
 *
 * The tier filter belongs to {@link planKeybindArm} alone. This transport is
 * the only one that can carry an `"in-app"` action, and it is a necessary
 * second transport for `"global"` ones because the native hook is measurably
 * blind while this app owns the foreground (`ptt.rs`: 20 physical keydowns
 * produced zero callbacks, cause still unexplained).
 *
 * There is deliberately no "is the user typing into a text field" check
 * either. It would make this transport disagree with the native one about
 * whether a press counts, and the native side has no DOM to consult; the
 * place to prevent a bare unmodified letter from firing while the user types
 * is the capture UI refusing to record one.
 */
export function matchDomKey(input: DomKeyInput): DomKeyMatch {
  if (input.suppressed) return { actions: [], reason: "suppressed" };

  // Presses only: a `keyup` has no `repeat`, and gating a release on one
  // would drop it — a dropped release latches the action down.
  if (input.edge === "down" && input.repeat) {
    return { actions: [], reason: "auto-repeat" };
  }

  const actions: GlobalKeybindAction[] = [];
  for (const action of GLOBAL_KEYBIND_ACTIONS) {
    const binding = input.bindings[action];
    if (!binding) continue;

    const matched =
      input.edge === "down"
        ? bindingMatchesPress(binding, input.event)
        : bindingMatchesRelease(binding, input.event);
    if (matched) actions.push(action);
  }

  return { actions, reason: null };
}
