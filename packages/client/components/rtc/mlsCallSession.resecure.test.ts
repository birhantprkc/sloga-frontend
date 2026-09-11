// Session-level specs for the "eternal Re-securing after a rejoin" wedge
// (`MlsCallSession`), on the shared world in `mlsCallSession.harness.ts`.
//   node --test --conditions=browser components/rtc/mlsCallSession.resecure.test.ts
//
// The report (RKode, 2026-09-10): someone leaves and rejoins an encrypted
// call, and the chip loops on "Re-securing…" until the client is quit. Three
// ways into that state are pinned here, one group each:
//   - P1 (1a–1g, 5d): a Welcome adopted while the join ladder sits in an
//     await resolves no wait, so the ladder keeps broadcasting intents as a
//     MEMBER and ends in `join timed out after retries` — amber with no owner,
//     since the enrolment assertion then finds enrolment proven and latches
//     nothing. 1d–1f are the same window with a non-`ok` DS answer, which a
//     member has to ignore rather than act on; 1g is the window before the
//     first intent (the pre-join roster pin);
//   - P3 (3): the enrolment alarm is latch-once for the whole call, so a
//     SECOND exhausted ladder after a re-establish is silent amber;
//   - no owner (4a): a re-securing nothing is left to end, which only the
//     240 s enrolment deadline used to catch.
//
// The fix makes "re-securing" end LOUD or with an owner, and never green of
// its own making. The GUARDS (4b, 4c, 5, 5b, 5c) pin the other half: the fix
// must not stop a live ladder, shorten an honest one, latch a start() still
// enrolling, or let a late or foreign Welcome turn a red back into a green.
// They are green at the base commit by construction; their evidence is the
// mutation that reddens them.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsHttpResult } from "@revolt/client";

import {
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  GROUP,
  newWorld,
  PEER_ID,
  SELF_ID,
} from "./mlsCallSession.harness.ts";

// ---- The session's bounds, mirrored ---------------------------------------
//
// None of these is exported by `mlsCallSession.ts`, so each is copied here
// under its own name and cited; a change there has to be made here too.

/** `JOINER_RETRY_MS` — each Welcome wait of the join ladder. */
const JOINER_RETRY_MS = 10_000;
/** `MAX_JOINER_RETRIES` — re-broadcasts after the first intent. */
const MAX_JOINER_RETRIES = 3;
/** Intents one un-admitted ladder broadcasts (`attempt <= MAX_JOINER_RETRIES`). */
const LADDER_INTENTS = MAX_JOINER_RETRIES + 1;
/** One whole ladder: every attempt's Welcome wait, back to back. */
const LADDER_MS = LADDER_INTENTS * JOINER_RETRY_MS;
/**
 * The re-securing backstop's bound: `#scheduleResecuringDeadline` arms
 * `RESECURE_ESCALATE_MS` (10 s), and re-arms the same bound while an owner
 * holds the state.
 */
const RESECURE_BACKSTOP_MS = 10_000;
/** `NEGOTIATING_FAILSAFE_MS` — no DS verdict by then turns `start()` amber. */
const NEGOTIATING_FAILSAFE_MS = 5_000;
/** `SELF_ENROLMENT_DEADLINE_MS` — the only thing that ended 4a's amber before. */
const SELF_ENROLMENT_DEADLINE_MS = 240_000;
/** Longer than the rest of any ladder plus one backstop bound. */
const SETTLE_MS = 45_000;
/** The harness's own `advance` step, used for sampling between ticks. */
const STEP_MS = 250;

// ---- Helpers ----------------------------------------------------------------

/** The joiner's `start()`, run up to its first intent (as `bringUpJoiner`). */
async function startJoiner(t: TestContext, world: World): Promise<void> {
  void world.session.start();
  await flush();
  await advance(t, 1);
}

/** Native's keys-changed for the adopted group, as `bringUpJoiner` drives it. */
async function installKeys(world: World, epoch: number): Promise<void> {
  await world.session.onLocalKeysChanged(GROUP, epoch);
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee", "the keys never enabled");
}

/** Every `loud` error the media-plane callback reported, in order. */
function louds(world: World): unknown[] {
  return world.journal.flatMap((entry) =>
    entry.kind === "state" && entry.state === "loud" ? [entry.error] : [],
  );
}

/** The `loud` / `clear` stream alone — the input to `state.tsx`'s latch. */
function verdicts(world: World): { state: string; error: unknown }[] {
  return world.journal.flatMap((entry) =>
    entry.kind === "state" && entry.state !== "resecuring"
      ? [{ state: entry.state, error: entry.error }]
      : [],
  );
}

