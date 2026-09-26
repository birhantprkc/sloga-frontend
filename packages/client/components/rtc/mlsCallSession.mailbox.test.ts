// Session-level specs for the DS MAILBOX a fleet seat's device keeps
// (`Ds.deliver` / `Ds.mailbox` / `Ds.ack` in `mlsCallSession.harness.ts`).
//   node --test --conditions=browser components/rtc/mlsCallSession.mailbox.test.ts
//
// Bonfire queues every MLS envelope for a device before it pushes it live,
// deletes it only on that device's ack, and replays whatever is still queued
// once per WS connection (plan, Lane D). The first four pin the harness's
// model of that, because every later spec on it is only as good as they are:
// a push is queued per device until its ack, a new page's connect re-delivers
// only the unacked envelopes and in queue order, the new session acks what it
// consumes, and a WS reconnect re-drains into the LIVE sink, where an
// envelope already applied another way comes back a `duplicate`.
//
// Then the two wave-1 audit items the mailbox exists for:
//   - W1-M1: a page reload whose mailbox holds stale commits for the group
//     its startup wipe removes, and a Welcome for that group, ends quiet and
//     rejoins through today's ladder;
//   - W1-m6: a Welcome for a group the device still holds is refused by
//     native (`welcome-join`, OpenMLS `GroupAlreadyExists`), the row is kept,
//     and the session stays on its group, failing closed.
// And the pre-sink hold's device filter: another device's copy is dropped
// when it arrives, never held for the next sink.
//
// No spec here re-intents faster than the DS's 5 s join-intent slowmode,
// which the harness DS does not model (W1-n5): the only re-intent is the
// session's own, at `JOINER_RETRY_MS` (10 s).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsEnvelope } from "@revolt/client";

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
} from "./mlsCallSession.harness.ts";

/** A fourth device, so two members can leave one after the other. */
const DAVE: Identity = { user_id: "dave", device_id: "devD" };

/** An `mls_commit` envelope as the DS queues it (opaque ciphertext). */
function commitEnvelope(
  id: string,
  groupId: string,
  epoch: number,
): MlsEnvelope {
  return {
    id,
    content_type: "mls_commit",
    group_id: groupId,
    epoch,
    ciphertext: `commit-${epoch}`,
  };
}

/** Every `console` level silenced and recorded for the rest of the test. */
function captureConsole(t: TestContext) {
  return {
    error: t.mock.method(console, "error", () => {}),
    warn: t.mock.method(console, "warn", () => {}),
    info: t.mock.method(console, "info", () => {}),
  };
}

type Captured = ReturnType<typeof captureConsole>;

/** The session's "envelope for another group" lines from call `from` on. */
function anotherGroupLines(logs: Captured, from = 0): unknown[] {
  return logs.info.mock.calls
    .slice(from)
    .filter((c) => c.arguments[0] === "[mls] envelope for another group")
    .map((c) => {
      const line = c.arguments[1] as Record<string, unknown>;
      return {
        liveGroup: line.liveGroup,
        epoch: line.epoch,
        disposition: line.disposition,
        acked: line.acked,
      };
    });
}

/** The ids a page's pre-sink hold is keeping for the next sink, in order. */
function heldIds(world: ReturnType<Fleet["seat"]>): string[] {
  return world.preSinkBuffer.map((e) =>
    e.kind === "envelope" ? e.envelope.id : e.kind,
  );
}

/**
 * `id` leaves the call: its page is gone and it drops off the SFU. Only SELF
 * (leaf 0) is told, so only SELF's leave-grace removes it, and no other seat
 * submits a competing Remove it would learn the commit from instead.
 */
