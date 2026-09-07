// Unit spec for the E2EE transport's 429 policy — run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/e2eeRatelimitPolicy.test.ts
// (pure functions, so the browser condition is not load-bearing here — it is
// kept so one invocation can cover the reactive suites beside it.)
// Focus: the server's reset hint is honored in the right order and unit, the
// wait is bounded above and below, and the bound on retries is real — after
// it the transport throws a TYPED error a caller can tell from "unreachable".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  E2EERateLimitError,
  isRateLimited,
  RATELIMIT_DEFAULT_DELAY_MS,
  RATELIMIT_JITTER_MS,
  RATELIMIT_MAX_DELAY_MS,
  RATELIMIT_MAX_RETRIES,
  RATELIMIT_SLACK_MS,
  ratelimitRetryDelayMs,
  retryAfterMs,
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
