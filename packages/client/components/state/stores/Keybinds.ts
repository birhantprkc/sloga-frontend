/**
 * Persisted GLOBAL (system-wide) keybinds: which chord, if any, each of the
 * twelve `../../keybinds/globalKeybinds.ts` actions is bound to.
 *
 * This store owns the **data** only. Arming the native hook, throttling press
 * edges and dispatching the actions belong to the dispatch lane — see
 * {@link Keybinds.hydrate} for why the store deliberately does not arm.
 *
 * # What was here before
 *
 * A commented-out husk of the *in-app* keybind defaults (`@revolt/keybinds`'
 * `KeybindAction` / `KeyComboSequence`), plus a `default()` / `clean()` pair
 * that both returned `{}`. None of the husk is reusable here and it is
 * removed rather than adapted: the live copy of that table is
 * `../../keybinds/keybindSequences.ts`' `DEFAULT_SEQUENCES`, it is keyed on a
 * different action enum, and its entries are `KeyboardEvent.key` sequences
 * matched by a focused DOM listener. A {@link Binding} is a
 * `KeyboardEvent.code` chord armed by the native hook. See `Binding`'s doc
 * comment in `globalKeybinds.ts`: the two vocabularies are over different
 * transports and must never be mixed.
 *
 * # Per-device, and staying that way
 *
 * 🔴 `keybinds` is NOT added to `./Sync.ts`. `SynchronisedStores` there is
 * exactly `"ordering" | "notifications" | "release-notes" | "friends"`, and
 * `voice` — which holds `pushToTalkKey`, the closest existing analogue — is
 * pointedly absent for the same reason: a chord chosen to stay clear of the
 * games and window managers on one machine is not the chord you want on
 * another, and a key grab that follows the account onto a shared or work
 * machine is a decision nobody has taken. Server-syncing these is a separate
 * change that also widens the server's write surface onto something that can
 * silently intercept keystrokes.
 */
import type { State } from "..";

// Relative specifier with an explicit `.ts`, not the `@revolt/keybinds` alias.
// The alias is a tsconfig `paths` / vite entry that `node --test` does not
// resolve, and this module's `clean()` is unit-tested. Matches
// `../../rtc/whisperPermissions.ts` and
// `../../rtc/transcription/transcriptExport.ts`, which take the same shape for
// the same reason.
//
// The two type-only names carry inline `type` markers (as in
// `../../rtc/transcription/callTranscriber.ts`) because Node's type-stripping
// does not elide import specifiers: left unmarked, `Binding` would survive
// into the emitted import list and fail as a missing runtime export.
import {
  type Binding,
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  MAX_BINDINGS,
  bindingsEqual,
  isGlobalKeybindAction,
  isReservedCombo,
  normalizeBinding,
} from "../../keybinds/globalKeybinds.ts";

import { AbstractStore } from ".";

export type TypeKeybinds = {
  /**
   * The chord bound to each action, or `null` for "not bound".
   *
   * Total rather than partial (`Record<…, Binding | null>`, not
   * `Partial<Record<…, Binding>>`) so that adding an action to
   * `GLOBAL_KEYBIND_ACTIONS` is a compile error in {@link defaultKeybinds}
   * until it is given a value here, the same exhaustiveness
   * `globalKeybinds.ts`' own `KEYBIND_TIER` / `KEYBIND_REQUIREMENT` tables
   * get from their explicit `Record<…>` annotations.
   *
   * At most one action holds any given chord — see
   * {@link cleanKeybinds} and {@link Keybinds.setBinding}.
   */
  bindings: Record<GlobalKeybindAction, Binding | null>;
};

