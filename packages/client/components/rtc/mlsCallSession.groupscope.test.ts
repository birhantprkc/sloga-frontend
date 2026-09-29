// Session-level specs for group scoping in the mailbox drain (`#consume`), on
// the one-seat world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.groupscope.test.ts
//
// Every arm of the drain past processing acts on OUR group: the H1 clear of
// the pending commit, the gap refetch of `#groupId`, the desync escalation,
// the removed-self / successor / rejoin transitions and the inbound memo the
// rotation classifier reads. A drained or replayed envelope for a group this
// session is not in (one it left, or a stale one from before a reload) must
// reach none of them: it is applied natively and acked only on a terminal
// disposition, and anything else stays unacked in the mailbox (invariant 10).
//
// Each case is a pair. ANOTHER group's envelope does none of it; OUR group's
// same envelope does exactly what it did before the check existed, so the
// check cannot be passing by switching the arm off for everyone.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type {
  MlsEnvelope,
  MlsProcessOutcome,
  MlsSubmitCommit,
} from "@revolt/client";

import {
  type World,
  advance,
  bringUpCreator,
  flush,
  GROUP,
  newWorld,
  PEER,
  SELF,
  THIRD,
} from "./mlsCallSession.harness.ts";

/** A group this session never joined: the one every foreign envelope names. */
const OTHER = "group-other";
/** The group a replacement establish mints (`createNextGroupOnce`). */
const NEXT_GROUP = "group-next";
/** What `#consume` logs, once, for every envelope of another group... */
const FOREIGN_LOG = "[mls] envelope for another group";
/** ...except a loud-classified drop, which it logs as an error instead. */
const FOREIGN_LOUD_LOG = "[mls] loud drop for another group";
/** The session's `MAX_PARK_ATTEMPTS`: parks past it escalate to a rejoin. */
const MAX_PARK_ATTEMPTS = 8;

const calls = (world: World, name: string) =>
  world.bridgeCalls.filter((n) => n === name).length;

/** Every `console.info(FOREIGN_LOG, …)` payload, recorded from here on. */
function foreignLogs(t: TestContext): () => unknown[] {
  const info = t.mock.method(console, "info");
  return () =>
    info.mock.calls
      .map((call) => call.arguments)
      .filter(([line]) => line === FOREIGN_LOG)
      .map(([, payload]) => payload);
}

/** Every `console.error(FOREIGN_LOUD_LOG, …)` payload, from here on. */
function foreignLoudLogs(t: TestContext): () => unknown[] {
  const error = t.mock.method(console, "error");
  return () =>
    error.mock.calls
      .map((call) => call.arguments)
      .filter(([line]) => line === FOREIGN_LOUD_LOG)
      .map(([, payload]) => payload);
}

/** A native rejection as it crosses IPC, naming the group it is about. */
type NativeRejection = Error & { type: string; group_id: string };

/** Native's `MlsEpochGap` (the harness keeps its own unexported). */
function epochGap(
  groupId: string,
  expected: number,
  got: number,
): NativeRejection {
  return Object.assign(new Error("mls_epoch_gap"), {
    type: "mls_epoch_gap",
    group_id: groupId,
    expected,
    got,
  });
}

/** Native's `MlsPoisonedEpoch`. */
function poisonedEpoch(groupId: string, epoch: number): NativeRejection {
  return Object.assign(new Error("mls_poisoned_epoch"), {
    type: "mls_poisoned_epoch",
    group_id: groupId,
    epoch,
  });
}

/**
 * Native's `MlsLeafRejected` for a leaf whose binding a device-listing
 * reconcile can repair: `needs_identity`, which the drain turns into a
 * reconcile and, once one has completed for the user, `rejoin_fresh`.
 */
function bindingUnverified(groupId: string): NativeRejection {
  return Object.assign(new Error("mls_leaf_rejected"), {
    type: "mls_leaf_rejected",
    group_id: groupId,
    user_id: THIRD.user_id,
    device_id: THIRD.device_id,
    reason: "binding_unverified",
  });
}

