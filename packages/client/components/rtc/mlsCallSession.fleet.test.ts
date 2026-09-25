// Session-level specs on a FLEET: several `MlsCallSession`s, one per device,
// seated on one shared delivery service (`newFleet` in
// `mlsCallSession.harness.ts`).
//   node --test --conditions=browser components/rtc/mlsCallSession.fleet.test.ts
//
// The first four pin the fleet itself, because every later spec on it is
// only as good as they are: a bring-up that converges, a DS that arbitrates
// first-submit-wins, one clock driving every seat, and a startup-wipe token
// per page rather than per process.
//
// The last is the stagger proof the one-seat world could not state. A
// wipe-rejoin is served by EVERY member, each on its own leaf stagger, so the
// member that must not act is a higher leaf whose serve fires after the
// rejoiner may already be back in. Here nothing is hand-placed: leaf 0's
// Remove, the rejoiner's re-intent, the Add that re-seats it and the higher
// leaf's serve all land when the real ladders put them.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type Fleet,
  type Identity,
  advance,
  flush,
  GROUP,
  identityOf,
  LEAVE_GRACE_MS,
  newFleet,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
  THIRD,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";
import { REJOIN_SERVE_SUPPRESS_MS } from "./mlsRejoinPolicy.ts";

/** The session's periodic reconcile tick (`RECONCILE_INTERVAL_MS`, private). */
const RECONCILE_INTERVAL_MS = 5_000;
/** Leaf order after a three-seat bring-up: creator first, then join order. */
const LEAF_ORDER = [SELF_ID, PEER_ID, THIRD_ID];

/** Every seat holds `members` at the DS's epoch, on an active row. */
function assertConverged(fleet: Fleet, members: string[]): void {
  assert.deepEqual(fleet.ds.members.map(identityOf), members, "DS roster");
  for (const world of fleet.seats) {
    const id = identityOf(world.me);
    assert.equal(world.session.state(), "active", `${id}'s session`);
    assert.equal(world.session.groupId(), GROUP, `${id}'s group`);
    assert.equal(world.localEpoch, fleet.ds.epoch, `${id}'s native epoch`);
    assert.deepEqual(
      world.localRoster.map(identityOf),
      members,
      `${id}'s native roster`,
    );
    assert.equal(world.localGroups.get(GROUP)?.state, "active", `${id}'s row`);
  }
}

/** The DS's arbitrated submits for GROUP from `index` on, as tuples. */
function groupSubmits(
  fleet: Fleet,
  index = 0,
): [string, string, number, string][] {
  return fleet.ds.submits
    .slice(index)
    .filter((s) => s.groupId === GROUP)
    .map((s) => [s.seat, s.kind, s.epoch, s.outcome]);
}

/** Advance until `id`'s session is active again, or fail after `boundMs`. */
async function untilActive(
  t: TestContext,
  fleet: Fleet,
  id: Identity,
  boundMs: number,
): Promise<void> {
  const world = fleet.seat(id);
  for (let waited = 0; waited < boundMs; waited += 250) {
    if (world.session.state() === "active") break;
    await advance(t, 250);
  }
  assert.equal(
    world.session.state(),
    "active",
    `${identityOf(id)} never re-joined`,
  );
}

// ---- The fleet itself ------------------------------------------------------

test("fleet: a three-seat bring-up converges on one epoch and one roster, in leaf order", async (t) => {
  const fleet = newFleet(t, [SELF, PEER, THIRD], "ch-fleet-up");
  await fleet.bringUp();

  // Re-checked here rather than trusted from `bringUp`'s own assertions: a
  // fleet whose check agreed with itself would prove nothing.
  assert.equal(fleet.ds.epoch, 2);
  assertConverged(fleet, LEAF_ORDER);
  // Leaf 0 created the group and admitted each joiner; every submit won.
  assert.deepEqual(groupSubmits(fleet), [
    [SELF_ID, "create", 0, "won"],
    [SELF_ID, "admit", 1, "won"],
    [SELF_ID, "admit", 2, "won"],
  ]);
});

