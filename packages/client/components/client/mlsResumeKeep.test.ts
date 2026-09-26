// Unit spec for the resume keep registry and the resume prefetch — run with
// Node's built-in runner:
//   node --test --conditions=browser components/client/mlsResumeKeep.test.ts
// Focus: the claim lifecycle is per KEEP ENTRY (R2-B1 and its re-check). A
// claim suspends the entry's timer without moving its deadline, a hand-back
// resumes it at the ORIGINAL deadline, `release` deletes the entry outright,
// and every cleanup marks its group in-flight and clears its recency records
// before the native delete is awaited, so neither a claim nor a recency
// candidate can adopt a group that is being deleted. `prefetchResume` never
// rejects, and a candidate it gives up on is cleaned before it returns `null`.
// Wave-2 audit: `release` tells the adopter when the group is being deleted
// and a recency candidate is never a group a live keep entry names (W2-m2);
// `discardChannel` removes every kept and record-only group of a channel so
// a startup "join" cannot trip over one (W2-m1).
// Fix pass 2: both discards also wait out every delete pending when called,
// including one nothing names any more (W2R-m1), and a keep of a group whose
// delete is pending is refused (W2R-n1).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { LOCAL_GROUP_KEEP_MS } from "../rtc/mlsRejoinPolicy.ts";
import {
  type PrefetchDeps,
  type ResumeStorage,
  KeptLocalGroups,
  RESUME_RECORD_PREFIX,
  clearAllResumeRecords,
  clearResumeRecord,
  clearResumeRecordsForGroup,
  prefetchResume,
  readResumeRecord,
  writeResumeRecord,
} from "./mlsResumeKeep.ts";

const CH = "chan-1";
const G = "group-g";
const H = "group-h";
const KEY = `mls-resume:${CH}`;

type Timer = { at: number; fn: () => void };

/** A manual clock that owns every timer the registry arms. */
class FakeClock {
  t = 1_000_000;
  #seq = 0;
  readonly #timers = new Map<number, Timer>();

  now = (): number => this.t;

  setTimer = (fn: () => void, ms: number): unknown => {
    const handle = ++this.#seq;
    this.#timers.set(handle, { at: this.t + ms, fn });
    return handle;
  };

  clearTimer = (handle: unknown): void => {
    this.#timers.delete(handle as number);
  };

  /** Due times of every armed timer, ascending. */
  armed(): number[] {
    return [...this.#timers.values()].map((x) => x.at).sort((a, b) => a - b);
  }

  /** Move time forward by `ms`, firing every timer that falls due, in order. */
  advance(ms: number): void {
    const until = this.t + ms;
    let next = this.#next(until);
    while (next) {
      this.#timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      next = this.#next(until);
    }
    this.t = until;
  }

  #next(until: number): [number, Timer] | undefined {
    let best: [number, Timer] | undefined;
    for (const entry of this.#timers) {
      if (entry[1].at <= until && (!best || entry[1].at < best[1].at)) {
        best = entry;
      }
    }
    return best;
  }
}

/** `sessionStorage` in memory; `key(i)` follows insertion order. */
class MemoryStorage implements ResumeStorage {
  readonly map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
  key(i: number): string | null {
    return [...this.map.keys()][i] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

const boom = (): never => {
  throw new Error("SecurityError: storage unavailable");
};

/** Every access throws, as `sessionStorage` does in a locked-down webview. */
const throwingStorage: ResumeStorage = {
  getItem: boom,
  setItem: boom,
  removeItem: boom,
  key: boom,
  get length(): number {
    return boom();
  },
};

/** Lets every pending microtask (and one macrotask turn) run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

/** A registry over a fake clock, an in-memory storage and a recorded delete. */
class Rig {
  readonly clock = new FakeClock();
  readonly storage = new MemoryStorage();
  /** Every native delete, in call order. */
  readonly deleted: string[] = [];
  /** Swap to delay or fail the native delete. */
  deleteImpl: (groupId: string) => Promise<void> = () => Promise.resolve();
  #tokens = 0;
  readonly kept = new KeptLocalGroups({
    now: this.clock.now,
    setTimer: this.clock.setTimer,
    clearTimer: this.clock.clearTimer,
    deleteLocal: (groupId) => {
      this.deleted.push(groupId);
      return this.deleteImpl(groupId);
    },
    storage: this.storage,
    newToken: () => `tok-${++this.#tokens}`,
  });

  /** A recency record for `channelId` naming `groupId`, `ageMs` old. */
  record(channelId: string, groupId: string, ageMs = 0): void {
    writeResumeRecord(this.storage, channelId, {
      groupId,
      epoch: 7,
      at: this.clock.t - ageMs,
    });
  }
}

/**
 * Leave an entry for G on `channelId` while G's delete is pending, and return
 * that delete. A keep of a group mid-delete is refused (W2R-n1), so the one
 * way left is a delete that starts INSIDE `keep(G)`, after its refusal check:
 * here the native delete of the unclaimed H it supersedes re-enters with
 * `cleanup(G)`. The checks that still guard such an entry (the claim's
 * in-flight check among them) are pinned on it, in the re-entry case.
 */
function keepGRacingItsDelete(
  r: Rig,
  gate: Promise<void>,
  channelId = CH,
): Promise<void> {
  const started: { deleting?: Promise<void> } = {};
  r.deleteImpl = (g) => {
    if (g === H && started.deleting === undefined) {
      started.deleting = r.kept.cleanup(G);
    }
    return g === G ? gate : Promise.resolve();
  };
  r.kept.keep(H, channelId, 5_000);
  r.kept.keep(G, channelId, 5_000);
  assert.ok(started.deleting, "G's delete started inside its keep");
  assert.equal(r.kept.isInFlight(G), true);
  assert.equal(r.kept.size, 1, "and the keep's entry stands");
  return started.deleting;
}

// ---------------------------------------------------------------------------
// Recency records

test("records: write → read round-trips under RESUME_RECORD_PREFIX + channelId; clear removes it", () => {
  const s = new MemoryStorage();
  assert.equal(RESUME_RECORD_PREFIX, "mls-resume:");
  assert.equal(readResumeRecord(s, CH), null, "absent → null");
  writeResumeRecord(s, CH, { groupId: G, epoch: 7, at: 1234 });
  assert.deepEqual(readResumeRecord(s, CH), { groupId: G, epoch: 7, at: 1234 });
  assert.deepEqual(JSON.parse(s.getItem(KEY) ?? "null"), {
    groupId: G,
    epoch: 7,
    at: 1234,
  });
  assert.equal(readResumeRecord(s, "chan-2"), null, "keyed per channel");
  writeResumeRecord(s, CH, { groupId: H, epoch: 9, at: 1300 });
  assert.deepEqual(readResumeRecord(s, CH), { groupId: H, epoch: 9, at: 1300 });
  assert.equal(s.length, 1, "one record per channel");
  clearResumeRecord(s, CH);
  assert.equal(readResumeRecord(s, CH), null);
  assert.equal(s.length, 0);
});

test("records: a malformed record reads as null", () => {
  const s = new MemoryStorage();
  for (const raw of [
    "not json",
    "",
    "null",
    "42",
    '"group-g"',
    "[]",
    "{}",
    '{"groupId":"group-g","epoch":7}',
    '{"groupId":7,"epoch":7,"at":1}',
    '{"groupId":"group-g","epoch":"7","at":1}',
    '{"groupId":"group-g","epoch":7,"at":"1"}',
  ]) {
    s.setItem(KEY, raw);
    assert.equal(readResumeRecord(s, CH), null, raw);
  }
});

test("records: null or throwing storage → read null, every write a silent no-op", () => {
  for (const s of [null, throwingStorage]) {
    assert.equal(readResumeRecord(s, CH), null);
    assert.doesNotThrow(() => {
      writeResumeRecord(s, CH, { groupId: G, epoch: 7, at: 1 });
      clearResumeRecord(s, CH);
      clearResumeRecordsForGroup(s, G);
      clearAllResumeRecords(s);
    });
  }
  // Writes that throw (quota) while reads work: the old record stands.
  const quota = new MemoryStorage();
  quota.setItem(KEY, JSON.stringify({ groupId: G, epoch: 7, at: 1 }));
  quota.setItem = boom;
  assert.doesNotThrow(() =>
    writeResumeRecord(quota, CH, { groupId: H, epoch: 8, at: 2 }),
  );
  assert.deepEqual(readResumeRecord(quota, CH), {
    groupId: G,
    epoch: 7,
    at: 1,
  });
});

test("records: clearResumeRecordsForGroup removes every record naming that group and nothing else", () => {
  const s = new MemoryStorage();
  // Adjacent matches catch a loop that removes while walking indexes.
  writeResumeRecord(s, "chan-1", { groupId: G, epoch: 1, at: 1 });
  writeResumeRecord(s, "chan-2", { groupId: G, epoch: 2, at: 2 });
  writeResumeRecord(s, "chan-3", { groupId: H, epoch: 3, at: 3 });
  writeResumeRecord(s, "chan-4", { groupId: G, epoch: 4, at: 4 });
  // Not a record (no prefix), even though its value names G.
  const foreign = JSON.stringify({ groupId: G, epoch: 5, at: 5 });
  s.setItem("other:chan-5", foreign);
  clearResumeRecordsForGroup(s, G);
  assert.equal(readResumeRecord(s, "chan-1"), null);
  assert.equal(readResumeRecord(s, "chan-2"), null);
  assert.equal(readResumeRecord(s, "chan-4"), null);
  assert.deepEqual(readResumeRecord(s, "chan-3"), {
    groupId: H,
    epoch: 3,
    at: 3,
  });
  assert.equal(s.getItem("other:chan-5"), foreign);
  assert.equal(s.length, 2);
});

test("records: clearAllResumeRecords removes every record and leaves other keys", () => {
  const s = new MemoryStorage();
  writeResumeRecord(s, "chan-1", { groupId: G, epoch: 1, at: 1 });
  writeResumeRecord(s, "chan-2", { groupId: H, epoch: 2, at: 2 });
  writeResumeRecord(s, "chan-3", { groupId: G, epoch: 3, at: 3 });
  s.setItem("other:chan-1", "keep me");
  s.setItem("mls-other", "keep me too");
  clearAllResumeRecords(s);
  assert.deepEqual([...s.map.keys()].sort(), ["mls-other", "other:chan-1"]);
});

// ---------------------------------------------------------------------------
// KeptLocalGroups: keep, expiry, claim lifecycle, cleanup

test("keep: expiry at exactly `ms` cleans the group once (native delete, recency record cleared, entry gone)", async () => {
  const r = new Rig();
  const t0 = r.clock.t;
  r.record(CH, G);
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.size, 1);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  r.clock.advance(4_999);
  await settle();
  assert.deepEqual(r.deleted, []);
  assert.notEqual(readResumeRecord(r.storage, CH), null);
  r.clock.advance(1);
  await settle();
  assert.deepEqual(r.deleted, [G]);
  assert.equal(readResumeRecord(r.storage, CH), null, "D7: expiry clears it");
  assert.equal(r.kept.size, 0);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.claim(CH), null);
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, [G], "one delete, never repeated");
});

