// Test-only support for the session-level `MlsCallSession` specs
// (`mlsCallSession.heal.test.ts`, `mlsCallSession.joinrace.test.ts`). Nothing
// in the app imports this file.
//
// The world drives the REAL join ladder, rotation seam and reconcile against a
// fake bridge, installer and media binding under fake timers: a Proxy bridge
// that throws on any method a path touches without a stub, an installer that
// posts entries and awaits between them (and can raise in that gap), and a
// binding that records every media-plane state change.
//
// Its roster is N members, not two. The 2-party world could not express the
// failure the 2026-09-07 legs found: the member that SERVES a membership
// change commits and installs first, so it is structurally never behind — only
// a NON-SERVING bystander races, and with two members the rejoiner and the
// only remote are the same device, which collapses the two roles into one.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import type { TestContext } from "node:test";

import type {
  E2EEBridge,
  EnvelopeDisposition,
  MlsCallCreated,
  MlsCallState,
  MlsClaimResult,
  MlsCommitInfo,
  MlsEnvelope,
  MlsFrameKey,
  MlsFrameKeys,
  MlsHttpResult,
  MlsJoinIntentPayload,
  MlsMemberDevice,
  MlsProcessOutcome,
  MlsSessionSink,
  MlsSubmitCommit,
  ResponseCreateMlsGroup,
  ResponseSubmitMlsCommit,
} from "@revolt/client";

import { classifyEnvelopeError } from "../client/mlsEnvelopeClassify.ts";
import { chipStateFrom } from "./chipInputs.ts";
import {
  type LocalPublicationEncryption,
  ENCRYPTION_TYPE_GCM,
} from "./localPublicationEncryption.ts";
import {
  type CallMode,
  type ChipLatch,
  type ChipState,
  type DecodeWitness,
  type LoudLatchMeta,
  DECODE_WITNESS_UNAVAILABLE,
  isTerminalLoud,
  summarizeDecodeWitness,
} from "./mlsCallModePolicy.ts";
import type {
  KeyInstaller,
  MediaEncryptionState,
  MlsCallSession,
  MlsMediaBinding,
  PublishGateReason,
} from "./mlsCallSession.ts";

// The session imports its siblings without extensions (Vite resolves them);
// Node's ESM loader does not, so a bare relative specifier gets `.ts`
// appended before the default resolution runs. Type-only imports (the
// `@revolt/client` alias) are stripped and never reach the loader.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a `.ts` sibling — let the default resolution report it.
      }
    }
    return nextResolve(specifier, context);
  },
});

const { MlsCallSession: Session, lagAction } =
  await import("./mlsCallSession.ts");

// ---- The cast ---------------------------------------------------------------

export const SELF: MlsMemberDevice = { user_id: "alice", device_id: "devA" };
export const PEER: MlsMemberDevice = { user_id: "bob", device_id: "devB" };
/** The third member — the BYSTANDER seat, which only a 3+ party call has. */
export const THIRD: MlsMemberDevice = { user_id: "carol", device_id: "devC" };
export const GROUP = "group-1";
/** The heal settle (`LOUD_HEAL_SETTLE_MS` = `RESECURE_ESCALATE_MS`). */
export const HEAL_SETTLE_MS = 10_000;
/** The join-race hold's bound (`JOIN_RACE_DEFER_MS` = `MEMBERSHIP_OBSERVED_MS`). */
export const JOIN_RACE_DEFER_MS = 20_000;
/** `LEAVE_GRACE_MS` — after this the grace entry is DELETED and the Remove runs. */
export const LEAVE_GRACE_MS = 10_000;
/**
 * `SUBMIT_TIMEOUT_MS`: `#stageAndSubmit` races `mlsSubmitCommit` against its
 * own timer for this long. A submit held past it (`holdSubmit`) rejects into
 * the timeout arm; releasing the hold afterwards changes nothing.
 */
export const SUBMIT_TIMEOUT_MS = 10_000;
/**
 * `LAG_DESYNC_THRESHOLD` (native `keys.rs`): a gap refetch that finds the
 * group this many epochs past the one it asked from makes `#gapRefetchInline`
 * schedule `#rejoinFresh`. `receiverLag` checks it against the session's own
 * `lagAction`.
 */
const LAG_DESYNC_THRESHOLD = 12;

export const identityOf = (m: MlsMemberDevice) => `${m.user_id}:${m.device_id}`;
export const SELF_ID = identityOf(SELF);
export const PEER_ID = identityOf(PEER);
export const THIRD_ID = identityOf(THIRD);

type BridgeStubs = { [K in keyof E2EEBridge]?: E2EEBridge[K] };
type FetchCommitsResult = Awaited<ReturnType<E2EEBridge["mlsFetchCommits"]>>;
type SubmitCommitResult = Awaited<ReturnType<E2EEBridge["mlsSubmitCommit"]>>;

/** A bridge that throws on any method the ladder touches without a stub. */
function fakeBridge(stubs: BridgeStubs): E2EEBridge {
  return new Proxy({} as E2EEBridge, {
    get(_target, prop) {
      if (typeof prop === "symbol") return undefined;
      const stub = stubs[prop as keyof E2EEBridge];
      if (!stub) throw new Error(`bridge.${String(prop)} is not stubbed`);
      return stub;
    },
  });
}

/**
 * Native's `MlsGroupNotFound`: the group is not in the local store. Exported
 * for `rejections`: `mls_call_process` answers it for any envelope of a group
 * a leave-clean wiped (`load_group`), such as the one `#rebaseInline`
 * synthesizes from a stale `Lost` (see `answerSubmitOnce`).
 */
export function groupNotFound(groupId: string): Error {
  return Object.assign(new Error("mls_group_not_found"), {
    type: "mls_group_not_found",
    group_id: groupId,
  });
}

/**
 * Native's `declined`: the user cancelled the BLOCKING downgrade dialog
 * (`e2ee_call_confirm_downgrade`). Crosses IPC as `{ type: "declined" }`;
 * raised here as an `Error` carrying it, as every native failure in this
 * world is. The session discriminates on `type` only.
 */
export function declined(): Error {
  return Object.assign(new Error("declined"), { type: "declined" });
}

/** Native's `Error::Mls { code }` (e2ee-core `mls_err`). */
function mlsCode(code: string): Error {
  return Object.assign(new Error(`mls: ${code}`), { type: "mls", code });
}

/**
 * Native's `MlsEpochGap`: `process_commit` got a commit past `last_epoch + 1`
 * and applies nothing (invariant 10).
 */
function epochGap(groupId: string, expected: number, got: number): Error {
  return Object.assign(new Error("mls_epoch_gap"), {
    type: "mls_epoch_gap",
    group_id: groupId,
    expected,
    got,
  });
}

/**
 * What rides every `"loud"` emission (`LoudLatchMeta`), plus the error a
 * media→control UPGRADE names as the one it supersedes. `"clear"` and
 * `"resecuring"` carry none.
 */
export type EncryptionStateMeta = LoudLatchMeta & { replaces?: unknown };

export interface EncryptionStateCall {
  state: MediaEncryptionState;
  error: unknown;
  /** Present exactly when the session passed one (never an `undefined` key). */
  meta?: EncryptionStateMeta;
}

/**
 * `state.tsx`'s `callEncryptionLatch`, as `#replay` rebuilds it: the latched
 * error plus whatever meta rode the emission that latched it. `origin` is
 * absent for a latch the session did not stamp (the two direct `state.tsx`
 * writers have no counterpart here, so in this world only a pre-meta emission
 * produces one).
 */
export interface ReplayedLatch extends Partial<EncryptionStateMeta> {
  error: unknown;
}

/**
 * The mutable call the session runs against: the MLS roster, the SFU set,
 * each participant's track SIDs, the group epoch, and the envelope outcomes
 * the fake `processEnvelope` answers with.
 */