/**
 * Hand the session one envelope (a commit unless told otherwise), as the
 * bridge does. The caller scripts what native answers for `id` (`outcomes` /
 * `rejections`) first.
 */
function deliver(
  world: World,
  id: string,
  groupId: string,
  epoch: number,
  contentType: MlsEnvelope["content_type"] = "mls_commit",
): void {
  const envelope: MlsEnvelope = {
    id,
    content_type: contentType,
    group_id: groupId,
    epoch,
    ciphertext: "",
  };
  assert.ok(world.sink, "the session registered no sink");
  world.sink({
    kind: "envelope",
    envelope,
    recipientDeviceId: world.me.device_id,
  });
}

/** A commit envelope with a scripted native outcome. */
function deliverOutcome(
  world: World,
  id: string,
  outcome: MlsProcessOutcome,
): void {
  world.outcomes.set(id, outcome);
  deliver(world, id, outcome.group_id, outcome.epoch);
}

/** A commit envelope, for the group `error` names, that native rejects. */
function deliverRejected(
  world: World,
  id: string,
  epoch: number,
  error: NativeRejection,
): void {
  world.rejections.set(id, error);
  deliver(world, id, error.group_id, epoch);
}

/** What a foreign envelope must leave exactly as it found it. */
function snapshot(world: World) {
  const { mailbox } = world.session.metrics();
  return {
    groupId: world.session.groupId(),
    state: world.session.state(),
    mode: world.session.callMode().kind,
    modes: world.modes.length,
    gate: [...world.gate].sort(),
    states: world.states.length,
    leaveCleanups: [...world.leaveCleanups],
    commitLosts: [...world.commitLosts],
    callCreate: calls(world, "callCreate"),
    mlsCreateGroup: calls(world, "mlsCreateGroup"),
    mlsFetchCommits: calls(world, "mlsFetchCommits"),
    reconcileCallRoster: calls(world, "reconcileCallRoster"),
    // Not the queue peaks: a foreign envelope is enqueued like any other.
    parks: mailbox.parks,
    gapRefetches: mailbox.gapRefetches,
    retries: mailbox.retries,
    desyncEscalations: mailbox.desyncEscalations,
  };
}

/** A bring-up creator on GROUP, `active` in `e2ee`, with the log recorded. */
async function activeCreator(t: TestContext, channelId: string) {
  const world = newWorld(t, "creator", channelId);
  await bringUpCreator(t, world);
  const logs = foreignLogs(t);
  return { world, logs };
}

// ---- removed_self ------------------------------------------------------------

test("another group's removed_self is applied and acked, and our group is not left", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-removed-other");
  const before = snapshot(world);
  const processed = calls(world, "processEnvelope");
  const acked = calls(world, "ackEnvelopes");

  deliverOutcome(world, "env-other-removed-self", {
    group_id: OTHER,
    kind: "commit_applied",
    epoch: 4,
    removed_self: true,
    removed: [SELF],
  });
  await flush();
  await advance(t, 1); // a scheduled `#onRemovedSelf` would run here

  assert.equal(calls(world, "processEnvelope"), processed + 1, "not applied");
  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "a terminal not acked");
  assert.deepEqual(snapshot(world), before, "another group moved our session");
  assert.equal(world.session.groupId(), GROUP);
  assert.deepEqual(logs(), [
    {
      group: OTHER,
      liveGroup: GROUP,
      epoch: 4,
      contentType: "mls_commit",
      disposition: "processed",
      acked: true,
    },
  ]);
});

test("OUR group's removed_self still leaves our group", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-removed-ours");
  const acked = calls(world, "ackEnvelopes");

  await world.removedSelf(1);
  await advance(t, 1); // `#onRemovedSelf` runs as a group action

  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "not acked");
  assert.equal(world.leaveCleanups[0], GROUP, "our removed_self was swallowed");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- successor (poisoned epoch) ----------------------------------------------

