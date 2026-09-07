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
 * "unreachable". The one failure a 429 policy cannot bound — a server that
 * accepts the connection and never answers — is bounded beside it by the
 * per-request deadline ([`MLS_REQUEST_DEADLINE_MS`]), which cuts the whole
 * request, 429 waits included, with its own typed error.
 */

/** Retries after the first 429 before the transport gives up. */
export const RATELIMIT_MAX_RETRIES = 3;

/**
 * Retries for a request on the call-plane ADMIT path — the roster listing
 * fetch and the KeyPackage claim. Those already sit inside an outer ladder
 * (the 5 s admit re-drive, the reconcile tick), so a long inner wait only
 * delays the ledger entry the outer retry keys on: one retry lets a reset
 * that is already imminent land, and past that the caller is told at once.
 * The DM plane keeps [`RATELIMIT_MAX_RETRIES`].
 */
export const CALL_PLANE_RATELIMIT_RETRIES = 1;

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
 * Per-request deadline for every call-plane request — each `/mls/` route and
 * the roster listing fetch the join path pins from — measured from the first
 * attempt to the final answer, 429 waits INCLUDED.
 *
 * Why it exists: a server that accepts the connection and never answers is
 * the one failure the 429 policy cannot bound. `fetch` carries no timeout of
 * its own, so a hung `POST /mls/groups` used to leave the session with no
 * verdict for as long as the socket stayed open — an unbounded RE-SECURING
 * hold with the publish gate held (T0d, 2026-09-06). Cutting the request
 * turns that into a thrown error, which every caller already routes: the
 * group-action catch and `#ensureKeyPackages` go loud, the join loop counts
 * it as one failed broadcast of its bounded ladder.
 *
 * The math: the deadline must clear the WORST legitimate wait, which is the
 * full retry ladder — [`RATELIMIT_MAX_RETRIES`] waits, each clamped to
 * [`RATELIMIT_MAX_DELAY_MS`] (slack and jitter are inside the clamp) —
 * 3 × 10 s = 30 s of sleeping, plus the four round-trips around them
 * (~33 s with a slow server). 45 s leaves ~12 s for those round-trips, so a
 * request that is merely rate limited always gets its last retry in before
 * the deadline, and a request that is genuinely hung is cut within a minute.
 *
 * The cut is NOT a rate limit: the loop throws the deadline's reason without
 * retrying (the ladders above it retry), and the error is typed
 * ([`E2EERequestTimeoutError`]) so a log can tell "never answered" from
 * "429 past the bound" from "unreachable".
 */
export const MLS_REQUEST_DEADLINE_MS = 45_000;

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

/**
 * Thrown (as the abort reason) when a request is still unanswered at its
 * [`RatelimitTransportOptions.deadlineMs`] — the server accepted the
 * connection and never answered, or kept us waiting out 429s past the
 * deadline. Never retried by the transport; the ladders above it decide.
 */
export class E2EERequestTimeoutError extends Error {
  readonly method: string;
  readonly path: string;
  readonly deadlineMs: number;

  constructor(method: string, path: string, deadlineMs: number) {
    super(
      `E2EE API ${method} ${path} failed: no answer within ${deadlineMs} ms`,
    );
    this.name = "E2EERequestTimeoutError";
    this.method = method;
    this.path = path;
    this.deadlineMs = deadlineMs;
  }
}

/** Whether `error` is the transport's per-request deadline. */
export function isRequestTimeout(
  error: unknown,
): error is E2EERequestTimeoutError {
  return error instanceof E2EERequestTimeoutError;
}

/** A composed deadline signal and the hook that disarms it. */
export interface RequestDeadline {
  /** Aborts on `base` (with its reason) or at the deadline (with `reason`). */
  signal: AbortSignal;
  /** Disarm the timer + detach from `base` once the request has settled. */
  release: () => void;
}

/**
 * Compose a per-request deadline with a caller's own abort signal: the
 * result aborts when EITHER does, carrying that side's reason — the base's
 * (a hang-up: "the abort is ours", quiet) or `reason` (the deadline: loud).
 *
 * Hand-rolled rather than `AbortSignal.any` + `AbortSignal.timeout` so the
 * reason is OUR typed error (`AbortSignal.timeout` aborts with a generic
 * `TimeoutError` `DOMException`), so `release` can disarm the timer the
 * moment the request settles instead of leaving one live per request, and
 * so the shells that predate `AbortSignal.any` (Safari < 17.4 on the macOS
 * port) get the same behavior. Pure, so `node --test` covers it.
 */
