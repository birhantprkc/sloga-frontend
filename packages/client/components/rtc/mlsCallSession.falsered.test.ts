// The ME-10 banner's central promise, as a session-level invariant.
//
// "This call's encryption could not be confirmed. Your audio and video should
// stay paused." That sentence is a claim about the publish gate, and until the
// 2026-09-08 join-race legs nothing asserted it: the
// harness binding did not implement `pausePublishing` at all, so every spec
// ran with the gate invisible and `#latchLoud`'s comment ("fail-closed: the
// banner says publishing is paused, and it is") was structurally unverified.
//
// The legs then produced the mirror of the failure this feature chases — not a
// false green but a FALSE RED with a false pause claim: a Linux seat showing
// ME-10 while the other seat recorded its publication as GCM and decrypted its
// frames for 24 minutes. So each spec here drives one way into a
// pause-promising state and asserts the session held the gate through it.
//
// Since the 2026-09-20 chip split, each spec also pins what the latch SAYS
// about itself: the `meta` that rides every `"loud"` (`origin`, and the
// send-side witness `mediaKeyed` that `#latchLoud` snapshots before the mode
// folds), and the chip `state.tsx` derives from it. A CONTROL latch taken
// while this device was keyed reads `cannot_verify`; a MEDIA latch reads
// `not_encrypted` whether or not the send side was keyed; a media→control
// upgrade is ONE emission that never re-reads keyed. The one control latch
// that is keyed on BOTH flags yet must not read so — `MissingLocalFrameKeyError`
// out of `#onRotationError` — is reached through the harness's `failLocalKeyOnce`
// seam on BOTH install paths (the fake installer's `applyKeys` composes the
// same one-shot check as its `applyLocalKey`, so the Add-grace timer and the
// Remove-immediate install each throw into their own catch), and this file
// pins that its snapshot reads un-keyed by the class exclusion alone,
// whichever catch handed it over.
//
// Scope, stated so the next reader does not over-read these: this file pins the
// SESSION's half — the reason set and the order of its edges, and the meta the
// session stamps. Whether a held gate reaches the wire is `publishGate.test.ts`.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { ENCRYPTION_TYPE_GCM } from "./localPublicationEncryption.ts";
import { MissingLocalFrameKeyError } from "./mlsCallKeys.ts";
import {
  type EncryptionStateCall,
  type World,
  advance,
  bringUpCreator,
  flush,
  GROUP,
  latchLoud,
  newWorld,
  PEER,
  PEER_ID,
  peerLeaves,
  peerRejoins,
  THIRD,
} from "./mlsCallSession.harness.ts";

/**
 * The invariant these specs exist for: while the call is in a state that
 * promises a pause, the session is holding the gate. Deliberately says nothing
 * about WHICH banner renders.
 */
function assertGateHeld(world: World, where: string): void {
  assert.equal(
    world.publishing(),
    false,
    `the gate was empty at ${where}, over a banner promising a pause`,
  );
}

/**
 * That the ME-10 banner renders at all.
 *
 * Asserted for BOTH latch origins now. Until the chip split this was pinned
 * for media latches only: a control verdict had no media-plane input and
 * painted "This call could not be secured" over a plane that may have been
 * provably keyed — the second, unfixed half of the 2026-09-08 legs — so
 * asserting it would have read as a regression the day the split landed.
 * The split gives a keyed control latch its own chip (`cannot_verify`) and
 * `callBanner` gives both loud chips a latched banner (`terminal_loud` /
 * `cannot_verify`), so the banner question and the WHICH-chip question are
 * separate: this asserts the banner; each spec pins the chip. The gate
 * assertion holds either way: a device that cannot prove who is in the call
 * must not send, whatever the banner ends up saying.
 */
function assertMe10(world: World, where: string): void {
  assert.equal(world.terminalLoud(), true, `no ME-10 banner at ${where}`);
}

/** Every `"loud"` the session emitted since `index`, WITH its meta. */
function loudsWithMeta(world: World, index: number): EncryptionStateCall[] {
  return world.states.slice(index).filter((s) => s.state === "loud");
}

