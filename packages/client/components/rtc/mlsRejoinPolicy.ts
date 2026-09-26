/**
 * Rejoin-after-reload decision policy (extracted from `mlsCallSession` so it
 * is unit-testable in isolation — it is PURE).
 *
 * WHY THIS EXISTS. Ctrl+R (or a crash) mid-call leaves the native MLS store
 * populated while the fresh page has no session: the device is still a member
 * everywhere — its own store, the peers' rosters, the server — and the
 * designed recovery (rejoin fan-out → stale-leaf remove → removed_self →
 * rejoin-fresh) has two silent failure links: a Welcome processed over the
 * surviving local state is destroyed as a loud-classified poison drop with no
 * consumer, and the once-per-connection envelope drain lands before any
 * session exists. The fix is joiner-side: wipe the channel's surviving local
 * group state at establish time so the rejoin runs against a genuinely fresh
 * store (rejoin plan §4.1).
 *
 * THE RESUME. That wipe costs a full re-enrol (~11 s) on every rejoin. A
 * group this device still holds from moments ago can instead be RESUMED: the
 * DS is asked which group the channel is on (the open-group GET is the
 * verdict), the commits missed since the local epoch are fetched and applied,
 * and only then does the unchanged fail-closed gate release (resume plan D2,
 * D6). `resumeDecision` is the whole go/no-go for that route; anything short of
 * every rule holding falls back to the wipe-and-rejoin above. `recencyValid`
 * bounds which held groups may be offered at all (D7).
 */

/**
 * How long a hung-up call's local group state is kept for a quick rejoin, and
 * the freshness bound on both a resume prefetch and a recency record (resume
 * plan D1, D7). Mirrors the session's `LEAVE_GRACE_MS`: for that long the
 * peers keep this device's leaf and keep sending under the current epoch
 * anyway, so a kept group exposes nothing a present member would not.
 * Wave 3 makes the session import it (one source).
 */
export const LOCAL_GROUP_KEEP_MS = 10_000;

/**
 * The largest epoch lag a resume catches up; at or above it the held group is
 * abandoned for a clean join. Mirrors the session's private
 * `LAG_DESYNC_THRESHOLD` (pinned to native keys.rs, strictly below the 16-slot
 * keyring wrap): a lag the live session would treat as desync is never one a
 * resume may paper over. Wave 3 makes the session import it (one source).
 */
export const RESUME_MAX_LAG = 12;

/** The part of a fetched commit `resumeDecision` reads. */
export type ResumeCommitRef = { epoch: number; committerIsSelf: boolean };

/**
 * Everything the read-only resume prefetch learned before `room.connect`
 * finished: the candidate held group and its native state, the DS's answers
 * (open-group GET, missed commits, current epoch), and when it was fetched.
 * Generic over the commit shape so the bridge can carry the full commit the
 * catch-up applies; the policy reads only `ResumeCommitRef`.
 */
export type ResumePrefetch<C extends ResumeCommitRef = ResumeCommitRef> = {
  groupId: string;
  claimToken: string | null;
  fetchedAtMs: number;
  queriedChannelId: string;
  localEpoch: number;
  localState: "active" | "poisoned";
  localChannelId: string;
  selfInLocalRoster: boolean;
  openGroupId: string | null;
  pendingCommit: number | null;
  commits: readonly C[];
  currentEpoch: number;
};

/**
 * Whether the startup establish may RESUME the prefetched held group instead
 * of wiping it and re-enrolling. `"resume"` only when EVERY rule holds; any
 * doubt is `"join"`, which is today's path and costs latency, never security.
 * Each rule is written in its passing form so a NaN or a missing value fails
 * it.
 *
 *  1. A prefetch exists. `null` covers no candidate, a failed or aborted
 *     prefetch, and an old shell that lacks a read op (resume plan audit m7).
 *  2. This is the page's startup establish. The 409/rejoin route is shared by
 *     the rejoin-fresh, poisoned-successor and re-upgrade establishes, none of
 *     which may adopt held state (audit M6; an explicit flag, not "generation
 *     1", R2-m7).
 *  3. The prefetch is fresh: `0 ≤ now − fetchedAtMs ≤ LOCAL_GROUP_KEEP_MS`. A
 *     clock that ran backwards reads as stale (R2-m1).
 *  4. The DS's open-group GET names exactly this group (D2: the GET is the DS
 *     verdict the resume rests on, and a mismatch is a hostile or moved DS).
 *  5. The GET was made for the channel the user chose AND native binds the
 *     held group to that same channel. This IS the T-15 channel binding on
 *     this route: the GET carries no channel field to check (R2-m1).
 *  6. Native state is `active` and this device is in its own local roster: a
 *     poisoned or self-removed group has nothing to resume.
 *  7. No own commit is pending natively. A persisted pending commit survives
 *     the page and poisons the group on the next inbound commit (audit B3).
 *  8. No fetched commit was committed by this device — the other half of B3:
 *     a commit of ours we never merged cannot be applied as a peer's.
 *  9. `0 ≤ currentEpoch − localEpoch < RESUME_MAX_LAG`: the held epoch is not
 *     ahead of the DS, and the gap is one the live session would still catch
 *     up rather than call desync.
 * 10. The fetched commits are exactly the missing epochs, in order:
 *     `commits.length === lag` and `commits[i].epoch === localEpoch + 1 + i`
 *     (the one-fetch count check, audit M4; contiguity, R-W2-5: a hostile DS
 *     padding or reordering the list must not pass on its length alone).
 *
 * `"resume"` is not a release: the session still applies every commit,
 * re-checks native state and enables through the unchanged gate (D6).
 */