/**
 * Validate one persisted entry and return a NORMALIZED copy, or `null`.
 *
 * Every field is checked for its own type and a failure rejects the whole
 * binding rather than substituting a default, because a partially-defaulted
 * chord is a *different chord*: reading a non-boolean `shift` as `false`
 * silently rebinds `Ctrl+Shift+KeyM` to `Ctrl+KeyM`, which then fires on a
 * keystroke the user never chose (modifier matching is exact — see
 * `bindingMatchesPress`). Dropping the entry leaves a visibly blank row the
 * user can refill; coercing it leaves a wrong row that looks right.
 *
 * The return value is rebuilt field by field rather than passed through, so
 * any extra property a future build persisted is discarded here. That keeps
 * the stored blob shaped like the pinned `keybinds_arm` payload
 * (`{ id, code, ctrl, shift, alt }`) instead of smuggling, say, a `meta` bit
 * that the native half has no field for and would ignore.
 *
 * An empty `code` is rejected: no real `KeyboardEvent.code` is `""`, so it is
 * a row that looks bound and can never fire — the same failure mode as the
 * reserved combo below.
 *
 * The rebuilt copy is then passed through `normalizeBinding`, which clears
 * the one flag the binding's own key names (`ShiftLeft` with `shift`,
 * `ControlLeft` with `ctrl`, and so on) and leaves every other binding
 * as it is. A modifier's own keydown carries its flag, so a capture or a
 * hand-edited blob can present a bare Shift as `{ ShiftLeft, shift: true }`
 * while a normalized one is `{ ShiftLeft, shift: false }`; both matchers
 * ignore that flag, so the two shapes are ONE effective key. The store must
 * not persist both, because the duplicate checks in {@link cleanKeybinds}
 * and {@link Keybinds.setBinding} compare whole chords with `bindingsEqual`
 * and would let two rows hold the same key and both fire on one press.
 * Normalizing here, on the single path every persisted or written entry
 * passes through, puts the shape right before either check runs.
 */
function validBinding(value: unknown): Binding | null {
  if (typeof value !== "object" || value === null) return null;

  const candidate = value as Record<string, unknown>;
  if (typeof candidate.code !== "string" || candidate.code === "") return null;
  if (typeof candidate.ctrl !== "boolean") return null;
  if (typeof candidate.shift !== "boolean") return null;
  if (typeof candidate.alt !== "boolean") return null;

  return normalizeBinding({
    code: candidate.code,
    ctrl: candidate.ctrl,
    shift: candidate.shift,
    alt: candidate.alt,
  });
}

/** How many actions currently hold a chord. */
function countBound(bindings: Record<GlobalKeybindAction, Binding | null>) {
  return GLOBAL_KEYBIND_ACTIONS.filter((action) => bindings[action] !== null)
    .length;
}

/**
 * Generate default values.
 *
 * 🔴 **No default bindings at all — every action `null`.** The feature is
 * opt-in and ships no global hotkeys, because a global binding is not scoped
 * to this application: a default that grabbed, say, `Alt+KeyM` would take that
 * chord away from whatever game or editor the user is actually in, system-wide,
 * from the moment they update. That complaint is the reason the capture UI and
 * this store exist, so shipping it as a default would be self-defeating.
 *
 * Exported as a free function (and a fresh object each call) mirroring
 * `./voiceOverlay.ts`' `defaultOverlaySettings`, so the specs can drive it
 * without a running `State`.
 */
export function defaultKeybinds(): TypeKeybinds {
  const bindings = {} as Record<GlobalKeybindAction, Binding | null>;

  for (const action of GLOBAL_KEYBIND_ACTIONS) {
    bindings[action] = null;
  }

  return { bindings };
}

