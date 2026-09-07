/**
 * The 429 policy for the E2EE / MLS transport (`#api` + `#apiMls` in
 * `e2ee.ts`, and the open-group probe in `state.tsx`) — pure and
 * dependency-free so `node --test` can load it (the house no-vitest split).
 *
 * Why this exists: every /e2ee and /mls request is metered per session in
 * 10 s windows, and an E2EE call bring-up is bursty by construction — the
 * admitter reconciles every roster user's signed device listing on every
 * join request, a fresh enrollment fans its own DeviceCreate back at itself,
 * and the delivery service sees a claim and a commit per joiner. On
 * 2026-09-06 a fresh Linux enrollment answered 429 three times on
 * `GET /e2ee/devices/<user>` during bring-up, and every caller treated the
 * throw as a generic transport failure: the DM-plane housekeeping logged and
 * moved on, the call-plane roster reconcile swallowed it, and the joiner's
 * leaf stayed unverifiable.
 *
 * A 429 is the one failure the server tells us exactly how to recover from:
 * the `/ratelimit` body carries `retry_after` and the response carries
 * `X-RateLimit-Reset-After`, both in MILLISECONDS until the window resets.
 * So the transport waits that out — bounded — before any caller sees a
 * failure, and when the bound is spent it throws a TYPED error so a caller
 * can tell "rate limited" (the server is reachable and answering) from
 * "unreachable" (the availability escapes are written for that case only).
 */

/** Retries after the first 429 before the transport gives up. */
export const RATELIMIT_MAX_RETRIES = 3;

/**
 * Longest single wait. The server's window is 10 s, so no legitimate reset
 * is further away than that; a proxy quoting hours is not waited on.
 */
export const RATELIMIT_MAX_DELAY_MS = 10_000;

/** Wait when the server named no reset at all (a bare 429 from a proxy). */
export const RATELIMIT_DEFAULT_DELAY_MS = 2_000;

/**
 * Slack added on top of the server's reset so the retry lands INSIDE the
 * next window rather than on its boundary (the reset is measured when the
 * 429 was built, and the clocks of the two ends are not the same clock).
 */
export const RATELIMIT_SLACK_MS = 250;

/**
 * Upper bound on the random jitter a caller may add. Several listing fetches
 * run concurrently and would otherwise all retry on the same millisecond.
 */
export const RATELIMIT_JITTER_MS = 250;

/**
 * Thrown by the transport when a request is still 429 after
 * [`RATELIMIT_MAX_RETRIES`]. `retryAfterMs` is the server's LAST reset hint
 * (or the default when it named none), so a caller that ledgers its own
 * retry can wait an honest amount.
 */
export class E2EERateLimitError extends Error {
  readonly status = 429;
  readonly method: string;
  readonly path: string;
  readonly retryAfterMs: number;
  readonly attempts: number;

  // Plain fields, not parameter properties: Node's strip-only TypeScript
  // loader (what `node --test` runs these specs under) rejects the latter.
  constructor(
    method: string,
    path: string,
    retryAfterMs: number,
    attempts: number,
  ) {
    super(
      `E2EE API ${method} ${path} failed: 429 after ${attempts} attempts ` +
        `(reset in ${retryAfterMs} ms)`,
    );
    this.name = "E2EERateLimitError";
    this.method = method;
    this.path = path;
    this.retryAfterMs = retryAfterMs;
    this.attempts = attempts;
  }
}

/** Whether `error` is the transport's exhausted-retries 429. */
export function isRateLimited(error: unknown): error is E2EERateLimitError {
  return error instanceof E2EERateLimitError;
}

/** The reset hints a 429 response can carry. */
export interface RatelimitHints {
  /** `retry_after` from the `/ratelimit` JSON body — milliseconds. */
  bodyRetryAfter?: unknown;
  /** `X-RateLimit-Reset-After` — milliseconds; CORS-exposed by delta. */
  resetAfterHeader?: string | null;
  /** RFC `Retry-After` — SECONDS (only a proxy would send it). */
  retryAfterHeader?: string | null;
}

/**
 * The server's reset hint in milliseconds, or null when it named none.
 * Precedence: body, then delta's header, then the RFC header. A hint that
 * is not a finite non-negative number is ignored (never trusted into a
 * negative or NaN wait).
 */
export function retryAfterMs(hints: RatelimitHints): number | null {
  const body = toNonNegative(hints.bodyRetryAfter);
  if (body !== null) return body;
  const reset = toNonNegative(hints.resetAfterHeader);
  if (reset !== null) return reset;
  const rfc = toNonNegative(hints.retryAfterHeader);
  if (rfc !== null) return rfc * 1000;
  return null;
}

function toNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * How long to wait before retry number `attempt` (1-based: the first retry
 * after the first 429 is attempt 1), or null when the bound is spent and the
 * transport must throw. `jitterMs` is the caller's random addition (at most
 * [`RATELIMIT_JITTER_MS`]); the result is clamped to
 * [`RATELIMIT_MAX_DELAY_MS`] regardless of what the server quoted.
 */
export function ratelimitRetryDelayMs(
  attempt: number,
  serverHintMs: number | null,
  jitterMs = 0,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (attempt > RATELIMIT_MAX_RETRIES) return null;
  const base =
    serverHintMs === null ? RATELIMIT_DEFAULT_DELAY_MS * attempt : serverHintMs;
  const jitter = Math.min(Math.max(jitterMs, 0), RATELIMIT_JITTER_MS);
  return Math.min(base + RATELIMIT_SLACK_MS + jitter, RATELIMIT_MAX_DELAY_MS);
}