export class World {
  roster: MlsMemberDevice[] = [SELF, PEER];
  sfu: string[] = [SELF_ID, PEER_ID];
  sids = new Map<string, string[]>([[PEER_ID, ["TR_old"]]]);
  epoch = 0;
  /** The keys the previous install answered with (`previous` of the next). */
  #lastKeys: MlsFrameKey[] | null = null;
  sink: MlsSessionSink | null = null;
  outcomes = new Map<string, MlsProcessOutcome>();
  /**
   * Native rejections, by envelope id, answered in place of an outcome. The
   * fake `processEnvelope` classifies them with the real
   * `classifyEnvelopeError`, as the bridge does, so a spec can only script a
   * disposition that some native error produces. Kept after use: native
   * rejects the same envelope the same way every time.
   */
  rejections = new Map<string, unknown>();
  /**
   * Groups native holds EVICTED. A processed commit that removed this device
   * (`removed_self`) is merged all the same: OpenMLS's `merge_staged_commit`
   * sets the group `Inactive`, and the row stays `active`. Every stage on it
   * then fails `is_operational` with `UseAfterEviction`, which native reports
   * as `Error::Mls` (`add-members` from `mls_call_admit`, `remove-members`
   * from `mls_call_remove`). Only the leave-clean ends it, by wiping the
   * group.
   */
  evicted = new Set<string>();
  states: EncryptionStateCall[] = [];
  /** Every `onMediaHold` edge, in order — the chip's amber while a hold is open. */
  holds: boolean[] = [];
  /**
   * The media-plane state changes and the amber edges INTERLEAVED, in the
   * order the session emitted them. `state.tsx` writes `callEncryptionLatch`
   * (the one composite signal; `callEncryptionError` is a memo over it) and
   * `callMediaHold` in separate, unbatched Solid setters, so the order
   * matters: between dropping the amber and reporting loud the chip has
   * neither and computes a green, which an effect or a live-leg sampler can
   * read even though no paint happens between them.
   */
  events: string[] = [];
  /** The same stream WITH payloads, for `chip()`. */
  journal: (
    | {
        kind: "state";
        state: MediaEncryptionState;
        error: unknown;
        meta?: EncryptionStateMeta;
      }
    | { kind: "hold"; active: boolean }
  )[] = [];
  modes: string[] = [];
  /**
   * `state.tsx`'s publish gate — a REASON SET, not a boolean: publishing flows
   * only while it is EMPTY, and it is SEEDED with the `negotiating` reason
   * `connect()` adds before `room.connect`. Without that seed a spec starts
   * from a state the app never has (publishing open through the negotiation
   * window) and every pause/release edge afterwards reads one step off.
   *
   * The binding used to leave `pausePublishing` unimplemented and stub
   * `resumePublishing` as a no-op, so the gate was invisible to every
   * session-level spec — which is how the ME-10 banner's central promise
   * ("your audio and video stay paused") went six review rounds without one
   * assertion behind it.
   */
  gate = new Set<PublishGateReason>(["negotiating"]);
  /** Every gate edge in order (`+reason` / `-reason`) — kept out of `events`. */
  gateLog: string[] = [];
  bridgeCalls: string[] = [];
  /** Injected by the fake installer between its two awaits, once. */
  midInstallError: Error | null = null;
  /**
   * What the next `applyLocalKey` throws INSTEAD of installing, once. Set by
   * `failLocalKeyOnce`; the installer nulls it as it takes it, so a spec
   * asserts `null` afterwards to know the throw fired (as the heal spec does
   * for `midInstallError`).
   */
  localKeyFailure: Error | null = null;
  /** The Room's `Connected` state as the binding reports it. */
  connected = true;
  /**
   * Local publications as the SFU has them on record — the LOCAL-DECLARATION
   * seam (`#assertLocalDeclarations`). Without it that whole path is vacuous,
   * so no spec could arm a `control` escalation, which is exactly how a
   * control-token defect reached a fourth review unnoticed.
   */
  localPublications: LocalPublicationEncryption[] = [];
  /** Track SIDs the session asked to be republished, in order. */
  republished: string[][] = [];
  /**
   * When set, the fake republish awaits this before flipping to GCM — the
   * window in which a `control` escalation is PENDING, which is where the
   * escalation's cancel token has to hold.
   */
  republishGate: Promise<void> | null = null;
  /** Open that window; the returned function closes it. */
  holdRepublish(): () => void {
    let release!: () => void;
    this.republishGate = new Promise<void>((r) => (release = r));
    return () => {
      this.republishGate = null;
      release();
    };
  }
  /**
   * When set, the `mlsJoinIntent` stub awaits this AFTER `record` has counted
   * the call — the join ladder suspended inside its intent broadcast, which is
   * where a Welcome can land that the ladder never looks for.
   */
  joinIntentGate: Promise<void> | null = null;
  /** The same window for the `callJoinIntent` stub (the native signing call). */
  callJoinIntentGate: Promise<void> | null = null;
  /**
   * The same window for the `mlsReplenish` stub: `start()` suspended in its
   * KeyPackage enrolment, BEFORE the first establish — `#establishGeneration`
   * is still 0 and `callCreate` has not run.
   */
  replenishGate: Promise<void> | null = null;
  /**
   * The same window for the `reconcileCallRoster` stub: a joiner suspended in
   * `#joinPath`'s pre-join roster pin, BEFORE its first intent.
   */
  reconcileRosterGate: Promise<void> | null = null;
  /**
   * One scripted rejection, taken by the first `callJoinIntent` to get PAST
   * its hold (or to enter, when none is open). Boxed so that an `undefined`
   * error still counts as set.
   */
  callJoinIntentFailure: { error: unknown } | null = null;
  /**
   * One scripted DS answer, taken by the first `mlsJoinIntent` to get PAST its
   * hold (or to enter, when none is open) in place of `ok`.
   */
  joinIntentAnswer: MlsHttpResult<void> | null = null;
  /**
   * The same window for the `mlsSubmitCommit` stub: `#stageAndSubmit`
   * suspended on the DS round trip, holding the per-group lock, with its own
   * `SUBMIT_TIMEOUT_MS` race running.
   */
  submitGate: Promise<void> | null = null;
  /**
   * One scripted rejection, taken by the first `mlsSubmitCommit` to get PAST
   * its hold (or to enter, when none is open). Boxed like
   * `callJoinIntentFailure`.
   */
  submitFailure: { error: unknown } | null = null;
  /**
   * One scripted DS answer, taken by the first `mlsSubmitCommit` to get PAST
   * its hold (or to enter, when none is open) in place of `Won`.
   */
  submitAnswer: SubmitCommitResult | null = null;
  /**
   * One scripted DS answer to the gap refetch (`mlsFetchCommits`), for the
   * group and from-epoch it was written for; `receiverLag` sets it. With
   * none scripted the stub fails the spec, as the unstubbed method did.
   */
  fetchCommitsAnswer: {
    groupId: string;
    fromEpoch: number;
    result: FetchCommitsResult;
  } | null = null;
  /**
   * The same window for the `processEnvelope` stub: the drain suspended in
   * native processing, HOLDING the per-group lock. A `#stageAndSubmit` that
   * starts meanwhile has captured `#groupId` and waits on that lock, so a
   * group action the held envelope schedules runs only after the submit is
   * in flight: the order a drain-scheduled `#rejoinFresh` (drain
   * `rejoin_fresh`, `escalate_desync`, park overflow, receiver lag) needs to
   * replace a group under a submit. `receiverLag` is the one this world
   * drives. Removed-self and successor cannot: native refuses to stage on an
   * evicted group (`add-members`) or a poisoned row (`MlsPoisonedEpoch`).
   */
  processGate: Promise<void> | null = null;
  /**
   * The same window for the `callLeaveCleanup` stub: the native local wipe,
   * which crosses IPC with NO deadline of its own. `#rejoinFresh` and
   * `#onRemovedSelf` await it inside their group action BEFORE the establish
   * that follows starts, so while it is held `#establishInFlight` is false
   * and only `#groupActionPending` marks the transition as owned.
   *
   * Both run the leave BEFORE their own `#toResecuring`, so the hold sits
   * inside a re-securing backstop window only when an EARLIER `#toResecuring`
   * armed it: the submit catch's hand-off (`#toResecuring`, then
   * `#scheduleReestablish` → `#rejoinFresh`). `#onRemovedSelf`'s leave runs
   * while the session is still `active`, with no backstop armed.
   */
  leaveCleanupGate: Promise<void> | null = null;
  /**
   * One scripted leave-clean rejection, for ONE group: taken by the first
   * `callLeaveCleanup` of `groupId` to get PAST its hold (or to enter, when
   * none is open). A leave-clean of any other group neither takes it nor
   * fails. Set by `failLeaveCleanupOnce`.
   */
  leaveCleanupFailure: { groupId: string; error: unknown } | null = null;
  /** Set by `createNextGroupOnce`: the next establish mints and creates it. */
  nextGroup: string | null = null;
  /**
   * What the next `callConfirmDowngrade` does INSTEAD of resolving (the
   * user pressed Ok): `declined` rejects with native's `{ type: "declined" }`
   * (the user cancelled); `error` rejects with anything else (the dialog
   * could not be shown — no window, a dead plugin). Taken by the first call;
   * later calls resolve. Set by `declineDowngradeOnce` /
   * `failConfirmDowngradeOnce`.
   */
  confirmDowngradeOutcome:
    | { kind: "declined" }
    | { kind: "error"; error: unknown }
    | null = null;
  /**
   * Every `callConfirmDowngrade` — the native BLOCKING dialog — with the
   * arguments the session passed, in order. A spec asserting "exactly one
   * dialog" / "no dialog" reads `confirmDowngrades()`.
   */
  confirmDowngradeCalls: {
    groupId: string;
    sfuParticipants: string[];
    displayNames: Record<string, string>;
  }[] = [];
  /** The group of every `callClearDowngrade` (the T6 re-upgrade), in order. */
  clearDowngradeCalls: string[] = [];
  /**
   * The commit native holds staged, per group, as `callAdmit` staged it.
   * `callCommitLost` drops it, and `callLeaveCleanup` marks it `"left"`,
   * because the wipe takes the group (and its pending commit) with it. A
   * leave-clean that FAILS (`failLeaveCleanupOnce`) leaves it staged.
   * `callCommitWon` answers from this as `mls_call_commit_won` does, and
   * deletes it when it merges.
   */
  stagedCommits = new Map<string, MlsSubmitCommit | "left">();
  /** The group of every `callCommitLost`, in order. */
  commitLosts: string[] = [];
  /** The group of every `callLeaveCleanup` that WIPED, in order. */
  leaveCleanups: string[] = [];
  /**
   * The group of every `callLeaveCleanup` that REJECTED, in order
   * (`failLeaveCleanupOnce`). Such a call never reaches `leaveCleanups`,
   * `stagedCommits` or `evicted`: native wiped nothing.
   */
  failedLeaveCleanups: string[] = [];
  /**
   * Suspend every `mlsJoinIntent` until the returned function runs. Each call
   * is recorded in `bridgeCalls` BEFORE it waits, so `joinIntents()` already
   * counts a suspended broadcast. Every call made while held waits on the same
   * gate; one release resumes them all, and later calls run straight through.
   */
  holdJoinIntent(): () => void {
    return this.#openGate("joinIntentGate");
  }
  /** `holdJoinIntent`, for the `callJoinIntent` stub. */
  holdCallJoinIntent(): () => void {
    return this.#openGate("callJoinIntentGate");
  }
  /**
   * `holdJoinIntent`, for the `mlsReplenish` stub. Its answer stays `null`
   * (above the low-water mark), so the hold delays the enrolment and publishes
   * nothing when released.
   */
  holdReplenish(): () => void {
    return this.#openGate("replenishGate");
  }
  /**
   * `holdJoinIntent`, for the `reconcileCallRoster` stub. EVERY caller waits,
   * not only the pre-join pin: the admit and rejoin-serve reconciles and the
   * `fetch_identity` re-drive go through the same stub. The pin reaches it only
   * when the SFU set holds someone other than SELF (`#reconcileRoster` returns
   * early on an empty set).
   */
  holdReconcileRoster(): () => void {
    return this.#openGate("reconcileRosterGate");
  }
  /**
   * `holdJoinIntent`, for the `mlsSubmitCommit` stub. The submit is counted
   * (`submits()`) before it waits. Advancing the clock `SUBMIT_TIMEOUT_MS`
   * while held fires the session's own race: the timeout arm. Releasing it
   * after that settles a promise nothing awaits any more (and spends a
   * scripted `failSubmitOnce` on it).
   */
  holdSubmit(): () => void {
    return this.#openGate("submitGate");
  }
  /**
   * `holdJoinIntent`, for the `processEnvelope` stub: every envelope the
   * drain processes while held waits, holding the per-group lock. Envelopes
   * are counted in `bridgeCalls` before they wait.
   */
  holdProcessEnvelope(): () => void {
    return this.#openGate("processGate");
  }
  /**
   * `holdJoinIntent`, for the `callLeaveCleanup` stub. EVERY leave-clean
   * waits, not only the group actions': `#startupWipe`'s direct call, the
   * orphan leave-cleans inside `#establish` and `dispose`'s un-awaited
   * teardown go through the same stub. A held call is counted in
   * `bridgeCalls` before it waits, but reaches `leaveCleanups` (and marks
   * its group's staged commit `"left"`) only once released — the wipe has
   * not happened while native is still running it. A `failLeaveCleanupOnce`
   * for its group rejects it only once released, too.
   */
  holdLeaveCleanup(): () => void {
    return this.#openGate("leaveCleanupGate");
  }
  #openGate(
    field:
      | "joinIntentGate"
      | "callJoinIntentGate"
      | "replenishGate"
      | "reconcileRosterGate"
      | "submitGate"
      | "processGate"
      | "leaveCleanupGate",
  ): () => void {
    assert.equal(this[field], null, `${field} is already held`);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    this[field] = gate;
    return () => {
      // Idempotent, and never clears a LATER hold's gate.
      if (this[field] === gate) this[field] = null;
      release();
    };
  }
  /**
   * The next `callJoinIntent` rejects with `error` — AFTER any open hold is
   * released, so "hold, deliver the Welcome, fail once, release" rejects a
   * call whose Welcome was already adopted. Later calls answer normally.
   */
  failCallJoinIntentOnce(error: unknown): void {
    assert.equal(
      this.callJoinIntentFailure,
      null,
      "a callJoinIntent failure is already scripted",
    );
    this.callJoinIntentFailure = { error };
  }
  /**
   * The next `mlsJoinIntent` answers `result` instead of `ok` — AFTER any open
   * hold is released, so "hold, deliver the Welcome, answer once, release"
   * hands a `not_found` / `call_full` / `feature_disabled` / other non-ok to a
   * ladder whose Welcome was already adopted. The call is still counted by
   * `record` first. Later calls answer `ok`.
   */
  answerJoinIntentOnce(result: MlsHttpResult<void>): void {
    assert.equal(
      this.joinIntentAnswer,
      null,
      "an mlsJoinIntent answer is already scripted",
    );
    this.joinIntentAnswer = result;
  }
  /** Every `mlsJoinIntent` recorded so far, suspended ones included. */
  joinIntents(): number {
    return this.bridgeCalls.filter((n) => n === "mlsJoinIntent").length;
  }
  /**
   * The next `mlsSubmitCommit` rejects with `error`, AFTER any open hold is
   * released. A rejected submit lands in the SAME catch as the timeout
   * (`#withTimeout` races the request itself), never in the post-submit
   * one. The real bridge rejects there on any non-2xx other than a 409 or a
   * 400 `FeatureDisabled` (`#apiMls`), on a 429 past its bound, on the 45 s
   * transport deadline and on the call's abort. Later calls answer `Won`.
   */
  failSubmitOnce(error: unknown): void {
    assert.equal(
      this.submitFailure,
      null,
      "an mlsSubmitCommit failure is already scripted",
    );
    assert.equal(
      this.submitAnswer,
      null,
      "an mlsSubmitCommit answer is already scripted",
    );
    this.submitFailure = { error };
  }
  /**
   * The next `mlsSubmitCommit` answers `result` instead of `Won`, AFTER any
   * open hold is released. The call is still counted by `record` first.
   * Later calls answer `Won`. Scripting it while an answer or a
   * `failSubmitOnce` is still unspent fails the spec: either would decide
   * the same call.
   *
   * What the real route can return (`mlsSubmitCommit` is `#apiMls` with
   * `arbitrated` only):
   *   - `ok` (2xx): an honest DS sends `{ result: "Won" }`;
   *   - `conflict` (409): an honest DS sends `{ result: "Lost", winning }`;
   *   - `feature_disabled` (400 `FeatureDisabled`): the plaintext arm;
   *   - a throw, for anything else: `failSubmitOnce`.
   * `mfa_required`, `not_found` and `call_full` need route options this one
   * never passes, so the bridge cannot return them, and scripting one fails
   * the spec. The BODY is the DS's to choose, and the bridge passes it
   * through unchecked, so `conflict` + `Won` (`classifyArbitration`:
   * `failed`) and `ok` + `Lost` (`lost`) stay scriptable as a hostile DS.
   *
   * An honest `Lost` names the commit the DS stored at the SUBMITTED epoch,
   * not at its current one: `insert_mls_commit` answers any
   * `commit.epoch <= current_epoch` with the row `{group_id}:{commit.epoch}`.
   * After `receiverLag` an admit staged on GROUP submits `epoch + 1`, and
   * the DS holds `receiverLag`'s own first commit there: epoch 1 from a
   * fresh `bringUpCreator`, as below.
   *
   *   world.answerSubmitOnce({
   *     kind: "conflict",
   *     body: {
   *       result: "Lost",
   *       winning: { group_id: GROUP, epoch: 1, committer: PEER,
   *                  commit: "commit-1", added: [], removed: [] },
   *     },
   *   });
   *
   * Whenever the session's `lost` arm runs, it calls `callCommitLost` on the
   * LIVE `#groupId` (not the submitted group), feeds `winning` to
   * `processEnvelope` (id `mls-synth:<group>:<epoch>`) and gap-refetches
   * the LIVE group from `winning.epoch + 1`. Neither of those two has a
   * default answer here, and each stub's assertion is a rejection the
   * post-submit catch may swallow, so a spec in which the arm can run
   * scripts both as native and the DS would answer. For a submit whose
   * GROUP was leave-cleaned and replaced by the `createNextGroupOnce` group
   * (live at epoch 0):
   *
   *   world.rejections.set(`mls-synth:${GROUP}:1`, groupNotFound(GROUP));
   *   world.fetchCommitsAnswer = {
   *     groupId: "group-2",
   *     fromEpoch: 2,
   *     result: { kind: "ok", body: { commits: [], current_epoch: 0 } },
   *   };
   */
  answerSubmitOnce(result: SubmitCommitResult): void {
    assert.equal(
      this.submitAnswer,
      null,
      "an mlsSubmitCommit answer is already scripted",
    );
    assert.equal(
      this.submitFailure,
      null,
      "an mlsSubmitCommit failure is already scripted",
    );
    assert.ok(
      result.kind === "ok" ||
        result.kind === "conflict" ||
        result.kind === "feature_disabled",
      `mlsSubmitCommit can never answer ${result.kind}`,
    );
    this.submitAnswer = result;
  }
  /** Every `mlsSubmitCommit` recorded so far, suspended ones included. */
  submits(): number {
    return this.bridgeCalls.filter((n) => n === "mlsSubmitCommit").length;
  }
  /**
   * The next `callConfirmDowngrade` rejects as native does when the user
   * CANCELS the blocking dialog (`declined()`), instead of resolving. The
   * call is still recorded first. Later calls resolve. Scripting it while
   * an outcome is unspent fails the spec: both would decide the same call.
   */
  declineDowngradeOnce(): void {
    assert.equal(
      this.confirmDowngradeOutcome,
      null,
      "a callConfirmDowngrade outcome is already scripted",
    );
    this.confirmDowngradeOutcome = { kind: "declined" };
  }
  /**
   * The next `callConfirmDowngrade` rejects with `error` — anything BUT a
   * decline: the dialog never showed. The session must not read it as the
   * user's answer. The call is still recorded first. Later calls resolve.
   */
  failConfirmDowngradeOnce(error: unknown): void {
    assert.equal(
      this.confirmDowngradeOutcome,
      null,
      "a callConfirmDowngrade outcome is already scripted",
    );
    this.confirmDowngradeOutcome = { kind: "error", error };
  }
  /**
   * The next `applyLocalKey` throws `error` before installing anything; later
   * calls install. Scripting it while one is still unspent fails the spec:
   * both would decide the same call.
   *
   * The one control-origin site this world could not otherwise reach: the
   * real installer throws `MissingLocalFrameKeyError` from `applyLocalKey`
   * when the egress carries no entry for this device (`mlsCallKeys.ts`), and
   * the session routes that class — and ONLY that class — past the media
   * debounce to `#onRotationError` → `#dropModeToNegotiating` +
   * `#latchLoud(error, "control")`. `applyLocalKey` runs on the Add-grace
   * path alone (`#scheduleGraceLocal`; the immediate path installs the local
   * key inside `applyKeys`), so the driver is a plain Add commit on a device
   * that already holds a key, then the grace:
   *
   *   world.failLocalKeyOnce(new MissingLocalFrameKeyError(GROUP, 1));
   *   await world.commit(1);        // Add-grace: remotes now, local deferred
   *   await advance(t, 2_000);      // ADD_GRACE_MS — the fenced timer fires
   *
   * Any other class handed here reaches `#onMediaError` (the media debounce)
   * instead, which is the session's routing to assert, not a harness fact.
   */
  failLocalKeyOnce(error: Error): void {
    assert.equal(
      this.localKeyFailure,
      null,
      "an applyLocalKey failure is already scripted",
    );
    this.localKeyFailure = error;
  }
  /** Every `callConfirmDowngrade` (native dialog) recorded so far. */
  confirmDowngrades(): number {
    return this.confirmDowngradeCalls.length;
  }
  /** Every `callClearDowngrade` recorded so far. */
  clearDowngrades(): number {
    return this.clearDowngradeCalls.length;
  }
  /**
   * The next `callLeaveCleanup` of `groupId` rejects with `error`, AFTER any
   * open hold is released. The call is still counted by `record` first. It
   * wipes nothing: `groupId` stays out of `leaveCleanups` (it is pushed to
   * `failedLeaveCleanups` instead), its staged commit is NOT marked
   * `"left"`, and an eviction is NOT cleared. A leave-clean of any other
   * group runs normally and leaves this one scripted; later calls for
   * `groupId` wipe normally. Scripting a second one before the first is
   * spent fails the spec.
   *
   * The default is the error native returns with its rows intact.
   * `mls_call_leave_cleanup` runs the whole wipe (the OpenMLS delete, the
   * group-scope DELETE, the `mls_groups` and `mls_join_intents` rows) in
   * ONE transaction, and a failed group-scope DELETE is `mls_err("wipe")`,
   * returned before `tx.commit()`: the transaction rolls back, so the
   * group, its pending commit and its eviction all survive. (A SQLite
   * failure is `Error::Storage { code }` and rolls back the same way.)
   *
   * The session sees none of this: `#safeLeave` logs
   * `[mls] leave-cleanup failed` and carries on, so the group a
   * `#rejoinFresh` or `#onRemovedSelf` abandoned is still MERGEABLE, and a
   * `callCommitWon` for its staged commit takes the merge path.
   */
  failLeaveCleanupOnce(
    groupId: string,
    error: unknown = mlsCode("wipe"),
  ): void {
    assert.equal(
      this.leaveCleanupFailure,
      null,
      "a callLeaveCleanup failure is already scripted",
    );
    this.leaveCleanupFailure = { groupId, error };
  }
  /**
   * The next establish mints `groupId` (`callCreate`) and the DS answers
   * `Created` for it (`mlsCreateGroup`), whatever the world's role: the DS
   * held no open group for the channel any more. The group then differs from
   * `GROUP`, which is what `#submitSuperseded` compares. The group id is
   * consumed by the `mlsCreateGroup` that answers for it.
   *
   * The world still models GROUP only: `callState`, `frameKeys` and the
   * envelope drivers keep answering for it.
   */
  createNextGroupOnce(groupId: string): void {
    assert.equal(this.nextGroup, null, "a next group is already scripted");
    assert.notEqual(groupId, GROUP, "the next group must not be GROUP");
    this.nextGroup = groupId;
  }
  /**
   * A peer's join intent fans out to this device (the `MlsJoinRequested`
   * event, as the bridge hands it to the sink). A joined session that is
   * `active` reconciles the requester's listing and schedules the admit on
   * its leaf stagger: `leafStaggerDelayMs(leaf)`, 0 ms for SELF at roster
   * index 0, so `advance(t, 1)` runs it. The admit then claims a KeyPackage,
   * stages the Add (`callAdmit`) and submits it (`mlsSubmitCommit`).
   *
   * `member` must NOT already be in `roster`, or the admit stops as
   * `already_member`. `rejoin: true` routes to the rejoin serve instead,
   * which acts only on a `member` that IS in `roster`: a Remove of its leaf,
   * which the default `callRemove` answers `mls_group_not_found` (a benign
   * no-op).
   */
  async joinRequest(
    member: MlsMemberDevice,
    {
      rejoin = false,
      groupId = GROUP,
    }: { rejoin?: boolean; groupId?: string } = {},
  ): Promise<void> {
    assert.ok(this.sink, "the session registered no sink");
    this.sink({
      kind: "join_request",
      request: {
        group_id: groupId,
        channel_id: this.channelId,
        user_id: member.user_id,
        device_id: member.device_id,
        key_package_ref: `kp-ref-${member.device_id}`,
        signature: `sig-${member.device_id}`,
      },
      rejoin,
    });
    await flush();
  }
  /** Declare one local publication to the SFU as NONE (the unmute shape). */
  declarePlaintext(trackSid = "TR_local"): void {
    this.localPublications = [{ trackSid, encryption: 0 }];
  }
  /**
   * Whether the binding implements `onMediaHold` — the chip's amber. A
   * binding without it must never get a deferred verdict: the amber is the
   * only thing separating a deferral from an invisible green.
   */
  holdsSupported = true;

  /**
   * Gate (d) — the senders whose frames the worker is currently DROPPING at an
   * index this device silenced. Empty by default: an ordinary healthy call has
   * nothing being discarded, and a spec that wants gate (d) to bite says so
   * with `dropFrames()`.
   *
   * The opposite default to `observedEncrypted`, which is modelled all-true
   * because it is the SFU's DECLARATION and structurally cannot witness this
   * class. The decode witness is a LOCAL measurement of frames that actually
   * arrived, so for a healthy call it genuinely holds.
   */
  #dropping: string[] = [];
  /** Whether the worker's heartbeat is arriving at all (fail-closed when not). */
  witnessAvailable = true;

  /** The worker is dropping these senders' frames at a silenced index. */
  dropFrames(...identities: string[]): void {
    for (const identity of identities) {
      // The witness is built from the SFU set, so naming somebody who is not
      // in it would silently model NO drops — a spec that reads green for the
      // wrong reason.
      assert.ok(
        this.sfu.includes(identity),
        `dropFrames(${identity}): not in the SFU set, so it owes no witness`,
      );
    }
    this.#dropping = identities;
  }

  /** The worker's heartbeat stopped — the patch is missing, or the worker died. */
  loseWitness(): void {
    this.witnessAvailable = false;
  }

  /**
   * Gate (d)'s input, built by handing a modelled worker window to the REAL
   * `summarizeDecodeWitness`.
   *
   * 🔴 It used to hand-build the `DecodeWitness` result instead, which meant
   * the reducer every one of these specs depends on was never exercised by
   * them — a second implementation of the thing under test, agreeing with
   * itself. Same shape as the chip assembly below.
   */
  decodeWitness(): DecodeWitness {
    if (!this.witnessAvailable) return DECODE_WITNESS_UNAVAILABLE;
    const remotes = this.sfu.filter((id) => id !== SELF_ID);
    return summarizeDecodeWitness(
      remotes.map((identity) => {
        const dropped = this.#dropping.includes(identity) ? 10 : 0;
        return { identity, indexes: [{ keyIndex: 1, seen: 10, dropped }] };
      }),
    );
  }

  /**
   * Roster members this device has NOT verified (gate c). Empty by default:
   * the ladders these specs drive are about the media plane, and an
   * unverified member is a separate axis. It exists so the axis is
   * EXPRESSIBLE — the harness used to hardcode every member verified, so no
   * spec could state a gate-(c) hold even if it wanted one.
   */
  unverified = new Set<string>();

  /** Mark roster members unverified for gate (c). */
  markUnverified(...identities: string[]): void {
    for (const identity of identities) this.unverified.add(identity);
  }

  /**
   * Participants LiveKit has reported no encryption status for (gate b).
   *
   * 🔴 Empty by default, and `observedEncryption` otherwise answers TRUE for
   * everyone, because that is the SFU's DECLARATION and a peer whose frames
   * this device cannot decrypt still reports encrypted — which is exactly why
   * gate (b) cannot see the media plane and gate (d) exists.
   *
   * It is an axis at all because routing the harness through the real
   * assembly was only half the fix: the assembly now includes SELF in
   * `publishingIdentities` as production does, but with every identity
   * hardcoded observed-true, "our own publication is not observed encrypted"
   * — the desktop 0.57.0 defect — was still inexpressible here.
   */
  unobserved = new Set<string>();

  /** LiveKit has vouched for nothing about these identities. */
  markUnobserved(...identities: string[]): void {
    for (const identity of identities) this.unobserved.add(identity);
  }
  session!: MlsCallSession;

  readonly role: "creator" | "joiner";
  readonly channelId: string;

  constructor(role: "creator" | "joiner", channelId: string) {
    this.role = role;
    this.channelId = channelId;
  }

  /** Seat a third member: the bystander role a 2-party world cannot express. */
  withThird(sids: string[] = ["TR_c_old"]): this {
    this.roster = [...this.roster, THIRD];
    this.sfu = [...this.sfu, THIRD_ID];
    this.sids.set(THIRD_ID, sids);
    return this;
  }

  frameKeys(): MlsFrameKeys {
    const keys = this.roster.map((m) => ({
      livekit_identity: identityOf(m),
      user_id: m.user_id,
      device_id: m.device_id,
      key_index: this.epoch % 16,
      epoch: this.epoch,
      frame_key_b64: `key-${this.epoch}`,
    }));
    const previous = this.#lastKeys ?? [];
    this.#lastKeys = keys;
    return { group_id: GROUP, epoch: this.epoch, keys, previous };
  }

  callState(): MlsCallState {
    return {
      group_id: GROUP,
      channel_id: this.channelId,
      epoch: this.epoch,
      state: "active",
      members: this.roster.map((m) => ({ ...m, user_verified: true })),
    };
  }

  /** Hand the session one inbound envelope with a scripted native outcome. */
  #deliver(
    contentType: string,
    kind: MlsProcessOutcome["kind"],
    epoch: number,
    removed: MlsMemberDevice[],
    {
      removedSelf = false,
      groupId = GROUP,
    }: { removedSelf?: boolean; groupId?: string } = {},
  ): void {
    // The default id is unchanged. Another group's envelope and a removed-self
    // one get their own, so the session's `#seen` dedup never skips them
    // against (and `outcomes` never overwrites) a same-epoch GROUP envelope.
    let id = `env-${kind}-${epoch}`;
    if (groupId !== GROUP) id += `@${groupId}`;
    if (removedSelf) id += "-removed-self";
    const envelope: MlsEnvelope = {
      id,
      content_type: contentType,
      group_id: groupId,
      epoch,
      ciphertext: "",
    };
    this.outcomes.set(envelope.id, {
      group_id: groupId,
      kind,
      epoch,
      removed_self: removedSelf,
      removed,
    });
    // `epoch` is GROUP's; another group's envelope does not move it.
    if (groupId === GROUP) this.epoch = epoch;
    assert.ok(this.sink, "the session registered no sink");
    this.sink({
      kind: "envelope",
      envelope,
      recipientDeviceId: SELF.device_id,
    });
  }

  /**
   * The admitter's Welcome lands (the joiner's ladder resolves on it). Safe at
   * any moment, including while the ladder is suspended in a held
   * `callJoinIntent` / `mlsJoinIntent`: the drain does not wait on the ladder,
   * so it reaches the session as a Welcome arriving mid-broadcast would. A
   * `groupId` other than `GROUP` is ANOTHER group's Welcome.
   */
  async welcome(epoch: number, groupId: string = GROUP): Promise<void> {
    this.#deliver("mls_welcome", "welcome_joined", epoch, [], { groupId });
    await flush();
  }

  /**
   * A commit for `epoch` that removed THIS device lands: its outcome carries
   * `removed_self: true`, so the drain takes `ack_removed_self` and schedules
   * `#onRemovedSelf` as a group action. That action runs on a `setTimeout(0)`
   * under the fake clock, so `advance(t, 1)` before asserting on it; and the
   * session drops it while another group action (an establish, a join
   * ladder) is still in flight. `sfu` and `roster` stay as the spec seated
   * them — `#onRemovedSelf` branches on whether SELF is still in the SFU.
   *
   * Processing it EVICTS GROUP (`evicted`) until that action's leave-clean:
   * an admit built on GROUP in between (one waiting on the lock behind a
   * held `processEnvelope`) is refused `add-members`, and `#stageAndSubmit`
   * goes loud without submitting. So this can never leave a submit in
   * flight under a group swap; `receiverLag` can.
   */
  async removedSelf(epoch: number): Promise<void> {
    this.#deliver("mls_commit", "commit_applied", epoch, [SELF], {
      removedSelf: true,
    });
    await flush();
  }

  /**
   * A GROUP commit lands `LAG_DESYNC_THRESHOLD` epochs ahead, and the gap
   * refetch finds GROUP that far past us: the drain's receiver-lag desync,
   * the smallest faithful way to make the DRAIN schedule `#rejoinFresh` on a
   * group that is still buildable.
   *   1. Native `process_commit` rejects the commit with `MlsEpochGap`
   *      (`envelope.epoch > last_epoch + 1`) and applies nothing, so GROUP
   *      stays operational and `epoch` does not move.
   *   2. `classifyEnvelopeError` makes that `park`, and `drainAction` a
   *      `gap_refetch` from `epoch + 1` (the park bound is not reached).
   *   3. `#gapRefetchInline` fetches while still HOLDING the lock. The DS
   *      answers every commit from `epoch + 1` up to the envelope's, which is
   *      its current epoch; `lagAction` reads that as `desync` and schedules
   *      `#rejoinFresh` (`rejoin_fresh:receiver_lag`) as a 0 ms group action.
   *
   * The envelope is neither acked nor re-queued. The rejoin leave-cleans
   * GROUP only when it RUNS, so `advance(t, 1)` before asserting on it. An
   * admit built on GROUP in between (one waiting on the lock behind a held
   * `processEnvelope`) is accepted, and its submit is in flight when the
   * group is replaced.
   *
   * That DS is `LAG_DESYNC_THRESHOLD` epochs past the admit's epoch, so an
   * honest one answers its submit `Lost`. The stub's default `Won` after
   * this driver is a DS whose two answers disagree; `answerSubmitOnce`
   * carries the honest `Lost` and the answers its arm needs next.
   */
  async receiverLag(): Promise<void> {
    const expected = this.epoch + 1;
    const current = expected + LAG_DESYNC_THRESHOLD;
    // The session's own threshold: one epoch less must not desync.
    assert.equal(lagAction(current, expected).do, "desync");
    assert.notEqual(lagAction(current - 1, expected).do, "desync");
    assert.equal(
      this.fetchCommitsAnswer,
      null,
      "a gap refetch answer is already scripted",
    );
    const envelope: MlsEnvelope = {
      id: `env-lag-${current}`,
      content_type: "mls_commit",
      group_id: GROUP,
      epoch: current,
      ciphertext: "",
    };
    this.rejections.set(envelope.id, epochGap(GROUP, expected, current));
    const commits: MlsCommitInfo[] = [];
    for (let epoch = expected; epoch <= current; epoch++) {
      commits.push({
        group_id: GROUP,
        epoch,
        committer: PEER,
        commit: `commit-${epoch}`,
        added: [],
        removed: [],
      });
    }
    this.fetchCommitsAnswer = {
      groupId: GROUP,
      fromEpoch: expected,
      result: { kind: "ok", body: { commits, current_epoch: current } },
    };
    assert.ok(this.sink, "the session registered no sink");
    this.sink({
      kind: "envelope",
      envelope,
      recipientDeviceId: SELF.device_id,
    });
    await flush();
  }

  /**
   * A commit for `epoch` lands and native fires keys-changed for it: the
   * drain records the inbound memo, then the rotation seam installs.
   */
  async commit(epoch: number, removed: MlsMemberDevice[] = []): Promise<void> {
    this.#deliver("mls_commit", "commit_applied", epoch, removed);
    await flush();
    await this.session.onLocalKeysChanged(GROUP, epoch);
    await flush();
  }

  /**
   * The chip the USER reads — `state.tsx`'s latch protocol replayed over the
   * media-plane callbacks, then the real `chipState`.
   *
   * Every other accessor here reports what the session SAID. Five of the six
   * defects six review rounds found lived in the gap between that and what the
   * chip shows, and none of them was visible to a spec asserting on the
   * callback stream: `state.tsx` latches first-wins (a `loud` under an
   * existing latch is a no-op unless its meta names the latched error as the
   * one it `replaces`) and clears on object IDENTITY, so a `clear` of a
   * superseded error that was never replaced wipes the signal outright.
   *
   * `observedEncryption` is modelled as ALL TRUE on purpose. It is the SFU's
   * declaration, not a decrypt: a peer whose frames this device cannot decrypt
   * still reports encrypted, which is exactly why gate (b) cannot see any of
   * this and why the media plane has to.
   *
   * 🔴 It goes through the REAL `chipStateFrom`. It used to hand-build the
   * `ChipInputs` literal, and that copy had drifted: it excluded SELF from
   * `publishingIdentities` entirely, where production includes the local
   * participant and excludes only our OWN screen leg — so no spec here could
   * express "our own publication is not observed encrypted", and every gate-(b)
   * assertion in these suites was evidence about a second implementation. The
   * whole point of the `chipInputs` extraction was that there be exactly one.
   */
  /**
   * Whether the session is HOLDING the publish gate — literally
   * `gate.size === 0`, and nothing more.
   *
   * 🔴 Not "whether media can leave this device". During the 2026-09-08 legs
   * the reason set was non-empty and the wire was not quiet, so no assertion
   * over this model can fail for the leg's reason; whether a held gate reaches
   * the wire is `publishGate.test.ts`'s job, against a fake of livekit's own
   * bookkeeping. Read this as "the session kept its side of the promise".
   */
  publishing(): boolean {
    return this.gate.size === 0;
  }

  /**
   * `state.tsx`'s `callTerminalLoud()` — the ONE condition the ME-10 banner
   * renders on, and with it the sentence "Your audio and video stay paused".
   *
   * `mode` defaults to the LIVE mode; passing `undefined` explicitly drives
   * `isTerminalLoud`'s `mode === undefined` arm (a latch with no session
   * mode), which `state.tsx` reaches but no ladder here can. A rest tuple
   * rather than a default parameter, because a default would swallow an
   * explicit `undefined` and make that arm undrivable again.
   */
  terminalLoud(...args: [mode?: CallMode | undefined]): boolean {
    const mode = args.length === 0 ? this.session.callMode() : args[0];
    return isTerminalLoud(
      mode,
      this.chip(),
      this.#replay().latch !== undefined,
    );
  }

  /**
   * `state.tsx`'s latch protocol over the media-plane callbacks, replayed —
   * VERBATIM its `onEncryptionState` binding over `callEncryptionLatch`:
   *
   *   "loud"  → latch === undefined || latch.error === meta?.replaces
   *               ? { error, ...meta } : latch
   *   "clear" → latch?.error === error ? undefined : latch
   *
   * First-wins, except that an emission naming the latched error as the one
   * it `replaces` (the media→control upgrade) takes over in ONE write; the
   * clear is identity-matched on `.error`. A bare `"clear"` (no error) touches
   * nothing, as the binding's does. Without this mirror every session spec
   * would measure the harness instead of the product.
   */
  #replay(): { latch: ReplayedLatch | undefined; mediaHold: boolean } {
    let latch: ReplayedLatch | undefined;
    let mediaHold = false;
    for (const entry of this.journal) {
      if (entry.kind === "hold") {
        mediaHold = entry.active;
      } else if (entry.state === "loud" && entry.error !== undefined) {
        latch =
          latch === undefined || latch.error === entry.meta?.replaces
            ? { error: entry.error, ...(entry.meta ?? {}) }
            : latch;
      } else if (entry.state === "clear" && entry.error !== undefined) {
        latch = latch?.error === entry.error ? undefined : latch;
      }
    }
    return { latch, mediaHold };
  }

  /**
   * `overrides` replace inputs this world otherwise holds fixed: a device
   * running a session has one (`hasSession`), its channel has an open group,
   * it needs no setup, and gate (d) reads the modelled worker window through
   * the real `summarizeDecodeWitness` (`decodeWitness()`). A spec overriding
   * `decodeWitness` hands the chip a verdict the modelled window did not
   * produce, so it is for driving the chip's ARMS, not for evidence about the
   * witness.
   */
  chip(
    overrides: Partial<{
      hasSession: boolean;
      channelHasOpenGroup: boolean;
      deviceNeedsSetup: boolean;
      decodeWitness: DecodeWitness;
    }> = {},
  ): ChipState {
    const { latch, mediaHold } = this.#replay();
    const mode = this.session.callMode();
    const sessionState = this.session.state();
    const {
      hasSession = true,
      channelHasOpenGroup = true,
      deviceNeedsSetup = false,
      decodeWitness = this.decodeWitness(),
    } = overrides;
    return chipStateFrom({
      hasSession: () => hasSession,
      sessionState: () => sessionState,
      mode: () => mode,
      mediaHold: () => mediaHold,
      // The `ChipLatch` shape `state.tsx` feeds: origin and keyed-ness only,
      // never the error or what it replaced.
      latch: (): ChipLatch | undefined =>
        latch && {
          origin: latch.origin,
          mediaKeyed: latch.mediaKeyed ?? false,
        },
      rosterVerified: () =>
        this.roster.map((m) => !this.unverified.has(identityOf(m))),
      channelHasOpenGroup: () => channelHasOpenGroup,
      // Both read only on the no-session path; a device running a session
      // is enrolled, and its peers are the ones publishing.
      deviceNeedsSetup: () => deviceNeedsSetup,
      peerCouldEncrypt: () => this.sfu.some((id) => id !== SELF_ID),
      decodeWitness: () => decodeWitness,
      observedEncryption: (identity) =>
        this.unobserved.has(identity) ? undefined : true,
      // Every SFU participant publishes one track, INCLUDING self. The
      // production assembly excludes only our own screen leg, and these
      // ladders have none.
      room: () => ({
        localIdentity: SELF_ID,
        participants: this.sfu.map((identity) => ({
          identity,
          publicationCount: 1,
        })),
        localPublications: [...this.localPublications],
      }),
    });
  }

  /**
   * The `(state, error)` PROJECTION of every `"clear"` since `index` — which
   * error was named, and when. `meta` is deliberately not in it: a `"clear"`
   * never carries one, and `loudSince` below is the same projection so the
   * two read alike. The meta a `"loud"` carried is asserted on `states`
   * itself (`latchLoud`) or read through `chip()`.
   */
  clearsSince(index: number): EncryptionStateCall[] {
    return this.#project(index, "clear");
  }

  /**
   * The `(state, error)` projection of every `"loud"` since `index`: WHICH
   * error latched and WHEN. The meta that rode it is not in the projection —
   * see `clearsSince`.
   */
  loudSince(index: number): EncryptionStateCall[] {
    return this.#project(index, "loud");
  }

  #project(index: number, state: MediaEncryptionState): EncryptionStateCall[] {
    return this.states
      .slice(index)
      .filter((s) => s.state === state)
      .map((s) => ({ state: s.state, error: s.error }));
  }

  /** The key index a sender publishes at for `epoch` (`epoch mod 16`). */
  indexAt(epoch: number): number {
    return epoch % 16;
  }

  /** The worker's decode-path missing key: the one shape that names its pair. */
  missingKey(identity: string, epoch: number): Error {
    return new Error(
      `MissingKey: missing key at index ${this.indexAt(epoch)} for participant ${identity}`,
    );
  }
}

