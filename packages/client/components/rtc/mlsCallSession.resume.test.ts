// Session-level specs for the RESUME (join-latency phase 2, wave 3): a
// device that comes back to a call it just left keeps its local MLS group,
// confirms it with the DS's open-group GET, catches up through the commits
// fetch, and enables through the unchanged fail-closed gate — no intent, no
// create, no Welcome, no commit. Anything short of that abandons the held
// group and runs today's ladder.
//   node --test --conditions=browser components/rtc/mlsCallSession.resume.test.ts
//
// Most cases run in a FLEET (`newFleet`): a reload is a real page death and a
// real prefetch on the new page's bridge (`Fleet.reload`), a hang-up and
// rejoin run on one page (`Fleet.rejoin`), and what the other seats submit
// emerges from their own ladders. The cases whose input no honest fleet can
// produce cheaply (a batch that removes this device, a lag of 12, an
// open-group GET naming another group, a re-establish with a prefetch still
// in hand) run on a one-seat world handed a prefetch by hand, as the host
// would hand it over.
//
// No-plaintext is checked on EVERY case, over the whole run, not at the end:
// `watch` fires on every publish-gate edge and every mode label each watched
// seat emits (and on every step of `run`), and records any moment at which a
// live session's gate was open while its mode was not `e2ee`. Its self-test
// shows it rejecting exactly that.
//
// No spec here re-intents faster than the DS's 5 s join-intent slowmode,
// which the harness DS does not model (W1-n5): every re-intent is the
// session's own, at `JOINER_RETRY_MS` (10 s).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import type { MlsCommitInfo, MlsFrameKeys } from "@revolt/client";

import {
  readResumeRecord,
  writeResumeRecord,
} from "../client/mlsResumeKeep.ts";
import { MissingLocalFrameKeyError } from "./mlsCallKeys.ts";
import {
  type Fleet,
  type Identity,
  type ResumePrefetchDep,
  type World,
  advance,
  flush,
  GROUP,
  groupNotFound,
  identityOf,
  newFleet,
  newWorld,
  PEER,
  PEER_ID,
  SELF,
  SELF_ID,
  THIRD,
  THIRD_ID,
} from "./mlsCallSession.harness.ts";
import type { KeyInstaller } from "./mlsCallSession.ts";
import {
  LOCAL_GROUP_KEEP_MS,
  REJOIN_SERVE_SUPPRESS_MS,
  RESUME_MAX_LAG,
} from "./mlsRejoinPolicy.ts";

/** `RESUME_PREFETCH_WAIT_MS` (session, private): the bounded prefetch wait. */
const RESUME_PREFETCH_WAIT_MS = 3_000;
/** `NEGOTIATING_FAILSAFE_MS` (session, private): the T0d fail-safe. */
const NEGOTIATING_FAILSAFE_MS = 5_000;
/** `KEPT_DISCARD_WAIT_MS` (session, private): the join path's delete bound. */
const KEPT_DISCARD_WAIT_MS = 5_000;
/** `RESECURE_ESCALATE_MS` (session, private): re-securing's loud bound. */
const RESECURE_ESCALATE_MS = 10_000;

/** What a resume prefetch hands the session (the dep's resolved value). */
type Prefetch = NonNullable<Awaited<ResumePrefetchDep>>;

// ---- Watching a seat -------------------------------------------------------

/**
 * One seat's run, as the spec reads it: bridge calls, native wipes, key
 * reads, publish-gate edges and mode labels INTERLEAVED in the order they
 * happened (`trace`), and every moment a live session published while its
 * mode was not `e2ee` (`violations`). `samples` counts the checks made, so a
 * watcher that never looked cannot pass.
 */
interface Watch {
  readonly world: World;
  readonly trace: string[];
  readonly violations: string[];
  samples: number;
  check(where: string): void;
}

/**
 * Call `on` after every push to `list` (the harness's append-only logs).
 * Chains: a second tap runs after the first.
 */
function tap<T>(list: T[], on: (item: T) => void): void {
  const push = list.push;
  Object.defineProperty(list, "push", {
    configurable: true,
    writable: true,
    value: (...items: T[]): number => {
      const length = push.apply(list, items);
      for (const item of items) on(item);
      return length;
    },
  });
}

/**
 * Watch `world` from now on. The harness appends to `bridgeCalls`,
 * `leaveCleanups`, `gateLog` and `modes` and never replaces them, so the
 * taps survive page deaths, boots, hang-ups and connects; `native.lastKeys`
 * is written by every frame-key read, so its epoch is each install's.
 *
 * The no-plaintext check: a session that is not closed, whose publish gate
 * is EMPTY (publishing flows), must be in mode `e2ee`. A hung-up seat (its
 * session closed, the gate cleared with the room) is not publishing to
 * anyone and is skipped.
 */
function watch(world: World): Watch {
  const w: Watch = {
    world,
    trace: [],
    violations: [],
    samples: 0,
    check(where: string): void {
      w.samples++;
      const session = world.session;
      if (session.state() === "closed") return;
      const mode = session.callMode().kind;
      if (world.publishing() && mode !== "e2ee") {
        w.violations.push(
          `${identityOf(world.me)} published at "${where}" in mode ${mode}`,
        );
      }
    },
  };
  tap(world.bridgeCalls, (name) => w.trace.push(`call:${name}`));
  tap(world.leaveCleanups, (groupId) => w.trace.push(`wiped:${groupId}`));
  tap(world.gateLog, (edge) => {
    w.trace.push(`gate:${edge}`);
    w.check(`gate ${edge}`);
  });
  tap(world.modes, (mode) => {
    w.trace.push(`mode:${mode}`);
    w.check(`mode ${mode}`);
  });
  let keys = world.native.lastKeys;
  Object.defineProperty(world.native, "lastKeys", {
    configurable: true,
    get: () => keys,
    set: (next: typeof keys) => {
      keys = next;
      w.trace.push(`keys:${next?.[0]?.epoch ?? "none"}`);
    },
  });
  return w;
}

/** A watcher per seat of `fleet`, keyed by identity. */
function watchFleet(fleet: Fleet): Map<string, Watch> {
  return new Map(fleet.seats.map((s) => [identityOf(s.me), watch(s)]));
}

/** No watched seat ever published outside `e2ee`, and each was looked at. */
function assertNoPlaintext(watches: Iterable<Watch>): void {
  for (const w of watches) {
    assert.ok(w.samples > 0, `${identityOf(w.world.me)} was never sampled`);
    assert.deepEqual(w.violations, [], "a plaintext publish window");
  }
}

/** `advance`, sampling every watcher after each 250 ms step. */
async function run(
  t: TestContext,
  ms: number,
  watches: Iterable<Watch>,
): Promise<void> {
  const list = [...watches];
  for (let elapsed = 0; elapsed < ms; elapsed += 250) {
    await advance(t, Math.min(250, ms - elapsed));
    for (const w of list) w.check(`t+${elapsed}`);
  }
}

/** `trace` from `index` on. */
function since(w: Watch, index: number): string[] {
  return w.trace.slice(index);
}

/** The index of the first `entry` in `trace`, failing if absent. */
function at(trace: readonly string[], entry: string): number {
  const index = trace.indexOf(entry);
  assert.ok(index >= 0, `no ${entry} in ${JSON.stringify(trace)}`);
  return index;
}

/** The ladder's own requests: none of them may appear on a resume. */
const LADDER = [
  "call:callCreate",
  "call:mlsCreateGroup",
  "call:callJoinIntent",
  "call:mlsJoinIntent",
];

function ladderCalls(trace: readonly string[]): string[] {
  return trace.filter((e) => LADDER.includes(e));
}

// ---- Console and timeline ----------------------------------------------------

/** Every `console` level silenced and recorded for the rest of the test. */
function captureConsole(t: TestContext) {
  return {
    error: t.mock.method(console, "error", () => {}),
    warn: t.mock.method(console, "warn", () => {}),
    info: t.mock.method(console, "info", () => {}),
  };
}

type Captured = ReturnType<typeof captureConsole>;

/** How many `level` lines from call `from` on start with `prefix`. */
function lines(
  logs: Captured,
  level: keyof Captured,
  prefix: string,
  from = 0,
): unknown[][] {
  return logs[level].mock.calls
    .slice(from)
    .filter((c) => String(c.arguments[0]).startsWith(prefix))
    .map((c) => c.arguments);
}

/**
 * Every re-securing the T0d fail-safe raised: `#toResecuring` logs
 * `("[mls] re-securing:", reason)`, and each fail-safe reason opens with
 * "no delivery-service verdict yet" (`negotiatingFailsafeReason`).
 */
function failsafeFirings(logs: Captured): unknown[] {
  return lines(logs, "warn", "[mls] re-securing:")
    .map((args) => String(args[1]))
    .filter((reason) => reason.startsWith("no delivery-service verdict"));
}

/** The stamp names of every `[mls] join timeline` line from call `from` on. */
function joinTimelines(logs: Captured, from = 0): string[][] {
  return lines(logs, "info", "[mls] join timeline", from).map((args) =>
    (args[1] as { stamps: { name: string }[] }).stamps.map((s) => s.name),
  );
}

// ---- Fleet drivers ------------------------------------------------------------

/** `id` drops off the SFU: every other seat watches it leave. */
function sfuLeave(fleet: Fleet, id: Identity): void {
  const key = identityOf(id);
  const any = fleet.seats[0];
  any.sfu = any.sfu.filter((p) => p !== key);
  for (const seat of fleet.seats) {
    if (identityOf(seat.me) !== key) seat.session.onParticipantLeft(key);
  }
}

/** `id` is back on the SFU: every other seat watches it join. */
function sfuReturn(fleet: Fleet, id: Identity): void {
  const key = identityOf(id);
  const any = fleet.seats[0];
  if (!any.sfu.includes(key)) any.sfu = [...any.sfu, key];
  any.sids.set(key, [`TR_${id.device_id}`]);
  for (const seat of fleet.seats) {
    if (identityOf(seat.me) !== key) seat.session.onParticipantJoined(key);
  }
}

/** Advance until `world`'s session is active, or fail after `boundMs`. */
async function untilActive(
  t: TestContext,
  world: World,
  boundMs: number,
  watches: Iterable<Watch>,
): Promise<void> {
  for (let waited = 0; waited < boundMs; waited += 250) {
    if (world.session.state() === "active") return;
    await run(t, 250, watches);
  }
  assert.equal(
    world.session.state(),
    "active",
    `${identityOf(world.me)} never went active`,
  );
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

/** Every seat holds `members` at the DS's epoch, on GROUP, active. */
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
  }
}

/** A seat that resumed is back in `e2ee`, publishing, on the DS's epoch. */
function assertResumed(fleet: Fleet, world: World): void {
  const id = identityOf(world.me);
  assert.equal(world.session.state(), "active", `${id}'s session`);
  assert.equal(world.session.callMode().kind, "e2ee", `${id}'s mode`);
  assert.equal(world.publishing(), true, `${id}'s gate is still held`);
  assert.equal(world.session.groupId(), GROUP, `${id}'s group`);
  assert.equal(world.localEpoch, fleet.ds.epoch, `${id}'s native epoch`);
}

// ---- One-seat drivers -----------------------------------------------------------

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A prefetch that passes every `resumeDecision` rule for a one-seat world
 * holding GROUP at epoch 0 with nothing missed, with `over` applied. Built
 * after `newWorld`, so `fetchedAtMs` is on the fake clock.
 */
function handPrefetch(world: World, over: Partial<Prefetch> = {}): Prefetch {
  return {
    groupId: GROUP,
    claimToken: null,
    fetchedAtMs: Date.now(),
    queriedChannelId: world.channelId,
    localEpoch: 0,
    localState: "active",
    localChannelId: world.channelId,
    selfInLocalRoster: true,
    openGroupId: GROUP,
    pendingCommit: null,
    commits: [],
    currentEpoch: 0,
    ...over,
  };
}

/** A fetched commit of GROUP at `epoch`, by PEER, as the prefetch carries it. */
function fetched(
  epoch: number,
  over: Partial<MlsCommitInfo> = {},
): MlsCommitInfo & { committerIsSelf: boolean } {
  return {
    group_id: GROUP,
    epoch,
    committer: PEER,
    commit: `commit-${epoch}`,
    added: [],
    removed: [],
    committerIsSelf: false,
    ...over,
  };
}

/**
 * A one-seat world whose host hands its session `prefetch` (resolved once
 * the world exists) and counts the session's aborts of it, each also traced
 * as `abort` in order with everything else.
 */
function oneSeat(
  t: TestContext,
  role: "creator" | "joiner",
  channel: string,
  prefetch: (world: World) => Prefetch | null,
): { world: World; w: Watch; aborts: () => number } {
  const dep = deferred<Prefetch | null>();
  const trace: string[] = [];
  let aborts = 0;
  const world = newWorld(t, role, channel, undefined, {
    resumePrefetch: dep.promise,
    abortResumePrefetch: () => {
      aborts++;
      trace.push("abort");
    },
  });
  const w = watch(world);
  tap(trace, (entry) => w.trace.push(entry));
  dep.resolve(prefetch(world));
  return { world, w, aborts: () => aborts };
}

