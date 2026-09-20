// Session-level specs for the THREE-PARTY join race (`MlsCallSession`), on the
// shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.joinrace.test.ts
//
// The failure these pin (rejoin plan section 7.4, live leg 3a, 2026-09-07): a
// member quick-rejoins, which advances the epoch; a BYSTANDER switches to the
// new key index before this device installs it; the worker raises a decode
// MissingKey naming that bystander, outside every rotation window;
// `#latchLoud` fires. Because a MissingKey NAMES its participant the heal's
// only witness is then a device that never churns, so the chip stayed red for
// the rest of the call while that same peer's frames decrypted again 3.6 s
// later.
//
// The fix DEFERS the verdict instead of guessing it, so the specs that matter
// most are the ones proving the deferral cannot be talked out of going loud,
// and cannot be answered by anything short of this side installing the exact
// index the error named. A previous attempt (`1df6c703`, reverted by
// `69797f8d`) turned that permanent red into a SILENT GREEN by trusting a
// bound that does not exist. The specs marked 🔴 are that regression's guards.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { ENCRYPTION_TYPE_GCM } from "./localPublicationEncryption.ts";
import {
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  GROUP,
  JOIN_RACE_DEFER_MS,
  LEAVE_GRACE_MS,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
  THIRD,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";

/**
 * A three-party call, live and green, past the first rotation settle so no
 * rotation window is open — the seat every spec below starts from.
 */
async function threeParty(
  t: TestContext,
  channelId: string,
  seat?: (w: World) => void,
): Promise<World> {
  const world = newWorld(t, "creator", channelId, (w) => {
    w.withThird();
    seat?.(w);
  });
  await bringUpCreator(t, world);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 3_000); // past the immediate-install rotation settle (2 s)
  assert.equal(world.session.callMode().kind, "e2ee");
  return world;
}

/**
 * Leg 3a's shape: PEER quick-rejoins the SFU (out, then back), which is the
 * membership change THIS device observes; the epoch it triggers is served by
 * someone else, so THIRD — a bystander that did nothing — reaches the new key
 * index first and our worker raises a missing key naming it.
 */
async function bystanderRaceAfterRejoin(
  world: World,
  nextEpoch: number,
): Promise<Error> {
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.session.onParticipantLeft(PEER_ID);
  await flush();
  world.sfu = [...world.sfu, PEER_ID];
  world.session.onParticipantJoined(PEER_ID);
  await flush();
  const error = world.missingKey(THIRD_ID, nextEpoch);
  world.session.noteEncryptionError(error);
  await flush();
  return error;
}

// ---- Specs -----------------------------------------------------------------

test("leg 3a: a bystander's missing key during an observed rejoin is HELD, not latched, and clears when the epoch installs", async (t) => {
  const world = await threeParty(t, "ch-3a");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);

  // Not loud — and not clear either. The verdict is open.
  assert.deepEqual(world.loudSince(before), [], "the bystander race latched");
  assert.deepEqual(world.clearsSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
  // ...and the chip is driven AMBER for as long as it is open. Without this
  // the deferral is the reverted attempt's silent green.
  assert.deepEqual(world.holds, [true], "the chip was not driven amber");
  assert.equal(
    world.chip(),
    "resecuring",
    "the chip the user reads went green",
  );
  assert.deepEqual(world.states.slice(before), [
    { state: "resecuring", error },
  ]);

  // Our copy of the commit lands, and with it the key at the exact index the
  // bystander was already sending at.
  await advance(t, 1_000);
  await world.commit(1);
  await flush();
  assert.deepEqual(world.holds, [true, false], "the hold never resolved");
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.chip(), "e2ee", "the chip did not come back");

  // And it stays resolved past the bound — the deadline was cancelled, not
  // merely outrun.
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 an install that ADVANCES past the index without filling it does not answer the hold", async (t) => {
  // The exact defect the media-E2EE review of the first cut found. The
  // ledger's `#superseded` also accepts "an install advanced us past it"
  // (`at <= advancedAt`), which is right for `errorSince` — where the heal's
  // peer witness still has to clear — and wrong as the hold's only test. The
  // worker marks an index invalid after ONE failure and drops every later
  // frame at it silently; only a `setKey` for that exact index re-validates
  // it, and the ring does not come round again for sixteen epochs. A sender
  // two epochs ahead of us would otherwise take the chip back to green over
  // an index nothing ever filled.
  const world = await threeParty(t, "ch-advance-nofill");
  const before = world.states.length;
  // THIRD is sending at the epoch-2 index; we are still at epoch 0.
  const error = await bystanderRaceAfterRejoin(world, 2);
  assert.deepEqual(world.holds, [true]);

  // Epoch 1 lands: it fills index 1 for every sender, so it ADVANCES us for
  // THIRD — but it never touches index 2.
  await advance(t, 1_000);
  await world.commit(1);
  await flush();
  assert.deepEqual(
    world.holds,
    [true],
    "an install that never filled the index answered the hold",
  );
  assert.deepEqual(world.loudSince(before), []);

  // Nothing fills index 2, so the verdict resolves the only honest way.
  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 the SFU's recovery echo cannot cancel the bound: a withheld commit still goes RED within it", async (t) => {
  const world = await threeParty(t, "ch-withheld");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.loudSince(before), []);
  assert.deepEqual(world.holds, [true]);

  // The exact signal that made the reverted attempt unsound: LiveKit's
  // `participantEncryptionStatusChanged(encrypted=true)` for ANY participant,
  // which `state.tsx` routes to `noteEncryptionRecovered()`. In leg 3a's own
  // trace it landed 97 ms after the error. Fire it there, and keep firing it
  // for the whole window — it is a server-controlled echo, so an attacker
  // that can withhold a commit can certainly send it.
  await advance(t, 250);
  for (let i = 0; i < JOIN_RACE_DEFER_MS / 1_000 + 2; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }

  // No install ever filled the index, so the verdict resolves the only
  // honest way it can.
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the hold was talked out of going loud",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, [true, false]);
  assert.equal(
    world.chip(),
    "not_encrypted",
    "the chip the user reads is not red",
  );
});

