/**
 * The pure decision behind `Voice.dispatchKeybind()` in `./state.tsx`: given
 * everything the guards read, is this global-keybind press ACCEPTED, and if
 * not, which guard dropped it.
 *
 * # Why this is a separate module
 *
 * `state.tsx` cannot be loaded by a unit runner at all, and that was verified
 * rather than assumed: it imports `livekit-client/e2ee-worker?worker` (a
 * Vite-only specifier that is not a resolvable path), `solid-livekit-components`,
 * `@capacitor/core` and five `@revolt/*` tsconfig-`paths` aliases, and it is a
 * `.tsx`, which `node --test` refuses outright — Node's type-stripping handles
 * `.ts`/`.mts`/`.cts` and throws `ERR_UNKNOWN_FILE_EXTENSION` on JSX, because
 * stripping types is not transforming syntax. No `components/rtc/*.test.ts`
 * imports `state.tsx`, and none can.
 *
 * So four guards that decide whether a keypress the user made in ANOTHER
 * application reaches the voice stack had zero automated coverage while they
 * lived inline. They are the correctness core of the feature: guard 3 exists
 * specifically to stop an unfocused keypress from throwing an error modal over
 * whatever the user was doing, and guard 2 exists to stop a second press from
 * spending the publish-gate sweeper's one-round margin and leaving a track
 * upstream-paused behind a mic button that reads live.
 *
 * This is the same component/pure-leaf split as `./joinRefusalPolicy`,
 * `./androidLegStartPolicy`, `./pauseVerdict`, `./vadGatePolicy` and the
 * sibling `../ui/components/design/keyCapturePolicy.ts`, drawn the same way:
 * **every decision is here** and `state.tsx` keeps only the mutable state
 * (`#keybindInFlight`, `#keybindLastAccepted`, `#pttHeld`), the signal reads
 * that feed this, and the side effects. A decision left inline is a decision
 * with no test.
 *
 * # Dependency-free apart from the vocabulary
 *
 * No framework import, deliberately — `solid-js` here would put this right
 * back out of reach of `node --test`, which is the entire point. The one
 * import is the type-only half of the keybind vocabulary, by relative
 * specifier with an explicit `.ts` and inline `type` markers, for the reason
 * `keyCapturePolicy.ts` and `../state/stores/Keybinds.ts` both record: the
 * `@revolt/keybinds` alias is a tsconfig `paths` entry the test runner does
 * not resolve, and Node's type-stripping does not elide import specifiers, so
 * an unmarked type name would survive into the emitted import list and fail
 * at runtime as a missing export.
 */
import type {
  GlobalKeybindAction,
  KeybindRequirement,
} from "../keybinds/globalKeybinds.ts";

/**
 * Everything the five guards read, at the instant of the press.
 *
 * Plain data, not the `Voice` instance: that is what makes this callable from
 * `node --test` with an object literal, and what keeps the guards from
 * acquiring a hidden dependency on class internals.
 *
 * `requirement` and `minIntervalMs` are passed in rather than read off
 * `KEYBIND_REQUIREMENT` / `KEYBIND_MIN_INTERVAL_MS` in here, for two reasons.
 * The spec can then drive the rate-limit boundary at an interval it names
 * itself instead of being pinned to whatever the constant happens to be, and
 * every input this function branches on is visible in one place at the call
 * site. The cost is that a caller could pass a requirement that is not the
 * one the table holds for `action`; `state.tsx` is the only caller and passes
 * `KEYBIND_REQUIREMENT[action]` literally.
 *
 * 🔴 `now` and `lastAccepted` MUST come from the same MONOTONIC clock
 * (`performance.now()`). See {@link decideKeybindDispatch} guard 2.
 */
export type KeybindDispatchInput = {
  /** The action the press is bound to. */
  action: GlobalKeybindAction;
  /** `KEYBIND_REQUIREMENT[action]`. */
  requirement: KeybindRequirement;
  /** `performance.now()` at this press edge. */
  now: number;
  /** `performance.now()` of the last ACCEPTED press of THIS action, if any. */
  lastAccepted: number | undefined;
  /** `KEYBIND_MIN_INTERVAL_MS`. */
  minIntervalMs: number;
  /** A dispatch of THIS action has started and not settled. */
  inFlight: boolean;
  /** `Voice.room() !== undefined`. */
  hasRoom: boolean;
  /** `incomingCall() !== undefined` — a ring is up. */
  hasIncomingCall: boolean;
  /** `Voice.pttActive()` — a push-to-talk key is held right now. */
  pttHeld: boolean;
  /** `Voice.fullscreen()` — the call view is fullscreen. */
  isFullscreen: boolean;
};