/**
 * Advance `ms`, sampling the lifecycle state and the chip after every tick.
 * A final-state check alone cannot see an amber that came and went, and an
 * amber that came is exactly what the ladder used to leave behind.
 */
async function watch(
  t: TestContext,
  world: World,
  ms: number,
): Promise<{ states: string[]; chips: string[] }> {
  const states = new Set<string>([world.session.state()]);
  const chips = new Set<string>([world.chip()]);
  for (let elapsed = 0; elapsed < ms; elapsed += STEP_MS) {
    await advance(t, Math.min(STEP_MS, ms - elapsed));
    states.add(world.session.state());
    chips.add(world.chip());
  }
  return { states: [...states], chips: [...chips] };
}

/** Advance until `done()` holds, failing past `maxMs`. */
async function advanceUntil(
  t: TestContext,
  done: () => boolean,
  maxMs: number,
  what: string,
): Promise<void> {
  for (let elapsed = 0; !done(); elapsed += STEP_MS) {
    assert.ok(elapsed < maxMs, `${what} did not happen within ${maxMs} ms`);
    await advance(t, STEP_MS);
  }
}

/** The end state of a join that succeeded: green, active, and never loud. */
function assertJoined(
  world: World,
  seen: { states: string[]; chips: string[] },
): void {
  assert.deepEqual(
    seen.states,
    ["active"],
    "the session left `active` after it adopted its Welcome",
  );
  assert.deepEqual(seen.chips, ["e2ee"], "the chip left green after joining");
  assert.equal(world.session.state(), "active");
  assert.equal(world.chip(), "e2ee");
  assert.deepEqual(louds(world), [], "a joined member went loud");
}

/** How many times the session called the bridge method `name`. */
function calls(world: World, name: string): number {
  return world.bridgeCalls.filter((n) => n === name).length;
}

/**
 * 1a's shape, with a non-`ok` DS answer: attempt 0's `mlsJoinIntent` is held,
 * the Welcome is adopted and its keys installed, and only then does `answer`
 * land. Whatever it says is moot for a member, so the call has to end exactly
 * as 1a's does — same mode as at adoption, no teardown, no re-establish.
 */
async function answerAfterAdoption(
  t: TestContext,
  channelId: string,
  answer: MlsHttpResult<void>,
): Promise<void> {
  const world = newWorld(t, "joiner", channelId);
  const release = world.holdJoinIntent();
  await startJoiner(t, world);
  assert.equal(world.joinIntents(), 1, "attempt 0's broadcast is not held");

  await world.welcome(0);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);
  // Everything the answer could move, as it stood at adoption. The joiner
  // already left its orphan epoch-0 group, so these counts are not zero.
  const intents = world.joinIntents();
  const mode = structuredClone(world.session.callMode());
  const leaves = calls(world, "callLeaveCleanup");
  const creates = calls(world, "callCreate");

  world.answerJoinIntentOnce(answer);
  release();
  await flush();
  // Not vacuous: the held broadcast took the scripted answer.
  assert.equal(world.joinIntentAnswer, null, "the answer was never delivered");
  const seen = await watch(t, world, SETTLE_MS);
  assert.equal(
    calls(world, "callLeaveCleanup"),
    leaves,
    "the group just joined was left",
  );
  assert.equal(calls(world, "callCreate"), creates, "a member re-established");
  assert.deepEqual(
    world.session.callMode(),
    mode,
    "the answer moved the call mode",
  );
  assert.equal(
    world.joinIntents(),
    intents,
    "the ladder kept broadcasting intents as a member",
  );
  assertJoined(world, seen);
}

// ---- P1: the ladder recognises its own success ------------------------------

test("1a — a Welcome adopted during a held mlsJoinIntent at attempt 0 stops the ladder", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-1a");
  const release = world.holdJoinIntent();
  await startJoiner(t, world);
  assert.equal(world.joinIntents(), 1, "attempt 0's broadcast is not held");

  // The admitter's Add lands while our broadcast is still in flight: adopted,
  // but there is no Welcome wait installed for it to resolve.
  await world.welcome(0);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);
  const intents = world.joinIntents();

  release();
  await flush();
  const seen = await watch(t, world, SETTLE_MS);
  assert.equal(
    world.joinIntents(),
    intents,
    "the ladder kept broadcasting intents as a member",
  );
  assertJoined(world, seen);
});