export function requestDeadlineSignal(
  deadlineMs: number,
  reason: unknown,
  base?: AbortSignal,
): RequestDeadline {
  const controller = new AbortController();
  if (base?.aborted) {
    controller.abort(base.reason);
    return { signal: controller.signal, release: () => {} };
  }
  const onBaseAbort = () => controller.abort(base?.reason);
  base?.addEventListener("abort", onBaseAbort, { once: true });
  const timer = setTimeout(() => {
    base?.removeEventListener("abort", onBaseAbort);
    controller.abort(reason);
  }, deadlineMs);
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      base?.removeEventListener("abort", onBaseAbort);
    },
  };
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
 * after the first 429 is attempt 1), or null when the bound (`maxRetries`,
 * default [`RATELIMIT_MAX_RETRIES`]) is spent and the transport must throw.
 * `jitterMs` is the caller's random addition (at most
 * [`RATELIMIT_JITTER_MS`]); the result is clamped to
 * [`RATELIMIT_MAX_DELAY_MS`] regardless of what the server quoted.
 */
export function ratelimitRetryDelayMs(
  attempt: number,
  serverHintMs: number | null,
  jitterMs = 0,
  maxRetries = RATELIMIT_MAX_RETRIES,
): number | null {
  if (!Number.isInteger(attempt) || attempt < 1) return null;
  if (attempt > maxRetries) return null;
  const base =
    serverHintMs === null ? RATELIMIT_DEFAULT_DELAY_MS * attempt : serverHintMs;
  const jitter = Math.min(Math.max(jitterMs, 0), RATELIMIT_JITTER_MS);
  return Math.min(base + RATELIMIT_SLACK_MS + jitter, RATELIMIT_MAX_DELAY_MS);
}

// ---- The transport loop ----------------------------------------------------

/** Whether `path` is a delivery-service (call-plane) route. */
export function isMlsPath(path: string): boolean {
  return path.startsWith("/mls/");
}

/** Per-request knobs a caller threads into [`fetchWithRatelimitPolicy`]. */
export interface RatelimitTransportOptions {
  /** Retries after the first 429 (default [`RATELIMIT_MAX_RETRIES`]). */
  maxRetries?: number;
  /**
   * Cuts the wait between retries (and, when the caller hands it to `fetch`
   * as well, the request itself). A call session threads its disposal here
   * so a hang-up does not leave a retry ladder running for a call that is
   * over.
   */
  signal?: AbortSignal;
  /**
   * Per-request deadline in milliseconds, measured over the WHOLE request —
   * every attempt and every 429 wait. Composed with `signal` (either aborts
   * the request); at the deadline the request rejects with a typed
   * [`E2EERequestTimeoutError`] and is NOT retried. Call-plane callers pass
   * [`MLS_REQUEST_DEADLINE_MS`]; omitted = no deadline (the DM plane today).
   */
  deadlineMs?: number;
  /**
   * Called ONCE per request, on the FIRST 429 and before any wait. The
   * negotiating fail-safe reads what this latches at 5 s, and the reset the
   * transport is about to wait for may be 10 s away.
   */
  onRatelimited?: (method: string, path: string) => void;
}

/** Injectable effects, so the loop runs under `node --test` without timers. */
export interface RatelimitFetchEffects {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Random jitter source in [0, [`RATELIMIT_JITTER_MS`]). */
  jitter?: () => number;
  log?: (message: string) => void;
}

/**
 * `setTimeout` as a promise that `signal` can cut short. Rejects with the
 * signal's reason — the same `AbortError` a cancelled `fetch` throws — so a
 * caller needs one catch for both.
 */