/**
 * An installer that, like `MlsKeyProvider.#install`, posts entries and awaits
 * between them — and can raise an InvalidKey in that gap, exactly once. Its
 * `applyLocalKey` can instead THROW a scripted error (`failLocalKeyOnce`)
 * before posting anything, where the real one throws
 * `MissingLocalFrameKeyError` — ahead of its first await, so the rejection
 * reaches the caller's `catch` with no microtask gap, as the real one does.
 */
function fakeInstaller(world: World): KeyInstaller {
  const install = async () => {
    await Promise.resolve(); // first entry posted, awaiting importKey
    const error = world.midInstallError;
    if (error) {
      world.midInstallError = null;
      world.session.noteEncryptionError(error);
    }
    await Promise.resolve(); // second entry
  };
  const applyLocalKey = async () => {
    const failure = world.localKeyFailure;
    if (failure) {
      world.localKeyFailure = null;
      throw failure;
    }
    await install();
  };
  return {
    applyKeys: install,
    applyRemoteKeys: install,
    applyLocalKey,
    resetForGroup: () => {},
  };
}

function fakeMedia(world: World): MlsMediaBinding {
  return {
    installer: fakeInstaller(world),
    localIdentity: () => SELF_ID,
    sfuParticipants: () => [...world.sfu],
    participantTrackSids: (identity) => world.sids.get(identity) ?? [],
    sfuConnected: () => world.connected,
    localPublications: () => [...world.localPublications],
    republishLocalPublications: async (trackSids) => {
      world.republished.push([...trackSids]);
      if (world.republishGate) await world.republishGate;
      // The republish comes up GCM, as the real seam's does.
      world.localPublications = world.localPublications.map((p) =>
        trackSids.includes(p.trackSid)
          ? { ...p, encryption: ENCRYPTION_TYPE_GCM }
          : p,
      );
    },
    pausePublishing: async (reason) => {
      world.gate.add(reason);
      world.gateLog.push(`+${reason}`);
    },
    resumePublishing: async (reason) => {
      world.gate.delete(reason);
      world.gateLog.push(`-${reason}`);
    },
    onEncryptionState: (state, error, meta) => {
      // `meta` is added as a key only when the session passed one: a strict
      // deepEqual treats `{ meta: undefined }` and `{}` as different objects,
      // and every exact-shape `"clear"` assertion is written without it.
      const call: EncryptionStateCall =
        meta === undefined ? { state, error } : { state, error, meta };
      world.states.push(call);
      world.events.push(`state:${state}`);
      world.journal.push({ kind: "state", ...call });
    },
    ...(world.holdsSupported
      ? {
          onMediaHold: (active: boolean) => {
            world.holds.push(active);
            world.events.push(`hold:${active}`);
            world.journal.push({ kind: "hold", active });
          },
        }
      : {}),
    onCallModeChanged: (mode) => world.modes.push(mode.kind),
    setEncryptionEnabled: async () => {},
  };
}

