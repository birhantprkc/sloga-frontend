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
//
// Group 6 pins the fix's own moving parts, which no spec above can see: the
// backstop's re-arm (6a) and its `#groupActionPending` owner term (6e), and
// the stale-submit guard `#submitSuperseded`. A submit whose group a
// re-establish replaced acts on nothing, whatever settles it: the timeout
// (6b) and a rejection (6c) stop in the submit's own catch, and every DS
// answer stops right after `classifyArbitration`, before its arm — `won`
// (6d), `lost` (6f) and `feature_disabled` (6g) alike. The fourth outcome,
// `failed` (a DS body that contradicts its status), has no spec of its own.
// A DS answer `classifyArbitration` cannot read throws before that check, so
// the post-submit catch's own guard stops it (6h). 6e is a GUARD in the sense
// above: the base has no backstop to fire, so only deleting the term reddens
// it.
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type {
  MlsHttpResult,
  MlsSubmitCommit,
  ResponseSubmitMlsCommit,
} from "@revolt/client";

import {
  type World,
  advance,
  bringUpCreator,
  bringUpJoiner,
  flush,
  GROUP,
  groupNotFound,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
  SUBMIT_TIMEOUT_MS,
  THIRD,
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

// ---- The backstop's owner terms, and the stale-submit guard -----------------

test("6a — the backstop re-arms while the join ladder still holds re-securing, and goes red within one bound of it returning", async (t) => {
  const world = newWorld(t, "joiner", "ch-resecure-6a");
  const releaseIntent = world.holdJoinIntent();
  await startJoiner(t, world);
  assert.equal(world.joinIntents(), 1, "attempt 0's broadcast is not held");
  // 1a's window: adopted while the ladder is suspended in its broadcast, so
  // the ladder stays the group action in flight until the broadcast returns.
  await world.welcome(1);
  assert.equal(world.session.state(), "active");
  await installKeys(world, 1);

  // THIRD's admit submits and the DS never answers. The timeout arm
  // re-secures and schedules a re-establish that is DROPPED behind the
  // ladder: the ladder is the owner now, and it will end nothing.
  world.holdSubmit();
  await world.joinRequest(THIRD);
  await advance(t, 1);
  assert.equal(world.submits(), 1, "the admit never submitted");
  await advance(t, SUBMIT_TIMEOUT_MS);
  assert.equal(world.session.state(), "resecuring");
  assert.deepEqual(world.commitLosts, [GROUP], "the timeout arm never ran");

  // Not vacuous: the first bound comes due with the ladder still suspended.
  const owned = 15_000;
  assert.ok(RESECURE_BACKSTOP_MS < owned && owned < 2 * RESECURE_BACKSTOP_MS);
  const seen = await watch(t, world, owned);
  assert.deepEqual(seen.chips, ["resecuring"], "the chip left amber");
  assert.equal(world.terminalLoud(), false, "a banner while an owner held it");
  assert.deepEqual(
    louds(world),
    [],
    "the backstop fired while the ladder held re-securing",
  );
  assert.equal(world.joinIntents(), 1);

  // The ladder returns through P1's check, and nothing owns the state now.
  releaseIntent();
  await flush();
  await advanceUntil(
    t,
    () => world.chip() === "not_encrypted" && world.terminalLoud(),
    RESECURE_BACKSTOP_MS + 1_000,
    "the backstop's red after the ladder returned",
  );
  assert.equal(
    world.joinIntents(),
    1,
    "the ladder broadcast again as a member",
  );
  assert.equal(world.publishing(), false, "the banner's pause claim is false");
  const latched = louds(world);
  assert.equal(latched.length, 1);
  const [error] = latched;
  assert.ok(error instanceof Error, "the red latched no error");
  // WHICH verdict latched: the backstop's own, not some later path's.
  assert.match(error.message, /stayed re-securing with nothing left to end it/);
});

/** The group that replaces GROUP under a held submit (`createNextGroupOnce`). */
const NEXT_GROUP = "group-2";

/** `#submitSuperseded`'s log line, verbatim. */
const STALE_LOG =
  "[mls] stale submit continuation for a superseded group — ignored";

/** `#safeLeave`'s log line for a leave-clean native refused, verbatim. */
const LEAVE_FAILED_LOG = "[mls] leave-cleanup failed";

/**
 * The bridge methods a submit continuation can reach: every call its arms
 * make (the merge, the clear, and the `lost` arm's replay, ack and refetch),
 * and a re-establish or re-admit started from one. A stale continuation
 * calls none of them.
 */
const CONTINUATION_CALLS = [
  "callCommitWon",
  "callCommitLost",
  "processEnvelope",
  "ackEnvelopes",
  "mlsFetchCommits",
  "callLeaveCleanup",
  "callCreate",
  "mlsCreateGroup",
  "callAdmit",
  "mlsSubmitCommit",
] as const;

/** How many times the session called each of `CONTINUATION_CALLS`. */
function continuationCalls(world: World): Record<string, number> {
  return Object.fromEntries(
    CONTINUATION_CALLS.map((name) => [name, calls(world, name)]),
  );
}

/** What a stale submit continuation must leave as the group swap left it. */
interface AfterSwap {
  leaveCleanups: string[];
  calls: Record<string, number>;
  mode: unknown;
  chip: string;
  /** `world.modes.length` at the swap: every mode edge past it is later. */
  modesAt: number;
  /** The epoch THIRD's admit staged on GROUP and submitted. */
  submittedEpoch: number;
  /** The commit THIRD's admit staged on GROUP, as `callAdmit` returned it. */
  staged: MlsSubmitCommit;
  /** GROUP's epoch at the swap. A merge of `staged` moves it to its epoch. */
  epoch: number;
}

interface Swap {
  releaseSubmit: () => void;
  after: AfterSwap;
  /** The payload of every `#submitSuperseded` log line so far, in order. */
  staleLogs: () => unknown[];
}

/**
 * The stale-submit shape, on the drain's receiver-lag desync
 * (`World.receiverLag`): the one `#rejoinFresh` the drain schedules in this
 * world that leaves GROUP buildable, so an admit can still submit on it. A
 * removed-self commit cannot stand in: native marks GROUP evicted, refuses
 * the admit `add-members`, and nothing is ever submitted.
 *   1. A GROUP commit lands `LAG_DESYNC_THRESHOLD` epochs ahead, and its
 *      `processEnvelope` is held: the drain holds the per-group lock.
 *   2. THIRD's admit captures GROUP and waits on that lock, unbuilt.
 *   3. Released, the drain parks the commit, gap-refetches, reads the lag as
 *      a desync and schedules `rejoin_fresh:receiver_lag`. The admit then
 *      stages on GROUP and submits, and the submit is held.
 *   4. The rejoin runs: GROUP is leave-cleaned, staged commit and all, and
 *      the re-establish lands on `NEXT_GROUP`.
 * With `leaveFails`, native refuses step 4's leave-clean
 * (`failLeaveCleanupOnce`) and `#safeLeave` swallows the refusal: the
 * re-establish still lands on `NEXT_GROUP`, but native keeps GROUP and the
 * staged commit, so a Won for it would take the merge path.
 * Returns with the submit still held and the session `active` on
 * `NEXT_GROUP`. Every `console.warn` and `console.error` is recorded (and
 * still printed) from the start, so the stale log line is counted over the
 * whole test.
 */
async function swapGroupUnderSubmit(
  t: TestContext,
  world: World,
  { leaveFails = false }: { leaveFails?: boolean } = {},
): Promise<Swap> {
  const warn = t.mock.method(console, "warn");
  const warns = () => warn.mock.calls.map((call) => call.arguments);
  const staleLogs = () =>
    warns().flatMap(([line, payload]) => (line === STALE_LOG ? [payload] : []));
  const error = t.mock.method(console, "error");
  const leaveFailures = () =>
    error.mock.calls
      .map((call) => call.arguments)
      .filter(([line]) => line === LEAVE_FAILED_LOG);

  await bringUpCreator(t, world);
  const releaseSubmit = world.holdSubmit();
  const releaseProcess = world.holdProcessEnvelope();

  await world.receiverLag();
  await world.joinRequest(THIRD);
  await advance(t, 1); // the admit's 0 ms leaf stagger
  assert.equal(
    calls(world, "processEnvelope"),
    1,
    "the lag commit is not held",
  );
  assert.equal(calls(world, "callAdmit"), 0, "the admit built ahead of it");
  assert.equal(world.submits(), 0, "the admit submitted ahead of it");

  world.createNextGroupOnce(NEXT_GROUP);
  if (leaveFails) world.failLeaveCleanupOnce(GROUP);
  releaseProcess();
  await flush();
  // The refetch took `receiverLag`'s answer: the stub nulls it only once the
  // range matched, and a failed stub assertion is a rejection the drain can
  // swallow, so the count alone would not prove it.
  assert.equal(calls(world, "mlsFetchCommits"), 1, "the drain never refetched");
  assert.equal(world.fetchCommitsAnswer, null, "the refetch took no answer");
  // GROUP is not evicted by a gap: the admit built and submitted on it.
  assert.equal(calls(world, "callAdmit"), 1, "the admit never built");
  assert.equal(world.submits(), 1, "the admit never submitted");
  const staged = world.stagedCommits.get(GROUP);
  assert.ok(staged !== undefined && staged !== "left", "nothing was staged");
  assert.equal(world.session.groupId(), GROUP, "replaced before the submit");

  await advance(t, 1); // `rejoin_fresh:receiver_lag` runs as a group action
  if (leaveFails) {
    // Refused, and swallowed: native wiped nothing, so GROUP and the commit
    // staged on it survive the swap.
    assert.deepEqual(
      world.failedLeaveCleanups,
      [GROUP],
      "the rejoin's leave-clean of GROUP was not refused",
    );
    assert.deepEqual(world.leaveCleanups, [], "a leave-clean wiped a group");
    assert.equal(
      world.stagedCommits.get(GROUP),
      staged,
      "the refused leave-clean took the staged commit",
    );
    assert.equal(
      leaveFailures().length,
      1,
      "`#safeLeave` did not log the refused leave-clean",
    );
  } else {
    assert.deepEqual(
      world.leaveCleanups,
      [GROUP],
      "the rejoin never leave-cleaned GROUP",
    );
    assert.equal(world.stagedCommits.get(GROUP), "left");
    assert.deepEqual(leaveFailures(), [], "a leave-clean was refused");
  }
  assert.equal(world.session.groupId(), NEXT_GROUP, "GROUP was not replaced");
  assert.equal(world.session.state(), "active");
  // WHICH transition replaced it: the receiver-lag rejoin, not some other.
  assert.ok(
    warns().some(
      ([line, reason]) =>
        line === "[mls] re-securing:" && /^receiver lag/.test(String(reason)),
    ),
    "the swap was not the receiver-lag rejoin",
  );
  // Still in flight across the swap: the submit has not settled, and no
  // catch has run. GROUP's staged commit is as the leave-clean left it.
  assert.notEqual(world.submitGate, null, "the submit settled before the swap");
  assert.deepEqual(world.commitLosts, []);
  assert.equal(calls(world, "callCommitWon"), 0);
  assert.deepEqual(louds(world), []);
  assert.deepEqual(staleLogs(), [], "a continuation ran before it settled");
  return {
    releaseSubmit,
    staleLogs,
    after: {
      leaveCleanups: [...world.leaveCleanups],
      calls: continuationCalls(world),
      mode: structuredClone(world.session.callMode()),
      chip: world.chip(),
      modesAt: world.modes.length,
      submittedEpoch: staged.epoch,
      staged,
      epoch: world.epoch,
    },
  };
}

/**
 * A stale continuation acts on NOTHING: the live group keeps its pending
 * state, is not left or re-created, no arm's bridge call runs, and the
 * session stays `active` on it with the chip and mode exactly as the swap
 * left them — throughout, not only at the end. It stops at the stale check,
 * once: `stale` is the one log payload expected, which also tells the sites
 * apart (the submit's own catch and the post-submit catch log no `outcome`,
 * the post-classify check logs the DS answer's).
 */
async function assertActedOnNothing(
  t: TestContext,
  world: World,
  swap: Swap,
  stale: Record<string, unknown>,
  during: { states: string[]; chips: string[] } = { states: [], chips: [] },
): Promise<void> {
  const { after } = swap;
  const seen = await watch(t, world, SETTLE_MS);
  const states = [...new Set([...during.states, ...seen.states])];
  const chips = [...new Set([...during.chips, ...seen.chips])];
  assert.deepEqual(
    world.commitLosts,
    [],
    "a stale continuation cleared the live group's pending commit",
  );
  assert.deepEqual(
    world.leaveCleanups,
    after.leaveCleanups,
    "a stale continuation left the live group",
  );
  assert.deepEqual(
    continuationCalls(world),
    after.calls,
    "a stale continuation reached the bridge",
  );
  assert.equal(
    world.session.groupId(),
    NEXT_GROUP,
    "a stale continuation moved the session off the live group",
  );
  assert.deepEqual(states, ["active"], "a stale continuation re-secured");
  assert.deepEqual(chips, [after.chip], "a stale continuation moved the chip");
  assert.deepEqual(
    world.modes.slice(after.modesAt),
    [],
    "a stale continuation changed the call mode",
  );
  assert.deepEqual(
    world.session.callMode(),
    after.mode,
    "the call mode is not the one the swap left",
  );
  assert.deepEqual(louds(world), [], "a stale continuation went loud");
  assert.deepEqual(
    swap.staleLogs(),
    [stale],
    "the continuation did not stop at the stale check exactly once",
  );
}

/**
 * The stale log's payload for this swap, as the submit's own catch and the
 * post-submit catch write it. The post-classify check adds the DS answer's
 * `outcome`.
 */
const SWAPPED = { submitted: GROUP, live: NEXT_GROUP };

test("6b — a submit that times out after its group was replaced acts on nothing", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-6b");
  const swap = await swapGroupUnderSubmit(t, world);

  const during = await watch(t, world, SUBMIT_TIMEOUT_MS);
  // The DS never answered, so only the session's own race can have settled
  // the submit. Not vacuous: had the timeout not fired, the release below
  // would deliver the stub's Won, whose stale log names `outcome: "won"`.
  assert.notEqual(world.submitGate, null, "the submit was answered");
  swap.releaseSubmit(); // a late answer nothing awaits any more
  await flush();
  await assertActedOnNothing(t, world, swap, SWAPPED, during);
});

