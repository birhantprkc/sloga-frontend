/**
 * The T0d negotiating fail-safe's decision, as a pure function.
 *
 * Split out of `mlsCallSession.ts` for the same reason every other policy here
 * is (`mlsAdmitPolicy`, `mlsCallModePolicy`, `mlsDrainPolicy`,
 * `mlsJoinRequestPolicy`): the session class cannot be imported under
 * `node --test`, and a rule with no test is a rule nobody can control.
 *
 * 🔴 2026-09-06, user decision: the availability escape (design §6.5 T0d /
 * R2-6) is WITHDRAWN. It read "no Delivery-Service verdict within 5 s AND the
 * open-group probe says none" as "DS unreachable" and released the
 * `negotiating` publish gate to plaintext under a "none" chip — the session
 * was still `starting`, which the chip renders as nothing. That premise was
 * never provable from the client: a slow create, a transport waiting out a
 * 429 and a probe whose own budget was spent each looked exactly like
 * unreachability at the 5 s tick, and each time the chip was wrong for as
 * long as the DS took to answer. The 429 backoff (up to three waits of
 * ~10 s) turned that from a rare race into a 30-40 s certainty.
 *
 * The rule is now fail-closed: the publish gate is NEVER released without a
 * DS verdict. With no verdict at the tick, hold the gate and go amber
 * RE-SECURING — whatever the probe says — until either the DS answers
 * (create/join lands and the normal path takes over) or the bounded deadline
 * (`SELF_ENROLMENT_DEADLINE_MS`, or the join ladder's terminal) expires and
 * the session goes LOUD through the existing `#latchLoud` ladder: the
 * NOT-ENCRYPTED chip and the Leave / Stay-unencrypted banner, where "Stay" is
 * the user's explicit consent to plaintext. A slow `POST /mls/groups` is now
 * a visibly delayed start, never unlabeled plaintext.
 */

/**
 * What the fail-safe should do when its window expires.
 *
 * Only two outcomes exist, and BOTH keep the publish gate held. The former
 * `"release"` (the availability escape) and `"rearm"` (deferring the release
 * decision until the probe completed) were deleted with the escape: with no
 * release left to decide, waiting for the probe only delayed the amber chip.
 */
export type NegotiatingFailsafeAction = "ignore" | "resecure";

export interface NegotiatingFailsafeInput {
  /**
   * Has the DS answered create/join at all — ANY status, 409 included?
   *
   * 🔴 This is the term the implementation was missing, and its absence was a
   * deterministic false alarm rather than a rare race. The fail-safe is
   * specified for exactly one condition — "the session produces NO verdict
   * within this window (no create/join response)" — but it was written as a
   * bare timer that only re-checked `negotiating`.
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
   * No longer a term of the DECISION — every value holds the gate — but still
   * an input, because it names the hold in the console
   * (`negotiatingFailsafeReason`). It used to be the whole escape: `"none"`
   * released, `"pending"` deferred, `"open"` / `"ratelimited"` held. Only
   * the hold survives.
   */
  probe: "open" | "pending" | "none" | "ratelimited";
  /**
   * A loud verdict is already latched (`#latchLoud`): the establish threw —
   * a 429 past the transport's bounded retries, a 5xx, a native refusal — or
   * the self-enrolment assertion fired. The chip reads NOT-ENCRYPTED and the
   * banner offers Leave / Stay-unencrypted on the promise that publishing is
   * paused. That path holds the gate and owns the only escape (the
   * native-confirmed "Stay unencrypted"); there is nothing left for the
   * fail-safe to decide, and flipping the state to `resecuring` under a red
   * chip would only muddy the log.
   */
  loudLatched: boolean;
  /**
   * The delivery service answered a 429 to SOME `/mls/` request of this
   * bring-up — the KeyPackage publish, or the create itself — and the
   * transport is waiting the reset out (up to three waits of ~10 s).
   *
   * Like `probe`, this no longer changes the outcome: with no verdict the
   * gate holds either way. It is kept so the RE-SECURING reason says WHY the
   * start is delayed — the 2026-09-06 field shape was exactly this wait
   * (`#ensureKeyPackages` returned best-effort, the create had not answered,
   * nothing was latched, the probe's own budget was spent) and, under the
   * withdrawn escape, it released plaintext to the SFU under no chip for the
   * 30-40 s until the delayed create landed.
   */
  transportRatelimited: boolean;
}

/**
 * 🔴 Once a verdict exists there is nothing here left to supervise. Each routed
 * path carries its own bound and its own terminal outcome (`join timed out
 * after retries` → RE-SECURING, a loud failure, or an active session), so
 * firing anyway adds no safety — it reports a failure that has not happened.
 * The same holds once a loud verdict is LATCHED: that path already holds the
 * gate and offers its own escape.
 *
 * Everything else — no verdict, nothing latched, ANY probe, rate limited or
 * not — is one outcome: hold the gate, amber RE-SECURING. The function can
 * never return a release, so no combination of inputs can resume plaintext.
 */
export function negotiatingFailsafeAction(
  input: NegotiatingFailsafeInput,
): NegotiatingFailsafeAction {
  if (input.loudLatched) return "ignore";
  if (input.dsVerdictSeen) return "ignore";
  return "resecure";
}

/**
 * The `#toResecuring` reason for a `"resecure"` verdict — the operator's tell
 * in the console for WHY a start is sitting amber. Ordered by how much each
 * term explains: a transport wait is the delay itself; a rate-limited probe
 * shares the same exhausted budget; an open group is the case the old rule
 * already held for; a pending probe and a bare "none" say only that the DS
 * has not answered.
 */
export function negotiatingFailsafeReason(
  input: NegotiatingFailsafeInput,
): string {
  if (input.transportRatelimited) {
    return "no delivery-service verdict yet — waiting out a rate limit";
  }
  switch (input.probe) {
    case "ratelimited":
      return "no delivery-service verdict yet — the open-group probe was rate limited";
    case "open":
      return "no delivery-service verdict yet with an open E2EE group";
    case "pending":
      return "no delivery-service verdict yet — the open-group probe is still pending";
    case "none":
      return "no delivery-service verdict yet";
  }
}
