/**
 * Every DECISION behind the global keybinds settings page (`./Keybinds.tsx`):
 * which actions sit on which side of the tier split, what the arm state
 * proves about the global tier as a whole, what one row is entitled to
 * claim, and whether that claim closes the row to further capture.
 *
 * # Why this is a separate module
 *
 * `Keybinds.tsx` is a `.tsx` reaching `solid-js`, `@lingui-solid`, `@revolt/ui`
 * and `@revolt/state`, so nothing declared inside it is loadable by
 * `node --test` at all — and these are the decisions that decide whether a
 * first global key can ever be bound. The one that could not be tested is the
 * one that shipped wrong: with zero bindings the disarm path publishes
 * `nativeAvailable: false` (no evidence), the page read that as "no native
 * hook here", and every global row locked its capture on every platform,
 * including the Windows desktop app. This is the same component/pure-leaf
 * split as `../../../../keybinds/keybindWorkerPolicy.ts`, drawn for the same
 * reason: every decision is here, and the page keeps only the composition.
 *
 * Dependency-free apart from the vocabulary: the two imports are relative
 * specifiers with an explicit `.ts` and inline `type` markers, because the
 * `@revolt/keybinds` alias is a tsconfig `paths` entry the test runner does
 * not resolve and Node's type-stripping does not elide import specifiers.
 * {@link KeybindArmState} is imported from `keybindWorkerPolicy.ts` rather
 * than `armState.ts` on purpose — the latter calls `createSignal` at module
 * scope, and a dependency on it would put this module right back out of
 * reach of the runner.
 */
import {
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_TIER,
} from "../../../../keybinds/globalKeybinds.ts";
import { type KeybindArmState } from "../../../../keybinds/keybindWorkerPolicy.ts";

/* ------------------------------------------------------------------------ *
 * The tier split
 * ------------------------------------------------------------------------ */

/**
 * The actions the native hook can fire while Sloga is unfocused, in
 * `GLOBAL_KEYBIND_ACTIONS` order.
 *
 * Derived from `KEYBIND_TIER` rather than listed again. The tier table is the
 * single source of truth for which side of this split an action falls on, and
 * a second hand-written list here would be a copy that silently stops matching
 * it — the failure mode `globalKeybinds.ts` describes for
 * `IN_APP_DEFAULT_SEQUENCES`, without that list's excuse (there is no leaf
 * constraint here; the table is one import away).
 */
export const GLOBAL_TIER_ACTIONS: readonly GlobalKeybindAction[] =
  GLOBAL_KEYBIND_ACTIONS.filter((action) => KEYBIND_TIER[action] === "global");

/** The actions that can only ever be driven by a focused DOM keydown. */
export const IN_APP_TIER_ACTIONS: readonly GlobalKeybindAction[] =
  GLOBAL_KEYBIND_ACTIONS.filter((action) => KEYBIND_TIER[action] === "in-app");

/* ------------------------------------------------------------------------ *
 * What the arm state proves about the global tier
 * ------------------------------------------------------------------------ */

/**
 * What the arm state proves about the global tier as a whole, before any
 * row is looked at.
 *
 * - `"probing"` — no arm has been attempted yet. Not a negative and not a
 *   positive; the page makes no claim.
 * - `"unavailable"` — PROVEN ABSENT, in one of exactly two ways: there is no
 *   shell invoke bridge, so nothing can ever arm from this build; or bindings
 *   were submitted through a bridge and nothing came back named. Both are
 *   negatives the page is entitled to state outright.
 * - `"unproven"` — a bridge exists, nothing has been submitted through it,
 *   and so there is no evidence either way. This is the shipped default (zero
 *   bindings, disarm path), and on the Windows desktop app it is also the
 *   state of a working native layer that has simply not been asked yet.
 * - `"available"` — positive evidence: a submitted binding came back named in
 *   one of the three lists.
 *
 * 🔴 **A state with no evidence never locks capture.** The only way to get
 * evidence is to bind something and let the arm report on it, so a page that
 * treats `"unproven"` as a negative closes the one door the evidence has to
 * come through — every global row locked before a first key can be bound,
 * forever. `"unproven"` and `"available"` therefore both fall through to the
 * per-row answer in {@link keybindRowStatus}; only the two proven negatives
 * and the unanswered probe short-circuit it.
 */
export type GlobalTierStatus =
  | "probing"
  | "unavailable"
  | "unproven"
  | "available";

/**
 * Read the arm state for the whole global tier.
 *
 * The order is the contract. `probed` is checked before `bridge` because an
 * unprobed state carries its fields' defaults, not answers — reading
 * `bridge: false` off `UNPROBED_KEYBIND_ARM_STATE` as "no bridge" would call
 * every shell absent for the instant before the worker mounts. `bridge` is
 * checked before `nativeAvailable` because the bridge is the only path the
 * evidence can arrive by, so evidence without a bridge is a torn state that
 * must not be read as a positive. `nativeAvailable` is checked before
 * `submitted` because a positive is a positive whatever the count. And
 * `submitted > 0` is the whole separation between "tried, and nothing came
 * back" and "never tried": the former is a negative, the latter is not.
 */
