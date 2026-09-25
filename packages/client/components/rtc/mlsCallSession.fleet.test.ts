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
// The fifth is the stagger proof the one-seat world could not state. A
// wipe-rejoin is served by EVERY member, each on its own leaf stagger, so the
// member that must not act is a higher leaf whose serve fires after the
// rejoiner may already be back in. Here nothing is hand-placed: leaf 0's
// Remove, the rejoiner's re-intent, the Add that re-seats it and the higher
// leaf's serve all land when the real ladders put them.
//
// The rest pin the stagger KICK, a member removing the rejoiner it has just
// seen re-seated, and the guard that closes it (see "The stagger kick"
// below): in every phase of the members' reconcile ticks, and on every path
// that re-seats the rejoiner under a serve scheduled against its stale leaf,
// no member removes the re-seated leaf. The last pins the guard's other
// direction: a device that wipes again once its rejoin has settled is still
// served, and re-enrolled.
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

// ---- The stagger kick ------------------------------------------------------
//
// In a call of seven or more members, the member at leaf 6 serves a
// wipe-rejoin on a 12 s stagger, which outlasts the Add that re-seats the
// rejoiner (about 10.5 s at the real constants). Its fire-time §4.8 check
// reads add observations that a member which did not admit makes on its 5 s
// reconcile tick (or once its own admit stagger for the re-intent runs out,
// at leaf 6 later still), so in most phases of that tick it was blind: it
// found the FRESH leaf present and removed it, sending a live member round
// the re-enrol ladder again. The guard is commit order, not a clock: a serve
// refuses when its target was removed at an epoch after the one it was
// scheduled at.
//
// On the wave-1 session (`1fbab1e0`) every case below except the replay
// failed with the kick itself, a `remove` won against the re-seated PEER:
// the phase sweep in 14 of its 20 phases, the others in their pinned phase.
// The replay was already refused there, by the §4.8 block the guard does
// not replace, and it pins that block.

/** The per-leaf admit and serve stagger (`ADMIT_STAGGER_MS`, private). */
const ADMIT_STAGGER_MS = 2_000;
/** `JOINER_RETRY_MS` (private): a joiner's next intent after an unanswered one. */
const JOINER_RETRY_MS = 10_000;
/** Enough members for a leaf 6 (the first seven seats) and a leaf 7 (all eight). */
const MORE: Identity[] = ["dave", "erin", "frank", "grace", "heidi"].map(
  (user) => ({ user_id: user, device_id: `dev-${user}` }),
);
const SEVEN: Identity[] = [SELF, PEER, THIRD, ...MORE.slice(0, 4)];
const EIGHT: Identity[] = [SELF, PEER, THIRD, ...MORE];
/** Past §4.8's window for the bring-up's own Adds: every serve arms. */
const SETTLE_MS = REJOIN_SERVE_SUPPRESS_MS + 5_000;
/**
 * Every phase of the members' reconcile ticks against the wipe: one whole
 * `RECONCILE_INTERVAL_MS`, in 250 ms steps (20 phases).
 */
const PHASES_MS = Array.from(
  { length: RECONCILE_INTERVAL_MS / 250 },
  (_, index) => index * 250,
);
/**
 * A phase in which the wave-1 session kicked the re-seated PEER in every
 * case pinned to it. Its sweep of those cases over the 20 phases: seven
 * seats kicked in 14 (with or without the SFU blip), eight seats in 14 (leaf
 * 7 too in 8 of them, this one among them), and the in-flight and locked
 * cases in all 20.
 */
const KICK_PHASE_MS = 0;
/**
 * A phase in which the wave-1 session did NOT kick a seven-seat call in the
 * first round (it did not from 3 250 to 4 500 ms), so a case pinned to it
 * is about what happens after the re-add alone.
 */
const QUIET_PHASE_MS = 3_500;
/** What a serve logs as it goes to stage the Remove (`#removeStaleLeaf`). */
const REMOVING_PEER = `[mls] removing stale leaf for rejoin: ${PEER_ID}`;
/** What the guard logs as it refuses a serve (`#removeStaleLeaf`). */
const TARGET_FRESH = "[mls] serve target was removed after scheduling";
/** What the schedule-time §4.8 check logs as it refuses a serve. */
const REFUSING = "[mls] refusing a rejoin serve";