/**
 * Validate the given data to see if it is compliant and return a compliant
 * object.
 *
 * 🔴 **`bindings` appears in BOTH {@link defaultKeybinds} and here, and must
 * stay in both.** This store family has no schema version anywhere —
 * `State.hydrate()` (`../index.tsx`) reads the raw blob off localforage, runs
 * it through `clean()`, and writes the result back when it differs. `clean()`
 * *is* the migration mechanism. A key present in `default()` but not built
 * here is therefore silently deleted from every existing install on its next
 * boot; a key present here but not in `default()` is missing until the first
 * hydration, so a fresh install reads `undefined`.
 *
 * 🔴 **This validates and PRESERVES; it never discards wholesale.** The
 * previous body was `return {}` unconditionally, which is the bug this
 * rewrite exists to fix — with the real type in place that would have
 * dropped every binding the user had set on every single boot, and written
 * the empty result back to disk. Input arrives from IndexedDB (or from
 * `Sync.merge`'s `JSON.parse`) and may hold anything: a missing key, `null`,
 * an array, an id from a future version, a `code` that is not a string. Every
 * one of those is handled per-entry, valid siblings survive, and nothing
 * throws — a throw here aborts `State.hydrate()`'s loop and takes every store
 * after `keybinds` down with it.
 *
 * Iteration is driven by `GLOBAL_KEYBIND_ACTIONS`, never by the input's own
 * keys. Two properties follow:
 *
 * 1. **An action id this build does not know is never read, so it cannot be
 *    carried.** That is strictly stronger than filtering the input's keys with
 *    `isGlobalKeybindAction` would be, and it is why that predicate is not
 *    called on this path; its real job is the wire-ingress direction, where it
 *    guards {@link Keybinds.bindingForId}. Carrying a future id forward would
 *    put an unknown key into `KEYBIND_REQUIREMENT`, which reads `undefined` as
 *    "no precondition" and dispatches unguarded.
 * 2. **The duplicate tie-break below is deterministic**, because the order is
 *    the declared action order rather than IndexedDB's insertion order. That
 *    matters concretely: `State.hydrate()` compares `equal(data, cleanData)`
 *    and writes back on a difference, so a `clean()` whose output depended on
 *    key order would rewrite the blob on every boot and could oscillate
 *    between two valid answers.
 */
export function cleanKeybinds(
  input: Partial<TypeKeybinds> | null | undefined,
): TypeKeybinds {
  const data = defaultKeybinds();

  // `Partial<TypeKeybinds>` is a compile-time promise about data that came
  // off disk, so it is re-checked here rather than trusted. `null` passes
  // `typeof === "object"` and an array indexes fine, hence both guards.
  const raw = (input as { bindings?: unknown } | null | undefined)?.bindings;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return data;
  }

  const persisted = raw as Record<string, unknown>;
  const accepted: Binding[] = [];

  for (const action of GLOBAL_KEYBIND_ACTIONS) {
    // Validated AND normalized before the reserved and duplicate checks, so a
    // blob holding `{ ShiftLeft, shift: true }` on one action and
    // `{ ShiftLeft, shift: false }` on another is seen as one chord twice.
    const binding = validBinding(persisted[action]);
    if (!binding) continue;

    // The remote-control panic combo (Ctrl+Shift+Alt+Q). The native side
    // refuses to arm it, so persisting one stores a row the settings UI shows
    // as bound and which can never fire. Dropped here as well as at capture
    // time, because a blob can predate the capture-time refusal or be
    // hand-edited.
    if (isReservedCombo(binding)) continue;

    // 🔴 Intra-set duplicate policy: FIRST in GLOBAL_KEYBIND_ACTIONS order
    // keeps the chord, later holders are nulled.
    //
    // The tradeoff, stated plainly: nulling a duplicate is data loss, and
    // keeping both is a footgun. Keeping both is the worse of the two, for
    // three reasons.
    //
    // 1. The native dispatch loop has no early break, so both actions fire on
    //    one press. The pairs available here are not harmless — `toggle-mute`
    //    plus `disconnect-call` on one chord means reaching for mute and
    //    leaving the call, from a keystroke made in another application, with
    //    no dialog in the way.
    // 2. `globalKeybinds.ts` assigns this check to this module by name:
    //    `findBindingConflict`'s "What this does NOT check" says duplicates
    //    "live in the store, which owns that comparison", and `bindingsEqual`
    //    is exported for it. Declining it would leave the check nowhere.
    // 3. The loss is bounded and self-evident, which the footgun is not. One
    //    row in the settings list goes blank and the user rebinds it in
    //    seconds; nothing else in the blob is touched. A double-fire is
    //    invisible until it happens and then destroys call state.
    //
    // Comparison is full-chord (`bindingsEqual`), NOT physical-key identity.
    // Deduplicating on `code` alone would also refuse `Alt+KeyM` alongside
    // `Ctrl+Alt+KeyM`, which is a legitimate pair: press matching is exact on
    // all three modifiers, so those two never both fire on a press, and
    // nulling one would be data loss with no harm to prevent. The residual is
    // known and accepted: `bindingMatchesRelease` compares physical key only,
    // so releasing the letter of one such pair ends both. That is harmless for
    // all twelve actions today because every one is dispatched on the press
    // edge and none has momentary (held) semantics — `pushToTalkKey` is a
    // separate mechanism on `voice`, and a candidate colliding with it is
    // already refused on `code` alone by `findBindingConflict`. 🔴 Adding a
    // momentary global action would make the release cross-fire real and
    // require revisiting this to `code`-identity.
    if (accepted.some((held) => bindingsEqual(held, binding))) continue;

    // The native cap. Unreachable today — `MAX_BINDINGS` is 16 and
    // `GLOBAL_KEYBIND_ACTIONS` has 12 entries, so every action could be bound
    // at once and still fit; a spec pins that inequality so it fails loudly if
    // a later lane adds a 17th action. Enforced anyway rather than left as a
    // comment, because the failure it prevents is not a rejected 17th binding:
    // `keybinds_arm` replaces the whole armed set, so an arm the native side
    // rejects for being oversized has already discarded what was working.
    if (accepted.length >= MAX_BINDINGS) continue;

    accepted.push(binding);
    data.bindings[action] = binding;
  }

  return data;
}