test("another group's poisoned epoch is acked, and no successor replaces our group", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-successor-other");
  world.createNextGroupOnce(NEXT_GROUP); // the successor, were one to run
  const before = snapshot(world);
  const acked = calls(world, "ackEnvelopes");

  const loudLogs = foreignLoudLogs(t);

  deliverRejected(world, "env-other-poisoned", 3, poisonedEpoch(OTHER, 3));
  await flush();
  await advance(t, 1); // a scheduled `#poisonedSuccessor` would run here

  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "a terminal not acked");
  assert.deepEqual(snapshot(world), before, "another group moved our session");
  assert.equal(world.nextGroup, NEXT_GROUP, "a successor was created");
  // A poisoned epoch is a loud-classified drop: logged as an error, not info.
  assert.deepEqual(logs(), []);
  assert.deepEqual(loudLogs(), [
    {
      group: OTHER,
      liveGroup: GROUP,
      epoch: 3,
      contentType: "mls_commit",
      reason: "poisoned",
    },
  ]);
});

test("OUR group's poisoned epoch still migrates to a successor group", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-successor-ours");
  world.createNextGroupOnce(NEXT_GROUP);
  const acked = calls(world, "ackEnvelopes");
  const creates = calls(world, "callCreate");

  deliverRejected(world, "env-ours-poisoned", 1, poisonedEpoch(GROUP, 1));
  await flush();
  await advance(t, 1); // `#poisonedSuccessor` runs as a group action

  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "not acked");
  assert.equal(calls(world, "callCreate"), creates + 1, "no successor created");
  assert.equal(world.session.groupId(), NEXT_GROUP, "GROUP was not replaced");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- rejoin_fresh (an unverifiable leaf) -------------------------------------

test("another group's unverifiable leaf stays unacked, with no reconcile and no rejoin", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-rejoin-other");
  world.createNextGroupOnce(NEXT_GROUP); // the rejoin, were one to run
  const before = snapshot(world);
  const processed = calls(world, "processEnvelope");
  const acked = calls(world, "ackEnvelopes");

  deliverRejected(world, "env-other-leaf", 2, bindingUnverified(OTHER));
  await flush();
  // Past every timer the drain arms for OUR group's twin: the detached
  // reconcile, the re-feed and the rejoin that follows it.
  await advance(t, 1_000);

  assert.equal(
    calls(world, "processEnvelope"),
    processed + 1,
    "not processed exactly once (a re-feed means a reconcile ran)",
  );
  assert.equal(calls(world, "ackEnvelopes"), acked, "a non-terminal was acked");
  assert.deepEqual(snapshot(world), before, "another group moved our session");
  assert.deepEqual(logs(), [
    {
      group: OTHER,
      liveGroup: GROUP,
      epoch: 2,
      contentType: "mls_commit",
      disposition: "needs_identity",
      acked: false,
    },
  ]);
});

test("OUR group's unverifiable leaf still reconciles, then rejoins fresh", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-rejoin-ours");
  world.createNextGroupOnce(NEXT_GROUP);
  const processed = calls(world, "processEnvelope");
  const acked = calls(world, "ackEnvelopes");
  const reconciles = calls(world, "reconcileCallRoster");

  deliverRejected(world, "env-ours-leaf", 1, bindingUnverified(GROUP));
  await flush();
  await advance(t, 1_000); // reconcile, re-feed, `rejoin_fresh:drain`

  assert.ok(
    calls(world, "reconcileCallRoster") > reconciles,
    "the leaf's listing was never reconciled",
  );
  assert.equal(
    calls(world, "processEnvelope"),
    processed + 2,
    "the envelope was not re-fed after the reconcile",
  );
  assert.equal(calls(world, "ackEnvelopes"), acked, "a non-terminal was acked");
  assert.equal(world.leaveCleanups[0], GROUP, "the rejoin never left GROUP");
  assert.equal(world.session.groupId(), NEXT_GROUP, "GROUP was not replaced");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- escalate_desync (the park bound) ----------------------------------------

test("another group's epoch gaps never count toward our park bound", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-escalate-other");
  const before = snapshot(world);
  const acked = calls(world, "ackEnvelopes");

  // As many gaps as OUR group escalates on (the ninth, past eight parks).
  for (let i = 0; i <= MAX_PARK_ATTEMPTS; i++) {
    deliverRejected(world, `env-other-gap-${i}`, 9, epochGap(OTHER, 2, 9));
    await flush();
  }
  await advance(t, 1); // a scheduled `rejoin_fresh:epoch_gap` would run here

  assert.equal(calls(world, "ackEnvelopes"), acked, "a gap was acked");
  assert.deepEqual(snapshot(world), before, "another group moved our session");
  assert.equal(logs().length, MAX_PARK_ATTEMPTS + 1);

  // OUR next gap is our first: a refetch, not an escalation.
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 1,
    result: { kind: "ok", body: { commits: [], current_epoch: 5 } },
  };
  deliverRejected(world, "env-ours-gap", 5, epochGap(GROUP, 1, 5));
  await flush();
  await advance(t, 1);
  assert.equal(calls(world, "mlsFetchCommits"), 1, "our gap was not refetched");
  assert.equal(world.fetchCommitsAnswer, null, "the refetch took no answer");
  assert.equal(world.session.metrics().mailbox.desyncEscalations, 0);
  assert.deepEqual(world.leaveCleanups, [], "our first gap escalated");
  assert.equal(world.session.groupId(), GROUP);
});