test("1b — a Welcome adopted during a held callJoinIntent broadcasts no intent at all", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-1b");
  const release = world.holdCallJoinIntent();
  await startJoiner(t, world);
  // Suspended in the native signing call, before the first broadcast.
  assert.equal(
    world.bridgeCalls.filter((n) => n === "callJoinIntent").length,
    1,
  );
  assert.equal(world.joinIntents(), 0);

  await world.welcome(0);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);

  release();
  await flush();
  const seen = await watch(t, world, SETTLE_MS);
  assert.equal(
    world.joinIntents(),
    0,
    "a member broadcast the intent it signed before joining",
  );
  assertJoined(world, seen);
});

test("1c — a Welcome adopted during attempt 3's held mlsJoinIntent ends green, with no re-securing after adoption", async (t) => {
  // The shape [A-F1] says actually wedges amber: adopted in the LAST attempt,
  // so no later intent is ever served as a rejoin to turn it red instead.
  const world = newWorld(t, "joiner", "ch-resecure-1c");
  await startJoiner(t, world);
  // Attempts 0–2 time out with no Welcome.
  await advanceUntil(
    t,
    () => world.joinIntents() === MAX_JOINER_RETRIES,
    MAX_JOINER_RETRIES * JOINER_RETRY_MS,
    `attempt ${MAX_JOINER_RETRIES - 1}'s broadcast`,
  );
  const release = world.holdJoinIntent();
  await advanceUntil(
    t,
    () => world.joinIntents() === LADDER_INTENTS,
    JOINER_RETRY_MS + 1_000,
    `attempt ${MAX_JOINER_RETRIES}'s broadcast`,
  );
  assert.equal(
    world.session.state(),
    "starting",
    "a verdict before the Welcome",
  );
  assert.deepEqual(louds(world), []);

  await world.welcome(0);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);

  release();
  await flush();
  const seen = await watch(t, world, SETTLE_MS);
  assert.equal(world.joinIntents(), LADDER_INTENTS);
  assert.ok(
    !seen.states.includes("resecuring"),
    `the session re-secured after adopting its Welcome (${seen.states})`,
  );
  assertJoined(world, seen);
});

test("1d — a not_found answer to a held mlsJoinIntent after its Welcome was adopted does not tear the group down", async (t) => {
  // Acted on, this is `#rejoinFresh("group closed during join")`: leave the
  // group we just joined, re-secure, and run a whole new establish.
  await answerAfterAdoption(t, "ch-resecure-1d", { kind: "not_found" });
});

test("1e — a feature_disabled answer to a held mlsJoinIntent after its Welcome was adopted does not drop the call to plaintext", async (t) => {
  // Acted on, this is `#toPlaintext`: a quiet `off` on an encrypted call.
  // Ignoring it keeps the call encrypted, which fails closed.
  await answerAfterAdoption(t, "ch-resecure-1e", { kind: "feature_disabled" });
});

test("1f — a call_full answer to a held mlsJoinIntent after its Welcome was adopted does not refuse a member", async (t) => {
  // Acted on, this is `#onCallFull`: loud, then the terminal `call_full` mode
  // and an auto-leave, for a device already in the group.
  await answerAfterAdoption(t, "ch-resecure-1f", { kind: "call_full" });
});

test("1g — a Welcome adopted during the held pre-join roster pin signs no intent at all", async (t) => {
  // The ladder's loop-head check, alone. Adopted before attempt 0, so the
  // first thing the loop does is ask whether it already joined.
  const world = newWorld(t, "joiner", "ch-resecure-1g");
  const release = world.holdReconcileRoster();
  await startJoiner(t, world);
  // Suspended in `#joinPath`'s roster pin, before the first intent.
  assert.equal(calls(world, "reconcileCallRoster"), 1, "the pin is not held");
  assert.equal(calls(world, "callJoinIntent"), 0);
  assert.equal(world.joinIntents(), 0);

  await world.welcome(0);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);

  release();
  await flush();
  const seen = await watch(t, world, SETTLE_MS);
  // Without the loop-head check this is the ONLY trace: the "intent signed"
  // check still stops the broadcast, one native signing call later.
  assert.equal(
    calls(world, "callJoinIntent"),
    0,
    "a member signed a join intent after its Welcome was adopted",
  );
  assert.equal(world.joinIntents(), 0, "a member broadcast a join intent");
  assertJoined(world, seen);
});

test("5d — a callJoinIntent that throws after its Welcome was adopted is not a false red", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-5d");
  const release = world.holdCallJoinIntent();
  await startJoiner(t, world);
  assert.equal(world.joinIntents(), 0);

  await world.welcome(0);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);
  // The signing call we were suspended in now fails — for a MEMBER, whose
  // intent is moot. Before the fix this reached `#onLoud`: failed, and red.
  world.failCallJoinIntentOnce(new Error("mls_native_error: signing failed"));

  release();
  await flush();
  const seen = await watch(t, world, SETTLE_MS);
  assert.equal(world.joinIntents(), 0);
  assertJoined(world, seen);
});