export function resumeDecision(
  p: ResumePrefetch | null,
  intendedChannelId: string,
  isStartup: boolean,
  nowMs: number,
): "resume" | "join" {
  if (p === null) return "join";
  if (!isStartup) return "join";
  const ageMs = nowMs - p.fetchedAtMs;
  if (!(ageMs >= 0 && ageMs <= LOCAL_GROUP_KEEP_MS)) return "join";
  if (!(p.openGroupId !== null && p.openGroupId === p.groupId)) return "join";
  if (p.queriedChannelId !== intendedChannelId) return "join";
  if (p.localChannelId !== intendedChannelId) return "join";
  if (!(p.localState === "active" && p.selfInLocalRoster)) return "join";
  if (p.pendingCommit !== null) return "join";
  if (p.commits.some((c) => c.committerIsSelf)) return "join";
  const lag = p.currentEpoch - p.localEpoch;
  if (!(lag >= 0 && lag < RESUME_MAX_LAG)) return "join";
  if (p.commits.length !== lag) return "join";
  for (let i = 0; i < p.commits.length; i++) {
    if (p.commits[i].epoch !== p.localEpoch + 1 + i) return "join";
  }
  return "resume";
}

/**
 * Whether a recency record lets `groupId` be offered for a resume (resume
 * plan D7, audit M1): the record must exist, name this very group, and be no
 * older than `LOCAL_GROUP_KEEP_MS` (`0 ≤ now − at`; a clock that ran
 * backwards reads as stale). This stops a hostile DS steering a resume into
 * an older group the device still holds, and bounds what a dead page's
 * leftovers can ever be resumed into.
 */
export function recencyValid(
  rec: { groupId: string; at: number } | null,
  groupId: string,
  nowMs: number,
): boolean {
  if (rec === null || rec.groupId !== groupId) return false;
  const ageMs = nowMs - rec.at;
  return ageMs >= 0 && ageMs <= LOCAL_GROUP_KEEP_MS;
}

/**
 * How long after a device's leaf was (re-)added this member refuses to serve
 * a rejoin intent for it (rejoin plan §4.8). A rejoin intent arriving inside
 * this window predates (or raced) the Add that satisfied it — serving it
 * would remove the freshly re-added LIVE member, and repeated, that drives
 * the victim to its re-establish cap and latches the loud "Stay unencrypted"
 * banner — i.e. a peer could manufacture genuine exhaustion to pressure a
 * plaintext downgrade. A device that really wiped again keeps re-broadcasting
 * every 10 s and is served on the first broadcast past the window.
 */
export const REJOIN_SERVE_SUPPRESS_MS = 15_000;

/**
 * Whether to serve a rejoin intent for a member device, given when we last
 * observed that device being ADDED to the roster (`null` = never observed).
 */
export function rejoinServeAction(opts: {
  addedAtMs: number | null;
  nowMs: number;
}): "serve" | "refuse_recent_add" {
  if (opts.addedAtMs === null) return "serve";
  return opts.nowMs - opts.addedAtMs < REJOIN_SERVE_SUPPRESS_MS
    ? "refuse_recent_add"
    : "serve";
}