function leaves(fleet: Fleet, id: Identity): void {
  const key = identityOf(id);
  const self = fleet.seat(SELF);
  fleet.seat(id).pageDeath();
  self.sfu = self.sfu.filter((p) => p !== key);
  self.sids.delete(key);
  self.session.onParticipantLeft(key);
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

// ---- The mailbox itself ----------------------------------------------------

test("mailbox: a push is queued for each addressed device and leaves only on that device's ack", async (t) => {
  const fleet = newFleet(t, [SELF, PEER], "ch-mailbox-ack");
  const self = fleet.seat(SELF);
  const peer = fleet.seat(PEER);
  const both = commitEnvelope("env-both", "group-x", 1);

  // Neither page has started a session, so no sink: each copy waits in its
  // page's pre-sink hold as well as in its device's mailbox.
  fleet.ds.deliver(both);
  fleet.ds.deliver(commitEnvelope("env-self", "group-x", 2), [SELF]);
  fleet.ds.deliver(both); // a re-push of a queued id is not queued twice
  assert.deepEqual(
    self.mailbox.map((e) => e.id),
    ["env-both", "env-self"],
  );
  assert.deepEqual(
    peer.mailbox.map((e) => e.id),
    ["env-both"],
  );
  assert.deepEqual(heldIds(self), ["env-both", "env-self"]);

  // A device's ack deletes its own copies only; an unknown id is ignored.
  peer.bridge.ackEnvelopes(["env-both"]);
  assert.deepEqual(peer.mailbox, []);
  assert.deepEqual(
    self.mailbox.map((e) => e.id),
    ["env-both", "env-self"],
    "PEER's ack deleted SELF's copy",
  );
  self.bridge.ackEnvelopes(["env-self", "env-unknown"]);
  assert.deepEqual(
    self.mailbox.map((e) => e.id),
    ["env-both"],
  );
  self.bridge.ackEnvelopes(["env-both"]);
  assert.deepEqual(self.mailbox, []);
});

test("mailbox: a new page's connect clears the hold and re-delivers only the unacked envelopes, in queue order", async (t) => {
  const fleet = newFleet(t, [SELF], "ch-mailbox-order");
  const self = fleet.seat(SELF);
  // Queue order is neither id order nor epoch order.
  fleet.ds.deliver(commitEnvelope("env-c", "group-x", 7));
  fleet.ds.deliver(commitEnvelope("env-a", "group-x", 3));
  fleet.ds.deliver(commitEnvelope("env-b", "group-x", 5));
  self.bridge.ackEnvelopes(["env-a"]);
  assert.deepEqual(heldIds(self), ["env-c", "env-a", "env-b"]);

  // The first half of `Fleet.reload`: page death, then a new page whose WS
  // connect clears its hold and drains the mailbox into it. No session is
  // started, so the hold is exactly what the next sink would be handed.
  self.pageDeath();
  self.boot();
  assert.deepEqual(heldIds(self), ["env-c", "env-b"]);
  // A re-delivery acks nothing.
  assert.deepEqual(
    self.mailbox.map((e) => e.id),
    ["env-c", "env-b"],
  );
});

test("mailbox: Fleet.reload hands the unacked envelopes to the new session in order, and it acks each", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF], "ch-mailbox-reload");
  const self = fleet.seat(SELF);
  fleet.ds.deliver(commitEnvelope("env-c", "group-gone", 7));
  fleet.ds.deliver(commitEnvelope("env-a", "group-gone", 3));
  fleet.ds.deliver(commitEnvelope("env-b", "group-gone", 5));
  self.bridge.ackEnvelopes(["env-a"]);
  const calls = self.bridgeCalls.length;

  await fleet.reload(SELF);

  // The new session registered its sink with the two unacked envelopes
  // waiting and consumed them in queue order. With no live group yet each is
  // another group's; native holds no `group-gone` row, so each is a quiet
  // `wiped` drop, which is terminal, so acked.
  assert.deepEqual(anotherGroupLines(logs), [
    { liveGroup: null, epoch: 7, disposition: "drop", acked: true },
    { liveGroup: null, epoch: 5, disposition: "drop", acked: true },
  ]);
  assert.equal(
    self.bridgeCalls.slice(calls).filter((n) => n === "processEnvelope").length,
    2,
    "the acked envelope was re-delivered",
  );
  assert.deepEqual(self.mailbox, []);
  assert.deepEqual(heldIds(self), []);
});