/** Every bridge method the join ladder + rotation seam + reconcile need. */
function bridgeFor(world: World): E2EEBridge {
  const record =
    <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    (...args: A): R => {
      world.bridgeCalls.push(name);
      return fn(...args);
    };
  const stubs: BridgeStubs = {
    registerMlsSink: record("registerMlsSink", (sink) => {
      world.sink = sink;
      return () => {
        world.sink = null;
      };
    }),
    // Above the low-water mark: nothing to publish, no MFA prompt. Counted by
    // `record` BEFORE it waits on `holdReplenish`; with no hold open it
    // settles exactly as a bare `async` return does.
    mlsReplenish: record("mlsReplenish", async () => {
      if (world.replenishGate) await world.replenishGate;
      return null;
    }),
    callCreate: record(
      "callCreate",
      async (channelId, _userId): Promise<MlsCallCreated> => {
        const group_id =
          world.nextGroup ?? (world.role === "creator" ? GROUP : "orphan-0");
        return {
          group_id,
          payload: {
            group_id,
            channel_id: channelId,
            device_id: SELF.device_id,
          },
        };
      },
    ),
    mlsCreateGroup: record(
      "mlsCreateGroup",
      async (payload): Promise<MlsHttpResult<ResponseCreateMlsGroup>> => {
        if (world.nextGroup !== null && payload.group_id === world.nextGroup) {
          world.nextGroup = null;
          return { kind: "ok", body: { result: "Created" } };
        }
        return world.role === "creator"
          ? { kind: "ok", body: { result: "Created" } }
          : {
              kind: "conflict",
              body: {
                result: "Conflict",
                open_group_id: GROUP,
                channel_id: world.channelId,
              },
            };
      },
    ),
    callLocalGroups: record("callLocalGroups", async () => []),
    // The wipe takes the group's staged commit with it: a `callCommitWon`
    // for that group afterwards is refused, as native's `load_group` is.
    // Counted by `record` BEFORE it waits on `holdLeaveCleanup`. A scripted
    // `failLeaveCleanupOnce` for this group rejects past the hold, having
    // wiped nothing (native's transaction rolled back).
    callLeaveCleanup: record("callLeaveCleanup", async (groupId) => {
      if (world.leaveCleanupGate) await world.leaveCleanupGate;
      const failure = world.leaveCleanupFailure;
      if (failure && failure.groupId === groupId) {
        world.leaveCleanupFailure = null;
        world.failedLeaveCleanups.push(groupId);
        throw failure.error;
      }
      world.evicted.delete(groupId);
      world.leaveCleanups.push(groupId);
      if (world.stagedCommits.has(groupId)) {
        world.stagedCommits.set(groupId, "left");
      }
    }),
    callState: record("callState", async () => world.callState()),
    callFrameKeys: record("callFrameKeys", async () => world.frameKeys()),
    // Joiner pre-pin: no local group before the Welcome (the session
    // tolerates the throw and pins from the SFU set).
    callRosterIdentities: record("callRosterIdentities", async () => {
      throw new Error("mls_group_not_found");
    }),
    // Counted by `record` BEFORE it waits on `holdReconcileRoster`.
    reconcileCallRoster: record("reconcileCallRoster", async () => {
      if (world.reconcileRosterGate) await world.reconcileRosterGate;
      return [];
    }),
    // Both intent stubs are counted by `record` BEFORE they wait on a hold
    // (`holdCallJoinIntent` / `holdJoinIntent`). With no hold open and nothing
    // scripted (`failCallJoinIntentOnce` / `answerJoinIntentOnce`) they settle
    // exactly as a bare `async` return does.
    callJoinIntent: record(
      "callJoinIntent",
      async (): Promise<MlsJoinIntentPayload> => {
        if (world.callJoinIntentGate) await world.callJoinIntentGate;
        const failure = world.callJoinIntentFailure;
        if (failure) {
          world.callJoinIntentFailure = null;
          throw failure.error;
        }
        return {
          device_id: SELF.device_id,
          key_package_ref: "kp-ref",
          signature: "sig",
        };
      },
    ),
    mlsJoinIntent: record(
      "mlsJoinIntent",
      async (): Promise<MlsHttpResult<void>> => {
        if (world.joinIntentGate) await world.joinIntentGate;
        const answer = world.joinIntentAnswer;
        if (answer) {
          world.joinIntentAnswer = null;
          return answer;
        }
        return { kind: "ok", body: undefined };
      },
    ),
    // Counted by `record` BEFORE it waits on `holdProcessEnvelope`. A native
    // rejection answers as the bridge's `processEnvelope` does.
    processEnvelope: record(
      "processEnvelope",
      async (envelope): Promise<EnvelopeDisposition> => {
        if (world.processGate) await world.processGate;
        if (world.rejections.has(envelope.id)) {
          return classifyEnvelopeError(world.rejections.get(envelope.id));
        }
        const outcome = world.outcomes.get(envelope.id);
        assert.ok(outcome, `no scripted outcome for envelope ${envelope.id}`);
        if (outcome.removed_self) world.evicted.add(outcome.group_id);
        return { kind: "processed", outcome, ack: true };
      },
    ),
    ackEnvelopes: record("ackEnvelopes", () => {}),
    // `GET /mls/groups/<id>/commits?from_epoch=`, the gap refetch: answers
    // only what `receiverLag` scripted, for the range it scripted.
    mlsFetchCommits: record(
      "mlsFetchCommits",
      async (groupId, fromEpoch): Promise<FetchCommitsResult> => {
        const answer = world.fetchCommitsAnswer;
        assert.ok(answer, `no scripted gap refetch of ${groupId}`);
        assert.deepEqual(
          [groupId, fromEpoch],
          [answer.groupId, answer.fromEpoch],
          "the gap refetch asked for another range",
        );
        world.fetchCommitsAnswer = null;
        return answer.result;
      },
    ),
    // The ghost-divergence timer fires 30 s after a member is seen in the MLS
    // roster but not in the SFU set, and stages a Remove. Specs that run past
    // that (a suspended hold outliving its bound) would otherwise die on an
    // unstubbed method. `mls_group_not_found` is the shape the session already
    // treats as a benign no-op — another member's Remove won the race — so the
    // ghost path runs to completion without deciding anything.
    //
    // An EVICTED group is the exception. `mls_call_remove` finds the target
    // leaf before `remove_members`, so a vanished target is still
    // `mls_group_not_found` there, but a member the group still holds reaches
    // `remove_members` and is refused `remove-members` (`UseAfterEviction`).
    callRemove: record("callRemove", async (groupId, userId, deviceId) => {
      const held = world.roster.some(
        (m) =>
          identityOf(m) === `${userId}:${deviceId}` &&
          identityOf(m) !== SELF_ID,
      );
      if (world.evicted.has(groupId) && held) throw mlsCode("remove-members");
      throw Object.assign(new Error("mls_group_not_found"), {
        type: "mls_group_not_found",
      });
    }),
    // ---- The admit path: verify, claim, stage, submit, merge ----
    //
    // When these were added (at bf8278e4) no session spec touched any of
    // them: an instrumented Proxy logged no unstubbed access across the four
    // specs. Shapes follow `components/client/e2ee.ts`. Native failures cross
    // IPC as `{ type: "<snake_case>", … }` (e2ee-core `Error`,
    // `#[serde(tag = "type")]`); the session reads only `type`, so they are
    // raised here as an `Error` carrying it, as `callRemove`'s is.
    //
    // Read-only native pin check: resolves, or rejects on an unpinned leaf.
    callVerifyJoinIntent: record("callVerifyJoinIntent", async () => {}),
    // `POST /mls/key_packages/claim`: one `Claimed` result per target.
    mlsClaimKeyPackage: record(
      "mlsClaimKeyPackage",
      async (body): Promise<MlsHttpResult<{ results: MlsClaimResult[] }>> => ({
        kind: "ok",
        body: {
          results: body.targets.map((target) => ({
            user_id: target.user_id,
            device_id: target.device_id,
            status: "Claimed" as const,
            key_package_ref: `kp-ref-${target.device_id}`,
            key_package: `kp-${target.device_id}`,
            mls_signature_key: `sig-key-${target.device_id}`,
            binding_signature: `binding-${target.device_id}`,
            reused: false,
          })),
        },
      }),
    ),
    // `mls_call_admit`: stages an Add + Welcome for the NEXT epoch and
    // applies nothing until the DS answers. On an evicted group
    // `add_members` fails `UseAfterEviction`: `add-members`.
    callAdmit: record(
      "callAdmit",
      async (request): Promise<MlsSubmitCommit> => {
        if (world.evicted.has(request.group_id)) throw mlsCode("add-members");
        const epoch = world.epoch + 1;
        const commit: MlsSubmitCommit = {
          device_id: SELF.device_id,
          epoch,
          commit: `commit-add-${epoch}`,
          welcome: `welcome-${epoch}`,
          added: [{ user_id: request.user_id, device_id: request.device_id }],
          removed: [],
        };
        world.stagedCommits.set(request.group_id, commit);
        return commit;
      },
    ),
    // `POST /mls/groups/<id>/commits`: `Won` by default. Counted by `record`
    // BEFORE it waits on `holdSubmit`; with no hold open and nothing
    // scripted (`failSubmitOnce` / `answerSubmitOnce`) it settles as a bare
    // `async` return does.
    mlsSubmitCommit: record(
      "mlsSubmitCommit",
      async (): Promise<MlsHttpResult<ResponseSubmitMlsCommit>> => {
        if (world.submitGate) await world.submitGate;
        const failure = world.submitFailure;
        if (failure) {
          world.submitFailure = null;
          throw failure.error;
        }
        const answer = world.submitAnswer;
        if (answer) {
          world.submitAnswer = null;
          return answer;
        }
        return { kind: "ok", body: { result: "Won" } };
      },
    ),
    // `mls_call_commit_won`: merges the staged commit, or refuses. A group
    // wiped under its commit is `mls_group_not_found` (`load_group`); no
    // pending commit or a different epoch is an `mls` code. A merge deletes
    // the staged commit, and on GROUP moves `epoch` to the won epoch (one
    // past the epoch it was staged at) and seats `added` in `roster`;
    // keys-changed stays the spec's to fire, as for `commit()`. Of the group
    // replacements this world drives, only one whose leave-clean failed
    // (`failLeaveCleanupOnce`) leaves the replaced group's commit mergeable.
    //
    // Native checks `won_epoch` against `group.epoch + 1`, this against the
    // staged commit's own epoch. They agree while GROUP's `epoch` has not
    // moved since `callAdmit`; a spec that moves it in between (`commit()`,
    // `welcome()`) is past what this stub models.
    callCommitWon: record(
      "callCommitWon",
      async (groupId, wonEpoch): Promise<MlsProcessOutcome> => {
        const staged = world.stagedCommits.get(groupId);
        if (staged === "left") throw groupNotFound(groupId);
        if (staged === undefined) throw mlsCode("no-pending-commit");
        if (staged.epoch !== wonEpoch) throw mlsCode("commit-epoch-mismatch");
        world.stagedCommits.delete(groupId);
        if (groupId === GROUP) {
          const ids = (list: MlsMemberDevice[] = []) => list.map(identityOf);
          const removed = ids(staged.removed);
          // An added member is seated as its cast constant when it has one,
          // so the reference-comparing drivers (`peerLeaves`) still find it.
          const added = (staged.added ?? []).map(
            (m) =>
              [SELF, PEER, THIRD].find(
                (c) => identityOf(c) === identityOf(m),
              ) ?? m,
          );
          world.epoch = wonEpoch;
          world.roster = [
            ...world.roster.filter((m) => !removed.includes(identityOf(m))),
            ...added,
          ];
        }
        return {
          group_id: groupId,
          kind: "commit_applied",
          epoch: wonEpoch,
          removed_self: false,
          removed: [],
        };
      },
    ),
    // `mls_call_commit_lost`: clears the pending commit. A wiped group is
    // `mls_group_not_found`, which the session swallows.
    callCommitLost: record("callCommitLost", async (groupId) => {
      world.commitLosts.push(groupId);
      if (world.stagedCommits.get(groupId) === "left") {
        throw groupNotFound(groupId);
      }
      world.stagedCommits.delete(groupId);
    }),
    // ---- The plaintext escape: the native BLOCKING confirm dialog ----
    //
    // `e2ee_call_confirm_downgrade`: resolves on Ok, rejects `declined` on
    // cancel, and rejects with anything else when the dialog could not be
    // shown at all. Recorded (with its arguments) BEFORE the scripted
    // outcome is taken, so a declined or failed dialog still counts as one
    // the session asked for. With nothing scripted it resolves: Ok.
    callConfirmDowngrade: record(
      "callConfirmDowngrade",
      async (groupId, sfuParticipants, displayNames) => {
        world.confirmDowngradeCalls.push({
          groupId,
          sfuParticipants: [...sfuParticipants],
          displayNames: { ...displayNames },
        });
        const outcome = world.confirmDowngradeOutcome;
        if (outcome) {
          world.confirmDowngradeOutcome = null;
          throw outcome.kind === "declined" ? declined() : outcome.error;
        }
      },
    ),
    // `e2ee_call_clear_downgrade`: the T6 re-upgrade after a confirmed
    // interlude clears the native grant, best-effort (the session swallows a
    // rejection). Resolves; recorded by group.
    callClearDowngrade: record("callClearDowngrade", async (groupId) => {
      world.clearDowngradeCalls.push(groupId);
    }),
  };
  return fakeBridge(stubs);
}