test("🔴 a missing key raised INSIDE a rotation window takes the same bound, not the cancellable escalation", async (t) => {
  // `classifyEncryptionError`'s rotation-window arm used to win this race and
  // hand the error to `#armResecureEscalation`, whose timer the SFU's echo
  // cancels — and whose "resecuring" never reached the chip at all. In a
  // 3-party call the arm is not rare: every member's leave-grace expires
  // together, so a member that loses the race to serve the Remove sits inside
  // a 12 s `arbitration` window across exactly the join race.
  const world = await threeParty(t, "ch-inwindow");
  await world.commit(1); // opens a rotation window (the install settle)
  await flush();
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 2); // an index we do not hold
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.holds, [true], "the rotation arm shadowed the hold");

  for (let i = 0; i < JOIN_RACE_DEFER_MS / 1_000 + 2; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 a local key install and the SFU echo TOGETHER still do not answer a hold", async (t) => {
  // The two things that cancel `#resecureTimer`, applied at once. A local key
  // install runs `#onLocalKeyInstalled` and `#clearResecureTimer` with it, and
  // the echo is the signal that made the reverted attempt unsound. Neither is
  // evidence about the index THIRD is actually sending at, and their sum is
  // not either.
  const world = await threeParty(t, "ch-otherinstall");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 2); // THIRD at index 2
  assert.deepEqual(world.holds, [true]);

  await advance(t, 1_000);
  await world.commit(1); // installs index 1 for everyone; index 2 untouched
  world.session.noteEncryptionRecovered();
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");

  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "an install plus an echo answered the hold",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 a binding that cannot render the amber gets the strict verdict, not an invisible one", async (t) => {
  // The amber is the whole reason a deferral is not the reverted attempt.
  // `onMediaHold` is an optional interface member, so a binding without it
  // must fail CLOSED rather than defer into a green chip.
  const world = await threeParty(t, "ch-nohold", (w) => {
    w.holdsSupported = false;
  });
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, []);
});

test("🔴 ...including inside a rotation window, where falling through would reach the cancellable arm", async (t) => {
  // The fall-through case: with a rotation window open, a missing key that
  // cannot be held would otherwise land in `#armResecureEscalation` — whose
  // bound the SFU's echo cancels, and whose state this binding cannot render
  // either. There is no honest way to stay open, so the strict verdict wins.
  const world = await threeParty(t, "ch-nohold-window", (w) => {
    w.holdsSupported = false;
  });
  await world.commit(1); // opens a rotation window (the install settle)
  await flush();
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 2);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("the deadline runs from the FIRST error: a stream of missing keys cannot walk the bound forward", async (t) => {
  const world = await threeParty(t, "ch-stream");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);

  // Re-raise the same pair every second for most of the window. Refreshing
  // the deadline on each would push the verdict out indefinitely.
  for (let i = 0; i < JOIN_RACE_DEFER_MS / 1_000 - 1; i++) {
    await advance(t, 1_000);
    world.session.noteEncryptionError(world.missingKey(THIRD_ID, 1));
  }
  assert.deepEqual(world.loudSince(before), []);
  await advance(t, 1_500);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the bound moved with the errors",
  );
});

test("section 8's plain-departure race: the window outlives the leave-grace entry the Remove deletes", async (t) => {
  const world = await threeParty(t, "ch-departure");
  // PEER leaves for good. The grace timer DELETES its own entry before
  // calling `#removeMember`, so a predicate reading `#leaveGrace` is blind
  // for the whole Remove — stage, submit, propagate, apply. That is the seat
  // section 8 found uncovered, and it is where the bystander race lands next.
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.roster = world.roster.filter((m) => m !== PEER);
  world.session.onParticipantLeft(PEER_ID);
  await advance(t, LEAVE_GRACE_MS + 1_000); // the grace fired; the entry is gone

  const before = world.states.length;
  world.session.noteEncryptionError(world.missingKey(THIRD_ID, 1));
  await flush();
  assert.deepEqual(
    world.loudSince(before),
    [],
    "a missing key during the Remove still latched at once",
  );
  assert.deepEqual(world.holds, [true]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("no observed membership change and no rotation window: a missing key latches loud at once, as on main", async (t) => {
  const world = await threeParty(t, "ch-nochange");
  const before = world.states.length;
  // Nothing joined, nothing left, no rotation in flight: an index this device
  // does not hold, with nothing that could explain it.
  const error = world.missingKey(THIRD_ID, 1);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, [], "a hold was armed with nothing in flight");
});

test("an InvalidKey during an observed rejoin is untouched: the withheld-key legs keep latching at once", async (t) => {
  const world = await threeParty(t, "ch-invalidkey");
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.session.onParticipantLeft(PEER_ID);
  await flush();
  world.sfu = [...world.sfu, PEER_ID];
  world.session.onParticipantJoined(PEER_ID);
  await flush();

  const before = world.states.length;
  // The decoy/withheld-key failure the live rig injects. It names no
  // participant and the key it holds is WRONG, not missing — `hard`, so no
  // hold may cover it (legs 9 and 11 assert the chip goes red on it).
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.deepEqual(world.holds, []);
});

test("🔴 a sender leaving SUSPENDS its hold; coming back with the index still unfilled re-arms it", async (t) => {
  // Absence must not RESOLVE a hold. The worker never prunes a participant's
  // key handler, so the index it marked invalid is still invalid when that
  // identity returns — and the SFU controls the roster, so a spurious
  // departure would otherwise be a free pass back to green.
  const world = await threeParty(t, "ch-senderleft");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  // A full LiveKit reconnect empties `remoteParticipants`, so every sender
  // reads as absent. That must change nothing at all (the M2 shape).
  const sfuBefore = [...world.sfu];
  world.connected = false;
  world.sfu = [SELF_ID];
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true], "an emptied SFU set moved the hold");
  world.connected = true;
  world.sfu = sfuBefore;
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true]);

  // Now THIRD drops off the SFU while STILL holding its leaf: no frames of
  // its are at risk, so the deadline is SUSPENDED — the chip stays amber and
  // nothing goes loud, however long it stays away.
  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  await world.session.reconcileNow();
  await flush();
  await advance(t, JOIN_RACE_DEFER_MS + 5_000);
  assert.deepEqual(world.loudSince(before), [], "a suspended hold still fired");
  assert.deepEqual(world.holds, [true], "a departure resolved the hold");

  // THIRD returns, still sending at an index we never filled: the deadline is
  // re-armed and reaches its honest verdict.
  world.sfu = [...world.sfu, THIRD_ID];
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched on re-arm");
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
});