/**
 * A CONTROL verdict at the DS-arbitration shape while this device is KEYED.
 * THIRD's join request schedules our admit (leaf 0 — no stagger, so one tick
 * runs it), which stages the Add and submits it; the DS answers 409 with
 * `Won`, a body no honest DS sends, which `classifyArbitration` reads as
 * `failed`. The `failed` arm runs `#safeCommitLost` — it discards only the
 * staged commit and touches no key — then `#onLoud`, which sets `failed` and
 * latches with the control default. So the snapshot `#latchLoud` takes reads
 * keyed: E2EE on, a local key held, nothing declared plaintext.
 *
 * Returns the error that latched, taken from the emission itself; the caller
 * pins the emission's shape.
 */
async function arbitrationFails(
  t: TestContext,
  world: World,
): Promise<unknown> {
  const submits = world.submits();
  const before = world.states.length;
  world.answerSubmitOnce({ kind: "conflict", body: { result: "Won" } });
  await world.joinRequest(THIRD);
  await advance(t, 1);
  assert.equal(world.submits(), submits + 1, "the admit never submitted");
  assert.equal(world.submitAnswer, null, "the 409 was never delivered");
  assert.deepEqual(world.commitLosts, [GROUP], "the failed arm did not run");
  assert.equal(world.session.state(), "failed");
  const louds = loudsWithMeta(world, before);
  assert.equal(louds.length, 1, "the arbitration failure did not latch once");
  assert.equal(
    (louds[0].error as Error).message,
    "409 commit without a winner",
    "a different verdict latched",
  );
  return louds[0].error;
}

test("a media latch after the mode reached e2ee re-asserts the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr1");
  await bringUpCreator(t, world);
  // The enable flip released `negotiating`: a healthy encrypted call publishes.
  assert.equal(world.publishing(), true, "an e2ee call must publish");
  assert.equal(world.terminalLoud(), false);

  const before = world.states.length;
  const error = await latchLoud(t, world);
  assertMe10(world, "the media latch");
  assertGateHeld(world, "the media latch");
  assert.deepEqual([...world.gate], ["negotiating"]);
  // The latch names its origin, and the send-side witness it snapshotted:
  // this device WAS keyed — what failed is a peer's frames.
  assert.deepEqual(world.states.slice(before), [
    { state: "loud", error, meta: { origin: "media", mediaKeyed: true } },
  ]);
  // Row 3: a keyed media latch never softens. The plane the worker reported
  // broken is the plane the chip is about.
  assert.equal(world.chip(), "not_encrypted");
});

test("a control latch on the local-declaration seam re-asserts the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr2");
  await bringUpCreator(t, world);
  assert.equal(world.publishing(), true);
  const before = world.states.length;

  // One local publication the SFU has on record as NONE, whose republish does
  // not land: the `control` escalation arms, then latches. This is the shape
  // the legs saw — a CONTROL-plane verdict, with the media plane keyed and
  // healthy throughout (the world's `observedEncrypted` is all true).
  const release = world.holdRepublish();
  world.declarePlaintext();
  world.session.noteLocalPublicationsChanged();
  await flush();
  assert.equal(
    world.publishing(),
    false,
    "the assertion window must pause while the declaration is wrong",
  );

  await advance(t, 11_000); // past RESECURE_ESCALATE_MS
  assertGateHeld(world, "the control escalation");
  assertMe10(world, "the control escalation");
  // A control latch, but NOT keyed: the snapshot's `!#localDeclarationPlain`
  // conjunct is false by construction on this seam — the SFU records our
  // publication as NONE, so "our send side is keyed" is exactly the claim
  // this verdict refutes.
  const louds = loudsWithMeta(world, before);
  assert.equal(louds.length, 1);
  assert.deepEqual(louds[0].meta, { origin: "control", mediaKeyed: false });
  assert.equal(world.chip(), "not_encrypted");

  release();
  await flush();
  // The republish landed GCM, so `enable-window` is released — but the latch
  // is terminal, so `negotiating` stays held and the banner stays true.
  assertGateHeld(world, "the republish landing under a latched verdict");
  assertMe10(world, "the republish landing under a latched verdict");
  // Every local publication is GCM now and the witness is clean, so the
  // ONLY thing keeping this control latch off row 4 is the `mediaKeyed:
  // false` it snapshotted at the latch. A live re-read would soften it.
  assert.equal(
    world.chip(),
    "not_encrypted",
    "the declaration-seam latch softened once the republish landed",
  );
});

