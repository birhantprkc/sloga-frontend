// Session-level specs for the checks a rejoin serve makes UNDER the lock, in
// the Remove's `build` (`#removeStaleLeaf`), on the fleet and the one-seat
// world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.serveguard.test.ts
//
// A serve that has fired gets past every check made outside the lock and
// then waits for it, and anything can happen to the group while it waits.
// Three checks run once it holds the lock, immediately before `callRemove`,
// and each case below is one that only its own check refuses:
//   - the target's Remove was applied while it waited (the Remove's epoch);
//   - the session re-entered the SAME group while it waited (the establish
//     generation: the reset cleared the facts that epoch is compared with);
//   - the session was reset and has not re-established yet (the group:
//     `#groupId` has moved, the generation has not).
// A refused serve removes nothing, so it must also note nothing: no
// served-rejoin observation (`#noteRejoinServed`, which extends the target's
// admit-grace) and no "removing stale leaf" warning.
//
// Before it fires, a serve reads the roster (`callState`) to find the target
// and its own leaf, and the group can change under that read too (W15R-m1).
// Every such change reset the group's maps, so the dedup key and the retry
// ledger the serve would write when the read settles now belong to the live
// group, where the same key can be a newer serve's. The last cases hold that
// read across each change, answered and thrown, and check that a live-group
// serve reserved (re-entry) or ledgered (reset) for the same device in the
// meantime keeps its entry.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsCallState } from "@revolt/client";

import {
  type Identity,
  type World,
  advance,
  bringUpJoiner,
  flush,
  GROUP,
  groupNotFound,
  newFleet,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
  THIRD,
} from "./mlsCallSession.harness.ts";
import type { MlsMediaBinding } from "./mlsCallSession.ts";
import { REJOIN_SERVE_SUPPRESS_MS } from "./mlsRejoinPolicy.ts";

// After the harness, which installs the resolver the session module needs.
const { MlsCallSession } = await import("./mlsCallSession.ts");
type Session = InstanceType<typeof MlsCallSession>;

// The served-rejoin probe reads the stack; the default 10 frames can stop
// short of `#removeStaleLeaf`.
Error.stackTraceLimit = 100;

/** The per-leaf admit and serve stagger (`ADMIT_STAGGER_MS`, private). */
const ADMIT_STAGGER_MS = 2_000;
/** Enough members for a leaf 6, whose serve fires after the re-add. */
const SEVEN: Identity[] = [
  SELF,
  PEER,
  THIRD,
  ...["dave", "erin", "frank", "grace"].map((user) => ({
    user_id: user,
    device_id: `dev-${user}`,
  })),
];
/** Past §4.8's window for the bring-up's own Adds: every serve arms. */
const SETTLE_MS = REJOIN_SERVE_SUPPRESS_MS + 5_000;
/** What a serve logs as it goes to stage the Remove. */
const REMOVING = "[mls] removing stale leaf";
const REMOVING_PEER = `${REMOVING} for rejoin: ${PEER_ID}`;
/** What each check under the lock logs as it refuses a serve. */
const TARGET_FRESH = "[mls] serve target was removed after scheduling";
const EARLIER_ESTABLISH = "[mls] serve was scheduled for an earlier establish";
const ANOTHER_GROUP = "[mls] serve was scheduled for another group";
/** What a serve logs when its roster read outlived the group it was for. */
const OUTLIVED_READ = "[mls] rejoin serve outlived its group during the read";
/** The retry ledger's re-drive tick (`ADMIT_RETRY_MS`, private). */
const ADMIT_RETRY_MS = 5_000;
/** The attempt number in each "retry n/max" warning for PEER's rejoin serve. */
const PEER_RETRY = new RegExp(
  `^\\[mls\\] admit of rejoin:${PEER_ID} aborted \\(\\w+\\), retry (\\d+)/`,
);

/** Bridge calls named `name` in `calls`. */
const count = (calls: string[], name: string) =>
  calls.filter((n) => n === name).length;