/** A PEER wipe-rejoin on a fleet that is up and settled, and what it logged. */
interface RejoinRun {
  fleet: Fleet;
  leafOrder: string[];
  /** The DS epoch before the wipe: the Remove is `epoch + 1`, the re-add `+ 2`. */
  epoch: number;
  /** `Date.now()` as the wipe started. */
  start: number;
  /** The group's arbitrated submits since the wipe. */
  submits(): [string, string, number, string][];
  /** Seat `index`'s bridge calls since the wipe. */
  since(index: number): string[];
  /** Each `console.warn` since the wipe whose first argument starts `prefix`. */
  warned(prefix: string): string[];
  /** The same, for `console.info`. */
  informed(prefix: string): string[];
  /** Every Remove of PEER that won AFTER a commit re-seated it: the kick. */
  kicks(): string[];
}

/**
 * Bring `seats` up, settle `SETTLE_MS + phaseMs`, open whatever hold the case
 * needs before PEER's first intent (`beforeWipe`), and wipe-rejoin PEER.
 */
async function wipeRejoinPeer(
  t: TestContext,
  seats: readonly Identity[],
  channelId: string,
  phaseMs: number,
  beforeWipe?: (fleet: Fleet) => void,
): Promise<RejoinRun> {
  const fleet = newFleet(t, seats, channelId);
  await fleet.bringUp();
  await advance(t, SETTLE_MS + phaseMs);
  const warns: string[] = [];
  const infos: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => {
    warns.push(String(args[0]));
  });
  t.mock.method(console, "info", (...args: unknown[]) => {
    infos.push(String(args[0]));
  });
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;
  const marks = fleet.seats.map((w) => w.bridgeCalls.length);
  beforeWipe?.(fleet);
  const start = Date.now();
  await fleet.wipeRejoin(PEER);
  await advance(t, 1);
  return {
    fleet,
    leafOrder: seats.map(identityOf),
    epoch,
    start,
    submits: () => groupSubmits(fleet, from),
    since: (index) => fleet.seats[index].bridgeCalls.slice(marks[index]),
    warned: (prefix) => warns.filter((w) => w.startsWith(prefix)),
    informed: (prefix) => infos.filter((i) => i.startsWith(prefix)),
    kicks: () => {
      // Read from the DS's own log, so it names the kicker whoever it was.
      const kicks: string[] = [];
      let reseated = false;
      for (const s of fleet.ds.submits.slice(from)) {
        if (s.groupId !== GROUP || s.outcome !== "won") continue;
        const commit = fleet.ds.commitAt(GROUP, s.epoch);
        if (!commit) continue; // a create: nothing logged
        const hits = (list: Identity[]) =>
          list.some((m) => identityOf(m) === PEER_ID);
        if (reseated && hits(commit.removed)) {
          kicks.push(`${s.seat} removed ${PEER_ID} at epoch ${s.epoch}`);
        }
        if (hits(commit.added)) reseated = true;
      }
      return kicks;
    },
  };
}

/** Advance until `atMs` after the wipe started. */
async function afterWipe(
  t: TestContext,
  run: RejoinRun,
  atMs: number,
): Promise<void> {
  while (Date.now() < run.start + atMs) await advance(t, 250);
}

/** Bridge calls named `name` in `calls`. */
const count = (calls: string[], name: string) =>
  calls.filter((n) => n === name).length;

/**
 * Just before the first of `leaves` fires its serve: PEER is already back in
 * (the Add landed first), and each of those seats armed its serve and has
 * not acted on it. The kick is checked first: a kick moves the DS past the
 * re-add's epoch, and must be named as a kick, not as a missing re-add.
 */
function assertReseatedBefore(run: RejoinRun, leaves: number[]): void {
  assert.deepEqual(run.kicks(), [], "a member removed the re-seated PEER");
  assert.equal(
    run.fleet.ds.epoch,
    run.epoch + 2,
    `PEER's re-add had not landed (DS epoch ${run.fleet.ds.epoch}, ` +
      `re-add at ${run.epoch + 2})`,
  );
  assert.deepEqual(run.fleet.ds.members.map(identityOf), run.leafOrder);
  for (const leaf of leaves) {
    const id = identityOf(run.fleet.seats[leaf].me);
    assert.ok(
      run.since(leaf).includes("callVerifyJoinIntent"),
      `${id} (leaf ${leaf}) never armed its serve`,
    );
    assert.equal(
      count(run.since(leaf), "callRemove"),
      0,
      `${id} (leaf ${leaf}) served before its stagger ran out`,
    );
  }
}