test("a control verdict while keyed reads cannot_verify, and only a dropping witness contradicts it", async (t) => {
  const world = newWorld(t, "creator", "chan-fr6");
  await bringUpCreator(t, world);
  assert.equal(world.publishing(), true);
  assert.equal(world.terminalLoud(), false);
  const before = world.states.length;

  const error = await arbitrationFails(t, world);
  // ONE emission, control origin, snapshotted KEYED: nothing on this path
  // wiped a key or declared a publication plaintext.
  assert.deepEqual(world.states.slice(before), [
    { state: "loud", error, meta: { origin: "control", mediaKeyed: true } },
  ]);
  assert.equal(world.session.callMode().kind, "negotiating");
  // Row 4, the one rule that yields it: control ∧ keyed ∧ every local
  // publication GCM ∧ the decode witness dropping nothing. `failed` sits
  // BELOW the latch rules (`#onLoud` set it before `#latchLoud` ran), so it
  // does not pre-empt this.
  assert.deepEqual(world.decodeWitness().dropping, []);
  assert.equal(world.chip(), "cannot_verify");
  assertMe10(world, "the keyed control verdict");
  assertGateHeld(world, "the keyed control verdict");
  assert.deepEqual([...world.gate], ["negotiating"]);

  // The witness may only CONTRADICT a soft reading, never rescue a red: a
  // sender whose frames we are dropping makes "not encrypted" the honest
  // claim. Once through the chip's arm directly, once through the modelled
  // worker window and the real reducer.
  assert.equal(
    world.chip({
      decodeWitness: { available: true, dropping: [PEER_ID], live: [] },
    }),
    "not_encrypted",
  );
  world.dropFrames(PEER_ID);
  assert.equal(world.chip(), "not_encrypted");
  assertMe10(world, "the keyed control verdict under a dropping witness");
  assertGateHeld(world, "the keyed control verdict under a dropping witness");
});

/**
 * The Add-grace local install THROWS `error`. `applyLocalKey`'s only caller
 * is `#scheduleGraceLocal`, inside the `ADD_GRACE_MS` timer an inbound Add
 * arms (remotes install now, our send key is deferred), and its catch is
 * `#onRotationError` — the one site that routes by error CLASS. Returns the
 * `states` index from before the commit; the caller pins what came out.
 */
async function graceLocalInstallThrows(
  t: TestContext,
  world: World,
  error: Error,
): Promise<number> {
  world.failLocalKeyOnce(error);
  const before = world.states.length;
  await world.commit(1); // an inbound Add at epoch 1: local install deferred
  await advance(t, 2_000); // ADD_GRACE_MS: the fenced timer runs, and throws
  await flush();
  assert.equal(world.localKeyFailure, null, "the scripted throw never fired");
  return before;
}

test("the missing-local-frame-key control latch reads mediaKeyed: false by exclusion and never cannot_verify", async (t) => {
  const world = newWorld(t, "creator", "chan-fr9");
  await bringUpCreator(t, world);
  assert.equal(world.chip(), "e2ee");
  assert.equal(world.publishing(), true);
  // Every OTHER row-4 conjunct holds explicitly: a local publication the SFU
  // records as GCM, and a witness dropping nothing. Only the snapshot's
  // class exclusion can keep this latch off row 4.
  world.localPublications = [
    { trackSid: "TR_local", encryption: ENCRYPTION_TYPE_GCM },
  ];
  assert.deepEqual(world.decodeWitness().dropping, []);

  // Native affirmatively says this device is not a sender at epoch 1 — the
  // shape a REMOVED leaf takes. `#e2eeEnabled` and `#hasLocalKey` both still
  // read true (the previous epoch's key is installed), so a snapshot on the
  // flags alone would read keyed, and be wrong: the CURRENT epoch's key is
  // exactly what is absent.
  const error = new MissingLocalFrameKeyError(GROUP, 1);
  const before = await graceLocalInstallThrows(t, world, error);
  // ONE emission, control origin, and NOT keyed — by the exclusion, not by
  // either flag. `#dropModeToNegotiating` ran before the latch, so the mode
  // folded and the gate re-asserted in lockstep.
  assert.deepEqual(loudsWithMeta(world, before), [
    { state: "loud", error, meta: { origin: "control", mediaKeyed: false } },
  ]);
  assert.equal(world.session.callMode().kind, "negotiating");
  // Row 5. Had the snapshot read keyed, this would be row 4's `cannot_verify`
  // — a "can't verify" chip over a device publishing under a key the members
  // who removed it still hold.
  assert.equal(world.chip(), "not_encrypted");
  assert.notEqual(world.chip(), "cannot_verify");
  // And it is the EXCLUSION holding it there, not the witness: with the
  // witness explicitly clean and live, the chip does not soften. A witness
  // may contradict a green; it never rescues a red.
  assert.equal(
    world.chip({
      decodeWitness: { available: true, dropping: [], live: [PEER_ID] },
    }),
    "not_encrypted",
    "a clean witness softened the missing-frame-key latch",
  );
  assertGateHeld(world, "the missing-local-frame-key latch");
  assertMe10(world, "the missing-local-frame-key latch");
  assert.deepEqual([...world.gate], ["negotiating"]);
});