// ---- P3: the enrolment alarm re-arms with a re-establish --------------------

test("3 — a second exhausted ladder after a re-establish goes red again, with a new error", async (t) => {
  // The re-establish is `#onRemovedSelf` → `#rejoinFresh` (SELF still in the
  // SFU, so the removal was a kick, not our leave): the path at `9610166e`
  // that runs `#resetGroupBuffers` — clearing the first latch through
  // `#resetRotationState` — and then a whole new join ladder.
  const world = newWorld(t, "joiner", "ch-resecure-3");
  await startJoiner(t, world);
  await advance(t, LADDER_MS + 1_000);
  // Red #1: the un-admitted ladder's own exhaustion.
  assert.equal(world.joinIntents(), LADDER_INTENTS);
  assert.equal(world.chip(), "not_encrypted");
  assert.equal(world.terminalLoud(), true);
  const [first] = louds(world);
  assert.ok(first instanceof Error, "red #1 latched no error");

  // The admitter's Add finally lands and native installs its keys. Without
  // this the trigger below is unrealistic: a joiner that was never admitted
  // holds no GROUP in its native store, so no commit for it can report
  // `removed_self`. Adopted (5b pins that it rescues nothing), and the
  // alarm's latch-once flag is still set — the Welcome's own enrolment check
  // returns early on it.
  await world.welcome(0);
  await world.session.onLocalKeysChanged(GROUP, 0);
  await flush();
  assert.equal(world.session.state(), "active", "the late Welcome was ignored");
  assert.equal(world.chip(), "not_encrypted", "a late Welcome rescued red #1");

  assert.ok(world.sfu.includes(SELF_ID));
  await world.removedSelf(1);
  await advance(t, 1); // `#onRemovedSelf` runs as a 0 ms group action
  // The re-establish broadcast a fresh intent, and dropped red #1 with it.
  assert.equal(world.joinIntents(), LADDER_INTENTS + 1, "no re-establish ran");
  assert.equal(world.chip(), "resecuring");

  await advance(t, LADDER_MS + 1_000);
  assert.equal(world.joinIntents(), 2 * LADDER_INTENTS);
  assert.equal(
    world.chip(),
    "not_encrypted",
    "the second exhausted ladder was silent amber",
  );
  assert.equal(world.terminalLoud(), true, "no banner on red #2");
  const [, second] = louds(world);
  assert.ok(second instanceof Error, "red #2 latched no error");
  assert.notEqual(second, first, "red #2 re-used red #1's error object");
  // The latch protocol's whole input: loud #1, its identity-matched clear,
  // loud #2 — nothing else.
  assert.deepEqual(verdicts(world), [
    { state: "loud", error: first },
    { state: "clear", error: first },
    { state: "loud", error: second },
  ]);
  // WHICH verdict latched #2. The re-securing backstop would latch this state
  // too, one bound later, so without this a build with the alarm still
  // latch-once could pass on the backstop's red alone.
  assert.match(second.message, /join never completed/);
});

// ---- The re-securing backstop -----------------------------------------------

test("4a — a re-securing with no owner goes red within the backstop bound", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-4a");
  await bringUpCreator(t, world);
  // Removed while this device is no longer in the SFU: `#onRemovedSelf` takes
  // its "stay re-securing" arm, and nothing is left to end it.
  world.sfu = [PEER_ID];
  await world.removedSelf(1);
  await advance(t, 1);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.chip(), "resecuring");
  assert.deepEqual(louds(world), []);

  // Before the fix this amber lasted until the enrolment deadline.
  assert.ok(RESECURE_BACKSTOP_MS + 1_000 < SELF_ENROLMENT_DEADLINE_MS);
  await advance(t, RESECURE_BACKSTOP_MS + 1_000);
  assert.equal(world.chip(), "not_encrypted", "no red within the bound");
  assert.equal(world.terminalLoud(), true, "red with no banner");
  assert.equal(world.publishing(), false, "the banner's pause claim is false");
  // The backstop never promotes to green, however quiet the roster looks.
  assert.notEqual(world.session.state(), "active");
  assert.equal(louds(world).length, 1);
});

