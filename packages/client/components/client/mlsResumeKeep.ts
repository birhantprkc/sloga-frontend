/**
 * Kept local MLS groups, the resume claim on them, and the recency record.
 *
 * WHY THIS EXISTS (join-latency plan R-W2-1). A hang-up no longer deletes the
 * call's local MLS group at once: it is KEPT for `LOCAL_GROUP_KEEP_MS` so a
 * quick rejoin can resume it instead of re-enrolling (D1). Whether a group on
 * disk can ever be resumed, and when it is finally deleted, is decided here.
 * `e2ee.ts` cannot be loaded under `node --test`, so this logic lives in a
 * pure module: the bridge only wires it to the native delete,
 * `sessionStorage`, the wall clock and `setTimeout`, and the harness builds
 * its bridge stubs from this same module, so the specs run the real lifecycle
 * rather than a stub of it.
 *
 * CLAIM LIFECYCLE (audit R2-B1). A resume prefetch CLAIMS the kept entry for
 * its channel so the keep timer cannot delete the group under it. A claim
 * with no consume contract would let a late expiry delete the live resumed
 * group, a fallback group with the same id or the next keep's group, and
 * repeated claims would stretch a keep past its 10 s. So a claim suspends the
 * entry's timer without cancelling it, never moves its deadline and never
 * refreshes recency. The re-check found four gaps; each is closed where it is
 * marked below:
 *  (1) state is per keep ENTRY, never per group id (`keep`, `release`);
 *  (2) an unconsumed claim is handed back SYNCHRONOUSLY in the abort
 *      listener, so a stale hand-back can never race the winner
 *      (`prefetchResume`);
 *  (3) a group being deleted is marked in flight and loses its recency record
 *      BEFORE the native delete is awaited (`cleanup`);
 *  (4) keep expiry clears the recency record (`#expire`).
 *
 * IN-FLIGHT EXCLUSION. From the moment a cleanup of a group starts until the
 * native delete settles, the group can be neither claimed nor offered as a
 * recency candidate, so a superseding connect cannot adopt a group that is
 * halfway off the disk. `cleanup` is the ONLY path to the native delete
 * (R-W2-2): keep expiry, a superseded keep, a refused keep, discard-all, a
 * channel discard and every bridge `callLeaveCleanup` all go through it.
 * It runs at most one native delete per group and hands a later caller the
 * pending one (F1-R1), so nothing awaiting it races a delete still running.
 * A group in flight cannot be kept either: the keep is refused (W2R-n1).
 * The discards wait out every pending delete, whether or not it can be
 * traced to what they discard (W2R-m1).
 * `release` reports whether the group it stops tracking is in flight, so an
 * adopter learns the group is being deleted rather than resuming it (W2-m2).
 *
 * UNCLAIMED CANDIDATES (W2-m2). A recency candidate carries no claim, so
 * nothing stops a keep entry's timer from deleting it under its adopter. A
 * group any live entry names (claimed, unclaimed, or past its deadline with
 * the timer not yet fired) is therefore never offered by recency: it is
 * resumed through its entry's claim or not at all.
 *
 * NULL PREFETCHES (W2-m1). A prefetch can answer `null` and still leave a
 * kept group on disk: no signed-in device, a claim past its deadline, an
 * entry claimed by another prefetch. By then a startup has spent the wipe
 * token, so nothing else deletes it before the join's create ladder trips
 * over it. `discardChannel` deletes everything this registry or the
 * channel's record names for the channel, for the join path to await.
 *
 * RECENCY (D7). `sessionStorage["mls-resume:<channelId>"] = { groupId, epoch,
 * at }`. A resume candidate must be named by its channel's record and be at
 * most `LOCAL_GROUP_KEEP_MS` old, so a hostile DS cannot steer a resume into
 * an old group this device still holds, and whatever a dead page left on
 * disk is never resumed. Storage that is missing or throws reads as "no
 * record", which means no resume.
 *
 * Pure: time, timers, storage, token minting and the native delete all come
 * in through deps.
 */