test("6c — a submit rejected after its group was replaced acts on nothing", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-6c");
  const swap = await swapGroupUnderSubmit(t, world);

  world.failSubmitOnce(new Error("network"));
  swap.releaseSubmit();
  await flush();
  // Spent, and spent HERE: a rejection lands in the submit's own catch, so
  // its stale log names no `outcome`. An unspent one would have let the
  // stub's Won through, which logs `outcome: "won"`.
  assert.equal(world.submitFailure, null, "the rejection was never delivered");
  await assertActedOnNothing(t, world, swap, SWAPPED);
});

test("6d — a Won for a submit whose group was replaced is never merged, and acts on nothing", async (t) => {
  // Under this trigger an honest DS answers Lost (6f). Under a trigger that
  // leaves the DS at our epoch (`rejoin_fresh:drain`, the interlude
  // re-upgrade), an honest Won is ordinary. The check must stop it BEFORE the
  // merge: a swallowed leave-clean leaves native holding GROUP, and the merge
  // would write `#lastOwnWon` onto the live session.
  //
  // So native refuses the swap's leave-clean here, and the merge is there to
  // take: without the check, `callCommitWon` finds GROUP and the staged
  // commit, merges it, moves GROUP's epoch and seats THIRD. Each assertion
  // below is one of those, and fails on its own if the Won is let through.
  const world = newWorld(t, "creator", "ch-resecure-6d");
  const swap = await swapGroupUnderSubmit(t, world, { leaveFails: true });
  // Not vacuous: a merge would move the epoch, since the admit staged the
  // next one.
  assert.notEqual(swap.after.staged.epoch, swap.after.epoch);

  swap.releaseSubmit();
  await flush();
  assert.equal(calls(world, "callCommitWon"), 0, "the stale Won was merged");
  assert.equal(
    world.epoch,
    swap.after.epoch,
    "a stale Won moved GROUP's epoch",
  );
  assert.deepEqual(
    world.roster.map((m) => m.device_id),
    [SELF.device_id, PEER.device_id],
    "a stale Won seated THIRD",
  );
  assert.equal(
    world.stagedCommits.get(GROUP),
    swap.after.staged,
    "a stale Won's merge consumed the staged commit",
  );
  // Not vacuous: the Won reached `classifyArbitration`, and the post-classify
  // check dropped it by name.
  await assertActedOnNothing(t, world, swap, {
    ...SWAPPED,
    outcome: "won",
  });
});