test("keep: a second keep for the channel naming another group cleans the older, UNCLAIMED group now", async () => {
  const r = new Rig();
  const t0 = r.clock.t;
  r.record(CH, G);
  r.kept.keep(G, CH, 5_000);
  r.clock.advance(1_000);
  r.kept.keep(H, CH, 5_000);
  assert.equal(r.kept.isInFlight(G), true, "cleaned now");
  await settle();
  assert.deepEqual(r.deleted, [G]);
  assert.equal(readResumeRecord(r.storage, CH), null, "the record named G");
  assert.equal(r.kept.size, 1);
  assert.deepEqual(r.clock.armed(), [t0 + 6_000], "only H's timer is armed");
  assert.equal(r.kept.claim(CH)?.groupId, H);
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, [G], "G's old timer never fires");
});

test("keep: a second keep for the channel leaves an older CLAIMED group to its claim holder", async () => {
  // The holder hands back: G settles by its own original deadline.
  const r = new Rig();
  r.kept.keep(G, CH, 5_000);
  const claim = r.kept.claim(CH);
  assert.ok(claim);
  r.clock.advance(1_000);
  r.kept.keep(H, CH, 5_000);
  await settle();
  assert.deepEqual(r.deleted, [], "the claimed group is untouched");
  assert.equal(r.kept.isInFlight(G), false);
  r.kept.handBack(claim.token);
  r.clock.advance(4_000);
  await settle();
  assert.deepEqual(r.deleted, [G], "handed back: gone by its deadline");
  r.clock.advance(1_000);
  await settle();
  assert.deepEqual(r.deleted, [G, H], "H expires on its own deadline");

  // The holder adopts (release): G is never deleted, H stays claimable.
  const r2 = new Rig();
  r2.kept.keep(G, CH, 5_000);
  assert.ok(r2.kept.claim(CH));
  r2.kept.keep(H, CH, 5_000);
  r2.kept.release(G);
  assert.equal(r2.kept.claim(CH)?.groupId, H);
  r2.clock.advance(60_000);
  await settle();
  assert.deepEqual(r2.deleted, []);
});

test("keep: re-keeping the same group replaces its entry with a FRESH deadline, on any channel", async () => {
  const r = new Rig();
  const t0 = r.clock.t;
  r.kept.keep(G, CH, 5_000);
  r.clock.advance(3_000);
  r.kept.keep(G, CH, 5_000);
  await settle();
  assert.deepEqual(r.deleted, [], "a re-keep never cleans its own group");
  assert.equal(r.kept.size, 1);
  assert.deepEqual(r.clock.armed(), [t0 + 8_000]);
  const claim = r.kept.claim(CH);
  assert.equal(claim?.deadlineMs, t0 + 8_000);
  r.kept.handBack(claim!.token);
  r.clock.advance(2_000);
  await settle();
  assert.deepEqual(r.deleted, [], "the old deadline passes quietly");
  r.clock.advance(3_000);
  await settle();
  assert.deepEqual(r.deleted, [G]);

  // The same group kept under another channel moves there.
  const r2 = new Rig();
  r2.kept.keep(G, "chan-a", 5_000);
  r2.kept.keep(G, "chan-b", 5_000);
  assert.equal(r2.kept.size, 1);
  assert.equal(r2.clock.armed().length, 1);
  assert.equal(r2.kept.claim("chan-a"), null);
  assert.equal(r2.kept.claim("chan-b")?.groupId, G);
  await settle();
  assert.deepEqual(r2.deleted, []);
});

test("claim: suspends the timer, keeps the deadline, never refreshes recency", async () => {
  const r = new Rig();
  const t0 = r.clock.t;
  r.record(CH, G);
  const before = r.storage.getItem(KEY);
  r.kept.keep(G, CH, 5_000);
  r.clock.advance(1_000);
  const claim = r.kept.claim(CH);
  assert.deepEqual(claim, {
    token: "tok-1",
    groupId: G,
    deadlineMs: t0 + 5_000,
  });
  assert.deepEqual(r.clock.armed(), [], "timer suspended");
  assert.equal(r.kept.size, 1, "the entry stays");
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(
    r.deleted,
    [],
    "no cleanup at the old deadline while claimed",
  );
  assert.equal(r.storage.getItem(KEY), before, "recency untouched");
});

test("handBack: resumes the entry at its ORIGINAL deadline, not now + ms", async () => {
  const r = new Rig();
  const t0 = r.clock.t;
  r.kept.keep(G, CH, 5_000);
  r.clock.advance(2_000);
  const claim = r.kept.claim(CH);
  assert.ok(claim);
  r.clock.advance(1_000);
  r.kept.handBack(claim.token);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  // Claimable again, with a new token and the same deadline.
  const again = r.kept.claim(CH);
  assert.deepEqual(again, {
    token: "tok-2",
    groupId: G,
    deadlineMs: t0 + 5_000,
  });
  r.kept.handBack(again.token);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  r.clock.advance(1_999);
  await settle();
  assert.deepEqual(r.deleted, []);
  r.clock.advance(1);
  await settle();
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.size, 0);
});

test("handBack: at or past the deadline cleans at once", async () => {
  for (const late of [5_000, 6_000]) {
    const r = new Rig();
    r.record(CH, G);
    r.kept.keep(G, CH, 5_000);
    const claim = r.kept.claim(CH);
    assert.ok(claim);
    r.clock.advance(late);
    r.kept.handBack(claim.token);
    assert.equal(r.kept.isInFlight(G), true, `${late}: cleaning now`);
    assert.equal(r.kept.size, 0);
    assert.deepEqual(r.clock.armed(), []);
    assert.equal(readResumeRecord(r.storage, CH), null);
    await settle();
    assert.deepEqual(r.deleted, [G]);
  }
});

test("handBack: a stale or unknown token is a no-op", async () => {
  const r = new Rig();
  const t0 = r.clock.t;
  r.kept.keep(G, CH, 5_000);
  const first = r.kept.claim(CH);
  assert.ok(first);
  r.kept.handBack(first.token);
  const second = r.kept.claim(CH);
  assert.ok(second);
  r.kept.handBack(first.token);
  r.kept.handBack("no-such-token");
  assert.deepEqual(r.clock.armed(), [], "still suspended under the live claim");
  assert.equal(r.kept.claim(CH), null, "still claimed");
  r.clock.advance(4_000);
  r.kept.handBack(second.token);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  r.kept.handBack(second.token);
  assert.deepEqual(
    r.clock.armed(),
    [t0 + 5_000],
    "a second hand-back arms nothing",
  );
  r.clock.advance(1_000);
  await settle();
  assert.deepEqual(r.deleted, [G]);
});

