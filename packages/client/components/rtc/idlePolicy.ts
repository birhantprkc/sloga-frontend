/**
 * Client idle detection for the AFK auto-move (AFK plan Wave 5b-2, B2).
 *
 * The rules live here, dependency-free, so `node --test` can hold them to
 * value cases; `state.tsx` only gathers the world each tick and acts on the
 * answer. What this module decides is narrow on purpose: WHEN this client
 * says "I have been idle for N seconds" and when it takes that back. It never
 * moves anyone.
 *
 * 🔴 The server is the authority (D-5b2-1). The beacon carries a RELATIVE
 * `idle_for` in whole seconds, never a client wall-clock time; the server
 * stamps `since` itself, clamps it to the join, and applies the server's own
 * `afk_timeout` on its own tick. The claim is CLIENT-CLAIMED and grants
 * nothing — the most a lying client can do is get itself moved.
 *
 * The fail-safe rules, each of which is a value case in the spec:
 *
 * - **A gap is missing evidence, never idle time.** A tick that arrives more
 *   than `IDLE_MAX_TICK_GAP_MS` after the previous one means this client was
 *   suspended, throttled or asleep — it saw nothing, so it cannot say the user
 *   did nothing. The idle clock restarts at `now`, and a standing claim is
 *   withdrawn.
 * - **A client that cannot run can never cause a move.** The claim is a
 *   heartbeat (`IDLE_REFRESH_MS`) under a short server-side TTL (180 s); a
 *   client that stops ticking stops refreshing, and its claim expires. Nothing
 *   here ever needs to run for a claim to go away.
 * - **The claim is made AT the timeout, never before it** (P2-4). The
 *   threshold is `afkTimeoutSeconds × 1000` exactly — no lead, no floor. An
 *   early claim would turn every lost "active again" DELETE in the lead window
 *   into moving an active user.
 * - **Anything not provably armed is disarmed.** A missing, non-finite or
 *   non-positive timeout, no designated AFK channel, not connected, or already
 *   in the AFK channel: the idle clock is held at `now`, and a standing claim
 *   is withdrawn.
 *
 * 🔴 This module is the ONLY place the timeout's seconds become milliseconds
 * and the only place idle milliseconds become `idle_for` seconds. `state.tsx`
 * passes `server.afkTimeout` through untouched.
 */

/** How often `state.tsx` runs `idleStep`. */
export const IDLE_TICK_MS = 5_000;

/**
 * How often a standing idle claim is re-sent, inside the server's 180 s TTL.
 * That leaves room for ONE lost refresh, not two: the attempt after a failure
 * waits another `IDLE_REFRESH_MS` plus up to a tick (and a failed PUT backs
 * off by the same interval), so a second loss in a row can let the claim
 * lapse. A lapse is the safe direction — it only delays a move, and the next
 * PUT re-creates the claim from its relative `idle_for`.
 */
export const IDLE_REFRESH_MS = 60_000;

/**
 * The longest interval between two ticks that still counts as having watched
 * the user throughout. Longer than that and the gap is treated as missing
 * evidence: the idle clock restarts.
 */
export const IDLE_MAX_TICK_GAP_MS = 150_000;

/**
 * Consecutive failed posts (of any kind that does not latch outright) after
 * which the connection stops posting for the rest of the call. The latch
 * resets when the server's AFK configuration changes (`state.tsx`).
 */
export const IDLE_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Error types that stop this connection posting at once (P2-6): no retry can
 * ever succeed for a bot or for a channel that is not a call. Every other
 * refusal — `NotInVoiceChannel` (webhook lag), `InvalidOperation` (a config
 * change racing the tick), a 429 — is plausibly transient and backs off.
 */
export const IDLE_LATCH_ERRORS: readonly string[] = [
  "IsBot",
  "NotAVoiceChannel",
];

/**
 * Everything one tick needs. Times are milliseconds on ONE monotonic clock
 * (`performance.now()` in `state.tsx`), never wall-clock.
 */
export type IdleWorld = {
  now: number;
  lastTickAt: number | undefined;
  lastActivityAt: number;
  continuousActive: boolean;
  connected: boolean;
  isAfkChannel: boolean;
  afkChannelId: string | undefined;
  afkTimeoutSeconds: number | undefined;
  posted: boolean;
  lastPostAt: number | undefined;
};

