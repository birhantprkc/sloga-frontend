// Unit spec for the E2EE transport's 429 policy — run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/e2eeRatelimitPolicy.test.ts
// (pure functions, so the browser condition is not load-bearing here — it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: the server's reset hint is honored in the right order and unit, the
// wait is bounded above and below, the bound on retries is real — after it
// the transport throws a TYPED error a caller can tell from "unreachable" —
// and the loop that applies all of that behaves: it hands back the first
// non-429, reports the first 429 exactly once, stops on abort, cuts a request
// the server never answers at the per-request deadline (429 waits included,
// never retried, typed apart from a rate limit), and the roster reconcile
// built on it pins every arrival before it throws.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallRosterOutcome,
  abortableSleep,
  CALL_PLANE_RATELIMIT_RETRIES,
  E2EERateLimitError,
  fetchWithRatelimitPolicy,
  isMlsPath,
  isRateLimited,
  isRequestTimeout,
  MLS_REQUEST_DEADLINE_MS,
  RATELIMIT_DEFAULT_DELAY_MS,
  RATELIMIT_JITTER_MS,
  RATELIMIT_MAX_DELAY_MS,
  RATELIMIT_MAX_RETRIES,
  RATELIMIT_SLACK_MS,
  ratelimitRetryDelayMs,
  requestDeadlineSignal,
  retryAfterMs,
  settleCallRosterReconcile,
} from "./e2eeRatelimitPolicy.ts";

test("the /ratelimit body wins, and it is already in milliseconds", () => {
  assert.equal(
    retryAfterMs({
      bodyRetryAfter: 4321,
      resetAfterHeader: "9999",
      retryAfterHeader: "9",
    }),
    4321,
  );
});

test("delta's reset header is next, in milliseconds", () => {
  assert.equal(
    retryAfterMs({ resetAfterHeader: "7350", retryAfterHeader: "9" }),
    7350,
  );
});

test("the RFC Retry-After header is last, and it is in SECONDS", () => {
  assert.equal(retryAfterMs({ retryAfterHeader: "3" }), 3000);
});

test("no hint at all is null, never zero", () => {
  assert.equal(retryAfterMs({}), null);
  assert.equal(
    retryAfterMs({
      bodyRetryAfter: undefined,
      resetAfterHeader: null,
      retryAfterHeader: "",
    }),
    null,
  );
});

test("a hint that is not a finite non-negative number is ignored", () => {
  // A garbage body must not mask a usable header, and nothing here may ever
  // turn into a negative or NaN wait.
  assert.equal(
    retryAfterMs({ bodyRetryAfter: "soon", resetAfterHeader: "500" }),
    500,
  );
  assert.equal(retryAfterMs({ bodyRetryAfter: -1 }), null);
  assert.equal(retryAfterMs({ bodyRetryAfter: Number.NaN }), null);
  assert.equal(retryAfterMs({ retryAfterHeader: "Infinity" }), null);
});

test("the wait is the server's reset plus slack", () => {
  assert.equal(ratelimitRetryDelayMs(1, 1200), 1200 + RATELIMIT_SLACK_MS);
});

test("jitter is added but capped at the jitter bound", () => {
  assert.equal(
    ratelimitRetryDelayMs(1, 1000, 100),
    1000 + RATELIMIT_SLACK_MS + 100,
  );
  assert.equal(
    ratelimitRetryDelayMs(1, 1000, 5000),
    1000 + RATELIMIT_SLACK_MS + RATELIMIT_JITTER_MS,
  );
  // Negative jitter is a caller bug, not a shorter wait.
  assert.equal(ratelimitRetryDelayMs(1, 1000, -50), 1000 + RATELIMIT_SLACK_MS);
});

test("the wait never exceeds the window bound, whatever the server quotes", () => {
  // The server's own window is 10 s; a proxy quoting an hour is not obeyed.
  assert.equal(ratelimitRetryDelayMs(1, 3_600_000), RATELIMIT_MAX_DELAY_MS);
  assert.equal(
    ratelimitRetryDelayMs(1, RATELIMIT_MAX_DELAY_MS, RATELIMIT_JITTER_MS),
    RATELIMIT_MAX_DELAY_MS,
  );
});