test("release: deletes the entry — no cleanup ever — and a later keep of that group expires normally", async () => {
  const r = new Rig();
  r.record(CH, G);
  const record = r.storage.getItem(KEY);
  r.kept.keep(G, CH, 5_000);
  const claim = r.kept.claim(CH);
  assert.ok(claim);
  r.kept.release(G);
  assert.equal(r.kept.size, 0);
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(r.storage.getItem(KEY), record, "release leaves recency alone");
  r.kept.handBack(claim.token);
  assert.deepEqual(r.clock.armed(), [], "hand-back of a released entry: no-op");
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, []);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.claim(CH), null);

  // The next hang-up keeps G again: a fresh entry whose expiry cleans it.
  const t1 = r.clock.t;
  r.kept.keep(G, CH, 5_000);
  assert.deepEqual(r.clock.armed(), [t1 + 5_000]);
  r.clock.advance(5_000);
  await settle();
  assert.deepEqual(r.deleted, [G]);

  // Releasing an unclaimed entry clears its timer too.
  r.kept.keep(H, CH, 5_000);
  r.kept.release(H);
  assert.deepEqual(r.clock.armed(), []);
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, [G]);
});

test("release: true while nothing is deleting the group, false while its cleanup is in flight; the entry is deleted either way (W2-m2)", async (t) => {
  const r = new Rig();
  r.kept.keep(G, CH, 5_000);
  assert.ok(r.kept.claim(CH));
  assert.equal(r.kept.release(G), true, "claimed, nothing deleting it");
  assert.equal(r.kept.size, 0);
  assert.equal(r.kept.release(G), true, "no entry: still not in flight");

  // The adopter holds the claim when a cleanup of its group starts (a leave
  // cleanup, a discard): release must say the group is on its way out.
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  r.kept.keep(G, CH, 5_000);
  assert.ok(r.kept.claim(CH));
  const cleaning = r.kept.cleanup(G);
  assert.equal(r.kept.release(G), false, "in flight: never adopt it");
  assert.equal(r.kept.size, 0, "the claimed entry is gone");

  // A keep of G that lands while the delete runs is refused (W2R-n1): no
  // entry, size unchanged, and release still reports the delete. (An entry
  // that names G mid-delete anyway is the re-entry case below.)
  t.mock.method(console, "info", () => undefined);
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.size, 0, "refused: no entry");
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(r.kept.release(G), false);
  assert.equal(r.kept.claim(CH), null);

  gate.resolve();
  await cleaning;
  assert.equal(r.kept.release(G), true, "the delete settled");
  assert.equal(r.kept.claim(CH), null, "not claimable after the delete");
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, [G], "release itself never deletes");
});

test("claim: refused while the group is in flight", async (t) => {
  t.mock.method(console, "info", () => undefined);
  // G in flight by a cleanup started first, and by its keep expiring.
  for (const via of ["cleanup", "expiry"] as const) {
    const r = new Rig();
    const gate = deferred<void>();
    r.deleteImpl = () => gate.promise;
    let cleaning: Promise<void> = Promise.resolve();
    if (via === "cleanup") cleaning = r.kept.cleanup(G);
    else {
      r.kept.keep(G, CH, 5_000);
      r.clock.advance(5_000);
    }
    assert.equal(r.kept.isInFlight(G), true, via);
    // A keep lands while the native delete is still running: refused
    // (W2R-n1), so there is no entry to claim, before or after it settles.
    r.kept.keep(G, CH, 5_000);
    assert.equal(r.kept.size, 0, `${via}: refused, no entry`);
    assert.equal(r.kept.claim(CH), null, `${via}: in flight → no claim`);
    gate.resolve();
    await cleaning;
    await settle();
    assert.equal(r.kept.isInFlight(G), false, via);
    assert.equal(r.kept.claim(CH), null, `${via}: not claimable after`);
  }
});

test("an entry naming a group mid-delete (only by re-entry since W2R-n1): claim refuses it, release drops it and reports the delete, discardChannel drops it with no second delete", async () => {
  // Claim: the in-flight check is the only thing refusing this entry.
  const c = new Rig();
  const cGate = deferred<void>();
  const cCleaning = keepGRacingItsDelete(c, cGate.promise);
  assert.equal(c.kept.claim(CH), null, "in flight → no claim");
  assert.equal(c.kept.size, 1, "the refusal takes nothing");
  cGate.resolve();
  await cCleaning;

  // Release: the entry goes, timer and all, and the answer is `false`.
  const e = new Rig();
  const eGate = deferred<void>();
  const eCleaning = keepGRacingItsDelete(e, eGate.promise);
  assert.equal(e.kept.release(G), false);
  assert.equal(e.kept.size, 0, "entry deleted anyway");
  assert.deepEqual(e.clock.armed(), []);
  eGate.resolve();
  await eCleaning;
  e.clock.advance(60_000);
  await settle();
  assert.deepEqual(e.deleted, [H, G], "release itself never deletes");

  // discardChannel: the entry goes through `cleanup`, sharing its delete.
  const d = new Rig();
  const dGate = deferred<void>();
  const dCleaning = keepGRacingItsDelete(d, dGate.promise);
  let done = false;
  const discarding = d.kept.discardChannel(CH).then(() => (done = true));
  assert.equal(d.kept.size, 0, "entry dropped on the call");
  assert.deepEqual(d.clock.armed(), []);
  await settle();
  assert.equal(done, false, "waits for G to be off the disk");
  dGate.resolve();
  await Promise.all([dCleaning, discarding]);
  d.clock.advance(60_000);
  await settle();
  assert.deepEqual(d.deleted, [H, G], "one native delete of G");
});

test("keep: a keep of a group whose delete is pending is REFUSED — no entry, no timer, info logged — and the group is not claimable once the delete settles (W2R-n1)", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  const before = info.mock.callCount();
  r.kept.keep(G, CH, 5_000);
  assert.equal(info.mock.callCount(), before + 1, "info logged");
  assert.equal(r.kept.size, 0, "no entry");
  assert.deepEqual(r.clock.armed(), [], "no timer");
  assert.equal(r.kept.claim(CH), null, "nothing to claim mid-delete");
  gate.resolve();
  await cleaning;
  assert.equal(r.kept.isInFlight(G), false);
  // The delete removed G: nothing may hand it to a resume afterwards.
  assert.equal(r.kept.claim(CH), null, "not claimable after the delete");
  assert.equal(r.kept.size, 0);
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, [G], "the pending delete was the only one");
});

test("keep: a refused keep of a group mid-delete touches nothing else — the channel's entry is not superseded, other entries and records stand (W2R-n1)", async (t) => {
  t.mock.method(console, "info", () => undefined);
  const X = "group-x";
  const r = new Rig();
  const t0 = r.clock.t;
  r.kept.keep(H, CH, 5_000);
  r.kept.keep(X, "chan-2", 5_000);
  r.record(CH, H);
  r.record("chan-2", X);
  const records = [...r.storage.map.entries()];
  const gate = deferred<void>();
  r.deleteImpl = (g) => (g === G ? gate.promise : Promise.resolve());
  const cleaning = r.kept.cleanup(G);
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.size, 2, "size unchanged");
  assert.deepEqual(r.clock.armed(), [t0 + 5_000, t0 + 5_000]);
  assert.equal(r.kept.isInFlight(H), false, "H not superseded");
  assert.deepEqual([...r.storage.map.entries()], records);
  await settle();
  assert.deepEqual(r.deleted, [G]);
  gate.resolve();
  await cleaning;
  // The channel still offers H, never G.
  assert.equal(r.kept.claim(CH)?.groupId, H);
  assert.equal(r.kept.claim("chan-2")?.groupId, X);
});

test("keep: once the pending delete has settled (resolved or rejected), a keep of that group is a normal keep again (W2R-n1)", async (t) => {
  t.mock.method(console, "info", () => undefined);
  for (const outcome of ["resolved", "rejected"] as const) {
    const r = new Rig();
    const gate = deferred<void>();
    r.deleteImpl = () => gate.promise;
    const cleaning = r.kept.cleanup(G).catch(() => undefined);
    r.kept.keep(G, CH, 5_000);
    assert.equal(r.kept.size, 0, `${outcome}: refused mid-delete`);
    if (outcome === "resolved") gate.resolve();
    else gate.reject(new Error("native delete failed"));
    await cleaning;
    assert.equal(r.kept.isInFlight(G), false, outcome);
    r.deleteImpl = () => Promise.resolve();
    const t1 = r.clock.t;
    r.kept.keep(G, CH, 5_000);
    assert.equal(r.kept.size, 1, outcome);
    assert.deepEqual(r.clock.armed(), [t1 + 5_000], outcome);
    const claim = r.kept.claim(CH);
    assert.deepEqual(
      claim,
      { token: "tok-1", groupId: G, deadlineMs: t1 + 5_000 },
      outcome,
    );
    r.kept.handBack(claim!.token);
    r.clock.advance(5_000);
    await settle();
    assert.deepEqual(r.deleted, [G, G], `${outcome}: expires normally`);
  }
});

