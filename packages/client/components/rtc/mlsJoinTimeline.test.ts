// Unit spec for the join-timeline recorder — run with Node's built-in runner:
//   node --test components/rtc/mlsJoinTimeline.test.ts   (Node >=23.6 strips types)
// Focus (join-latency plan, slice 0): every later slice is judged by this
// readout, so its arithmetic must be beyond doubt — t0 is the first stamp,
// a repeated stamp never moves, and a summary is a snapshot nobody can alias.
// The clock is always injected; a spec that reads real time proves nothing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { type JoinTimelineSummary, JoinTimeline } from "./mlsJoinTimeline.ts";

test("the first stamp defines t0", () => {
  // A clock that is already well past zero: the first stamp must read 0
  // regardless of the absolute time it was taken at.
  const t = 1_234.5;
  const tl = new JoinTimeline("joiner", () => t);
  assert.deepEqual(tl.summary().stamps, []);
  tl.stamp("start");
  assert.deepEqual(tl.summary().stamps, [{ name: "start", ms: 0 }]);
  assert.equal(tl.elapsedTo("start"), 0);
  // The default clock (performance.now) obeys the same rule.
  const live = new JoinTimeline("joiner");
  live.stamp("start");
  assert.equal(live.elapsedTo("start"), 0);
});

test("stamps report ms relative to t0 in insertion order", () => {
  let t = 500;
  const tl = new JoinTimeline("joiner", () => t);
  tl.stamp("start");
  t = 512.34;
  tl.stamp("keyPackagesPut");
  // Deliberately NOT the declaration order of the stamp names: the summary
  // reports the order the stamps were taken in, nothing else.
  t = 700.06;
  tl.stamp("enableBegin");
  t = 1_501.96;
  tl.stamp("createRouted");
  // ms is rounded to 0.1 (12.34 → 12.3, 200.06 → 200.1, 1001.96 → 1002).
  assert.deepEqual(tl.summary().stamps, [
    { name: "start", ms: 0 },
    { name: "keyPackagesPut", ms: 12.3 },
    { name: "enableBegin", ms: 200.1 },
    { name: "createRouted", ms: 1_002 },
  ]);
});

test("a duplicate stamp name keeps the first occurrence", () => {
  // An admit re-drive re-runs the reconcile; the timeline must keep the
  // moment the step FIRST completed, or the readout hides the re-drive cost.
  let t = 0;
  const tl = new JoinTimeline("admitter", () => t);
  tl.stamp("joinRequestSeen");
  t = 100;
  tl.stamp("reconcileDone");
  t = 250;
  tl.stamp("reconcileDone");
  t = 300;
  tl.stamp("staggerFired");
  assert.deepEqual(tl.summary().stamps, [
    { name: "joinRequestSeen", ms: 0 },
    { name: "reconcileDone", ms: 100 },
    { name: "staggerFired", ms: 300 },
  ]);
  assert.equal(tl.elapsedTo("reconcileDone"), 100);
  // A repeat of the FIRST stamp must not move t0 either.
  t = 400;
  tl.stamp("joinRequestSeen");
  assert.equal(tl.elapsedTo("staggerFired"), 300);
  assert.equal(tl.summary().stamps.length, 3);
});

test("elapsedTo returns null for a stamp never taken", () => {
  const tl = new JoinTimeline("joiner", () => 0);
  // Empty timeline: not even t0 exists yet.
  assert.equal(tl.elapsedTo("start"), null);
  tl.stamp("start");
  // A step that never happened is null, never 0 — 0 means "at t0".
  assert.equal(tl.elapsedTo("welcomeAdopted"), null);
  assert.equal(tl.elapsedTo("modeE2ee"), null);
});

test("elapsedTo returns the stamp's ms", () => {
  let t = 10;
  const tl = new JoinTimeline("joiner", () => t);
  tl.stamp("start");
  t = 1_260;
  tl.stamp("keysInstalled");
  t = 1_900;
  tl.stamp("e2eeEnabled");
  assert.equal(tl.elapsedTo("keysInstalled"), 1_250);
  assert.equal(tl.elapsedTo("e2eeEnabled"), 1_890);
  // It reads the recorded stamp, not the clock at the time of the question.
  t = 5_000;
  assert.equal(tl.elapsedTo("keysInstalled"), 1_250);
});

test("restart clears every stamp and the next stamp is a new t0", () => {
  // A re-establish is a fresh joiner attempt; measuring it against the
  // previous generation's t0 would blame the new attempt for the old wait.
  let t = 0;
  const tl = new JoinTimeline("joiner", () => t);
  tl.stamp("start");
  t = 800;
  tl.stamp("intentAccepted");
  tl.restart();
  assert.deepEqual(tl.summary().stamps, []);
  assert.equal(tl.summary().totalMs, 0);
  assert.equal(tl.elapsedTo("start"), null);
  assert.equal(tl.elapsedTo("intentAccepted"), null);
  t = 10_000;
  tl.stamp("start");
  t = 10_400;
  tl.stamp("intentAccepted");
  assert.deepEqual(tl.summary().stamps, [
    { name: "start", ms: 0 },
    { name: "intentAccepted", ms: 400 },
  ]);
});

test("summary returns a fresh object each call", () => {
  // The admit ring and the console line both hold on to summaries; a later
  // stamp or a caller's edit must never rewrite what was already reported.
  let t = 0;
  const tl = new JoinTimeline("admitter", () => t);
  tl.stamp("joinRequestSeen");
  t = 50;
  tl.stamp("claimDone");
  const first = tl.summary();
  const second = tl.summary();
  assert.notEqual(first, second);
  assert.notEqual(first.stamps, second.stamps);
  assert.deepEqual(first, second);
  first.stamps.push({ name: "commitWon", ms: 999 });
  first.totalMs = -1;
  first.role = "joiner";
  const expected: JoinTimelineSummary = {
    role: "admitter",
    stamps: [
      { name: "joinRequestSeen", ms: 0 },
      { name: "claimDone", ms: 50 },
    ],
    totalMs: 50,
  };
  assert.deepEqual(tl.summary(), expected);
  assert.deepEqual(second, expected);
  // And a stamp taken after the fact does not reach an older summary.
  t = 90;
  tl.stamp("commitWon");
  assert.deepEqual(second, expected);
  assert.equal(tl.summary().stamps.length, 3);
});

test("totalMs is last minus first and 0 with one stamp", () => {
  let t = 100;
  const tl = new JoinTimeline("joiner", () => t);
  assert.equal(tl.summary().totalMs, 0);
  tl.stamp("start");
  assert.equal(tl.summary().totalMs, 0);
  t = 350;
  tl.stamp("keyPackagesPut");
  assert.equal(tl.summary().totalMs, 250);
  // The total spans first → last, not first → second; 0.1 rounding applies.
  t = 2_100.06;
  tl.stamp("modeE2ee");
  assert.equal(tl.summary().totalMs, 2_000.1);
});

test("the role is echoed in the summary", () => {
  assert.equal(new JoinTimeline("joiner", () => 0).summary().role, "joiner");
  const admit = new JoinTimeline("admitter", () => 0);
  assert.equal(admit.summary().role, "admitter");
  // The role is fixed at construction; a restart does not lose it.
  admit.stamp("joinRequestSeen");
  admit.restart();
  assert.equal(admit.summary().role, "admitter");
});
