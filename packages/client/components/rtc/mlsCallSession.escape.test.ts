// Session-level specs for the plaintext ESCAPE — `confirmPlaintext` and the
// wave-2 seams around it (`confirmReachable`, `hasUsableGroup`,
// `confirmLocalPlaintext`, the interlude's `confirmedVia`) — on the shared
// world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.escape.test.ts
//
// Why a file of its own. Until wave 2 nothing at the session level exercised
// `confirmPlaintext` at all, and the ME-10 banner's "Stay unencrypted" button
// was offered exactly where the escape returned without a word: every
// permanent control terminus leaves `#groupId` null, and the first guard read
// `!this.#groupId` as "nothing to do". A red chip over a pause claim and an
// inert button is the parked-behind-a-chip state this design exists to
// eliminate, and raising a louder banner over it (wave 3) would be a
// regression in honesty. So each spec here drives one way the button is
// offered and asserts that the press does what the copy says — or, on a
// decline, that it does nothing at all.
//
// Two rules these specs keep, stated so nobody reads them as incidental:
//  - the in-app confirm is still a confirm. The session releases the gate on
//    it only because the caller's own blocking, per-device dialog was answered
//    first (that dialog is `state.tsx`'s, not the session's); nothing here
//    releases a gate without one, and a DECLINE of the native dialog keeps the
//    pause and the banner.
//  - an app-confirmed interlude is NOT sticky across a re-secure (invariant
//    1, plan §5): it was confirmed with no usable group, so it outlives only
//    the group state it was confirmed against. A natively-confirmed one is,
//    exactly as before.
//
// Each spec names the mutation it kills (`scripts/rtc-mutations.py`); the
// CONTROL specs prove the announce witness can fire, they are not rules.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsEnvelope } from "@revolt/client";

import {
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  GROUP,
  latchLoud,
  newWorld,
  PEER,
  SELF,
  SELF_ID,
  THIRD,
} from "./mlsCallSession.harness.ts";

// ---- The session's bounds, mirrored ---------------------------------------
//
// None of these is exported by `mlsCallSession.ts`; each is copied here under
// its own name and cited, as `mlsCallSession.resecure.test.ts` does.

/** `RESECURE_ESCALATE_MS` — the re-securing backstop's bound. */
const RESECURE_BACKSTOP_MS = 10_000;
/** `JOINER_RETRY_MS` — each Welcome wait of the join ladder. */
const JOINER_RETRY_MS = 10_000;
/** `MAX_JOINER_RETRIES` — re-broadcasts after the first intent. */
const MAX_JOINER_RETRIES = 3;
/** One whole ladder: every attempt's Welcome wait, back to back. */
const LADDER_MS = (MAX_JOINER_RETRIES + 1) * JOINER_RETRY_MS;

// ---- Helpers ----------------------------------------------------------------

/** A bare (device-less) SFU identity: non-enrolled on sight, so `mixed`. */
const DAVE = "dave";

/**
 * What `state.tsx`'s `confirmCallPlaintext` passes: the display names of the
 * non-enrolled identities it could resolve (`userId → username`), which is
 * empty on a call with no mix. The session forwards it to the native dialog
 * and reads nothing from it.
 */
const NO_NAMES: Record<string, string> = {};
const MIX_NAMES: Record<string, string> = { [DAVE]: "Dave" };

/** The interlude a confirmation produces, by who authorized it. */
function interludeVia(via: "native" | "app") {
  return { kind: "interlude", localConfirmed: true, confirmedVia: via };
}

/**
 * Seat a bare identity in the SFU set and reconcile: T1 `mixed`, with the
 * `mixed` reason held (the falsered spec pins the ordering of that edge).
 */
async function declareMix(world: World): Promise<void> {
  world.sfu = [...world.sfu, DAVE];
  world.sids.set(DAVE, ["TR_d"]);
  await world.session.reconcileNow();
  await flush();
  assert.equal(world.session.callMode().kind, "mixed");
  assert.ok(world.gate.has("mixed"), "the mix was declared without a pause");
}

/**
 * A permanent control terminus with `#groupId` null: removed from the group
 * while no longer in the SFU (`#onRemovedSelf`'s "stay re-securing" arm,
 * the resecure spec's 4a), then the backstop's control latch one bound later.
 * Nothing is left to end it, and no path ever assigns a group again — the
 * shape the "Stay unencrypted" button was inert under.
 */