/** The first argument of every `console[level]` call, from here on. */
function logged(t: TestContext, level: "info" | "warn"): () => string[] {
  const method = t.mock.method(console, level);
  return () => method.mock.calls.map((call) => String(call.arguments[0]));
}

/**
 * Per session, every `#noteRejoinServed` reached from a serve. Read through
 * the media binding: a served-rejoin observation first arms the target's
 * admit-grace, whose first act is `media.localIdentity()`, so a wrapped
 * `localIdentity` sees each one with its stack. Installed before the seats
 * boot, since each binds its media as it does.
 */
function servedObservations(t: TestContext): Map<Session, number> {
  const seen = new Map<Session, number>();
  const bindMedia = MlsCallSession.prototype.bindMedia;
  t.mock.method(
    MlsCallSession.prototype,
    "bindMedia",
    function (this: Session, media: MlsMediaBinding) {
      return bindMedia.call(this, {
        ...media,
        localIdentity: () => {
          const stack = new Error().stack ?? "";
          if (
            stack.includes("noteRejoinServed") &&
            stack.includes("removeStaleLeaf")
          ) {
            seen.set(this, (seen.get(this) ?? 0) + 1);
          }
          return media.localIdentity();
        },
      });
    },
  );
  return seen;
}

/** How a held roster read ends. */
type ReadOutcome = "answers" | "throws";

/**
 * Hold the first roster read a rejoin serve makes: `world.callState` called
 * from `#serveRejoin`, found on the stack as the served-rejoin probe finds
 * `#removeStaleLeaf`. Every other read answers at once. `settle` ends the
 * held one with the state it read when it was made (SELF and the target both
 * present), or rejects it as native does for a group it does not hold.
 */
function holdServeRead(t: TestContext, world: World) {
  const read = world.callState;
  let held: {
    state: MlsCallState;
    resolve: (state: MlsCallState) => void;
    reject: (error: unknown) => void;
  } | null = null;
  t.mock.method(world, "callState", function (this: World) {
    const state = read.call(this);
    if (held || !(new Error().stack ?? "").includes("serveRejoin")) {
      return state;
    }
    // The bridge stub is `async () => world.callState()`, so the read waits
    // on the promise returned here.
    return new Promise<MlsCallState>((resolve, reject) => {
      held = { state, resolve, reject };
    }) as unknown as MlsCallState;
  });
  return {
    held: () => held !== null,
    settle(outcome: ReadOutcome) {
      assert.ok(held, "no serve read the roster");
      if (outcome === "answers") held.resolve(held.state);
      else held.reject(groupNotFound(GROUP));
    },
  };
}

/** The attempt number of each "retry n/max" warning for PEER's rejoin serve. */
const peerRetries = (warned: () => string[]) =>
  warned().flatMap((line) => {
    const match = PEER_RETRY.exec(line);
    return match ? [Number(match[1])] : [];
  });