/**
 * Which guard dropped the press. Machine-readable rather than a boolean
 * because the reason is the observable part of a rejection: a spec that only
 * asserted "rejected" would pass with the guards in any order, and the order
 * is behavior (see {@link decideKeybindDispatch}).
 *
 * - `"in-flight"` — a dispatch of this action is still awaiting.
 * - `"rate-limited"` — inside `minIntervalMs` of this action's last accepted
 *   press, or the clock went backwards.
 * - `"needs-room"` — a `"room"` action with no call.
 * - `"needs-incoming-call"` — an `"incoming-call"` action with no ring.
 * - `"has-room"` — an `"incoming-call"` action while a call is ALREADY live;
 *   the other half of the same precondition, separately named because it is a
 *   different failure (see guard 3).
 * - `"ptt-held"` — a mute toggle landing inside a push-to-talk hold.
 * - `"needs-fullscreen"` — theater outside fullscreen.
 */
export type KeybindDropReason =
  | "in-flight"
  | "rate-limited"
  | "needs-room"
  | "needs-incoming-call"
  | "has-room"
  | "ptt-held"
  | "needs-fullscreen";

/**
 * Accept, or a named refusal. A rejected press is dropped SILENTLY by the
 * caller and never queued: there is no feedback channel for a key pressed
 * while unfocused, and a modal is the specific outcome guard 3 exists to
 * prevent. The reason is for specs and for a `console.debug`, never for UI.
 */
export type KeybindDispatchVerdict =
  | { readonly accept: true }
  | { readonly accept: false; readonly reason: KeybindDropReason };

/**
 * THE decision for every global keybind press.
 *
 * 🔴 **The order of these guards is behavior**, because which reason a
 * rejected press reports is observable, and because the caller stamps
 * `#keybindLastAccepted` only on `accept` — so moving a guard across guard 2
 * changes what the NEXT press does. Do not reorder.
 *
 * 1. **In-flight, per action.** None of the voice toggles has an in-flight
 *    guard of its own; on the click path the guard comes free from the input
 *    device (a finger cannot produce two presses inside one renegotiation).
 *    A key gives no such guarantee. First, so an in-flight press reports
 *    `"in-flight"` and not `"rate-limited"` — they overlap for every action
 *    whose dispatch settles inside `minIntervalMs`, which is most of them.
 *
 * 2. **Rate limit, per action.** NOT redundant with (1): the failure it
 *    prevents OUTLIVES the await. Each mic unmute ends in livekit's
 *    unconditional `resumeUpstream()`, which re-asserts the publish gate and
 *    re-enters the coalescing sweeper, whose episode budget has a margin of
 *    exactly one round over the convergent path — so a second unmute landing
 *    after the first has RESOLVED but while its sweep is still draining
 *    spends that margin and drops a sweep, leaving a track upstream-paused
 *    behind a mic button that reads live.
 *
 *    🔴 MONOTONIC clock, and the comparison is written so that it stays
 *    monotonic: the test is `now - lastAccepted < minIntervalMs`, so a `now`
 *    that moved BACKWARDS yields a negative delta, which is inside the
 *    window and rejects. A wall-clock step (NTP, sleep/resume) must never be
 *    able to open the window this floor exists to keep shut. Written as
 *    `now < lastAccepted + minIntervalMs` it would behave identically; a
 *    `Math.abs` or an `elapsed > minIntervalMs || elapsed < 0` form would
 *    not.
 *
 *    A delta of EXACTLY `minIntervalMs` is accepted (`<`, not `<=`): the
 *    floor is the minimum spacing between presses, so the press at the floor
 *    is the first legal one.
 *
 * 3. **Precondition** (`KEYBIND_REQUIREMENT`). Without it a `"room"` action
 *    with no call pops an error modal — `toggleMute` / `toggleDeafen` /
 *    `toggleCamera` all `throw "invalid state"`, a bare string with no
 *    `.name`, which `onErr`'s `NotAllowedError` filter does not swallow —
 *    from a keypress the user made in ANOTHER application.
 *    `toggleScreenshare` throws the same string outside any try, i.e. an
 *    unhandled rejection.
 *
 *    `"incoming-call"` needs BOTH halves: a ring must be up, AND there must
 *    be no room yet. `accept-call` with a room already live would tear down
 *    the call the user is in, because `connect()` leads with `disconnect()`,
 *    and a stale ring that `dismissIncomingCall` has not cleared is exactly
 *    the state where that happens.
 *
 * 4. **Mute is inert during a push-to-talk hold.**
 *
 *    🔴 Both halves of the desync were verified in `state.tsx`. Push-to-talk
 *    does NOT consult `#settings.micOn` or `#settings.deafen` — `#pttKeydown`
 *    and the native `ptt:down` handler go straight to
 *    `#setMicEnabled(room, true)` past a whisper check and an
 *    already-enabled check, nothing else. `toggleMute`, meanwhile, flips the
 *    user's INTENT (`want = !this.#settings.micOn`) and then reconciles from
 *    the WIRE (`room.localParticipant.isMicrophoneEnabled`). So a mute press
 *    mid-hold writes `micOn` against a track state push-to-talk owns: the mic
 *    icon derives from settings (`micOn && !deafen && !whisper.target()`)
 *    while the toggle decided from the wire, and the two disagree until the
 *    next full toggle.
 *
 *    A no-op rather than "end the hold and mute": the user is holding a key
 *    to talk, and the honest reading of a mute press during it is that they
 *    pressed the wrong key. `#pttHeld`'s clears in `state.tsx` are what keep
 *    this from becoming a permanently dead mute key.
 *
 *    🔴 Deafen is deliberately NOT inert. It is a receive-side control the
 *    user may genuinely want mid-sentence, and `toggleDeafen` reads "are we
 *    deafened" off the persisted flag rather than the track, so it does not
 *    invert against the wire the way mute does. `pttHeld` therefore gates
 *    `"toggle-mute"` and nothing else.
 *
 * 5. **Theater needs fullscreen.** `KEYBIND_REQUIREMENT` is `"none"` for
 *    `toggle-theater` because it cannot THROW, not because it is
 *    unconditional — the table's own comment says its real precondition is
 *    already being in fullscreen and that "the dispatch layer reads it
 *    directly". This is that read. Without it `toggleImmersive()` sets
 *    `immersive` and hides the call bar in the normal view, where nothing
 *    offers a way back.
 *
 *    🔴 It is guard 5 and not part of guard 3 on purpose: it is a
 *    *precondition*, so it must sit BEFORE the accept — a press dropped by a
 *    precondition never happened, and stamping it would rate-limit the first
 *    press that CAN run. It is not IN guard 3 because `KEYBIND_REQUIREMENT`
 *    models only "does this need a guard to avoid the modal", and fullscreen
 *    is renderer UI state that table does not describe.
 */
