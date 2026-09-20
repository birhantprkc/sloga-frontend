// Session-level specs for the join-timeline wiring (`MlsCallSession` +
// `mlsJoinTimeline.ts`), on the shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.timeline.test.ts
//
// The recorder itself is pinned by `mlsJoinTimeline.test.ts`. These four pin
// WHERE the session stamps it, because a stamp in the wrong place (or one
// silently dropped from the wiring) turns the readout the join-latency plan
// measures its levers against into a fiction that still prints. Each list
// below is the EXACT sequence this world reaches, so a stamp that moves,
// duplicates or disappears fails here rather than in a live leg.
//
// What this world can and cannot reach on the joiner path: every stamp from
// `start` through `modeE2ee` is reachable. `e2eeEnabled` needs the media
// binding's `setEncryptionEnabled`, which the fake implements (a resolving
// no-op), so the enable window runs to completion; `keyPackagesPut` is taken
// after `#ensureKeyPackages`, which runs in `start()` ahead of the first
// establish and is never re-run by a re-establish.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  GROUP,
  newWorld,
  THIRD,
} from "./mlsCallSession.harness.ts";
import type { JoinStamp, JoinTimelineSummary } from "./mlsJoinTimeline.ts";

/** The joiner's summary, or a failure naming the seat that has none. */
function joinTimelineOf(world: World): JoinTimelineSummary {
  const summary = world.session.metrics().joinTimeline;
  assert.ok(summary, "metrics() carries no joiner timeline");
  return summary;
}

function names(summary: JoinTimelineSummary): JoinStamp[] {
  return summary.stamps.map((s) => s.name);
}

/** The ms of `name`, or a failure: the summary is the only public reader. */
function msOf(summary: JoinTimelineSummary, name: JoinStamp): number {
  const entry = summary.stamps.find((s) => s.name === name);
  assert.ok(entry, `${name} was never stamped`);
  return entry.ms;
}

/** Stamps never run backwards: each ms is at least the one before it. */
function assertMonotone(summary: JoinTimelineSummary): void {
  for (let i = 1; i < summary.stamps.length; i++) {
    const prev = summary.stamps[i - 1];
    const next = summary.stamps[i];
    assert.ok(
      next.ms >= prev.ms,
      `${next.name} (${next.ms} ms) precedes ${prev.name} (${prev.ms} ms)`,
    );
  }
}

/**
 * The joiner ladder as this world drives it, in stamp order. The create
 * ladder conflicts onto the open group (409 → join), the startup wipe finds
 * nothing to wipe but is still passed, the pre-join pin reconciles the SFU
 * set, the intent is accepted, the Welcome is adopted, the first local key
 * installs, and the enable window flips E2EE on and lands the `e2ee` label.
 */
const JOINER_SEQUENCE: JoinStamp[] = [
  "start",
  "keyPackagesPut",
  "createRouted",
  "wipeDone",
  "reconcileDone",
  "intentAccepted",
  "welcomeAdopted",
  "keysInstalled",
  "enableBegin",
  "e2eeEnabled",
  "modeE2ee",
];

/**
 * A re-establish re-runs the ladder from the create route up to the Welcome
 * wait: the KeyPackage enrolment lives in `start()` and is not repeated, and
 * no Welcome has answered the fresh intent yet.
 */
const REESTABLISH_SEQUENCE: JoinStamp[] = [
  "start",
  "createRouted",
  "wipeDone",
  "reconcileDone",
  "intentAccepted",
];

// ---- Specs -----------------------------------------------------------------

test("a joiner bring-up stamps the join timeline in order", async (t) => {
  const world = newWorld(t, "joiner", "ch-timeline-joiner");
  await bringUpJoiner(t, world, 1);
  const summary = joinTimelineOf(world);
  assert.equal(summary.role, "joiner");
  assert.deepEqual(names(summary), JOINER_SEQUENCE);
  assert.deepEqual(summary.stamps[0], { name: "start", ms: 0 });
  assertMonotone(summary);
  assert.equal(summary.totalMs, msOf(summary, "modeE2ee"));
});