/** `start()` and the detached establish's first run. */
async function startSession(t: TestContext, w: Watch): Promise<void> {
  void w.world.session.start();
  await flush();
  await run(t, 1, [w]);
}

// ---- The watcher itself ---------------------------------------------------------

test("watch: it records a live session publishing outside e2ee, and it looks at every gate edge", async (t) => {
  captureConsole(t);
  const { world, w } = oneSeat(t, "creator", "ch-resume-watch", () => null);
  // The session's own edges: the seeded `negotiating` gate is released only
  // with the `e2ee` label, so nothing is recorded on the way up.
  await startSession(t, w);
  await run(t, 3_000, [w]); // past the first install's rotation settle
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.ok(w.samples > 0);
  assert.deepEqual(w.violations, []);

  // A media failure outside every rotation window: loud, and the session
  // re-asserts the `negotiating` gate itself.
  world.session.noteEncryptionError(new Error("InvalidKey: x"));
  await flush();
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false);
  assert.deepEqual(w.violations, []);

  // A known-bad input: the gate released while the session is negotiating is
  // exactly a plaintext publish window, and it is recorded on the edge.
  world.gate.clear();
  world.gateLog.push("-negotiating");
  assert.equal(w.violations.length, 1, "the watcher missed a plaintext window");
  assert.match(w.violations[0], /published at "gate -negotiating"/);
});

// ---- (a) Ctrl+R inside the grace --------------------------------------------------

test("(a) Ctrl+R inside the grace, nothing missed: the held group resumes to e2ee with the gate released, and no intent, create or commit is sent", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-a";
  const fleet = newFleet(t, [SELF, PEER], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, 3_000, watches.values());
  const peer = fleet.seat(PEER);
  const w = watches.get(PEER_ID)!;
  const from = fleet.ds.submits.length;
  const mark = w.trace.length;
  const infos = logs.info.mock.calls.length;
  const epoch = fleet.ds.epoch;

  await fleet.reload(PEER);
  await run(t, 2_000, watches.values());

  assertResumed(fleet, peer);
  const trace = since(w, mark);
  assert.deepEqual(ladderCalls(trace), [], "the resume ran the ladder");
  assert.deepEqual(groupSubmits(fleet, from), [], "a commit was submitted");
  assert.equal(
    trace.some((e) => e.startsWith("wiped:")),
    false,
    "the resume wiped a group",
  );
  assert.equal(fleet.ds.openGroup(channel), GROUP, "the DS closed the group");
  // Adopted through the bridge, the grant cleared, and only then the keys of
  // the DS's current epoch installed (the explicit install: nothing was
  // processed, so native fired no keys-changed), then the gate released.
  assert.ok(
    at(trace, "call:prefetchResume") < at(trace, "call:releaseKeptGroup"),
  );
  assert.ok(
    at(trace, "call:releaseKeptGroup") < at(trace, "call:callClearDowngrade"),
  );
  assert.ok(at(trace, "call:callClearDowngrade") < at(trace, `keys:${epoch}`));
  assert.ok(at(trace, `keys:${epoch}`) < at(trace, "gate:-negotiating"));
  assert.deepEqual(
    trace.filter((e) => e.startsWith("keys:")),
    [`keys:${epoch}`],
    "keys read at another epoch",
  );
  // Stamped in execution order, and nothing of the ladder's.
  const [timeline, ...more] = joinTimelines(logs, infos);
  assert.deepEqual(more, [], "more than one join timeline");
  const stamp = (name: string) => at(timeline, name);
  assert.ok(stamp("prefetchDone") < stamp("catchUpDone"));
  assert.ok(stamp("catchUpDone") < stamp("resumed"));
  assert.ok(stamp("resumed") < stamp("keysInstalled"));
  assert.ok(stamp("keysInstalled") < stamp("modeE2ee"));
  for (const ladder of ["createRouted", "intentAccepted", "welcomeAdopted"]) {
    assert.equal(timeline.includes(ladder), false, `stamped ${ladder}`);
  }
  // The record now names the resumed group, fresh.
  assert.equal(readResumeRecord(peer.sessionStorage, channel)?.groupId, GROUP);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group", infos).length,
    1,
  );
  assertNoPlaintext(watches.values());
});

// ---- (a′) Hang-up and rejoin on one page ------------------------------------------

test("(a′, i′) hang-up → rejoin inside 10 s resumes through the kept group's claim, and the group is still live 25 s later", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-a2";
  const fleet = newFleet(t, [SELF, PEER], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, 3_000, watches.values());
  const peer = fleet.seat(PEER);
  const w = watches.get(PEER_ID)!;
  const from = fleet.ds.submits.length;
  const mark = w.trace.length;
  const infos = logs.info.mock.calls.length;

  // The hang-up is an SFU departure too; the rejoin comes back inside the
  // members' leave-grace.
  await fleet.rejoin(PEER);
  sfuLeave(fleet, PEER);
  const prefetch = await peer.resumePrefetch;
  assert.equal(prefetch?.groupId, GROUP);
  assert.notEqual(prefetch?.claimToken ?? null, null, "no claim was taken");
  await run(t, 2_000, watches.values());
  sfuReturn(fleet, PEER);
  await run(t, 1_000, watches.values());

  assertResumed(fleet, peer);
  const trace = since(w, mark);
  assert.deepEqual(ladderCalls(trace), []);
  assert.ok(
    at(trace, "call:keepLocalGroup") < at(trace, "call:prefetchResume"),
  );
  assert.ok(
    at(trace, "call:prefetchResume") < at(trace, "call:releaseKeptGroup"),
  );
  assert.equal(peer.kept.size, 0, "the adopted entry is still tracked");
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group", infos).length,
    1,
  );

  // R2-B1: the claim's suspended timer died with the release, so nothing
  // deletes the live group at its old deadline or any later one.
  await run(t, 25_000, watches.values());
  assertResumed(fleet, peer);
  assert.equal(
    since(w, mark).some((e) => e === `wiped:${GROUP}`),
    false,
    "the resumed group was deleted under the live call",
  );
  assert.ok(peer.localGroups.has(GROUP));
  assert.deepEqual(groupSubmits(fleet, from), [], "a commit was submitted");
  assertConverged(fleet, [SELF_ID, PEER_ID]);
  assertNoPlaintext(watches.values());
});

// ---- (f) The sole member --------------------------------------------------------

test("(f) a sole member's reload resumes and sends no intent, so the DS never closes its group", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-f";
  const fleet = newFleet(t, [SELF], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, 3_000, watches.values());
  const self = fleet.seat(SELF);
  const w = watches.get(SELF_ID)!;
  const mark = w.trace.length;

  await fleet.reload(SELF);
  await run(t, 2_000, watches.values());

  assertResumed(fleet, self);
  // An intent from the only member closes the group at the DS (`join_intent`'s
  // solo close), and the next create would mint a successor.
  assert.deepEqual(ladderCalls(since(w, mark)), []);
  assert.equal(fleet.ds.openGroup(channel), GROUP, "the DS closed the group");
  assert.deepEqual(fleet.ds.members.map(identityOf), [SELF_ID]);
  assertNoPlaintext(watches.values());
});

// ---- (g) A fleet peer's reload --------------------------------------------------

test("(g) fleet: PEER's reload inside the grace — no seat stages a Remove or an Add, every seat ends on one epoch, PEER enrolled", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-g";
  const fleet = newFleet(t, [SELF, PEER, THIRD], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  // Past §4.8's window for the bring-up's own Adds, so a rejoin intent WOULD
  // be served now: a reload that fell back to today's ladder would show here
  // as a Remove and an Add.
  await run(t, REJOIN_SERVE_SUPPRESS_MS + 5_000, watches.values());
  const peer = fleet.seat(PEER);
  const from = fleet.ds.submits.length;
  const marks = new Map([...watches].map(([id, w]) => [id, w.trace.length]));
  const epoch = fleet.ds.epoch;

  // The page dies: its room connection with it, so both members watch PEER
  // leave the SFU. The new page reconnects well inside their leave-grace.
  sfuLeave(fleet, PEER);
  await fleet.reload(PEER);
  await run(t, 1_500, watches.values());
  sfuReturn(fleet, PEER);
  // Past every leave-grace, admit stagger and serve window.
  await run(t, 30_000, watches.values());

  assert.deepEqual(groupSubmits(fleet, from), [], "a seat submitted a commit");
  for (const [id, w] of watches) {
    const trace = since(w, marks.get(id)!);
    for (const staged of ["call:callRemove", "call:callAdmit"]) {
      assert.equal(trace.includes(staged), false, `${id} staged ${staged}`);
    }
  }
  assert.equal(fleet.ds.epoch, epoch);
  assertResumed(fleet, peer);
  assertConverged(fleet, [SELF_ID, PEER_ID, THIRD_ID]);
  for (const seat of fleet.seats) {
    assert.equal(seat.session.callMode().kind, "e2ee");
  }
  assertNoPlaintext(watches.values());
});

// ---- (b) Missed commits ----------------------------------------------------------

/** Two more devices, so three can join while PEER's page is gone. */
const DAVE: Identity = { user_id: "dave", device_id: "devD" };
const ERIN: Identity = { user_id: "erin", device_id: "devE" };

/**
 * `world` joins the running call through the real ladder, as `bringUp` seats
 * a joiner: onto the SFU (every live seat watches it arrive), started, and
 * admitted by leaf 0.
 */
async function joinSeat(
  t: TestContext,
  fleet: Fleet,
  world: World,
  watches: Iterable<Watch>,
): Promise<void> {
  const id = identityOf(world.me);
  const room = fleet.seats[0];
  if (!room.sfu.includes(id)) room.sfu = [...room.sfu, id];
  room.sids.set(id, [`TR_${world.me.device_id}`]);
  for (const seat of fleet.seats) {
    if (seat !== world && seat.session.state() === "active") {
      seat.session.onParticipantJoined(id);
    }
  }
  void world.session.start();
  await flush();
  await untilActive(t, world, 10_000, watches);
}

/**
 * SELF and PEER up; PEER's page dies; THIRD, DAVE and ERIN join while it is
 * gone, so the DS is three Adds (epochs 2–4) past PEER's row at epoch 1, and
 * PEER's mailbox holds all three.
 */
async function threeMissed(t: TestContext, channel: string) {
  const fleet = newFleet(t, [SELF, PEER, THIRD, DAVE, ERIN], channel);
  const watches = watchFleet(fleet);
  const peer = fleet.seat(PEER);
  await joinSeat(t, fleet, fleet.seat(SELF), watches.values());
  await joinSeat(t, fleet, peer, watches.values());
  await run(t, 3_000, watches.values());
  peer.pageDeath();
  for (const id of [THIRD, DAVE, ERIN]) {
    await joinSeat(t, fleet, fleet.seat(id), watches.values());
  }
  assert.equal(peer.localEpoch, 1);
  assert.equal(fleet.ds.epoch, 4);
  assert.deepEqual(
    peer.mailbox.map((e) => [e.content_type, e.epoch]),
    [
      ["mls_commit", 2],
      ["mls_commit", 3],
      ["mls_commit", 4],
    ],
  );
  return { fleet, watches, peer, w: watches.get(PEER_ID)! };
}

const FIVE = [SELF_ID, PEER_ID, THIRD_ID, identityOf(DAVE), identityOf(ERIN)];

test("(b) three missed commits, fetched: applied in order by the catch-up, the epoch is the DS's, and the keys are installed at the current epoch", async (t) => {
  captureConsole(t);
  const { fleet, watches, peer, w } = await threeMissed(t, "ch-resume-b");
  // Only the fetch can deliver them: the mailbox copies are gone (bonfire's
  // queue budget, which the harness DS does not model otherwise).
  fleet.ds.ack(
    PEER,
    peer.mailbox.map((e) => e.id),
  );
  const processed = peer.native.processed.size;
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;

  await fleet.reload(PEER);
  const prefetch = await peer.resumePrefetch;
  assert.deepEqual(
    prefetch?.commits.map((c) => c.epoch),
    [2, 3, 4],
  );
  await run(t, 2_000, watches.values());

  assertResumed(fleet, peer);
  assert.deepEqual(
    [...peer.native.processed].slice(processed),
    [2, 3, 4].map((e) => `mls-synth:${GROUP}:${e}`),
    "not applied by the catch-up, in order",
  );
  // Keys only at the current epoch: the explicit install at 4 runs before
  // native's keys-changed for 2 and 3 arrive, which are then stale and
  // dropped; native's own 4 is the same install re-asserted. No frame key of
  // an intermediate epoch is ever read, and the gate opens after the install.
  const trace = since(w, mark);
  const keys = trace.filter((e) => e.startsWith("keys:"));
  assert.ok(keys.length > 0, "no keys were installed");
  assert.deepEqual([...new Set(keys)], ["keys:4"]);
  assert.ok(at(trace, "keys:4") < at(trace, "gate:-negotiating"));
  // The catch-up applied all three before native confirmed the epoch.
  assert.ok(
    trace.lastIndexOf("call:processEnvelope") < at(trace, "call:callState"),
  );
  assert.deepEqual(ladderCalls(trace), []);
  assert.deepEqual(groupSubmits(fleet, from), []);
  assertConverged(fleet, FIVE);
  assertNoPlaintext(watches.values());
});