test("mailbox: a reconnect re-drains into the live sink; an already-applied commit comes back a duplicate, is acked and applied once", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER, THIRD, DAVE], "ch-mailbox-reconnect");
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  assert.equal(fleet.ds.epoch, 3);

  // PEER's WS drops: bonfire still queues every envelope for it (`deliver`
  // queues before it pushes), but the live push never lands.
  const wsDown = t.mock.method(peer, "receive", () => {});
  leaves(fleet, THIRD);
  await flush();
  await advance(t, LEAVE_GRACE_MS + 1_000);
  assert.equal(fleet.ds.epoch, 4, "SELF removed THIRD");
  assert.equal(peer.localEpoch, 3, "PEER missed the Remove");
  assert.deepEqual(
    peer.mailbox.map((e) => [e.group_id, e.epoch]),
    [[GROUP, 4]],
  );
  const missed = peer.mailbox[0].id;

  // The WS is back (no drain yet). DAVE leaves; SELF's Remove at epoch 5 is
  // pushed live, lands on a gap, and the gap refetch applies epochs 4 and 5
  // under their synthetic ids. Neither mailbox copy is acked: the refetch
  // acks only its synthetic envelopes, and a gapped envelope is never acked
  // (invariant 10).
  wsDown.mock.restore();
  leaves(fleet, DAVE);
  await flush();
  await advance(t, LEAVE_GRACE_MS + 1_000);
  assert.equal(fleet.ds.epoch, 5, "SELF removed DAVE");
  assert.equal(peer.localEpoch, 5, "the gap refetch caught PEER up");
  assert.deepEqual(peer.localRoster.map(identityOf), [SELF_ID, PEER_ID]);
  assert.deepEqual(
    peer.mailbox.map((e) => [e.group_id, e.epoch]),
    [
      [GROUP, 4],
      [GROUP, 5],
    ],
  );
  assert.equal(peer.mailbox[0].id, missed);
  assert.ok(peer.native.processed.has(`mls-synth:${GROUP}:4`));
  assert.ok(peer.native.processed.has(`mls-synth:${GROUP}:5`));
  const processed = [...peer.native.processed];
  const calls = peer.bridgeCalls.length;
  const states = peer.states.length;
  const errors = logs.error.mock.calls.length;

  await fleet.reconnect(PEER);

  // Both came back into the LIVE sink (nothing waits in the hold) and were
  // processed and acked. Native answered each a `duplicate` (an epoch it
  // already holds): nothing recorded, epoch and roster unmoved, no keys read
  // or installed, so nothing was applied twice.
  assert.deepEqual(heldIds(peer), []);
  assert.deepEqual(peer.bridgeCalls.slice(calls), [
    "processEnvelope",
    "ackEnvelopes",
    "processEnvelope",
    "ackEnvelopes",
  ]);
  assert.deepEqual(peer.mailbox, []);
  assert.deepEqual([...peer.native.processed], processed);
  assert.equal(peer.localEpoch, 5);
  assert.deepEqual(peer.localRoster.map(identityOf), [SELF_ID, PEER_ID]);
  await advance(t, 1_000);
  assert.deepEqual(peer.states.slice(states), []);
  assert.equal(logs.error.mock.calls.length, errors);
  assert.equal(peer.session.state(), "active");
  assert.equal(peer.session.callMode().kind, "e2ee");
});

// ---- W1-M1: a reload that drains stale envelopes for the group it wipes ----
//
// PEER's page dies. While it is gone two members leave and SELF removes each,
// so PEER's mailbox gains two commits for its old group, and the DS pushes it
// a Welcome for that group too. The new page's WS connect drains all three
// into the pre-sink hold, and the new session consumes them at `start()`,
// BEFORE its establish runs: the startup wipe has not happened yet, so the
// old row is still HELD when they arrive.
//   - The commits are another group's (no live group yet): native applies
//     them to the held row in order, and each is acked on that terminal
//     outcome. None reaches the new session's transitions.
//   - The Welcome is a quiet refusal: PEER holds no own join intent for the
//     group (native deleted it when the first Welcome seated PEER), so native
//     answers `MlsUnsolicitedWelcome` before OpenMLS is asked to seat
//     anything: an ack and drop, no latch.
// Then the establish runs today's ladder: the wipe drops the (now caught-up)
// row, leaf 0 serves the rejoin intent (a Remove of the stale leaf), the
// re-intent `JOINER_RETRY_MS` later is admitted, and PEER is back on GROUP.