// ---- Clock + scheduling helpers ---------------------------------------------

/** Drain every settled promise chain (setImmediate is left real). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** Advance the fake clock in small steps, draining continuations between. */
export async function advance(t: TestContext, ms: number): Promise<void> {
  const step = 250;
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    t.mock.timers.tick(Math.min(step, ms - elapsed));
    await flush();
  }
}

/**
 * Fake timers do not move `performance.now()`, which stamps both the heal
 * probe's install reference and the error ledger. A counter that advances on
 * every read gives the two a strict order without depending on the real
 * clock's resolution.
 */
function fakePerformanceNow(t: TestContext): void {
  const original = performance.now;
  // Tracks the FAKE timer clock (which mocks `Date`), plus a strictly
  // increasing sub-millisecond tiebreaker so two reads in one tick still
  // order — the ledger's install reference depends on that. Returning a bare
  // counter instead would make every elapsed-time measurement read as zero,
  // and the hold's banked budget is one.
  const base = Date.now();
  let tick = 0;
  Object.defineProperty(performance, "now", {
    value: () => Date.now() - base + ++tick * 1e-6,
    configurable: true,
    writable: true,
  });
  t.after(() => {
    Object.defineProperty(performance, "now", {
      value: original,
      configurable: true,
      writable: true,
    });
  });
}

