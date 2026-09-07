// Unit spec for the rejoin-after-reload policy — run with Node's built-in
// runner:
//   node --test components/rtc/mlsRejoinPolicy.test.ts   (Node >=23.6 strips types)
// Focus (rejoin plan §6 tests 2/3/8): the startup wipe's target selection
// (channel-scoped, orphan-sparing, once-per-page), the peer-side rejoin-serve
// staleness gate, and the generation-guarded Welcome acceptance.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REJOIN_SERVE_SUPPRESS_MS,
  admitInProgressVerdict,
  rejoinReintentWindowMs,
  rejoinServeAction,
  startupWipeTargets,
  welcomeVerdict,
} from "./mlsRejoinPolicy.ts";

// ---- startupWipeTargets (§4.1) ---------------------------------------------

test("surviving local groups for the channel are all wiped on the join route", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["g1", "g2"],
      orphanGroupId: null,
      tokenSpent: false,
    }),
    ["g1", "g2"],
  );
});

test("the create route's fresh orphan is never wiped; stale siblings are (M9 solo case)", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["stale", "orphan"],
      orphanGroupId: "orphan",
      tokenSpent: false,
    }),
    ["stale"],
  );
});

test("absent local state wipes nothing (the plain establish)", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: [],
      orphanGroupId: null,
      tokenSpent: false,
    }),
    [],
  );
});

test("a spent page-lifetime token wipes nothing more — later establishes own their state", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["g1"],
      orphanGroupId: null,
      tokenSpent: true,
    }),
    [],
  );
});

// ---- rejoinServeAction (§4.8) ----------------------------------------------

test("a rejoin intent for a freshly (re-)added leaf is refused", () => {
  assert.equal(
    rejoinServeAction({ addedAtMs: 1_000, nowMs: 1_000 + 1 }),
    "refuse_recent_add",
  );
  assert.equal(
    rejoinServeAction({
      addedAtMs: 1_000,
      nowMs: 1_000 + REJOIN_SERVE_SUPPRESS_MS - 1,
    }),
    "refuse_recent_add",
  );
});

test("an actively re-broadcasting device is served once the window passes", () => {
  assert.equal(
    rejoinServeAction({
      addedAtMs: 1_000,
      nowMs: 1_000 + REJOIN_SERVE_SUPPRESS_MS,
    }),
    "serve",
  );
});

test("a device we never observed being added is served (today's behavior)", () => {
  assert.equal(rejoinServeAction({ addedAtMs: null, nowMs: 5_000 }), "serve");
});

test("the suppress window outlasts one 10 s re-broadcast beat", () => {
  // A stale burst re-broadcasts at most every 10 s; a window shorter than
  // that would serve the very next straggler and re-remove the fresh leaf.
  assert.ok(REJOIN_SERVE_SUPPRESS_MS > 10_000);
});

// ---- welcomeVerdict (§4.2 / F2) --------------------------------------------

test("a Welcome for the live join target adopts and resolves the live-generation wait", () => {
  assert.deepEqual(
    welcomeVerdict({
      welcomeGroupId: "g",
      liveGroupId: "g",
      waitGeneration: 3,
      liveGeneration: 3,
    }),
    { adopt: true, resolveWait: true },
  );
});

test("a stale-generation wait is never cross-resolved by a newer establish's Welcome", () => {
  assert.deepEqual(
    welcomeVerdict({
      welcomeGroupId: "g",
      liveGroupId: "g",
      waitGeneration: 2,
      liveGeneration: 3,
    }),
    { adopt: true, resolveWait: false },
  );
});

test("a Welcome for a group we since abandoned proves NOTHING (F2)", () => {
  assert.deepEqual(
    welcomeVerdict({
      welcomeGroupId: "old",
      liveGroupId: "new",
      waitGeneration: 3,
      liveGeneration: 3,
    }),
    { adopt: false, resolveWait: false },
  );
});

test("with no live group nothing adopts (post-teardown straggler)", () => {
  assert.deepEqual(
    welcomeVerdict({
      welcomeGroupId: "g",
      liveGroupId: null,
      waitGeneration: null,
      liveGeneration: 4,
    }),
    { adopt: false, resolveWait: false },
  );
});

// ---- the served-rejoin window + "still admitting" (the rejoin beat) ----------

const WINDOW = rejoinReintentWindowMs({
  joinerRetryMs: 10_000,
  submitTimeoutMs: 10_000,
  settleMs: 2_000,
});

test("the served-rejoin window is the re-broadcast cadence + one submit + the settle", () => {
  assert.equal(WINDOW, 22_000);
});

const idle = {
  scheduledAdmit: false,
  ledgeredAdmit: false,
  scheduledRejoin: false,
  ledgeredRejoin: false,
  rejoinServedAtMs: null,
  windowMs: WINDOW,
};

test("nothing scheduled, ledgered or served ⇒ not in progress", () => {
  assert.equal(admitInProgressVerdict({ ...idle, nowMs: 50_000 }), false);
});

test("each admit/rejoin arm alone keeps the window alive", () => {
  for (const arm of [
    "scheduledAdmit",
    "ledgeredAdmit",
    "scheduledRejoin",
    "ledgeredRejoin",
  ] as const) {
    assert.equal(
      admitInProgressVerdict({ ...idle, [arm]: true, nowMs: 50_000 }),
      true,
      arm,
    );
  }
});

test("🔴 a stale leaf removed while the device is connected keeps its window alive until the re-Add is due", () => {
  // The phase nothing else ledgers: the Remove landed, the rejoiner's next
  // broadcast (10 s cadence) has not arrived, no Add is scheduled. Measured
  // live 2026-09-07: the window lapsed here and the stayer went `mixed`.
  assert.equal(
    admitInProgressVerdict({
      ...idle,
      rejoinServedAtMs: 10_000,
      nowMs: 20_000,
    }),
    true,
  );
  assert.equal(
    admitInProgressVerdict({
      ...idle,
      rejoinServedAtMs: 10_000,
      nowMs: 10_000 + WINDOW - 1,
    }),
    true,
  );
});

test("at and past the window a served rejoin no longer counts (liveness bound)", () => {
  assert.equal(
    admitInProgressVerdict({
      ...idle,
      rejoinServedAtMs: 10_000,
      nowMs: 10_000 + WINDOW,
    }),
    false,
  );
  assert.equal(
    admitInProgressVerdict({
      ...idle,
      rejoinServedAtMs: 10_000,
      nowMs: 90_000,
    }),
    false,
  );
});

test("a backwards clock jump reads as inside the window (the deadline still caps)", () => {
  assert.equal(
    admitInProgressVerdict({ ...idle, rejoinServedAtMs: 10_000, nowMs: 5_000 }),
    true,
  );
});