test("serve guard: a serve refused by the Remove's epoch under the lock notes no served rejoin and warns no removal", async (t) => {
  const served = servedObservations(t);
  const fleet = newFleet(t, SEVEN, "ch-serveguard-locked");
  await fleet.bringUp();
  await advance(t, SETTLE_MS);
  const warned = logged(t, "warn");
  const informed = logged(t, "info");
  const epoch = fleet.ds.epoch;
  const leaf0 = fleet.seats[0];
  const leaf6 = fleet.seats[6];
  const mark6 = leaf6.bridgeCalls.length;
  const since6 = () => leaf6.bridgeCalls.slice(mark6);

  // Leaf 6's native store is slow: every envelope its drain processes waits,
  // holding the per-group lock, from before the Remove arrives.
  const release = leaf6.holdProcessEnvelope();
  const start = Date.now();
  await fleet.wipeRejoin(PEER);
  await advance(t, 1);
  while (Date.now() < start + 6 * ADMIT_STAGGER_MS + 500) {
    await advance(t, 250);
  }

  // Leaf 6's serve has fired. Its store has applied nothing, so it got past
  // every check made outside the lock and is waiting for it, behind the
  // drain that is about to apply the Remove AND the re-add.
  assert.equal(fleet.ds.epoch, epoch + 2, "PEER's re-add had not landed");
  assert.equal(leaf6.localEpoch, epoch, "leaf 6 applied a commit");
  assert.equal(count(since6(), "callRemove"), 0, "leaf 6 staged early");
  // The probe is not blind: leaf 0's serve, which did stage, was seen.
  assert.ok(
    (served.get(leaf0.session) ?? 0) > 0,
    "the probe never saw leaf 0's served-rejoin observation",
  );
  const refused = () =>
    informed().filter((line) => line.startsWith(TARGET_FRESH)).length;
  const refusedAtFire = refused();

  // The store catches up. The clock does not move here, so no serve can
  // fire: a refusal logged now is leaf 6's, the one waiting for the lock.
  release();
  await flush();
  const refusedAtRelease = refused();
  const peer = fleet.seat(PEER);
  for (
    let waited = 0;
    peer.session.state() !== "active" && waited < 40_000;
    waited += 250
  ) {
    await advance(t, 250);
  }
  assert.equal(peer.session.state(), "active", "PEER never re-joined");
  await advance(t, 20_000); // every settle has run out

  assert.equal(count(since6(), "callRemove"), 0, "leaf 6 staged a Remove");
  assert.equal(
    refusedAtRelease,
    refusedAtFire + 1,
    "leaf 6's serve was not refused by the Remove's epoch under the lock",
  );
  assert.equal(
    served.get(leaf6.session) ?? 0,
    0,
    "leaf 6's refused serve noted a served rejoin (admit-grace extended)",
  );
  assert.deepEqual(
    warned().filter((line) => line.startsWith(REMOVING)),
    [REMOVING_PEER],
    "a warning other than leaf 0's one removal",
  );
});

test("serve guard: a serve waiting on the lock across a removed_self re-entry into the SAME group refuses on the establish generation", async (t) => {
  const world = newWorld(t, "joiner", "ch-serveguard-reentry");
  await bringUpJoiner(t, world, 0);
  await advance(t, SETTLE_MS);
  const warned = logged(t, "warn");
  const informed = logged(t, "info");
  const mark = world.bridgeCalls.length;
  const since = () => world.bridgeCalls.slice(mark);
  const intentsBefore = count(world.bridgeCalls, "mlsJoinIntent");

  // The drain takes the lock on the commit that removed SELF, and waits.
  const releaseRemoval = world.holdProcessEnvelope();
  await world.removedSelf(1);
  // PEER's rejoin intent. SELF is leaf 0, so the serve fires at once, gets
  // past every check made outside the lock and waits for it.
  await world.joinRequest(PEER, { rejoin: true });
  await advance(t, 1);
  await flush();
  assert.ok(since().includes("callState"), "the serve never read state");
  assert.equal(count(since(), "callRemove"), 0, "the serve staged early");
  // The re-add's Welcome, queued behind the removal in the same drain.
  await world.welcome(2);
  // Let the removal through and hold the Welcome: the drain keeps the lock.
  releaseRemoval();
  const releaseWelcome = world.holdProcessEnvelope();
  await flush();
  // The removed_self action re-enters: a new establish joins GROUP again,
  // the same group id, and waits for its Welcome.
  for (let i = 0; i < 20; i++) await advance(t, 50);
  assert.equal(world.session.groupId(), GROUP, "the re-entry is not in GROUP");
  assert.ok(
    count(world.bridgeCalls, "mlsJoinIntent") > intentsBefore,
    "the re-entry sent no join intent",
  );
  assert.equal(count(since(), "callRemove"), 0, "the serve ran early");
  // The Welcome lands and the drain lets go: the serve builds.
  releaseWelcome();
  await flush();
  await advance(t, 1);
  await flush();
  assert.equal(world.session.state(), "active", "the re-entry never landed");

  assert.equal(count(since(), "callRemove"), 0, "the serve staged a Remove");
  assert.deepEqual(
    warned().filter((line) => line.startsWith(REMOVING)),
    [],
    "the refused serve warned that it was removing",
  );
  assert.ok(
    informed().some((line) => line.startsWith(EARLIER_ESTABLISH)),
    "the serve was not refused on the establish generation",
  );
});