test("W1-M1: a wipe-rejoin whose mailbox holds stale commits and a Welcome for the wiped group ends quiet and rejoins", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER, THIRD, DAVE], "ch-mailbox-w1m1");
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  const self = fleet.seat(SELF);
  assert.equal(fleet.ds.epoch, 3);

  peer.pageDeath();
  leaves(fleet, THIRD);
  await flush();
  await advance(t, LEAVE_GRACE_MS + 1_000);
  leaves(fleet, DAVE);
  await flush();
  await advance(t, LEAVE_GRACE_MS + 1_000);
  assert.equal(fleet.ds.epoch, 5, "SELF removed THIRD, then DAVE");
  // A Welcome for GROUP at an epoch the DS can seat, so only native's own
  // checks decide it.
  fleet.ds.deliver(
    {
      id: "stale-welcome",
      content_type: "mls_welcome",
      group_id: GROUP,
      epoch: 1,
      ciphertext: "welcome-1",
    },
    [PEER],
  );
  assert.deepEqual(
    peer.mailbox.map((e) => [e.content_type, e.group_id, e.epoch]),
    [
      ["mls_commit", GROUP, 4],
      ["mls_commit", GROUP, 5],
      ["mls_welcome", GROUP, 1],
    ],
  );
  assert.equal(peer.localGroups.get(GROUP)?.epoch, 3, "the stale row");
  assert.equal(peer.native.intents.has(GROUP), false, "PEER holds an intent");
  const states = peer.states.length;
  const modes = peer.modes.length;
  const selfModes = self.modes.length;
  const infos = logs.info.mock.calls.length;
  const from = fleet.ds.submits.length;

  await fleet.wipeRejoin(PEER);

  // Drained and consumed before the establish: every envelope acked, the
  // commits applied to the still-held row, the Welcome seated nothing.
  assert.equal(peer.resumePrefetch, undefined, "today's path: no prefetch");
  assert.deepEqual(peer.mailbox, [], "a drained envelope was left unacked");
  assert.deepEqual(anotherGroupLines(logs, infos), [
    { liveGroup: null, epoch: 4, disposition: "processed", acked: true },
    { liveGroup: null, epoch: 5, disposition: "processed", acked: true },
  ]);
  assert.equal(peer.localGroups.get(GROUP)?.epoch, 5);
  assert.equal(peer.native.processed.has("stale-welcome"), false);
  assert.equal(peer.leaveCleanups.includes(GROUP), false, "wiped too early");

  // Today's ladder: the startup wipe, then the served rejoin.
  await advance(t, 1);
  assert.ok(peer.leaveCleanups.includes(GROUP), "PEER's startup wipe");
  await untilActive(t, fleet, PEER, 40_000);
  await advance(t, 5_000);
  assert.deepEqual(
    fleet.ds.submits
      .slice(from)
      .filter((s) => s.groupId === GROUP)
      .map((s) => [s.seat, s.kind, s.epoch, s.outcome]),
    [
      [SELF_ID, "remove", 6, "won"],
      [SELF_ID, "admit", 7, "won"],
    ],
  );
  assert.equal(peer.session.groupId(), GROUP);
  assert.equal(peer.session.callMode().kind, "e2ee");
  assert.equal(peer.localEpoch, fleet.ds.epoch);
  assert.deepEqual(peer.localRoster.map(identityOf), [SELF_ID, PEER_ID]);
  assert.deepEqual(peer.mailbox, []);

  // Quiet: no loud emission, one mode edge (the new session's own `e2ee`)
  // and none on SELF, no loud banner, and no error logged anywhere in the
  // fleet.
  assert.deepEqual(peer.loudSince(states), []);
  assert.deepEqual(peer.modes.slice(modes), ["e2ee"]);
  assert.deepEqual(self.modes.slice(selfModes), []);
  assert.equal(peer.terminalLoud(), false);
  assert.equal(self.terminalLoud(), false);
  assert.deepEqual(
    logs.error.mock.calls.map((c) => c.arguments),
    [],
  );
});