test("OUR group's gaps still escalate to a rejoin past the park bound", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-escalate-ours");
  world.createNextGroupOnce(NEXT_GROUP);
  const acked = calls(world, "ackEnvelopes");

  for (let i = 0; i < MAX_PARK_ATTEMPTS; i++) {
    world.fetchCommitsAnswer = {
      groupId: GROUP,
      fromEpoch: 1,
      result: { kind: "ok", body: { commits: [], current_epoch: 5 } },
    };
    deliverRejected(world, `env-ours-gap-${i}`, 5, epochGap(GROUP, 1, 5));
    await flush();
    assert.equal(world.fetchCommitsAnswer, null, `gap ${i} was not refetched`);
  }
  assert.deepEqual(world.leaveCleanups, [], "escalated inside the bound");

  deliverRejected(world, "env-ours-gap-last", 5, epochGap(GROUP, 1, 5));
  await flush();
  await advance(t, 1); // `rejoin_fresh:epoch_gap` runs as a group action

  assert.equal(calls(world, "mlsFetchCommits"), MAX_PARK_ATTEMPTS);
  assert.equal(calls(world, "ackEnvelopes"), acked, "a gap was acked");
  assert.equal(world.session.metrics().mailbox.desyncEscalations, 1);
  assert.equal(world.leaveCleanups[0], GROUP, "the escalation left nothing");
  assert.equal(world.session.groupId(), NEXT_GROUP, "GROUP was not replaced");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- a commit at our STAGED epoch (H1) ---------------------------------------

interface PoisonedMerge {
  /** Release the held submit: it answers `Won`, and the merge is refused. */
  release: () => void;
  /** The pending commit native holds for GROUP from here on. */
  held: MlsSubmitCommit;
  /** Whether the merge was refused (the one-shot throw fired). */
  fired: () => boolean;
}

/**
 * An admit of THIRD staged at epoch 1 on GROUP, whose merge native then
 * refuses with `MlsPoisonedEpoch`, followed by a commit at that same epoch
 * which the drain consumes BEFORE the successor transition runs.
 *
 * That is the one window in which `#consume` runs with `#staged` set, and so
 * the only one in which the H1 clear can fire. The drain shares `#lock` with
 * `#stageAndSubmit`, and every other exit from it leaves `#staged` cleared (a
 * Won merges, a Lost clears before it rebases, a timeout or failure clears
 * before it re-secures, a superseded submit's group swap reset it), so a
 * commit queued behind a submit is always consumed with nothing staged. Only
 * the poisoned-merge catch keeps it: it schedules `#poisonedSuccessor`
 * (whose reset clears it) as a 0 ms group action, which the fake clock holds
 * until the next tick, and releases the lock to the queued drain first.
 *
 * The world has no way to script a `callCommitWon` rejection, so this puts
 * one in native's staged-commit slot instead: a copy of the staged commit
 * whose `epoch`, which the stub reads to check the won epoch, throws
 * `MlsPoisonedEpoch` once. The copy is what native holds from then on, so
 * "our pending commit was not discarded" reads as that exact object still
 * being there.
 */
async function stageThenPoisonTheMerge(
  t: TestContext,
  world: World,
): Promise<PoisonedMerge> {
  const release = world.holdSubmit();
  await world.joinRequest(THIRD);
  await advance(t, 1); // the admit's 0 ms leaf stagger: stage, then submit
  assert.equal(world.submits(), 1, "the admit never submitted");
  const staged = world.stagedCommits.get(GROUP);
  assert.ok(staged !== undefined && staged !== "left", "nothing was staged");
  assert.equal(staged.epoch, 1);

  let armed = true;
  const held: MlsSubmitCommit = { ...staged };
  Object.defineProperty(held, "epoch", {
    enumerable: true,
    get: () => {
      if (armed) {
        armed = false;
        throw poisonedEpoch(GROUP, 1);
      }
      return staged.epoch;
    },
  });
  world.stagedCommits.set(GROUP, held);
  return { release, held, fired: () => !armed };
}

test("another group's commit at our staged epoch does not discard our pending commit", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-staged-other");
  const { release, held, fired } = await stageThenPoisonTheMerge(t, world);
  const processed = calls(world, "processEnvelope");
  const acked = calls(world, "ackEnvelopes");

  deliverOutcome(world, "env-other-staged", {
    group_id: OTHER,
    kind: "commit_applied",
    epoch: 1,
    removed_self: false,
    removed: [],
  });
  await flush();
  assert.equal(
    calls(world, "processEnvelope"),
    processed,
    "the drain ran ahead of the held submit",
  );

  release();
  await flush(); // Won, the refused merge, then the queued drain

  assert.ok(fired(), "the merge was never refused: nothing stayed staged");
  assert.equal(calls(world, "callCommitWon"), 1);
  assert.equal(calls(world, "processEnvelope"), processed + 1, "not applied");
  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "a terminal not acked");
  assert.deepEqual(world.commitLosts, [], "our pending commit was cleared");
  assert.equal(
    world.stagedCommits.get(GROUP),
    held,
    "native no longer holds our pending commit",
  );
  assert.deepEqual(logs(), [
    {
      group: OTHER,
      liveGroup: GROUP,
      epoch: 1,
      contentType: "mls_commit",
      disposition: "processed",
      acked: true,
    },
  ]);
});