/**
 * Whether a staggered rejoin serve's target is still the stale leaf the serve
 * was scheduled against. `scheduledAtEpoch` is the epoch of the roster read in
 * which the serve confirmed that leaf present; `removedAtEpoch` is the HIGHEST
 * epoch at which this member saw a commit remove that identity (`null` =
 * never). `false` means the identity was removed after scheduling, so the leaf
 * present now is a fresh re-add: refuse the serve.
 *
 * THE DEFECT. A serve fires `leafStaggerDelayMs(leaf)` after it is scheduled,
 * so in a call of seven or more members the member at leaf 6 or above fires
 * 12 s or later, after the rejoiner's Add (about 10.5 s on a wipe-rejoin). The
 * fire-time §4.8 check reads add observations that a non-admitting member
 * records only in its periodic roster reconcile (every 5 s), so it is blind in
 * that window; the roster read shows the target present (the FRESH leaf), and
 * the serve removed a live member, sending it round the re-enrol ladder again.
 * A wall-clock recency window cannot close this. Commit order can.
 *
 * WHY THIS IS COMPLETE. Both epochs share one numbering (a commit's outcome
 * epoch is the epoch it produced; the roster read reports the current epoch).
 * `removedAtEpoch` is written from every commit this member applies for the
 * group (inbound, rebased or refetched) and from its own won Removes. The
 * authoritative check runs inside the Remove's build step, UNDER the session
 * lock, immediately before native stages the Remove, so no commit is applied
 * concurrently with it. Native resolves the target by identity, so it finds
 * one only if either (a) no Remove of it has been applied since the anchor
 * (the leaf is the stale one and serving is correct), or (b) a later Add was
 * applied. Commits apply in strict epoch order and a gap is desync, never a
 * skip-ahead (invariant 10), so in (b) the Remove that preceded that Add, at
 * an epoch after the anchor, was applied first and recorded, and this returns
 * `false`. The anchor never predates this member's own join (the roster read
 * requires membership), so Removes it never saw cannot matter. Equal epochs
 * are still stale: a Remove AT the anchor epoch is already reflected in the
 * roster the serve was scheduled against. Outside the lock the argument fails:
 * the pump can apply the Remove AND the Add while the check awaits.
 *
 * NEVER DELETABLE WITHIN A GROUP. The fact is monotonic (max-merge only) and is
 * cleared only on a group change, together with every scheduled serve, so no
 * serve can outlive the fact it is checked against. A rejoiner can be seen
 * leaving and returning (a reconnect, a second reload) between its Remove and
 * its Add; deleting the fact on a leave, an admit, a reconcile or any roster
 * diff erases it exactly when a late serve needs it, and reopens the defect.
 * That deletable, observation-driven shape is what left the §4.8 check blind.
 */
export function serveTargetStillStale(i: {
  scheduledAtEpoch: number;
  removedAtEpoch: number | null;
}): boolean {
  return i.removedAtEpoch === null || i.removedAtEpoch <= i.scheduledAtEpoch;
}

/**
 * Which surviving LOCAL groups the startup fresh-rejoin wipes (rejoin plan
 * §4.1). The probe lists the native store's group ids for the USER-intended
 * channel — existence tested by existence, never readability (F5: a corrupt
 * post-crash group still lists, and that is exactly the state that most needs
 * the wipe), and keyed on the channel the user chose, never a server-supplied
 * id (F1: a hostile DS cannot steer the wipe at an arbitrary group).
 *
 *  - `orphanGroupId` — the fresh epoch-0 group `callCreate` just minted on
 *    the CREATE route; never stale, never wiped. Pass null on the join route
 *    (the orphan was already leave-cleaned before the probe, L1).
 *  - `tokenSpent` — the once-per-page-lifetime wipe already ran; later
 *    establishes in this page own their state coherently, so a second sweep
 *    could only destroy a legitimately-established group mid-flight.
 *  - `spareGroupId` — the held group a startup RESUME is adopting; filtered
 *    exactly like the orphan. The wipe is no longer universal because a kept
 *    or recently held group no longer has to be thrown away to be trusted:
 *    the resume confirms it with the DS (the open-group GET must name it) and
 *    catches it up from the DS's own commit list before anything is enabled
 *    (resume plan D2, D6, D7). It is spared only on a `"resume"` decision,
 *    which already required the recency record and the user-chosen channel
 *    binding, so F1 still holds: the DS can only confirm a group this device
 *    chose, never name one. A resume that then fails cleans the group up
 *    itself before falling back to the join. Absent or null spares nothing.
 */
export function startupWipeTargets(opts: {
  localGroupIds: readonly string[];
  orphanGroupId: string | null;
  tokenSpent: boolean;
  spareGroupId?: string | null;
}): string[] {
  if (opts.tokenSpent) return [];
  return opts.localGroupIds.filter(
    (id) => id !== opts.orphanGroupId && id !== opts.spareGroupId,
  );
}