test("claim: refused at or past the deadline even if the timer has not fired", async () => {
  const early = new Rig();
  const t0 = early.clock.t;
  early.kept.keep(G, CH, 5_000);
  early.clock.t = t0 + 4_999;
  assert.deepEqual(early.kept.claim(CH), {
    token: "tok-1",
    groupId: G,
    deadlineMs: t0 + 5_000,
  });

  for (const late of [5_000, 7_000]) {
    const r = new Rig();
    const t1 = r.clock.t;
    r.kept.keep(G, CH, 5_000);
    // Time moved on, but the (throttled) timer has not run yet.
    r.clock.t = t1 + late;
    assert.equal(r.kept.claim(CH), null, `${late}`);
    assert.deepEqual(
      r.clock.armed(),
      [t1 + 5_000],
      "the refusal suspends nothing",
    );
    r.clock.advance(0);
    await settle();
    assert.deepEqual(r.deleted, [G]);
  }
});

test("claim: refused while already claimed, and for a channel with no entry", () => {
  const r = new Rig();
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.claim("chan-2"), null);
  const claim = r.kept.claim(CH);
  assert.ok(claim);
  assert.equal(r.kept.claim(CH), null);
  r.kept.handBack(claim.token);
  assert.equal(r.kept.claim(CH)?.token, "tok-2");
});

test("cleanup: in flight SYNCHRONOUSLY (entry, timer and every record naming the group gone), cleared when the delete settles", async () => {
  const r = new Rig();
  r.record(CH, G);
  r.record("chan-2", G);
  r.record("chan-3", H);
  r.kept.keep(G, CH, 5_000);
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  assert.equal(r.kept.isInFlight(G), true);
  assert.equal(r.kept.size, 0);
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(readResumeRecord(r.storage, CH), null);
  assert.equal(readResumeRecord(r.storage, "chan-2"), null);
  assert.equal(readResumeRecord(r.storage, "chan-3")?.groupId, H);
  await settle();
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.isInFlight(G), true, "still in flight while native runs");
  gate.resolve();
  await cleaning;
  assert.equal(r.kept.isInFlight(G), false);
});

test("cleanup: a rejected delete propagates and still clears in-flight (no entry needed)", async () => {
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  assert.equal(r.kept.isInFlight(G), true);
  gate.reject(new Error("native delete failed"));
  await assert.rejects(cleaning, /native delete failed/);
  assert.equal(r.kept.isInFlight(G), false);
  assert.deepEqual(r.deleted, [G]);
});

test("cleanup: an overlapping cleanup of the same group shares the pending delete (one deleteLocal, both settle with it); a later one deletes anew (F1-R1)", async () => {
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const first = r.kept.cleanup(G);
  const second = r.kept.cleanup(G);
  assert.deepEqual(r.deleted, [G], "one native delete");
  assert.equal(r.kept.isInFlight(G), true);
  const settled: string[] = [];
  void first.then(() => settled.push("first"));
  void second.then(() => settled.push("second"));
  await settle();
  assert.deepEqual(settled, [], "neither settles before the delete does");
  assert.equal(r.kept.isInFlight(G), true);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(settled.sort(), ["first", "second"]);
  assert.equal(r.kept.isInFlight(G), false);
  assert.deepEqual(r.deleted, [G], "still one");

  // Once it settled, a cleanup is a fresh native delete.
  r.deleteImpl = () => Promise.resolve();
  await r.kept.cleanup(G);
  assert.deepEqual(r.deleted, [G, G]);
  assert.equal(r.kept.isInFlight(G), false);
});

test("cleanup: overlapping cleanups of a rejecting delete both reject with THE same error; a later one deletes anew (F1-R1)", async () => {
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const failed = new Error("native delete failed");
  const caught = (p: Promise<void>) =>
    p.then(
      () => "resolved",
      (e: unknown) => e,
    );
  const first = caught(r.kept.cleanup(G));
  const second = caught(r.kept.cleanup(G));
  assert.deepEqual(r.deleted, [G], "one native delete");
  gate.reject(failed);
  assert.equal(await first, failed);
  assert.equal(await second, failed);
  assert.equal(r.kept.isInFlight(G), false);

  r.deleteImpl = () => Promise.resolve();
  await r.kept.cleanup(G);
  assert.deepEqual(r.deleted, [G, G], "a rejected delete is not reused");
});

test("cleanup: joining a pending delete still clears, synchronously, a record naming the group written since it started (F1-R1)", async () => {
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const first = r.kept.cleanup(G);
  // A record touched after the first cleanup cleared the old one.
  r.record(CH, G);
  r.record("chan-2", H);
  const second = r.kept.cleanup(G);
  assert.equal(readResumeRecord(r.storage, CH), null, "cleared on the call");
  assert.equal(readResumeRecord(r.storage, "chan-2")?.groupId, H);
  assert.equal(r.kept.recencyCandidate(CH), null, "before the delete settles");
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(r.deleted, [G], "one native delete");
  assert.equal(r.kept.isInFlight(G), false);
  // G is off the disk: nothing may offer it for a resume.
  assert.equal(r.kept.recencyCandidate(CH), null, "after the delete settled");
});

test("recencyCandidate: the channel's recent record, excluding stale and in-flight groups", async () => {
  const r = new Rig();
  assert.equal(r.kept.recencyCandidate(CH), null, "no record");
  r.record(CH, G, 0);
  assert.equal(r.kept.recencyCandidate(CH), G);
  r.record(CH, G, LOCAL_GROUP_KEEP_MS);
  assert.equal(r.kept.recencyCandidate(CH), G, "age exactly the keep window");
  r.record(CH, G, LOCAL_GROUP_KEEP_MS + 1);
  assert.equal(r.kept.recencyCandidate(CH), null, "stale");
  r.record(CH, G, -1);
  assert.equal(r.kept.recencyCandidate(CH), null, "from the future");
  r.storage.setItem(KEY, "garbage");
  assert.equal(r.kept.recencyCandidate(CH), null, "malformed");

  // A record naming a group whose delete is running is not a candidate.
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  r.record(CH, G, 0);
  assert.equal(r.kept.recencyCandidate(CH), null, "in flight");
  gate.resolve();
  await cleaning;
  assert.equal(r.kept.recencyCandidate(CH), G);
});

test("recencyCandidate: refuses a group ANY live keep entry names (unclaimed, claimed, displaced, other channel, past its deadline before the timer ran) and offers it once none does (W2-m2)", async () => {
  // Unclaimed, then claimed, then released.
  const r = new Rig();
  r.record(CH, G);
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.recencyCandidate(CH), null, "unclaimed entry");
  assert.ok(r.kept.claim(CH));
  assert.equal(r.kept.recencyCandidate(CH), null, "claimed entry");
  r.kept.release(G);
  assert.equal(r.kept.recencyCandidate(CH), G, "no entry names it any more");

  // A claimed entry displaced from its channel by a newer keep.
  const d = new Rig();
  d.kept.keep(G, CH, 5_000);
  assert.ok(d.kept.claim(CH));
  d.kept.keep(H, CH, 5_000);
  d.record(CH, G);
  assert.equal(d.kept.recencyCandidate(CH), null, "displaced claimed entry");
  d.kept.release(G);
  assert.equal(d.kept.recencyCandidate(CH), G);

  // An entry under another channel names the group just the same.
  const o = new Rig();
  o.kept.keep(G, "chan-2", 5_000);
  o.record(CH, G);
  assert.equal(o.kept.recencyCandidate(CH), null, "entry on another channel");
  o.kept.release(G);
  assert.equal(o.kept.recencyCandidate(CH), G);

  // Past its deadline with the (throttled) timer not yet run: that timer
  // is about to delete G under whoever adopted it.
  const p = new Rig();
  const t0 = p.clock.t;
  p.record(CH, G);
  p.kept.keep(G, CH, 5_000);
  p.clock.t = t0 + 5_000;
  assert.deepEqual(p.clock.armed(), [t0 + 5_000], "timer not run");
  assert.equal(p.kept.recencyCandidate(CH), null, "past deadline, not fired");
  p.clock.advance(0);
  await settle();
  assert.deepEqual(p.deleted, [G]);
  assert.equal(p.kept.recencyCandidate(CH), null, "expired: record gone");
});

test("discardAll: cleans every entry (claimed too, all started at once), clears every record, awaits them all", async () => {
  const r = new Rig();
  r.record(CH, G);
  r.record("chan-2", H);
  r.record("chan-3", "group-x");
  r.storage.setItem("other:key", "v");
  r.kept.keep(G, CH, 5_000);
  r.kept.keep(H, "chan-2", 5_000);
  const claim = r.kept.claim("chan-2");
  assert.ok(claim);
  const gate = deferred<void>();
  r.deleteImpl = (g) =>
    g === G ? Promise.reject(new Error("native")) : gate.promise;
  const discarding = r.kept.discardAll();
  assert.equal(r.kept.isInFlight(G), true);
  assert.equal(r.kept.isInFlight(H), true);
  let done = false;
  void discarding.then(
    () => (done = true),
    () => undefined,
  );
  await settle();
  assert.equal(done, false, "waits for every cleanup");
  gate.resolve();
  await discarding;
  assert.deepEqual([...r.deleted].sort(), [G, H]);
  assert.equal(r.kept.size, 0);
  assert.deepEqual(r.clock.armed(), []);
  assert.deepEqual([...r.storage.map.keys()], ["other:key"]);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.isInFlight(H), false);
  r.kept.handBack(claim.token);
  assert.deepEqual(r.clock.armed(), []);
});