test("serve guard: a serve that builds between a reset and the next establish refuses on the group", async (t) => {
  const world = newWorld(t, "joiner", "ch-serveguard-gap");
  await bringUpJoiner(t, world, 0);
  await advance(t, SETTLE_MS);
  const warned = logged(t, "warn");
  const informed = logged(t, "info");
  const mark = world.bridgeCalls.length;
  const since = () => world.bridgeCalls.slice(mark);

  // As above: the drain holds the lock on the removal, and the serve fires
  // and waits for it.
  const releaseRemoval = world.holdProcessEnvelope();
  await world.removedSelf(1);
  await world.joinRequest(PEER, { rejoin: true });
  await advance(t, 1);
  await flush();
  assert.ok(since().includes("callState"), "the serve never read state");
  // A second envelope keeps the drain, and the lock, busy past the removal.
  await world.welcome(2);
  // The removed_self action's leave-clean hangs: `#groupId` is null, and no
  // new establish has bumped the generation yet.
  const releaseLeave = world.holdLeaveCleanup();
  t.after(releaseLeave);
  releaseRemoval();
  const releaseWelcome = world.holdProcessEnvelope();
  await flush();
  for (let i = 0; i < 20; i++) await advance(t, 50);
  assert.equal(world.session.groupId(), null, "the reset had not happened");
  assert.ok(
    since().includes("callLeaveCleanup"),
    "the removed_self action never reached its leave-clean",
  );
  // The drain lets go while the leave-clean still hangs: the serve builds.
  releaseWelcome();
  await flush();
  await advance(t, 1);
  await flush();

  assert.equal(count(since(), "callRemove"), 0, "the serve staged a Remove");
  assert.deepEqual(
    warned().filter((line) => line.startsWith(REMOVING)),
    [],
    "the refused serve warned that it was removing",
  );
  assert.ok(
    informed().some((line) => line.startsWith(ANOTHER_GROUP)),
    "the serve was not refused on the group",
  );
});

