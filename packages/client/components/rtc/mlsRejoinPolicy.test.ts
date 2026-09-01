// Unit spec for the rejoin-after-reload policy — run with Node's built-in
// runner:
//   node --test components/rtc/mlsRejoinPolicy.test.ts   (Node >=23.6 strips types)
// Focus (rejoin plan §6 tests 2/3/8): the startup wipe's target selection
// (channel-scoped, orphan-sparing, once-per-page), the peer-side rejoin-serve
// staleness gate, and the generation-guarded Welcome acceptance.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REJOIN_SERVE_SUPPRESS_MS,
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