async function removedTerminus(t: TestContext, world: World): Promise<void> {
  world.sfu = world.sfu.filter((id) => id !== SELF_ID);
  await world.removedSelf(1);
  await advance(t, 1); // `#onRemovedSelf` runs as a 0 ms group action
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.session.groupId(), null, "the group survived the removal");
  await advance(t, RESECURE_BACKSTOP_MS + 1_000);
  assert.equal(world.terminalLoud(), true, "no ME-10 banner at the terminus");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false, "the banner's pause claim is false");
}

/**
 * A peer's §3.4 ctl-announce lands: it declared plaintext over THIS group and
 * channel. Delivered through the world's public seams (`outcomes` + `sink`)
 * as a processed `ctl_received` outcome, the way the fake `processEnvelope`
 * answers any scripted envelope. While `mixed`, the session moves to the
 * UNCONFIRMED interlude (T4) and keeps publishing paused.
 */
async function peerAnnouncesPlaintext(world: World): Promise<void> {
  const envelope: MlsEnvelope = {
    id: "env-ctl-plaintext",
    content_type: "mls_ctl",
    group_id: GROUP,
    epoch: world.epoch,
    ciphertext: "",
  };
  world.outcomes.set(envelope.id, {
    group_id: GROUP,
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
  assert.ok(world.sink, "the session registered no sink");
  world.sink({ kind: "envelope", envelope, recipientDeviceId: SELF.device_id });
  await flush();
}

/**
 * The witness for an ANNOUNCE effect: `#announceDowngrade` reaches the bridge
 * as `callAnnounce` (then `mlsSendCtl`), and the fake records the name of
 * every stubbed method into `world.bridgeCalls` as it is called. Arming
 * snapshots the log's length; the counter reads how many `callAnnounce`
 * entries landed AFTER it, so a confirm's own announce (7 CONTROL) is never
 * charged to the epoch advances that follow it (8 / 8 CONTROL). It counts
 * ATTEMPTS at the bridge, not deliveries: the product's catch around the
 * announce is best-effort, and "did the session try to announce" is the
 * question every site here asks. The harness journals no effect list, so
 * this log is the only place the effect is visible. The CONTROL specs prove
 * the witness fires for a native confirm, so a zero here is evidence.
 */
function watchAnnounces(world: World): () => number {
  const armedAt = world.bridgeCalls.length;
  return () =>
    world.bridgeCalls.slice(armedAt).filter((n) => n === "callAnnounce").length;
}

// ---- 1. The terminus the button was dead under --------------------------------

test("1 — confirmPlaintext with no group shows no native dialog and applies the in-app confirm (kills escape-no-group-returns-early)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-1");
  await bringUpCreator(t, world);
  await removedTerminus(t, world);
  // The banner offers the button here: reachable, and nothing for the
  // native dialog to compute a roster against.
  assert.equal(world.session.confirmReachable(), true);
  assert.equal(world.session.hasUsableGroup(), false);

  await world.session.confirmPlaintext(NO_NAMES);
  await flush();
  assert.equal(
    world.confirmDowngrades(),
    0,
    "a native dialog was asked for with no group to compute it against",
  );
  assert.deepEqual(
    world.session.callMode(),
    interludeVia("app"),
    "the press did nothing — the escape is still inert at the terminus",
  );
  // "Continue without encryption" means exactly that: every reason the
  // terminus was holding (`enable-window` from the reset, `negotiating` from
  // the latch's fold) is released, and the banner no longer claims a pause.
  assert.deepEqual([...world.gate], [], "the confirm left a reason held");
  assert.equal(world.publishing(), true);
  assert.equal(world.terminalLoud(), false, "ME-10 over a confirmed interlude");

  // A second press is a no-op: the interlude is confirmed, so the escape is
  // no longer reachable and no dialog is ever raised over it.
  assert.equal(world.session.confirmReachable(), false);
  await world.session.confirmPlaintext(NO_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 0);
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
});

// ---- 2. With a usable group: the native dialog, and its three answers ----------

test("2a — with a usable group the native dialog runs exactly once, and Ok confirms natively", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-2a");
  await bringUpCreator(t, world);
  await declareMix(world);
  assert.equal(world.session.confirmReachable(), true);
  assert.equal(world.session.hasUsableGroup(), true);

  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1, "no native dialog over a group");
  assert.deepEqual(world.confirmDowngradeCalls, [
    {
      groupId: GROUP,
      sfuParticipants: [...world.sfu],
      displayNames: MIX_NAMES,
    },
  ]);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.deepEqual([...world.gate], [], "the confirm left a reason held");
  assert.equal(world.publishing(), true);
});