test("(b′) the drained copies were applied first, as another group's: every fetched commit is a duplicate, which counts as clean", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await threeMissed(t, "ch-resume-b2");
  const drained = peer.mailbox.map((e) => e.id);
  const processed = peer.native.processed.size;
  const mark = w.trace.length;
  const infos = logs.info.mock.calls.length;

  await fleet.reload(PEER);
  const prefetch = await peer.resumePrefetch;
  // Read before the drain was consumed: PEER at 1, three commits missing.
  assert.equal(prefetch?.localEpoch, 1);
  assert.deepEqual(
    prefetch?.commits.map((c) => c.epoch),
    [2, 3, 4],
  );
  await run(t, 2_000, watches.values());

  assertResumed(fleet, peer);
  // Applied once each, by the drain; the catch-up's copies were duplicates.
  assert.deepEqual([...peer.native.processed].slice(processed), drained);
  assert.deepEqual(peer.mailbox, [], "a drained copy was left unacked");
  assert.equal(lines(logs, "warn", "[mls] resume catch-up stopped").length, 0);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group", infos).length,
    1,
  );
  assert.deepEqual(ladderCalls(since(w, mark)), []);
  assertConverged(fleet, FIVE);
  assertNoPlaintext(watches.values());
});

// ---- (c) A failed commits fetch ---------------------------------------------------

/**
 * SELF and PEER up, past §4.8's serve window for the bring-up's Add, so a
 * fallback rejoin intent from PEER is served (a Remove, then the re-intent's
 * Add) as today.
 */
async function pairUp(t: TestContext, channel: string) {
  const fleet = newFleet(t, [SELF, PEER], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, REJOIN_SERVE_SUPPRESS_MS + 5_000, watches.values());
  const peer = fleet.seat(PEER);
  return { fleet, watches, peer, w: watches.get(PEER_ID)! };
}

/**
 * Today's ladder after an abandoned resume, from `mark` on: the held group
 * was wiped BEFORE the first create and the first intent, the served rejoin
 * then re-seated PEER (a Remove, the re-intent's Add), and nothing resumed.
 * `members` is who the call converges on.
 */
async function assertCleanJoin(
  t: TestContext,
  fleet: Fleet,
  w: Watch,
  mark: number,
  from: number,
  watches: Iterable<Watch>,
  members: string[] = [SELF_ID, PEER_ID],
): Promise<void> {
  const peer = w.world;
  await untilActive(t, peer, 40_000, watches);
  await run(t, 5_000, watches);
  const trace = since(w, mark);
  const wiped = at(trace, `wiped:${GROUP}`);
  assert.ok(wiped < at(trace, "call:callCreate"), "created before the wipe");
  assert.ok(wiped < at(trace, "call:callJoinIntent"), "intent before the wipe");
  const epoch = groupSubmits(fleet, from)[0]?.[2] ?? -1;
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch, "won"],
    [SELF_ID, "admit", epoch + 1, "won"],
  ]);
  assert.equal(peer.session.callMode().kind, "e2ee");
  assert.equal(peer.session.groupId(), GROUP);
  assert.equal(peer.localEpoch, fleet.ds.epoch);
  assert.deepEqual(fleet.ds.members.map(identityOf), members);
  for (const id of members) {
    const seat = fleet.seat(id);
    assert.equal(seat.session.state(), "active", `${id}'s session`);
    assert.equal(seat.localEpoch, fleet.ds.epoch, `${id}'s native epoch`);
    assert.deepEqual(seat.localRoster.map(identityOf), members);
  }
}

for (const [status, error] of [
  [
    "404",
    new Error(
      `E2EE MLS GET /mls/groups/${GROUP}/commits?from_epoch=2 failed: 404`,
    ),
  ],
  ["500", undefined],
] as const) {
  test(`(c) the commits fetch fails ${status}: the held group is deleted, and only then does today's ladder run`, async (t) => {
    const logs = captureConsole(t);
    const channel = `ch-resume-c${status}`;
    const { fleet, watches, peer, w } = await pairUp(t, channel);
    const mark = w.trace.length;
    const from = fleet.ds.submits.length;
    const warns = logs.warn.mock.calls.length;

    fleet.ds.failFetchCommitsOnce(error);
    await fleet.reload(PEER);
    assert.equal(await peer.resumePrefetch, null);
    assert.deepEqual(
      lines(logs, "warn", "[mls] resume prefetch abandoned", warns).map(
        (args) => (args[1] as { why: string }).why,
      ),
      ["read failed"],
    );
    assert.equal(readResumeRecord(peer.sessionStorage, channel), null);

    await assertCleanJoin(t, fleet, w, mark, from, watches.values());
    assert.equal(
      lines(logs, "info", "[mls] resumed the held call group").length,
      0,
    );
    assertNoPlaintext(watches.values());
  });
}

// ---- (d) A lag the live session would call desync ----------------------------------

type Outcome = World["outcomes"] extends Map<string, infer O> ? O : never;

/**
 * `world.outcomes`, answering each fetched commit's synthetic envelope as
 * `commit_applied` and moving the world's native epoch to it as it is
 * processed: the one-seat fake's `processEnvelope` reads the outcome but
 * never moves the epoch itself.
 */
function applyFetched(world: World, epochs: readonly number[]): void {
  class Applying extends Map<string, Outcome> {
    override get(id: string): Outcome | undefined {
      const outcome = super.get(id);
      if (outcome && id.startsWith("mls-synth:")) world.epoch = outcome.epoch;
      return outcome;
    }
  }
  const outcomes = new Applying(world.outcomes);
  for (const epoch of epochs) {
    outcomes.set(`mls-synth:${GROUP}:${epoch}`, {
      group_id: GROUP,
      kind: "commit_applied",
      epoch,
      removed_self: false,
      removed: [],
    });
  }
  world.outcomes = outcomes;
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

test(`(d) a lag of RESUME_MAX_LAG (${RESUME_MAX_LAG}) abandons the held group: deleted, then today's create; one less is caught up`, async (t) => {
  const logs = captureConsole(t);
  const lagging = oneSeat(t, "creator", "ch-resume-d12", (world) =>
    handPrefetch(world, {
      currentEpoch: RESUME_MAX_LAG,
      commits: range(1, RESUME_MAX_LAG).map((e) => fetched(e)),
    }),
  );
  await startSession(t, lagging.w);
  await run(t, 2_000, [lagging.w]);
  const trace = lagging.w.trace;
  assert.ok(at(trace, "abort") < at(trace, `wiped:${GROUP}`));
  assert.ok(at(trace, `wiped:${GROUP}`) < at(trace, "call:callCreate"));
  assert.equal(
    trace.includes("call:processEnvelope"),
    false,
    "a commit of the abandoned group was applied",
  );
  assert.equal(lagging.world.session.callMode().kind, "e2ee");
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );

  // The boundary: RESUME_MAX_LAG − 1 is caught up, commit by commit.
  const infos = logs.info.mock.calls.length;
  const lag = RESUME_MAX_LAG - 1;
  const caught = oneSeat(t, "creator", "ch-resume-d11", (world) => {
    applyFetched(world, range(1, lag));
    return handPrefetch(world, {
      currentEpoch: lag,
      commits: range(1, lag).map((e) => fetched(e)),
    });
  });
  await startSession(t, caught.w);
  await run(t, 2_000, [caught.w]);
  assert.deepEqual(ladderCalls(caught.w.trace), []);
  assert.equal(caught.aborts(), 0);
  assert.equal(
    caught.w.trace.filter((e) => e === "call:processEnvelope").length,
    lag,
  );
  assert.equal(caught.world.epoch, lag);
  assert.equal(caught.world.session.callMode().kind, "e2ee");
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group", infos).length,
    1,
  );
  assertNoPlaintext([lagging.w, caught.w]);
});

// ---- (e) A removal of this device ---------------------------------------------------

/** The warn of each group action dropped as `kind`, from call `from` on. */
function droppedActions(logs: Captured, kind: string, from = 0): unknown[] {
  return lines(
    logs,
    "warn",
    "[mls] group action dropped while another is in flight",
    from,
  ).filter((args) => (args[1] as { kind: string }).kind === kind);
}

/** Advance until `world` has sent a join intent, or fail after 5 s. */
async function untilIntent(t: TestContext, w: Watch): Promise<void> {
  for (let waited = 0; w.world.joinIntents() === 0 && waited < 5_000; ) {
    await run(t, 250, [w]);
    waited += 250;
  }
  assert.ok(w.world.joinIntents() > 0, "the join path never sent an intent");
}

/**
 * A one-seat joiner's fallback into GROUP, from its first intent to e2ee:
 * the admitter's Welcome at `epoch` lands, then native's keys-changed for it.
 */
async function welcomeBack(
  t: TestContext,
  w: Watch,
  epoch: number,
): Promise<void> {
  const world = w.world;
  await untilIntent(t, w);
  await world.welcome(epoch);
  assert.equal(world.session.state(), "active");
  await world.session.onLocalKeysChanged(GROUP, epoch);
  await run(t, 1_000, [w]);
  assert.equal(world.session.callMode().kind, "e2ee");
}

test("(e, e″) a fetched commit removing this device: the catch-up stops, the held group is deleted before today's ladder, and the fallback into the SAME group id is not torn down by the dropped removal", async (t) => {
  const logs = captureConsole(t);
  const { world, w } = oneSeat(t, "joiner", "ch-resume-e", (wd) => {
    applyFetched(wd, [1]);
    wd.outcomes.set(`mls-synth:${GROUP}:2`, {
      group_id: GROUP,
      kind: "commit_applied",
      epoch: 2,
      removed_self: true,
      removed: [SELF],
    });
    return handPrefetch(wd, {
      currentEpoch: 2,
      commits: [fetched(1), fetched(2, { removed: [SELF] })],
    });
  });

  await startSession(t, w);
  // The removal's own group action was dropped while the establish ran: the
  // stale record R2-M3 is about now exists for GROUP.
  assert.equal(droppedActions(logs, "removed_self").length, 1);
  const trace = w.trace;
  assert.equal(trace.filter((e) => e === "call:processEnvelope").length, 2);
  const wiped = at(trace, `wiped:${GROUP}`);
  assert.ok(trace.lastIndexOf("call:processEnvelope") < wiped);
  assert.ok(at(trace, "abort") < wiped);
  assert.ok(wiped < at(trace, "call:callCreate"), "created before the wipe");

  await welcomeBack(t, w, 3);
  assert.ok(wiped < at(trace, "call:callJoinIntent"));
  // The fallback re-entered GROUP in the same generation. The record went
  // with the step-6 cleanup, so nothing acts on it now or later.
  await run(t, 30_000, [w]);
  assert.equal(world.session.groupId(), GROUP);
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.deepEqual(
    trace.filter((e) => e === `wiped:${GROUP}`),
    [`wiped:${GROUP}`],
    "the fallback's group was torn down",
  );
  for (const line of [
    "[mls] dropped removal is moot: still in the group",
    "[mls] acting on a removal dropped mid-action",
  ]) {
    assert.equal(
      lines(logs, "info", line).length + lines(logs, "warn", line).length,
      0,
      `the step-6 cleanup left the record: ${line}`,
    );
  }
  assertNoPlaintext([w]);
});

/**
 * Hold the one-seat world's drain inside ANOTHER group's envelope, with a
 * stale removal of this device (epoch 0) queued behind it, then run the
 * startup establish: it adopts GROUP, and its catch-up waits on the lock the
 * drain holds. Released, the drain consumes the removal in the same batch,
 * now for the adopted group and with the establish still in flight, so the
 * removal's group action is dropped and recorded. `selfPresent` is what
 * native's roster says afterwards.
 */
async function removalDuringResume(
  t: TestContext,
  w: Watch,
  logs: Captured,
  selfPresent: boolean,
): Promise<void> {
  const world = w.world;
  void world.session.start();
  await flush();
  const release = world.holdProcessEnvelope();
  world.outcomes.set("env-other", {
    group_id: "group-other",
    kind: "commit_applied",
    epoch: 5,
    removed_self: false,
    removed: [],
  });
  assert.ok(world.sink);
  world.sink({
    kind: "envelope",
    envelope: {
      id: "env-other",
      content_type: "mls_commit",
      group_id: "group-other",
      epoch: 5,
      ciphertext: "",
    },
    recipientDeviceId: SELF.device_id,
  });
  await world.removedSelf(0);
  await run(t, 1, [w]);
  assert.equal(world.session.groupId(), GROUP, "the resume did not adopt");
  assert.equal(droppedActions(logs, "removed_self").length, 0);
  if (!selfPresent) world.roster = [PEER];
  release();
  await flush();
  assert.equal(droppedActions(logs, "removed_self").length, 1);
}

