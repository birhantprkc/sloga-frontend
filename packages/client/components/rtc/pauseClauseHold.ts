/**
 * Pause-clause hysteresis — a pure hold on the way DOWN from `disproved`.
 *
 * The banner's second line is derived from `callBanner(...).pause`, and
 * `"disproved"` is the one value with teeth: it tells the user their
 * microphone, camera or screen share may still be sending and that leaving
 * the call is the only sure way to stop it. The verdict behind it is a
 * per-episode live-wire observation, so across confirm cycles it can read
 * `disproved` → quiet → `disproved` in quick succession while nothing about
 * the call has actually changed. Rendering that raw would FLASH the blocking
 * line — up for a beat, down for a beat, up again — which is both
 * unreadable and, worse, teaches the user that the warning is noise. This
 * module holds the clause at `"disproved"` for `PAUSE_DISPROOF_HOLD_MS` after
 * the LAST disproof, so a bounce inside that window reads as one continuous
 * warning. The 15 s is the same figure as the session's
 * `REUPGRADE_HYSTERESIS_MS` (`mlsCallSession.ts`), for the same reason: a
 * transition that can oscillate must not be shown at the oscillation's
 * frequency.
 *
 * What the hold must NEVER do is outlive the thing it softens. A hold is
 * only ever applied on top of a banner that is still raised (a gated kind)
 * and still claims a held gate (`pause !== "none"`). The moment the banner
 * goes `none` — the call re-secured and the gate released 1→0 — or the pause
 * clause goes `none` — the user confirmed plaintext, or the kind changed to
 * one that carries no pause — the hold drops IMMEDIATELY and `heldUntil`
 * resets to 0. That resume is real, and holding "may still be sending" over
 * a green call would be exactly the false red this slice exists to remove.
 *
 * House pattern (`mlsAdmitGracePolicy.ts`): pure, dependency-free, `now` is
 * injected, the function returns a window, and the CALLER owns the timer.
 * The banner component keeps one `setTimeout(holdExpiresIn(state, now))`
 * to re-evaluate when the hold lapses, mirroring its existing rise debounce;
 * nothing in here schedules anything, so `node --test` can pin every arm.
 * `now` may be any millisecond clock so long as the same clock feeds every
 * call and `holdExpiresIn`.
 */

import type { CallBanner, PauseClause } from "./mlsCallModePolicy.ts";

/**
 * How long the `"disproved"` clause stays up after the LAST disproof, in
 * milliseconds. Equal to the session's `REUPGRADE_HYSTERESIS_MS`; the two
 * bound the same bounce.
 */
export const PAUSE_DISPROOF_HOLD_MS = 15_000;

/** The hold's whole state. `heldUntil === 0` means no hold is armed. */
export interface HoldState {
  /** Clock value (same clock as `now`) at which the hold lapses; 0 = none. */
  readonly heldUntil: number;
}

/** The inert state: nothing held. Use as the component's initial value. */
export const NO_HOLD: HoldState = { heldUntil: 0 };

/** What `holdPauseClause` hands back: the next state and the clause to show. */
export interface HeldPauseClause {
  readonly state: HoldState;
  readonly pause: PauseClause;
}

/**
 * Fold one banner observation through the hold.
 *
 * - `banner.pause === "disproved"`: re-arm. `heldUntil` is stamped from THIS
 *   observation, so the hold measures time since the last disproof, not the
 *   first.
 * - `banner.kind === "none"` or `banner.pause === "none"`: drop immediately.
 *   The banner's own clause passes through unchanged.
 * - otherwise (a raised kind whose gate is `"held"`): keep showing
 *   `"disproved"` while the hold is live, else pass `"held"` through. The
 *   previous state object is returned as-is while holding, so a memo keyed on
 *   identity does not churn every tick.
 */
export function holdPauseClause(
  prev: HoldState,
  input: { banner: CallBanner; now: number },
): HeldPauseClause {
  const { banner, now } = input;
  if (banner.pause === "disproved") {
    return {
      state: { heldUntil: now + PAUSE_DISPROOF_HOLD_MS },
      pause: "disproved",
    };
  }
  if (banner.kind === "none" || banner.pause === "none") {
    return { state: NO_HOLD, pause: banner.pause };
  }
  if (prev.heldUntil > now) {
    return { state: prev, pause: "disproved" };
  }
  return { state: NO_HOLD, pause: "held" };
}

/**
 * Milliseconds until the hold lapses, for sizing the caller's one timer.
 * 0 when nothing is held or the hold has already expired — a caller that
 * treats 0 as "do not arm" never schedules a no-op wake-up.
 */
export function holdExpiresIn(state: HoldState, now: number): number {
  return state.heldUntil > now ? state.heldUntil - now : 0;
}