test("6e GUARD — a re-establish held in its leave-clean is an owner: the backstop waits, and the call ends green", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-6e");
  await bringUpCreator(t, world);
  await advance(t, 3_000); // past the bring-up's rotation settle (2 s)
  const creates = calls(world, "callCreate");
  const releaseLeave = world.holdLeaveCleanup();

  // THIRD's admit submit rejects: the submit catch re-secures (arming the
  // backstop) and schedules the re-establish, which runs as a group action
  // and suspends in `#rejoinFresh`'s leave-clean, BEFORE its establish.
  world.failSubmitOnce(new Error("network"));
  await world.joinRequest(THIRD);
  await advance(t, 1);
  assert.equal(world.submits(), 1, "the admit never submitted");
  assert.equal(world.submitFailure, null, "the rejection was never delivered");
  assert.equal(world.session.state(), "resecuring");
  await advance(t, 1);
  assert.equal(calls(world, "callLeaveCleanup"), 1, "no leave-clean started");
  assert.deepEqual(world.leaveCleanups, [], "the leave-clean is not held");

  // Not vacuous: the bound comes due twice over, and no establish is in
  // flight — only the pending group action owns the state.
  const held = 25_000;
  assert.ok(2 * RESECURE_BACKSTOP_MS < held);
  const seen = await watch(t, world, held);
  assert.deepEqual(world.leaveCleanups, [], "the leave-clean was not held");
  assert.equal(calls(world, "callCreate"), creates, "an establish started");
  assert.deepEqual(seen.states, ["resecuring"]);
  assert.deepEqual(seen.chips, ["resecuring"], "the chip left amber");
  assert.deepEqual(louds(world), [], "the backstop fired on an owned state");
  assert.equal(world.terminalLoud(), false);
  assert.equal(world.publishing(), false, "a re-securing device published");

  releaseLeave();
  await flush();
  await advance(t, 1);
  assert.deepEqual(world.leaveCleanups, [GROUP]);
  assert.equal(calls(world, "callCreate"), creates + 1, "no re-establish ran");
  assert.equal(world.session.state(), "active");
  await installKeys(world, world.epoch);
  const settled = await watch(t, world, SETTLE_MS);
  assertJoined(world, settled);
});