// ---- Scenario drivers --------------------------------------------------------

export function newWorld(
  t: TestContext,
  role: "creator" | "joiner",
  channelId: string,
  seat?: (world: World) => void,
): World {
  t.mock.timers.enable({
    apis: ["setTimeout", "setInterval", "Date"],
    now: 1_000_000,
  });
  fakePerformanceNow(t);
  const world = new World(role, channelId);
  seat?.(world); // seat extra members BEFORE the ladder reads the roster
  world.session = new Session({
    bridge: bridgeFor(world),
    userId: SELF.user_id,
    deviceId: SELF.device_id,
    channelId,
  });
  world.session.bindMedia(fakeMedia(world));
  t.after(() => world.session.dispose());
  return world;
}

/** Creator: create → active → epoch 0 installed → enabled → `e2ee`. */
export async function bringUpCreator(
  t: TestContext,
  world: World,
): Promise<void> {
  void world.session.start();
  await flush();
  await advance(t, 1); // the detached establish (group action) runs
  assert.equal(world.session.state(), "active");
  assert.equal(world.session.callMode().kind, "e2ee");
}

/**
 * Joiner: create-race 409 → join intent → (optionally a pre-Welcome error)
 * → Welcome at `epoch` → first install at `epoch` with `previous: []` →
 * enabled → `e2ee`.
 */