/**
 * The verdict, the kick FIRST so a failure names the kicker: no Remove of
 * the re-seated PEER won, the group's submits are exactly `expected`, no seat
 * but `stagers` ever staged a Remove, nothing is left staged, and PEER ends
 * enrolled on every seat at its old leaf.
 */
function assertNoKick(
  run: RejoinRun,
  expected: [string, string, number, string][],
  stagers: number[],
): void {
  assert.deepEqual(run.kicks(), [], "a member removed the re-seated PEER");
  assert.deepEqual(run.submits(), expected);
  for (const [index, world] of run.fleet.seats.entries()) {
    const id = identityOf(world.me);
    if (!stagers.includes(index)) {
      assert.equal(
        count(run.since(index), "callRemove"),
        0,
        `${id} staged a Remove`,
      );
    }
    assert.equal(world.stagedCommits.size, 0, `${id} holds a staged commit`);
  }
  assertConverged(run.fleet, run.leafOrder);
}

/** Leaf 0's Remove won, then its Add re-seated PEER: the whole story. */
const servedByLeafZero = (
  run: RejoinRun,
): [string, string, number, string][] => [
  [SELF_ID, "remove", run.epoch + 1, "won"],
  [SELF_ID, "admit", run.epoch + 2, "won"],
];

for (const phaseMs of PHASES_MS) {
  test(`stagger kick, phase +${phaseMs} ms: in a seven-member call, leaf 6's serve fires AFTER the re-add and stages NO Remove against the re-seated leaf`, async (t) => {
    const run = await wipeRejoinPeer(t, SEVEN, `ch-kick-${phaseMs}`, phaseMs);

    // The wipe-rejoin of the stagger proof, at the REAL constants and with
    // nothing placed by hand. Leaf 6's serve is armed on a 12 s stagger, and
    // PEER's plain re-intent comes `JOINER_RETRY_MS` (10 s) after its first,
    // so the Add that re-seats it lands BEFORE that serve fires; the
    // schedule-time §4.8 check could not refuse it (the Add had not
    // happened), and the fire-time roster check finds PEER present again.
    // Whether leaf 6's own reconcile tick has observed the Add by then
    // depends on the phase; the guard must not.
    const fireAt = 6 * ADMIT_STAGGER_MS;
    assert.ok(fireAt > JOINER_RETRY_MS, "leaf 6 fires after the retry");
    await afterWipe(t, run, fireAt - 250);
    assertReseatedBefore(run, [6]);

    await untilActive(t, run.fleet, PEER, 40_000);
    await advance(t, 20_000); // leaf 6's serve and every settle have run out
    assertNoKick(run, servedByLeafZero(run), [0]);
    assert.deepEqual(
      run.warned("[mls] removing stale leaf"),
      [REMOVING_PEER],
      "exactly one member removed the stale leaf",
    );
  });
}

test("stagger kick: in an eight-member call, neither leaf 6 nor leaf 7 stages a Remove against the re-seated leaf", async (t) => {
  const run = await wipeRejoinPeer(t, EIGHT, "ch-kick-eight", KICK_PHASE_MS);

  // Two serves now fire after the re-add, at 12 s and 14 s. In this phase
  // the wave-1 session kicked PEER from BOTH (leaf 7 once PEER was back
  // from leaf 6's kick), so neither may be left to the phase.
  await afterWipe(t, run, 6 * ADMIT_STAGGER_MS - 250);
  assertReseatedBefore(run, [6, 7]);

  await untilActive(t, run.fleet, PEER, 40_000);
  await advance(t, 20_000); // leaf 7's serve and every settle have run out
  assertNoKick(run, servedByLeafZero(run), [0]);
  assert.deepEqual(
    run.warned("[mls] removing stale leaf"),
    [REMOVING_PEER],
    "exactly one member removed the stale leaf",
  );
  assert.ok(
    run.informed(TARGET_FRESH).length > 0,
    "no serve was refused by the Remove's epoch",
  );
});

