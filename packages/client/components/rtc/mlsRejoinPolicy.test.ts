// Unit spec for the rejoin-after-reload policy — run with Node's built-in
// runner:
//   node --test components/rtc/mlsRejoinPolicy.test.ts   (Node >=23.6 strips types)
// Focus (rejoin plan §6 tests 2/3/8): the startup wipe's target selection
// (channel-scoped, orphan-sparing, once-per-page), the peer-side rejoin-serve
// staleness gate, and the generation-guarded Welcome acceptance. Wave 1.5:
// the epoch-keyed serve-target check that stops a staggered serve removing a
// member re-seated after the serve was scheduled. Resume wave 2: every rule
// of `resumeDecision` failing alone, its age/lag boundaries, `recencyValid`,
// and the startup wipe sparing the resumed group.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type ResumePrefetch,
  admitInProgressVerdict,
  LOCAL_GROUP_KEEP_MS,
  recencyValid,
  REJOIN_SERVE_SUPPRESS_MS,
  rejoinReintentWindowMs,
  rejoinServeAction,
  RESUME_MAX_LAG,
  resumeDecision,
  serveTargetStillStale,
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

test("the group a resume adopts is spared, like the create route's orphan (D2/D6)", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["stale", "kept"],
      orphanGroupId: null,
      tokenSpent: false,
      spareGroupId: "kept",
    }),
    ["stale"],
  );
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["stale", "kept", "orphan"],
      orphanGroupId: "orphan",
      tokenSpent: false,
      spareGroupId: "kept",
    }),
    ["stale"],
  );
});

test("a spent token wipes nothing even with a group to spare", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["stale", "kept"],
      orphanGroupId: null,
      tokenSpent: true,
      spareGroupId: "kept",
    }),
    [],
  );
});