export async function bringUpJoiner(
  t: TestContext,
  world: World,
  epoch: number,
  beforeWelcome?: () => void,
): Promise<void> {
  void world.session.start();
  await flush();
  await advance(t, 1); // the establish runs up to the Welcome wait
  assert.equal(world.session.state(), "starting");
  assert.ok(world.bridgeCalls.includes("mlsJoinIntent"), "no intent broadcast");
  beforeWelcome?.();
  await world.welcome(epoch);
  assert.equal(world.session.state(), "active");
  await world.session.onLocalKeysChanged(GROUP, epoch);
  await flush();
  assert.equal(world.session.callMode().kind, "e2ee");
}

/**
 * An InvalidKey outside every rotation window: the media latch goes loud.
 *
 * The emission's meta is pinned exactly. `origin: "media"` — the path is
 * `noteEncryptionError` → `#latchLoud(error, "media")`, never the control
 * default. `mediaKeyed: true` — the snapshot `#latchLoud` takes BEFORE
 * `loudModeFallback` reads `#e2eeEnabled && #hasLocalKey &&
 * !#localDeclarationPlain && !(error instanceof MissingLocalFrameKeyError)`,
 * and on this path every conjunct holds: the bring-up enabled E2EE and
 * installed a local key, nothing declared plaintext, and the error is a
 * bare `Error`. A media latch says the RECEIVE side failed; the send-side
 * witness is a separate fact, and the chip's media arm ignores it either
 * way (`origin === "media"` reads `not_encrypted` regardless).
 */