test("🔴 flapping presence cannot walk the bound: a re-arm gets the REMAINING budget", async (t) => {
  // Suspension parks the deadline, so a peer whose connection flaps faster
  // than the bound — or a hostile SFU minting departures — would keep the
  // loud verdict permanently deniable if each re-arm started a fresh window.
  // Five cycles of 6 s armed is 30 s of exposure against a 20 s bound.
  const world = await threeParty(t, "ch-flap");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  for (let i = 0; i < 5 && world.loudSince(before).length === 0; i++) {
    await advance(t, 6_000); // armed
    world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
    await world.session.reconcileNow(); // suspend, banking the remainder
    await flush();
    world.sfu = [...world.sfu, THIRD_ID];
    await world.session.reconcileNow(); // re-arm on what is LEFT
    await flush();
  }
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "each re-arm refreshed the bound instead of continuing it",
  );
});

test("a sender removed from the GROUP resolves its hold: that index can never be filled", async (t) => {
  // The mirror of the bug being fixed. A device with no leaf holds no key of
  // this group and gets no future one, so a hold on it has no verdict left to
  // reach — and left suspended it would pin the chip amber for the rest of an
  // otherwise healthy call. Judged on the verified roster, not the SFU set.
  const world = await threeParty(t, "ch-removed");
  const before = world.states.length;
  await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  world.sfu = world.sfu.filter((id) => id !== THIRD_ID);
  world.roster = world.roster.filter((m) => m !== THIRD);
  await world.commit(1, [THIRD]); // the Remove epoch lands
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true, false], "the hold outlived the Remove");
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 the heal does not clear while the named peer has moved on to another unfilled index", async (t) => {
  // The defect the media-E2EE review of `ae15b2db` found. `errorSinceInstall`
  // cannot see that peer: the ledger's advance rule forgives the later pair
  // the moment an install advances us for that sender, and the worker emits
  // nothing more once it has silenced an index. Re-validating the index the
  // LATCH named is then no witness at all — the peer is two epochs ahead and
  // its every frame is being dropped.
  const world = await threeParty(t, "ch-heal-movedon");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 1); // THIRD at epoch 1
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  // THIRD moves on to epoch 2 while we are still behind.
  world.session.noteEncryptionError(world.missingKey(THIRD_ID, 2));
  await flush();

  // Our copy of commit 1 lands: it fills index 1 (the one the latch named) and
  // sweeps the index-2 record through the advance rule.
  await advance(t, 1_000);
  await world.commit(1);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.clearsSince(before),
    [],
    "healed to green while that peer's frames were dropped at index 2",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 a HARD error inside a rotation window is not the SFU's to clear either", async (t) => {
  // The other half of the shadowing problem. Missing keys now always take the
  // hold, but an `InvalidKey` raised inside a rotation window still goes to
  // `#armResecureEscalation` — and that timer was cancellable by
  // `noteEncryptionRecovered()`, i.e. by ANY participant's SFU-declared
  // encryption status. One echo turned a hard failure into a green chip over
  // an index the worker had marked invalid: the reverted attempt's posture,
  // reached without touching a missing key at all. A hard error reports a key
  // that STAYS wrong until the next epoch, so only a local install may end it.
  const world = await threeParty(t, "ch-hard-inwindow");
  await world.commit(1); // an Add rotation: grace + settle = a 4 s window
  // Past the 2 s Add-grace, so the DEFERRED local install has already run and
  // cannot clear the escalation later — that clear is legitimate and local,
  // and would mask what this spec is about — but still inside the window.
  await advance(t, 2_500);
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), []);
  assert.deepEqual(world.holds, [true], "the chip was not driven amber");

  for (let i = 0; i < 13; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the echo cleared a media-plane escalation",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 the loud verdict is REPORTED before the amber is dropped", async (t) => {
  // `state.tsx` writes `callMediaHold` and `callEncryptionError` unbatched, so
  // dropping the amber first leaves an intermediate state with neither set,
  // in which `chipState` computes a green. No paint happens between them, but
  // an effect or a live-leg sampler can read it.
  const world = await threeParty(t, "ch-order");
  await bystanderRaceAfterRejoin(world, 1);
  const from = world.events.length;
  await advance(t, JOIN_RACE_DEFER_MS + 1_000);
  const tail = world.events.slice(from);
  assert.ok(tail.includes("state:loud"), `no loud in ${tail.join(",")}`);
  assert.ok(tail.includes("hold:false"), `no amber drop in ${tail.join(",")}`);
  assert.ok(
    tail.indexOf("state:loud") < tail.indexOf("hold:false"),
    `the amber was dropped before the loud landed: ${tail.join(",")}`,
  );
});