test("6f — an honest Lost for a submit whose group was replaced acts on nothing: no rebase, no refetch of the live group", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-6f");
  const swap = await swapGroupUnderSubmit(t, world);
  // The honest answer: the DS stores `receiverLag`'s own first commit at the
  // SUBMITTED epoch (1 here), and names that row as the winner.
  const epoch = swap.after.submittedEpoch;
  world.answerSubmitOnce({
    kind: "conflict",
    body: {
      result: "Lost",
      winning: {
        group_id: GROUP,
        epoch,
        committer: PEER,
        commit: `commit-${epoch}`,
        added: [],
        removed: [],
      },
    },
  });
  // What the `lost` arm would reach, scripted as native and the DS would
  // answer: GROUP was wiped, and the live group is at epoch 0. Unscripted,
  // a build without the check would stop partway through that arm on a
  // stub's assertion (a rejection the post-submit catch can swallow), so the
  // arm would never run as it does against native.
  world.rejections.set(`mls-synth:${GROUP}:${epoch}`, groupNotFound(GROUP));
  world.fetchCommitsAnswer = {
    groupId: NEXT_GROUP,
    fromEpoch: epoch + 1,
    result: { kind: "ok", body: { commits: [], current_epoch: 0 } },
  };

  swap.releaseSubmit();
  await flush();
  assert.equal(world.submitAnswer, null, "the Lost was never delivered");
  assert.deepEqual(
    world.commitLosts,
    [],
    "a stale Lost cleared the live group's pending commit",
  );
  assert.equal(
    calls(world, "processEnvelope"),
    swap.after.calls.processEnvelope,
    "a stale Lost replayed the winning commit",
  );
  assert.equal(
    calls(world, "mlsFetchCommits"),
    swap.after.calls.mlsFetchCommits,
    "a stale Lost gap-refetched the live group",
  );
  assert.notEqual(world.fetchCommitsAnswer, null, "the refetch was answered");
  // Not vacuous: the scripted Lost, not the stub's default Won, reached
  // `classifyArbitration`, and the post-classify check dropped it by name.
  await assertActedOnNothing(t, world, swap, { ...SWAPPED, outcome: "lost" });
});