export async function latchLoud(t: TestContext, world: World): Promise<Error> {
  await advance(t, 3_000); // past the immediate-install rotation settle (2 s)
  const before = world.states.length;
  const error = new Error("InvalidKey: Decryption failed: x");
  world.session.noteEncryptionError(error);
  await flush();
  assert.deepEqual(world.states.slice(before), [
    { state: "loud", error, meta: { origin: "media", mediaKeyed: true } },
  ]);
  assert.equal(world.session.callMode().kind, "negotiating");
  return error;
}

/** The peer leaves the SFU and the group: a Remove epoch installs. */
export async function peerLeaves(world: World, epoch: number): Promise<void> {
  world.sfu = world.sfu.filter((id) => id !== PEER_ID);
  world.roster = world.roster.filter((m) => m !== PEER);
  world.sids.delete(PEER_ID);
  await world.commit(epoch, [PEER]);
  await world.session.reconcileNow(); // the roster diff observes the removal
  await flush();
}

/** The peer re-adds with all-new tracks: an Add epoch installs. */
export async function peerRejoins(
  world: World,
  epoch: number,
  sids: string[],
): Promise<void> {
  if (!world.sfu.includes(PEER_ID)) world.sfu = [...world.sfu, PEER_ID];
  if (!world.roster.includes(PEER)) world.roster = [...world.roster, PEER];
  world.sids.set(PEER_ID, sids);
  await world.commit(epoch);
  await world.session.reconcileNow(); // the roster diff observes the re-Add
  await flush();
}