test("with no hint the wait backs off linearly from the default", () => {
  assert.equal(
    ratelimitRetryDelayMs(1, null),
    RATELIMIT_DEFAULT_DELAY_MS + RATELIMIT_SLACK_MS,
  );
  assert.equal(
    ratelimitRetryDelayMs(2, null),
    2 * RATELIMIT_DEFAULT_DELAY_MS + RATELIMIT_SLACK_MS,
  );
});

// 🔴 The bound. Without it a 429 that never clears (a hostile proxy, a bug in
// the bucket) would spin the transport forever — and with it, the caller's
// own ladder (admit re-drive, envelope retries, join retries) never runs.
test("retries are bounded; past the bound the caller must give up", () => {
  for (let attempt = 1; attempt <= RATELIMIT_MAX_RETRIES; attempt++) {
    assert.notEqual(ratelimitRetryDelayMs(attempt, 100), null, `${attempt}`);
  }
  assert.equal(ratelimitRetryDelayMs(RATELIMIT_MAX_RETRIES + 1, 100), null);
  assert.equal(ratelimitRetryDelayMs(0, 100), null);
  assert.equal(ratelimitRetryDelayMs(1.5, 100), null);
});

test("the exhausted-retries error is typed and carries the reset hint", () => {
  const error = new E2EERateLimitError(
    "GET",
    "/e2ee/devices/01ABC",
    2500,
    RATELIMIT_MAX_RETRIES + 1,
  );
  assert.equal(isRateLimited(error), true);
  assert.equal(error.status, 429);
  assert.equal(error.retryAfterMs, 2500);
  assert.equal(error.name, "E2EERateLimitError");
  assert.match(error.message, /429/);
  assert.match(error.message, /\/e2ee\/devices\/01ABC/);
  // A plain transport failure is NOT rate limiting: the availability escapes
  // are written for that case and must not fire for this one.
  assert.equal(isRateLimited(new Error("E2EE API GET /x failed: 502")), false);
  assert.equal(isRateLimited(null), false);
});

test("the retry bound is a parameter: the call-plane budget is one retry", () => {
  assert.equal(CALL_PLANE_RATELIMIT_RETRIES, 1);
  assert.notEqual(
    ratelimitRetryDelayMs(1, 100, 0, CALL_PLANE_RATELIMIT_RETRIES),
    null,
  );
  assert.equal(
    ratelimitRetryDelayMs(2, 100, 0, CALL_PLANE_RATELIMIT_RETRIES),
    null,
  );
  // A zero budget: no wait at all, the first 429 is the verdict.
  assert.equal(ratelimitRetryDelayMs(1, 100, 0, 0), null);
});

// ---- The transport loop, with fetch and sleep injected --------------------

function ratelimited(retryAfter = 100): Response {
  return new Response(JSON.stringify({ retry_after: retryAfter }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });
}

function ok(): Response {
  return new Response("{}", { status: 200 });
}

/** A fetch answering `script` in order, then the last entry forever. */
function scripted(script: (() => Response)[]) {
  const trace: string[] = [];
  let calls = 0;
  return {
    trace,
    calls: () => calls,
    fetch: async () => {
      const next = script[Math.min(calls, script.length - 1)];
      calls++;
      trace.push(`fetch ${calls}`);
      return next();
    },
    effects: {
      sleep: async (ms: number) => {
        trace.push(`sleep ${ms}`);
      },
      jitter: () => 0,
      log: () => {},
    },
  };
}