export class Keybinds extends AbstractStore<"keybinds", TypeKeybinds> {
  /**
   * Construct store
   * @param state State
   */
  constructor(state: State) {
    super(state, "keybinds");
  }

  /**
   * Hydrate external context
   *
   * Nothing to do, deliberately. The obvious thing to put here — arming the
   * native hook with the persisted set — must not live in the store:
   *
   * - `State.hydrate()` runs every store's `hydrate()` before any UI is
   *   mounted, so an arm from here would arm the hook before the dispatch
   *   layer has any `keybind:down` / `keybind:up` listener attached. A press
   *   in that window is delivered nowhere, and its `keybind:up` with it.
   * - `keybinds_arm` is a release-all (`ARM_RELEASES_ALL_HELD` in
   *   `globalKeybinds.ts`): whoever calls it must drop every action it
   *   believes is held, unconditionally. That held-set is dispatch-lane state
   *   the store has no access to, so the caller and the owner of the
   *   held-set have to be the same module.
   */
  hydrate(): void {
    /** nothing needs to be done */
  }

  /**
   * Generate default values
   */
  default(): TypeKeybinds {
    return defaultKeybinds();
  }

  /**
   * Validate the given data to see if it is compliant and return a compliant object
   */
  clean(input: Partial<TypeKeybinds>): TypeKeybinds {
    return cleanKeybinds(input);
  }

  /**
   * Every action's current binding
   * @returns Action to binding (or `null`) map
   */
  bindings(): Record<GlobalKeybindAction, Binding | null> {
    return this.get().bindings;
  }

  /**
   * Binding for one action
   * @param action Action
   * @returns Binding, or `null` if unbound
   */
  binding(action: GlobalKeybindAction): Binding | null {
    return this.get().bindings[action] ?? null;
  }