export function abortableSleep(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Run `fetchFn` under the 429 policy: wait out the server's reset — bounded
 * by `maxRetries` — and only then fail, with a TYPED [`E2EERateLimitError`]
 * a caller can tell from "unreachable". The body of a 429 (`{retry_after}`
 * in ms) is consumed here; the caller only ever sees a non-429 response, the
 * typed error, its own abort reason, or — with `deadlineMs` set — the typed
 * [`E2EERequestTimeoutError`] when the whole request (attempts AND waits)
 * outlives the deadline. A deadline cut is never retried here.
 *
 * `fetchFn` is invoked once per attempt with the signal the attempt must
 * ride (the caller's, composed with the deadline when one is set), so a
 * caller whose body is a string re-sends it safely; a streaming body must
 * not go through this.
 */
export async function fetchWithRatelimitPolicy(
  fetchFn: (signal?: AbortSignal) => Promise<Response>,
  method: string,
  path: string,
  options: RatelimitTransportOptions = {},
  effects: RatelimitFetchEffects = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? RATELIMIT_MAX_RETRIES;
  const sleep = effects.sleep ?? abortableSleep;
  const jitter = effects.jitter ?? (() => Math.random() * RATELIMIT_JITTER_MS);
  const log = effects.log ?? ((message: string) => console.warn(message));
  const deadline =
    options.deadlineMs === undefined
      ? null
      : requestDeadlineSignal(
          options.deadlineMs,
          new E2EERequestTimeoutError(method, path, options.deadlineMs),
          options.signal,
        );
  const signal = deadline?.signal ?? options.signal;
  try {
    for (let retry = 0; ; retry++) {
      if (signal?.aborted) throw signal.reason;
      const response = await fetchFn(signal);
      if (response.status !== 429) return response;
      if (retry === 0) options.onRatelimited?.(method, path);

      const body = (await response.json().catch(() => null)) as {
        retry_after?: unknown;
      } | null;
      const hint = retryAfterMs({
        bodyRetryAfter: body?.retry_after,
        resetAfterHeader: response.headers.get("X-RateLimit-Reset-After"),
        retryAfterHeader: response.headers.get("Retry-After"),
      });
      const delay = ratelimitRetryDelayMs(
        retry + 1,
        hint,
        jitter(),
        maxRetries,
      );
      if (delay === null) {
        throw new E2EERateLimitError(
          method,
          path,
          hint ?? RATELIMIT_DEFAULT_DELAY_MS,
          retry + 1,
        );
      }
      log(
        `[e2ee] ${method} ${path} rate limited; retrying in ` +
          `${Math.round(delay)} ms (${retry + 1}/${maxRetries})`,
      );
      await sleep(delay, signal);
    }
  } finally {
    deadline?.release();
  }
}

// ---- The call-roster reconcile's settlement ---------------------------------

/** One roster user's outcome from the per-user listing fetch + native pin. */
export type CallRosterOutcome =
  /** The listing arrived and a device the call named was newly pinned. */
  | { kind: "pinned"; userId: string }
  /**
   * The listing arrived; nothing new to pin (our own user, no named device,
   * or a device the listing does not verify — a verdict, not a failure).
   */
  | { kind: "settled"; userId: string }
  /** No listing: the fetch, or the native reconcile behind it, threw. */
  | { kind: "unfetched"; userId: string; error: unknown };

export type CallRosterSettlement =
  | { kind: "ok"; pinnedUsers: string[] }
  | {
      kind: "unfetched";
      /** Users pinned BEFORE the failure is raised — those pins stand. */
      pinnedUsers: string[];
      unfetchedCount: number;
      /** The first unfetched user's cause: what the reconcile throws. */
      error: unknown;
    };

/**
 * Settle a call-roster reconcile once every user's fetch + pin has run.
 * Every listing that arrived is already pinned by the time an outcome
 * exists (the outcomes are produced AFTER the native pin op), and only then
 * does one missing listing become a throw — carrying the FIRST cause, so a
 * 429 past the bounded retries stays typed. Pinning first is the point: a
 * caller that retries in the next window must not re-earn pins it has.
 */
export function settleCallRosterReconcile(
  outcomes: readonly CallRosterOutcome[],
): CallRosterSettlement {
  const pinnedUsers: string[] = [];
  let unfetchedCount = 0;
  let error: unknown;
  for (const outcome of outcomes) {
    if (outcome.kind === "pinned") pinnedUsers.push(outcome.userId);
    if (outcome.kind === "unfetched") {
      if (unfetchedCount === 0) error = outcome.error;
      unfetchedCount++;
    }
  }
  return unfetchedCount
    ? { kind: "unfetched", pinnedUsers, unfetchedCount, error }
    : { kind: "ok", pinnedUsers };
}