test("(e′) a removal drained DURING the resume, native still listing this device: recorded, re-checked at the action's end, moot — the resume stands", async (t) => {
  const logs = captureConsole(t);
  const { world, w } = oneSeat(t, "creator", "ch-resume-e1", (wd) =>
    handPrefetch(wd),
  );
  await removalDuringResume(t, w, logs, true);
  await run(t, 2_000, [w]);

  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    1,
  );
  assert.equal(
    lines(logs, "info", "[mls] dropped removal is moot: still in the group")
      .length,
    1,
    "the record was never re-checked",
  );
  assert.equal(
    lines(logs, "warn", "[mls] acting on a removal dropped mid-action").length,
    0,
  );
  assert.equal(w.trace.includes(`wiped:${GROUP}`), false);
  assert.deepEqual(ladderCalls(w.trace), []);
  assert.equal(world.session.groupId(), GROUP);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true);
  assertNoPlaintext([w]);
});

test("(e′, e″) the same removal with native no longer listing this device: the catch-up's native check refuses, step 6 clears the record, and the fallback into the SAME group id is left alone", async (t) => {
  const logs = captureConsole(t);
  const { world, w } = oneSeat(t, "joiner", "ch-resume-e2", (wd) =>
    handPrefetch(wd),
  );
  await removalDuringResume(t, w, logs, false);
  await run(t, 1, [w]);
  assert.equal(
    lines(logs, "warn", "[mls] resume catch-up not confirmed by native state")
      .length,
    1,
  );
  const wiped = at(w.trace, `wiped:${GROUP}`);
  assert.ok(wiped < at(w.trace, "call:callCreate"));

  world.roster = [SELF, PEER]; // the fallback's Welcome seats this device
  await welcomeBack(t, w, 1);
  await run(t, 30_000, [w]);
  for (const line of [
    "[mls] dropped removal is moot: still in the group",
    "[mls] acting on a removal dropped mid-action",
  ]) {
    assert.equal(
      lines(logs, "info", line).length + lines(logs, "warn", line).length,
      0,
      `the step-6 cleanup left the record: ${line}`,
    );
  }
  assert.deepEqual(
    w.trace.filter((e) => e === `wiped:${GROUP}`),
    [`wiped:${GROUP}`],
  );
  assert.equal(world.session.groupId(), GROUP);
  assert.equal(world.session.callMode().kind, "e2ee");
  assertNoPlaintext([w]);
});

test("(e′) a removal recorded while the startup's join ladder waits for its Welcome, native not listing this device once it lands: acted on — the group is left and the device rejoins", async (t) => {
  const logs = captureConsole(t);
  const { world, w } = oneSeat(t, "joiner", "ch-resume-e3", () => null);
  await startSession(t, w);
  await untilIntent(t, w);
  assert.equal(world.session.groupId(), GROUP);
  await world.removedSelf(1);
  assert.equal(droppedActions(logs, "removed_self").length, 1);
  const intents = world.joinIntents();
  const mark = w.trace.length;

  world.roster = [PEER];
  await world.welcome(2);
  await run(t, 1_000, [w]);

  assert.equal(
    lines(logs, "warn", "[mls] acting on a removal dropped mid-action").length,
    1,
  );
  assert.ok(since(w, mark).includes(`wiped:${GROUP}`), "the group was kept");
  await run(t, 2_000, [w]);
  assert.ok(world.joinIntents() > intents, "the device never rejoined");
  assertNoPlaintext([w]);
});

// ---- (h) A commit between the prefetch and the catch-up ------------------------------

test("(h) fleet: THIRD's leave-grace fires after PEER's prefetch settled and before its catch-up — native is past the fetched epoch, the resume is refused, and PEER converges through the clean join", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-h";
  const fleet = newFleet(t, [SELF, PEER, THIRD], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, REJOIN_SERVE_SUPPRESS_MS + 5_000, watches.values());
  const peer = fleet.seat(PEER);
  const w = watches.get(PEER_ID)!;

  // THIRD drops off the SFU; SELF's leave-grace for it runs.
  sfuLeave(fleet, THIRD);
  await run(t, LOCAL_GROUP_KEEP_MS - 1_000, watches.values());

  // PEER's page dies. The new page's host starts the prefetch before its
  // room connects (under a controller of the spec's, standing for
  // `state.tsx`'s), and it settles at once: GROUP, nothing missed.
  peer.pageDeath();
  const dep = deferred<Prefetch | null>();
  const controller = new AbortController();
  peer.boot({
    resumePrefetch: dep.promise,
    abortResumePrefetch: () => controller.abort(),
  });
  const mark = w.trace.length;
  const prefetch = await peer.bridge.prefetchResume(channel, controller.signal);
  assert.equal(prefetch?.groupId, GROUP);
  assert.equal(prefetch?.currentEpoch, fleet.ds.epoch);
  void peer.session.start();
  await flush();

  // The room connect takes a while. Meanwhile SELF's grace fires, and its
  // Remove of THIRD reaches PEER as ANOTHER group's envelope (nothing is
  // adopted yet), which native applies.
  const from = fleet.ds.submits.length;
  await run(t, 1_500, watches.values());
  assert.equal(fleet.ds.epoch, prefetch!.currentEpoch + 1, "no Remove");
  assert.equal(peer.localEpoch, fleet.ds.epoch, "PEER's native missed it");
  assert.equal(peer.session.groupId(), null);

  // The session reads the prefetch it was handed, inside its bound.
  dep.resolve(prefetch);
  await run(t, 1, watches.values());
  assert.equal(
    lines(logs, "warn", "[mls] resume catch-up not confirmed by native state")
      .length,
    1,
  );
  assert.ok(controller.signal.aborted, "the join path left the prefetch live");

  await assertCleanJoin(t, fleet, w, mark, from + 1, watches.values());
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

// ---- (h′) A stale rejoin intent served after the resume -----------------------------

test("(h′) fleet: a stale pre-reload rejoin intent served after the resume removes PEER, whose removal handler rejoins it cleanly (audit Q5)", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-h2";
  const fleet = newFleet(t, [SELF, PEER, THIRD], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, REJOIN_SERVE_SUPPRESS_MS + 5_000, watches.values());
  const peer = fleet.seat(PEER);
  const w = watches.get(PEER_ID)!;
  const from = fleet.ds.submits.length;

  await fleet.reload(PEER);
  await run(t, 2_000, watches.values());
  assertResumed(fleet, peer);
  const mark = w.trace.length;
  const epoch = fleet.ds.epoch;

  // An intent PEER's previous page sent reaches the members only now,
  // flagged `rejoin` (PEER's leaf is in the roster). Each member serves it
  // on its own stagger; leaf 0's Remove reaches PEER as a removal of itself.
  await fleet.seat(SELF).joinRequest(PEER, { rejoin: true });
  await fleet.seat(THIRD).joinRequest(PEER, { rejoin: true });
  await run(t, 2_000, watches.values());
  assert.deepEqual(
    groupSubmits(fleet, from)[0],
    [SELF_ID, "remove", epoch + 1, "won"],
    "the stale intent was not served",
  );
  assert.deepEqual(fleet.ds.log[epoch]?.removed.map(identityOf), [PEER_ID]);
  const trace = since(w, mark);
  assert.ok(at(trace, `wiped:${GROUP}`) < at(trace, "call:callJoinIntent"));
  // The removal handler's re-establish is not the startup's: no resume.
  assert.equal(trace.includes("call:releaseKeptGroup"), false);
  assert.equal(trace.includes("call:discardKeptForChannel"), false);

  await untilActive(t, peer, 40_000, watches.values());
  await run(t, 10_000, watches.values());
  assert.deepEqual(groupSubmits(fleet, from), [
    [SELF_ID, "remove", epoch + 1, "won"],
    [SELF_ID, "admit", epoch + 2, "won"],
  ]);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    1,
  );
  assert.equal(peer.session.callMode().kind, "e2ee");
  assertConverged(fleet, [SELF_ID, PEER_ID, THIRD_ID]);
  assertNoPlaintext(watches.values());
});

// ---- (i) The keep's lifetime ----------------------------------------------------------

/** SELF and PEER up and settled; PEER is the seat that hangs up. */
async function settledPair(t: TestContext, channel: string) {
  const fleet = newFleet(t, [SELF, PEER], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, 3_000, watches.values());
  const peer = fleet.seat(PEER);
  return { fleet, watches, peer, w: watches.get(PEER_ID)! };
}

test("(i) a hung-up group is kept for 10 s and then deleted, with its record", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-i";
  const { watches, peer, w } = await settledPair(t, channel);
  const mark = w.trace.length;

  peer.hangUp();
  await flush();
  assert.equal(peer.kept.size, 1);
  assert.equal(readResumeRecord(peer.sessionStorage, channel)?.groupId, GROUP);
  await run(t, LOCAL_GROUP_KEEP_MS - 250, watches.values());
  assert.ok(peer.localGroups.has(GROUP), "deleted before its keep ran out");
  assert.equal(since(w, mark).includes(`wiped:${GROUP}`), false);

  await run(t, 500, watches.values());
  assert.equal(peer.localGroups.has(GROUP), false, "the keep never expired");
  assert.ok(since(w, mark).includes(`wiped:${GROUP}`));
  assert.equal(peer.kept.size, 0);
  assert.equal(readResumeRecord(peer.sessionStorage, channel), null);
  assertNoPlaintext(watches.values());
});

test("(i) a discarding hang-up deletes the group at once, whichever of the session and the bridge hears the sign-out first; a sign-out after a plain hang-up deletes every kept group, every channel's", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-i2";
  const discard = await settledPair(t, channel);
  discard.peer.hangUp({ discardMls: true });
  await flush();
  assert.equal(discard.peer.localGroups.has(GROUP), false, "not at once");
  assert.equal(discard.peer.kept.size, 0);
  assert.equal(readResumeRecord(discard.peer.sessionStorage, channel), null);

  // The session's own discard, before the bridge's sign-out belt has run
  // (`hangUp` runs the belt first, which alone refuses the keep): nothing is
  // kept or recorded, and the group goes at once.
  const channel2 = "ch-resume-i2b";
  const first = await settledPair(t, channel2);
  const mark = first.w.trace.length;
  first.peer.session.dispose({ discard: true });
  await flush();
  const trace = since(first.w, mark);
  assert.equal(trace.includes("call:keepLocalGroup"), false, "kept");
  assert.equal(trace.includes("call:touchResumeRecord"), false, "recorded");
  assert.equal(first.peer.localGroups.has(GROUP), false, "not at once");
  assert.equal(readResumeRecord(first.peer.sessionStorage, channel2), null);

  const channel3 = "ch-resume-i3";
  const { peer, watches } = await settledPair(t, channel3);
  // Another channel's group, kept by an earlier call on this page.
  peer.native.localGroups.set("group-elsewhere", {
    channelId: "ch-elsewhere",
    epoch: 0,
    leaves: [PEER],
    state: "active",
  });
  assert.equal(
    peer.bridge.keepLocalGroup("group-elsewhere", "ch-elsewhere", 10_000),
    true,
  );
  writeResumeRecord(peer.sessionStorage, "ch-elsewhere", {
    groupId: "group-elsewhere",
    epoch: 0,
    at: Date.now(),
  });
  peer.hangUp();
  await flush();
  assert.equal(peer.kept.size, 2);

  peer.hangUp({ discardMls: true }); // the sign-out
  await flush();
  assert.equal(peer.localGroups.has(GROUP), false);
  assert.equal(peer.localGroups.has("group-elsewhere"), false);
  assert.equal(peer.kept.size, 0);
  assert.equal(peer.sessionStorage.length, 0, "a record survived the sign-out");
  assert.equal(peer.bridge.keepLocalGroup("group-later", channel3, 1), false);
  assertNoPlaintext([
    ...watches.values(),
    ...discard.watches.values(),
    ...first.watches.values(),
  ]);
});

// ---- (i′) R2-B1: claims, entries and deadlines ------------------------------------------

test("(i′) an abandoned claim is handed back and the group deleted at its ORIGINAL deadline", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-i4";
  const { watches, peer } = await settledPair(t, channel);
  peer.hangUp();
  const deadline = Date.now() + LOCAL_GROUP_KEEP_MS;
  await run(t, 3_000, watches.values());

  // A connect's prefetch claims the entry, and the connect is abandoned
  // before its session ever starts.
  peer.connect({ prefetchFromBridge: true });
  const prefetch = await peer.resumePrefetch;
  assert.notEqual(prefetch?.claimToken ?? null, null, "nothing was claimed");
  await run(t, 1_000, watches.values());
  peer.hangUp();
  assert.equal(peer.resumePrefetchSignal?.aborted, true);

  await run(t, deadline - Date.now() - 250, watches.values());
  assert.ok(peer.localGroups.has(GROUP), "deleted before the deadline");
  await run(t, 500, watches.values());
  assert.equal(
    peer.localGroups.has(GROUP),
    false,
    "the claim moved the deadline",
  );
  assert.equal(readResumeRecord(peer.sessionStorage, channel), null);
  assertNoPlaintext(watches.values());
});