test("any other failure from the Add-grace install stays on the media debounce", async (t) => {
  const world = newWorld(t, "creator", "chan-fr10");
  await bringUpCreator(t, world);
  assert.equal(world.chip(), "e2ee");
  // The routing CONTROL for the spec above: the same seam, a bare `Error`.
  // `#onRotationError` hands anything that is not a `MissingLocalFrameKeyError`
  // to `#onMediaError` — a transient inside a rotation window must not stick
  // the chip loud — so nothing latches, the mode never folds, and the
  // publish gate is not re-asserted by the session on this path.
  const error = new Error("x");
  const before = await graceLocalInstallThrows(t, world, error);
  assert.deepEqual(loudsWithMeta(world, before), [], "a bare Error latched");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.terminalLoud(), false);
  assert.deepEqual(
    world.states.slice(before).map((s) => s.state),
    ["resecuring"],
    "the bare Error did not take the media debounce",
  );

  // The debounce's own verdict, when nothing recovers it: a MEDIA latch, and
  // keyed (a bare `Error` is not excluded by class). Never a control one.
  await advance(t, 11_000); // past RESECURE_ESCALATE_MS
  assert.deepEqual(loudsWithMeta(world, before), [
    { state: "loud", error, meta: { origin: "media", mediaKeyed: true } },
  ]);
  assert.equal(world.chip(), "not_encrypted");
  assertGateHeld(world, "the escalated media debounce");
  assertMe10(world, "the escalated media debounce");
});

/**
 * The Remove-IMMEDIATE local install THROWS `error`. An inbound commit that
 * removed a device leaves the inbound memo `removed`, so the epoch classifies
 * `immediate` and `onLocalKeysChanged` installs everything at once through
 * `applyKeys` — the fake's `applyKeys` composes the same one-shot
 * `failLocalKeyOnce` check as its `applyLocalKey` — and the throw lands in
 * the immediate path's OWN catch, the second of the two sites that hand to
 * `#onRotationError`. No clock advance: nothing on this path arms a timer,
 * so a scripted failure still unspent once the commit resolves means the
 * epoch took the Add-grace path instead, and the spec would be pinning the
 * wrong catch. Returns the `states` index from before the commit.
 */
async function immediateInstallThrows(
  world: World,
  error: Error,
): Promise<number> {
  world.failLocalKeyOnce(error);
  const before = world.states.length;
  await world.commit(1, [PEER]); // an inbound Remove at epoch 1: all keys now
  assert.equal(
    world.localKeyFailure,
    null,
    "the scripted throw never fired inside the commit: not the immediate path",
  );
  return before;
}