test("4b GUARD — the backstop never cuts a live re-establish ladder short: a Welcome in attempt 3's wait ends green", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-4b");
  await bringUpJoiner(t, world, 0);
  const before = world.joinIntents();
  // Kicked while still in the SFU: `#rejoinFresh` re-secures, so the backstop
  // is armed, and the new ladder is the owner it has to wait for.
  await world.removedSelf(1);
  await advance(t, 1);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.joinIntents(), before + 1, "no re-establish ran");

  await advanceUntil(
    t,
    () => world.joinIntents() === before + LADDER_INTENTS,
    LADDER_MS,
    `the re-establish's attempt ${MAX_JOINER_RETRIES}`,
  );
  await advance(t, 5_000); // ~35 s into the ladder
  // Not vacuous: the backstop has come due three times over by now.
  assert.ok(3 * RESECURE_BACKSTOP_MS < 3 * JOINER_RETRY_MS + 5_000);
  assert.equal(world.session.state(), "resecuring");
  assert.deepEqual(louds(world), [], "the backstop cut a live ladder short");

  await world.welcome(2);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 2);
  const seen = await watch(t, world, SETTLE_MS);
  assert.equal(world.joinIntents(), before + LADDER_INTENTS);
  assertJoined(world, seen);
});

test("4c GUARD — the backstop never fires while start()'s KeyPackage enrolment holds up the first establish", async (t) => {
  // The owner term for establish generation 0. A slow enrolment (a 429 wait)
  // turns amber through the negotiating fail-safe at 5 s, with no establish
  // in flight and no group action scheduled yet. A latch taken here would
  // outlive the create that follows and leave an encrypted call red for good.
  const held = 20_000;
  const world = newWorld(t, "creator", "ch-resecure-4c");
  const release = world.holdReplenish();
  void world.session.start();
  await flush();
  await advance(t, held);
  // Not vacuous: still suspended in the enrolment, before any establish, and
  // the backstop armed at the fail-safe's amber has come due once already.
  assert.equal(calls(world, "mlsReplenish"), 1, "the enrolment is not held");
  assert.equal(calls(world, "callCreate"), 0, "an establish ran");
  assert.ok(NEGOTIATING_FAILSAFE_MS + RESECURE_BACKSTOP_MS < held);
  assert.equal(world.session.state(), "resecuring");
  assert.equal(world.chip(), "resecuring");
  assert.deepEqual(louds(world), [], "the backstop fired during enrolment");

  release();
  await flush();
  await advance(t, 1); // the detached establish (group action) runs
  assert.equal(world.session.state(), "active");
  await installKeys(world, 0);
  const seen = await watch(t, world, SETTLE_MS);
  assertJoined(world, seen);
});

// ---- Guards: the honest ladder is untouched ---------------------------------

test(`5 GUARD — an un-admitted joiner broadcasts exactly ${LADDER_INTENTS} intents and is red at the ladder's end`, async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-5");
  await startJoiner(t, world);
  assert.equal(world.joinIntents(), 1);
  assert.equal(world.terminalLoud(), false, "a banner before any verdict");

  await advance(t, LADDER_MS + 1_000);
  assert.equal(world.joinIntents(), LADDER_INTENTS);
  assert.equal(world.chip(), "not_encrypted");
  assert.equal(world.terminalLoud(), true);
  assert.equal(world.publishing(), false);

  // Spent is spent: no further broadcast.
  await advance(t, SETTLE_MS);
  assert.equal(world.joinIntents(), LADDER_INTENTS);
});

test("5b GUARD — a late Welcome after the ladder's red does not turn it green", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-5b");
  await startJoiner(t, world);
  await advance(t, LADDER_MS + 1_000);
  assert.equal(world.chip(), "not_encrypted");
  const latched = louds(world);
  assert.equal(latched.length, 1);

  // The admitter's Add finally lands, and native installs its keys.
  await world.welcome(0);
  await world.session.onLocalKeysChanged(GROUP, 0);
  await flush();
  await advance(t, SETTLE_MS);
  assert.equal(world.chip(), "not_encrypted", "a late Welcome rescued a red");
  assert.equal(world.terminalLoud(), true);
  assert.deepEqual(verdicts(world), [{ state: "loud", error: latched[0] }]);
});

test("5c GUARD — another group's Welcome during a held intent does not stop the ladder", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-5c");
  const release = world.holdJoinIntent();
  await startJoiner(t, world);
  assert.equal(world.joinIntents(), 1);

  await world.welcome(0, "other-group");
  assert.equal(world.session.state(), "starting", "a foreign Welcome adopted");
  release();
  await flush();

  await advance(t, JOINER_RETRY_MS + 1_000);
  assert.equal(
    world.joinIntents(),
    2,
    "the ladder stopped on a foreign Welcome",
  );
  await advance(t, LADDER_MS);
  assert.equal(world.joinIntents(), LADDER_INTENTS);
  assert.equal(world.chip(), "not_encrypted");
  assert.equal(world.terminalLoud(), true);
});