test("stagger kick: leaf 6 watching PEER leave and rejoin the SFU between its Remove and its re-add still stages NO Remove", async (t) => {
  const run = await wipeRejoinPeer(t, SEVEN, "ch-kick-blip", KICK_PHASE_MS);
  const leaf6 = run.fleet.seats[6];

  // Between the Remove and the re-add, on the seat whose serve is still
  // armed: it has applied the Remove, and nothing has put PEER back.
  await afterWipe(t, run, JOINER_RETRY_MS / 2);
  assert.equal(run.fleet.ds.epoch, run.epoch + 1, "not between the two");
  assert.equal(leaf6.localEpoch, run.epoch + 1, "leaf 6 missed the Remove");
  assert.ok(
    !leaf6.localRoster.some((m) => identityOf(m) === PEER_ID),
    "leaf 6 still holds PEER's leaf",
  );
  // PEER's connection blips as leaf 6 sees it. The Room is left as it is:
  // what matters is what the two hooks forget. The Remove leaf 6 applied is
  // a fact about the group, not about the connection, and its serve must
  // still see it when it fires.
  leaf6.session.onParticipantLeft(PEER_ID);
  await flush();
  leaf6.session.onParticipantJoined(PEER_ID);
  await flush();

  await afterWipe(t, run, 6 * ADMIT_STAGGER_MS - 250);
  assertReseatedBefore(run, [6]);

  await untilActive(t, run.fleet, PEER, 40_000);
  await advance(t, 20_000); // leaf 6's serve and every settle have run out
  assertNoKick(run, servedByLeafZero(run), [0]);
  assert.deepEqual(
    run.warned("[mls] removing stale leaf"),
    [REMOVING_PEER],
    "exactly one member removed the stale leaf",
  );
  assert.ok(
    run.informed(TARGET_FRESH).length > 0,
    "no serve was refused by the Remove's epoch",
  );
});

test("stagger kick: a second rejoin intent while a member's own Remove is in flight arms a second serve, which stages NO Remove after the re-add", async (t) => {
  let releaseSelf!: () => void;
  let releaseThird!: () => void;
  const seats = [SELF, PEER, THIRD];
  const run = await wipeRejoinPeer(
    t,
    seats,
    "ch-kick-in-flight",
    KICK_PHASE_MS,
    (fleet) => {
      // Leaf 0's serve waits on its listing fetch, so THIRD (leaf 2) is the
      // member whose Remove wins; and the DS is slow to answer THIRD's
      // submit, which keeps that Remove in flight (well inside the
      // session's `SUBMIT_TIMEOUT_MS`).
      releaseSelf = fleet.seat(SELF).holdReconcileRoster();
      releaseThird = fleet.seat(THIRD).holdSubmit();
    },
  );
  const { fleet, epoch } = run;
  const third = fleet.seat(THIRD);

  // THIRD's serve fired at 4 s, staged the Remove, and is waiting on the DS.
  const intentAt = 7_250;
  await afterWipe(t, run, intentAt);
  assert.equal(fleet.ds.epoch, epoch, "a Remove reached the DS");
  assert.equal(
    count(run.since(2), "mlsSubmitCommit"),
    1,
    "THIRD never submitted",
  );
  const staged = third.stagedCommits.get(GROUP);
  assert.ok(staged && staged !== "left", "THIRD holds no staged Remove");
  assert.equal(staged.epoch, epoch + 1);
  assert.deepEqual((staged.removed ?? []).map(identityOf), [PEER_ID]);

  // PEER's device sends its intent again. THIRD's serve timer has fired, so
  // its dedup key is gone, and the DS still holds PEER's stale leaf (THIRD's
  // Remove has not reached it), so the DS flags this one `rejoin` too: THIRD
  // arms a SECOND serve, anchored at the epoch before its own Remove.
  // It is sent through the DS here, at 7.25 s, rather than left to PEER's
  // ladder, whose next intent is not due until 10 s: the case needs it to
  // land while THIRD's own Remove is still in flight (the DS answers at
  // 8.5 s). Its payload is byte-for-byte what the ladder sends.
  const answer = fleet.ds.joinIntent(fleet.seat(PEER), GROUP, {
    device_id: PEER.device_id,
    key_package_ref: `kp-ref-${PEER.device_id}`,
    signature: `sig-${PEER.device_id}`,
  });
  assert.equal(answer.kind, "ok");
  await flush();
  assert.equal(
    count(run.since(2), "callVerifyJoinIntent"),
    2,
    "THIRD never served the second intent",
  );
  assert.deepEqual(run.warned(REFUSING), [], "THIRD refused at schedule time");

  // The DS answers: THIRD's own Remove wins. It never comes back to THIRD
  // inbound (a committer is not sent its own commit), so THIRD knows it was
  // removed only from its own won submit. Then leaf 0's listing arrives, and
  // its serve finds the leaf already gone.
  await afterWipe(t, run, 8_500);
  releaseThird();
  await flush();
  assert.deepEqual(run.submits(), [[THIRD_ID, "remove", epoch + 1, "won"]]);
  await advance(t, 250);
  releaseSelf();
  await flush();

  // Just before the second serve fires (THIRD's 4 s stagger after the
  // second intent): PEER's plain re-intent has had it re-seated by leaf 0.
  await afterWipe(t, run, intentAt + 2 * ADMIT_STAGGER_MS - 250);
  assert.equal(fleet.ds.epoch, epoch + 2, "PEER's re-add had not landed");
  assert.equal(count(run.since(2), "callRemove"), 1, "THIRD served early");

  await untilActive(t, fleet, PEER, 40_000);
  await advance(t, 20_000); // the second serve and every settle have run out
  assertNoKick(
    run,
    [
      [THIRD_ID, "remove", epoch + 1, "won"],
      [SELF_ID, "admit", epoch + 2, "won"],
    ],
    [2],
  );
  assert.equal(
    count(run.since(2), "callRemove"),
    1,
    "THIRD's second serve reached native",
  );
  assert.deepEqual(
    run.warned("[mls] removing stale leaf"),
    [REMOVING_PEER],
    "THIRD's second serve got past every check made outside the lock",
  );
  assert.ok(
    run.informed(TARGET_FRESH).length > 0,
    "no serve was refused by the Remove's epoch",
  );
});