test("(i′) resume, then hang up: the new keep is a FRESH entry that expires 10 s later", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-i5";
  const { fleet, watches, peer, w } = await settledPair(t, channel);
  await fleet.rejoin(PEER);
  await run(t, 2_000, watches.values());
  assertResumed(fleet, peer);
  const mark = w.trace.length;

  peer.hangUp();
  await flush();
  assert.equal(peer.kept.size, 1);
  await run(t, LOCAL_GROUP_KEEP_MS - 250, watches.values());
  assert.ok(peer.localGroups.has(GROUP));
  await run(t, 500, watches.values());
  assert.equal(
    peer.localGroups.has(GROUP),
    false,
    "the new keep never expired",
  );
  assert.ok(since(w, mark).includes(`wiped:${GROUP}`));
  assertNoPlaintext(watches.values());
});

test("(i′) two connects race on one channel, the first superseded mid-prefetch: the winner resumes and the group is live 25 s later", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-i6";
  const { fleet, watches, peer, w } = await settledPair(t, channel);
  peer.hangUp();
  const releaseOpen = fleet.ds.holdOpenGroup();

  // The first connect claims the entry; its open-group read hangs.
  peer.connect({ prefetchFromBridge: true });
  const first = peer.session;
  const firstPrefetch = peer.resumePrefetch;
  void first.start();
  await flush();
  await run(t, 500, watches.values());
  assert.equal(peer.kept.size, 1);

  // Superseded: the hang-up aborts its prefetch (the claim goes back at
  // once), and the next connect claims the entry again.
  peer.hangUp();
  peer.connect({ prefetchFromBridge: true });
  void peer.session.start();
  await flush();
  assert.equal(await firstPrefetch, null, "the superseded prefetch resolved");
  releaseOpen();
  await run(t, 2_000, watches.values());

  assert.equal(first.state(), "closed");
  assertResumed(fleet, peer);
  assert.notEqual((await peer.resumePrefetch)?.claimToken ?? null, null);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    1,
  );
  const mark = w.trace.length;
  await run(t, 25_000, watches.values());
  assertResumed(fleet, peer);
  assert.equal(since(w, mark).includes(`wiped:${GROUP}`), false);
  assert.ok(peer.localGroups.has(GROUP));
  assertNoPlaintext(watches.values());
});

test("(i′) a kept group whose expiry delete is in flight is never adopted by the next connect: it joins after the delete", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-i7";
  const fleet = newFleet(t, [SELF, PEER], channel);
  const watches = watchFleet(fleet);
  await fleet.bringUp();
  await run(t, REJOIN_SERVE_SUPPRESS_MS + 5_000, watches.values());
  const peer = fleet.seat(PEER);
  const w = watches.get(PEER_ID)!;
  const from = fleet.ds.submits.length;

  peer.hangUp();
  const releaseLeave = peer.holdLeaveCleanup();
  await run(t, LOCAL_GROUP_KEEP_MS + 250, watches.values());
  assert.ok(peer.kept.isInFlight(GROUP), "the expiry delete never started");
  assert.ok(peer.localGroups.has(GROUP), "the held delete already ran");
  const mark = w.trace.length;

  peer.connect({ prefetchFromBridge: true });
  assert.equal(
    await peer.resumePrefetch,
    null,
    "an in-flight group was offered",
  );
  void peer.session.start();
  await flush();
  await run(t, 1_000, watches.values());
  assert.deepEqual(ladderCalls(since(w, mark)), [], "joined under the delete");
  releaseLeave();

  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  assert.equal(since(w, mark).includes("call:releaseKeptGroup"), false);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

// ---- (i″) R2-M1 and (q) W2-M3: the native downgrade grant ---------------------------------

test("(i″) every default keep clears the native downgrade grant before it keeps", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-i8";
  const { fleet, watches, peer, w } = await settledPair(t, channel);
  await peer.bridge.callConfirmDowngrade(GROUP, [], {});
  assert.equal(peer.native.downgradeConfirmed(channel), true);

  // With a grant, and again (after a resume) with none: each keep clears.
  for (const round of ["granted", "resumed"]) {
    const mark = w.trace.length;
    peer.hangUp();
    await flush();
    const trace = since(w, mark);
    assert.ok(
      at(trace, "call:callClearDowngrade") < at(trace, "call:keepLocalGroup"),
      `${round}: kept before the clear`,
    );
    assert.equal(peer.native.downgradeConfirmed(channel), false, round);
    assert.ok(peer.localGroups.has(GROUP), `${round}: not kept`);
    if (round === "granted") {
      peer.connect({ prefetchFromBridge: true });
      void peer.session.start();
      await flush();
      await run(t, 2_000, watches.values());
      assertResumed(fleet, peer);
    }
  }
  assertNoPlaintext(watches.values());
});

test("(q) Ctrl+R resume after a confirmed downgrade: the grant the dead page left is cleared before the enable, and an announce is refused", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-q";
  const { fleet, watches, peer, w } = await settledPair(t, channel);
  await peer.bridge.callConfirmDowngrade(GROUP, [], {});
  const grantAtEnable: boolean[] = [];
  tap(peer.gateLog, (edge) => {
    if (edge === "+enable-window") {
      grantAtEnable.push(peer.native.downgradeConfirmed(channel));
    }
  });
  const mark = w.trace.length;

  await fleet.reload(PEER);
  // The page death could not clear it: native outlived the page.
  assert.equal(peer.native.downgradeConfirmed(channel), true);
  await run(t, 2_000, watches.values());

  assertResumed(fleet, peer);
  const trace = since(w, mark);
  assert.ok(
    at(trace, "call:callClearDowngrade") < at(trace, "gate:+enable-window"),
  );
  assert.deepEqual(grantAtEnable, [false], "enabled on a live grant");
  assert.equal(peer.native.downgradeConfirmed(channel), false);
  await assert.rejects(peer.bridge.callAnnounce(GROUP, PEER.user_id), {
    type: "mls_not_confirmed",
  });
  assertNoPlaintext(watches.values());
});

// ---- (j) The DS names another group ------------------------------------------------------

test("(j) the open-group GET names another group: the held group is deleted, then today's path runs byte-for-byte", async (t) => {
  const logs = captureConsole(t);
  const moved = oneSeat(t, "creator", "ch-resume-j", (world) =>
    handPrefetch(world, { openGroupId: "group-successor" }),
  );
  await startSession(t, moved.w);
  await run(t, 2_000, [moved.w]);
  // Today's path: a session with no prefetch at all.
  const today = newWorld(t, "creator", "ch-resume-j0");
  const plain = watch(today);
  await startSession(t, plain);
  await run(t, 2_000, [plain]);

  const trace = moved.w.trace;
  const create = at(trace, "call:callCreate");
  assert.deepEqual(
    trace.slice(0, create).filter((e) => e !== "call:mlsReplenish"),
    [
      "call:registerMlsSink",
      "abort",
      "call:releaseKeptGroup",
      "call:clearResumeRecord",
      "call:callLeaveCleanup",
      `wiped:${GROUP}`,
      "call:discardKeptForChannel",
    ],
  );
  const todayTrace = plain.trace;
  assert.deepEqual(
    trace.slice(create),
    todayTrace.slice(at(todayTrace, "call:callCreate")),
  );
  assert.equal(moved.world.session.callMode().kind, "e2ee");
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext([moved.w, plain]);
});

// ---- (k) A pending own commit ---------------------------------------------------------------

/** An own Add staged on GROUP for the next epoch, as `callAdmit` leaves it. */
function stageOwnCommit(world: World, epoch: number): void {
  world.native.stagedCommits.set(GROUP, {
    device_id: world.me.device_id,
    epoch,
    commit: `commit-add-${epoch}-${world.me.device_id}`,
    welcome: `welcome-${epoch}-${world.me.device_id}`,
    added: [THIRD],
    removed: [],
  });
}