export function globalTierStatus(arm: KeybindArmState): GlobalTierStatus {
  if (!arm.probed) return "probing";
  if (!arm.bridge) return "unavailable";
  if (arm.nativeAvailable) return "available";
  if (arm.submitted > 0) return "unavailable";
  return "unproven";
}

/* ------------------------------------------------------------------------ *
 * What one row may claim
 * ------------------------------------------------------------------------ */

/**
 * What this page is entitled to say about one row.
 *
 * - `"unsupported"` / `"refused"` — the native layer reported that this
 *   action's chord did not arm. Unbindable: the row must say so.
 * - `"probing"` — the capability answer is not in yet. 🔴 Distinct from
 *   `"unavailable"` on purpose: an unanswered probe is not a negative answer,
 *   and it is not a positive one either, so the row makes no claim.
 * - `"unavailable"` — the global tier is proven absent, in one of exactly the
 *   two ways {@link GlobalTierStatus} lists: no shell bridge, or a bridged
 *   arm that produced no evidence. Nothing in the global tier can fire
 *   WHILE SLOGA IS UNFOCUSED — the DOM transport applies no tier filter, so a
 *   chord already bound here still fires when the window has focus. Do not
 *   restate this as "nothing can fire": that sentence was shipped in the UI
 *   and had to be corrected. 🔴
 *   NOT "the probe answered and `nativeAvailable` is `false`": that reading
 *   also covers the no-evidence state, and the no-evidence state must stay
 *   open.
 * - `"armed"` — the id came back in `KeybindsArmResult.armed`. The **only**
 *   positive signal that a binding took, per that type's discharge rule; this
 *   is the one status that earns a "works system-wide" claim.
 * - `"unclaimed"` — no signal in either direction. An unbound row, an
 *   `"in-app"`-tier row (which is never submitted to `keybinds_arm` at all),
 *   a global row on an `"unproven"` tier, or a global row whose last arm did
 *   not mention it. The row shows its chord and promises nothing.
 */
export type KeybindRowStatus =
  | "unsupported"
  | "refused"
  | "probing"
  | "unavailable"
  | "armed"
  | "unclaimed";

/**
 * Decide what one row may claim, from the arm result and the tier.
 *
 * 🔴 **The two refusal lists are checked FIRST, ahead of the tier and probe
 * state.** They are facts about a specific chord that native has already
 * answered on, and they can only be non-empty if native answered at all — so
 * there is no ordering in which a refusal is masked by `"probing"`. They are
 * also not filtered by tier: an `"in-app"` action must never be submitted to
 * `keybinds_arm`, so its id appearing in a result at all is a bug in the
 * arming lane, and swallowing it here would hide that bug behind a row that
 * looks fine.
 *
 * 🔴 **`armed` is the only positive test.** `refused.length === 0 &&
 * unsupported.length === 0` is not evidence of anything — off Windows
 * `keybinds_arm` returns three empty lists and no error, which is
 * indistinguishable from success to a negative check. That is the exact shape
 * of the existing push-to-talk row's lie, which promises "works globally" off
 * `"__TAURI__" in window`.
 *
 * 🔴 **`nativeAvailable: false` is not read here at all.** The tier gate goes
 * through {@link globalTierStatus}, which is the only place that knows the
 * difference between "no evidence" and "proven absent"; a direct
 * `!arm.nativeAvailable` check is the exact line that locked every global row
 * on every platform with nothing bound.
 */
export function keybindRowStatus(
  action: GlobalKeybindAction,
  arm: KeybindArmState,
): KeybindRowStatus {
  if (arm.unsupported.includes(action)) return "unsupported";
  if (arm.refused.includes(action)) return "refused";

  if (KEYBIND_TIER[action] === "global") {
    const tier = globalTierStatus(arm);
    if (tier === "probing") return "probing";
    if (tier === "unavailable") return "unavailable";
    // `"unproven"` and `"available"` both fall through: neither is a claim
    // about THIS row, and the only per-row positive is `armed` membership.
  }

  if (arm.armed.includes(action)) return "armed";
  return "unclaimed";
}

/**
 * Should the row refuse further capture?
 *
 * 🔴 Only `"unavailable"`. A `"unsupported"` or `"refused"` row is exactly the
 * row the user needs to re-bind — locking it would leave them staring at a
 * chord that cannot work with no way to replace it. And `"probing"` stays open
 * because the store is authoritative regardless of the probe: a chord saved
 * while the answer is in flight arms when it lands.
 */
export function blocksCapture(status: KeybindRowStatus): boolean {
  return status === "unavailable";
}

/**
 * Should the row refuse to CLEAR what is already bound?
 *
 * 🔴 Never — and that is the whole point of this predicate existing. Locking
 * capture says "you cannot bind this here". Locking clear says "you cannot undo
 * what you already bound", which is a trap: on a shell that has an invoke
 * bridge but no native hook (macOS today) the first system-wide binding turns
 * every global row `"unavailable"`, and wiring the clear control to the same
 * flag left the user with a chord they could neither replace nor remove. The
 * only escape was the page-level reset, which wipes every binding they have.
 *
 * Written as a named predicate returning a constant rather than a literal
 * `false` at the call site so the asymmetry with {@link blocksCapture} is
 * visible here, and so a spec can hold it to it.
 */
export function blocksClear(_status: KeybindRowStatus): boolean {
  return false;
}