test("🔴 a device Welcomed into a call PAST epoch 16 still resolves its hold", async (t) => {
  // An earlier cut gated the pair witnesses on `#installEpoch >=
  // WORKER_KEYRING_SIZE` — the GROUP's epoch, not this worker's ring
  // occupancy. A device Welcomed at epoch 20 has filled ONE slot and nothing
  // of its is stale, yet the guard disabled the fix from its first install and
  // turned every join race into a guaranteed loud latch, on exactly the
  // receiver role the live legs use. The worker raises a decode missing key
  // only for an EMPTY slot and no path ever empties one, so a pair this side
  // has since filled cannot be a stale generation's: the epoch never enters.
  const world = newWorld(t, "joiner", "ch-late-join", (w) => w.withThird());
  await bringUpJoiner(t, world, 20);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 5_000);
  const before = world.states.length;
  await bystanderRaceAfterRejoin(world, 21); // index 21 mod 16 = 5
  assert.deepEqual(world.holds, [true]);

  await advance(t, 1_000);
  await world.commit(21); // fills index 5 for every sender
  await flush();
  assert.deepEqual(world.holds, [true, false], "the hold never resolved");
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 an ex-member that is STILL PUBLISHING does not resolve its hold", async (t) => {
  // A roster departure resolves a hold because a device with no leaf gets no
  // future key, so the index it failed at can never be filled. That is only
  // true once its frames are gone too: a device whose leaf was removed while
  // it stays connected is still sending into an index the worker marked
  // invalid, and resolving there was a green chip over exactly that — and
  // DS-schedulable, by relaying any Remove for the bystander (media-E2EE
  // review, 2026-09-08).
  const world = await threeParty(t, "ch-exmember-live");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  // THIRD loses its leaf but keeps its SFU connection and its tracks.
  world.roster = world.roster.filter((m) => m !== THIRD);
  await world.session.reconcileNow();
  await flush();
  assert.deepEqual(world.holds, [true], "an SFU-present ex-member resolved it");

  await advance(t, JOIN_RACE_DEFER_MS);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the hold was resolved instead of reaching its verdict",
  );
});

test("🔴 a media escalation is not cancelled by a later LOCAL key install", async (t) => {
  // `#clearResecureTimer` used to cancel whatever timer was pending, whoever
  // asked. Our own key install is no evidence at all about a peer's wrong key,
  // and neither is a correction to our own publication declaration — the two
  // other callers. The escalation now carries a cancel token fixed at the arm,
  // and only a clearer presenting the same token may cancel it.
  const world = await threeParty(t, "ch-token");
  await world.commit(1); // an Add rotation: grace + settle = a 4 s window
  await advance(t, 2_500); // past the grace, so its own install is done
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.holds, [true]);

  // A whole new epoch installs — `#onLocalKeyInstalled` runs with it.
  await advance(t, 1_000);
  await world.commit(2);
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");
  await advance(t, 12_000);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "a local key install cancelled a peer's media escalation",
  );
});

test("🔴 a Welcome joiner's pre-Welcome missing keys do not disable its heal", async (t) => {
  // A device joined by Welcome hears the members' frames before it holds any
  // key, and native snapshots `previous` only across a commit it applied, so
  // those pairs can NEVER be filled. Counting them as "this sender still has
  // an unfilled index" pinned the bystander heal off for the life of the
  // group — on exactly the receiver role leg 3a used, turning the fix into a
  // permanent red there (media-E2EE review, 2026-09-08). `#missing` carries
  // the same H1 exemption.
  const world = newWorld(t, "joiner", "ch-joiner-heal", (w) => w.withThird());
  await bringUpJoiner(t, world, 5, () => {
    // Heard at epoch 4, before our first key: unfillable forever.
    world.session.noteEncryptionError(world.missingKey(THIRD_ID, 4));
  });
  await world.session.reconcileNow();
  await flush();
  await advance(t, 5_000);

  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 6);
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  await advance(t, 1_000);
  await world.commit(6); // fills index 6 — the index the latch named
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.clearsSince(before),
    [{ state: "clear", error }],
    "an unfillable pre-Welcome pair held the heal off",
  );
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 a media latch does not subsume the CONTROL escalation, which still reaches its own deadline", async (t) => {
  // `#latchLoud` force-cleared every pending escalation, so a media verdict
  // destroyed the bound on correcting our OWN publication declaration: the SFU
  // kept that publication on record as NONE — every receiver disarms its
  // cryptor for us — with nothing left to escalate, and the documented
  // "a control failure never heals" upgrade became unreachable from the timer
  // that was supposed to trigger it (media-E2EE review, 2026-09-08).
  const world = await threeParty(t, "ch-control-survives");
  await world.commit(1);
  await advance(t, 2_500);
  const before = world.states.length;

  // A peer's hard failure arms the media escalation...
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  // ...then an unmute arms `control`, with the republish held open so it
  // cannot correct itself.
  await advance(t, 1_000);
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();

  // The media escalation reaches its deadline first: a MEDIA latch.
  await advance(t, 9_500);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // The control escalation must still be pending, and reach its own deadline.
  await advance(t, 2_000);
  const control = world
    .loudSince(before)
    .map((s) => s.error)
    .find((e) => e !== error && e !== undefined);
  assert.ok(control, "the media latch swallowed the control escalation");
  // The upgrade emission, pinned. It is ONE `loud` naming the media error it
  // `replaces` — `state.tsx` swaps the latched object in a single write — and
  // it carries `mediaKeyed: false` WITHOUT re-snapshotting: the media plane
  // already FAILED at the original latch, so a keyed-looking send side now
  // proves nothing and the chip must never soften to "can't verify" over a
  // plane the worker reported broken (kills `chip-upgrade-reads-keyed`). The
  // media latch reads `mediaKeyed: false` here too: our declaration was on
  // the SFU's record as plaintext when it latched (`!#localDeclarationPlain`),
  // and row 3 reads a media latch `not_encrypted` regardless.
  assert.deepEqual(
    world.states.slice(before).filter((s) => s.state === "loud"),
    [
      { state: "loud", error, meta: { origin: "media", mediaKeyed: false } },
      {
        state: "loud",
        error: control,
        meta: { origin: "control", mediaKeyed: false, replaces: error },
      },
    ],
  );
  // No clear for the media error — not before the upgrade, not as part of
  // it. The old clear(previous) + loud(error) pair had a two-write window
  // with NO latch at all; the single emit has none.
  assert.deepEqual(
    world.clearsSince(before).filter((c) => c.error === error),
    [],
    "the upgrade cleared the media error in a separate write",
  );

  // ...and the upgraded latch never heals, however the peers churn. (The
  // upgrade names the media error it replaces rather than clearing it, so the
  // question is whether the CONTROL error is ever cleared.)
  const sinceUpgrade = world.states.length;
  world.sfu = [SELF_ID];
  world.roster = [SELF];
  await world.commit(2, [PEER, THIRD]);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.ok(
    !world.clearsSince(sinceUpgrade).some((c) => c.error === control),
    "a control-upgraded latch healed",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
  // 🔴 The upgrade must not cost the user the banner. `state.tsx` latches
  // first-wins and clears on identity, so an upgrade written as a clear of
  // the superseded media error plus a fresh loud once wiped the signal: red
  // chip with a Leave / Stay-unencrypted banner became amber with neither,
  // while the session stayed latched. The single `replaces` write cannot.
  assert.equal(world.chip(), "not_encrypted", "the upgrade wiped the UI latch");
  release();
});