test("(k) Ctrl+R with an own commit still pending natively: no resume — the held group is deleted, then today's ladder (audit B3)", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await pairUp(t, "ch-resume-k");
  stageOwnCommit(peer, fleet.ds.epoch + 1);
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;

  await fleet.reload(PEER);
  const prefetch = await peer.resumePrefetch;
  assert.equal(prefetch?.pendingCommit, fleet.ds.epoch + 1);
  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  assert.equal(
    lines(logs, "info", "[mls] startup establish: no resume").length,
    1,
  );
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

// ---- (l) Recency (D7) ---------------------------------------------------------------------

test("(l) Ctrl+R with a record older than 10 s: nothing is offered, the group the record names is deleted, then today's ladder", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await pairUp(t, "ch-resume-l1");
  peer.pageDeath();
  await run(t, LOCAL_GROUP_KEEP_MS + 1_000, watches.values());
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;
  const reads = fleet.ds.openGroupRequests.length;

  await fleet.reload(PEER);
  assert.equal(await peer.resumePrefetch, null);
  assert.equal(fleet.ds.openGroupRequests.length, reads, "a stale candidate");
  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

test("(l) a kept group whose channel record names another group is refused at the claim and deleted, then today's ladder", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-l2";
  const { fleet, watches, peer, w } = await pairUp(t, channel);
  peer.hangUp();
  writeResumeRecord(peer.sessionStorage, channel, {
    groupId: "group-other",
    epoch: 0,
    at: Date.now(),
  });
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;
  const warns = logs.warn.mock.calls.length;

  peer.connect({ prefetchFromBridge: true });
  assert.equal(await peer.resumePrefetch, null);
  assert.deepEqual(
    lines(logs, "warn", "[mls] resume prefetch abandoned", warns).map(
      (args) => (args[1] as { why: string }).why,
    ),
    ["claimed group has no recent record"],
  );
  void peer.session.start();
  await flush();
  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

// ---- (m) Only the startup establish resumes (audit M6) ------------------------------------

test("(m) a re-establish never resumes, even with the startup's prefetch still fresh: today's create ladder, no abort, release or discard", async (t) => {
  const logs = captureConsole(t);
  const { world, w, aborts } = oneSeat(t, "creator", "ch-resume-m", (wd) =>
    handPrefetch(wd),
  );
  await startSession(t, w);
  await run(t, 1_000, [w]);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    1,
  );
  const mark = w.trace.length;

  // A receiver-lag desync: `#rejoinFresh`, whose establish is not the
  // startup's, while the prefetch it was handed would still pass every
  // other rule (fetched under 10 s ago, same group, nothing missed).
  await world.receiverLag();
  await run(t, 2_000, [w]);
  const trace = since(w, mark);
  assert.ok(trace.includes(`wiped:${GROUP}`), "no rejoin ran");
  assert.ok(at(trace, `wiped:${GROUP}`) < at(trace, "call:callCreate"));
  for (const resumeStep of [
    "abort",
    "call:releaseKeptGroup",
    "call:discardKeptForChannel",
    "call:callClearDowngrade",
  ]) {
    assert.equal(trace.includes(resumeStep), false, resumeStep);
  }
  assert.equal(aborts(), 0);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    1,
  );
  assert.equal(world.session.callMode().kind, "e2ee");
  assertNoPlaintext([w]);
});

// ---- (o) R2-n1: resumed one epoch behind a publishing peer ----------------------------------

test(`(o) resumed at epoch N while a peer publishes at N+1: loud within the re-securing bound (${RESECURE_ESCALATE_MS} ms), the gate held`, async (t) => {
  captureConsole(t);
  const { world, w } = oneSeat(t, "creator", "ch-resume-o", (wd) => {
    wd.epoch = 3;
    return handPrefetch(wd, { localEpoch: 3, currentEpoch: 3 });
  });
  await startSession(t, w);
  assert.equal(world.session.callMode().kind, "e2ee");
  const firstError = Date.now();

  // The DS withheld the commit to 4 (or it is still in flight): every frame
  // PEER sends from now on is at index 4, which this device has no key for.
  let loudAt: number | null = null;
  while (Date.now() - firstError <= RESECURE_ESCALATE_MS + 250) {
    world.session.noteEncryptionError(world.missingKey(PEER_ID, 4));
    await run(t, 250, [w]);
    if (world.terminalLoud()) {
      loudAt = Date.now();
      break;
    }
  }
  assert.notEqual(loudAt, null, "never went loud");
  assert.ok(
    loudAt! - firstError <= RESECURE_ESCALATE_MS + 250,
    `loud after ${loudAt! - firstError} ms`,
  );
  assert.equal(world.session.callMode().kind, "negotiating");
  assert.equal(world.publishing(), false);
  assertNoPlaintext([w]);
});

// ---- (p) R-W2-4 / W2-m1: every startup join discards the kept group first -----------------

test("(p) same-page hang-up → rejoin whose decision is join (a pending commit): the kept group is deleted BEFORE the ladder and the fallback's Welcome is accepted", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await pairUp(t, "ch-resume-p1");
  peer.hangUp();
  stageOwnCommit(peer, fleet.ds.epoch + 1);
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;

  peer.connect({ prefetchFromBridge: true });
  const prefetch = await peer.resumePrefetch;
  assert.notEqual(prefetch?.claimToken ?? null, null);
  assert.notEqual(prefetch?.pendingCommit ?? null, null);
  peer.resumePrefetchSignal!.addEventListener("abort", () =>
    w.trace.push("abort"),
  );
  void peer.session.start();
  await flush();

  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  const trace = since(w, mark);
  assert.ok(at(trace, "abort") < at(trace, `wiped:${GROUP}`));
  assert.equal(peer.prefetchAborts, 1);
  assert.equal(peer.kept.size, 0);
  assert.deepEqual(peer.mailbox, [], "the Welcome was left unacked");
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

test("(p) a NULL prefetch with a kept group on disk (claimed elsewhere): the group is discarded BEFORE the ladder and the fallback's Welcome is accepted", async (t) => {
  captureConsole(t);
  const channel = "ch-resume-p2";
  const { fleet, watches, peer, w } = await pairUp(t, channel);
  peer.hangUp();
  // A claim nothing hands back: its entry is unclaimable, and recency never
  // offers a group an entry names.
  assert.notEqual(peer.bridge.claimKeptLocalGroup(channel), null);
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;

  peer.connect({ prefetchFromBridge: true });
  assert.equal(await peer.resumePrefetch, null);
  assert.ok(peer.localGroups.has(GROUP), "the kept group is not on disk");
  void peer.session.start();
  await flush();

  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  const trace = since(w, mark);
  assert.ok(
    at(trace, "call:discardKeptForChannel") < at(trace, `wiped:${GROUP}`),
  );
  assert.equal(trace.includes("call:releaseKeptGroup"), false);
  assert.equal(peer.prefetchAborts, 1);
  assert.equal(peer.kept.size, 0);
  assert.deepEqual(peer.mailbox, []);
  assertNoPlaintext(watches.values());
});

// ---- (r) W2R-M1: an abandoned prefetch, in a fleet --------------------------------------

test("(r) fleet: a held commits fetch — the bound fires, the prefetch is aborted, the fallback joins the SAME group id, and the held fetch released as a failure deletes nothing", async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-r";
  const { fleet, watches, peer, w } = await pairUp(t, channel);
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;
  const release = fleet.ds.holdFetchCommits();

  await fleet.reload(PEER);
  const signal = peer.resumePrefetchSignal!;
  await run(t, RESUME_PREFETCH_WAIT_MS - 250, watches.values());
  assert.equal(peer.prefetchAborts, 0);
  assert.deepEqual(ladderCalls(since(w, mark)), [], "joined before the bound");
  await run(t, 500, watches.values());
  assert.equal(
    lines(logs, "warn", "[mls] resume prefetch not back in time").length,
    1,
  );
  assert.equal(peer.prefetchAborts, 1);
  assert.equal(signal.aborted, true);

  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  const joined = since(w, mark).length;
  fleet.ds.failFetchCommitsOnce();
  release();
  await run(t, 5_000, watches.values());
  assert.equal(await peer.resumePrefetch, null);
  assert.equal(
    since(w, mark)
      .slice(joined)
      .some((e) => e.startsWith("wiped:")),
    false,
    "the released fetch deleted a group",
  );
  assert.ok(peer.localGroups.has(GROUP));
  assert.equal(readResumeRecord(peer.sessionStorage, channel)?.groupId, GROUP);
  assert.equal(peer.session.callMode().kind, "e2ee");
  assert.deepEqual(failsafeFirings(logs), [], "the fail-safe fired");
  assertNoPlaintext(watches.values());
});

test(`(r) RESUME_PREFETCH_WAIT_MS < NEGOTIATING_FAILSAFE_MS: a prefetch held until the bound never trips the negotiating fail-safe`, async (t) => {
  const logs = captureConsole(t);
  const never = new Promise<Prefetch | null>(() => {});
  const world = newWorld(t, "creator", "ch-resume-failsafe", undefined, {
    resumePrefetch: never,
    abortResumePrefetch: () => {},
  });
  const w = watch(world);
  const t0 = Date.now();
  let createdAt: number | null = null;
  tap(world.bridgeCalls, (name) => {
    if (name === "callCreate") createdAt ??= Date.now() - t0;
  });
  const states = new Set<string>();
  void world.session.start();
  await flush();
  for (let ms = 0; ms < NEGOTIATING_FAILSAFE_MS + 2_000; ms += 250) {
    await run(t, 250, [w]);
    states.add(world.session.state());
  }

  assert.ok(
    createdAt !== null && createdAt >= RESUME_PREFETCH_WAIT_MS,
    `created at ${createdAt}`,
  );
  assert.ok(createdAt! < NEGOTIATING_FAILSAFE_MS);
  assert.equal(states.has("resecuring"), false, [...states].join());
  assert.deepEqual(failsafeFirings(logs), [], "the fail-safe fired");
  assert.equal(lines(logs, "warn", "[mls] re-securing:").length, 0);
  assert.equal(world.session.callMode().kind, "e2ee");
  assertNoPlaintext([w]);
});

// ---- (s) A hung pending delete ----------------------------------------------------------

test(`(s) the join path's discard never settles (a hung delete): LOUD at KEPT_DISCARD_WAIT_MS (${KEPT_DISCARD_WAIT_MS} ms), and never the ladder`, async (t) => {
  const logs = captureConsole(t);
  const channel = "ch-resume-s";
  const { watches, peer, w } = await settledPair(t, channel);
  peer.hangUp();
  assert.notEqual(peer.bridge.claimKeptLocalGroup(channel), null);
  const release = peer.holdLeaveCleanup();
  const mark = w.trace.length;

  peer.connect({ prefetchFromBridge: true });
  assert.equal(await peer.resumePrefetch, null);
  void peer.session.start();
  await flush();
  await run(t, 1, watches.values());
  assert.ok(since(w, mark).includes("call:discardKeptForChannel"));
  await run(t, KEPT_DISCARD_WAIT_MS - 250, watches.values());
  assert.equal(peer.terminalLoud(), false, "loud before the bound");
  await run(t, 500, watches.values());
  assert.equal(peer.terminalLoud(), true, "not loud at the bound");
  assert.equal(peer.session.state(), "failed");
  assert.equal(
    lines(logs, "error", "[mls] join path: a local delete did not finish")
      .length,
    1,
  );

  // Even once the delete finishes, nothing takes the ladder.
  release();
  await run(t, 60_000, watches.values());
  assert.deepEqual(ladderCalls(since(w, mark)), []);
  assert.equal(peer.publishing(), false);
  assertNoPlaintext(watches.values());
});

// ---- (t) W2-m2: a candidate already being deleted -------------------------------------------

test("(t) the resume candidate's delete is already in flight when the session adopts: releaseKeptGroup answers false, no adoption — step 6, then today's ladder", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await pairUp(t, "ch-resume-t");
  peer.hangUp();
  peer.connect({ prefetchFromBridge: true });
  const prefetch = await peer.resumePrefetch;
  assert.notEqual(prefetch?.claimToken ?? null, null);
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;

  // A delete of the group starts after the prefetch settled: any route into
  // the registry's `cleanup` (a keep expiry, a superseded keep, a discard, a
  // bridge leave-clean) marks it in flight; the bridge's own leave-clean
  // stands for all of them here. The native delete hangs a while.
  const releaseLeave = peer.holdLeaveCleanup();
  void peer.bridge.callLeaveCleanup(GROUP);
  assert.ok(peer.kept.isInFlight(GROUP));
  void peer.session.start();
  await flush();
  await run(t, 1, watches.values());

  assert.equal(
    lines(logs, "warn", "[mls] resume candidate is being deleted").length,
    1,
  );
  const trace = since(w, mark);
  assert.equal(trace.includes("call:callClearDowngrade"), false, "adopted");
  assert.equal(peer.session.groupId(), null);
  await run(t, 1_000, watches.values());
  assert.deepEqual(ladderCalls(since(w, mark)), [], "joined under the delete");
  releaseLeave();

  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

// ---- (u)–(y) The final audit's fix pass: FA-B1, FA-M1, FA-m2, FA-m3 --------

/**
 * One macrotask. The real installer posts each key to the media worker and
 * awaits its `importKey`, which answers by message: a switch of the send key
 * is never a same-tick microtask.
 */
function macrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * The LOCAL send key a seat's media plane holds (`bindSendKey`): `epoch` is
 * the one frames go out under, `history` every switch in order, `remotes`
 * every remote-only install (the Add-grace path's first half). `failAt`
 * makes the next local switch at that epoch reject instead, as an import of
 * our own key failing after the call returned. `onSend` runs after a switch.
 */
interface SendKey {
  epoch: number | null;
  history: number[];
  remotes: number[];
  failAt: number | null;
  onSend: ((epoch: number) => void) | null;
}

/**
 * Rebind `world`'s session (booted, not started) to a media binding whose
 * installer records the send key (`SendKey`), and is the harness's
 * `fakeMedia` in every other respect: the same gate, gate log, mode labels
 * and chip journal, so `watch`, `publishing()` and `terminalLoud()` read
 * what they read on the harness's own binding.
 *
 * `state.tsx` reconciles on every participant and track event, and one can
 * land while a key import is in flight: each install reconciles an active
 * session between its two awaits, as such an event would.
 */
function bindSendKey(world: World): SendKey {
  const key: SendKey = {
    epoch: null,
    history: [],
    remotes: [],
    failAt: null,
    onSend: null,
  };
  const eventDuringImport = () => {
    if (world.session.state() === "active") void world.session.reconcileNow();
  };
  const importLocal = async (frameKeys: MlsFrameKeys): Promise<void> => {
    await macrotask();
    eventDuringImport();
    await macrotask();
    if (key.failAt === frameKeys.epoch) {
      key.failAt = null;
      throw new Error(
        `InvalidKey: local key import failed (${frameKeys.epoch})`,
      );
    }
    key.epoch = frameKeys.epoch;
    key.history.push(frameKeys.epoch);
    key.onSend?.(frameKeys.epoch);
  };
  const installer: KeyInstaller = {
    applyKeys: importLocal,
    applyLocalKey: importLocal,
    applyRemoteKeys: async (frameKeys) => {
      await macrotask();
      eventDuringImport();
      await macrotask();
      key.remotes.push(frameKeys.epoch);
    },
    resetForGroup: () => {},
  };
  world.session.bindMedia({
    installer,
    localIdentity: () => identityOf(world.me),
    sfuParticipants: () => [...world.sfu],
    participantTrackSids: (identity) => world.sids.get(identity) ?? [],
    sfuConnected: () => world.connected,
    localPublications: () => [...world.localPublications],
    republishLocalPublications: async () => {},
    pausePublishing: async (reason) => {
      world.gate.add(reason);
      world.gateLog.push(`+${reason}`);
    },
    resumePublishing: async (reason) => {
      world.gate.delete(reason);
      world.gateLog.push(`-${reason}`);
    },
    onEncryptionState: (state, error, meta) => {
      const call =
        meta === undefined ? { state, error } : { state, error, meta };
      world.states.push(call);
      world.events.push(`state:${state}`);
      world.journal.push({ kind: "state", ...call });
    },
    onMediaHold: (active) => {
      world.holds.push(active);
      world.events.push(`hold:${active}`);
      world.journal.push({ kind: "hold", active });
    },
    onCallModeChanged: (mode) => {
      world.modes.push(mode.kind);
    },
    setEncryptionEnabled: async () => {},
  });
  return key;
}

/**
 * A second invariant on one seat, sampled as `watch` samples no-plaintext:
 * on every publish-gate edge and on every step of `run` (it is a `Watch`,
 * so `run` and `untilActive` drive it). `fault` names what is wrong now, or
 * null. A closed session is skipped, as `watch` skips it.
 */
function guard(world: World, fault: () => string | null): Watch {
  const g: Watch = {
    world,
    trace: [],
    violations: [],
    samples: 0,
    check(where: string): void {
      g.samples++;
      if (world.session.state() === "closed") return;
      const what = fault();
      if (what !== null) g.violations.push(`at "${where}": ${what}`);
    },
  };
  tap(world.gateLog, (edge) => g.check(`gate ${edge}`));
  return g;
}

/** `g` looked, and never saw its fault. */
function assertNever(g: Watch, message: string): void {
  assert.ok(g.samples > 0, "the guard never looked");
  assert.deepEqual(g.violations, [], message);
}

/** Publishing while native is behind the DS's epoch (FA-M1). */
function behindTheDs(fleet: Fleet, world: World): Watch {
  return guard(world, () =>
    world.publishing() && world.localEpoch < fleet.ds.epoch
      ? `published at native epoch ${world.localEpoch}, the DS at ${fleet.ds.epoch}`
      : null,
  );
}

/** The `cause` of each `[mls] startup establish: no resume` line. */
function noResumeCauses(logs: Captured, from = 0): string[] {
  return noResumeLines(logs, from).map((detail) => String(detail.cause));
}

/** The detail of each `[mls] startup establish: no resume` line. */
function noResumeLines(logs: Captured, from = 0): Record<string, unknown>[] {
  return lines(logs, "info", "[mls] startup establish: no resume", from).map(
    (args) => args[1] as Record<string, unknown>,
  );
}

/**
 * The session states `world` is in at each of its bridge calls from now
 * until its ladder's first request. A resume that goes active reaches the
 * bridge before any fallback could (the recency touch, the reconcile and
 * the enrolment proof `#toActive` starts), so `active` here is a resume
 * that went active.
 */
function statesBeforeLadder(world: World): Set<string> {
  const states = new Set<string>();
  let ladder = false;
  tap(world.bridgeCalls, (name) => {
    if (LADDER.includes(`call:${name}`)) ladder = true;
    if (!ladder) states.add(world.session.state());
  });
  return states;
}

/**
 * FA-B1's catch-up, [Add, Remove THIRD, Add]. SELF, PEER and THIRD up;
 * THIRD drops off the SFU and SELF's leave-grace for it runs; PEER's page
 * dies inside it; DAVE joins (an Add), the grace removes THIRD (a Remove),
 * ERIN joins (an Add). Only the fetch delivers the three to PEER. PEER's new
 * page is booted with a prefetch on its bridge (read now, well inside the
 * record's grace), its media bound to `bindSendKey`, and not started.
 */
async function removeBetweenAdds(t: TestContext, channel: string) {
  const fleet = newFleet(t, [SELF, PEER, THIRD, DAVE, ERIN], channel);
  const watches = watchFleet(fleet);
  const peer = fleet.seat(PEER);
  for (const id of [SELF, PEER, THIRD]) {
    await joinSeat(t, fleet, fleet.seat(id), watches.values());
  }
  await run(t, 3_000, watches.values());
  const base = fleet.ds.epoch;
  const leftAt = Date.now();
  sfuLeave(fleet, THIRD);
  await run(t, 7_000, watches.values());
  peer.pageDeath();
  const diedAt = Date.now();
  await joinSeat(t, fleet, fleet.seat(DAVE), watches.values());
  assert.equal(fleet.ds.epoch, base + 1, "the Remove came before the Add");
  for (let w = 0; fleet.ds.epoch < base + 2 && w < 5_000; w += 250) {
    await run(t, 250, watches.values());
  }
  const removeEpoch = base + 2;
  assert.deepEqual(
    fleet.ds.log[removeEpoch - 1]?.removed.map(identityOf),
    [THIRD_ID],
    "no Remove of THIRD",
  );
  await joinSeat(t, fleet, fleet.seat(ERIN), watches.values());
  const current = fleet.ds.epoch;
  assert.equal(current, base + 3);
  fleet.ds.ack(
    PEER,
    peer.mailbox.map((e) => e.id),
  );
  assert.ok(Date.now() - leftAt > LOCAL_GROUP_KEEP_MS, "THIRD's grace ran");
  assert.ok(Date.now() - diedAt < LOCAL_GROUP_KEEP_MS - 3_000, "a slow reload");

  peer.boot({ prefetchFromBridge: true });
  const key = bindSendKey(peer);
  const prefetch = await peer.resumePrefetch;
  assert.deepEqual(
    prefetch?.commits.map((c) => c.epoch),
    [base + 1, removeEpoch, current],
    "the record went stale before the reload",
  );
  return {
    fleet,
    watches,
    peer,
    w: watches.get(PEER_ID)!,
    key,
    base,
    removeEpoch,
    current,
  };
}

/**
 * Native's keys-changed for `epoch` (the catch-up's first commit) lands
 * while the catch-up applies the next one, as a Tauri event can land before
 * the next invoke's reply: at the second `processEnvelope` from now the
 * push is delivered, and that apply is held until the pushed send key is
 * in, so the catch-up resumes on a seat holding `epoch`'s send key.
 */
function pushMidCatchUp(world: World, key: SendKey, epoch: number): void {
  let applies = 0;
  tap(world.bridgeCalls, (name) => {
    if (name !== "processEnvelope" || ++applies !== 2) return;
    const release = world.holdProcessEnvelope();
    key.onSend = (switched) => {
      if (switched !== epoch) return;
      key.onSend = null;
      setImmediate(release);
    };
    void world.session.onLocalKeysChanged(GROUP, epoch);
  });
}

/** The send key is older than the Remove: the removed member holds it. */
function staleSendKey(world: World, key: SendKey, removeEpoch: number): Watch {
  return guard(world, () =>
    world.publishing() && (key.epoch === null || key.epoch < removeEpoch)
      ? `published on the send key of epoch ${key.epoch}`
      : null,
  );
}

test("(u) FA-B1: a keys-changed push for an intermediate epoch lands mid-catch-up over [Add, Remove THIRD, Add] — the final key is installed before the seat goes active, and the gate never opens on a send key THIRD holds", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w, key, base, removeEpoch, current } =
    await removeBetweenAdds(t, "ch-resume-u1");
  const stale = staleSendKey(peer, key, removeEpoch);
  pushMidCatchUp(peer, key, base + 1);
  const mark = w.trace.length;

  void peer.session.start();
  await flush();
  await run(t, 5_000, [...watches.values(), stale]);

  // The interleave happened: the pushed send key went in mid-catch-up.
  assert.equal(key.history[0], base + 1, "the push never installed");
  assertNever(stale, "the gate opened on a send key the removed THIRD holds");
  assertResumed(fleet, peer);
  assert.equal(key.epoch, current, "not on the final send key");
  assert.ok(
    at(since(w, mark), `keys:${current}`) <
      at(since(w, mark), "gate:-negotiating"),
  );
  assert.deepEqual(ladderCalls(since(w, mark)), []);
  assert.deepEqual(noResumeCauses(logs), []);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    1,
  );
  assertNoPlaintext(watches.values());
});