/**
 * How an inbound `welcome_joined` outcome is honored (rejoin plan §4.2, F2).
 *
 *  - `adopt` — the Welcome is for the group the LIVE establish is joining
 *    (stale establishes never touch the live group id, so a match means the
 *    current generation's join target): adopt it, mark enrolment proven for
 *    the live generation, go active.
 *  - `resolveWait` — additionally release the pending `#waitForWelcome` slot,
 *    ONLY when that wait belongs to the live generation. A superseded join
 *    loop's wait must never be cross-resolved by a newer establish's Welcome
 *    (nor the reverse) — that cross-resolution is what let a stale loop keep
 *    broadcasting while the live one gave up (§1.5 oscillation).
 *
 * A Welcome failing `adopt` proves nothing: it was produced for a join this
 * session has since abandoned, and treating it as enrolment re-creates the
 * exact silent-unencrypted state this design exists to kill (F2).
 */
export function welcomeVerdict(opts: {
  welcomeGroupId: string;
  liveGroupId: string | null;
  /** Generation captured by the pending `#waitForWelcome`, null if none. */
  waitGeneration: number | null;
  liveGeneration: number;
}): { adopt: boolean; resolveWait: boolean } {
  const adopt =
    opts.liveGroupId !== null && opts.welcomeGroupId === opts.liveGroupId;
  return {
    adopt,
    resolveWait: adopt && opts.waitGeneration === opts.liveGeneration,
  };
}

/**
 * How long after this member watched a CONNECTED device lose its MLS leaf
 * (a served rejoin: the stale leaf was removed so the device can be re-added)
 * that device's re-Add is still expected — so its admit-grace may re-arm
 * instead of lapsing into non-enrolled.
 *
 * The gap it covers: the rejoiner is never told it was served, so the Add
 * waits for its next intent broadcast (`joinerRetryMs` cadence), and a slow
 * Remove submit can push that broadcast onto the still-present leaf, where it
 * is served as a SECOND rejoin — hence one submit bound on top — plus the
 * propagation settle. The stagger, claim and submit of the Add itself are
 * covered by the ordinary scheduled/ledgered-admit arms of
 * `admitInProgressVerdict`. Measured live 2026-09-07 on 0.58.0: the party
 * that stayed read a quick rejoiner as non-enrolled for the whole gap — chip
 * Not encrypted, the downgrade banner with Turn off encryption for ~12 s, on
 * every quick rejoin, both directions.
 *
 * Bounds are passed in (the `rotationWindowMs` pattern) because the session
 * owns the constants; the spec pins the sum.
 */
export function rejoinReintentWindowMs(bounds: {
  joinerRetryMs: number;
  submitTimeoutMs: number;
  settleMs: number;
}): number {
  return bounds.joinerRetryMs + bounds.submitTimeoutMs + bounds.settleMs;
}

/**
 * Whether this member is observably still working on admitting an identity —
 * the test an expiring admit-grace window re-arms on (bounded by the window's
 * own budget deadline, which the caller enforces).
 *
 *  - `scheduledAdmit` / `ledgeredAdmit` — an Add timer is scheduled, or an
 *    aborted attempt sits in the re-drive ledger.
 *  - `scheduledRejoin` / `ledgeredRejoin` — the same for a rejoin serve (stale
 *    leaf removal). The ledgered arm was missing: a retryable serve abort sat
 *    in the ledger under its own key, invisible to the re-arm, and the window
 *    could lapse while the serve was merely waiting for its retry tick.
 *  - `rejoinServedAtMs` — when this member watched the identity's stale leaf go
 *    while the device stayed connected (`null` = never). Inside
 *    `rejoinReintentWindowMs` its re-Add is expected and nothing else ledgers
 *    that phase. A clock that jumped backwards (now before the stamp) reads
 *    as LAPSED: the alternative kept a departed-but-SFU-present device
 *    pending for the whole jump, and the budget deadline it would fall back
 *    on moves with the same clock.
 *
 * This is a LIVENESS bound only: the pending stretch is still billed and a
 * device that never re-broadcasts goes loud at the smaller of the window and
 * the budget deadline.
 */
export function admitInProgressVerdict(opts: {
  scheduledAdmit: boolean;
  ledgeredAdmit: boolean;
  scheduledRejoin: boolean;
  ledgeredRejoin: boolean;
  rejoinServedAtMs: number | null;
  nowMs: number;
  windowMs: number;
}): boolean {
  if (
    opts.scheduledAdmit ||
    opts.ledgeredAdmit ||
    opts.scheduledRejoin ||
    opts.ledgeredRejoin
  ) {
    return true;
  }
  if (opts.rejoinServedAtMs === null) return false;
  const elapsed = opts.nowMs - opts.rejoinServedAtMs;
  return elapsed >= 0 && elapsed < opts.windowMs;
}