test("🔴 a remote peer's SFU-declared status does not cancel the bound on OUR declaration", async (t) => {
  // The last un-evidenced cancel in the file. `noteEncryptionRecovered` fires
  // on ANY participant's `participantEncryptionStatusChanged(encrypted=true)`
  // and used to clear the `control` escalation — so one peer reporting itself
  // encrypted destroyed the bound on correcting a publication the SFU still
  // had on record as NONE, which every receiver disarms its cryptor for.
  const world = await threeParty(t, "ch-control-echo");
  const before = world.states.length;
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  assert.deepEqual(world.holds, [true], "no control escalation was armed");

  for (let i = 0; i < 13; i++) {
    world.session.noteEncryptionRecovered();
    await advance(t, 1_000);
  }
  assert.equal(
    world.loudSince(before).length,
    1,
    "a peer's declared status cancelled the control bound",
  );
  assert.equal(world.chip(), "not_encrypted");
  // The seam's latch, pinned: CONTROL origin (what the SFU records for our
  // own publications is nothing a later epoch could disprove) and
  // `mediaKeyed: false` — the snapshot's `!#localDeclarationPlain` conjunct:
  // our declaration was still on the SFU's record as plaintext when the
  // deadline latched. E2EE was on and a frame key was installed, so without
  // that conjunct this latch would read keyed.
  const [seam] = world.states.slice(before).filter((s) => s.state === "loud");
  assert.deepEqual(seam.meta, { origin: "control", mediaKeyed: false });
  // And row 4 stays unreachable from it however the OTHER inputs move: the
  // SFU's record flipping to GCM after the latch (the held republish landing
  // late) satisfies `localPublicationsEncrypted`, and the chip must still not
  // soften to "can't verify" — the latch itself carries the fact that this
  // device was publishing under a plaintext declaration.
  world.localPublications = [
    { trackSid: "TR_local", encryption: ENCRYPTION_TYPE_GCM },
  ];
  assert.equal(
    world.chip(),
    "not_encrypted",
    "a late GCM record softened the declaration-seam red",
  );
  world.declarePlaintext(); // back to the seat the held republish corrects
  release();
});

test("🔴 the heal holds while ANOTHER present peer still has an index we never filled", async (t) => {
  // `originatingPairRefilled` answers a question about the latch's own sender.
  // A different present peer silenced earlier is invisible to
  // `errorSinceInstall`, because the ledger's advance rule forgives its pair
  // the moment any install advances us for that sender — so the heal could go
  // green while that peer's frames were still being dropped.
  const world = await threeParty(t, "ch-unfilled-elsewhere");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 1);
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);
  // PEER is silenced at an index nothing in this call will ever fill.
  world.session.noteEncryptionError(world.missingKey(PEER_ID, 9));
  await flush();

  // Epoch 1 fills index 1 for everyone, so the LATCH's own pair is answered.
  await advance(t, 1_000);
  await world.commit(1);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.clearsSince(before),
    [],
    "healed while another present peer was still being dropped",
  );
  assert.equal(world.chip(), "not_encrypted");
});

test("a loud latch from another cause supersedes every open hold", async (t) => {
  const world = await threeParty(t, "ch-supersede");
  await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);

  const before = world.states.length;
  const hard = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(hard);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error: hard }]);
  assert.deepEqual(world.holds, [true, false]);

  // The superseded hold's own deadline must not fire a second latch under
  // the first (`#latchLoud` early-returns, but the timer must be gone).
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error: hard }]);
});