test("2b — a DECLINED native dialog changes nothing: no interlude, the pause and the escape both stand (kills escape-declined-routes-to-app)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-2b");
  await bringUpCreator(t, world);
  await declareMix(world);
  const gateBefore = [...world.gate];

  world.declineDowngradeOnce();
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1, "the dialog was not asked");
  assert.equal(
    world.session.callMode().kind,
    "mixed",
    "a decline was read as a confirmation",
  );
  assert.deepEqual([...world.gate], gateBefore, "a decline moved the gate");
  assert.equal(world.publishing(), false, "a decline released publishing");
  // The banner persists, and with it the button: the next press asks again.
  assert.equal(world.session.confirmReachable(), true);
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 2);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
});

test("2c — a native dialog that FAILS for any reason but a decline routes to the in-app confirm", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-2c");
  await bringUpCreator(t, world);
  await declareMix(world);

  world.failConfirmDowngradeOnce(new Error("ipc"));
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1, "the dialog was not attempted");
  assert.deepEqual(
    world.session.callMode(),
    interludeVia("app"),
    "an IPC failure was read as a decline — the escape went inert",
  );
  assert.deepEqual([...world.gate], [], "the confirm left a reason held");
  assert.equal(world.publishing(), true);
});

// ---- 3. confirmReachable: the button's population, arm by arm -------------------

test("3a — confirmReachable is false on a healthy e2ee call and true under a latch; false again over a confirmed interlude and after dispose", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-3a");
  await bringUpCreator(t, world);
  assert.equal(world.session.confirmReachable(), false, "reachable on e2ee");

  // `negotiating` with a latched loud media error, the state still `active`:
  // the ME-10 population the terminal banner offers "Stay unencrypted" to.
  await latchLoud(t, world);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.confirmReachable(), true, "the latch was silent");
  // ... and the group is intact, so the native dialog is the route.
  assert.equal(world.session.hasUsableGroup(), true);

  await world.session.confirmLocalPlaintext();
  await flush();
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
  assert.equal(
    world.session.confirmReachable(),
    false,
    "reachable over a confirmed interlude",
  );

  world.session.dispose();
  assert.equal(
    world.session.confirmReachable(),
    false,
    "reachable after dispose",
  );
  // Terminal: the press must not clear `#announcedBy` or apply a mode.
  await world.session.confirmPlaintext(NO_NAMES);
  await world.session.confirmLocalPlaintext();
  await flush();
  assert.equal(
    world.confirmDowngrades(),
    0,
    "a dialog over a disposed session",
  );
});

test("3b — confirmReachable is false through a healthy negotiation and true once the DS verdict is `failed` (negotiating && failed)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-3b");
  // Before any verdict: negotiating, and no UI offers the button.
  void world.session.start();
  await flush();
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(
    world.session.confirmReachable(),
    false,
    "reachable pre-verdict",
  );
  await advance(t, 1);
  assert.equal(world.session.state(), "active");

  // The S:2970 shape: THIRD's admit submits, and the DS answers a 409 whose
  // body says `Won` — an arbitration `classifyArbitration` reads as `failed`.
  // `#onLoud` sets `failed` and latches; the fold drops `e2ee` to
  // `negotiating`. Only the staged commit is discarded; the group stands.
  world.answerSubmitOnce({ kind: "conflict", body: { result: "Won" } });
  await world.joinRequest(THIRD);
  await advance(t, 1);
  assert.equal(world.session.state(), "failed", "the arbitration did not fail");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.session.confirmReachable(), true, "unreachable on failed");
  assert.equal(world.session.hasUsableGroup(), true);
  assert.equal(world.publishing(), false);

  await world.session.confirmPlaintext(NO_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1, "no native dialog over the group");
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.equal(world.publishing(), true);
});

test("3c — confirmReachable is true while a re-establish holds re-securing (negotiating && resecuring), and hasUsableGroup is false under it", async (t) => {
  const world = newWorld(t, "joiner", "ch-escape-3c");
  await bringUpJoiner(t, world, 0);
  assert.equal(world.session.hasUsableGroup(), true);

  // Removed while STILL in the SFU: `#onRemovedSelf` → `#rejoinFresh` drops
  // the mode to `negotiating`, enters re-securing and starts a join ladder
  // whose Welcome never lands — the establish is in flight for the whole
  // ladder, and the native dialog's group may change under it.
  await world.removedSelf(1);
  await advance(t, 1);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(
    world.session.confirmReachable(),
    true,
    "unreachable resecuring",
  );
  assert.equal(
    world.session.hasUsableGroup(),
    false,
    "an establish in flight was offered to the native dialog",
  );
  assert.equal(world.publishing(), false);
});