test("(u) FA-B1, LDA-M1: our install's local half fails while native's keys-changed for the same epoch installs the remotes on the Add-grace path — counter moved, fence held, but OUR send key is the old one: no resume, and the gate never opens on it", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w, key, base, removeEpoch, current } =
    await removeBetweenAdds(t, "ch-resume-u2");
  const stale = staleSendKey(peer, key, removeEpoch);
  pushMidCatchUp(peer, key, base + 1);
  // Native's keys-changed for the last commit (an Add) lands before the
  // reply to the catch-up's final native check: classified by the Add memo
  // still recorded, it installs the remote keys and defers our send key.
  let applies = 0;
  let pushed = false;
  tap(peer.bridgeCalls, (name) => {
    if (name === "processEnvelope") applies++;
    if (name !== "callState" || applies < 3 || pushed) return;
    pushed = true;
    void peer.session.onLocalKeysChanged(GROUP, current);
  });
  key.failAt = current;
  const early = statesBeforeLadder(peer);
  const mark = w.trace.length;

  void peer.session.start();
  await flush();
  await run(t, 30_000, [...watches.values(), stale]);

  // The race ran as scripted: the push's remote-only install, our failed
  // local switch, and the intermediate send key still in place.
  assert.ok(pushed, "the final check never ran");
  assert.equal(key.failAt, null, "our install never ran");
  assert.ok(key.remotes.includes(current), "no Add-grace install ran");
  assert.equal(key.history[0], base + 1);
  assertNever(stale, "the gate opened on a send key the removed THIRD holds");
  assert.equal(early.has("active"), false, "active on the resume path");
  assert.deepEqual(noResumeCauses(logs), ["install_check_failed"]);
  const [detail] = noResumeLines(logs);
  assert.equal(detail.installEpoch, current, "the fence moved");
  assert.equal(detail.ownSendKeyEpoch, base + 1);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  const trace = since(w, mark);
  assert.ok(at(trace, `wiped:${GROUP}`) < at(trace, "call:callCreate"));
  assert.ok(fleet.ds.epoch > current, "the fallback never rejoined");
  assertNoPlaintext(watches.values());
});

// ---- (v) The resume's own install fails ----------------------------------

for (const [channel, label, failure] of [
  [
    "ch-resume-v1",
    "an import error",
    () => new Error("InvalidKey: local key import failed"),
  ],
  [
    "ch-resume-v2",
    "no local frame key",
    () => new MissingLocalFrameKeyError(GROUP, 0),
  ],
] as const) {
  test(`(v) the resume's install of its own key fails (${label}): install_check_failed, never active on the resume path, the held group deleted before today's ladder`, async (t) => {
    const logs = captureConsole(t);
    const { fleet, watches, peer, w } = await pairUp(t, channel);
    const mark = w.trace.length;
    const from = fleet.ds.submits.length;
    const early = statesBeforeLadder(peer);

    peer.failLocalKeyOnce(failure());
    await fleet.reload(PEER);
    await run(t, 1, watches.values());
    assert.equal(peer.localKeyFailure, null, "the install never ran");
    assert.equal(early.has("active"), false, "active on the resume path");
    assert.deepEqual(noResumeCauses(logs), ["install_check_failed"]);

    await assertCleanJoin(t, fleet, w, mark, from, watches.values());
    assert.equal(
      lines(logs, "info", "[mls] resumed the held call group").length,
      0,
    );
    // Whatever the failed install latched went with the fallback's reset:
    // the rejoined seat is not left under a red of the abandoned group's.
    assert.equal(peer.terminalLoud(), false, "a stale red outlived the join");
    assertNoPlaintext(watches.values());
  });
}

// ---- (w) FA-M1: a commit between the prefetch's GET and the adoption ------

/**
 * FA-M1's window. SELF, PEER and THIRD up. With `drop`, THIRD drops off the
 * SFU and SELF's leave-grace for it runs. PEER's page dies inside it; DAVE
 * joins (an Add PEER misses, delivered only by the fetch). PEER's new page
 * starts its prefetch (the spec holds it, as a slow room connect would),
 * which reads the DS now: one commit missing. Started, the session waits on
 * it. With `drop`, SELF's Remove of THIRD lands meanwhile and reaches PEER
 * as ANOTHER group's envelope before the adoption, a gap native applies
 * nothing of; without, as long passes with nothing landing. The prefetch
 * is then handed over (`handOver`).
 */
async function behindWindow(t: TestContext, channel: string, drop: boolean) {
  const logs = captureConsole(t);
  const fleet = newFleet(t, [SELF, PEER, THIRD, DAVE], channel);
  const watches = watchFleet(fleet);
  const peer = fleet.seat(PEER);
  for (const id of [SELF, PEER, THIRD]) {
    await joinSeat(t, fleet, fleet.seat(id), watches.values());
  }
  await run(t, 3_000, watches.values());
  const base = fleet.ds.epoch;
  if (drop) sfuLeave(fleet, THIRD);
  await run(t, 7_500, watches.values());
  peer.pageDeath();
  await joinSeat(t, fleet, fleet.seat(DAVE), watches.values());
  assert.equal(fleet.ds.epoch, base + 1, "the Remove came before the Add");
  fleet.ds.ack(
    PEER,
    peer.mailbox.map((e) => e.id),
  );

  const dep = deferred<Prefetch | null>();
  const controller = new AbortController();
  peer.boot({
    resumePrefetch: dep.promise,
    abortResumePrefetch: () => controller.abort(),
  });
  const prefetch = await peer.bridge.prefetchResume(channel, controller.signal);
  assert.equal(prefetch?.localEpoch, base, "the record went stale");
  assert.equal(prefetch?.currentEpoch, base + 1);
  const w = watches.get(PEER_ID)!;
  const mark = w.trace.length;
  const behind = behindTheDs(fleet, peer);
  void peer.session.start();
  await flush();
  for (let waited = 0; waited < 2_000; waited += 250) {
    if (drop && fleet.ds.epoch === base + 2) break;
    await run(t, 250, [...watches.values(), behind]);
  }
  assert.equal(fleet.ds.epoch, drop ? base + 2 : base + 1);
  assert.equal(peer.session.groupId(), null, "adopted before the hand-over");
  assert.equal(peer.localEpoch, base, "native applied the dropped commit");
  const tailFetches = () =>
    since(w, mark).filter((e) => e === "call:mlsFetchCommits").length;
  return {
    logs,
    fleet,
    watches,
    peer,
    w,
    mark,
    base,
    behind,
    tailFetches,
    handOver: () => dep.resolve(prefetch),
  };
}

test("(w) FA-M1: a commit dropped as another group's between the GET and the adoption — ONE tail fetch catches the seat up, and it never publishes behind the DS", async (t) => {
  const {
    logs,
    fleet,
    watches,
    peer,
    w,
    mark,
    base,
    behind,
    tailFetches,
    handOver,
  } = await behindWindow(t, "ch-resume-w1", true);
  handOver();
  await run(t, 10_000, [...watches.values(), behind]);

  assertNever(behind, "published behind the DS");
  assertResumed(fleet, peer);
  assert.equal(peer.localEpoch, base + 2);
  assert.equal(tailFetches(), 1, "not exactly one tail fetch");
  const [tail, ...more] = lines(logs, "info", "[mls] resume tail applied");
  assert.deepEqual(more, []);
  assert.deepEqual(tail?.[1], {
    groupId: GROUP,
    from: base + 1,
    epoch: base + 2,
  });
  assert.deepEqual(ladderCalls(since(w, mark)), []);
  assert.deepEqual(noResumeCauses(logs), []);
  assertNoPlaintext(watches.values());
});

test("(w) FA-M1: nothing dropped in the window — no tail fetch, and the resume is unchanged", async (t) => {
  const {
    logs,
    fleet,
    watches,
    peer,
    w,
    mark,
    base,
    behind,
    tailFetches,
    handOver,
  } = await behindWindow(t, "ch-resume-w2", false);
  handOver();
  await run(t, 10_000, [...watches.values(), behind]);

  assertResumed(fleet, peer);
  assert.equal(peer.localEpoch, base + 1);
  assert.equal(tailFetches(), 0, "a tail fetch with nothing dropped");
  assert.equal(lines(logs, "info", "[mls] resume tail applied").length, 0);
  assert.deepEqual(ladderCalls(since(w, mark)), []);
  assert.deepEqual(noResumeCauses(logs), []);
  assertNever(behind, "published behind the DS");
  assertNoPlaintext(watches.values());
});