test("fleet: two seats submitting at one epoch — the DS keeps the first, the other loses and catches up", async (t) => {
  const fleet = newFleet(t, [SELF, PEER, THIRD], "ch-fleet-arbitrate");
  await fleet.bringUp();
  await advance(t, 3_000);
  const from = fleet.ds.submits.length;

  // PEER drops off the SFU. Both remaining members watched it go, so both
  // leave-graces expire on the same tick and both stage a Remove of PEER at
  // epoch 3: the herd the DS's arbitration exists to dedup.
  const self = fleet.seat(SELF);
  self.sfu = self.sfu.filter((id) => id !== PEER_ID);
  self.sids.delete(PEER_ID);
  self.session.onParticipantLeft(PEER_ID);
  fleet.seat(THIRD).session.onParticipantLeft(PEER_ID);
  await flush();
  await advance(t, LEAVE_GRACE_MS + 1_000);

  const atThree = groupSubmits(fleet, from).filter(
    ([, , epoch]) => epoch === 3,
  );
  assert.deepEqual(
    atThree.map(([seat, kind]) => [seat, kind]).sort(),
    [
      [SELF_ID, "remove"],
      [THIRD_ID, "remove"],
    ],
    "both seats submitted a Remove at epoch 3",
  );
  assert.deepEqual(
    atThree.map(([, , , outcome]) => outcome),
    ["won", "lost"],
    "the first submit won, the second lost",
  );
  const winner = atThree[0][0];
  const loser = atThree[1][0];
  const stored = fleet.ds.log.find((c) => c.epoch === 3);
  assert.ok(stored, "the DS stored no commit at epoch 3");
  assert.equal(identityOf(stored.committer), winner);
  assert.equal(fleet.ds.epoch, 3);
  // The loser applied the winner's commit instead of its own.
  assert.ok(
    fleet.seat(loser).bridgeCalls.includes("callCommitLost"),
    `${loser} never dropped its losing commit`,
  );
  for (const id of [SELF, THIRD]) {
    const world = fleet.seat(id);
    assert.equal(world.localEpoch, 3, `${identityOf(id)}'s native epoch`);
    assert.deepEqual(world.localRoster.map(identityOf), [SELF_ID, THIRD_ID]);
  }
});

test("fleet: one advance fires every seat's timers, and nothing fires without it", async (t) => {
  const fleet = newFleet(t, [SELF, PEER, THIRD], "ch-fleet-clock");
  await fleet.bringUp();
  await advance(t, 3_000);
  const reads = () =>
    fleet.seats.map(
      (w) => w.bridgeCalls.filter((n) => n === "callState").length,
    );

  const before = reads();
  await flush();
  assert.deepEqual(reads(), before, "a flush alone ran a seat's timer");

  // The periodic reconcile is a per-session `setTimeout` chain: ONE tick of
  // the shared clock must run all three.
  await advance(t, RECONCILE_INTERVAL_MS);
  const after = reads();
  for (const [index, world] of fleet.seats.entries()) {
    assert.ok(
      after[index] > before[index],
      `${identityOf(world.me)}'s reconcile tick never fired`,
    );
  }
});

test("fleet: each page has its own startup-wipe token — one seat's reload does not spend another's", async (t) => {
  const channel = "ch-fleet-tokens";
  const fleet = newFleet(t, [SELF, PEER, THIRD], channel);
  await fleet.bringUp();
  await advance(t, REJOIN_SERVE_SUPPRESS_MS + 5_000);
  const peer = fleet.seat(PEER);
  const third = fleet.seat(THIRD);
  const thirdTokens = third.startupWipeTokens;
  // A joiner also leave-cleans the orphan its create minted, so read only
  // whether GROUP was wiped, from here on.
  const peerMark = peer.leaveCleanups.length;

  await fleet.reload(PEER);
  await advance(t, 1);
  assert.ok(
    peer.leaveCleanups.slice(peerMark).includes(GROUP),
    "PEER's startup wipe",
  );
  const peerTokens = peer.startupWipeTokens;
  await untilActive(t, fleet, PEER, 40_000);
  await advance(t, REJOIN_SERVE_SUPPRESS_MS + 5_000);

  // THIRD's page dies next. Its fresh page must wipe on its OWN token, as if
  // PEER's reload had never happened. (The behaviour is asserted before the
  // Sets, so a session that ignores its dep fails on the wipe it skipped.)
  assert.equal(third.leaveCleanups.includes(GROUP), false);
  const thirdMark = third.leaveCleanups.length;
  await fleet.reload(THIRD);
  await advance(t, 1);
  assert.ok(
    third.leaveCleanups.slice(thirdMark).includes(GROUP),
    "THIRD's startup wipe",
  );
  await untilActive(t, fleet, THIRD, 40_000);
  assertConverged(fleet, LEAF_ORDER);

  // Each page spent only its own token: a fresh Set per page, none shared.
  assert.notEqual(third.startupWipeTokens, thirdTokens, "a fresh Set per page");
  assert.ok(peerTokens.has(channel), "PEER spent its token");
  assert.ok(third.startupWipeTokens.has(channel), "THIRD spent its token");
  assert.equal(thirdTokens.has(channel), false, "THIRD's first page spent one");
  assert.equal(
    fleet.seat(SELF).startupWipeTokens.has(channel),
    false,
    "SELF never reloaded, so it spent nothing",
  );
});