test("discardChannel: cleans every entry for the channel (claimed, displaced, unclaimed) and leaves other channels alone (W2-m1)", async () => {
  const X = "group-x";
  const r = new Rig();
  const t0 = r.clock.t;
  r.kept.keep(G, CH, 5_000);
  const held = r.kept.claim(CH);
  assert.ok(held);
  // G stays tracked under its claim, displaced from CH by H.
  r.kept.keep(H, CH, 5_000);
  r.kept.keep(X, "chan-2", 5_000);
  r.record("chan-2", X);
  const record2 = r.storage.getItem("mls-resume:chan-2");
  const discarding = r.kept.discardChannel(CH);
  assert.equal(r.kept.isInFlight(G), true, "claimed, displaced entry");
  assert.equal(r.kept.isInFlight(H), true, "unclaimed entry");
  assert.equal(r.kept.isInFlight(X), false, "another channel's entry");
  assert.equal(r.kept.size, 1);
  await discarding;
  assert.deepEqual([...r.deleted].sort(), [G, H]);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000], "chan-2's timer only");
  assert.equal(r.storage.getItem("mls-resume:chan-2"), record2);
  r.kept.handBack(held.token);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000], "the old claim is stale");
  assert.equal(r.kept.claim("chan-2")?.groupId, X);

  // The channel's current entry, claimed by a prefetch that answered null.
  const c = new Rig();
  c.kept.keep(G, CH, 5_000);
  assert.ok(c.kept.claim(CH));
  await c.kept.discardChannel(CH);
  assert.deepEqual(c.deleted, [G]);
  assert.equal(c.kept.size, 0);
  assert.equal(c.kept.claim(CH), null);
});

test("discardChannel: cleans the group only the channel's record names, stale or not, and clears the record (W2-m1)", async () => {
  // A Ctrl+R: the entry died with the page, the group and record did not.
  const r = new Rig();
  r.record(CH, G);
  r.record("chan-2", H);
  const discarding = r.kept.discardChannel(CH);
  assert.equal(r.kept.isInFlight(G), true);
  assert.equal(readResumeRecord(r.storage, CH), null);
  await discarding;
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(readResumeRecord(r.storage, "chan-2")?.groupId, H);

  // Too old to resume from, but the group it names is still on disk.
  const s = new Rig();
  s.record(CH, G, LOCAL_GROUP_KEEP_MS + 1);
  await s.kept.discardChannel(CH);
  assert.deepEqual(s.deleted, [G]);
  assert.equal(s.storage.getItem(KEY), null);

  // A malformed record names nothing: nothing deleted, the key removed.
  const m = new Rig();
  m.storage.setItem(KEY, "garbage");
  await m.kept.discardChannel(CH);
  assert.deepEqual(m.deleted, []);
  assert.equal(m.storage.getItem(KEY), null);
});

test("discardChannel: never cleans a group twice (one its entry named, one already in flight) and still clears the record (W2-m1)", async () => {
  const r = new Rig();
  r.record(CH, G);
  r.kept.keep(G, CH, 5_000);
  await r.kept.discardChannel(CH);
  assert.deepEqual(r.deleted, [G], "through its entry, once");
  assert.equal(readResumeRecord(r.storage, CH), null);

  // Claimed and named by the record too.
  const c = new Rig();
  c.record(CH, G);
  c.kept.keep(G, CH, 5_000);
  assert.ok(c.kept.claim(CH));
  await c.kept.discardChannel(CH);
  assert.deepEqual(c.deleted, [G]);

  // The record names a group whose delete is already running.
  const f = new Rig();
  const gate = deferred<void>();
  f.deleteImpl = () => gate.promise;
  const cleaning = f.kept.cleanup(G);
  f.record(CH, G);
  const discarding = f.kept.discardChannel(CH);
  assert.equal(readResumeRecord(f.storage, CH), null, "record cleared");
  gate.resolve();
  await Promise.all([cleaning, discarding]);
  assert.deepEqual(f.deleted, [G], "not deleted a second time");
});

test("discardChannel: every cleanup starts synchronously, the promise waits for all of them, and it is idempotent (W2-m1)", async () => {
  const R = "group-r";
  const r = new Rig();
  r.kept.keep(G, CH, 5_000);
  assert.ok(r.kept.claim(CH));
  r.kept.keep(H, CH, 5_000);
  r.record(CH, R);
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const discarding = r.kept.discardChannel(CH);
  for (const g of [G, H, R]) {
    assert.equal(r.kept.isInFlight(g), true, g);
  }
  assert.equal(r.kept.size, 0);
  assert.equal(readResumeRecord(r.storage, CH), null);
  let done = false;
  void discarding.then(() => (done = true));
  // A second discard while the first is still deleting finds nothing.
  const again = r.kept.discardChannel(CH);
  await settle();
  assert.equal(done, false, "waits for every native delete");
  assert.deepEqual([...r.deleted].sort(), [G, H, R]);
  gate.resolve();
  await discarding;
  await again;
  for (const g of [G, H, R]) {
    assert.equal(r.kept.isInFlight(g), false, g);
  }
  await r.kept.discardChannel(CH);
  await r.kept.discardChannel("chan-none");
  assert.deepEqual([...r.deleted].sort(), [G, H, R], "nothing deleted twice");
});

test("discardChannel: a rejecting native delete is caught and warned; the promise resolves and in-flight clears (W2-m1)", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const r = new Rig();
  r.kept.keep(G, CH, 5_000);
  r.record(CH, H);
  r.deleteImpl = (g) =>
    g === G
      ? Promise.reject(new Error("native delete failed"))
      : Promise.resolve();
  await assert.doesNotReject(r.kept.discardChannel(CH));
  assert.deepEqual([...r.deleted].sort(), [G, H]);
  assert.ok(warn.mock.callCount() >= 1);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.isInFlight(H), false);
  assert.equal(r.kept.size, 0);
});

test("discardChannel: waits for the pending delete of a record's group already in flight, without deleting it again (F1-R1)", async () => {
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  // G's keep timer fired: its delete is running.
  r.kept.keep(G, CH, 5_000);
  r.clock.advance(5_000);
  assert.equal(r.kept.isInFlight(G), true);
  // A record naming G written after that cleanup cleared the old one.
  r.record(CH, G);
  let done = false;
  const discarding = r.kept.discardChannel(CH).then(() => (done = true));
  assert.equal(readResumeRecord(r.storage, CH), null, "record cleared");
  await settle();
  assert.equal(done, false, "the join path waits for G to be off the disk");
  gate.resolve();
  await discarding;
  assert.deepEqual(r.deleted, [G], "one native delete");
  assert.equal(r.kept.isInFlight(G), false);
});

test("discardChannel: waits for the pending delete of a group already in flight whose keep was refused, without deleting it again, and no entry survives (F1-R1, W2R-n1)", async (t) => {
  t.mock.method(console, "info", () => undefined);
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  // A keep of G lands while its delete runs: refused, no entry.
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.size, 0);
  let done = false;
  const discarding = r.kept.discardChannel(CH).then(() => (done = true));
  await settle();
  assert.equal(done, false, "the join path waits for G to be off the disk");
  gate.resolve();
  await Promise.all([cleaning, discarding]);
  assert.deepEqual(r.deleted, [G], "one native delete");
  assert.equal(r.kept.isInFlight(G), false);
  // No entry survives to delete G again under whatever the join adopts.
  assert.equal(r.kept.size, 0);
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(r.kept.claim(CH), null, "not claimable after the delete");
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, [G]);
});

test("discardChannel: a pending delete it waits on that rejects is caught and warned; the promise resolves (F1-R1)", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G).catch((e: unknown) => e);
  r.record(CH, G);
  const discarding = r.kept.discardChannel(CH);
  gate.reject(new Error("native delete failed"));
  await assert.doesNotReject(discarding);
  assert.ok(warn.mock.callCount() >= 1, "warned");
  assert.ok((await cleaning) instanceof Error, "the owner's cleanup rejects");
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.isInFlight(G), false);
});