test("stagger kick: a stale rejoin intent sent AFTER the re-add is refused by §4.8, and no member removes the re-seated leaf", async (t) => {
  const run = await wipeRejoinPeer(t, SEVEN, "ch-kick-replay", QUIET_PHASE_MS);
  const { fleet, epoch } = run;

  // Every seat has applied the re-add.
  for (
    let waited = 0;
    fleet.seats.some((w) => w.localEpoch !== epoch + 2) && waited < 20_000;
    waited += 250
  ) {
    await advance(t, 250);
  }
  for (const world of fleet.seats) {
    assert.equal(
      world.localEpoch,
      epoch + 2,
      `${identityOf(world.me)} never applied the re-add`,
    );
  }
  const marks = fleet.seats.map((w) => w.bridgeCalls.length);
  const refusedBefore = run.warned(REFUSING).length;

  // PEER's device sends a rejoin intent it no longer needs (a stale
  // re-broadcast), and PEER's leaf is in the roster, so the DS flags it
  // `rejoin`. A serve scheduled now anchors AFTER the Remove, so the
  // Remove's epoch cannot refuse it: only §4.8's add observations can —
  // leaf 0's (it admitted) at schedule time, every other member's by the
  // time its stagger runs out.
  const answer = fleet.ds.joinIntent(fleet.seat(PEER), GROUP, {
    device_id: PEER.device_id,
    key_package_ref: `kp-ref-${PEER.device_id}`,
    signature: `sig-${PEER.device_id}`,
  });
  assert.equal(answer.kind, "ok");
  await flush();
  const served = fleet.seats.filter((w, index) =>
    w.bridgeCalls.slice(marks[index]).includes("callVerifyJoinIntent"),
  ).length;
  const refused = run.warned(REFUSING).length - refusedBefore;
  assert.ok(refused > 0, "leaf 0 served a leaf it had just added");
  assert.ok(
    refused < served,
    "every member refused at schedule time: no serve reached its fire time",
  );

  await advance(t, 6 * ADMIT_STAGGER_MS + 10_000); // every stagger has run out
  assertNoKick(run, servedByLeafZero(run), [0]);
  assert.deepEqual(
    run.warned("[mls] removing stale leaf"),
    [REMOVING_PEER],
    "exactly one member removed the stale leaf",
  );
});