test("three 429s in a row end in the typed error after the bounded attempts", async () => {
  const s = scripted([() => ratelimited(300)]);
  await assert.rejects(
    fetchWithRatelimitPolicy(
      s.fetch,
      "GET",
      "/e2ee/devices/01ABC",
      {},
      s.effects,
    ),
    (error: unknown) =>
      isRateLimited(error) &&
      error.attempts === RATELIMIT_MAX_RETRIES + 1 &&
      error.retryAfterMs === 300 &&
      error.path === "/e2ee/devices/01ABC",
  );
  // One initial request, then exactly the bounded retries — each preceded by
  // the server's reset plus slack — and nothing after the bound.
  assert.equal(s.calls(), RATELIMIT_MAX_RETRIES + 1);
  const wait = 300 + RATELIMIT_SLACK_MS;
  assert.deepEqual(s.trace, [
    "fetch 1",
    `sleep ${wait}`,
    "fetch 2",
    `sleep ${wait}`,
    "fetch 3",
    `sleep ${wait}`,
    "fetch 4",
  ]);
});

test("a 429 then a 200 hands the caller the 200, after the server's wait", async () => {
  const s = scripted([() => ratelimited(1200), ok]);
  const response = await fetchWithRatelimitPolicy(
    s.fetch,
    "GET",
    "/e2ee/devices/01ABC",
    {},
    s.effects,
  );
  assert.equal(response.status, 200);
  assert.deepEqual(s.trace, [
    "fetch 1",
    `sleep ${1200 + RATELIMIT_SLACK_MS}`,
    "fetch 2",
  ]);
});

test("the first 429 fires the notifier exactly once, before any wait", async () => {
  const s = scripted([() => ratelimited(100)]);
  const fired: string[] = [];
  await assert.rejects(
    fetchWithRatelimitPolicy(
      s.fetch,
      "PUT",
      "/mls/key_packages",
      {
        onRatelimited: (method, path) => {
          fired.push(`${method} ${path}`);
          s.trace.push("notified");
        },
      },
      s.effects,
    ),
    isRateLimited,
  );
  assert.deepEqual(fired, ["PUT /mls/key_packages"]);
  // Before the first sleep — the fail-safe reads the latch at 5 s and the
  // wait it would otherwise miss can be 10 s long.
  assert.equal(s.trace.indexOf("notified"), 1);
  assert.equal(s.trace.filter((step) => step === "notified").length, 1);
});

test("a 200 on the first try never fires the notifier", async () => {
  const s = scripted([ok]);
  let fired = 0;
  await fetchWithRatelimitPolicy(
    s.fetch,
    "POST",
    "/mls/groups",
    { onRatelimited: () => fired++ },
    s.effects,
  );
  assert.equal(fired, 0);
  assert.deepEqual(s.trace, ["fetch 1"]);
});

test("only delivery-service paths count as MLS transport", () => {
  assert.equal(isMlsPath("/mls/key_packages"), true);
  assert.equal(isMlsPath("/mls/groups/01GRP/commits"), true);
  assert.equal(isMlsPath("/e2ee/devices/01ABC"), false);
  assert.equal(isMlsPath("/mls"), false);
});

test("the call-plane budget stops after one retry", async () => {
  const s = scripted([() => ratelimited(100)]);
  await assert.rejects(
    fetchWithRatelimitPolicy(
      s.fetch,
      "POST",
      "/mls/key_packages/claim",
      { maxRetries: CALL_PLANE_RATELIMIT_RETRIES },
      s.effects,
    ),
    (error: unknown) => isRateLimited(error) && error.attempts === 2,
  );
  assert.equal(s.calls(), 2);
  // And a zero budget throws on the first 429 without sleeping at all.
  const z = scripted([() => ratelimited(100)]);
  await assert.rejects(
    fetchWithRatelimitPolicy(
      z.fetch,
      "GET",
      "/x",
      { maxRetries: 0 },
      z.effects,
    ),
    (error: unknown) => isRateLimited(error) && error.attempts === 1,
  );
  assert.deepEqual(z.trace, ["fetch 1"]);
});

test("an abort during the wait stops the retries with the abort reason", async () => {
  const controller = new AbortController();
  const s = scripted([() => ratelimited(100)]);
  const hungUp = new Error("hung up");
  await assert.rejects(
    fetchWithRatelimitPolicy(
      s.fetch,
      "GET",
      "/e2ee/devices/01ABC",
      { signal: controller.signal },
      {
        ...s.effects,
        // The real sleep, so the abort has to cut through a pending timer.
        sleep: (ms, signal) => {
          s.trace.push(`sleep ${ms}`);
          queueMicrotask(() => controller.abort(hungUp));
          return abortableSleep(ms, signal);
        },
      },
    ),
    (error: unknown) => error === hungUp,
  );
  assert.equal(s.calls(), 1);
});