test("3d — confirmReachable is true for `mixed` and for a peer-announced (unconfirmed) interlude, and the native Ok confirms it (T4 → T5)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-3d");
  await bringUpCreator(t, world);
  await declareMix(world);
  assert.equal(world.session.confirmReachable(), true, "unreachable on mixed");

  await peerAnnouncesPlaintext(world);
  const mode = world.session.callMode();
  assert.equal(mode.kind, "interlude", "the announce was not applied");
  assert.equal(
    mode.kind === "interlude" && mode.localConfirmed,
    false,
    "a PEER's announce confirmed this device",
  );
  assert.equal(world.publishing(), false, "T4 lifted the pause");
  assert.equal(
    world.session.confirmReachable(),
    true,
    "unreachable on an unconfirmed interlude",
  );

  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.equal(world.publishing(), true);
});

// ---- 4. hasUsableGroup: routing only, and only when the group is settled --------

test("4a — hasUsableGroup is false while the first establish is in flight and true once it settled with a group", async (t) => {
  const world = newWorld(t, "joiner", "ch-escape-4a");
  void world.session.start();
  await flush();
  await advance(t, 1); // up to the Welcome wait: the establish is in flight
  assert.equal(world.session.state(), "starting");
  assert.equal(world.session.hasUsableGroup(), false, "usable mid-establish");
  await world.welcome(0);
  await world.session.onLocalKeysChanged(GROUP, 0);
  await flush();
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.groupId(), GROUP);
  assert.equal(world.session.hasUsableGroup(), true, "unusable once settled");
});

test("4b — hasUsableGroup is false while a group action is pending, even with the group still assigned", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-4b");
  await bringUpCreator(t, world);
  assert.equal(world.session.hasUsableGroup(), true);

  // The drain schedules `#onRemovedSelf` as a 0 ms group action and marks it
  // pending at once; the group is nulled only when the action RUNS. In
  // between, a native dialog would compute against a group about to go.
  await world.removedSelf(1);
  assert.equal(world.session.groupId(), GROUP, "nulled before the action ran");
  assert.equal(
    world.session.hasUsableGroup(),
    false,
    "usable under a pending group action",
  );
  // The action ran: SELF was still in the SFU, so `#rejoinFresh` re-created
  // the group and the creator settled `active` again — usable once more.
  await advance(t, 1);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.groupId(), GROUP);
  assert.equal(world.session.hasUsableGroup(), true, "unusable once settled");
});

// ---- 5. C1: the terminal arm releases `mixed` too ------------------------------

test("5 — a terminal confirm from `negotiating` with `mixed` still held releases every reason, `mixed` included (kills escape-negotiating-keeps-mixed-held)", async (t) => {
  const world = newWorld(t, "joiner", "ch-escape-5");
  await bringUpJoiner(t, world, 0);
  await declareMix(world);

  // A re-establish under the mix: `#resetEnableState` drops `#mixPaused`
  // WITHOUT releasing `mixed` (and pauses `enable-window`), then
  // `#dropModeToNegotiating` holds `negotiating`. The ladder then exhausts
  // and latches: `negotiating` + latched, with three reasons held.
  await world.removedSelf(1);
  await advance(t, 1);
  assert.equal(world.session.callMode().kind, "negotiating");
  await advance(t, LADDER_MS + 1_000);
  assert.equal(world.terminalLoud(), true, "no ME-10 after the ladder");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(
    [...world.gate].sort(),
    ["enable-window", "mixed", "negotiating"],
    "the terminus is not holding the reasons this spec is about",
  );
  assert.equal(world.session.confirmReachable(), true);

  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.deepEqual(
    [...world.gate],
    [],
    "the terminal confirm left a reason held while the banner said unencrypted",
  );
  assert.equal(world.publishing(), true);
});

// ---- 6. C4: an app-confirmed interlude is withdrawn by a re-secure -------------

test("6a — an APP-confirmed interlude is withdrawn to `negotiating` by a re-secure, and the gate is re-held (kills escape-app-interlude-sticky)", async (t) => {
  const world = newWorld(t, "joiner", "ch-escape-6a");
  await bringUpJoiner(t, world, 0);
  await latchLoud(t, world);
  await world.session.confirmLocalPlaintext();
  await flush();
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
  assert.equal(world.publishing(), true);

  // A fresh rejoin (`#onRemovedSelf` → `#rejoinFresh`): the ONE rule at
  // `#dropModeToNegotiating` and `#resetEnableState` reads the provenance.
  await world.removedSelf(1);
  await advance(t, 1);
  assert.equal(world.session.state(), "resecuring");
  assert.deepEqual(
    world.session.callMode(),
    { kind: "negotiating" },
    "the app-confirmed window outlived the group it was confirmed against",
  );
  assert.deepEqual([...world.gate], ["negotiating"], "the gate is not re-held");
  assert.equal(world.publishing(), false);
  // The user confirms again over the NEW group, or not at all: reachable,
  // and never natively — no dialog was ever raised on the app route.
  assert.equal(world.session.confirmReachable(), true);
  assert.equal(world.confirmDowngrades(), 0);
});