test("stagger kick: a serve that fires while its own drain holds the lock on the Remove and the re-add refuses UNDER the lock", async (t) => {
  let release!: () => void;
  const run = await wipeRejoinPeer(
    t,
    SEVEN,
    "ch-kick-locked",
    KICK_PHASE_MS,
    // Leaf 6's native store is slow: every envelope its drain processes
    // waits, holding the per-group lock, from before the Remove arrives.
    (fleet) => (release = fleet.seats[6].holdProcessEnvelope()),
  );
  const { fleet, epoch } = run;
  const leaf6 = fleet.seats[6];

  // Leaf 6's serve has fired. Nothing it could read outside the lock showed
  // the Remove (its store has applied nothing yet), so it got past every
  // check made there and is waiting for the lock — behind the drain that is
  // about to apply the Remove AND the re-add. A serve warns that it is
  // removing only once it is through the check under the lock, so the one
  // warning so far should be leaf 0's. (What is read here is asserted after
  // the verdict, so a kick is still named as one.)
  await afterWipe(t, run, 6 * ADMIT_STAGGER_MS + 500);
  assert.equal(fleet.ds.epoch, epoch + 2, "PEER's re-add had not landed");
  assert.equal(leaf6.localEpoch, epoch, "leaf 6 applied a commit");
  assert.equal(count(run.since(6), "callRemove"), 0, "leaf 6 staged early");
  const warnedAtFire = run.warned("[mls] removing stale leaf");
  const refusedAtFire = run.informed(TARGET_FRESH).length;

  // The store catches up. Only a check made under the lock, after the drain
  // applied both, can see that the leaf now present is the re-added one.
  // The clock does not move here, so no serve can fire: a refusal logged now
  // is leaf 6's serve, the one waiting for the lock.
  release();
  await flush();
  const refusedAtRelease = run.informed(TARGET_FRESH).length;
  await untilActive(t, fleet, PEER, 40_000);
  await advance(t, 20_000); // every settle has run out
  assertNoKick(run, servedByLeafZero(run), [0]);
  assert.deepEqual(
    warnedAtFire,
    [REMOVING_PEER],
    "a serve warned before the check under the lock",
  );
  assert.equal(
    refusedAtRelease,
    refusedAtFire + 1,
    "leaf 6's serve was not refused under the lock",
  );
  // The refused serve logged no removing warning: the one there is leaf 0's,
  // the only seat that staged a Remove.
  assert.deepEqual(
    run.warned("[mls] removing stale leaf"),
    [REMOVING_PEER],
    "leaf 6's refused serve warned that it was removing",
  );
});

// ---- No lockout ------------------------------------------------------------
//
// The guard's other direction. What it reads, the epoch of a Remove, is never
// forgotten within a group: every member still holds PEER's first Remove
// long after PEER is back in. A serve for a LATER genuine wipe is anchored
// at the epoch the member reads as it arms it, after that Remove, so the old
// Remove cannot refuse it. Anchored any earlier (at 0, say), every serve of
// every later wipe of the device would be refused, its stale leaf never
// removed, and the device never re-enrolled: locked out of the call's
// encryption for good.