test("OUR group's commit at our staged epoch still clears our pending commit first (H1)", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-staged-ours");
  const { release, fired } = await stageThenPoisonTheMerge(t, world);
  const processed = calls(world, "processEnvelope");

  deliverOutcome(world, "env-ours-staged", {
    group_id: GROUP,
    kind: "commit_applied",
    epoch: 1,
    removed_self: false,
    removed: [],
  });
  await flush();
  release();
  await flush();

  assert.ok(fired(), "the merge was never refused: nothing stayed staged");
  assert.equal(calls(world, "processEnvelope"), processed + 1, "not applied");
  assert.deepEqual(world.commitLosts, [GROUP], "the H1 clear never ran");
  assert.equal(world.stagedCommits.has(GROUP), false, "native kept it staged");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- an epoch gap (refetch and receiver lag) ---------------------------------

test("another group's epoch gap stays unacked, with no refetch of our group and no lag escalation", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-gap-other");
  world.createNextGroupOnce(NEXT_GROUP); // the lag rejoin, were one to run
  const before = snapshot(world);
  const acked = calls(world, "ackEnvelopes");

  // Far enough ahead that a refetch finding it would read as receiver lag.
  deliverRejected(world, "env-other-lag", 14, epochGap(OTHER, 1, 14));
  await flush();
  await advance(t, 1); // a scheduled `rejoin_fresh:receiver_lag` would run

  assert.equal(calls(world, "mlsFetchCommits"), 0, "a group was refetched");
  assert.equal(calls(world, "ackEnvelopes"), acked, "a gap was acked");
  assert.deepEqual(snapshot(world), before, "another group moved our session");
  assert.deepEqual(logs(), [
    {
      group: OTHER,
      liveGroup: GROUP,
      epoch: 14,
      contentType: "mls_commit",
      disposition: "park",
      acked: false,
    },
  ]);
});