// ---- The stagger proof -----------------------------------------------------

test("stagger: a wipe-rejoin is served by leaf 0 alone — the higher leaf's serve fires after it and stages NO Remove", async (t) => {
  const fleet = newFleet(t, [SELF, PEER, THIRD], "ch-fleet-stagger");
  await fleet.bringUp();
  // Past §4.8's window for the bring-up's own Adds, so neither server
  // refuses the rejoin at schedule time: both serves arm their stagger.
  await advance(t, REJOIN_SERVE_SUPPRESS_MS + 5_000);
  const warns = t.mock.method(console, "warn", () => {});
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;
  const marks = fleet.seats.map((w) => w.bridgeCalls.length);

  // PEER's page restarts: its startup wipe drops the group and it
  // re-intents while its stale leaf (leaf 1) is still in the roster, so the
  // DS flags the intent `rejoin` to every member. SELF (leaf 0) serves on a
  // 0 ms stagger; THIRD (leaf 2 when the serve is scheduled) on 4 s. PEER's
  // next intent comes `JOINER_RETRY_MS` (10 s) later, and is an ordinary
  // join that leaf 0 admits. Nothing below is placed by hand.
  //
  // The negative control for this spec is `JOINER_RETRY_MS` → 1 500 with the
  // fire-time §4.8 re-check in `#removeStaleLeaf` removed: PEER's re-intent
  // then lands its Add inside THIRD's 4 s stagger, and THIRD removes the live
  // leaf. The fleet's DS does not model join-intent slowmode, so it accepts
  // that 1.5 s re-intent where the real DS (5 s minimum interval) would
  // refuse it. That is fine for the control, whose job is only to put the
  // Add inside a higher leaf's stagger window — the defect class — and this
  // spec, at the real 10 s retry, never re-intents faster than slowmode.
  await fleet.wipeRejoin(PEER);
  await advance(t, 1);
  await untilActive(t, fleet, PEER, 40_000);
  await advance(t, 10_000); // every stagger and settle has run out

  // Leaf 0's Remove won, then an Add re-seated PEER — and nothing else was
  // submitted for the group: no second Remove from anyone.
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch + 1, "won"],
    [SELF_ID, "admit", epoch + 2, "won"],
  ]);
  const [removal, readd] = fleet.ds.log.filter((c) => c.epoch > epoch);
  assert.deepEqual(removal.removed.map(identityOf), [PEER_ID]);
  assert.deepEqual(readd.added.map(identityOf), [PEER_ID]);
  // PEER's own create lost to the open group; no successor was opened.
  assert.equal(fleet.ds.openGroup("ch-fleet-stagger"), GROUP);

  // Both servers got past the pin check and neither refused at schedule
  // time, so both staggers were armed; only leaf 0's reached a Remove.
  const third = fleet.seat(THIRD);
  const since = (index: number) =>
    fleet.seats[index].bridgeCalls.slice(marks[index]);
  assert.ok(since(0).includes("callVerifyJoinIntent"), "SELF never served");
  assert.ok(since(2).includes("callVerifyJoinIntent"), "THIRD never served");
  const warned = warns.mock.calls.map((c) => String(c.arguments[0]));
  assert.deepEqual(
    warned.filter((w) => w.startsWith("[mls] refusing a rejoin serve")),
    [],
  );
  assert.deepEqual(
    warned.filter((w) => w.startsWith("[mls] removing stale leaf")),
    [`[mls] removing stale leaf for rejoin: ${PEER.user_id}:${PEER.device_id}`],
    "exactly one member removed the stale leaf",
  );
  assert.deepEqual(
    since(2).filter((n) => n === "callRemove" || n === "mlsSubmitCommit"),
    [],
    "THIRD (the higher leaf) staged or submitted a commit",
  );
  assert.equal(third.stagedCommits.size, 0, "THIRD holds a staged commit");

  // PEER ends enrolled on every seat, at its old leaf.
  assertConverged(fleet, LEAF_ORDER);
});