test("6g — a feature_disabled for a submit whose group was replaced acts on nothing: the call does not drop to plaintext", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-6g");
  const swap = await swapGroupUnderSubmit(t, world);
  world.answerSubmitOnce({ kind: "feature_disabled" });

  swap.releaseSubmit();
  await flush();
  assert.equal(world.submitAnswer, null, "the answer was never delivered");
  // Acted on, this is `#toPlaintext`: a quiet `off` on the live group, from
  // an answer about a group this session already abandoned.
  assert.ok(
    !world.modes.slice(swap.after.modesAt).includes("off"),
    "a stale feature_disabled dropped the call to plaintext",
  );
  assert.notEqual(world.session.callMode().kind, "off", "the mode is `off`");
  assert.notEqual(world.session.state(), "plaintext", "the state is plaintext");
  // Not vacuous: the scripted answer, not the stub's default Won, reached
  // `classifyArbitration`, and the post-classify check dropped it by name.
  await assertActedOnNothing(t, world, swap, {
    ...SWAPPED,
    outcome: "plaintext",
  });
});

test("6h — a 2xx with no body for a submit whose group was replaced acts on nothing: `classifyArbitration` throws into the post-submit catch", async (t) => {
  const world = newWorld(t, "creator", "ch-resecure-6h");
  const swap = await swapGroupUnderSubmit(t, world);
  // What the real bridge hands back for a 204: `#apiMls`
  // (`components/client/e2ee.ts`) answers it `{ kind: "ok", body }` with
  // `body` cast `undefined as T`, and a 2xx whose JSON is `null` passes
  // through the same way. The type says `ResponseSubmitMlsCommit`, the value
  // has none, and the cast below is that same cast. `classifyArbitration`
  // reads `res.body.result` and throws, after the submit resolved and before
  // the post-classify check.
  world.answerSubmitOnce({
    kind: "ok",
    body: undefined as unknown as ResponseSubmitMlsCommit,
  });

  swap.releaseSubmit();
  await flush();
  assert.equal(world.submitAnswer, null, "the answer was never delivered");
  // WHICH site stopped it. Not the submit's own catch: the answer resolved,
  // and no clock has moved, so the timeout cannot have fired. Not the
  // post-classify check: its payload names the DS answer's `outcome`, and
  // this one has none. That leaves the post-submit catch's guard.
  assert.deepEqual(
    swap.staleLogs(),
    [SWAPPED],
    "the post-submit catch's guard did not stop the continuation",
  );
  await assertActedOnNothing(t, world, swap, SWAPPED);
});