test("discardChannel: waits for the pending delete of a record's group whose keep under ANOTHER channel was refused, without deleting it again (F1-R1, W2R-n1)", async (t) => {
  const info = t.mock.method(console, "info", () => undefined);
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  // While G's delete runs, a keep of G under chan-2 is refused, and CH's
  // record names G.
  r.kept.keep(G, "chan-2", 5_000);
  assert.equal(info.mock.callCount(), 1, "refused");
  assert.equal(r.kept.size, 0, "no entry");
  r.record(CH, G);
  let done = false;
  const discarding = r.kept.discardChannel(CH).then(() => (done = true));
  assert.equal(readResumeRecord(r.storage, CH), null, "record cleared");
  await settle();
  assert.equal(done, false, "the join path waits for G to be off the disk");
  assert.deepEqual(r.deleted, [G], "no second native delete");
  gate.resolve();
  await Promise.all([cleaning, discarding]);
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.size, 0);
  assert.equal(r.kept.claim("chan-2"), null, "not claimable after the delete");
});

test("discardChannel: a record-only group already in flight goes through `cleanup`, sharing its delete, so every record naming it goes, not only the channel's (F1-R1)", async () => {
  const r = new Rig();
  const gate = deferred<void>();
  r.deleteImpl = () => gate.promise;
  const cleaning = r.kept.cleanup(G);
  // Written while G's delete runs; no entry names G, only these records.
  r.record(CH, G);
  r.record("chan-2", G);
  r.record("chan-3", H);
  let done = false;
  const discarding = r.kept.discardChannel(CH).then(() => (done = true));
  assert.equal(readResumeRecord(r.storage, CH), null, "the channel's record");
  assert.equal(
    readResumeRecord(r.storage, "chan-2"),
    null,
    "chan-2's record names the group being deleted: cleared on the call",
  );
  assert.equal(readResumeRecord(r.storage, "chan-3")?.groupId, H);
  await settle();
  assert.equal(done, false, "waits for G to be off the disk");
  gate.resolve();
  await Promise.all([cleaning, discarding]);
  assert.deepEqual(r.deleted, [G], "one native delete");
  // G is off the disk: no channel may offer it for a resume.
  assert.equal(r.kept.recencyCandidate("chan-2"), null);
});

// Once `cleanup` starts, no entry and no record names its group any more, so
// a discard cannot attribute the running delete to a channel. It waits on
// every delete pending when it is called instead (W2R-m1): a join path that
// awaited it could otherwise create or join that group id while its native
// delete still runs.

test("discardChannel: waits out a pending delete nothing names any more (keep expiry, superseded keep, late hand-back, leave cleanup), on any channel, deleting nothing twice (W2R-m1)", async () => {
  const variants = ["expiry", "superseded", "late hand-back", "leave"] as const;
  for (const variant of variants) {
    for (const channel of [CH, "chan-2"]) {
      const at = `${variant} / ${channel}`;
      const r = new Rig();
      const gate = deferred<void>();
      r.deleteImpl = (g) => (g === G ? gate.promise : Promise.resolve());
      r.record(CH, G);
      r.kept.keep(G, CH, 5_000);
      if (variant === "expiry") r.clock.advance(5_000);
      if (variant === "superseded") r.kept.keep(H, CH, 5_000);
      if (variant === "late hand-back") {
        const claim = r.kept.claim(CH);
        assert.ok(claim, at);
        r.clock.t += 5_000;
        r.kept.handBack(claim.token);
      }
      if (variant === "leave") void r.kept.cleanup(G);
      // Only the running delete is left of G.
      assert.equal(r.kept.isInFlight(G), true, at);
      assert.equal(readResumeRecord(r.storage, CH), null, at);
      let done = false;
      const discarding = r.kept
        .discardChannel(channel)
        .then(() => (done = true));
      await settle();
      assert.equal(done, false, `${at}: resolved while G's delete runs`);
      gate.resolve();
      await discarding;
      assert.equal(r.kept.isInFlight(G), false, at);
      assert.deepEqual(
        r.deleted.filter((g) => g === G),
        [G],
        `${at}: one native delete of G`,
      );
    }
  }
});

test("discardAll: waits out a pending delete nothing names any more, with or without entries of its own to clean (W2R-m1)", async () => {
  for (const withEntry of [false, true]) {
    const r = new Rig();
    const gate = deferred<void>();
    r.deleteImpl = (g) => (g === G ? gate.promise : Promise.resolve());
    r.record(CH, G);
    r.kept.keep(G, CH, 5_000);
    if (withEntry) r.kept.keep(H, "chan-2", 10_000);
    // G's keep expired: its delete runs, and neither entry nor record is left.
    r.clock.advance(5_000);
    assert.equal(r.kept.isInFlight(G), true);
    assert.equal(r.kept.size, withEntry ? 1 : 0);
    let done = false;
    const discarding = r.kept.discardAll().then(() => (done = true));
    await settle();
    assert.equal(done, false, `entry ${withEntry}: resolved while G's runs`);
    gate.resolve();
    await discarding;
    assert.equal(r.kept.isInFlight(G), false);
    assert.equal(r.kept.size, 0);
    assert.deepEqual(r.deleted, withEntry ? [G, H] : [G], "none twice");
  }
});

test("discardChannel and discardAll: a pending delete they wait on that rejects is caught and warned; each still resolves (W2R-m1)", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  for (const which of ["discardChannel", "discardAll"] as const) {
    const r = new Rig();
    const gate = deferred<void>();
    r.deleteImpl = () => gate.promise;
    // A leave cleanup whose caller handles its own rejection: the only warn
    // can then come from the discard.
    const owner = r.kept.cleanup(G).catch((e: unknown) => e);
    const before = warn.mock.callCount();
    let done = false;
    const discarding = (
      which === "discardChannel"
        ? r.kept.discardChannel(CH)
        : r.kept.discardAll()
    ).then(() => (done = true));
    await settle();
    assert.equal(done, false, `${which}: waits for the delete`);
    gate.reject(new Error("native delete failed"));
    await assert.doesNotReject(discarding, which);
    assert.ok(warn.mock.callCount() > before, `${which}: warned`);
    assert.ok((await owner) instanceof Error, `${which}: the owner rejects`);
    assert.deepEqual(r.deleted, [G], which);
    assert.equal(r.kept.isInFlight(G), false, which);
  }
});

test("discardChannel and discardAll: wait on the deletes pending WHEN CALLED, not on one that starts after (W2R-m1)", async () => {
  for (const which of ["discardChannel", "discardAll"] as const) {
    const r = new Rig();
    const gateG = deferred<void>();
    const never = deferred<void>();
    r.deleteImpl = (g) => (g === G ? gateG.promise : never.promise);
    void r.kept.cleanup(G);
    let done = false;
    void (
      which === "discardChannel"
        ? r.kept.discardChannel(CH)
        : r.kept.discardAll()
    ).then(() => (done = true));
    // A later leave cleanup that never settles.
    void r.kept.cleanup(H);
    await settle();
    assert.equal(done, false, `${which}: waits for G's delete`);
    gateG.resolve();
    // A flag, not an await: a discard stuck on H fails here, never hangs.
    await settle();
    assert.equal(done, true, `${which}: settled with G's delete`);
    assert.equal(r.kept.isInFlight(H), true, `${which}: H still deleting`);
  }
});

test("setKeepsRefused: a refused keep cleans at once; lifting it restores keeps", async (t) => {
  for (const method of ["warn", "info", "log"] as const) {
    t.mock.method(console, method, () => undefined);
  }
  const r = new Rig();
  r.record(CH, G);
  r.kept.setKeepsRefused(true);
  r.kept.keep(G, CH, 5_000);
  assert.equal(r.kept.isInFlight(G), true);
  assert.equal(r.kept.size, 0);
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(readResumeRecord(r.storage, CH), null);
  await settle();
  assert.deepEqual(r.deleted, [G]);
  r.kept.setKeepsRefused(false);
  const t1 = r.clock.t;
  r.kept.keep(H, CH, 5_000);
  assert.equal(r.kept.size, 1);
  assert.deepEqual(r.clock.armed(), [t1 + 5_000]);
  await settle();
  assert.deepEqual(r.deleted, [G]);
});

test("timer fire: a failing delete is caught and warned, never an unhandled rejection", async (t) => {
  const warn = t.mock.method(console, "warn", () => undefined);
  const r = new Rig();
  r.deleteImpl = () => Promise.reject(new Error("native gone"));
  r.kept.keep(G, CH, 100);
  r.clock.advance(100);
  await settle();
  await settle();
  assert.deepEqual(r.deleted, [G]);
  assert.ok(warn.mock.callCount() >= 1);
  assert.equal(r.kept.isInFlight(G), false);
});

// ---------------------------------------------------------------------------
// prefetchResume

const SELF = { userId: "u-self", deviceId: "d-self" };

type Commit = {
  epoch: number;
  id: string;
  committer: { user_id: string; device_id: string };
};

const commit = (epoch: number, user_id: string, device_id: string): Commit => ({
  epoch,
  id: `c${epoch}`,
  committer: { user_id, device_id },
});

type Reads = Pick<
  PrefetchDeps<Commit>,
  "openGroup" | "callState" | "pendingCommitEpoch" | "fetchCommits"
>;

type CallState = Awaited<ReturnType<Reads["callState"]>>;

