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
// The last group pins the harness's other native and page facts the resume
// specs stand on (W2R-m2, and what wave 3 added to the harness): the native
// downgrade grant (marked by a native Ok, cleared by a clear, outliving a page
// death, and cleared by the leave-clean of its channel's LAST row), the page
// death's abort of its own prefetch, and a hang-up and rejoin on one page.
//
// No spec here re-intents faster than the DS's 5 s join-intent slowmode,
// which the harness DS does not model (W1-n5): the only re-intent is the
// session's own, at `JOINER_RETRY_MS` (10 s).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsEnvelope } from "@revolt/client";

import { readResumeRecord } from "../client/mlsResumeKeep.ts";
import {
  type Fleet,
  type Identity,
  type World,
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

// ---- The native downgrade grant (W2R-m2) -----------------------------------
//
// `mls_downgrade_confirmed` is engine memory keyed by CHANNEL: the shell's,
// not the page's, so a Ctrl+R keeps it (W2-M3). Where a live session is not
// the point, rows are seated by hand on seats whose sessions never started,
// so nothing but the calls under test reaches the grant.

/** A native row for `groupId` on `channelId`, seated by hand. */
function holdRow(world: World, groupId: string, channelId: string): void {
  world.native.localGroups.set(groupId, {
    channelId,
    epoch: 0,
    leaves: [world.me],
    state: "active",
  });
}

test("grant: a native Ok marks the channel's grant on that device alone, a clear removes it, and the announce is refused without it", async (t) => {
  const channel = "ch-grant-mark";
  const fleet = newFleet(t, [SELF, PEER], channel);
  const self = fleet.seat(SELF);
  const peer = fleet.seat(PEER);
  holdRow(self, GROUP, channel);
  holdRow(peer, GROUP, channel);
  const notConfirmed = { type: "mls_not_confirmed" };
  await assert.rejects(
    self.bridge.callAnnounce(GROUP, SELF.user_id),
    notConfirmed,
  );

  // A declined dialog, and one over a group the store does not hold, mark
  // nothing.
  self.declineDowngradeOnce();
  await assert.rejects(self.bridge.callConfirmDowngrade(GROUP, [], {}), {
    type: "declined",
  });
  await assert.rejects(
    self.bridge.callConfirmDowngrade("group-unheld", [], {}),
    { type: "mls_group_not_found" },
  );
  assert.equal(self.native.downgradeConfirmed(channel), false);

  await self.bridge.callConfirmDowngrade(GROUP, [], {});
  assert.equal(self.native.downgradeConfirmed(channel), true, "no grant");
  assert.equal(
    peer.native.downgradeConfirmed(channel),
    false,
    "another device's native was marked",
  );
  const payload = await self.bridge.callAnnounce(GROUP, SELF.user_id);
  assert.equal(payload.group_id, GROUP);
  await assert.rejects(
    peer.bridge.callAnnounce(GROUP, PEER.user_id),
    notConfirmed,
  );

  await self.bridge.callClearDowngrade(GROUP);
  assert.equal(self.native.downgradeConfirmed(channel), false, "not cleared");
  await assert.rejects(
    self.bridge.callAnnounce(GROUP, SELF.user_id),
    notConfirmed,
  );
});

test("grant: it outlives a page death, whose dispose cannot clear it, and the next page's announce is built on it", async (t) => {
  const channel = "ch-grant-reload";
  const fleet = newFleet(t, [SELF, PEER], channel);
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  await peer.bridge.callConfirmDowngrade(GROUP, [], {});
  assert.equal(peer.native.downgradeConfirmed(channel), true);
  const clears = peer.clearDowngrades();

  // PEER's live session holds GROUP, so its default dispose WOULD clear the
  // grant (R2-M1) if its bridge still reached native. The page is dead first.
  peer.pageDeath();
  assert.equal(
    peer.native.downgradeConfirmed(channel),
    true,
    "the page death took the grant",
  );
  assert.equal(peer.clearDowngrades(), clears, "the dead page reached native");

  peer.boot(); // the next page; its session is not started
  assert.equal(peer.native.downgradeConfirmed(channel), true);
  const payload = await peer.bridge.callAnnounce(GROUP, PEER.user_id);
  assert.equal(payload.group_id, GROUP);
});

test("grant: a leave-clean clears it only with the channel's LAST row, by whichever route; a failed one clears nothing", async (t) => {
  const channel = "ch-grant-rows";
  const fleet = newFleet(t, [SELF], channel);
  const self = fleet.seat(SELF);
  holdRow(self, GROUP, channel);
  holdRow(self, "group-succ", channel);
  holdRow(self, "group-other", "ch-other");
  await self.bridge.callConfirmDowngrade(GROUP, [], {});
  await self.bridge.callConfirmDowngrade("group-other", [], {});
  const granted = () =>
    [channel, "ch-other"].filter((c) => self.native.downgradeConfirmed(c));
  assert.deepEqual(granted(), [channel, "ch-other"]);

  // A row of the channel remains (a successor created before the cleanup).
  await self.bridge.callLeaveCleanup(GROUP);
  assert.deepEqual(
    granted(),
    [channel, "ch-other"],
    "cleared while a row of the channel remained",
  );
  // Another channel's last row takes that channel's grant only.
  await self.bridge.callLeaveCleanup("group-other");
  assert.deepEqual(granted(), [channel]);
  // A leave-clean native rolled back wiped nothing, so it clears nothing.
  self.failLeaveCleanupOnce("group-succ");
  await assert.rejects(self.bridge.callLeaveCleanup("group-succ"));
  assert.ok(self.localGroups.has("group-succ"));
  assert.deepEqual(granted(), [channel]);
  // The last row goes by a keep's expiry: the registry's own delete.
  assert.equal(self.bridge.keepLocalGroup("group-succ", channel, 10_000), true);
  await advance(t, 10_250);
  assert.equal(self.localGroups.has("group-succ"), false, "never expired");
  assert.deepEqual(granted(), [], "the last row left its grant behind");
});

// ---- A page's own connects: page death, hang-up, rejoin ---------------------

test("page death aborts its own prefetch: a held commits read released as a failure afterwards clears nothing, and a dead page keeps nothing", async (t) => {
  const channel = "ch-page-abort";
  const fleet = newFleet(t, [SELF, PEER], channel);
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  // PEER's session installed GROUP's keys: the tab records it as resumable.
  assert.equal(readResumeRecord(peer.sessionStorage, channel)?.groupId, GROUP);

  // A new page whose host starts a prefetch, its session never started (so
  // nothing but the host can abort it), on a DS that holds the last read.
  const release = fleet.ds.holdFetchCommits();
  const requests = fleet.ds.fetchCommitsRequests.length;
  peer.pageDeath();
  peer.boot({ prefetchFromBridge: true });
  await flush();
  assert.equal(
    fleet.ds.fetchCommitsRequests.length,
    requests + 1,
    "the prefetch never reached its commits read",
  );
  const signal = peer.resumePrefetchSignal;
  assert.ok(signal, "no prefetch signal");
  assert.equal(signal.aborted, false);

  peer.pageDeath();
  assert.equal(signal.aborted, true, "the page death left its prefetch live");
  // Released as a failure: a prefetch still running would `giveUp`, clearing
  // the tab's record for a page that no longer exists. Its outcome is read
  // after an `advance`, never awaited: a `giveUp` that ran would clean the
  // candidate up through the dead page's bridge, which never settles, and an
  // await on it would hang the file instead of failing this case.
  const prefetch = peer.resumePrefetch;
  assert.ok(prefetch, "no prefetch");
  const settled: ({ value: unknown } | { error: unknown })[] = [];
  void prefetch.then(
    (value) => settled.push({ value }),
    (error: unknown) => settled.push({ error }),
  );
  fleet.ds.failFetchCommitsOnce();
  release();
  await advance(t, 1);
  assert.deepEqual(
    settled,
    [{ value: null }],
    "the dead page's prefetch did not settle to null (a giveUp that ran never settles)",
  );
  assert.equal(
    readResumeRecord(peer.sessionStorage, channel)?.groupId,
    GROUP,
    "the dead page's prefetch cleared the tab's record",
  );
  assert.ok(peer.localGroups.has(GROUP));
  assert.equal(
    peer.prefetchAborts,
    0,
    "the host's abort counted as a dep call",
  );
  // A dead page's bridge keeps nothing, so no recency record may follow.
  assert.equal(peer.bridge.keepLocalGroup(GROUP, channel, 10_000), false);
});

test("rejoin: a hang-up keeps the group on the SAME page, and the next connect's prefetch claims it there", async (t) => {
  const channel = "ch-page-rejoin";
  const fleet = newFleet(t, [SELF, PEER], channel);
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  const first = peer.session;
  const kept = peer.kept;
  const tokens = peer.startupWipeTokens;
  const calls = peer.bridgeCalls.length;

  await fleet.rejoin(PEER);

  assert.equal(first.state(), "closed", "the hung-up session is still up");
  assert.notEqual(peer.session, first, "no new session");
  assert.equal(peer.kept, kept, "the rejoin ran on a new page");
  assert.equal(peer.startupWipeTokens, tokens);
  // The hang-up cleared the grant and KEPT the group, recorded it, and only
  // then did the new connect start its prefetch.
  const since = peer.bridgeCalls.slice(calls);
  const at = (name: string) => {
    const index = since.indexOf(name);
    assert.ok(index >= 0, `no ${name}`);
    return index;
  };
  assert.ok(at("callClearDowngrade") < at("keepLocalGroup"));
  assert.ok(at("keepLocalGroup") < at("touchResumeRecord"));
  assert.ok(at("touchResumeRecord") < at("prefetchResume"));
  const prefetch = await peer.resumePrefetch;
  assert.equal(prefetch?.groupId, GROUP);
  assert.notEqual(
    prefetch?.claimToken ?? null,
    null,
    "the entry was unclaimed",
  );
  assert.ok(peer.localGroups.has(GROUP));
  assert.ok(peer.gate.has("negotiating"), "the connect did not seed the gate");
});

test("hang-up on sign-out: the kept groups are discarded ahead of the dispose, the group goes at once, and later keeps are refused", async (t) => {
  const channel = "ch-page-signout";
  const fleet = newFleet(t, [SELF, PEER], channel);
  await fleet.bringUp();
  await advance(t, 3_000);
  const peer = fleet.seat(PEER);
  const calls = peer.bridgeCalls.length;

  peer.hangUp({ discardMls: true });
  await flush();

  const since = peer.bridgeCalls.slice(calls);
  assert.equal(since[0], "discardKeptLocalGroups");
  assert.equal(since.includes("keepLocalGroup"), false, "a sign-out kept");
  assert.equal(peer.session.state(), "closed");
  assert.ok(peer.leaveCleanups.includes(GROUP), "the group was not deleted");
  assert.equal(peer.localGroups.has(GROUP), false);
  assert.equal(readResumeRecord(peer.sessionStorage, channel), null);
  assert.equal(peer.bridge.keepLocalGroup("group-later", channel, 1), false);
});