// ---- W1-m6: a Welcome for a group the device still holds ------------------
//
// Native checks the own join intent BEFORE OpenMLS is asked to seat the group
// (`MlsUnsolicitedWelcome` otherwise, as W1-M1 shows), so the refusal is
// reachable only for a device that holds both the row and an intent for the
// group. That native state is set directly here as the precondition.
// OpenMLS's `into_group` then fails `GroupAlreadyExists`, native answers
// `mls_err("welcome-join")` with its transaction rolled back, and the
// classifier makes that a loud terminal drop. The session stays on its group
// and FAILS CLOSED: the consumed Welcome latches loud (control origin), the
// mode drops to negotiating and the publish gate stays held. That is Lane
// D's "rolled back, loud": quiet only in that nothing is published in
// plaintext and nothing crashes.

test("W1-m6: a Welcome for a held group is refused (welcome-join), the row is kept, and the session stays on its group, closed", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER], "ch-mailbox-w1m6");
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  assert.equal(peer.session.callMode().kind, "e2ee");
  peer.native.intents.add(GROUP);
  const row = structuredClone(peer.localGroups.get(GROUP));
  assert.equal(row?.epoch, 1);
  const calls = peer.bridgeCalls.length;
  const states = peer.states.length;

  fleet.ds.deliver(
    {
      id: "welcome-held",
      content_type: "mls_welcome",
      group_id: GROUP,
      epoch: 1,
      ciphertext: "welcome-1",
    },
    [PEER],
  );
  await flush();

  // Native refused and changed nothing: row, intent and replay record.
  assert.deepEqual(peer.localGroups.get(GROUP), row);
  assert.ok(peer.native.intents.has(GROUP), "the intent was not kept");
  assert.equal(peer.native.processed.has("welcome-held"), false);
  // The terminal drop was acked, so no drain re-delivers it.
  assert.deepEqual(peer.bridgeCalls.slice(calls), [
    "processEnvelope",
    "ackEnvelopes",
  ]);
  assert.deepEqual(peer.mailbox, []);
  // The session is still on its group.
  assert.equal(peer.session.state(), "active");
  assert.equal(peer.session.groupId(), GROUP);
  // Fail closed: one loud latch, one error, negotiating, gate held.
  assert.deepEqual(
    peer.states.slice(states).map((s) => [s.state, String(s.error), s.meta]),
    [
      [
        "loud",
        "Error: MLS envelope destroyed: mls",
        { origin: "control", mediaKeyed: true },
      ],
    ],
  );
  assert.deepEqual(
    logs.error.mock.calls.map((c) => c.arguments),
    [["[mls] loud terminal envelope drop", "mls", "mls_welcome"]],
  );
  assert.equal(peer.session.callMode().kind, "negotiating");
  assert.equal(peer.publishing(), false);
  assert.equal(peer.terminalLoud(), true);

  // And it stays closed: nothing heals it on its own.
  await advance(t, 30_000);
  assert.equal(peer.session.callMode().kind, "negotiating");
  assert.equal(peer.publishing(), false);
  assert.equal(logs.error.mock.calls.length, 1);
  assert.deepEqual(
    peer.states.slice(states).map((s) => s.state),
    ["loud"],
  );
});

// ---- The pre-sink hold's device filter -------------------------------------

test("hold: another device's copy is dropped when it arrives, never held for the next sink", async (t) => {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF], "ch-mailbox-device");
  const self = fleet.seat(SELF);

  // The bridge sees the user's E2EE events for every one of the user's
  // devices; with no sink registered yet, the hold decides.
  self.receive({
    kind: "envelope",
    envelope: commitEnvelope("env-theirs", "group-gone", 4),
    recipientDeviceId: "devOther",
  });
  assert.deepEqual(heldIds(self), [], "another device's copy was held");
  self.receive({
    kind: "envelope",
    envelope: commitEnvelope("env-own", "group-gone", 6),
    recipientDeviceId: SELF.device_id,
  });
  assert.deepEqual(heldIds(self), ["env-own"]);

  // The session's sink is handed the own copy alone.
  void self.session.start();
  await flush();
  assert.equal(
    self.bridgeCalls.filter((n) => n === "processEnvelope").length,
    1,
  );
  assert.deepEqual(anotherGroupLines(logs), [
    { liveGroup: null, epoch: 6, disposition: "drop", acked: true },
  ]);
  assert.deepEqual(heldIds(self), []);
});