const activeState = (): CallState => ({
  channel_id: CH,
  epoch: 7,
  state: "active",
  members: [
    { user_id: SELF.userId, device_id: SELF.deviceId },
    { user_id: "u-b", device_id: "d-b" },
  ],
});

const happyReads = (): Reads => ({
  openGroup: async () => ({ group_id: G }),
  callState: async () => activeState(),
  pendingCommitEpoch: async () => null,
  fetchCommits: async () => ({
    kind: "ok",
    body: { commits: [commit(8, "u-b", "d-b")], current_epoch: 8 },
  }),
});

/** Prefetch deps over the rig, recording every read in call order. */
function reader(
  r: Rig,
  over: Partial<Reads> = {},
  self: PrefetchDeps<Commit>["self"] = SELF,
  storage: ResumeStorage | null = r.storage,
) {
  const reads = { ...happyReads(), ...over };
  const calls: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const deps: PrefetchDeps<Commit> = {
    kept: r.kept,
    storage,
    now: r.clock.now,
    self,
    openGroup: (channelId, signal) => {
      calls.push(`open:${channelId}`);
      signals.push(signal);
      return reads.openGroup(channelId, signal);
    },
    callState: (groupId) => {
      calls.push(`state:${groupId}`);
      return reads.callState(groupId);
    },
    pendingCommitEpoch: (groupId) => {
      calls.push(`pending:${groupId}`);
      return reads.pendingCommitEpoch(groupId);
    },
    fetchCommits: (groupId, fromEpoch, signal) => {
      calls.push(`fetch:${groupId}@${fromEpoch}`);
      signals.push(signal);
      return reads.fetchCommits(groupId, fromEpoch, signal);
    },
  };
  return { deps, calls, signals };
}

/** A kept, claimable G on CH with a fresh recency record. */
function keptCandidate(ms = 5_000) {
  const r = new Rig();
  const t0 = r.clock.t;
  r.kept.keep(G, CH, ms);
  r.record(CH, G);
  return { r, t0 };
}

/** Rejects with an AbortError when `signal` aborts, as `fetch` does. */
const untilAborted = (signal: AbortSignal | undefined): Promise<never> =>
  new Promise((_, reject) => {
    signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
      { once: true },
    );
  });

test("prefetch: no candidate → null, no reads", async () => {
  const r = new Rig();
  const { deps, calls } = reader(r);
  assert.equal(await prefetchResume(deps, CH), null);
  assert.deepEqual(calls, []);
  // A group kept for ANOTHER channel is no candidate here, and stays unclaimed.
  r.kept.keep(G, "chan-2", 5_000);
  r.record("chan-2", G);
  assert.equal(await prefetchResume(deps, CH), null);
  assert.deepEqual(calls, []);
  assert.equal(r.clock.armed().length, 1);
  assert.deepEqual(r.deleted, []);
});

test("prefetch: already aborted, or no signed-in self → null with nothing touched", async () => {
  for (const variant of ["aborted", "no-self"] as const) {
    const { r, t0 } = keptCandidate();
    const record = r.storage.getItem(KEY);
    const ctrl = new AbortController();
    if (variant === "aborted") ctrl.abort();
    const { deps, calls } = reader(r, {}, variant === "no-self" ? null : SELF);
    assert.equal(await prefetchResume(deps, CH, ctrl.signal), null, variant);
    assert.deepEqual(calls, [], variant);
    assert.deepEqual(r.clock.armed(), [t0 + 5_000], `${variant}: not claimed`);
    assert.equal(r.storage.getItem(KEY), record, variant);
    await settle();
    assert.deepEqual(r.deleted, [], variant);
  }
});

test("prefetch: claim candidate → every field, committerIsSelf per device, fetchedAtMs after the fetch, one fetch from epoch + 1", async () => {
  const { r, t0 } = keptCandidate();
  r.clock.t += 2_000;
  const record = r.storage.getItem(KEY);
  const commits = [
    commit(8, "u-b", "d-b"),
    commit(9, SELF.userId, SELF.deviceId),
    commit(10, SELF.userId, "d-other"),
    commit(11, "u-other", SELF.deviceId),
  ];
  let fetchedAt = -1;
  const { deps, calls, signals } = reader(r, {
    fetchCommits: async () => {
      r.clock.t += 40;
      fetchedAt = r.clock.t;
      return { kind: "ok", body: { commits, current_epoch: 11 } };
    },
  });
  const ctrl = new AbortController();
  const got = await prefetchResume(deps, CH, ctrl.signal);
  assert.equal(fetchedAt, t0 + 2_040);
  assert.deepEqual(got, {
    groupId: G,
    claimToken: "tok-1",
    fetchedAtMs: t0 + 2_040,
    queriedChannelId: CH,
    localEpoch: 7,
    localState: "active",
    localChannelId: CH,
    selfInLocalRoster: true,
    openGroupId: G,
    pendingCommit: null,
    commits: [
      { ...commits[0], committerIsSelf: false },
      { ...commits[1], committerIsSelf: true },
      { ...commits[2], committerIsSelf: false },
      { ...commits[3], committerIsSelf: false },
    ],
    currentEpoch: 11,
  });
  assert.deepEqual(calls.slice(0, 3).sort(), [
    `open:${CH}`,
    `pending:${G}`,
    `state:${G}`,
  ]);
  assert.deepEqual(calls.slice(3), [`fetch:${G}@8`], "one fetch, epoch + 1");
  assert.deepEqual(signals, [ctrl.signal, ctrl.signal]);
  // Held under the claim; nothing written, nothing deleted.
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(r.kept.size, 1);
  assert.equal(r.kept.claim(CH), null);
  assert.equal(r.storage.getItem(KEY), record);
  await settle();
  assert.deepEqual(r.deleted, []);
});

test("prefetch: the three reads start together; the fetch follows them", async () => {
  const { r } = keptCandidate();
  const open = deferred<{ group_id: string } | null>();
  const state = deferred<CallState>();
  const pending = deferred<number | null>();
  const { deps, calls } = reader(r, {
    openGroup: () => open.promise,
    callState: () => state.promise,
    pendingCommitEpoch: () => pending.promise,
  });
  const prefetch = prefetchResume(deps, CH);
  await settle();
  assert.deepEqual([...calls].sort(), [
    `open:${CH}`,
    `pending:${G}`,
    `state:${G}`,
  ]);
  state.resolve(activeState());
  open.resolve({ group_id: G });
  pending.resolve(null);
  const got = await prefetch;
  assert.deepEqual(calls.slice(3), [`fetch:${G}@8`]);
  assert.equal(got?.groupId, G);
});

test("prefetch: recency-only candidate (no keep entry) → token null, fields passed through", async () => {
  const r = new Rig();
  r.record(CH, G, 3_000);
  const { deps, calls } = reader(r, {
    openGroup: async () => ({ group_id: H }),
    callState: async () => ({
      channel_id: "chan-other",
      epoch: 4,
      state: "stale",
      members: [
        { user_id: SELF.userId, device_id: "d-other" },
        { user_id: "u-other", device_id: SELF.deviceId },
      ],
    }),
    pendingCommitEpoch: async () => 5,
    fetchCommits: async () => ({
      kind: "ok",
      body: { commits: [], current_epoch: 4 },
    }),
  });
  const got = await prefetchResume(deps, CH);
  assert.deepEqual(got, {
    groupId: G,
    claimToken: null,
    fetchedAtMs: r.clock.t,
    queriedChannelId: CH,
    localEpoch: 4,
    localState: "poisoned",
    localChannelId: "chan-other",
    selfInLocalRoster: false,
    openGroupId: H,
    pendingCommit: 5,
    commits: [],
    currentEpoch: 4,
  });
  assert.equal(calls[3], `fetch:${G}@5`);
  assert.equal(r.kept.size, 0);
  await settle();
  assert.deepEqual(r.deleted, []);
});

test("prefetch: a kept group no claim can take is no recency candidate either → null, no reads, left to its entry (W2-m2)", async () => {
  // Claimed by an earlier connect's prefetch that has not settled.
  const { r, t0 } = keptCandidate();
  const held = r.kept.claim(CH);
  assert.ok(held);
  const { deps, calls } = reader(r);
  assert.equal(await prefetchResume(deps, CH), null, "claimed elsewhere");
  // Handed back, then past its deadline with the timer not yet run.
  r.kept.handBack(held.token);
  r.clock.t = t0 + 5_000;
  assert.equal(await prefetchResume(deps, CH), null, "past its deadline");
  assert.deepEqual(calls, []);
  assert.deepEqual(r.deleted, []);
  assert.deepEqual(r.clock.armed(), [t0 + 5_000], "still its entry's timer");
  r.clock.advance(0);
  await settle();
  assert.deepEqual(r.deleted, [G], "the entry's expiry deletes it, once");
});

