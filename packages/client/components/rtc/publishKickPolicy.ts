/**
 * Publish-time kick — the PURE decision core for what the
 * `LocalTrackPublished` handler in state.tsx does with the publish gate once
 * a local publication has landed, extracted so `node --test` can load it
 * (the house no-vitest split; this module must stay dependency-free).
 *
 * Why this exists: the kick in that handler used to run only under a held
 * gate. Wave 1 of the "never publish unpaused" fix made it UNCONDITIONAL,
 * because of one publication nothing else can reach: a track the
 * `LocalSenderCreated` hook born-paused (`pauseAtBirth`) whose gate then
 * emptied DURING its offer/answer. It lands at `LocalTrackPublished` as
 * `{flag: true, sender.track: null}` under an EMPTY gate, and the gate's own
 * 1->0 resume sweep and `#reassertPublishGate` both read
 * `trackPublications`, which did not contain it yet — so the publish-time
 * sweep is the only thing left that can resume it.
 *
 * The final audit (F1) found the unconditional sweep too broad: under an
 * empty gate `#applyPublishGate` resumes EVERY `{flag: true, quiet}`
 * publication, not just that one. The screen-share consent-pending pause is
 * exactly such a publication — `localTrack.pauseUpstream()` issued while
 * the viewer-consent answer is still pending, on every shell — and the
 * sweep resumed it, putting the share on the wire ahead of its answer: a
 * regression. The gate is not the only owner of `pauseUpstream()`, so
 * "resume everything quiet" is not a safe reading of "gate empty".
 *
 * The decision is therefore narrowed to three arms. Under a HELD gate the
 * full sweep runs, exactly as before wave 1 (its pause/repause arms are the
 * ones that fire; a held gate never resumes). Under an EMPTY gate the
 * handler resumes ONLY the publication the born-paused hook itself tagged,
 * and otherwise touches nothing — a pause it did not issue is somebody
 * else's decision.
 */

/** What the `LocalTrackPublished` handler does with the gate this pass. */
export type PublishKickAction =
  /**
   * Gate held: run the full `#applyPublishGate` sweep over the room. This
   * is the unchanged pre-wave behaviour — the pause/repause arms re-assert
   * the gate on the new sender (first publish, republish, stale flag) and
   * nothing is resumed.
   */
  | "sweep"
  /**
   * Gate empty and THIS track was born-paused by the hook: resume this one
   * publication. It is the only publication whose pause the gate owns and
   * that no other sweep could see while it was in flight.
   */
  | "resumeLanded"
  /**
   * Gate empty and the track was not born-paused: do nothing. Any pause it
   * carries (screen-share consent pending, a user mute) belongs to whoever
   * issued it, and a sweep here would resume it.
   */
  | "none";

export interface PublishKickInput {
  /**
   * `#gateHeld()` at handler entry — the publish-gate reason set is
   * non-empty, so every publication must be (kept) paused.
   */
  gateHeld: boolean;
  /**
   * This EXACT track was tagged by the born-paused hook at
   * `LocalSenderCreated` (D0). The caller consumes the tag at
   * `LocalTrackPublished` BEFORE deciding and REGARDLESS of which arm is
   * chosen, so a tag can never outlive its publication and fire on a later
   * republish of the same `LocalTrack` instance. It says nothing about the
   * track's current pause flag or wire state; the caller's resume op reads
   * those itself.
   */
  bornPaused: boolean;
}

/**
 * Decide, in this order:
 *
 * 1. `gateHeld` → `"sweep"`. The gate owns every publication while it is
 *    held; the sweep's only reachable arms are pause/repause, so it cannot
 *    resume anything. `bornPaused` is irrelevant here — the born-paused
 *    publication is swept with the rest, and its tag is still consumed.
 * 2. `bornPaused` → `"resumeLanded"`. The gate emptied during this track's
 *    offer/answer; the 1→0 resume sweep could not see it, so resume it now.
 * 3. Otherwise `"none"`. An empty gate says the GATE holds nothing; it does
 *    not say the wire should be live. A quiet publication the hook did not
 *    pause stays exactly as its owner left it.
 *
 * Arm 1 precedes arm 2 so a gate that refilled during the offer/answer wins
 * over the tag: the born-paused track must not be resumed under a held
 * gate, not even for one sweep.
 */
export function publishKickAction(input: PublishKickInput): PublishKickAction {
  if (input.gateHeld) return "sweep";
  if (input.bornPaused) return "resumeLanded";
  return "none";
}