test("OUR group's epoch gap is still refetched and left unacked", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-gap-ours");
  const acked = calls(world, "ackEnvelopes");
  world.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: 1,
    result: { kind: "ok", body: { commits: [], current_epoch: 5 } },
  };

  deliverRejected(world, "env-ours-gap", 5, epochGap(GROUP, 1, 5));
  await flush();

  assert.equal(calls(world, "mlsFetchCommits"), 1, "our gap was not refetched");
  assert.equal(world.fetchCommitsAnswer, null, "the refetch took no answer");
  assert.equal(calls(world, "ackEnvelopes"), acked, "a gap was acked");
  assert.equal(world.session.metrics().mailbox.gapRefetches, 1);
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

test("OUR group's gap still escalates on receiver lag", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-lag-ours");
  world.createNextGroupOnce(NEXT_GROUP);

  await world.receiverLag();
  await advance(t, 1); // `rejoin_fresh:receiver_lag` runs as a group action

  assert.equal(calls(world, "mlsFetchCommits"), 1, "our gap was not refetched");
  assert.equal(world.leaveCleanups[0], GROUP, "the lag never left GROUP");
  assert.equal(world.session.groupId(), NEXT_GROUP, "GROUP was not replaced");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- the inbound memo (`#lastInbound`) ---------------------------------------
//
// The session exposes the memo through what it decides: the rotation
// classifier (`classifyLocalKeyInstall`) reads it for the TIMING of our send
// key, and the receive-gap metric for whether an epoch was Remove-driven.
// Our keys-changed for epoch 1 with no memo of our own for it is the
// fail-safe: immediate, and not a Remove. A memo another group's commit
// wrote at the same epoch number would pass for ours on both.

/** Receive-gap samples so far: `[Add-driven, Remove-driven]`. */
const receiveGaps = (world: World) => {
  const { receiveGapAddMs, receiveGapRemoveMs } = world.session.metrics();
  return [receiveGapAddMs.count, receiveGapRemoveMs.count];
};

test("another group's Remove at our next epoch is not recorded as ours", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-memo-remove-other");
  const [adds, removes] = receiveGaps(world);

  deliverOutcome(world, "env-other-remove", {
    group_id: OTHER,
    kind: "commit_applied",
    epoch: 1,
    removed_self: false,
    removed: [PEER],
  });
  await flush();
  world.epoch = 1; // our own epoch 1, with no inbound of ours for it
  await world.session.onLocalKeysChanged(GROUP, 1);
  await flush();

  assert.deepEqual(
    receiveGaps(world),
    [adds + 1, removes],
    "our epoch 1 read another group's Remove as its own",
  );
  assert.equal(logs().length, 1);
});

test("OUR group's Remove is still recorded as Remove-driven", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-memo-remove-ours");
  const [adds, removes] = receiveGaps(world);

  await world.commit(1, [PEER]);

  assert.deepEqual(receiveGaps(world), [adds, removes + 1]);
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

test("another group's Add at our next epoch does not defer our send key", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-memo-add-other");

  deliverOutcome(world, "env-other-add", {
    group_id: OTHER,
    kind: "commit_applied",
    epoch: 1,
    removed_self: false,
    removed: [],
  });
  await flush();
  world.epoch = 1;
  // The local send-key install throws this, on whichever path it runs: now
  // (immediate) or after the Add grace. Only its timing is under test.
  world.failLocalKeyOnce(new Error("scripted local install failure"));
  await world.session.onLocalKeysChanged(GROUP, 1);
  await flush();

  assert.equal(
    world.localKeyFailure,
    null,
    "our send key waited out another group's Add grace",
  );
  assert.equal(logs().length, 1);
});