test("the missing-local-frame-key latch off the Remove-immediate install reads mediaKeyed: false by exclusion and never cannot_verify", async (t) => {
  // Kills `rotation-immediate-local-key-reads-media`: the immediate path's
  // catch in `onLocalKeysChanged` handing to `#onMediaError(error)` instead of
  // `#onRotationError(error)`. The spec above cannot see that — its throw
  // comes out of the Add-grace timer's catch — and those two catches are the
  // ONLY callers of `#onRotationError`, so a defect in either is invisible to
  // a spec driving the other.
  const world = newWorld(t, "creator", "chan-fr11");
  await bringUpCreator(t, world);
  assert.equal(world.chip(), "e2ee");
  assert.equal(world.publishing(), true);
  // As in the Add-grace spec: every OTHER row-4 conjunct holds explicitly.
  world.localPublications = [
    { trackSid: "TR_local", encryption: ENCRYPTION_TYPE_GCM },
  ];
  assert.deepEqual(world.decodeWitness().dropping, []);

  // The shape a REMOVED leaf takes, on the path a Remove actually drives: the
  // epoch that dropped a member carries no send key for this device. Both
  // flags still read keyed from epoch 0's install.
  const error = new MissingLocalFrameKeyError(GROUP, 1);
  const before = await immediateInstallThrows(world, error);
  // ONE emission, control origin, NOT keyed — the exclusion, through the
  // other catch. `#dropModeToNegotiating` folded the mode before the latch,
  // so the gate re-asserted in lockstep. Under the mutation the class takes
  // the media debounce instead: no control latch, the mode stays `e2ee`, and
  // this device goes on publishing under epoch 0's key — the key the members
  // who removed it still hold.
  assert.deepEqual(loudsWithMeta(world, before), [
    { state: "loud", error, meta: { origin: "control", mediaKeyed: false } },
  ]);
  assert.equal(world.session.callMode().kind, "negotiating");
  // Row 5, never row 4: the same verdict as the Add-grace spec, from the
  // catch that spec never reaches.
  assert.equal(world.chip(), "not_encrypted");
  assert.notEqual(world.chip(), "cannot_verify");
  assert.equal(
    world.chip({
      decodeWitness: { available: true, dropping: [], live: [PEER_ID] },
    }),
    "not_encrypted",
    "a clean witness softened the Remove-immediate missing-frame-key latch",
  );
  assertGateHeld(world, "the Remove-immediate missing-local-frame-key latch");
  assertMe10(world, "the Remove-immediate missing-local-frame-key latch");
  assert.deepEqual([...world.gate], ["negotiating"]);
});

test("a control verdict under a media latch upgrades it in ONE emission that never re-reads keyed", async (t) => {
  const world = newWorld(t, "creator", "chan-fr7");
  await bringUpCreator(t, world);
  const media = await latchLoud(t, world);
  assert.equal(world.chip(), "not_encrypted");
  assertGateHeld(world, "the media latch");
  const before = world.states.length;

  // The session is still `active` under a media latch, so the admit runs and
  // the DS's hostile answer reaches `#onLoud` → `#latchLoud` with the control
  // default — under an EXISTING media latch: the upgrade path.
  const control = await arbitrationFails(t, world);
  // Exactly one emission, and no `clear` of the media error before it:
  // `state.tsx` latches first-wins and clears on identity, so a
  // clear(media)+loud(control) pair has a frame with NO latch at all. The
  // single `loud` names the media error as the one it `replaces`, which is
  // the only thing that lets the binding swap the latched object in place.
  assert.deepEqual(world.states.slice(before), [
    {
      state: "loud",
      error: control,
      meta: { origin: "control", mediaKeyed: false, replaces: media },
    },
  ]);
  assert.deepEqual(world.clearsSince(before), []);
  // `mediaKeyed: false` is NOT a re-snapshot — the send side is as keyed now
  // as it was at the media latch. The media plane already FAILED; a keyed
  // send side proves nothing about it, so the chip must not soften.
  assert.equal(
    world.chip(),
    "not_encrypted",
    "the upgrade softened a failed media plane to can't-verify",
  );
  assert.equal(world.session.state(), "failed");
  assertMe10(world, "the upgraded latch");
  assertGateHeld(world, "the upgraded latch");
  assert.deepEqual([...world.gate], ["negotiating"]);
});

test("a media latch taken while keyed reads not_encrypted: only its origin keeps it off row 4", async (t) => {
  const world = newWorld(t, "creator", "chan-fr8");
  await bringUpCreator(t, world);
  await advance(t, 3_000); // past the immediate-install rotation settle (2 s)
  // Every OTHER row-4 conjunct holds, explicitly rather than vacuously: a
  // local publication the SFU records as GCM, and a clean witness.
  world.localPublications = [
    { trackSid: "TR_local", encryption: ENCRYPTION_TYPE_GCM },
  ];
  assert.deepEqual(world.decodeWitness().dropping, []);
  const before = world.states.length;

  // Driven directly, not through `latchLoud`, so this spec's verdict on the
  // origin is its own and not the helper's.
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  const louds = loudsWithMeta(world, before);
  assert.equal(louds.length, 1);
  assert.equal(louds[0].error, error);
  assert.equal(louds[0].meta?.mediaKeyed, true, "the send side was keyed");
  assert.equal(
    louds[0].meta?.origin,
    "media",
    "a media-plane verdict was stamped with the control origin",
  );
  // Had the session stamped `control` here, this keyed latch would read
  // `cannot_verify` — a softer chip over the plane the worker reported
  // broken. The origin is the only input that separates the two rows.
  assert.notEqual(
    world.chip(),
    "cannot_verify",
    "a keyed media latch softened to can't-verify",
  );
  assert.equal(world.chip(), "not_encrypted");
  assertMe10(world, "the keyed media latch");
  assertGateHeld(world, "the keyed media latch");
});