import {
  type ResumeCommitRef,
  type ResumePrefetch,
  recencyValid,
} from "../rtc/mlsRejoinPolicy.ts";

export type ResumeClaim = {
  token: string;
  groupId: string;
  deadlineMs: number;
};

export type ResumeRecord = { groupId: string; epoch: number; at: number };

/** The slice of the Web Storage API the records use. */
export type ResumeStorage = {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
  key(i: number): string | null;
  readonly length: number;
};

export const RESUME_RECORD_PREFIX = "mls-resume:";

function parseRecord(raw: string): ResumeRecord | null {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null) return null;
  const { groupId, epoch, at } = v as Record<string, unknown>;
  if (typeof groupId !== "string" || groupId === "") return null;
  if (typeof epoch !== "number" || !Number.isSafeInteger(epoch) || epoch < 0) {
    return null;
  }
  if (typeof at !== "number" || !Number.isFinite(at)) return null;
  return { groupId, epoch, at };
}

/** Every record key currently in `s`; unreadable indices are skipped. */
function recordKeys(s: ResumeStorage): string[] {
  const keys: string[] = [];
  let n = 0;
  try {
    n = s.length;
  } catch {
    return keys;
  }
  for (let i = 0; i < n; i++) {
    try {
      const k = s.key(i);
      if (k !== null && k.startsWith(RESUME_RECORD_PREFIX)) keys.push(k);
    } catch {
      // Skip it; a record we cannot see is a record nothing can resume from.
    }
  }
  return keys;
}

function removeKey(s: ResumeStorage, k: string): void {
  try {
    s.removeItem(k);
  } catch {
    // Unavailable storage: nothing else can read the record either.
  }
}

/** The channel's record, or `null` if absent, malformed or unreadable. */
export function readResumeRecord(
  s: ResumeStorage | null,
  channelId: string,
): ResumeRecord | null {
  if (!s) return null;
  try {
    const raw = s.getItem(RESUME_RECORD_PREFIX + channelId);
    return raw === null ? null : parseRecord(raw);
  } catch {
    return null;
  }
}

export function writeResumeRecord(
  s: ResumeStorage | null,
  channelId: string,
  rec: ResumeRecord,
): void {
  if (!s) return;
  try {
    s.setItem(
      RESUME_RECORD_PREFIX + channelId,
      JSON.stringify({ groupId: rec.groupId, epoch: rec.epoch, at: rec.at }),
    );
  } catch {
    // Full or unavailable: no record means no resume, which fails closed.
  }
}

export function clearResumeRecord(
  s: ResumeStorage | null,
  channelId: string,
): void {
  if (!s) return;
  removeKey(s, RESUME_RECORD_PREFIX + channelId);
}

/**
 * Remove every record naming `groupId`, whatever its channel. A record that
 * names the group but is otherwise malformed goes too.
 */
export function clearResumeRecordsForGroup(
  s: ResumeStorage | null,
  groupId: string,
): void {
  if (!s) return;
  for (const k of recordKeys(s)) {
    let names = false;
    try {
      const raw = s.getItem(k);
      if (raw !== null) {
        const v: unknown = JSON.parse(raw);
        names =
          typeof v === "object" &&
          v !== null &&
          (v as { groupId?: unknown }).groupId === groupId;
      }
    } catch {
      // Unreadable or malformed: it reads as no record anyway.
    }
    if (names) removeKey(s, k);
  }
}

export function clearAllResumeRecords(s: ResumeStorage | null): void {
  if (!s) return;
  for (const k of recordKeys(s)) removeKey(s, k);
}

export interface KeptGroupsDeps {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** The RAW native delete (`e2ee_call_leave_cleanup`). */
  deleteLocal(groupId: string): Promise<void>;
  storage: ResumeStorage | null;
  newToken(): string;
}

/** One armed timer; the fire is ignored unless it is still the entry's. */
type TimerSlot = { handle: unknown };

