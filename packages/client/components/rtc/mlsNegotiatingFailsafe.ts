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
  /** The channel's open-group probe, whose own verdict may still be pending. */
  probe: "open" | "pending" | "none";
  /** Re-arms already consumed against [`MAX_FAILSAFE_REARMS`]. */
  rearmsUsed: number;
}

/**
 * 🔴 Once a verdict exists there is nothing here left to supervise. Each routed
 * path carries its own bound and its own terminal outcome (`join timed out
 * after retries` → RE-SECURING, a loud failure, or an active session), so
 * firing anyway adds no safety — it reports a failure that has not happened.
 *
 * Strictly more conservative than the behaviour it replaces, in the only
 * direction that matters: it never RELEASES the publish gate in a case where
 * the old code held it, and it never resumes plaintext on an E2EE-known call.
 * It only declines to raise an alarm.
 */
export function negotiatingFailsafeAction(
  input: NegotiatingFailsafeInput,
): NegotiatingFailsafeAction {
  if (input.dsVerdictSeen) return "ignore";
  if (input.probe === "open") return "resecure";
  if (input.probe === "pending" && input.rearmsUsed < MAX_FAILSAFE_REARMS) {
    return "rearm";
  }
  return "release";
}