test("keysInstalled is stamped by the local key install", async (t) => {
  // Driven by hand rather than through `bringUpJoiner`, so the clock can move
  // BETWEEN the Welcome and the key install: with both in the same tick the
  // two stamps round to the same ms and "installed after adopted" would hold
  // for a stamp taken at the Welcome too.
  const world = newWorld(t, "joiner", "ch-timeline-keys");
  void world.session.start();
  await flush();
  await advance(t, 1); // the establish runs up to the Welcome wait
  assert.equal(world.session.state(), "starting");
  await world.welcome(1);
  assert.equal(world.session.state(), "active");
  const KEY_DELAY_MS = 300;
  await advance(t, KEY_DELAY_MS);
  await world.session.onLocalKeysChanged(GROUP, 1);
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee");

  const summary = joinTimelineOf(world);
  const adopted = msOf(summary, "welcomeAdopted");
  const installed = msOf(summary, "keysInstalled");
  assert.ok(
    installed >= adopted + KEY_DELAY_MS,
    `keysInstalled at ${installed} ms, welcomeAdopted at ${adopted} ms`,
  );
  // And the install is what it follows: nothing between the two on the list.
  assert.equal(
    names(summary).indexOf("keysInstalled"),
    names(summary).indexOf("welcomeAdopted") + 1,
  );
});

test("an admitted joiner leaves an admit timeline with joinRequestSeen → staggerFired → claimDone → commitWon", async (t) => {
  const world = newWorld(t, "creator", "ch-timeline-admit");
  await bringUpCreator(t, world);
  assert.ok(
    !world.session.metrics().admitTimelines?.length,
    "an admit timeline exists before any join request",
  );
  // THIRD, not PEER: the world seats PEER in the roster from the start, and a
  // join request for a member already in the roster stops as
  // `already_member` before any stagger.
  await world.joinRequest(THIRD);
  await advance(t, 1); // SELF is leaf 0: the 0 ms stagger fires the admit
  await flush();
  assert.ok(world.bridgeCalls.includes("callCommitWon"), "the Add never won");

  const timelines = world.session.metrics().admitTimelines;
  assert.ok(timelines, "metrics() carries no admit timelines");
  assert.equal(timelines.length, 1);
  const [admit] = timelines;
  assert.equal(admit.role, "admitter");
  assert.deepEqual(names(admit), [
    "joinRequestSeen",
    "reconcileDone",
    "staggerFired",
    "claimDone",
    "commitWon",
  ]);
  assert.deepEqual(admit.stamps[0], { name: "joinRequestSeen", ms: 0 });
  assertMonotone(admit);
});

test("a re-establish restarts the joiner timeline", async (t) => {
  const world = newWorld(t, "joiner", "ch-timeline-reestablish");
  await bringUpJoiner(t, world, 1);
  await advance(t, 3_000); // past the immediate-install rotation settle
  const first = joinTimelineOf(world);
  assert.ok(names(first).includes("modeE2ee"), "the first join never landed");
  const intents = world.joinIntents();

  // A kick while SELF is still in the SFU: `#onRemovedSelf` → `#rejoinFresh`
  // → a fresh establish, which broadcasts a new intent and waits for its
  // Welcome. That establish is a new generation of the SAME session, so a
  // timeline that merely first-wins its stamps would keep the old `start`
  // and the old `modeE2ee`, and the readout would attribute the rejoin's
  // dead air to a join that finished seconds ago.
  await world.removedSelf(2);
  await advance(t, 1); // `#onRemovedSelf` runs as a 0 ms group action
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.joinIntents(), intents + 1, "no fresh intent broadcast");

  const second = joinTimelineOf(world);
  assert.deepEqual(names(second), REESTABLISH_SEQUENCE);
  assert.deepEqual(second.stamps[0], { name: "start", ms: 0 });
  assert.ok(
    !names(second).includes("modeE2ee"),
    "the previous generation's stamps survived the restart",
  );
  assertMonotone(second);
  // The first generation's snapshot was a copy: the restart did not alias it.
  assert.deepEqual(names(first), JOINER_SEQUENCE);
});