test("prefetch: a claim candidate whose record is missing, stale or names another group → cleaned, null", async () => {
  for (const variant of ["missing", "stale", "other-group"] as const) {
    const r = new Rig();
    r.kept.keep(G, CH, 5_000);
    if (variant === "stale") r.record(CH, G, LOCAL_GROUP_KEEP_MS + 1);
    if (variant === "other-group") r.record(CH, H);
    const { deps } = reader(r);
    assert.equal(await prefetchResume(deps, CH), null, variant);
    assert.deepEqual(r.deleted, [G], variant);
    assert.equal(r.kept.isInFlight(G), false, variant);
    assert.equal(r.kept.size, 0, variant);
    assert.equal(r.kept.claim(CH), null, variant);
  }
});

test("prefetch: abort BEFORE the reads resolve → synchronous hand-back at the original deadline, null, no cleanup", async () => {
  const { r, t0 } = keptCandidate();
  const state = deferred<CallState>();
  const pending = deferred<number | null>();
  const { deps, calls } = reader(r, {
    openGroup: (_, signal) => untilAborted(signal),
    callState: () => state.promise,
    pendingCommitEpoch: () => pending.promise,
  });
  const ctrl = new AbortController();
  const prefetch = prefetchResume(deps, CH, ctrl.signal);
  await settle();
  assert.deepEqual(r.clock.armed(), [], "claimed: timer suspended");
  r.clock.t += 1_000;
  ctrl.abort();
  // Inside the abort, before any await: re-armed at the ORIGINAL deadline.
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  state.resolve(activeState());
  pending.resolve(null);
  assert.equal(await prefetch, null);
  assert.ok(!calls.some((c) => c.startsWith("fetch:")), "no fetch after abort");
  assert.deepEqual(r.deleted, []);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.size, 1);
  r.clock.advance(4_000);
  await settle();
  assert.deepEqual(r.deleted, [G], "the handed-back entry expires normally");
});

test("prefetch: abort DURING the commits fetch → handed back, null, no cleanup", async () => {
  const { r, t0 } = keptCandidate();
  const { deps, calls } = reader(r, {
    fetchCommits: (_, __, signal) => untilAborted(signal),
  });
  const ctrl = new AbortController();
  const prefetch = prefetchResume(deps, CH, ctrl.signal);
  await settle();
  assert.equal(calls[3], `fetch:${G}@8`);
  assert.deepEqual(r.clock.armed(), []);
  ctrl.abort();
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  assert.equal(await prefetch, null);
  await settle();
  assert.deepEqual(r.deleted, []);
  assert.equal(r.kept.size, 1);
});

test("prefetch: abort AFTER a successful resolve still hands the claim back", async () => {
  const { r, t0 } = keptCandidate();
  const { deps } = reader(r);
  const ctrl = new AbortController();
  const got = await prefetchResume(deps, CH, ctrl.signal);
  assert.equal(got?.claimToken, "tok-1");
  assert.deepEqual(r.clock.armed(), []);
  r.clock.t += 1_000;
  ctrl.abort();
  assert.deepEqual(r.clock.armed(), [t0 + 5_000]);
  assert.deepEqual(r.kept.claim(CH), {
    token: "tok-2",
    groupId: G,
    deadlineMs: t0 + 5_000,
  });
});

test("prefetch: abort after the session released the group is a no-op", async () => {
  const { r } = keptCandidate();
  const { deps } = reader(r);
  const ctrl = new AbortController();
  const got = await prefetchResume(deps, CH, ctrl.signal);
  assert.equal(got?.groupId, G);
  r.kept.release(G);
  ctrl.abort();
  assert.deepEqual(r.clock.armed(), []);
  assert.equal(r.kept.size, 0);
  r.clock.advance(60_000);
  await settle();
  assert.deepEqual(r.deleted, []);
});

test("prefetch: old shell (pending-commit probe rejects) → cleaned, and the cleanup completes BEFORE null resolves", async () => {
  const { r } = keptCandidate();
  const events: string[] = [];
  r.deleteImpl = async (g) => {
    events.push(`delete ${g}`);
    await settle();
    events.push(`deleted ${g}`);
  };
  const { deps } = reader(r, {
    pendingCommitEpoch: () =>
      Promise.reject(
        new Error("unknown command e2ee_call_pending_commit_epoch"),
      ),
  });
  const got = await prefetchResume(deps, CH).then((v) => {
    events.push("resolved");
    return v;
  });
  assert.equal(got, null);
  assert.deepEqual(events, [`delete ${G}`, `deleted ${G}`, "resolved"]);
  assert.equal(r.kept.isInFlight(G), false);
  assert.equal(r.kept.size, 0);
  assert.equal(readResumeRecord(r.storage, CH), null);
  assert.equal(r.kept.claim(CH), null);
});

test("prefetch: a non-ok commits fetch → cleaned, null (claim and recency-only candidates alike)", async () => {
  const notOk: Partial<Reads> = {
    fetchCommits: async () => ({ kind: "gone" }),
  };
  const { r } = keptCandidate();
  assert.equal(await prefetchResume(reader(r, notOk).deps, CH), null);
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.size, 0);
  assert.equal(r.kept.isInFlight(G), false);

  const recent = new Rig();
  recent.record(CH, G);
  assert.equal(await prefetchResume(reader(recent, notOk).deps, CH), null);
  assert.deepEqual(recent.deleted, [G]);
  assert.equal(readResumeRecord(recent.storage, CH), null);
});

test("prefetch: openGroup → null is a prefetch with openGroupId null, not a failure", async () => {
  const { r } = keptCandidate();
  const { deps } = reader(r, { openGroup: async () => null });
  const got = await prefetchResume(deps, CH);
  assert.equal(got?.groupId, G);
  assert.equal(got?.openGroupId, null);
  assert.equal(got?.claimToken, "tok-1");
  await settle();
  assert.deepEqual(r.deleted, []);
});

test("prefetch: never rejects — sync throws, rejections, a failing cleanup, throwing storage", async (t) => {
  t.mock.method(console, "warn", () => undefined);
  const fail = () => {
    throw new Error("sync throw");
  };
  const cases: [string, Partial<Reads>, ResumeStorage | null | undefined][] = [
    ["callState throws synchronously", { callState: fail }, undefined],
    [
      "openGroup rejects",
      { openGroup: () => Promise.reject(new Error("x")) },
      undefined,
    ],
    ["fetchCommits throws synchronously", { fetchCommits: fail }, undefined],
    [
      "callState rejects",
      { callState: () => Promise.reject(new Error("x")) },
      undefined,
    ],
    ["storage throws", {}, throwingStorage],
  ];
  for (const [name, over, storage] of cases) {
    const { r } = keptCandidate();
    const { deps } = reader(
      r,
      over,
      SELF,
      storage === undefined ? r.storage : storage,
    );
    assert.equal(await prefetchResume(deps, CH), null, name);
    assert.deepEqual(r.deleted, [G], name);
  }
  // The cleanup itself fails: still null.
  const { r } = keptCandidate();
  r.deleteImpl = () => Promise.reject(new Error("native delete failed"));
  const { deps } = reader(r, {
    callState: () => Promise.reject(new Error("x")),
  });
  assert.equal(await prefetchResume(deps, CH), null);
  assert.deepEqual(r.deleted, [G]);
  assert.equal(r.kept.isInFlight(G), false);
});

test("prefetch: the abort listener is removed on every null return and stays attached after success", async (t: TestContext) => {
  const watch = (ctrl: AbortController) => {
    const add = t.mock.method(ctrl.signal, "addEventListener");
    const remove = t.mock.method(ctrl.signal, "removeEventListener");
    return () => {
      const of = (calls: { arguments: unknown[] }[]) =>
        calls
          .filter((c) => c.arguments[0] === "abort")
          .map((c) => c.arguments[1]);
      const removed = of(remove.mock.calls);
      return of(add.mock.calls).filter((fn) => !removed.includes(fn)).length;
    };
  };
  const unrecorded = () => {
    const r = new Rig();
    r.kept.keep(G, CH, 5_000);
    return r;
  };
  const nulls: [string, () => Rig, Partial<Reads>][] = [
    ["no candidate", () => new Rig(), {}],
    ["claim fails recency", unrecorded, {}],
    [
      "read rejects",
      () => keptCandidate().r,
      { callState: () => Promise.reject(new Error("x")) },
    ],
    [
      "non-ok fetch",
      () => keptCandidate().r,
      { fetchCommits: async () => ({ kind: "gone" }) },
    ],
  ];
  for (const [name, make, over] of nulls) {
    const r = make();
    const ctrl = new AbortController();
    const attached = watch(ctrl);
    const got = await prefetchResume(reader(r, over).deps, CH, ctrl.signal);
    assert.equal(got, null, name);
    assert.equal(attached(), 0, `${name}: listener removed`);
  }
  const { r } = keptCandidate();
  const ctrl = new AbortController();
  const attached = watch(ctrl);
  const got = await prefetchResume(reader(r).deps, CH, ctrl.signal);
  assert.equal(got?.groupId, G);
  assert.ok(attached() >= 1, "success: the hand-back listener stays");
});