test("no lockout: after a settled rejoin, PEER's next wipe-rejoin is served by leaf 6 and PEER is re-enrolled on every seat", async (t) => {
  const run = await wipeRejoinPeer(t, SEVEN, "ch-no-lockout", KICK_PHASE_MS);
  const { fleet } = run;
  const leaf6 = fleet.seats[6];
  const leaf6Id = identityOf(leaf6.me);

  // The first wipe-rejoin, as the sweep's: leaf 0 removes and re-adds PEER,
  // and the higher leaves' serves are refused, leaf 6's after the re-add.
  // Each member now holds that Remove's epoch for PEER.
  await untilActive(t, fleet, PEER, 40_000);
  await advance(t, 20_000); // leaf 6's serve and every settle have run out
  assertNoKick(run, servedByLeafZero(run), [0]);
  assert.ok(
    run.informed(TARGET_FRESH).length > 0,
    "no serve was refused by the Remove's epoch",
  );

  // Settled: across a further window (past §4.8's for the re-add, too) no
  // seat serves or stages anything, and none reads anyone as non-enrolled.
  const quiet = fleet.seats.map((w) => w.bridgeCalls.length);
  await advance(t, SETTLE_MS);
  for (const [index, world] of fleet.seats.entries()) {
    const id = identityOf(world.me);
    const calls = world.bridgeCalls.slice(quiet[index]);
    assert.equal(count(calls, "callVerifyJoinIntent"), 0, `${id} served`);
    assert.equal(count(calls, "callRemove"), 0, `${id} staged a Remove`);
    assert.deepEqual(world.session.nonEnrolled(), [], `${id}'s non-enrolled`);
  }
  assertConverged(fleet, run.leafOrder);

  // PEER's page restarts again. Every member below leaf 6 is slow to fetch
  // PEER's listing, so each of their serves waits before it can arm, and
  // leaf 6's, on its 12 s stagger, is the one that must remove the stale
  // leaf. PEER's plain re-intent at 10 s finds that leaf still present, so
  // the DS flags it `rejoin` too, and every member already holds a serve.
  const from = fleet.ds.submits.length;
  const epoch = fleet.ds.epoch;
  const marks = fleet.seats.map((w) => w.bridgeCalls.length);
  const since = (index: number) =>
    fleet.seats[index].bridgeCalls.slice(marks[index]);
  const held = [0, 2, 3, 4, 5];
  const releases = held.map((index) =>
    fleet.seats[index].holdReconcileRoster(),
  );
  const start = Date.now();
  await fleet.wipeRejoin(PEER);
  await advance(t, 1);

  // Just before leaf 6's serve fires: nothing has touched the stale leaf,
  // leaf 6 has armed its serve, and no held member has.
  const fireAt = 6 * ADMIT_STAGGER_MS;
  while (Date.now() < start + fireAt - 250) await advance(t, 250);
  assert.equal(fleet.ds.epoch, epoch, "a commit landed before leaf 6 served");
  assert.ok(
    since(6).includes("callVerifyJoinIntent"),
    `${leaf6Id} (leaf 6) never armed its serve`,
  );
  for (const index of held) {
    assert.equal(
      count(since(index), "callVerifyJoinIntent"),
      0,
      `leaf ${index} armed a serve past its held listing fetch`,
    );
  }

  // Leaf 6's serve fires; then the listings arrive, and the held serves find
  // the leaf already gone. PEER's next plain intent is admitted.
  while (Date.now() < start + fireAt + 1_000) await advance(t, 250);
  for (const release of releases) release();
  await flush();
  const peer = fleet.seat(PEER);
  for (
    let waited = 0;
    (peer.session.state() !== "active" || fleet.ds.epoch < epoch + 2) &&
    waited < 60_000;
    waited += 250
  ) {
    await advance(t, 250);
  }

  // The verdict, the lockout FIRST: a second Remove of PEER won.
  const removals = fleet.ds.submits
    .slice(from)
    .filter(
      (s) =>
        s.groupId === GROUP &&
        s.outcome === "won" &&
        (fleet.ds.commitAt(GROUP, s.epoch)?.removed ?? []).some(
          (m) => identityOf(m) === PEER_ID,
        ),
    );
  assert.notEqual(
    removals.length,
    0,
    `PEER is locked out: no member removed its second stale leaf, so it ` +
      `was never re-enrolled (its session is ${peer.session.state()})`,
  );
  await advance(t, 20_000); // every settle has run out
  assert.deepEqual(groupSubmits(fleet, from), [
    [leaf6Id, "remove", epoch + 1, "won"],
    [SELF_ID, "admit", epoch + 2, "won"],
  ]);
  assert.deepEqual(
    fleet.seats.map((_, index) => count(since(index), "callRemove")),
    [0, 0, 0, 0, 0, 0, 1],
    "only leaf 6 staged a Remove",
  );
  for (const world of fleet.seats) {
    const id = identityOf(world.me);
    assert.equal(world.stagedCommits.size, 0, `${id} holds a staged commit`);
  }
  assertConverged(fleet, run.leafOrder);
});
