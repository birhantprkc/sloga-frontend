/**
 * Admit-path abort classification + the joiner's self-enrolment verdict
 * (extracted from `mlsCallSession` so it is unit-testable in isolation — it is
 * PURE).
 *
 * WHY THIS EXISTS. The admit path (`#onJoinRequest` → `#tryAdmit`) used to be a
 * ladder of bare `return`s: session not active yet, `callState` threw, our leaf
 * index came back -1, the KeyPackage claim was refused. Every one of them
 * dropped a verified join request on the floor with no log, no retry and no
 * state change — so a group could sit at epoch 0 with a pending intent for an
 * hour while both clients believed nothing was wrong. Classifying the abort
 * makes the two questions explicit: do we try again, and does the user need to
 * be told the call is not end-to-end encrypted.
 */

/** Why one admit attempt stopped before a commit reached the DS. */
export type AdmitAbort =
  /** The session is not `active` (still establishing, or re-securing). */
  | "not_active"
  /** The request names a group we are not currently in. */
  | "other_group"
  /** Native `callState` failed — we cannot read our own roster. */
  | "state_unavailable"
  /** We are not in the group's verified roster, so we cannot admit anyone. */
  | "not_a_member"
  /** The joiner is already in the roster — another member's Add won. */
  | "already_member"
  /** The roster is at the E2EE cap; the joiner is refused BY DESIGN (A3). */
  | "call_full"
  /** The DS refused the claim, or the target has no KeyPackage left. */
  | "claim_failed"
  /**
   * We hold no usable pin for the joiner's device, so its leaf cannot be
   * verified (native `mls_leaf_rejected`, typically `unknown_identity`).
   */
  | "leaf_unverifiable"
  /** Media E2EE is switched off server-side — this is a plain voice call. */
  | "feature_disabled";

/**
 * Whether a staged-commit build error is a refusal of ONE admit TARGET rather
 * than a failure of our own session.
 *
 * This distinction is the fix for the observed production wedge: a joiner whose
 * device we have never pinned makes `callAdmit` throw `mls_leaf_rejected`, that
 * went to `#onLoud`, `#onLoud` set the session state to `failed` — and from
 * then on EVERY join request was dropped by the `#state !== "active"` guard. So
 * one unverifiable device permanently disabled E2EE admission for the whole
 * call. The admitter's own media stays fully encrypted throughout; the correct
 * response is to refuse that ONE joiner (who then shows up as non-enrolled via
 * the roster reconcile, which is the honest signal) and stay active.
 */
export function isAdmitTargetRefusal(error: unknown): boolean {
  return (error as { type?: string } | null)?.type === "mls_leaf_rejected";
}

/**
 * Whether the abort may resolve on its own, so the request is worth re-trying.
 *
 * The joiner re-broadcasts its intent only `MAX_JOINER_RETRIES` times over ~40 s
 * and then stops forever, so the admitter cannot rely on another fan-out to get
 * a second chance: a transient abort MUST be re-driven from the admitter's own
 * side or the joiner is stranded outside the group for the rest of the call.
 */
export function admitAbortIsRetryable(abort: AdmitAbort): boolean {
  switch (abort) {
    case "not_active":
    case "other_group":
    case "state_unavailable":
    case "not_a_member":
    case "claim_failed":
    case "leaf_unverifiable":
      // `leaf_unverifiable` is retryable because the pin set is NOT static: a
      // device-list event, a DM open, or a roster reconcile can pin the device
      // mid-call, and each re-drive re-runs `#reconcileRoster` first. Cheap,
      // now that the pre-check catches it before any KeyPackage is claimed.
      return true;
    case "already_member":
    case "call_full":
    case "feature_disabled":
      return false;
  }
}

/**
 * Whether the abort leaves the call in an honest state without any further
 * signalling.
 *
 * `already_member` means the joiner IS enrolled (someone else's Add won) and
 * `call_full` / `feature_disabled` are refusals the joiner is told about
 * through its own path. Everything else means a participant we accepted into
 * the SFU room is NOT in the MLS group — a downgrade, which the roster
 * reconcile must keep reporting.
 */
export function admitAbortIsBenign(abort: AdmitAbort): boolean {
  return (
    abort === "already_member" ||
    abort === "call_full" ||
    abort === "feature_disabled"
  );
}

/**
 * The joiner's "am I actually in the group?" verdict.
 *
 * `pending` is the honest answer while the bounded create/join/re-establish
 * ladder is still running — the deadline, not this function, decides when
 * waiting has stopped being reasonable.
 */
export type EnrolmentVerdict = "enrolled" | "pending" | "not_enrolled";

/**
 * Decide whether this device has PROVEN its own enrolment.
 *
 * `selfInRoster` alone is NOT proof (rejoin plan §4.3 / F2): after a reload
 * the native store survives the webview, so our leaf sits in the roster while
 * the new page holds no working session — the exact silent pass the 08-16
 * incident rode. Proof is roster presence AND `joinedThisGeneration`: a
 * `welcome_joined` (or our own create) whose captured establish generation
 * equals the live one. Roster presence without it falls through to the
 * ladder — and alarms at exhaustion.
 *
 * `ladderExhausted` is the session's own bounded give-up signal (join retries
 * spent, or the re-establish cap reached) OR the backstop deadline elapsing.
 * Until then an un-enrolled device is legitimately mid-negotiation.
 *
 * `establishInFlight` suppresses the alarm while an establish is actually
 * running (F3): the honest worst-case ladder can outlast any fixed deadline,
 * and a loud NOT-ENCRYPTED on a call that then secures moments later trains
 * users to ignore the one warning that must never be ignored. The true
 * give-up callers pass `ladderExhausted` AFTER their establish returned, so
 * this never masks a real exhaustion.
 *
 * `terminal` covers the modes where not being in a group is CORRECT and must
 * never raise an alarm: a plain (feature-off) voice call, and a joiner the
 * roster cap refused — both already tell the user through their own path.
 */
export function enrolmentVerdict(opts: {
  selfInRoster: boolean;
  joinedThisGeneration: boolean;
  establishInFlight: boolean;
  ladderExhausted: boolean;
  terminal: boolean;
}): EnrolmentVerdict {
  if (opts.selfInRoster && opts.joinedThisGeneration) return "enrolled";
  if (opts.terminal) return "enrolled"; // not our alarm to raise
  if (opts.establishInFlight) return "pending"; // F3: never alarm mid-establish
  return opts.ladderExhausted ? "not_enrolled" : "pending";
}