test("no group to spare wipes exactly as before", () => {
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["g1", "g2"],
      orphanGroupId: null,
      tokenSpent: false,
      spareGroupId: null,
    }),
    ["g1", "g2"],
  );
  assert.deepEqual(
    startupWipeTargets({
      localGroupIds: ["stale", "orphan"],
      orphanGroupId: "orphan",
      tokenSpent: false,
      spareGroupId: null,
    }),
    ["stale"],
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

test("a backwards clock jump reads as LAPSED, not as a fresh window", () => {
  // The budget deadline moves with the same clock, so "inside the window"
  // would have kept a departed-but-SFU-present device pending for the whole
  // jump.
  assert.equal(
    admitInProgressVerdict({ ...idle, rejoinServedAtMs: 10_000, nowMs: 5_000 }),
    false,
  );
});

// ---- serveTargetStillStale (the staggered-serve kick) -----------------------

test("a serve target no commit has removed is still the stale leaf", () => {
  assert.equal(
    serveTargetStillStale({ scheduledAtEpoch: 7, removedAtEpoch: null }),
    true,
  );
});

test("a Remove at the scheduling epoch was already in the state the serve read — still stale", () => {
  // The anchor is the epoch of the callState that confirmed the leaf present,
  // so that leaf was present AFTER this Remove: it is the one to serve.
  assert.equal(
    serveTargetStillStale({ scheduledAtEpoch: 7, removedAtEpoch: 7 }),
    true,
  );
});

test("🔴 a Remove applied after scheduling means the present leaf is the re-seated member — refuse", () => {
  // The fleet defect: leaf 6's serve fires at 12 s, after the Remove and the
  // Add (~10.5 s), and would remove the LIVE re-added member.
  for (const removedAtEpoch of [8, 9, 1_000]) {
    assert.equal(
      serveTargetStillStale({ scheduledAtEpoch: 7, removedAtEpoch }),
      false,
      `removed at ${removedAtEpoch}`,
    );
  }
});

test("a Remove from before scheduling (an earlier rejoin cycle) never blocks the serve", () => {
  for (const removedAtEpoch of [0, 3, 6]) {
    assert.equal(
      serveTargetStillStale({ scheduledAtEpoch: 7, removedAtEpoch }),
      true,
      `removed at ${removedAtEpoch}`,
    );
  }
});

// ---- resumeDecision (resume plan, session step 1) ---------------------------
//
// Each negative case breaks exactly ONE rule of an otherwise valid prefetch,
// so a rule that stops being checked leaves its case resuming.

const CH = "chan";
const NOW = 1_000_000;
const LOCAL_EPOCH = 7;

/** `n` fetched commits taking the local epoch forward one epoch at a time. */
function contiguous(n: number): ResumePrefetch["commits"] {
  return Array.from({ length: n }, (_, i) => ({
    epoch: LOCAL_EPOCH + 1 + i,
    committerIsSelf: false,
  }));
}

/** A prefetch every rule accepts, `lag` epochs behind the DS. */
function valid(lag = 2): ResumePrefetch {
  return {
    groupId: "kept",
    claimToken: "token",
    fetchedAtMs: NOW - 1_000,
    queriedChannelId: CH,
    localEpoch: LOCAL_EPOCH,
    localState: "active",
    localChannelId: CH,
    selfInLocalRoster: true,
    openGroupId: "kept",
    pendingCommit: null,
    commits: contiguous(lag),
    currentEpoch: LOCAL_EPOCH + lag,
  };
}

/** The startup establish on the intended channel, at `NOW`. */
function decide(p: ResumePrefetch | null): "resume" | "join" {
  return resumeDecision(p, CH, true, NOW);
}

test("a fully valid prefetch resumes", () => {
  assert.equal(decide(valid()), "resume");
});

test("a recency-only candidate (Ctrl+R, no claim token) resumes on the same rules", () => {
  assert.equal(decide({ ...valid(), claimToken: null }), "resume");
});

test("(1) no prefetch joins — an old shell, no candidate, or a failed prefetch", () => {
  assert.equal(decide(null), "join");
});

test("(2) only the startup establish may resume (M6/R2-m7)", () => {
  assert.equal(resumeDecision(valid(), CH, false, NOW), "join");
});

test("(3) a prefetch older than the keep window joins (R2-m1)", () => {
  assert.equal(
    decide({ ...valid(), fetchedAtMs: NOW - LOCAL_GROUP_KEEP_MS - 1 }),
    "join",
  );
});

test("(3) a prefetch stamped after now (a backwards clock) joins", () => {
  assert.equal(decide({ ...valid(), fetchedAtMs: NOW + 1 }), "join");
});

test("(3) boundary: a prefetch exactly the keep window old, or just taken, resumes", () => {
  assert.equal(
    decide({ ...valid(), fetchedAtMs: NOW - LOCAL_GROUP_KEEP_MS }),
    "resume",
  );
  assert.equal(decide({ ...valid(), fetchedAtMs: NOW }), "resume");
});

test("(4) no group open on the DS for the channel joins", () => {
  assert.equal(decide({ ...valid(), openGroupId: null }), "join");
});

test("(4) the DS's open group being another group joins", () => {
  assert.equal(decide({ ...valid(), openGroupId: "other" }), "join");
});

test("(5) an open-group GET for another channel joins (T-15 binding, R2-m1)", () => {
  assert.equal(decide({ ...valid(), queriedChannelId: "other" }), "join");
});

test("(5) a local group bound to another channel joins (T-15 binding, R2-m1)", () => {
  assert.equal(decide({ ...valid(), localChannelId: "other" }), "join");
});

test("(5) a prefetch agreeing with itself but not with the intended channel joins", () => {
  assert.equal(resumeDecision(valid(), "other", true, NOW), "join");
});

test("(6) a poisoned local group joins", () => {
  assert.equal(decide({ ...valid(), localState: "poisoned" }), "join");
});

test("(6) self absent from the local roster joins", () => {
  assert.equal(decide({ ...valid(), selfInLocalRoster: false }), "join");
});

test("(7) a staged pending commit joins (B3)", () => {
  for (const pendingCommit of [LOCAL_EPOCH + 1, 0]) {
    assert.equal(
      decide({ ...valid(), pendingCommit }),
      "join",
      `pending at ${pendingCommit}`,
    );
  }
});

test("(8) a fetched commit this device authored joins", () => {
  for (const selfAt of [0, 1]) {
    const commits = contiguous(2).map((c, i) => ({
      ...c,
      committerIsSelf: i === selfAt,
    }));
    assert.equal(decide({ ...valid(), commits }), "join", `self at ${selfAt}`);
  }
});

test("(9) boundary: a lag of RESUME_MAX_LAG - 1 resumes", () => {
  assert.equal(decide(valid(RESUME_MAX_LAG - 1)), "resume");
});

test("(9) a lag of RESUME_MAX_LAG joins (the session's desync threshold)", () => {
  assert.equal(decide(valid(RESUME_MAX_LAG)), "join");
});

test("(9) a local epoch ahead of the DS joins", () => {
  // No list can match a negative lag, so rule (10) necessarily fails with it.
  assert.equal(decide({ ...valid(0), currentEpoch: LOCAL_EPOCH - 1 }), "join");
});

test("boundary: lag 0 with no commits to catch up resumes", () => {
  assert.equal(decide(valid(0)), "resume");
});

test("(10) a commit list shorter or longer than the lag joins", () => {
  const cases: [string, ResumePrefetch][] = [
    ["short", { ...valid(2), commits: contiguous(1) }],
    ["long", { ...valid(2), commits: contiguous(3) }],
    ["empty", { ...valid(2), commits: [] }],
    ["extra at lag 0", { ...valid(0), commits: contiguous(1) }],
  ];
  for (const [label, p] of cases) {
    assert.equal(decide(p), "join", label);
  }
});

test("(10) a right-length list that does not step epoch by epoch joins (R-W2-5)", () => {
  // The expected list for lag 2 from epoch 7 is [8, 9].
  for (const epochs of [
    [8, 10],
    [9, 8],
    [8, 8],
    [9, 10],
    [7, 8],
  ]) {
    const commits = epochs.map((epoch) => ({ epoch, committerIsSelf: false }));
    assert.equal(
      decide({ ...valid(2), commits }),
      "join",
      `epochs ${epochs.join(",")}`,
    );
  }
});

// ---- recencyValid (D7) -------------------------------------------------------

test("no recency record is never valid", () => {
  assert.equal(recencyValid(null, "kept", NOW), false);
});

test("a recency record for another group is not valid", () => {
  assert.equal(recencyValid({ groupId: "other", at: NOW }, "kept", NOW), false);
});

test("a recency record up to exactly the keep window old is valid", () => {
  assert.equal(recencyValid({ groupId: "kept", at: NOW }, "kept", NOW), true);
  assert.equal(
    recencyValid(
      { groupId: "kept", at: NOW - LOCAL_GROUP_KEEP_MS },
      "kept",
      NOW,
    ),
    true,
  );
});

test("a recency record past the keep window is not valid", () => {
  assert.equal(
    recencyValid(
      { groupId: "kept", at: NOW - LOCAL_GROUP_KEEP_MS - 1 },
      "kept",
      NOW,
    ),
    false,
  );
});

test("a recency record stamped after now (a backwards clock) is not valid", () => {
  assert.equal(
    recencyValid({ groupId: "kept", at: NOW + 1 }, "kept", NOW),
    false,
  );
});

// ---- the constants the session mirrors ---------------------------------------

test("a group is kept for 10 s (the session's LEAVE_GRACE_MS)", () => {
  assert.equal(LOCAL_GROUP_KEEP_MS, 10_000);
});

test("a resume catches up at most 11 epochs (the session's LAG_DESYNC_THRESHOLD is 12)", () => {
  assert.equal(RESUME_MAX_LAG, 12);
});