test("a mix cycle under a latch never empties the gate", async (t) => {
  const world = newWorld(t, "creator", "chan-fr3", (w) => w.withThird());
  await bringUpCreator(t, world);
  await latchLoud(t, world);
  assertGateHeld(world, "the latch");

  // A bare (device-less) identity publishing in the SFU set is non-enrolled on
  // sight: T1 `mixed`. The label leaves `negotiating`, so the lockstep
  // releases that reason — `mixed` has to be holding by then.
  world.sfu = [...world.sfu, "dave"];
  world.sids.set("dave", ["TR_d"]);
  await world.session.reconcileNow();
  await flush();
  assert.equal(world.session.callMode().kind, "mixed");
  assert.equal(
    world.publishing(),
    false,
    "the mixed banner promises the same pause",
  );

  // The mix clears and the T2 warm resume runs: `#foldBeforeMixedRelease`
  // must assert `negotiating` BEFORE `mixed` is released, or the gate is empty
  // for the chained microtask between them.
  world.sfu = world.sfu.filter((id) => id !== "dave");
  world.sids.delete("dave");
  await world.session.reconcileNow();
  await flush();
  const before = world.gateLog.length;
  await advance(t, 20_000); // REUPGRADE_HYSTERESIS_MS
  assertMe10(world, "the T2 re-upgrade under a media latch");
  assertGateHeld(world, "the T2 re-upgrade under a latch");
  // The media latch survived the cycle unchanged: still row 3.
  assert.equal(world.chip(), "not_encrypted");
  assert.deepEqual(
    [...world.gate],
    ["negotiating"],
    "the T2 path left a stale reason behind",
  );
  // The ORDER, not just the resting state: a settled `{negotiating}` looks
  // identical whether the fold ran before the release or a microtask after it,
  // and only the first keeps the promise for the whole interval. No spec can
  // observe a gap it does not look for.
  assert.deepEqual(
    world.gateLog.slice(before),
    ["+negotiating", "-mixed"],
    "the gate emptied between releasing `mixed` and folding to `negotiating`",
  );
});

test("a membership churn that does not heal the latch keeps the gate held", async (t) => {
  const world = newWorld(t, "creator", "chan-fr4");
  await bringUpCreator(t, world);
  await latchLoud(t, world);

  // The peer leaves and rejoins with all-new tracks. Whatever the heal
  // verdict decides, the banner and the gate must agree afterwards.
  await peerLeaves(world, 1);
  await peerRejoins(world, 2, ["TR_new"]);
  await advance(t, 11_000); // past the heal settle
  if (world.terminalLoud()) {
    assertGateHeld(world, "the un-healed latch after a rejoin");
    // Still the media latch: a churn cannot re-origin it.
    assert.equal(world.chip(), "not_encrypted");
  } else {
    // Healed: the chip is honest again, so publishing MUST come back — an
    // unreleased reason is silent outgoing death behind a green chip.
    assert.equal(
      world.publishing(),
      true,
      "the latch healed but publishing never resumed",
    );
  }
});

test("a joiner whose enrolment never proves keeps the pre-connect gate", async (t) => {
  const world = newWorld(t, "joiner", "chan-fr5");
  void world.session.start();
  await flush();
  await advance(t, 1);
  // Still negotiating: `connect()` asserted `negotiating` before `room.connect`
  // and the session has not reached a verdict, so nothing has released it.
  assert.equal(world.publishing(), false);
  assert.equal(world.terminalLoud(), false, "no banner before a verdict");
  const before = world.states.length;

  // The Welcome never lands; `SELF_ENROLMENT_DEADLINE_MS` (240 s) latches.
  await advance(t, 250_000);
  assertGateHeld(world, "the self-enrolment assertion");
  assertMe10(world, "the self-enrolment assertion");
  // A first-join control latch is un-keyed by construction: no Welcome, so
  // no local key was ever installed. It must never read `cannot_verify`.
  const louds = loudsWithMeta(world, before);
  assert.equal(louds.length, 1);
  assert.deepEqual(louds[0].meta, { origin: "control", mediaKeyed: false });
  assert.equal(world.chip(), "not_encrypted");
});