export function decideKeybindDispatch(
  input: KeybindDispatchInput,
): KeybindDispatchVerdict {
  // Guard 1 — in-flight, per action.
  if (input.inFlight) return { accept: false, reason: "in-flight" };

  // Guard 2 — rate limit, per action. `lastAccepted === undefined` is the
  // first ever press of this action and is never limited.
  if (
    input.lastAccepted !== undefined &&
    input.now - input.lastAccepted < input.minIntervalMs
  )
    return { accept: false, reason: "rate-limited" };

  // Guard 3 — `KEYBIND_REQUIREMENT` precondition.
  switch (input.requirement) {
    case "none":
      break;
    case "room":
      if (!input.hasRoom) return { accept: false, reason: "needs-room" };
      break;
    case "incoming-call":
      if (!input.hasIncomingCall)
        return { accept: false, reason: "needs-incoming-call" };
      if (input.hasRoom) return { accept: false, reason: "has-room" };
      break;
    default: {
      // Exhaustiveness, for the same reason `KEYBIND_REQUIREMENT` is a
      // `Record<GlobalKeybindAction, …>` and `#runKeybind`'s switch has a
      // `never` arm: a fourth `KeybindRequirement` must be a COMPILE error
      // here, not a value that falls out of the switch.
      //
      // 🔴 That is ALL this arm buys — compile-time only. At RUNTIME it
      // changes nothing: `unreachable` is `never`, so `return unreachable` is
      // `return undefined`, exactly what falling out of the switch would do.
      // A `requirement` outside the union (a wire value, an id that is not a
      // `GlobalKeybindAction` indexing `KEYBIND_REQUIREMENT` to `undefined`)
      // therefore still yields NO verdict, and no arm here can prevent that.
      // Fail-closed is the CALLER's job: `dispatchKeybind` reads
      // `!verdict?.accept`, optionally, because an unguarded `verdict.accept`
      // off `undefined` throws a `TypeError` outside its `try` (which wraps
      // only `#runKeybind`) — an unhandled rejection from a keypress possibly
      // made in another application. Pinned by the out-of-union spec in
      // `./keybindDispatchPolicy.test.ts`.
      const unreachable: never = input.requirement;
      return unreachable;
    }
  }

  // Guard 4 — mute is inert during a push-to-talk hold. Mute ONLY.
  if (input.action === "toggle-mute" && input.pttHeld)
    return { accept: false, reason: "ptt-held" };

  // Guard 5 — theater needs fullscreen.
  if (input.action === "toggle-theater" && !input.isFullscreen)
    return { accept: false, reason: "needs-fullscreen" };

  return { accept: true };
}