type KeepEntry = {
  readonly groupId: string;
  readonly channelId: string;
  /** Fixed at keep time; no claim or hand-back ever moves it. */
  readonly deadlineMs: number;
  timer: TimerSlot | null;
  claimToken: string | null;
};

/**
 * The kept local groups. At most one entry is CLAIMABLE per channel; a
 * claimed entry displaced by a newer keep on its channel stays tracked, but
 * unclaimable, until its holder hands it back or releases it.
 */
export class KeptLocalGroups {
  readonly #deps: KeptGroupsDeps;
  /** Every live entry, including a claimed one displaced from its channel. */
  readonly #entries = new Set<KeepEntry>();
  readonly #byChannel = new Map<string, KeepEntry>();
  /** Group id → its native delete, from the start of `cleanup` to settling. */
  readonly #pending = new Map<string, Promise<void>>();
  #refused = false;

  constructor(deps: KeptGroupsDeps) {
    this.#deps = deps;
  }

  /**
   * Keep `groupId` on disk for `ms`, then delete it. While keeps are refused
   * the group is deleted at once instead. A keep of a group whose delete is
   * pending is refused outright (W2R-n1).
   *
   * `true` iff an entry was created. `false` on either refusal, and the
   * caller must then not write a recency record for the group: the group is
   * already on its way off the disk, and a record would name a deleted group.
   */
  keep(groupId: string, channelId: string, ms: number): boolean {
    // W2R-n1: `cleanup` dropped every entry naming the group when its delete
    // started, so an entry created now would outlive that delete and be
    // claimable once it settled, naming a group no longer on disk. The
    // pending delete already removes the group: refuse, change nothing.
    if (this.isInFlight(groupId)) {
      console.info("[mls] keep refused: the group's delete is pending", {
        groupId,
        channelId,
      });
      return false;
    }
    if (this.#refused) {
      this.#cleanupLogged(groupId, "keep refused");
      return false;
    }
    const deadlineMs = this.#deps.now() + ms;
    // Gap (1): any older entry for this group, claimed or not, is dropped and
    // the keep gets a FRESH entry that expires on its own deadline. A token
    // issued for the old entry is now stale and its hand-back a no-op.
    this.#deleteEntries(groupId);
    const older = this.#byChannel.get(channelId);
    if (older !== undefined) {
      this.#byChannel.delete(channelId);
      // A claimed older group belongs to its claim holder: its hand-back
      // resumes its own timer, its release drops it.
      if (older.claimToken === null) {
        this.#cleanupLogged(older.groupId, "superseded keep");
      }
    }
    const entry: KeepEntry = {
      groupId,
      channelId,
      deadlineMs,
      timer: null,
      claimToken: null,
    };
    this.#entries.add(entry);
    this.#byChannel.set(channelId, entry);
    this.#arm(entry, ms);
    return true;
  }