test("an already-aborted signal never sends the request", async () => {
  const controller = new AbortController();
  const reason = new Error("call is over");
  controller.abort(reason);
  const s = scripted([ok]);
  await assert.rejects(
    fetchWithRatelimitPolicy(
      s.fetch,
      "GET",
      "/x",
      { signal: controller.signal },
      s.effects,
    ),
    (error: unknown) => error === reason,
  );
  assert.equal(s.calls(), 0);
});

test("abortableSleep resolves on time and rejects on abort", async () => {
  await abortableSleep(1);
  const controller = new AbortController();
  const pending = abortableSleep(60_000, controller.signal);
  controller.abort(new Error("cut"));
  await assert.rejects(pending, /cut/);
});

// ---- The per-request deadline ---------------------------------------------

/** A fetch that never answers: it settles only when its signal aborts. */
function hung(seen: AbortSignal[]) {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: (signal?: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        calls++;
        if (signal) seen.push(signal);
        signal?.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  };
}

test("the deadline clears the worst-case 429 ladder with room to spare", () => {
  // Three waits, each clamped to the server's 10 s window (slack + jitter
  // are inside the clamp): 30 s of sleeping, ~33 s with the round-trips. The
  // deadline must sit comfortably above that, or a merely rate-limited
  // request would be cut before its last legitimate retry.
  const worstSleep = RATELIMIT_MAX_RETRIES * RATELIMIT_MAX_DELAY_MS;
  assert.equal(worstSleep, 30_000);
  assert.ok(MLS_REQUEST_DEADLINE_MS >= worstSleep + 10_000);
  assert.equal(MLS_REQUEST_DEADLINE_MS, 45_000);
});

test("a request the server never answers is cut at the deadline, typed, unretried", async () => {
  const seen: AbortSignal[] = [];
  const h = hung(seen);
  await assert.rejects(
    fetchWithRatelimitPolicy(h.fetch, "POST", "/mls/groups", {
      deadlineMs: 20,
    }),
    (error: unknown) =>
      isRequestTimeout(error) &&
      !isRateLimited(error) &&
      error.method === "POST" &&
      error.path === "/mls/groups" &&
      error.deadlineMs === 20,
  );
  // The transport does not retry a deadline cut: one attempt, and the
  // signal that attempt rode is the one that was aborted.
  assert.equal(h.calls(), 1);
  assert.equal(seen.length, 1);
  assert.ok(seen[0].aborted);
});

test("the deadline also bounds the 429 wait, and that cut is not a rate limit", async () => {
  // Always 429 with a reset far past the deadline: the real sleep is what
  // the deadline has to cut through, and the caller must be told "timed
  // out", never "rate limited" (which would read as a server verdict).
  const s = scripted([() => ratelimited(10_000)]);
  await assert.rejects(
    fetchWithRatelimitPolicy(
      s.fetch,
      "GET",
      "/mls/channels/01ABC/open_group",
      { deadlineMs: 20 },
      { ...s.effects, sleep: abortableSleep },
    ),
    (error: unknown) => isRequestTimeout(error) && !isRateLimited(error),
  );
  assert.equal(s.calls(), 1);
});

test("the caller's own abort still wins under a deadline, with its reason", async () => {
  const controller = new AbortController();
  const hungUp = new Error("hung up");
  const seen: AbortSignal[] = [];
  const h = hung(seen);
  const pending = fetchWithRatelimitPolicy(h.fetch, "GET", "/mls/x", {
    signal: controller.signal,
    deadlineMs: 60_000,
  });
  controller.abort(hungUp);
  await assert.rejects(pending, (error: unknown) => error === hungUp);
  assert.equal(seen[0].reason, hungUp);
});