for (const [label, reason, answer] of [
  ["non-ok", "feature_disabled", () => ({ kind: "feature_disabled" as const })],
  [
    "short",
    "short",
    (current: number) => ({
      kind: "ok" as const,
      body: { commits: [], current_epoch: current },
    }),
  ],
] as const) {
  test(`(w) FA-M1: the tail fetch fails (${label}) — tail_failed, never active behind, the held group deleted before today's ladder`, async (t) => {
    const {
      logs,
      fleet,
      watches,
      peer,
      w,
      mark,
      base,
      behind,
      tailFetches,
      handOver,
    } = await behindWindow(t, `ch-resume-w3-${reason}`, true);
    peer.fetchCommitsAnswer = {
      groupId: GROUP,
      fromEpoch: base + 2,
      result: answer(base + 2),
    };
    const early = statesBeforeLadder(peer);
    handOver();
    await run(t, 1_000, [...watches.values(), behind]);

    assert.equal(peer.fetchCommitsAnswer, null, "the tail never asked");
    assert.equal(tailFetches(), 1);
    assertNever(behind, "published behind the DS");
    assert.equal(early.has("active"), false, "active on the resume path");
    assert.deepEqual(noResumeCauses(logs), ["tail_failed"]);
    assert.equal(noResumeLines(logs)[0].reason, reason);
    const trace = since(w, mark);
    assert.ok(at(trace, `wiped:${GROUP}`) < at(trace, "call:callCreate"));
    await untilActive(t, peer, 40_000, [...watches.values(), behind]);
    assert.equal(peer.localEpoch, fleet.ds.epoch);
    assert.equal(
      lines(logs, "info", "[mls] resumed the held call group").length,
      0,
    );
    assertNever(behind, "published behind the DS");
    assertNoPlaintext(watches.values());
  });
}

/** The detail of each `[mls] keys-changed dropped: the deleted group's` line. */
function staleKeysDropped(logs: Captured, from = 0): unknown[] {
  return lines(
    logs,
    "info",
    "[mls] keys-changed dropped: the deleted group's",
    from,
  ).map((args) => args[1]);
}

/**
 * A fallback that re-entered the held group's id left no trace of the old
 * incarnation: no frame-key read of the deleted row, no re-securing or loud
 * state, no red, and the seat publishes in `e2ee` on the DS's epoch.
 */
function assertCleanReentry(logs: Captured, fleet: Fleet, world: World): void {
  assert.deepEqual(
    lines(logs, "error", "[mls] rotation key path failed"),
    [],
    "a keys-changed of the deleted incarnation reached the key path",
  );
  assert.deepEqual(
    world.states.map((s) => s.state),
    [],
    "re-securing or loud",
  );
  assert.equal(world.terminalLoud(), false, "a red after the re-entry");
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.groupId(), GROUP);
  assert.equal(world.session.callMode().kind, "e2ee");
  assert.equal(world.publishing(), true, "the gate is still held");
  assert.equal(world.localEpoch, fleet.ds.epoch);
}

test("(w) F1: after a tail-failure fallback into the SAME group id, native's keys-changed for the commit the catch-up applied lands after the delete and is dropped by the stale-keys fence — the seat reaches e2ee and never goes loud", async (t) => {
  // FAF-T characterized this loud: the harness's DS answers the tail at once,
  // so the fallback's delete and the ladder's re-point to GROUP (the same DS
  // group id) ran before native's keys-changed for the catch-up's commit (a
  // macrotask) was delivered; the group-id and epoch checks both passed
  // (`#installEpoch` reset), and the frame-key read found the row deleted:
  // re-securing, then loud for good. FAF-S2's `#staleKeysFence` (set in
  // `#joinWithoutResume` at the highest epoch this page applied for the
  // candidate) drops such a push; DS epochs of one group id only rise, so
  // the Welcome back lands above the floor and is installed.
  const { logs, fleet, watches, peer, base, behind, handOver } =
    await behindWindow(t, "ch-resume-f1", true);
  peer.fetchCommitsAnswer = {
    groupId: GROUP,
    fromEpoch: base + 2,
    result: { kind: "feature_disabled" },
  };
  handOver();
  await run(t, 60_000, [...watches.values(), behind]);

  assert.deepEqual(noResumeCauses(logs), ["tail_failed"]);
  assertCleanReentry(logs, fleet, peer);
  assert.deepEqual(staleKeysDropped(logs), [
    { groupId: GROUP, epoch: base + 1, floor: base + 1 },
  ]);
  assert.ok(fleet.ds.members.map(identityOf).includes(PEER_ID));
  assertNever(behind, "published behind the DS");
  assertNoPlaintext(watches.values());
});

test("(w) F2: the PRE-EXISTING path — a catch-up that stops after applying a commit falls back into the SAME group id; the applied commit's keys-changed is dropped, and the seat reaches e2ee without ever going loud", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await threeMissed(t, "ch-resume-f2");
  fleet.ds.ack(
    PEER,
    peer.mailbox.map((e) => e.id),
  );
  // Native refuses the catch-up's second commit, a quiet terminal drop: the
  // catch-up stops with the first (epoch 2) applied, and native has fired
  // its keys-changed for it.
  peer.rejections.set(`mls-synth:${GROUP}:3`, groupNotFound(GROUP));
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;

  await fleet.reload(PEER);
  const prefetch = await peer.resumePrefetch;
  assert.deepEqual(
    prefetch?.commits.map((c) => c.epoch),
    [2, 3, 4],
  );
  await assertCleanJoin(t, fleet, w, mark, from, watches.values(), FIVE);

  assert.deepEqual(noResumeCauses(logs), ["catch_up_stopped"]);
  assert.equal(noResumeLines(logs)[0].epoch, 3);
  assertCleanReentry(logs, fleet, peer);
  assert.deepEqual(staleKeysDropped(logs), [
    { groupId: GROUP, epoch: 2, floor: 2 },
  ]);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

test("(w) F3: the fence never over-drops — the floor itself is dropped and the next epoch (the Welcome back) installed; a fallback that applied nothing fences nothing", async (t) => {
  const logs = captureConsole(t);
  // The catch-up applies epoch 1 and stops at 2: the floor is 1.
  const stopped = oneSeat(t, "joiner", "ch-resume-f3a", (world) => {
    applyFetched(world, [1]);
    world.rejections.set(`mls-synth:${GROUP}:2`, groupNotFound(GROUP));
    return handPrefetch(world, {
      currentEpoch: 2,
      commits: [fetched(1), fetched(2)],
    });
  });
  await startSession(t, stopped.w);
  assert.deepEqual(noResumeCauses(logs), ["catch_up_stopped"]);
  await untilIntent(t, stopped.w);
  assert.equal(stopped.world.session.groupId(), GROUP, "not the same id");
  // The old incarnation's push at the floor, after the re-entry: dropped.
  await stopped.world.session.onLocalKeysChanged(GROUP, 1);
  assert.deepEqual(staleKeysDropped(logs), [
    { groupId: GROUP, epoch: 1, floor: 1 },
  ]);
  // The new incarnation's first push, one above the floor: installed.
  const mark = stopped.w.trace.length;
  await welcomeBack(t, stopped.w, 2);
  assert.equal(staleKeysDropped(logs).length, 1, "the Welcome's key dropped");
  assert.ok(since(stopped.w, mark).includes("keys:2"), "never installed");
  assert.equal(stopped.world.session.callMode().kind, "e2ee");
  assert.equal(stopped.world.publishing(), true);

  // Nothing applied (an own commit pending): no fence, whatever lands.
  const from = logs.info.mock.calls.length;
  const pending = oneSeat(t, "creator", "ch-resume-f3b", (world) =>
    handPrefetch(world, { pendingCommit: 1 }),
  );
  await startSession(t, pending.w);
  await run(t, 2_000, [pending.w]);
  assert.deepEqual(noResumeCauses(logs, from), ["own_commit_pending"]);
  await pending.world.session.onLocalKeysChanged(GROUP, 0);
  await run(t, 1_000, [pending.w]);
  assert.deepEqual(staleKeysDropped(logs, from), []);
  assert.equal(pending.world.session.callMode().kind, "e2ee");
  assert.equal(pending.world.publishing(), true);
  assertNoPlaintext([stopped.w, pending.w]);
});

// ---- (x) FA-m2: the W1-m1 veto ---------------------------------------------

test("(x) W1-m1: an envelope of the held group destroyed by a loud drop before the adoption vetoes the resume — loud_foreign_drop, then today's ladder", async (t) => {
  const logs = captureConsole(t);
  const { fleet, watches, peer, w } = await pairUp(t, "ch-resume-x");
  const mark = w.trace.length;
  const from = fleet.ds.submits.length;
  const early = statesBeforeLadder(peer);

  // The new page's WS delivers an envelope of GROUP into the pre-sink hold,
  // and native refuses it as structurally malformed: a terminal, LOUD drop
  // that consumes it. Nothing is missed, so the resume would pass without
  // the veto.
  peer.pageDeath();
  peer.boot({ prefetchFromBridge: true });
  const id = "env-destroyed";
  peer.rejections.set(
    id,
    Object.assign(new Error("mls: malformed"), {
      type: "mls",
      code: "malformed",
    }),
  );
  peer.receive({
    kind: "envelope",
    envelope: {
      id,
      content_type: "mls_commit",
      group_id: GROUP,
      epoch: fleet.ds.epoch,
      ciphertext: "",
    },
    recipientDeviceId: PEER.device_id,
  });
  void peer.session.start();
  await flush();
  await run(t, 1, watches.values());

  assert.equal(
    lines(logs, "error", "[mls] loud drop for another group").length,
    1,
    "the envelope was not destroyed before the adoption",
  );
  assert.equal(early.has("active"), false, "active on the resume path");
  assert.equal(
    lines(logs, "warn", "[mls] resume vetoed: a loud drop destroyed").length,
    1,
  );
  assert.deepEqual(noResumeCauses(logs), ["loud_foreign_drop"]);
  await assertCleanJoin(t, fleet, w, mark, from, watches.values());
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group").length,
    0,
  );
  assertNoPlaintext(watches.values());
});

// ---- (y) FA-m3: the fallback-cause line ------------------------------------

test("(y) FA-m3: every startup establish that does not resume logs ONE cause line, naming the rule, with numbers and no key material; a resume logs none", async (t) => {
  const logs = captureConsole(t);
  const cases: [string, (world: World) => Prefetch | null, string][] = [
    ["ch-resume-y0", () => null, "prefetch_none"],
    [
      "ch-resume-y1",
      (world) => handPrefetch(world, { openGroupId: "group-successor" }),
      "open_group_mismatch",
    ],
    [
      "ch-resume-y2",
      (world) => handPrefetch(world, { pendingCommit: 1 }),
      "own_commit_pending",
    ],
    [
      "ch-resume-y3",
      (world) =>
        handPrefetch(world, {
          currentEpoch: RESUME_MAX_LAG,
          commits: range(1, RESUME_MAX_LAG).map((e) => fetched(e)),
        }),
      "lag_out_of_range",
    ],
  ];
  const watched: Watch[] = [];
  for (const [channel, prefetch, cause] of cases) {
    const from = logs.info.mock.calls.length;
    const { world, w } = oneSeat(t, "creator", channel, prefetch);
    watched.push(w);
    await startSession(t, w);
    await run(t, 2_000, [w]);
    const found = noResumeLines(logs, from);
    assert.deepEqual(
      found.map((d) => d.cause),
      [cause],
      channel,
    );
    const [detail] = found;
    for (const [field, value] of Object.entries(detail)) {
      assert.ok(
        value === null ||
          ["string", "number", "boolean"].includes(typeof value),
        `${channel}: ${field} is not a number or an id`,
      );
      assert.equal(
        String(value).includes("key-"),
        false,
        `${channel}: ${field} carries key material`,
      );
    }
    assert.equal(detail.candidate, cause === "prefetch_none" ? null : GROUP);
    if (cause === "lag_out_of_range") {
      assert.equal(detail.lag, RESUME_MAX_LAG);
      assert.equal(detail.localEpoch, 0);
      assert.equal(detail.dsEpoch, RESUME_MAX_LAG);
    }
    assert.equal(world.session.callMode().kind, "e2ee");
  }

  const from = logs.info.mock.calls.length;
  const resumed = oneSeat(t, "creator", "ch-resume-y4", (world) =>
    handPrefetch(world),
  );
  watched.push(resumed.w);
  await startSession(t, resumed.w);
  await run(t, 2_000, [resumed.w]);
  assert.deepEqual(noResumeLines(logs, from), []);
  assert.equal(
    lines(logs, "info", "[mls] resumed the held call group", from).length,
    1,
  );
  assertNoPlaintext(watched);
});