  /**
   * Binding for an action id that arrived off the wire
   *
   * 🔴 This is the ingress guard `isGlobalKeybindAction` exists for.
   * `keybind:down` / `keybind:up` carry `{ id: string }` because the native
   * side stringifies whatever it was armed with, and a stale `keybinds_arm`
   * racing a rebuild can name an action this build does not have. Indexing
   * the record with an unchecked string instead would read `undefined` and
   * invite the caller to treat it as "unbound" when the truth is "unknown".
   *
   * @param id Action id, unvalidated
   * @returns Binding, or `null` if the id is unknown or the action is unbound
   */
  bindingForId(id: string): Binding | null {
    if (!isGlobalKeybindAction(id)) return null;
    return this.binding(id);
  }

  /**
   * Which OTHER action already holds this chord
   *
   * Exposed because `findBindingConflict` in `globalKeybinds.ts` deliberately
   * does not check intra-set duplicates — the binding set lives here. The
   * capture UI is expected to call this and warn before calling
   * {@link Keybinds.setBinding}, which resolves the collision by taking the
   * chord rather than refusing it.
   *
   * @param candidate Chord to test
   * @param except Action being rebound, which is not its own conflict
   * @returns The conflicting action, or `null`
   */
  conflictingAction(
    candidate: Binding,
    except?: GlobalKeybindAction,
  ): GlobalKeybindAction | null {
    // Normalized first, for the same reason `setBinding` normalizes before its
    // duplicate sweep: everything already held is stored with a modifier key's
    // own flag cleared, so an un-normalized `{ShiftLeft, shift: true}` would
    // compare unequal to the identical binding on another row, report "no
    // conflict", and then be silently stolen by the write that follows.
    const wanted = normalizeBinding(candidate);
    const bindings = this.bindings();

    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      if (action === except) continue;

      const held = bindings[action];
      if (held && bindingsEqual(held, wanted)) return action;
    }

    return null;
  }

  /**
   * Bind a chord to an action
   *
   * Any other action holding the same chord is unbound, keeping the
   * one-action-per-chord invariant that {@link cleanKeybinds} enforces on the
   * hydration path. Last write wins here — unlike `clean()`, this call is an
   * explicit, current user action, and refusing it would leave the settings UI
   * with no way to move a chord from one row to another. The UI is expected to
   * have surfaced {@link Keybinds.conflictingAction} first.
   *
   * @param action Action to bind
   * @param binding Chord
   * @returns Whether it was accepted
   */
  setBinding(action: GlobalKeybindAction, binding: Binding): boolean {
    // Re-validated rather than trusted: the argument is typed, but a capture
    // UI mid-chord can hand over a half-built object, and this also strips any
    // extra property before it reaches disk. It also normalizes a
    // modifier-keyed chord, and it runs FIRST on purpose: the reserved check
    // and the duplicate sweep below compare the normalized shape, so
    // `{ ShiftLeft, shift: true }` written over a row holding
    // `{ ShiftLeft, shift: false }` takes that row instead of sitting beside
    // it as a second copy of the same key.
    const clean = validBinding(binding);
    if (!clean) return false;

    // Refused, not stolen: the native layer will not arm the panic combo, so
    // accepting it would store a row that silently never fires.
    if (isReservedCombo(clean)) return false;

    const next = { ...this.bindings() };

    for (const other of GLOBAL_KEYBIND_ACTIONS) {
      const held = next[other];
      if (other !== action && held && bindingsEqual(held, clean)) {
        next[other] = null;
      }
    }

    next[action] = clean;

    // Unreachable with twelve actions and a cap of sixteen; see the note in
    // `cleanKeybinds`. Checked before the write so the refusal happens here
    // rather than at `keybinds_arm`, which would have discarded the working
    // set by the time it failed.
    if (countBound(next) > MAX_BINDINGS) return false;

    this.set("bindings", next);
    return true;
  }

  /**
   * Unbind an action
   * @param action Action
   */
  clearBinding(action: GlobalKeybindAction) {
    this.set("bindings", { ...this.bindings(), [action]: null });
  }

  /**
   * Unbind everything, returning to the shipped default
   */
  resetBindings() {
    this.set("bindings", defaultKeybinds().bindings);
  }
}