test("OUR group's Add still defers our send key behind the grace", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-memo-add-ours");
  const failure = new Error("scripted local install failure");
  world.failLocalKeyOnce(failure);

  await world.commit(1);
  assert.equal(world.localKeyFailure, failure, "installed without the grace");

  await advance(t, 2_000); // `ADD_GRACE_MS`
  assert.equal(world.localKeyFailure, null, "the grace never installed");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});

// ---- a ctl-announce (the mode machine) ---------------------------------------
//
// `#onCtlReceived` checks the group and channel a §3.4 announce's payload
// names, but that binding is the sender's own claim: the group native
// authenticated the sender in is the envelope's. So the foreign announce
// below names OUR group and channel in its payload, the one shape in which
// nothing but the scoping check stands between a member of another group and
// our mode machine.

/** A bare (device-less) SFU identity: non-enrolled on sight, so `mixed`. */
const DAVE = "dave";

/** Seat a bare identity and reconcile: T1 `mixed`, with publishing paused. */
async function declareMix(world: World): Promise<void> {
  world.sfu = [...world.sfu, DAVE];
  world.sids.set(DAVE, ["TR_d"]);
  await world.session.reconcileNow();
  await flush();
  assert.equal(world.session.callMode().kind, "mixed");
  assert.ok(world.gate.has("mixed"), "the mix was declared without a pause");
}

/**
 * PEER's plaintext announce over OUR group and channel, in an `mls_ctl`
 * envelope of `groupId` that native answers as a processed `ctl_received`.
 * While `mixed`, ours moves the session to the unconfirmed interlude (T4).
 */
function deliverAnnounce(world: World, id: string, groupId: string): void {
  world.outcomes.set(id, {
    group_id: groupId,
    kind: "ctl_received",
    epoch: world.epoch,
    removed_self: false,
    removed: [],
    ctl: {
      sender_user_id: PEER.user_id,
      sender_device_id: PEER.device_id,
      payload: JSON.stringify({
        v: 1,
        kind: "mode",
        mode: "plaintext",
        channel_id: world.channelId,
        group_id: GROUP,
      }),
    },
  });
  deliver(world, id, groupId, world.epoch, "mls_ctl");
}

test("another group's ctl-announce is acked and never reaches our mode machine", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-ctl-other");
  await declareMix(world);
  const before = snapshot(world);
  const processed = calls(world, "processEnvelope");
  const acked = calls(world, "ackEnvelopes");

  deliverAnnounce(world, "env-other-ctl", OTHER);
  await flush();

  assert.equal(
    world.session.callMode().kind,
    "mixed",
    "another group's announce reached our mode machine",
  );
  assert.equal(calls(world, "processEnvelope"), processed + 1, "not applied");
  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "a terminal not acked");
  assert.deepEqual(snapshot(world), before, "another group moved our session");
  assert.equal(world.publishing(), false, "the mix's pause was lifted");
  assert.deepEqual(logs(), [
    {
      group: OTHER,
      liveGroup: GROUP,
      epoch: world.epoch,
      contentType: "mls_ctl",
      disposition: "processed",
      acked: true,
    },
  ]);
});

test("OUR group's ctl-announce still moves a mixed call to the unconfirmed interlude (T4)", async (t) => {
  const { world, logs } = await activeCreator(t, "ch-gs-ctl-ours");
  await declareMix(world);
  const acked = calls(world, "ackEnvelopes");

  deliverAnnounce(world, "env-ours-ctl", GROUP);
  await flush();

  const mode = world.session.callMode();
  assert.equal(mode.kind, "interlude", "our announce was not applied");
  assert.equal(
    mode.kind === "interlude" && mode.localConfirmed,
    false,
    "a PEER's announce confirmed this device",
  );
  assert.equal(world.modes.at(-1), "interlude", "no mode change was reported");
  assert.equal(calls(world, "ackEnvelopes"), acked + 1, "not acked");
  assert.equal(world.publishing(), false, "T4 lifted the pause");
  assert.deepEqual(logs(), [], "our own envelope read as another group's");
});