test("the heal clears a bystander latch once this side installs the exact index the error named", async (t) => {
  // The other half of the fix (rejoin plan section 7.4(b)), in the corrected
  // form. A missing key NAMES its participant, so `#loudPeers` is the
  // bystander that raised it — and `loudHealVerdict` needs that device to
  // leave or re-publish with all-new SIDs, which a bystander never does. Once
  // this side pushes the exact pair, `setKey` re-validates that index and any
  // surviving failure re-emits inside the settle, so the latch has a witness
  // it can actually produce.
  const world = await threeParty(t, "ch-heal-refill");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 1);
  world.session.noteEncryptionError(error); // no window: latches at once
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  await advance(t, 1_000);
  await world.commit(1); // fills index 1 for every sender, THIRD included
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.clearsSince(before), [{ state: "clear", error }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("🔴 a control escalation cannot swallow a peer's decrypt failure", async (t) => {
  // The fourth silent-green route, and it needed no attacker. One shared
  // escalation timer meant the reuse guard decided which cancel token a
  // pending escalation carried: a routine unmute arms `control` and awaits its
  // republish, a peer's failure lands in that window and gets no escalation of
  // its own, and the republish's correction — evidence about OUR publications
  // only — then cancelled it. Separate escalations per reason cannot be traded
  // for each other.
  const world = await threeParty(t, "ch-control-swallow");
  await world.commit(1); // an Add rotation: a 4 s window
  await advance(t, 2_500); // past the grace, so its own install is done

  // The unmute: a publication lands NONE-declared, and the republish is held
  // open so the `control` escalation is genuinely pending.
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  const before = world.states.length;

  // A peer's hard decrypt failure, inside the rotation window.
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();

  release(); // the republish lands GCM and corrects the declaration
  await flush();
  assert.deepEqual(world.loudSince(before), [], "it latched early");

  await advance(t, 13_000);
  assert.deepEqual(
    world.loudSince(before),
    [{ state: "loud", error }],
    "the declaration correction cancelled a peer's escalation",
  );
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 ...and a control escalation cannot make a media latch unhealable either", async (t) => {
  // The mirror ordering. The old shared `#resecureOrigin` upgraded to
  // `control` the moment a control arm fired, so a media error that latched
  // afterwards was recorded as a control latch — and `loudHealVerdict` refuses
  // to heal those. One routine unmute overlapping a rotation turned a
  // recoverable red into a permanent one.
  const world = await threeParty(t, "ch-origin-poison");
  await world.commit(1);
  await advance(t, 2_500);
  const before = world.states.length;

  // The media escalation first...
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  // ...then the unmute arms `control` on top of it.
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  release();
  await flush();

  await advance(t, 13_000);
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // The latch must still be a MEDIA latch: the peers leaving are a witness
  // the heal can act on. An InvalidKey names nobody, so the witness set is
  // EVERY remote that was present — both of them have to go.
  await advance(t, 1_000);
  world.sfu = [SELF_ID];
  world.roster = [SELF];
  await world.commit(2, [PEER, THIRD]);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  // The declaration correction also reports a bare clear; what matters is
  // that the LATCH's own error was cleared, which only a media latch can do.
  assert.ok(
    world.clearsSince(before).some((c) => c.error === error),
    "the latch was recorded as control and could never heal",
  );
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("a pair RE-PUSHED after the latch is a witness, even though it was filled before", async (t) => {
  // Every install carries the previous epoch's keys as well, and a `setKey`
  // for an index calls `resetKeyStatus` on it — so re-pushing a slot genuinely
  // re-validates it. The ledger therefore stamps a pair with its LATEST fill,
  // not its first: a stamp frozen at the first fill would make this witness
  // false forever from epoch 16 on, once the ring starts reusing indexes, and
  // the bystander heal would expire silently on any long call (media-E2EE
  // review, 2026-09-08).
  const world = await threeParty(t, "ch-heal-repush");
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 0); // index 0 was filled at epoch 0
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // Epoch 1's install carries epoch 0 as `previous`, re-pushing index 0.
  await advance(t, 1_000);
  await world.commit(1);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.clearsSince(before), [{ state: "clear", error }]);
  assert.equal(world.session.callMode().kind, "e2ee");
});

test("...but a pair filled BEFORE the latch is no witness at all", async (t) => {
  // The negative control, and the reverted attempt's exact mistake: it asked
  // whether the pair had EVER been pushed, which is true from the moment the
  // install posts — and the worker raises the error precisely BECAUSE that
  // `setKey` had not been processed yet, so the clause was already true at
  // latch time and healed the latch it was meant to judge.
  const world = await threeParty(t, "ch-heal-prefill");
  // Epoch 1's install carries epoch 0 as `previous`, so it re-pushes index 0
  // — a genuine re-validation. Latch AFTER it, so the pair's newest fill is
  // strictly BEFORE the latch.
  await world.commit(1);
  await advance(t, 5_000); // past the grace AND the settle: no window open
  const before = world.states.length;
  const error = world.missingKey(THIRD_ID, 0);
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.loudSince(before), [{ state: "loud", error }]);

  // Epoch 2 carries epoch 1 as `previous`, so it touches indexes 2 and 1 and
  // never index 0. THIRD never churns, so the latch has no witness at all.
  await advance(t, 1_000);
  await world.commit(2);
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(world.clearsSince(before), []);
  assert.equal(world.session.callMode().kind, "negotiating");
});

test("🔴 gate (d): a peer whose frames the worker is DROPPING takes the chip amber with NO verdict object anywhere", async (t) => {
  // This is the spec the whole change exists for. Six review rounds each found
  // the same posture — a green chip while a peer's frames were being discarded
  // at an index the worker had marked invalid — in a DIFFERENT place, because
  // green was the DEFAULT: the chip went amber only while a verdict OBJECT
  // happened to exist, so every defect was "a verdict was destroyed without
  // evidence" or "one was never created".
  //
  // Here the session's verdict machinery is completely silent: no error was
  // raised, no hold is open, no escalation is pending, nothing is latched. The
  // chip goes amber anyway, on the worker's measurement alone.
  const world = await threeParty(t, "ch-witness-drop");
  const before = world.states.length;
  const holdsBefore = world.holds.length;
  assert.equal(world.chip(), "e2ee");

  world.dropFrames(THIRD_ID);

  assert.equal(
    world.chip(),
    "resecuring",
    "the chip stayed green over frames the worker was discarding",
  );
  assert.deepEqual(world.loudSince(before), [], "gate (d) produced a verdict");
  assert.deepEqual(world.clearsSince(before), []);
  assert.equal(
    world.holds.length,
    holdsBefore,
    "gate (d) armed a hold — it must only WITHHOLD the green",
  );
  assert.equal(world.session.callMode().kind, "e2ee");

  // And it lifts the moment the worker stops discarding, without anything
  // having to clear a verdict — there was never one to clear.
  world.dropFrames();
  assert.equal(world.chip(), "e2ee");
});

test("🔴 gate (d): losing the worker's heartbeat is AMBER, not green", async (t) => {
  // A build that shipped without the livekit-client patch reaches exactly this
  // state. It must cost the green, loudly, rather than silently removing the
  // gate and leaving the chip reading exactly as it did before the fix.
  const world = await threeParty(t, "ch-witness-lost");
  assert.equal(world.chip(), "e2ee");
  world.loseWitness();
  assert.equal(
    world.chip(),
    "resecuring",
    "a witness we cannot read was treated as a witness that passed",
  );
});

test("gate (d) is independent of the join-race hold: a resolved hold still needs the witness", async (t) => {
  // The two mechanisms must not stand in for each other. A hold that resolves
  // correctly returns the chip to green ONLY because the witness is also clean;
  // with the worker still discarding that peer's frames it stays amber.
  const world = await threeParty(t, "ch-witness-vs-hold");
  const before = world.states.length;
  const error = await bystanderRaceAfterRejoin(world, 1);
  assert.deepEqual(world.holds, [true]);
  assert.equal(world.chip(), "resecuring");

  // The worker is still dropping THIRD's frames when our install lands.
  world.dropFrames(THIRD_ID);
  await advance(t, 1_000);
  await world.commit(1);
  await flush();

  assert.deepEqual(world.holds, [true, false], "the hold never resolved");
  assert.deepEqual(world.loudSince(before), []);
  assert.equal(
    world.chip(),
    "resecuring",
    "a resolved hold took the chip green while frames were still being dropped",
  );
  void error;

  world.dropFrames();
  assert.equal(world.chip(), "e2ee");
});

test("🔴 gate (b): a publisher LiveKit has NOT vouched for holds the chip amber", async (t) => {
  // Our OWN publication, which is the case that shipped green in desktop
  // 0.57.0: the worker says the cryptor is on, the SFU's record says nothing,
  // and every receiver arms from the SFU's record. This harness could not
  // state it until the chip assembly was shared — its copy excluded SELF from
  // the publishers gate (b) judges, so gate (b) was modelled over remotes only.
  const world = await threeParty(t, "ch-unobserved");
  assert.equal(world.chip(), "e2ee");

  world.markUnobserved(SELF_ID);
  assert.equal(
    world.chip(),
    "resecuring",
    "a publisher with no observed status was vouched for anyway",
  );
});

test("🔴 gate (c): an unverified roster member holds the lock open", async (t) => {
  // Not a media-plane ladder — it is here because this harness could not
  // EXPRESS it until the chip assembly was shared. It hardcoded every member
  // verified, so every green these suites assert was taken with gate (c)
  // pre-satisfied, and a regression that dropped the verification read would
  // have been invisible to all of them.
  const world = await threeParty(t, "ch-unverified");
  assert.equal(world.chip(), "e2ee");

  world.markUnverified(THIRD_ID);
  assert.equal(
    world.chip(),
    "e2ee_unverified",
    "an unverified member did not hold the verified lock open",
  );

  // ...and gate (c) only withholds the VERIFIED claim; the media plane's amber
  // still outranks it.
  world.dropFrames(THIRD_ID);
  assert.equal(
    world.chip(),
    "resecuring",
    "the media plane's amber must still win over an unverified lock",
  );
});

// ---- The loud split: a KEYED control latch reads "can't verify" ------------
//
// Every `loud` carries `{ origin, mediaKeyed }`, snapshotted by `#latchLoud`
// before `loudModeFallback` folds the mode. `chipState` reads `cannot_verify`
// from exactly one rule: a CONTROL latch taken while this device was keyed,
// with its local publications on the SFU's record as GCM and the decode
// witness dropping nothing. `sessionState === "failed"` sits BELOW the latch
// rules because `#onLoud` sets `failed` BEFORE it calls `#latchLoud` — so the
// keyed mid-call `#onLoud` sites reach that rule, and the un-keyed ones (the
// re-establish caps, which wipe the keys first) do not.

/** `MAX_REESTABLISH` (`mlsCallSession.ts`, not exported): the fourth is the cap. */
const REESTABLISH_CAP = 3;

test("🔴 a DS arbitration classified `failed` mid-call latches KEYED: the chip reads cannot_verify, and only the decode witness can turn it not_encrypted", async (t) => {
  // An established, keyed creator admits a joiner: the admit commit is staged
  // and submitted, and a hostile DS answers a 409 whose body says `Won` —
  // `classifyArbitration` → `failed` → `#safeCommitLost` + `#onLoud`. The
  // session is `failed` and the latch is a CONTROL one taken while this
  // device was keyed: E2EE on, a frame key installed, nothing declared
  // plaintext. Nothing says the media plane failed; the group can no longer
  // be vouched for. That is "we can't confirm", not "not encrypted".
  const world = newWorld(t, "creator", "ch-arbitration-failed");
  await bringUpCreator(t, world);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 3_000); // past the immediate-install rotation settle (2 s)
  assert.equal(world.chip(), "e2ee");
  const before = world.states.length;

  world.answerSubmitOnce({ kind: "conflict", body: { result: "Won" } });
  await world.joinRequest(THIRD); // not in this two-party roster
  await advance(t, 1); // the admit's 0 ms leaf stagger: claim, stage, submit
  assert.equal(world.submits(), 1, "the admit never submitted");
  assert.equal(world.submitAnswer, null, "the hostile answer was never taken");
  // The `failed` arm: the staged commit is discarded and nothing is merged.
  assert.deepEqual(world.commitLosts, [GROUP]);
  assert.equal(
    world.bridgeCalls.filter((n) => n === "callCommitWon").length,
    0,
  );
  assert.equal(world.session.state(), "failed");
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false, "the banner's pause claim is false");

  // ONE loud, control-origin, KEYED — the snapshot `#latchLoud` takes before
  // the mode folds to `negotiating` (after which `#e2eeEnabled` reads false).
  const louds = world.states.slice(before).filter((s) => s.state === "loud");
  assert.equal(louds.length, 1);
  const [latched] = louds;
  const error = latched.error;
  assert.ok(error instanceof Error, "the arbitration latched no error");
  assert.match(error.message, /409 commit without a winner/);
  assert.deepEqual(latched.meta, { origin: "control", mediaKeyed: true });

  assert.equal(
    world.chip(),
    "cannot_verify",
    "a keyed control failure read as a media-plane failure",
  );
  assert.equal(world.terminalLoud(), true, "no banner on cannot_verify");

  // 🔴 The witness may only CONTRADICT a green, and here it may only harden
  // the red: a peer whose frames the worker is dropping makes this "not
  // encrypted", and lifting the drop returns it to "can't verify"...
  world.dropFrames(PEER_ID);
  assert.equal(
    world.chip(),
    "not_encrypted",
    "a dropping witness left the chip at cannot_verify",
  );
  world.dropFrames();
  assert.equal(world.chip(), "cannot_verify");
  // ...while an UNAVAILABLE witness cannot support the positive claim "not
  // encrypted" either: "we can't confirm" is exactly what unavailable means.
  world.loseWitness();
  assert.equal(world.chip(), "cannot_verify");
  world.witnessAvailable = true;

  // Terminal: nothing heals a control latch, and no later verdict lands.
  await advance(t, JOIN_RACE_DEFER_MS * 2);
  assert.deepEqual(
    world.states
      .slice(before)
      .filter((s) => s.state === "loud" || s.state === "clear"),
    louds,
  );
  assert.equal(world.session.state(), "failed");
  assert.equal(world.chip(), "cannot_verify");
  assert.equal(world.terminalLoud(), true);
});

