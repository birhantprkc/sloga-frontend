/**
 * The T0d negotiating fail-safe's decision, as a pure function.
 *
 * Split out of `mlsCallSession.ts` for the same reason every other policy here
 * is (`mlsAdmitPolicy`, `mlsCallModePolicy`, `mlsDrainPolicy`,
 * `mlsJoinRequestPolicy`): the session class cannot be imported under
 * `node --test`, and a rule with no test is a rule nobody can control.
 */

/** Bounded fail-safe re-arms while the open-group probe is still PENDING
 *  (LOW-2) — beyond this the probe shares the DS's unreachability and the
 *  availability escape applies. */
export const MAX_FAILSAFE_REARMS = 2;

/** What the fail-safe should do when its window expires. */
export type NegotiatingFailsafeAction =
  | "ignore"
  | "resecure"
  | "rearm"
  | "release";

export interface NegotiatingFailsafeInput {
  /**
   * Has the DS answered create/join at all — ANY status, 409 included?
   *
   * 🔴 This is the term the implementation was missing, and its absence was a
   * deterministic false alarm rather than a rare race. The fail-safe is
   * specified for exactly one condition — "the session produces NO verdict
   * within this window (DS unreachable — no create/join response)" — but it
   * was written as a bare timer that only re-checked `negotiating`.
   *
   * A 409 conflict IS a verdict: the DS answered, and it answered in
   * milliseconds. The join it routes us to is then bounded by
   * `MAX_JOINER_RETRIES * JOINER_RETRY_MS` = 30 s, six times the 5 s fail-safe
   * window. So every conflicted join — every joiner, on every call where a
   * group already exists — tripped this at 5 s and latched loud RE-SECURING
   * with the publish gate held, on a session that was converging normally.
   *
   * Reported from the field as "sometimes it works great and other times it is
   * a troubleshooting", which is precisely the shape: the CREATOR never
   * conflicts and never trips it, the JOINER always does.
   */
  dsVerdictSeen: boolean;
  /**
   * The channel's open-group probe, whose own verdict may still be pending.
   *
   * `ratelimited`: the probe was answered 429. That is not a verdict about
   * the group and it is not unreachability either — the DS answered, and
   * the budget it is refusing from is this session's own MLS bucket, which
   * nothing but an E2EE call's bring-up spends. The availability escape is
   * justified by same-origin UNREACHABILITY (R2-6), so it does not apply:
   * treat it like an open group and hold the gate, loud.
   */
  probe: "open" | "pending" | "none" | "ratelimited";
  /** Re-arms already consumed against [`MAX_FAILSAFE_REARMS`]. */
  rearmsUsed: number;
  /**
   * A loud verdict is already latched (`#latchLoud`): the establish threw —
   * a 429 past the transport's bounded retries, a 5xx, a native refusal — or
   * the self-enrolment assertion fired. The chip reads NOT-ENCRYPTED and the
   * banner offers Leave / Stay-unencrypted on the promise that publishing is
   * paused.
   *
   * 🔴 Firing the availability escape under that latch made the promise
   * false: `#onLoud` leaves the mode at `negotiating` and this fail-safe only
   * re-checked the mode, so a create that failed inside the 5 s window
   * resumed plaintext five seconds later, under a red chip, with the user
   * told it was paused. The latch already holds the gate and owns the only
   * escape (the native-confirmed "Stay unencrypted"); there is nothing left
   * for the fail-safe to decide.
   */
  loudLatched: boolean;
  /**
   * The delivery service answered a 429 to SOME `/mls/` request of this
   * bring-up — the KeyPackage publish, or the create itself — and the
   * transport is waiting the reset out (up to three waits of ~10 s).
   *
   * 🔴 Without this term that wait is invisible here. `#ensureKeyPackages`
   * is best-effort and returns; the create has not answered, so
   * `dsVerdictSeen` is false; nothing is latched; and the probe, its own
   * budget spent, may already read "none". Those four together ARE the
   * release arm: at 5 s the gate opened and the SFU got plaintext under NO
   * chip (the session state was still `starting`, which the chip renders
   * as nothing) for the 30-40 s until the delayed create landed. A 429 is
   * not unreachability — the DS answered, and the budget it refused from is
   * this session's own — so the availability escape's premise fails here
   * exactly as it does for a rate-limited probe: hold + loud.
   *
   * Deliberately NOT folded into `dsVerdictSeen`: that reads "ignore" — a
   * silent hold under a "none" chip, the user parked muted with nothing on
   * screen saying why. "resecure" flips the session state, which reaches
   * the chip reactively through `onStateChange`, so it goes amber for as
   * long as the wait runs.
   */
  transportRatelimited: boolean;
}

/**
 * 🔴 Once a verdict exists there is nothing here left to supervise. Each routed
 * path carries its own bound and its own terminal outcome (`join timed out
 * after retries` → RE-SECURING, a loud failure, or an active session), so
 * firing anyway adds no safety — it reports a failure that has not happened.
 * The same holds once a loud verdict is LATCHED: that path already holds the
 * gate and offers its own escape, and the one thing the fail-safe could add
 * is a release it must never make.
 *
 * Strictly more conservative than the behaviour it replaces, in the only
 * direction that matters: it never RELEASES the publish gate in a case where
 * the old code held it, and it never resumes plaintext on an E2EE-known call.
 * It only declines to raise an alarm — or, for a rate-limited probe or
 * transport, raises the one the old code mistook for a completed no-group
 * verdict.
 */
export function negotiatingFailsafeAction(
  input: NegotiatingFailsafeInput,
): NegotiatingFailsafeAction {
  if (input.loudLatched) return "ignore";
  if (input.dsVerdictSeen) return "ignore";
  if (input.transportRatelimited) return "resecure";
  if (input.probe === "open" || input.probe === "ratelimited") {
    return "resecure";
  }
  if (input.probe === "pending" && input.rearmsUsed < MAX_FAILSAFE_REARMS) {
    return "rearm";
  }
  return "release";
}