test("a request that answers in time disarms its deadline", async () => {
  const seen: AbortSignal[] = [];
  const response = await fetchWithRatelimitPolicy(
    async (signal) => {
      if (signal) seen.push(signal);
      return ok();
    },
    "GET",
    "/mls/x",
    { deadlineMs: 5 },
  );
  assert.equal(response.status, 200);
  await abortableSleep(15);
  // The composed signal the attempt rode never fires after the fact — the
  // timer was released with the response, not left to abort a settled
  // request (and keep the event loop alive) later.
  assert.equal(seen[0].aborted, false);
});

test("no deadline means no deadline: the caller's signal is passed through", async () => {
  const controller = new AbortController();
  const seen: AbortSignal[] = [];
  await fetchWithRatelimitPolicy(
    async (signal) => {
      if (signal) seen.push(signal);
      return ok();
    },
    "GET",
    "/e2ee/devices/01ABC",
    { signal: controller.signal },
  );
  assert.equal(seen[0], controller.signal);
});

test("requestDeadlineSignal: an already-aborted base aborts at once with its reason", () => {
  const base = new AbortController();
  const reason = new Error("call is over");
  base.abort(reason);
  const deadline = requestDeadlineSignal(
    60_000,
    new Error("late"),
    base.signal,
  );
  assert.ok(deadline.signal.aborted);
  assert.equal(deadline.signal.reason, reason);
  deadline.release(); // must be a harmless no-op
});

test("requestDeadlineSignal: release detaches from the base", async () => {
  const base = new AbortController();
  const deadline = requestDeadlineSignal(
    60_000,
    new Error("late"),
    base.signal,
  );
  deadline.release();
  base.abort(new Error("after release"));
  assert.equal(deadline.signal.aborted, false);
});

test("requestDeadlineSignal: the deadline fires with the given reason", async () => {
  const late = new Error("late");
  const deadline = requestDeadlineSignal(5, late);
  await abortableSleep(15);
  assert.ok(deadline.signal.aborted);
  assert.equal(deadline.signal.reason, late);
});

// ---- The call-roster reconcile's settlement -------------------------------

test("every listing that arrived is settled before anything throws", () => {
  const settled = settleCallRosterReconcile([
    { kind: "pinned", userId: "A" },
    { kind: "settled", userId: "B" },
    { kind: "pinned", userId: "C" },
  ]);
  assert.deepEqual(settled, { kind: "ok", pinnedUsers: ["A", "C"] });
});

test("one missing listing throws AFTER the arrivals are pinned", () => {
  const cause = new E2EERateLimitError("GET", "/e2ee/devices/B", 2500, 2);
  const settled = settleCallRosterReconcile([
    { kind: "pinned", userId: "A" },
    { kind: "unfetched", userId: "B", error: cause },
    { kind: "pinned", userId: "C" },
  ]);
  assert.equal(settled.kind, "unfetched");
  if (settled.kind !== "unfetched") return;
  // The pins on either side of the failure stand — the retry in the next
  // window only has to fetch what was missing.
  assert.deepEqual(settled.pinnedUsers, ["A", "C"]);
  assert.equal(settled.unfetchedCount, 1);
  // The cause stays TYPED, so the admitter can tell "ask again in a window"
  // from "no listing, ever".
  assert.equal(settled.error, cause);
  assert.equal(isRateLimited(settled.error), true);
});

test("several missing listings report the count and the first cause", () => {
  const first = new Error("offline");
  const outcomes: CallRosterOutcome[] = [
    { kind: "unfetched", userId: "A", error: first },
    { kind: "settled", userId: "B" },
    { kind: "unfetched", userId: "C", error: new Error("later") },
  ];
  const settled = settleCallRosterReconcile(outcomes);
  assert.equal(settled.kind, "unfetched");
  if (settled.kind !== "unfetched") return;
  assert.equal(settled.unfetchedCount, 2);
  assert.equal(settled.error, first);
  assert.deepEqual(settled.pinnedUsers, []);
});

test("an empty roster settles clean", () => {
  assert.deepEqual(settleCallRosterReconcile([]), {
    kind: "ok",
    pinnedUsers: [],
  });
});
