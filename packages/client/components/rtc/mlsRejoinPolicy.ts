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
 */

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
 */
export function startupWipeTargets(opts: {
  localGroupIds: readonly string[];
  orphanGroupId: string | null;
  tokenSpent: boolean;
}): string[] {
  if (opts.tokenSpent) return [];
  return opts.localGroupIds.filter((id) => id !== opts.orphanGroupId);
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
 *    that phase. A clock that jumped backwards reads as inside the window;
 *    the deadline still caps it.
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
  return opts.nowMs - opts.rejoinServedAtMs < opts.windowMs;
}