test("CONTROL — the re-establish cap is NOT keyed: `#resetGroupBuffers` wipes the keys before the cap, so its red reads not_encrypted", async (t) => {
  // The cap (`#rejoinFresh`: `re-establish limit reached`) is an `#onLoud`
  // caller too, but it is reached only after `#resetGroupBuffers` ran
  // `#resetRotationState` — `#hasLocalKey = false`, E2EE off — so its
  // snapshot reads un-keyed by construction and the chip reads
  // `not_encrypted` at row 5, which is truthful there: no send key is held.
  //
  // A KEYED member drives it: a kick while still in the SFU (`#onRemovedSelf`)
  // is `#rejoinFresh` #1, whose establish conflicts onto the open group and
  // broadcasts a join intent; the DS answers `not_found` (the group closed
  // during the join), which is the direct `#rejoinFresh` #2, then #3 — and #4
  // is the cap. `#reestablishes` resets only on `#toActive`, which this chain
  // never reaches. Each intent is held so the next answer can be scripted
  // before the ladder's own retry timer runs.
  const world = newWorld(t, "joiner", "ch-reestablish-cap");
  await bringUpJoiner(t, world, 1);
  await world.session.reconcileNow();
  await flush();
  await advance(t, 3_000);
  assert.equal(world.chip(), "e2ee", "not keyed before the chain");
  const before = world.states.length;
  const intents = world.joinIntents();

  let release = world.holdJoinIntent();
  await world.removedSelf(2);
  await advance(t, 1); // `#onRemovedSelf` runs as a 0 ms group action
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.joinIntents(), intents + 1, "#1 broadcast no intent");
  for (let n = 2; n <= REESTABLISH_CAP; n++) {
    world.answerJoinIntentOnce({ kind: "not_found" });
    release();
    release = world.holdJoinIntent(); // re-held before the next intent runs
    await advance(t, 1);
    assert.equal(world.joinIntentAnswer, null, `#${n}'s answer never landed`);
    assert.equal(world.joinIntents(), intents + n, `#${n} broadcast no intent`);
    assert.equal(world.session.state(), "resecuring");
    assert.deepEqual(world.loudSince(before), [], `#${n} went loud early`);
  }
  // The third `not_found`: `#rejoinFresh` #4, which is the cap. No establish
  // runs, so no further intent.
  world.answerJoinIntentOnce({ kind: "not_found" });
  release();
  await advance(t, 1);
  assert.equal(
    world.joinIntents(),
    intents + REESTABLISH_CAP,
    "the cap ran another establish",
  );
  assert.equal(world.session.state(), "failed");
  assert.equal(world.session.callMode().kind, "negotiating");

  const louds = world.states.slice(before).filter((s) => s.state === "loud");
  assert.equal(louds.length, 1);
  const [latched] = louds;
  const error = latched.error;
  assert.ok(error instanceof Error, "the cap latched no error");
  // WHICH verdict latched: the cap, reached through the closed-group rejoin.
  assert.match(error.message, /re-establish limit reached: group closed/);
  assert.deepEqual(latched.meta, { origin: "control", mediaKeyed: false });
  assert.equal(world.chip(), "not_encrypted", "an un-keyed cap read keyed");
  assert.equal(world.terminalLoud(), true, "no banner on the cap's red");
  assert.equal(world.publishing(), false, "the banner's pause claim is false");
});