  /**
   * Claim the channel's kept group for a resume prefetch. `null` unless an
   * unclaimed entry exists, its group is not being deleted and its deadline
   * has not passed. The entry's timer is suspended; the deadline and the
   * recency record are left exactly as they were.
   */
  claim(channelId: string): ResumeClaim | null {
    const entry = this.#byChannel.get(channelId);
    if (entry === undefined || entry.claimToken !== null) return null;
    if (this.isInFlight(entry.groupId)) return null;
    if (!(this.#deps.now() < entry.deadlineMs)) return null;
    const token = this.#deps.newToken();
    this.#disarm(entry);
    entry.claimToken = token;
    return { token, groupId: entry.groupId, deadlineMs: entry.deadlineMs };
  }

  /**
   * Return an unconsumed claim. The entry's timer resumes at its ORIGINAL
   * deadline, or the group is deleted now if that has passed. An unknown or
   * stale token (the entry was released, re-kept or cleaned) is a no-op.
   */
  handBack(token: string): void {
    for (const entry of this.#entries) {
      if (entry.claimToken !== token) continue;
      const remaining = entry.deadlineMs - this.#deps.now();
      entry.claimToken = null;
      if (remaining > 0) {
        this.#arm(entry, remaining);
      } else {
        this.#cleanupLogged(entry.groupId, "handed back past its deadline");
      }
      return;
    }
  }

  /**
   * Stop tracking `groupId` without deleting it: the session adopted it, or
   * is about to delete it itself. No native call, no recency change.
   *
   * `false` if a cleanup of the group is in flight (W2-m2): the entry is
   * dropped either way, but the group is on its way off the disk and must
   * not be adopted.
   */
  release(groupId: string): boolean {
    // Gap (1): deleting the ENTRY means no timer of this registry can touch
    // the group afterwards; a later keep of it starts a fresh entry.
    this.#deleteEntries(groupId);
    return !this.isInFlight(groupId);
  }

  /**
   * THE single path to the native delete (R-W2-2). Everything up to the
   * native delete runs synchronously on the call; a rejection propagates.
   *
   * One native delete per group at a time (F1-R1): while one is pending, a
   * call still drops any entry and record naming the group, then returns
   * THAT delete's promise, so no caller settles before the delete has.
   */
  cleanup(groupId: string): Promise<void> {
    const pending = this.#pending.get(groupId);
    if (pending !== undefined) {
      this.#deleteEntries(groupId);
      clearResumeRecordsForGroup(this.#deps.storage, groupId);
      return pending;
    }
    let resolve!: () => void;
    let reject!: (err: unknown) => void;
    const run = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Gap (3): in flight and off the recency record BEFORE the await, so
    // neither a claim nor a recency candidate can name the group mid-delete.
    this.#pending.set(groupId, run);
    this.#delete(groupId).then(resolve, reject);
    return run;
  }

  isInFlight(groupId: string): boolean {
    return this.#pending.has(groupId);
  }

  /**
   * The group a resume may try with no kept entry to claim (a Ctrl+R or a
   * crash): the channel's record, if it is recent, its group is not being
   * deleted and no keep entry names it.
   */
  recencyCandidate(channelId: string): string | null {
    const rec = readResumeRecord(this.#deps.storage, channelId);
    if (rec === null || this.isInFlight(rec.groupId)) return null;
    // W2-m2: an entry's timer could delete the group under an adopter that
    // holds no claim on it, so a kept group is offered only by `claim`.
    if (this.#hasEntry(rec.groupId)) return null;
    return recencyValid(rec, rec.groupId, this.#deps.now())
      ? rec.groupId
      : null;
  }

  /**
   * Delete every kept group and every record. All cleanups start before this
   * returns; the promise settles when they all have, and every other native
   * delete pending at the call has too (W2R-m1), and never rejects.
   */
  async discardAll(): Promise<void> {
    const groups = new Set([...this.#entries].map((e) => e.groupId));
    const pending = [...groups].map((g) => this.cleanup(g));
    clearAllResumeRecords(this.#deps.storage);
    const results = await Promise.allSettled(this.#withPending(pending));
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[mls] kept group discard failed", r.reason);
      }
    }
  }

  /**
   * Delete everything a resume could still name for `channelId`, before a
   * join path creates or joins the channel's group (W2-m1): every entry for
   * the channel, claimed or not, and the group its record names unless
   * another channel's entry names it. The record goes too. All cleanups
   * start before this returns; the promise settles when they all have, and
   * never rejects. A delete already running is not repeated but is waited
   * out (F1-R1), so an awaiting caller can join the same group id with no
   * native delete of it still running. That covers EVERY delete pending at
   * the call, not only the ones this channel's entries or record name
   * (W2R-m1): see `#withPending`.
   */
  async discardChannel(channelId: string): Promise<void> {
    // The record's group is judged against the entries as they stand, so a
    // group an entry names is cleaned once, through that entry, and another
    // channel's entry is left to its own keep.
    const rec = readResumeRecord(this.#deps.storage, channelId);
    const recordOnly =
      rec !== null && !this.#hasEntry(rec.groupId) ? rec.groupId : null;
    const groups = new Set<string>();
    for (const entry of this.#entries) {
      if (entry.channelId === channelId) groups.add(entry.groupId);
    }
    if (recordOnly !== null) groups.add(recordOnly);
    // A group whose delete is pending gets that delete back from `cleanup`.
    const pending = [...groups].map((g) => this.cleanup(g));
    clearResumeRecord(this.#deps.storage, channelId);
    const results = await Promise.allSettled(this.#withPending(pending));
    for (const r of results) {
      if (r.status === "rejected") {
        console.warn("[mls] kept channel discard failed", {
          channelId,
          err: r.reason,
        });
      }
    }
  }

  setKeepsRefused(refused: boolean): void {
    this.#refused = refused;
  }

  get size(): number {
    return this.#entries.size;
  }

  #arm(entry: KeepEntry, ms: number): void {
    const slot: TimerSlot = { handle: null };
    entry.timer = slot;
    slot.handle = this.#deps.setTimer(() => this.#expire(entry, slot), ms);
  }

  #disarm(entry: KeepEntry): void {
    if (entry.timer === null) return;
    this.#deps.clearTimer(entry.timer.handle);
    entry.timer = null;
  }

  #expire(entry: KeepEntry, slot: TimerSlot): void {
    if (entry.timer !== slot || !this.#entries.has(entry)) return;
    entry.timer = null;
    // Gap (4): expiry goes through `cleanup`, which clears the recency
    // record, so a group past its keep is never a recency candidate either.
    this.#cleanupLogged(entry.groupId, "keep expired");
  }

  /**
   * `started` plus every native delete pending now, each once (W2R-m1).
   * Once `cleanup` starts, no entry or record names the group any more, so a
   * delete begun by a keep expiry, a hand-back past its deadline, a
   * superseded keep or a prefetch giving up cannot be traced to a channel.
   * A discard that waited only on what it could trace would settle while
   * such a delete still ran, and a join awaiting it could create or join
   * that same group id under the delete.
   */
  #withPending(started: Promise<void>[]): Promise<void>[] {
    return [...new Set([...started, ...this.#pending.values()])];
  }

  #hasEntry(groupId: string): boolean {
    for (const entry of this.#entries) {
      if (entry.groupId === groupId) return true;
    }
    return false;
  }

  #deleteEntries(groupId: string): void {
    for (const entry of [...this.#entries]) {
      if (entry.groupId !== groupId) continue;
      this.#entries.delete(entry);
      if (this.#byChannel.get(entry.channelId) === entry) {
        this.#byChannel.delete(entry.channelId);
      }
      this.#disarm(entry);
    }
  }

  /** `cleanup`'s body; the group is already marked in flight. */
  async #delete(groupId: string): Promise<void> {
    try {
      this.#deleteEntries(groupId);
      clearResumeRecordsForGroup(this.#deps.storage, groupId);
      await this.#deps.deleteLocal(groupId);
    } finally {
      this.#pending.delete(groupId);
    }
  }

  #cleanupLogged(groupId: string, reason: string): void {
    this.cleanup(groupId).catch((err: unknown) => {
      console.warn("[mls] kept group cleanup failed", { groupId, reason, err });
    });
  }
}

export interface PrefetchDeps<
  C extends {
    epoch: number;
    committer: { user_id: string; device_id: string };
  },
> {
  kept: KeptLocalGroups;
  storage: ResumeStorage | null;
  now(): number;
  self: { userId: string; deviceId: string } | null;
  openGroup(
    channelId: string,
    signal?: AbortSignal,
  ): Promise<{ group_id: string } | null>;
  callState(groupId: string): Promise<{
    channel_id: string;
    epoch: number;
    state: string;
    members: readonly { user_id: string; device_id: string }[];
  }>;
  pendingCommitEpoch(groupId: string): Promise<number | null>;
  fetchCommits(
    groupId: string,
    fromEpoch: number,
    signal?: AbortSignal,
  ): Promise<
    | { kind: "ok"; body: { commits: C[]; current_epoch: number } }
    | { kind: string }
  >;
}

/**
 * Gather, read-only, what a resume decision needs for `channelId`'s candidate
 * group. Nothing is applied and nothing native is mutated; the only write is
 * the failure path's `cleanup`. NEVER rejects.
 *
 *  - Aborted (or no signed-in device) before starting → `null`, nothing
 *    touched.
 *  - Candidate: the channel's claimable kept group, which must ALSO pass
 *    recency; else the recency record's group (no claim), if no keep entry
 *    names it. None → `null`.
 *  - Aborted at any await → `null`; the listener already handed the claim
 *    back, and the group is left to its keep.
 *  - A read that throws (an old shell without the pending-commit op), a
 *    non-ok commits fetch, or a claimed group failing recency → the candidate
 *    is cleaned up, awaited, THEN `null`: a candidate is never left on disk
 *    for a join path to trip over.
 */
export async function prefetchResume<
  C extends {
    epoch: number;
    committer: { user_id: string; device_id: string };
  },
>(
  deps: PrefetchDeps<C>,
  channelId: string,
  signal?: AbortSignal,
): Promise<ResumePrefetch<C & ResumeCommitRef> | null> {
  const self = deps.self;
  if (signal?.aborted || self === null) return null;

  let groupId: string | null = null;
  let claim: ResumeClaim | null = null;
  // Gap (2): the hand-back runs INSIDE the abort dispatch, before any await
  // can resume, so a superseding connect's claim sees the entry already
  // re-armed. It stays attached after a successful resolve: a connect
  // superseded later still hands back, and once the session has released the
  // entry the token is stale and the hand-back a no-op.
  const handBack = () => {
    if (claim !== null) deps.kept.handBack(claim.token);
  };
  const giveUp = async (why: string, err?: unknown): Promise<null> => {
    signal?.removeEventListener("abort", handBack);
    if (signal?.aborted) return null;
    console.warn("[mls] resume prefetch abandoned", {
      channelId,
      groupId,
      why,
      err,
    });
    if (groupId === null) return null;
    try {
      await deps.kept.cleanup(groupId);
    } catch (cleanupErr) {
      console.warn("[mls] resume candidate cleanup failed", {
        groupId,
        err: cleanupErr,
      });
    }
    return null;
  };

  try {
    claim = deps.kept.claim(channelId);
    if (claim !== null) {
      groupId = claim.groupId;
      const rec = readResumeRecord(deps.storage, channelId);
      if (!recencyValid(rec, groupId, deps.now())) {
        return await giveUp("claimed group has no recent record");
      }
      signal?.addEventListener("abort", handBack, { once: true });
    } else {
      groupId = deps.kept.recencyCandidate(channelId);
      if (groupId === null) return null;
    }
    const candidate = groupId;

    const [open, state, pendingCommit] = await Promise.all([
      deps.openGroup(channelId, signal),
      deps.callState(candidate),
      deps.pendingCommitEpoch(candidate),
    ]);
    if (signal?.aborted) return await giveUp("aborted");

    const fetched = await deps.fetchCommits(candidate, state.epoch + 1, signal);
    if (signal?.aborted) return await giveUp("aborted");
    if (fetched.kind !== "ok" || !("body" in fetched)) {
      return await giveUp(`commits fetch ${fetched.kind}`);
    }

    const isSelf = (m: { user_id: string; device_id: string }) =>
      m.user_id === self.userId && m.device_id === self.deviceId;
    return {
      groupId: candidate,
      claimToken: claim?.token ?? null,
      fetchedAtMs: deps.now(),
      queriedChannelId: channelId,
      localEpoch: state.epoch,
      localState: state.state === "active" ? "active" : "poisoned",
      localChannelId: state.channel_id,
      selfInLocalRoster: state.members.some(isSelf),
      openGroupId: open?.group_id ?? null,
      pendingCommit,
      commits: fetched.body.commits.map((c) => ({
        ...c,
        committerIsSelf: isSelf(c.committer),
      })),
      currentEpoch: fetched.body.current_epoch,
    };
  } catch (err) {
    return await giveUp("read failed", err);
  }
}