export type IdleAction = "none" | "post-idle" | "refresh-idle" | "clear-idle";

/**
 * The claim threshold in milliseconds, or `undefined` when the timeout is not
 * a usable number (missing, non-finite, or ≤ 0 — all disarm). The one
 * seconds→ms conversion in the idle path.
 */
function claimThresholdMs(
  afkTimeoutSeconds: number | undefined,
): number | undefined {
  if (
    typeof afkTimeoutSeconds !== "number" ||
    !Number.isFinite(afkTimeoutSeconds) ||
    afkTimeoutSeconds <= 0
  )
    return undefined;
  return afkTimeoutSeconds * 1000;
}

/**
 * Whether idle detection applies at all: connected, a server with a designated
 * AFK channel and a usable timeout, and not already in that channel.
 */
export function afkIdleArmed(
  w: Pick<
    IdleWorld,
    "connected" | "isAfkChannel" | "afkChannelId" | "afkTimeoutSeconds"
  >,
): boolean {
  return (
    w.connected &&
    !w.isAfkChannel &&
    !!w.afkChannelId &&
    claimThresholdMs(w.afkTimeoutSeconds) !== undefined
  );
}

/**
 * One tick. Returns the idle clock to carry forward and what to tell the
 * server. The caller applies `action` and records `posted` / `lastPostAt`
 * from the outcome; discrete activity events (speaking edge, PTT down,
 * keybind, input in the visible window) set `lastActivityAt` directly.
 *
 * In order, the first that applies wins:
 * 1. not armed ⇒ restart the clock; withdraw a standing claim;
 * 2. tick gap > `IDLE_MAX_TICK_GAP_MS` ⇒ same (a gap is missing evidence);
 * 3. continuously active (speaking, PTT held, sharing, camera, watching) ⇒
 *    same;
 * 4. idle for at least the timeout ⇒ post, or refresh once
 *    `IDLE_REFRESH_MS` has passed since the last post;
 * 5. otherwise ⇒ withdraw a standing claim (activity since the post).
 */
export function idleStep(w: IdleWorld): {
  lastActivityAt: number;
  action: IdleAction;
} {
  const reset: { lastActivityAt: number; action: IdleAction } = {
    lastActivityAt: w.now,
    action: w.posted ? "clear-idle" : "none",
  };

  const thresholdMs = claimThresholdMs(w.afkTimeoutSeconds);
  if (!afkIdleArmed(w) || thresholdMs === undefined) return reset;

  if (w.lastTickAt !== undefined && w.now - w.lastTickAt > IDLE_MAX_TICK_GAP_MS)
    return reset;

  if (w.continuousActive) return reset;

  if (w.now - w.lastActivityAt >= thresholdMs) {
    if (!w.posted)
      return { lastActivityAt: w.lastActivityAt, action: "post-idle" };
    const refreshDue =
      w.lastPostAt === undefined || w.now - w.lastPostAt >= IDLE_REFRESH_MS;
    return {
      lastActivityAt: w.lastActivityAt,
      action: refreshDue ? "refresh-idle" : "none",
    };
  }

  return {
    lastActivityAt: w.lastActivityAt,
    action: w.posted ? "clear-idle" : "none",
  };
}

/**
 * The beacon's `idle_for`: whole seconds idle, rounded DOWN (the server takes
 * an unsigned integer), never negative. A non-finite result reads as 0 — "just
 * went idle" — which can only delay a move, never hasten one.
 */
export function idleForSeconds(now: number, lastActivityAt: number): number {
  const seconds = Math.floor((now - lastActivityAt) / 1000);
  return Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
}

/**
 * What a failed post does to the connection: `"latch"` stops posting for the
 * rest of the call (until the AFK configuration changes); `"backoff"` waits
 * for the next refresh. A latch error latches at once; any other failure
 * latches once `consecutiveFailures` (the caller's running count) reaches
 * `IDLE_MAX_CONSECUTIVE_FAILURES`.
 */
export function idleFailureDisposition(
  errorType: string | undefined,
  consecutiveFailures: number,
): "latch" | "backoff" {
  if (errorType !== undefined && IDLE_LATCH_ERRORS.includes(errorType))
    return "latch";
  return consecutiveFailures >= IDLE_MAX_CONSECUTIVE_FAILURES
    ? "latch"
    : "backoff";
}