test("6b — a NATIVELY-confirmed interlude stays sticky through the same re-secure", async (t) => {
  const world = newWorld(t, "joiner", "ch-escape-6b");
  await bringUpJoiner(t, world, 0);
  await latchLoud(t, world);
  await world.session.confirmPlaintext(NO_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));

  await world.removedSelf(1);
  await advance(t, 1);
  assert.equal(world.session.state(), "resecuring");
  assert.deepEqual(
    world.session.callMode(),
    interludeVia("native"),
    "a native confirmation was withdrawn by a re-secure",
  );
  assert.deepEqual([...world.gate], [], "a sticky interlude re-held the gate");
  assert.equal(world.publishing(), true);
  assert.equal(world.session.confirmReachable(), false);
});

// ---- 7. The in-app route never announces ---------------------------------------

test("7 — confirmLocalPlaintext emits no announce (kills escape-app-confirm-announces)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-7");
  await bringUpCreator(t, world);
  // With the group INTACT, so `#announceDowngrade` would not return early on
  // a null group: the only thing keeping the announce out is the effect list.
  await latchLoud(t, world);
  assert.equal(world.session.hasUsableGroup(), true);
  const announces = watchAnnounces(world);

  await world.session.confirmLocalPlaintext();
  await flush();
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
  assert.equal(announces(), 0, "the in-app confirm announced a downgrade");
});

test("7 CONTROL — the announce witness fires for a NATIVE confirm on the same shape", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-7c");
  await bringUpCreator(t, world);
  await latchLoud(t, world);
  const announces = watchAnnounces(world);

  await world.session.confirmPlaintext(NO_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.equal(announces(), 1, "the witness cannot see an announce at all");
});

// ---- 8. ME-4: only a NATIVE confirm re-announces on an epoch advance ---------
//
// `#onEpochAdvanced` re-announces a locally confirmed interlude on every
// inbound epoch advance (ME-4: `max_past_epochs` is 0, so late processors
// lose the first announce). Native gates the announce on its own
// downgrade-confirmed flag, which only the native dialog sets — so an
// app-confirmed interlude over an INTACT group (2c's route: the dialog failed
// for a reason other than a decline) would re-attempt on each advance and
// fail `mls_not_confirmed` every time. The re-announce is therefore keyed on
// provenance, exactly as stickiness is (6a/6b).

test("8 — an app-confirmed interlude with an intact group does NOT re-announce on epoch advance (kills escape-app-interlude-reannounces)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-8");
  await bringUpCreator(t, world);
  await declareMix(world);

  // 2c's route: the group is INTACT, so `#announceDowngrade` has a group to
  // announce over — the only thing keeping it out is the provenance test.
  world.failConfirmDowngradeOnce(new Error("ipc"));
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1);
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
  assert.equal(world.session.hasUsableGroup(), true, "the group did not hold");
  const announces = watchAnnounces(world);

  // Two inbound commits, neither a Welcome: each reaches the ME-4 site with
  // the interlude still confirmed (asserted, so a zero is never vacuous).
  await world.commit(1);
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
  await world.commit(2);
  assert.deepEqual(world.session.callMode(), interludeVia("app"));
  assert.equal(world.session.groupId(), GROUP, "the group did not survive");
  assert.equal(
    announces(),
    0,
    "an app-confirmed interlude re-attempted the native announce",
  );
});

test("8 CONTROL — a NATIVELY-confirmed interlude re-announces on every epoch advance on the same shape (ME-4 preserved)", async (t) => {
  const world = newWorld(t, "creator", "ch-escape-8c");
  await bringUpCreator(t, world);
  await declareMix(world);

  // 2a's route. The witness is armed AFTER the confirm (whose own announce 7
  // CONTROL already counts) so each count below is one epoch advance's.
  await world.session.confirmPlaintext(MIX_NAMES);
  await flush();
  assert.equal(world.confirmDowngrades(), 1);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  const announces = watchAnnounces(world);

  await world.commit(1);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.equal(announces(), 1, "ME-4 did not re-announce on the first advance");
  await world.commit(2);
  assert.deepEqual(world.session.callMode(), interludeVia("native"));
  assert.equal(
    announces(),
    2,
    "ME-4 did not re-announce on the second advance",
  );
});