for (const outcome of ["answers", "throws"] as const) {
  test(`serve guard: a serve roster read that ${outcome} after a re-entry into the SAME group leaves the new establish's serve its reservation`, async (t) => {
    const world = newWorld(
      t,
      "joiner",
      `ch-serveguard-read-reentry-${outcome}`,
    );
    await bringUpJoiner(t, world, 0);
    await advance(t, SETTLE_MS);
    const read = holdServeRead(t, world);
    const warned = logged(t, "warn");
    const informed = logged(t, "info");
    const mark = world.bridgeCalls.length;
    const since = () => world.bridgeCalls.slice(mark);
    const intentsBefore = count(world.bridgeCalls, "mlsJoinIntent");

    // PEER's rejoin intent. The serve checks the live group, reads the
    // roster, and the read waits.
    await world.joinRequest(PEER, { rejoin: true });
    await advance(t, 1);
    await flush();
    assert.ok(read.held(), "the serve never read the roster");
    // The commit that removed SELF lands. The removed_self action resets the
    // group and re-enters it: a new establish joins GROUP again, the same
    // group id, and its Welcome lands.
    await world.removedSelf(1);
    for (let i = 0; i < 20; i++) await advance(t, 50);
    assert.equal(
      world.session.groupId(),
      GROUP,
      "the re-entry is not in GROUP",
    );
    assert.ok(
      count(world.bridgeCalls, "mlsJoinIntent") > intentsBefore,
      "the re-entry sent no join intent",
    );
    await world.welcome(2);
    assert.equal(world.session.state(), "active", "the re-entry never landed");
    // The new group's first roster reconcile stamps PEER as freshly added
    // (§4.8); past that window a serve of PEER arms again.
    await advance(t, SETTLE_MS);

    // PEER re-broadcasts. The new establish's serve reserves PEER's key and
    // waits in its listing reconcile.
    const releaseReconcile = world.holdReconcileRoster();
    t.after(releaseReconcile);
    const reconciles = count(world.bridgeCalls, "reconcileCallRoster");
    await world.joinRequest(PEER, { rejoin: true });
    assert.equal(
      count(world.bridgeCalls, "reconcileCallRoster"),
      reconciles + 1,
      "the new establish never served PEER",
    );

    // The first serve's read settles, into the new establish's maps, and any
    // timer it armed there fires.
    read.settle(outcome);
    await flush();
    await advance(t, 1);
    await flush();
    // A duplicate of PEER's intent is still deduped on the live serve's key.
    await world.joinRequest(PEER, { rejoin: true });
    assert.equal(
      count(world.bridgeCalls, "reconcileCallRoster"),
      reconciles + 1,
      "the live serve's reservation was dropped: a duplicate started a serve",
    );

    // The live serve goes on and removes the stale leaf, once.
    releaseReconcile();
    await flush();
    await advance(t, 1);
    await flush();
    assert.equal(
      count(since(), "callRemove"),
      1,
      "the new establish's serve did not remove PEER's stale leaf once",
    );
    assert.deepEqual(
      warned().filter((line) => line.startsWith(REMOVING)),
      [REMOVING_PEER],
      "a warning other than the new establish's one removal",
    );
    assert.ok(
      !informed().some((line) => line.startsWith(EARLIER_ESTABLISH)),
      "the outlived read armed a serve that fired into the new establish",
    );
    assert.equal(
      informed().filter((line) => line.startsWith(OUTLIVED_READ)).length,
      1,
      "the read was not refused as outliving its establish",
    );
  });

  test(`serve guard: a serve roster read that ${outcome} after a reset, before the next establish, leaves the ledgered serve to its re-drive`, async (t) => {
    const world = newWorld(t, "joiner", `ch-serveguard-read-gap-${outcome}`);
    await bringUpJoiner(t, world, 0);
    await advance(t, SETTLE_MS);
    const read = holdServeRead(t, world);
    const warned = logged(t, "warn");
    const informed = logged(t, "info");
    const mark = world.bridgeCalls.length;
    const since = () => world.bridgeCalls.slice(mark);

    // As above: the serve's roster read waits.
    await world.joinRequest(PEER, { rejoin: true });
    await advance(t, 1);
    await flush();
    assert.ok(read.held(), "the serve never read the roster");
    // The removed_self action resets the group and its leave-clean hangs:
    // `#groupId` is null, and no new establish has bumped the generation.
    const releaseLeave = world.holdLeaveCleanup();
    t.after(releaseLeave);
    await world.removedSelf(1);
    for (let i = 0; i < 20; i++) await advance(t, 50);
    assert.equal(world.session.groupId(), null, "the reset had not happened");
    assert.ok(
      since().includes("callLeaveCleanup"),
      "the removed_self action never reached its leave-clean",
    );
    // PEER re-broadcasts into the gap: ledgered for the re-drive.
    await world.joinRequest(PEER, { rejoin: true });
    assert.deepEqual(
      peerRetries(warned),
      [1],
      "PEER's intent was not ledgered",
    );

    // The first serve's read settles, into the reset maps. The re-drive tick
    // runs inside the gap: the entry aborts again and counts attempt 2.
    read.settle(outcome);
    await flush();
    await advance(t, ADMIT_RETRY_MS + 1_000);

    assert.equal(world.session.groupId(), null, "the gap closed");
    assert.deepEqual(
      peerRetries(warned),
      [1, 2],
      "PEER's ledger entry was dropped: the re-drive never ran it",
    );
    assert.equal(count(since(), "callRemove"), 0, "a serve staged a Remove");
    assert.equal(
      informed().filter((line) => line.startsWith(OUTLIVED_READ)).length,
      1,
      "the read was not refused as outliving its group",
    );
  });
}
