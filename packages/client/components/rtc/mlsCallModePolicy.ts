/**
 * The §3.4 call-mode transition machine + the §4.4 dual-gated chip + the ctl
 * payload parser — the PURE, session-independent core of slice 6.5's downgrade
 * UX, extracted from `mlsCallSession`/`state.tsx` so every transition and the
 * chip precedence table are unit-testable in isolation (the house no-vitest
 * split; this module must stay dependency-free so `node --test` can load it —
 * the one import below is TYPE-ONLY and is erased, so nothing is loaded).
 *
 * Nothing here performs I/O or touches a Room: `callModeTransition` returns the
 * NEXT mode + the EFFECTS the session must run; `chipState` derives the visible
 * indicator from a snapshot of inputs; `parseCtlPayload` validates a received
 * ctl-announce (default-closed forward-compat). The session owns the imperative
 * glue (native confirm dialog, pause gate, announce courier, timers).
 */

import type { CallEncryptionReadiness } from "./e2eeDeviceReadiness.ts";

// ---- Call mode (the §3.4 state machine) ------------------------------------

export type CallMode =
  // Session exists, no verdict yet — publishing GATED (`negotiating` reason).
  | { kind: "negotiating" }
  // Not an E2EE call (feature/toggle off) — publishing normal, no chrome (L4).
  | { kind: "off" }
  // Enabled, roster consistent, publishing encrypted.
  | { kind: "e2ee" }
  // Non-enrolled present (post grace) — publishing PAUSED, banner shown.
  | { kind: "mixed" }
  // A confirmed plaintext window is open; `localConfirmed` is THIS device's.
  // `confirmedVia` records WHO authorized a local confirm: `native` is the
  // group-bound dialog (invariant 1's per-device confirmation, sticky across a
  // re-secure); `app` is the in-app confirm the escape falls back to when no
  // usable group exists or the native dialog fails for a reason other than a
  // decline — it authorizes THIS plaintext window only and is withdrawn by the
  // next re-secure (`interludeStickyAcrossResecure`). Absent on an
  // unconfirmed interlude (T4 remote announce).
  | {
      kind: "interlude";
      localConfirmed: boolean;
      confirmedVia?: "native" | "app";
    }
  // Terminal joiner-side A3 refusal (auto-leave).
  | { kind: "call_full" };

/**
 * The events that drive the machine. Each is a RESOLVED fact (e.g.
 * `local_confirm` fires only AFTER the native dialog returned Ok) — the pure
 * function never awaits.
 */
export type CallModeEvent =
  // The session settled: not an E2EE call (feature/toggle off, legacy server).
  | { type: "verdict_plaintext" }
  // Enable completed (pause→setE2EEEnabled(true)→resume all done).
  | { type: "enabled" }
  // A non-enrolled participant is present past the classification grace.
  | { type: "mix_detected" }
  // The last non-enrolled participant left (drives T2 / T6 after hysteresis).
  | { type: "mix_cleared" }
  // This device's user confirmed plaintext (T3 / T5). `via` names the route:
  // `native` (default) is the group-bound native dialog; `app` is the in-app
  // confirm the escape routes to when no usable group exists.
  | { type: "local_confirm"; via?: "native" | "app" }
  // A verified member announced plaintext for this call (T4). Never resumes.
  | { type: "remote_announce" }
  // join_intent returned MlsCallFull (T7 — joiner side only).
  | { type: "call_full" }
  // A control-plane re-establish (desync/poison/rejoin) — keeps the mode.
  | { type: "resecure" };

/** An effect the session must perform after a transition (imperative glue). */
export type CallModeEffect =
  // Assert / release the named publish-gate reason (R2-7 reason-scoped gate).
  | { do: "pause"; reason: "negotiating" | "mixed" | "enable-window" }
  | { do: "resume"; reason: "negotiating" | "mixed" | "enable-window" }
  // Flip the LiveKit Room E2EE mode. `false` only ever after a native confirm.
  | { do: "set_e2ee"; enabled: boolean }
  // Courier the group-encrypted mode announcement (best-effort; ME-4/ME-12).
  | { do: "announce" }
  // Start the 15 s re-upgrade hysteresis (T2 warm resume / T6 successor).
  | { do: "schedule_reupgrade"; viaSuccessor: boolean }
  // Cancel a pending re-upgrade (a participant bounced back in).
  | { do: "cancel_reupgrade" }
  // Auto-leave the SFU (T7) — deferred by the session (never sync in-callback).
  | { do: "auto_leave" };

export interface CallModeTransition {
  mode: CallMode;
  effects: CallModeEffect[];
}

/**
 * The §3.4 transition function. `mode` is the current mode; `event` a resolved
 * fact; returns the next mode + the effects to run. Total + deterministic —
 * every (mode, event) pair is handled (unknown pairs are no-ops that keep the
 * mode, so a spurious event never corrupts state).
 *
 * Invariants encoded here (gate-checklist / audit folds):
 *  - The ONLY path to `interlude` (a plaintext window) is `local_confirm`
 *    (T3/T5) or `remote_announce` (T4); `remote_announce` sets
 *    `localConfirmed:false` so it NEVER resumes publishing (I1).
 *  - `local_confirm`'s effect order is `set_e2ee(false)` BEFORE `resume`
 *    (no encrypted frame to keyless peers; no plaintext under an encrypted
 *    flag) — the session performs them in array order.
 *  - The enable branch is MODE-GATED (ME-6): only `negotiating`/`e2ee`/`mixed`
 *    accept `enabled`; an `interlude` NEVER warm-enables the old group — its
 *    sole exit is `mix_cleared` → T6 successor.
 *  - `call_full` is terminal (T7); further events keep it.
 */
export function callModeTransition(
  mode: CallMode,
  event: CallModeEvent,
): CallModeTransition {
  const keep = (): CallModeTransition => ({ mode, effects: [] });

  // Terminal.
  if (mode.kind === "call_full" || mode.kind === "off") {
    // `off` still accepts a late `mix_detected`? No — an off call negotiated
    // plaintext for a NON-E2EE call; there is no group. Stay put.
    return keep();
  }

  switch (event.type) {
    case "call_full":
      // T7 — joiner-side only; terminal + auto-leave (deferred).
      return { mode: { kind: "call_full" }, effects: [{ do: "auto_leave" }] };

    case "verdict_plaintext":
      // T0a — feature/toggle off ⇒ release the negotiating gate, no chrome.
      return {
        mode: { kind: "off" },
        effects: [{ do: "resume", reason: "negotiating" }],
      };

    case "enabled":
      // T0b — enable completed. MODE-GATED (ME-6): never from an interlude.
      if (
        mode.kind === "negotiating" ||
        mode.kind === "e2ee" ||
        mode.kind === "mixed"
      ) {
        return { mode: { kind: "e2ee" }, effects: [] };
      }
      return keep();

    case "mix_detected":
      // T0c / T1 — a non-enrolled participant (post-grace). PAUSE + banner.
      // Already mixed/interlude ⇒ no-op (the pause is already asserted).
      if (mode.kind === "negotiating") {
        // Swap the negotiating gate for the mixed gate (both keep us paused).
        return {
          mode: { kind: "mixed" },
          effects: [
            { do: "pause", reason: "mixed" },
            { do: "resume", reason: "negotiating" },
            { do: "cancel_reupgrade" },
          ],
        };
      }
      if (mode.kind === "e2ee") {
        return {
          mode: { kind: "mixed" },
          effects: [
            { do: "pause", reason: "mixed" },
            { do: "cancel_reupgrade" },
          ],
        };
      }
      // In an interlude, a NEW non-enrolled participant does not change the
      // mode — the interlude already tolerates plaintext; cancel any pending
      // re-upgrade so we don't resume-encrypt while a mix persists.
      if (mode.kind === "interlude") {
        return { mode, effects: [{ do: "cancel_reupgrade" }] };
      }
      return keep();

    case "mix_cleared":
      // The last non-enrolled participant left. From `mixed` (nobody
      // confirmed): T2 warm resume after hysteresis. From `interlude`
      // (plaintext was live): T6 fresh-successor re-upgrade after hysteresis.
      if (mode.kind === "mixed") {
        return {
          mode,
          effects: [{ do: "schedule_reupgrade", viaSuccessor: false }],
        };
      }
      if (mode.kind === "interlude") {
        return {
          mode,
          effects: [{ do: "schedule_reupgrade", viaSuccessor: true }],
        };
      }
      return keep();

    case "local_confirm": {
      // T3 / T5 — the user confirmed plaintext (the dialog already returned
      // Ok). set_e2ee(false) STRICTLY before resume. Announce is best-effort.
      // Reachable from `mixed` (T3), `interlude(localConfirmed:false)` (T5)
      // or `negotiating` (ME-10, below).
      //
      // `via` stamps the interlude's provenance (`confirmedVia`). The in-app
      // route (`via: "app"`) OMITS `announce`: `callAnnounce` is native-gated
      // on `mls_not_confirmed`, and the in-app route never armed a grant, so
      // the announce would be refused (and a later T6 `callClearDowngrade`
      // would run against a grant that never existed). Nothing else differs —
      // E2EE-off, the gate releases and the re-upgrade cancel are the same.
      const via = event.via ?? "native";
      const confirmed: CallMode = {
        kind: "interlude",
        localConfirmed: true,
        confirmedVia: via,
      };
      const announce: CallModeEffect[] =
        via === "app" ? [] : [{ do: "announce" }];
      if (
        mode.kind === "mixed" ||
        (mode.kind === "interlude" && !mode.localConfirmed)
      ) {
        return {
          mode: confirmed,
          effects: [
            { do: "set_e2ee", enabled: false },
            { do: "resume", reason: "mixed" },
            // A confirmed plaintext interlude must release EVERY session-held
            // gate reason (re-verify MED-B): a failed `#enable` deliberately
            // leaves `enable-window` held (fail-closed), and without this the
            // user who just confirmed "resume unencrypted" stays paused
            // forever. Releasing an un-held reason is a no-op.
            { do: "resume", reason: "enable-window" },
            ...announce,
            { do: "cancel_reupgrade" },
          ],
        };
      }
      // ME-10 terminal-loud escape: a call that FAILED to secure (retry
      // exhaustion / loud failure while still `negotiating`) may be resumed
      // as plaintext by the SAME confirmed path — "Stay unencrypted".
      // No explicit `negotiating` resume: the session's mode lockstep releases
      // that gate AFTER these effects run (E2EE-off still strictly first);
      // `enable-window` (held by a failed enable) IS released explicitly
      // (re-verify MED-B). The caller gates reachability on a
      // failed/re-securing/latched-loud session.
      //
      // `mixed` IS released here too (lane-3 C1): after a mix was declared
      // (`#onMixDetected` held `mixed`) and a re-establish ran,
      // `#resetEnableState` drops `#mixPaused` WITHOUT releasing the `mixed`
      // gate reason, so a terminal confirm from `negotiating` used to release
      // `enable-window` + `negotiating` and leave `mixed` held — fail-closed,
      // while the banner said the media was being sent. Releasing an un-held
      // reason is a no-op on the reason set, and `negotiating` itself stays
      // held until `#setMode` runs after these effects, so this cannot
      // produce a premature 1→0 edge.
      if (mode.kind === "negotiating") {
        return {
          mode: confirmed,
          effects: [
            { do: "set_e2ee", enabled: false },
            { do: "resume", reason: "mixed" },
            { do: "resume", reason: "enable-window" },
            ...announce,
            { do: "cancel_reupgrade" },
          ],
        };
      }
      return keep();
    }

    case "remote_announce":
      // T4 — a verified member announced plaintext. Publishing STAYS PAUSED
      // (an announce can never open the local plaintext path); only re-words
      // the banner. Reachable from `mixed` only (an already-interlude member
      // ignores a duplicate announce).
      if (mode.kind === "mixed") {
        return {
          mode: { kind: "interlude", localConfirmed: false },
          effects: [{ do: "cancel_reupgrade" }],
        };
      }
      return keep();

    case "resecure":
      // A control-plane re-establish keeps the CallMode (the machine rides
      // above group identity). The session's own pause-through-re-secure logic
      // handles the gate EXCEPT in interlude(localConfirmed:true), where the
      // user keeps publishing plaintext (their authorization came from the
      // user, not from group state).
      return keep();
  }
}

/**
 * Whether a confirmed interlude survives a control-plane re-secure — the
 * invariant-1 withdrawal rule. Consumed at exactly two sites in
 * `mlsCallSession`: `#dropModeToNegotiating` (the `#rejoinFresh` /
 * `#poisonedSuccessor` / `#onRemovedSelf` entry, which otherwise folds the
 * mode to `negotiating` and re-asserts its gate) and `#resetEnableState`
 * (which otherwise drops `#e2eeEnabled` / the enable window for the new
 * group). Both used to test `interlude && localConfirmed` inline.
 *
 * A NATIVE confirm is the per-device, group-bound authorization invariant 1
 * names; it stays sticky, because its grant was made against the group and
 * the user keeps publishing plaintext on their own authority. An APP confirm
 * was made where no usable group existed (or the native dialog failed for a
 * reason other than a decline): it authorized THIS plaintext window and
 * nothing about the group the re-secure is about to establish, so the
 * re-secure withdraws it — the mode drops to `negotiating`, the gate holds,
 * and the user is asked again if the next group fails too. Without this the
 * in-app route would mint a second, permanently sticky interlude.
 */
export function interludeStickyAcrossResecure(
  mode: CallMode | undefined,
): boolean {
  return (
    mode?.kind === "interlude" &&
    mode.localConfirmed &&
    mode.confirmedVia !== "app"
  );
}

// ---- The §4.4 dual-gated chip ----------------------------------------------

export type ChipState =
  | "none"
  | "e2ee"
  | "e2ee_unverified"
  | "resecuring"
  // A CONTROL-plane latch on a device that still holds a live send key, with
  // every local publication declared GCM and the decode witness reporting
  // nothing dropping: the media plane never failed, but the group can no
  // longer be vouched for. "We can't confirm" — loud (the gate is HELD, the
  // banner offers Rejoin / Leave / Stay unencrypted), but not the positive
  // claim "not encrypted", which the 09-08 reading made over frames every
  // peer was decrypting fine.
  | "cannot_verify"
  | "not_encrypted";

// ---- Gate (d): the decode witness ------------------------------------------

/**
 * One sender's arrival tally at one key index, as the E2EE worker reports it.
 *
 * The worker reads the key index off EVERY arriving frame before it decides
 * whether to drop it, so this is the one witness that is both a LOCAL fact and
 * INDEX-scoped. `RTCRtpReceiver.getStats()` is neither: `framesDecoded` and
 * `totalSamplesReceived - concealedSamples` are counted after the worker's
 * server-injected-frame passthrough, so SFU-injected blank and Opus-silence
 * frames advance them for a participant whose real frames are being dropped
 * (M10), and they name a participant rather than an index.
 */
export interface DecodeIndexTally {
  keyIndex: number;
  /** Frames that ARRIVED at this index during the window. */
  seen: number;
  /**
   * Of those, how many the worker threw away because it had marked that index
   * invalid. Non-zero is not an absence of evidence — it is the failure
   * itself, measured: this device is being sent frames it silently discards.
   */
  dropped: number;
}

/** One sender's tallies in one window. */
export interface DecodeWitnessSample {
  identity: string;
  indexes: readonly DecodeIndexTally[];
}

/** Gate (d)'s input: the latest window the worker reported. */
export interface DecodeWitness {
  /**
   * A sample arrived recently enough to judge on.
   *
   * 🔴 FALSE IS AMBER, and that is the whole inversion. A build that lost the
   * patch, a worker that died, a listener that was never armed — each stops
   * the heartbeat, and the chip degrades to amber instead of quietly losing
   * the gate. Exempting on "no evidence" is the reasoning that produced the
   * silent green six review rounds kept finding in a new place.
   *
   * 🔴 What it does NOT prove. The worker posts on an interval at module
   * scope, before `init` and independently of whether any transform is
   * installed or any frame has ever been seen. `available: true` therefore
   * means "the patched worker is in this bundle" and nothing more — never
   * "this peer is being witnessed". Only a non-empty `dropping` is positive
   * evidence of anything, and only about the senders it names.
   */
  available: boolean;
  /**
   * Senders whose frames ARRIVED and were DROPPED at an index this device
   * silenced — "the sender is still using an index we cannot read".
   */
  dropping: readonly string[];
  /** Senders whose frames arrived and got through. Diagnostic, not a gate. */
  live: readonly string[];
}

/** No sample: gate (d) cannot judge, so it holds the chip amber. */
// Frozen: this exact object is the signal's initial value, is re-handed on
// every stale tick and on teardown, and is aliased by DECODE_WITNESS_INITIAL.
// One consumer mutating `dropping` in place would poison the amber sentinel
// for the life of the process. Nothing does today; freezing keeps it that way
// loudly rather than by convention.
export const DECODE_WITNESS_UNAVAILABLE: DecodeWitness = Object.freeze({
  available: false,
  dropping: Object.freeze([]),
  live: Object.freeze([]),
});

/**
 * Reduce a window of worker tallies to gate (d)'s input.
 *
 * A sender counts as `dropping` if ANY of its indexes lost a frame, and as
 * `live` if any index got one through. Both can be true at once — a sender
 * mid-rotation is briefly sending at two indexes — and `dropping` is what the
 * gate reads, because a sender whose new index we can read is still having its
 * old-index frames discarded until it stops using that index.
 */
export function summarizeDecodeWitness(
  participants: readonly DecodeWitnessSample[],
): DecodeWitness {
  const dropping: string[] = [];
  const live: string[] = [];
  for (const participant of participants) {
    let drop = false;
    let ok = false;
    for (const tally of participant.indexes) {
      if (tally.dropped > 0) drop = true;
      if (tally.seen > tally.dropped) ok = true;
    }
    if (drop) dropping.push(participant.identity);
    if (ok) live.push(participant.identity);
  }
  return { available: true, dropping, live };
}

/**
 * What the chip knows about a latched call-encryption error: where it came
 * from and whether this device was KEYED when it latched.
 *
 * `origin` is `undefined` for the two latches `state.tsx` writes directly
 * (the store-owner identity mismatch and `sessionSetupDecision`'s
 * `hold_loud`) — neither went through `#latchLoud`, so neither carries a
 * `LoudLatchMeta`; they read `not_encrypted` unconditionally. `mediaKeyed`
 * is `#latchLoud`'s snapshot at latch time: E2EE on, a local send key held,
 * the local declaration not plaintext, and the error not a
 * `MissingLocalFrameKeyError` (which reads keyed while the CURRENT epoch key
 * is absent). A media→control upgrade emits `mediaKeyed: false` — a plane
 * that already failed never reads keyed.
 */
export interface ChipLatch {
  origin: LoudLatchOrigin | undefined;
  mediaKeyed: boolean;
}

/** A snapshot of everything the chip derivation reads. */
export interface ChipInputs {
  /** No session at all (non-capable shell / never constructed). */
  hasSession: boolean;
  /** The session lifecycle state (when `hasSession`). */
  sessionState?:
    | "starting"
    | "active"
    | "plaintext"
    | "resecuring"
    | "failed"
    | "closed";
  /** The §3.4 call mode (when `hasSession`). */
  mode?: CallMode;
  /** LiveKit E2EE mode is on + our first local send-key is installed. */
  e2eeEnabled: boolean;
  hasLocalKey: boolean;
  /** A rotation-window RE-SECURING is active (media-plane debounce). */
  resecuring: boolean;
  /**
   * The latched call-encryption error's provenance, or `undefined` when
   * nothing is latched. Replaces the boolean it used to be: the chip now
   * splits a latch by origin and by whether the send side was keyed, so it
   * needs the record, not the fact of one. The banner and the release rule
   * still take the boolean ("a gate is held") — `CallBannerInputs` /
   * `PlaintextReleaseInputs`.
   */
  latch: ChipLatch | undefined;
  /**
   * The current SFU participants WITH ≥1 published track (FE-2: only these
   * ever report a LiveKit encryption status; trackless listeners are covered
   * by MLS membership + verification, not gate (b)).
   */
  publishingIdentities: readonly string[];
  /** LiveKit's observed per-participant encryption status (identity → bool). */
  observedEncrypted: ReadonlyMap<string, boolean>;
  /**
   * Every LOCAL publication is on the SFU's record as GCM (vacuous when we
   * publish nothing). The observed status above witnesses the worker's
   * cryptor, not the declaration receivers arm their cryptors from: a mic
   * publish still in flight when E2EE was enabled lands declared NONE, the
   * worker still says "encrypted", and every peer disarms for us and hears
   * nothing while this chip read green (desktop 0.57.0, 2026-09-06). The
   * session re-declares such publications; until it has, the chip must
   * not vouch for them. Derived by `localPublicationsEncrypted`.
   */
  localPublicationsEncrypted: boolean;
  /** The VERIFIED MLS roster: every member's `user_verified` flag. */
  rosterVerified: readonly boolean[];
  /**
   * The channel has an open MLS group — the FE-7 probe, answered ONCE at
   * connect and never re-asked. That staleness is why it cannot be the only
   * term below.
   */
  channelHasOpenGroup: boolean;
  /**
   * This shell COULD encrypt calls and this install is not set up for it —
   * `encryptionSetupAvailable(readiness)`. A LOCAL fact, so unlike the probe
   * it is always current. Without it a never-enrolled desktop that joined
   * before the group opened stayed on chip `none` for the whole call — silent
   * on the side whose media is in the clear, while every peer paused behind
   * the mixed banner naming it (media-e2ee-reviewer, HIGH-4).
   */
  deviceNeedsSetup: boolean;
  /**
   * At least one OTHER participant is device-qualified on the SFU, i.e.
   * someone here can encrypt. LIVE — re-read on every participants-version
   * bump — which is what makes it usable where the open-group probe is not.
   *
   * It is what keeps `deviceNeedsSetup` from shouting on a call where nobody
   * is encrypting: `shellSupported` is true on every Tauri desktop and every
   * native Android build, not just the platforms media E2EE has shipped on,
   * so an unqualified local term would have put a red chip and an
   * undismissable strip on EVERY call for every install that never turned
   * encryption on — including plain calls with nothing to downgrade
   * (media-e2ee-reviewer round 3, finding 2).
   */
  peerCouldEncrypt: boolean;
  /**
   * Gate (d) — the worker's decode witness. Required, never optional: a
   * permissive default would restore green-by-default at the one place this
   * whole change exists to remove it.
   */
  decodeWitness: DecodeWitness;
}

/**
 * Derive the §4.4 chip. DUAL-GATED green (invariant 11 / amendment A1):
 * (a) native control-plane health, (b) LiveKit-observed per-participant
 * encryption over TRACK-PUBLISHING participants AND every local publication
 * declared GCM to the SFU, (c) every roster member user-verified. Neither gate alone is green; either's absence drops to
 * resecuring/not_encrypted (fail-closed). Server flags can never promote.
 * Precedence: not_encrypted / cannot_verify (the two LOUD values, ordered by
 * the rows below) > resecuring > e2ee_unverified > e2ee > none.
 */
export function chipState(inputs: ChipInputs): ChipState {
  const mode = inputs.mode?.kind;
  const latch = inputs.latch;

  // ---- loud — highest precedence. The order of record (rows 1–6) ----------
  //
  // Rows 1–6 read ONLY `mode`, `latch`, `sessionState === "failed"` and,
  // under row 4, `localPublicationsEncrypted` + the decode witness. Every
  // other input reaches the no-session arm below exactly as before.
  // `pauseDisproved` is NOT an input here: it is a withdrawal-only signal by
  // pinned design (it may contradict a claimed pause, never escalate a chip).
  //
  // Row 1 — the §3.4 downgrade modes. Plaintext is live or being offered.
  if (mode === "mixed" || mode === "interlude" || mode === "call_full") {
    return "not_encrypted";
  }
  // Row 2 — a latch with no origin: the two direct `state.tsx` writers (the
  // store-owner identity mismatch, `sessionSetupDecision`'s `hold_loud`).
  // Neither came through `#latchLoud`, so there is no snapshot to split on.
  if (latch !== undefined && latch.origin === undefined) {
    return "not_encrypted";
  }
  // Row 3 — a MEDIA latch: frames failed to decrypt outside every window, or a
  // re-securing that never resolved. The media plane itself is broken.
  if (latch?.origin === "media") return "not_encrypted";
  // Row 4 — the ONE rule that yields `cannot_verify`: a CONTROL latch taken
  // while this device was KEYED (`mediaKeyed` — see `ChipLatch`), with every
  // local publication on the SFU's record as GCM and the decode witness
  // reporting no sender's frames being dropped. The group can no longer be
  // vouched for, but nothing says the media plane failed — "we can't
  // confirm", not "not encrypted". No `decodeWitness.available` conjunct: a
  // seat whose witness is `unavailable` (unpatched bundle, dead worker, stale
  // tick) cannot support the POSITIVE claim "Not encrypted" either — "we
  // can't confirm" is exactly what `unavailable` means. First-join control
  // latches are un-keyed regardless (`#hasLocalKey` is only set after a
  // Welcome install), so this cannot soften a first-join failure.
  if (
    latch?.origin === "control" &&
    latch.mediaKeyed &&
    inputs.localPublicationsEncrypted &&
    inputs.decodeWitness.dropping.length === 0
  ) {
    return "cannot_verify";
  }
  // Row 5 — any other latch (an un-keyed control latch: a spent join ladder,
  // the local-declaration seam, a media→control upgrade, a re-establish cap
  // reached after `#resetRotationState` wiped the keys).
  if (latch !== undefined) return "not_encrypted";
  // Row 6 — `failed` with NO latch: the fail-closed backstop for any path to
  // `failed` that skipped `#latchLoud`. It sits BELOW the latch rules on
  // purpose: `#onLoud` sets `failed` BEFORE it calls `#latchLoud` — the ONLY
  // `#setState("failed")` in the session — so every `#onLoud` caller latches
  // with `sessionState === "failed"`, and the keyed mid-call control sites
  // (a native build that threw, a DS commit arbitration classified failed, a
  // destroyed envelope) must reach row 4. `failed` is decided by the latch
  // rules; this row only catches a `failed` nothing latched.
  if (inputs.sessionState === "failed") return "not_encrypted";
  // NO SESSION. Two independent reasons this is a downgrade rather than a
  // quiet plain call, and either is enough:
  //
  //  (a) the channel HAS an open group — someone is encrypting and we are not.
  //      Covers ME-7/R2-4 (a capable shell whose session failed to construct,
  //      a downgrade the user can't see) and the §0.2 #9 self-attribution for
  //      a shell that can never encrypt. The old `capableAndEnabled` split of
  //      this arm is gone: both halves always returned the same chip, and the
  //      BANNER is what needs them told apart (`callBanner` reads the
  //      readiness).
  //  (b) this device could encrypt, is not set up here, and someone else in
  //      the call CAN encrypt. Local and live, so unlike (a) it cannot go
  //      stale when the group opens after the probe answered — and unlike an
  //      unqualified local term it says nothing on a call where there is no
  //      encryption to be left out of.
  if (
    !inputs.hasSession &&
    (inputs.channelHasOpenGroup ||
      (inputs.deviceNeedsSetup && inputs.peerCouldEncrypt))
  ) {
    return "not_encrypted";
  }

  // ---- none — no session / not an E2EE call / still starting -------------
  if (
    !inputs.hasSession ||
    inputs.sessionState === "starting" ||
    inputs.sessionState === "plaintext" ||
    mode === "off"
  ) {
    return "none";
  }

  // Native control-plane gate (a): active + enabled + first key + not
  // resecuring + no latched error.
  const nativeHealthy =
    inputs.sessionState === "active" &&
    mode === "e2ee" &&
    inputs.e2eeEnabled &&
    inputs.hasLocalKey;

  // ---- resecuring (amber, bounded) ---------------------------------------
  if (inputs.sessionState === "resecuring" || inputs.resecuring) {
    return "resecuring";
  }
  if (!nativeHealthy) {
    // Enabled-but-not-yet-fully-healthy (e.g. mid-negotiation with an open
    // group): amber, not green. `negotiating` mode lands here.
    return "resecuring";
  }

  // Media-plane gate (b): every TRACK-PUBLISHING participant observed
  // encrypted. A missing entry is NOT green (fail-closed). No publishers yet
  // (everyone muted) ⇒ (b) is vacuously satisfied — (a)+(c) carry it.
  const mediaObserved = inputs.publishingIdentities.every(
    (identity) => inputs.observedEncrypted.get(identity) === true,
  );
  // Media-plane gate (d): a FRESH worker sample, in which no sender's frames
  // are being discarded by the decode path.
  //
  // 🔴 Scope, stated where the gate is. RECEIVE-SIDE only: it witnesses frames
  // arriving at this device, so a local send-index regression (the `getKeys()`
  // replay past the key-ring wrap) is invisible here — every peer goes amber
  // and the sender stays green. It covers only senders CURRENTLY sending: a
  // muted, unsubscribed, or SFU-withheld peer owes no witness and is exempt by
  // construction. It is a positive measurement of discards, not a proof of
  // authenticated decryption.
  //
  // This is the gate that inverts the default. Gates (a)-(c) are all read from
  // objects whose absence means "fine": a verdict that was destroyed without
  // evidence, or never created, reads as green through every one of them, which
  // is how six review rounds each found the same silent green in a different
  // place. This one needs a positive measurement, refreshed every second, of
  // the frames actually arriving. It can only ever withhold a green — it never
  // latches, never clears, and never promotes.
  const decodeWitnessed =
    inputs.decodeWitness.available &&
    inputs.decodeWitness.dropping.length === 0;
  if (
    !mediaObserved ||
    !inputs.localPublicationsEncrypted ||
    !decodeWitnessed
  ) {
    // (a) holds but (b) not yet satisfied for a publishing participant, or
    // one of OUR OWN publications is not on record as GCM — bounded amber
    // (the session arms the 10 s escalation → loud, R2-2, and republishes
    // the local declaration).
    return "resecuring";
  }

  // Verification gate (c).
  //
  // 🔴 A non-empty roster is REQUIRED, not incidental. `[].every(v => v)` is
  // `true`, so an empty read used to promote `e2ee_unverified` straight to
  // `e2ee` — a VERIFIED lock, the strongest claim the product makes, resting
  // on nobody having been verified. It is reachable in a legitimate call:
  // `callRoster` is seeded empty and is only written by `#reconcileOnce`,
  // which returns early unless the session is `active`, so there is a window
  // on every call before the first native `callState()` round-trip resolves —
  // and if that bridge call keeps throwing (store-owner mismatch, a native
  // panic, a lost group id) it is swallowed and the roster stays empty for the
  // life of the call while the session stays active.
  //
  // §4.4 requires "all leaf bindings verified" for green. An unloaded roster
  // has verified no leaf bindings, so it cannot vouch. A healthy MLS group
  // always contains at least our own leaf.
  const allVerified =
    inputs.rosterVerified.length > 0 && inputs.rosterVerified.every((v) => v);
  return allVerified ? "e2ee" : "e2ee_unverified";
}

/**
 * ME-10 terminal-loud (slice 6.5): the call FAILED to secure — the banner
 * offers the blocking Leave / Stay-unencrypted choice, plus Reset encryption
 * on a store-owner mismatch.
 *
 * Two shapes count. `negotiating` is the original one: retry exhaustion or a
 * loud failure while the verdict was still pending. `mode === undefined` with
 * a latched error is the same state seen one step earlier: a refusal thrown
 * inside establish() (the store-owner mismatch is exactly this) fails the
 * session before it ever emits a mode verdict, so the UI's mode signal still
 * reads undefined — requiring `negotiating` made the banner, and with it the
 * only Reset-encryption control in a call, unreachable on precisely the
 * install it was built for. The latched-error requirement keeps this off
 * web/plaintext calls: their chip also reads not_encrypted (open-group
 * attribution, no session), but nothing ever latches there.
 *
 * A loud verdict that lands AFTER the mode reached `e2ee` is folded into the
 * first shape by the session, not widened here: `loudModeFallback` drops the
 * mode back to `negotiating` (re-asserting the negotiating publish gate in
 * lockstep), so the same banner, the same "Stay unencrypted" / Leave escape
 * and the same `confirmPlaintext` guard serve it.
 *
 * Both LOUD chip values count: `cannot_verify` is a control latch taken while
 * keyed, which `#onLoud` folds to `negotiating` (or leaves before any
 * verdict) exactly like `not_encrypted`; the gate is held either way and the
 * same escape serves it.
 */
export function isTerminalLoud(
  mode: CallMode | undefined,
  chip: ChipState,
  latchedError: boolean,
): boolean {
  if (chip !== "not_encrypted" && chip !== "cannot_verify") return false;
  if (mode?.kind === "negotiating") return true;
  return mode === undefined && latchedError;
}

// ---- Which banner a chip must carry (the no-dead-end invariant) ------------

/**
 * The KIND axis of the banner the call card renders — Line A: what is wrong
 * and which escape is offered. The second axis, `PauseClause`, is Line B:
 * what may be said about the publish gate. `callBanner` derives both; the
 * raise predicate is `kind !== "none"`.
 *
 * - `securing` — the held-gate stretch of a join or rejoin: a session exists,
 *   no verdict has landed yet (`mode` is `undefined` on a first join,
 *   `negotiating` on a rejoin) and the chip is not red. A NOTICE, not a
 *   downgrade: it parks nothing and offers no escape. It exists because that
 *   stretch was chip-less AND banner-less — up to ~43 s on a stuck first join
 *   before the joiner ladder latched — so a pause disproof inside it had no
 *   surface at all. Evaluated AFTER every red and device arm, never before.
 * - `mixed` / `interlude` — the §3.4 downgrade states. Publishing is paused
 *   (mixed) or explicitly resumed in plaintext (interlude); the escape is
 *   "Turn off encryption" / "Resume unencrypted".
 * - `device_not_set_up` — this shell COULD encrypt calls but this install is
 *   not set up for the signed-in account: never enrolled, wiped, or holding a
 *   device the server refuses. The cause and the remedy are the DEVICE's, so
 *   it does not borrow the call-failure copy. Whether publishing is paused
 *   differs by cause (see `callEncryptionCapable`), which is why the caller —
 *   not this rule — decides whether to offer the plaintext release.
 * - `device_unsupported` — this shell can never encrypt calls (a browser, an
 *   unaudited build). Nothing to set up; the escape is Leave.
 * - `terminal_loud` — ME-10: the DEVICE is fine and the CALL failed to secure.
 *   Publishing is held by the `negotiating` gate; the escape is Leave / Stay
 *   unencrypted (plus Reset encryption on a store-owner mismatch). Requires a
 *   LATCHED error, because that is what makes its `held` clause — "your audio
 *   and video should stay paused" — a claim about a gate that is asserted.
 * - `unencrypted_notice` — the honest floor: a red chip nothing above claimed,
 *   with nothing latched, so no pause may be promised and no release offered.
 *   Unreachable today (every red chip on a `ready` device latches); it exists
 *   so the backstop cannot lie the way the previous one did.
 * - `cannot_verify` — the chip's `cannot_verify`: a control latch taken while
 *   this device was keyed, media plane clean. Publishing is held by the
 *   `negotiating` gate (`loudModeFallback` / `#onLoud`); the copy says the
 *   group can't be confirmed, never "not encrypted" or "could not be
 *   secured". The escape is Rejoin / Leave / Stay unencrypted. Only ever
 *   reached WITH a session, so the device is `ready` by construction.
 */
export type CallBannerKind =
  | "none"
  | "securing"
  | "mixed"
  | "interlude"
  | "terminal_loud"
  | "cannot_verify"
  | "device_not_set_up"
  | "device_unsupported"
  | "unencrypted_notice";

/**
 * The PAUSE axis — Line B: what this banner may say about the publish gate.
 *
 * - `held` — a gate is asserted for this kind (`negotiating` on a securing /
 *   loud / can't-verify call, `mixed`, the unconfirmed interlude, the R2-4
 *   hold on a refused device), so the copy may say publishing SHOULD be
 *   paused. Hedged on purpose: a held gate is a claim about what was ISSUED,
 *   never a proof about the wire.
 * - `disproved` — the publish-gate episode saw a live wire under a held gate
 *   and a confirming re-sweep agreed (`callPauseDisproofConfirmed`). It
 *   overrides every kind: the copy withdraws the pause and points at Leave.
 * - `none` — nothing is held (a confirmed interlude, a device that never
 *   attempted encryption, no banner), so nothing about a pause may be said.
 *
 * "proven" is deliberately UNREPRESENTABLE. The verdict beneath this is
 * two-valued: proven-quiet and unknown are the SAME `{ value: false,
 * confirmed: false }` object (`pauseVerdict.ts`, `publishGateEpisode.ts`),
 * and making "proven" a value is a producer change pinned OUT by mutation
 * `episode-quiet-arm-withdrawal-claims-confirmed`. So `held` is the strongest
 * claim this type can carry, and no arm may ever assert a pause as fact.
 */
export type PauseClause = "none" | "held" | "disproved";

/** What `callBanner` hands the card: both axes, derived together. */
export interface CallBanner {
  readonly kind: CallBannerKind;
  readonly pause: PauseClause;
}

export interface CallBannerInputs {
  /** The §4.4 chip, from `chipState`. */
  chip: ChipState;
  /** The §3.4 call mode (undefined before any verdict). */
  mode: CallMode | undefined;
  /**
   * A structured call-encryption error is latched.
   *
   * Load-bearing, not decoration: on every reachable path the latch and the
   * held `negotiating` gate are asserted together (`sessionSetupDecision`'s
   * `hold_loud`, `#onLoud`), so it is the term that decides whether a banner
   * may claim publishing is paused. It was accepted and ignored once, which
   * is exactly how a red strip came to promise a pause over a live mic
   * (media-e2ee-reviewer, MEDIUM-1).
   */
  latchedError: boolean;
  /**
   * WHY this device is or is not encrypting, from `e2eeDeviceReadiness` —
   * the whole four-valued reason, deliberately not a boolean. Collapsing it
   * made `unsupported` ("this app can't encrypt calls", a POSITIVE fact) the
   * fallback for "we don't know", which is the most reassuring and least
   * actionable thing to say to someone whose call just failed
   * (media-e2ee-reviewer, F4).
   */
  readiness: CallEncryptionReadiness;
  /**
   * An MLS call session exists (`Voice.#mlsSession !== undefined`) — the
   * discriminator for `securing`, and deliberately not `mode`. `mode` is
   * `undefined` before the first verdict on a FIRST join (the session's
   * initial `negotiating` is a field initialiser, never pushed through
   * `#setMode`), which is the same value it has with no session at all; and
   * the session-less setup arms (`hold_loud`, `owned_elsewhere`) hold the
   * `negotiating` gate without ever building one. Only a session is actually
   * securing anything. Without one the readiness arms own the banner, so a
   * device-not-set-up seat never reads `securing`.
   */
  hasSession: boolean;
  /** `callPauseDisproved()` — `PauseDisproofVerdict.value`, the alarm. */
  pauseDisproved: boolean;
  /**
   * `callPauseDisproofConfirmed()` — `PauseDisproofVerdict.confirmed`; this
   * is its first runtime consumer. A `{ value: true, confirmed: false }`
   * verdict is a SINGLE observation promoted to the alarm because the
   * episode's confirm budget ran out. It stays `held` here — whose copy
   * already hedges — rather than withdrawing the pause on evidence the
   * 2026-09-08 false red taught this slice not to act on alone.
   */
  pauseDisproofConfirmed: boolean;
}

/**
 * THE INVARIANT: `chipState(x) ∈ { "not_encrypted", "cannot_verify" }` implies
 * `callBanner(...).kind !== "none"`, for every readiness. A LOUD chip always
 * carries a banner and an escape — enforced by an exhaustive spec over the
 * chip's whole input space, not by inspection. `cannot_verify` was added to
 * the chip in wave 2 and would have been BANNERLESS through the
 * `!== "not_encrypted"` guard below while that spec still sampled only
 * `not_encrypted` — which is why the guard is widened there and the spec's
 * filter alongside it.
 *
 * The second axis does not weaken the first. `pause` never decides whether a
 * banner is raised — `kind` alone does — it decides what Line B may claim
 * about the gate under that kind, and `disproved` can only WITHDRAW a pause
 * the kind's copy would otherwise hedge. Nothing on the pause axis can turn a
 * `none` into a banner or a banner into a `none`.
 *
 * It did not hold before. `isTerminalLoud` requires a latched error, and the
 * chip's two NO-SESSION branches (ME-7 "capable, no session, open group" and
 * the §0.2 #9 self-attribution) latch nothing — nobody attempted encryption,
 * so nothing could fail. Those were read as attribution rather than failure and
 * deliberately given no banner. For a browser that reading is right; for a
 * desktop install that could encrypt and simply is not set up it is a downgrade
 * with a one-click remedy the user is never shown, which is the §7.4
 * observation this closes.
 *
 * 🔴 The invariant is about the chip, and the chip is not the whole story: both
 * no-session branches are gated on `channelHasOpenGroup`, a server probe run
 * ONCE at connect. A device that cannot encrypt, alone in a channel with no
 * group yet, gets chip `none` and therefore no banner from this rule — so a
 * device that must not go quiet has to stay E2EE-CAPABLE and latch, which puts
 * its chip red through its latch — a direct `state.tsx` write with no origin,
 * row 2 of `chipState` — with no probe involved. That is what
 * `callEncryptionCapable` does for `owned_elsewhere`, and it is the reason it
 * is not simply "not an E2EE call". The remaining case — a never-enrolled
 * install (`needs_setup`) in a channel whose group opens after the probe
 * answered — is pre-existing on main and recorded as a follow-up, with a spec
 * below that pins the gap rather than letting it hide.
 *
 * ORDER IS PART OF THE RULE. `redBannerKind` — every red and device arm, as
 * one table — is evaluated first and in full; only a chip it reads as not red
 * goes on to the `securing` question. So `securing` can never mask
 * `device_not_set_up` / `device_unsupported` / `cannot_verify` / a latched
 * loud state: a session implies readiness `ready`, and the session-less setup
 * arms have no session to be securing with.
 */
export function callBanner(inputs: CallBannerInputs): CallBanner {
  let kind = redBannerKind(inputs);
  if (kind === "none" && securingReachable(inputs)) kind = "securing";
  return { kind, pause: pauseClauseFor(kind, inputs) };
}

/**
 * The `securing` rule, stated once: a session exists, no verdict has landed
 * (`mode` undefined on a first join, `negotiating` on a rejoin) and the chip
 * is not red. The chip conjunct is redundant behind `redBannerKind` — a red
 * chip never reaches here — and is kept so the rule reads whole on its own,
 * as the slice-6.5 banner plan states it, and so a future caller that does
 * not come through the red table still cannot read a red chip as securing.
 */
function securingReachable(inputs: CallBannerInputs): boolean {
  return (
    inputs.hasSession &&
    (inputs.mode === undefined || inputs.mode.kind === "negotiating") &&
    inputs.chip !== "not_encrypted" &&
    inputs.chip !== "cannot_verify"
  );
}

/**
 * The red and device arms — the whole pre-wave-3 banner table, unchanged.
 * `none` from here means "the chip is not red", which is the ONE place
 * `callBanner` goes on to ask about `securing`; it is not the final answer.
 */
function redBannerKind(inputs: CallBannerInputs): CallBannerKind {
  const mode = inputs.mode?.kind;
  if (mode === "mixed") return "mixed";
  if (mode === "interlude") return "interlude";
  // `cannot_verify` is only reachable WITH a session (a keyed control latch),
  // and a session implies readiness `ready`, so the device arms below have
  // nothing to say about it; it gets its own banner here, ahead of the guard
  // that would otherwise read it as "not red" and return `none`.
  if (inputs.chip === "cannot_verify") return "cannot_verify";
  if (inputs.chip !== "not_encrypted") return "none";

  // The device arms outrank the loud one: when the reason this call is not
  // encrypted is the device, showing the loud "could not be confirmed" copy
  // and offering only a per-call escape sends the user round the loop again
  // on their next call.
  switch (inputs.readiness) {
    case "unsupported":
      return "device_unsupported";
    case "needs_setup":
    case "owned_elsewhere":
      return "device_not_set_up";
    case "ready":
      break;
  }

  // A `ready` device with a red chip is a CALL failure. Everything left lands
  // here — the two `isTerminalLoud` shapes, the `call_full` auto-leave, and any
  // red state a future change invents — so nothing can return `none` from here
  // by omission. `isTerminalLoud` has no production caller any more (the
  // `callTerminalLoud` accessor is gone); only the harness's `terminalLoud()`
  // and the specs read it, and it is not the gate for this.
  //
  // The latch is what makes the loud copy true. Every reachable red chip on a
  // `ready` device has one: `sessionSetupDecision` latches on every
  // capable-but-sessionless arm, `#onLoud` latches before `call_full`, and a
  // session that reached `failed` came through `#onLoud`. An unlatched one
  // would mean no gate is held, so it gets the floor instead of a promise.
  return inputs.latchedError ? "terminal_loud" : "unencrypted_notice";
}

/**
 * The pause axis for a kind — Line B. `callBanner` is the entry the app
 * calls; this is exported so the table can be pinned by itself.
 *
 * | kind                              | pause      |
 * |-----------------------------------|------------|
 * | any, verdict `{true, true}`       | disproved  |
 * | securing                          | held       |
 * | mixed                             | held       |
 * | interlude, !localConfirmed        | held       |
 * | interlude, localConfirmed         | none       |
 * | terminal_loud                     | held       |
 * | cannot_verify                     | held       |
 * | device_not_set_up, refused device | held       |
 * | device_not_set_up, never enrolled | none       |
 * | device_unsupported                | none       |
 * | unencrypted_notice                | none       |
 * | none                              | none       |
 *
 * `disproved` needs BOTH halves of the verdict: `{ value: true, confirmed:
 * false }` is a budget-exhausted single observation and stays on the kind's
 * own row. The refused device is `owned_elsewhere` — the one readiness that
 * is still capable, so `sessionSetupDecision` answers `hold_loud` for it: the
 * `negotiating` gate is asserted and the error latched in one step (see
 * `callEncryptionCapable`). `needs_setup` attempts nothing and holds nothing.
 */
export function pauseClauseFor(
  kind: CallBannerKind,
  inputs: CallBannerInputs,
): PauseClause {
  // A hidden banner carries no pause clause: nothing renders it, and a
  // transient `{ none, disproved }` would otherwise park the float for a
  // beat through `bannerParksFloat`. The verdict is reset at the 1→0 edge
  // anyway (`endEpisode` / `resetForCall` write `{ false, false }`).
  if (kind === "none") return "none";
  if (inputs.pauseDisproved && inputs.pauseDisproofConfirmed) {
    return "disproved";
  }
  switch (kind) {
    case "securing":
    case "mixed":
    case "terminal_loud":
    case "cannot_verify":
      return "held";
    case "interlude":
      return inputs.mode?.kind === "interlude" && inputs.mode.localConfirmed
        ? "none"
        : "held";
    case "device_not_set_up":
      return inputs.readiness === "owned_elsewhere" ? "held" : "none";
    case "device_unsupported":
    case "unencrypted_notice":
      return "none";
  }
  // `none` was returned above; the guard narrowed it away, so it is absent here.
  const exhaustive: never = kind;
  return exhaustive;
}

/**
 * Whether a banner must park the Float-level Watch Together player host.
 *
 * The card banner sits at z5 INSIDE the call card and the player host floats
 * above the card, so a banner the user is meant to read and act on has to
 * displace it. That is true of the three §3.4 states and of `cannot_verify` —
 * each has an in-call control that clears it (Rejoin / Leave / Stay
 * unencrypted for the latter), so the park is transient by construction — and
 * of ANY kind whose pause is `disproved`: "your microphone, camera or screen
 * share may still be sending; leave to stop it" is the one line the user must
 * not be able to miss, and Leave clears it.
 *
 * 🔴 It is NOT true of the device banners. `device_not_set_up`,
 * `device_unsupported` and `unencrypted_notice` describe the DEVICE, and
 * nothing in the call clears them: parking on those un-anchors the player for
 * the entire call, with no control that brings it back and no copy that says
 * why. Testing `!== "none"` did exactly that and is how this rule earned a name
 * (media-e2ee-reviewer round 5, MEDIUM). They still need a z-order that beats
 * the player; that is a layout fix, not a reason to hide the video.
 *
 * 🔴 Nor of `securing`, held or not. It is a notice over a join that is
 * expected to succeed, with no control that clears it; parking the player on
 * every join would teach the user the notice is an interruption, not
 * information. Only its `disproved` row parks — through the pause clause,
 * never the kind.
 */
export function bannerParksFloat(banner: CallBanner): boolean {
  return (
    banner.kind === "mixed" ||
    banner.kind === "interlude" ||
    banner.kind === "terminal_loud" ||
    banner.kind === "cannot_verify" ||
    banner.pause === "disproved"
  );
}

/**
 * Whether the banner's plaintext release would release anything.
 *
 * With a session the session owns it (`confirmPlaintext`). Without one it is
 * the R2-4 hold, whose terms `canConfirmNoSessionPlaintext` checks; the two
 * here stand in for all of them, because the hold latches the error and
 * asserts the `negotiating` gate in the same step and the only thing that
 * empties the gate is `#confirmNoSessionPlaintext`, which flips the mode to a
 * confirmed interlude — a different banner.
 *
 * Keeps the button off the banners where nothing is paused (a never-enrolled
 * device, a shell that cannot encrypt), where pressing it is a silent no-op,
 * and off `call_full`, which is terminal in the session so `confirmPlaintext`
 * returns immediately. Lives here rather than on `Voice` because it is the
 * rule that decides whether a user is offered a plaintext downgrade, and the
 * Voice class cannot be loaded under `node --test`.
 */
export interface PlaintextReleaseInputs {
  mode: CallMode | undefined;
  hasSession: boolean;
  /** The call's connect-time capability snapshot. */
  e2eeCapable: boolean;
  latchedError: boolean;
}

export function plaintextReleaseAvailable(
  inputs: PlaintextReleaseInputs,
): boolean {
  const mode = inputs.mode?.kind;
  if (mode === "call_full") return false;
  if (inputs.hasSession) {
    // With a session the session owns the release — but only where it has
    // something to release. `mixed` and `interlude` are its own downgrade
    // states and `negotiating` holds the gate; anything else needs the latch
    // that proves a gate is held, or `confirmPlaintext` returns immediately
    // and the button is the silent no-op this rule exists to prevent.
    return (
      mode === "mixed" ||
      mode === "interlude" ||
      mode === "negotiating" ||
      inputs.latchedError
    );
  }
  return inputs.e2eeCapable && inputs.latchedError;
}

// ---- ctl-announce payload parsing (default-closed forward-compat) ----------

/** The one recognised ctl semantics: a mode change to plaintext (§3.4). */
export interface CtlModeAnnounce {
  kind: "mode";
  mode: "plaintext";
  channelId: string;
  groupId: string;
}

/**
 * Parse a received ctl payload (ME-15 forward-compat, default-closed): the
 * ONLY actionable message is `{v:1, kind:"mode", mode:"plaintext", …}`.
 * Unknown `v`/`kind`, malformed JSON, or any mode other than exactly
 * `"plaintext"` returns null — a quiet no-op, never an action (there is NO
 * `mode:"e2ee"` trigger; re-upgrade is automatic-only). The caller
 * additionally checks the channel/group binding against the live call.
 */
export function parseCtlPayload(raw: string): CtlModeAnnounce | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.v !== 1) return null;
  if (obj.kind !== "mode") return null;
  if (obj.mode !== "plaintext") return null;
  if (typeof obj.channel_id !== "string" || typeof obj.group_id !== "string") {
    return null;
  }
  return {
    kind: "mode",
    mode: "plaintext",
    channelId: obj.channel_id,
    groupId: obj.group_id,
  };
}

// ---- LiveKit encryptionError classification (the §4.4 loud-state debounce) --

/**
 * Classify a LiveKit `encryptionError`: a missing key INSIDE a known rotation
 * window (an epoch change we are mid-processing, or within the Add-grace) is
 * `resecuring` (transient, bounded); the same error OUTSIDE a known window is
 * immediately `loud`. Clean rotations never flap because a correctly-graced
 * rotation produces no missing-key error.
 *
 * `awaitingFirstKey` (6.7b fix, found in the on-device Android×desktop
 * proof): a joiner that connects to the SFU while existing members are
 * ALREADY publishing encrypted frames receives those frames BEFORE its
 * Welcome resolves and its first key installs — LiveKit raises missing-key
 * `encryptionError`s that are EXPECTED join-in-progress noise, not a
 * media-plane failure. Classifying them loud latched the session terminally
 * (`#latchLoud` is by design not cleared by a later successful join), wedging
 * every rejoin/mid-call join whose admit takes longer than the first inbound
 * encrypted frame — near-certain on a real network (an on-device Android
 * admitter takes seconds); desktop↔desktop on one machine admits sub-second,
 * which is why the 6.4–6.6 desktop proofs never hit it. The window is
 * BOUNDED exactly like a rotation window: the caller arms the same
 * `RESECURE_ESCALATE_MS` escalation, so a join that never completes still
 * goes loud; the chip stays amber throughout (never green — chip gate (a)
 * requires the first local key) and the publish gate holds (no plaintext can
 * escape while re-securing).
 */
export function classifyEncryptionError(
  inRotationWindow: boolean,
  awaitingFirstKey: boolean,
): "resecuring" | "loud" {
  return inRotationWindow || awaitingFirstKey ? "resecuring" : "loud";
}

/**
 * What opened a §4.4 rotation window, which decides how long it stays
 * "known" (`rotationWindowMs`):
 *  - `grace` — an Add-driven local key install: the sender keeps the old key
 *    for the Add-grace, then everyone needs the commit to propagate;
 *  - `immediate` — a Remove-driven / first / fail-safe install: only the
 *    propagation settle;
 *  - `arbitration` — this member just SUBMITTED a commit for epoch N+1 and
 *    is awaiting the DS verdict. Whoever wins that epoch, its keys are not
 *    installed here yet, and if the winner is another member's Remove it
 *    switches its send key IMMEDIATELY on winning while OUR copy of the
 *    winning commit sits queued behind the per-group lock until our own
 *    submit returns 409 Lost. The loser therefore eats the winner's
 *    new-index frames BEFORE it can have processed the commit — and the two
 *    windows above are opened by that very processing, so they can never
 *    cover it. Measured live 2026-09-06 on a three-party call with member
 *    churn: the member that lost three leave-grace Remove races latched a
 *    terminal NOT-ENCRYPTED chip with no error of its own, while it kept
 *    decrypting everyone and everyone kept decrypting it.
 */
export type RotationWindowOpener = "grace" | "immediate" | "arbitration";

export interface RotationWindowBounds {
  /** The Add-grace the sender holds the old key for (`ADD_GRACE_MS`). */
  addGraceMs: number;
  /** Commit-propagation settle past any grace (`ROTATION_SETTLE_MS`). */
  settleMs: number;
  /** The bound on one submit round trip (`SUBMIT_TIMEOUT_MS`). */
  submitTimeoutMs: number;
}

/**
 * How long a rotation window stays known, by what opened it. An
 * `arbitration` window must outlast the submit round trip plus the inline
 * rebase that follows a Lost, so it is sized to the submit bound plus the
 * settle; the install that ends the rotation re-opens the window with its
 * own (shorter) `grace`/`immediate` length, so the long window never
 * outlives the rotation it covers by more than the settle.
 */
export function rotationWindowMs(
  opened: RotationWindowOpener,
  bounds: RotationWindowBounds,
): number {
  switch (opened) {
    case "grace":
      return bounds.addGraceMs + bounds.settleMs;
    case "immediate":
      return bounds.settleMs;
    case "arbitration":
      return bounds.submitTimeoutMs + bounds.settleMs;
  }
}

/**
 * The mode a session drops to when a LOUD verdict latches, or null to keep
 * the current mode.
 *
 * Only `e2ee` moves: a loud latch there (a failed commit, a media-plane
 * missing key outside every window, a destroyed envelope, a failed
 * self-enrolment re-check) left the chip red with NO banner and no way out —
 * `isTerminalLoud` renders the Leave / Stay-unencrypted banner for
 * `negotiating` (or no verdict yet) only, and `confirmPlaintext` guards its
 * terminal escape on `negotiating` too. Dropping to `negotiating` through the
 * session's `#setMode` also re-asserts the negotiating publish gate, so the
 * banner's `held` pause clause is honest (fail-closed, I3): a
 * session that can no longer vouch for the group must not keep publishing as
 * if it could.
 *
 * Every other mode keeps: `negotiating`/`undefined` already render the
 * terminal banner; `mixed` and `interlude` carry their own banners whose
 * buttons run the same native-confirmed plaintext path; `off` is a plain
 * voice call and `call_full` is terminal.
 */
export function loudModeFallback(mode: CallMode): CallMode | null {
  return mode.kind === "e2ee" ? { kind: "negotiating" } : null;
}

/**
 * The mode label a session may WRITE while a loud verdict is latched.
 *
 * `loudModeFallback` covers the ENTRY into loud: it drops `e2ee` to
 * `negotiating` so the terminal banner and its Leave / Stay-unencrypted
 * escape render. The mode machine keeps running underneath, though, and any
 * `mix_detected` → `mix_cleared` cycle under the latch (a peer's leave +
 * rejoin, a browser peer joining and leaving) ends in the T2 warm resume,
 * which wrote `e2ee` back — publish gate empty, chip still red from the
 * latched error, `isTerminalLoud` false, `confirmPlaintext` refusing.
 * Measured live 2026-09-07 on the L3 receiver after the publisher's rejoin:
 * red chip, no banner, no way out but leaving the call, and the pause the
 * banner had promised silently lifted.
 *
 * So while latched, `e2ee` is unreachable: it folds to `negotiating`, whose
 * `#setMode` lockstep re-asserts the negotiating publish gate (the banner's
 * `held` pause clause is honest again) and whose shape reads as a loud
 * banner kind. Every other label passes: `mixed` and `interlude`
 * carry their own banners with the same native-confirmed escape, `off` is a
 * plain call, `call_full` is terminal. A red chip therefore always has a
 * banner with an escape — by construction, not by the order timers happen to
 * fire.
 */
export function modeUnderLoudLatch(
  next: CallMode,
  loudLatched: boolean,
): CallMode {
  return loudLatched && next.kind === "e2ee" ? { kind: "negotiating" } : next;
}

/**
 * Where a loud latch came from. Only a MEDIA latch — a LiveKit
 * `encryptionError` or a native frame-key error, classified outside every
 * rotation window or escalated from a re-securing that never resolved — can
 * heal (`loudHealVerdict`). A CONTROL latch (a failed join ladder, a
 * destroyed envelope, a failed mid-call group action or commit arbitration,
 * local publications the SFU keeps recording as plaintext, a terminal session
 * failure) says nothing a later epoch could disprove; it stays terminal until
 * the group re-establishes or the call ends.
 *
 * The origin also decides what the chip SAYS. A media latch is
 * `not_encrypted`: frames failed. A control latch taken while this device was
 * still KEYED (`LoudLatchMeta.mediaKeyed`), with its local publications
 * declared GCM and the decode witness dropping nothing, is `cannot_verify`:
 * the group can no longer be vouched for, but no frame failed — the 09-08
 * reading ("not encrypted" over media every peer decrypted fine) was this
 * case. Either way the publish gate stays HELD (`loudModeFallback` folds the
 * mode to `negotiating`, `#onLoud` sets `failed` under it); `cannot_verify`
 * changes the copy, never the gate.
 */
export type LoudLatchOrigin = "media" | "control";

/**
 * Rides EVERY `loud` emission out of `#latchLoud` (`onEncryptionState`'s
 * third argument). `mediaKeyed` is snapshotted at the latch — E2EE on, a
 * local send key held, the local declaration not plaintext, the error not a
 * `MissingLocalFrameKeyError` — BEFORE `loudModeFallback` runs, since that
 * fold is what `#resetEnableState` later reads. A media→control upgrade emits
 * `mediaKeyed: false`: a plane that already failed never reads keyed.
 */
export interface LoudLatchMeta {
  origin: LoudLatchOrigin;
  mediaKeyed: boolean;
}

/**
 * The CANCEL TOKEN on a pending re-securing escalation: only a clearer that
 * presents the same token may cancel it.
 *
 *  - `joiner` — raised before this device holds any key of the group, where
 *    every index is missing by construction. Its genuine recovery is our own
 *    first key.
 *  - `media` — a decrypt failure after that. The key it names stays wrong
 *    until the next epoch, so nothing cancels it: it escalates, and
 *    `loudHealVerdict` — which has the witnesses — decides afterwards.
 *  - `control` — the local-declaration seam, cleared by that declaration
 *    being corrected.
 *
 * One timer serves the whole media plane and five sites used to clear it
 * unconditionally; three successive reviews each found a silent green at a
 * DIFFERENT one of them, because the structure could not say who was entitled
 * to cancel (media-E2EE reviews, 2026-09-08).
 */
export type ResecureReason = "joiner" | "media" | "control";

/**
 * What the session knows NOW about one device whose frames the latch could
 * have come from: the device the error named when the worker's message
 * carried one, else every remote device that was in the call at latch time
 * (LiveKit's worker re-wraps its `CryptorError` into a plain `Error` before
 * posting it, and only the MissingKey message embeds the identity — the
 * decoy/withheld-key failure reads `InvalidKey: Decryption failed: …`).
 */
export interface LoudHealPeer {
  /** The device (its primary or any screen leg) is in the SFU right now. */
  present: boolean;
  /** It was observed ADDED to the MLS roster after the latch was set. */
  readdedAfterLatch: boolean;
  /**
   * It publishes at least one track now and NONE of them existed at latch
   * time. New tracks decrypt at the new key index, which the install's
   * `setKey` re-validated, so a persisting failure re-emits inside the
   * settle. A device publishing nothing is neither gone nor re-keyed.
   */
  sidsAllNew: boolean;
}

/** The witnesses a latched session must hold before its loud latch may heal. */
export interface LoudHealInputs {
  origin: LoudLatchOrigin;
  /** Epoch-keys-applied counter at the moment the latch was set. */
  latchedInstallSeq: number;
  /** The same counter now — a strictly larger value means a new epoch's keys. */
  installSeq: number;
  /**
   * A media-plane error the install did not supersede: a hard error (the key
   * itself wrong) at or after the reference taken BEFORE the installer ran,
   * or a missing key for a pair no install has covered
   * (`MediaErrorLedger.errorSince`).
   */
  errorSinceInstall: boolean;
  /**
   * The settle has run since BOTH the last key install and the latest
   * observed re-Add of a PRESENT witness (`latestPresentAddedAt`). Leg 9 of
   * the 2026-09-07 sitting: a probe armed by the Remove epoch's install fired
   * the instant its own reconcile observed the rejoiner's Add, before one
   * frame under the new key had been judged, and healed over a key that was
   * still wrong.
   */
  settleElapsed: boolean;
  /** A FRESH reconcile reported neither non-enrolled nor pending identities. */
  rosterConsistent: boolean;
  /**
   * Every device the failure could have come from. Empty means the latch
   * has no witness at all (no remote was present) and must hold.
   */
  peers: readonly LoudHealPeer[];
  /**
   * The latch's ORIGINATING error was a decode missing key, and this side has
   * since pushed that exact pair to the worker in an install STRICTLY AFTER
   * the latch (`pairFilledAtSeq > latchedInstallSeq`).
   *
   * That `setKey` calls `resetKeyStatus` for the index the failure named, so
   * the index is live again and any surviving failure re-emits inside the
   * settle — which `errorSinceInstall` catches above. It is the one witness a
   * BYSTANDER latch can ever produce: a missing key names its participant, so
   * `peers` is the device that raised it, and a bystander never leaves and
   * never re-publishes, which is why leg 3a stayed red for the whole call.
   *
   * Strictly-after is what the reverted attempt got wrong: it asked whether
   * the pair had EVER been pushed, which is true from the moment the install
   * posts — and the worker raises a missing key precisely BECAUSE that
   * `setKey` had not been processed yet, so the clause was already true at
   * latch time and healed the latch it was meant to judge.
   *
   * It ALSO requires that the sender has no OTHER index still unfilled
   * (`MediaErrorLedger.unfilledPairs`). Re-validating the index the latch
   * named proves nothing if the sender has since moved on to another we never
   * got: `errorSinceInstall` cannot see that peer, because the ledger's
   * advance rule forgives the later pair, and the worker emits nothing more
   * after silencing an index. Without that second half this clause substitutes
   * for the peer witness in exactly the case the peer witness exists for
   * (media-E2EE review, 2026-09-08).
   */
  originatingPairRefilled?: boolean;
  /**
   * Any sender PRESENT in the SFU still has an index this side failed at and
   * has not filled. The refilled-pair witness answers a question about the
   * latch's own sender; a different present peer silenced earlier is invisible
   * to `errorSinceInstall`, because the ledger's advance rule forgives its
   * pair once any install advances us for it — so the heal could clear while
   * that peer's frames were still being dropped (media-E2EE review,
   * 2026-09-08).
   */
  unfilledElsewhere?: boolean;
}

/**
 * Whether a loud latch may heal. `heal` ONLY when the group RE-KEYED past the
 * failure, the media plane stayed clean through the settle, the roster is
 * consistent, and the FAILING PEER'S situation provably changed. Anything
 * short of that is `hold`, and the latch stays terminal exactly as before.
 *
 * A mere recovery (the missing key arriving, `noteEncryptionRecovered`) still
 * never heals — R1 of the 2026-09-07 L3 leg, kept on purpose: it proves
 * nothing about why frames failed.
 *
 * Why the peer-scoped witness (media-E2EE review, 2026-09-07): the LiveKit
 * worker emits ONE error for a key index and then marks it invalid, after
 * which every frame at that index is dropped SILENTLY; a new epoch's install
 * re-validates only the index it installs. A peer still sending at an OLD
 * index after the re-key therefore produces zero errors and zero decrypts —
 * the exact class the latch exists for — so "no error since the install" on
 * its own would heal over silently dropped media. It is sufficient only once
 * EVERY device the failure could have come from is gone, or was re-added
 * after the latch and publishes only tracks that did not exist at latch time
 * (those decrypt at the fresh index; if they fail, the error re-emits inside
 * the settle and holds). When the error named its device the set is that one
 * device; otherwise it is every remote present at latch time — the same set
 * in a 1:1 call. No device at all: hold.
 *
 * Both chip planes are required (invariant 11): control (a verified commit
 * installed a new epoch, the roster matches the SFU set) and media (no decrypt
 * error through the settle, the failing peer's frames gone or re-keyed). A
 * hostile DS cannot mint the witness — the keys come from a natively verified
 * commit, the roster must match the SFU set, the errors are local truth.
 */
/**
 * The latest observed re-Add among the PRESENT witnesses of a media latch
 * (0 when none). The heal settle must run from it as well as from the last
 * key install; an absent witness does not count — its frames are gone.
 */
export function latestPresentAddedAt(
  witnesses: readonly { present: boolean; addedAt?: number }[],
): number {
  let latest = 0;
  for (const w of witnesses) {
    if (w.present && w.addedAt !== undefined && w.addedAt > latest) {
      latest = w.addedAt;
    }
  }
  return latest;
}

export function loudHealVerdict(inputs: LoudHealInputs): "heal" | "hold" {
  if (inputs.origin !== "media") return "hold";
  if (inputs.installSeq <= inputs.latchedInstallSeq) return "hold";
  if (inputs.errorSinceInstall) return "hold";
  if (!inputs.settleElapsed) return "hold";
  if (!inputs.rosterConsistent) return "hold";
  if (inputs.peers.length === 0) return "hold";
  if (inputs.unfilledElsewhere) return "hold";
  // Behind the empty-witness hold, never in front of it.
  if (inputs.originatingPairRefilled) return "heal";
  return inputs.peers.every(
    (peer) => !peer.present || (peer.readdedAfterLatch && peer.sidsAllNew),
  )
    ? "heal"
    : "hold";
}

// ---- media-plane errors vs. the heal's install reference --------------------

/**
 * The key-pair id `<livekit identity>@<key index>` a frame key or a worker
 * error refers to. A screen leg is its own pair: native emits a `:screen`
 * entry for every member (`mlsCallKeys.ts`) and the worker keys a leg's
 * cryptor under the leg's identity.
 */
export function keyPairId(identity: string, keyIndex: number): string {
  return `${identity}@${keyIndex}`;
}

/** The worker's key ring (livekit-client default `keyringSize`). */
export const WORKER_KEYRING_SIZE = 16;

/**
 * What a media-plane error says about the key it failed at. The worker posts
 * `${reason}: ${message}` as a plain `Error` (`setupCryptorErrorEvents`); the
 * decode path's MissingKey — `missing key at index N for participant X` — is
 * the one shape that names both halves of the pair. The worker raises it only
 * while it holds NO key at that index, and the pair's `setKey` resets the
 * index's failure count (`resetKeyStatus`), so an install of that pair
 * provably supersedes it. Everything else — InvalidKey (the key it holds is
 * wrong), the encode path's missing key, a native key-path failure — reports
 * a key that stays wrong until the next epoch: `hard`. An index outside the
 * ring is not a key pair at all (a plaintext frame's last byte read as an
 * index; the worker's failure count for it is `NaN`, so it re-emits every
 * frame): `hard` too.
 */
export type MediaErrorClass =
  | { kind: "missing_key"; identity: string; pair: string }
  | { kind: "hard" };

export function classifyMediaError(error: unknown): MediaErrorClass {
  const message =
    typeof error === "object" && error !== null
      ? (error as { message?: unknown }).message
      : undefined;
  const missing =
    typeof message === "string"
      ? /^MissingKey: missing key at index (\d+) for participant (\S+)/.exec(
          message,
        )
      : null;
  if (!missing) return { kind: "hard" };
  const index = Number(missing[1]);
  if (index >= WORKER_KEYRING_SIZE) return { kind: "hard" };
  return {
    kind: "missing_key",
    identity: missing[2],
    pair: keyPairId(missing[2], index),
  };
}

/**
 * The media-plane error record the heal probe judges against its install
 * reference (`errorSinceInstall`). Two ledgers, because the worker's two
 * failure shapes mean different things after a re-key:
 *
 *  - A HARD error marks its key index invalid — one error, then silent drops
 *    (failureTolerance 0) — until a `setKey` for that index re-validates it:
 *    the next epoch's install, or LiveKit's own replay of every key it knows
 *    on each worker `enable` ack (a remote publish, a reconnect). Either
 *    way a peer still failing there re-emits on its next frame, which lands
 *    after the reference and holds — fail-closed for this ledger, and a
 *    re-set of an already-set pair changes no missing-key record (the slot
 *    was never empty). Its stamp is compared against a reference taken
 *    BEFORE the installer
 *    runs. `MlsKeyProvider.#install` awaits `importKey` per entry after each
 *    `onSetEncryptionKey` post, and an InvalidKey landing between those
 *    awaits used to be stamped before a reference taken after the install
 *    resolved: the index went silent and the probe healed over it 10 s later
 *    (media-E2EE review of `9e5fa880`). With the reference ahead of the
 *    install, every error during it counts — conservative by construction.
 *    Stamps and reference come from one MONOTONIC clock (`performance.now`):
 *    a wall clock stepping back between the two would re-open the window.
 *  - A MISSING key names its sender and is superseded by the next install of
 *    that SENDER that COMPLETES after it was observed: the worker processed
 *    the frame before the `setKey` message or it would not have raised
 *    MissingKey, and the `setKey` resets the index. Superseding by identity
 *    rather than by exact pair is deliberate: a device joined by Welcome
 *    hears the members' frames at epoch E before it holds any key and
 *    installs E+1 first (native snapshots `previous` only across a commit it
 *    applied itself), so `P@E` would never be covered and every later latch
 *    on that device would hold for the life of the group — the R2 heal inert
 *    on exactly the receiver role the live legs use (review of e2163ead,
 *    H1). The install proves this side holds the sender's current index;
 *    whether its older-index frames were lost is the SID witness's question.
 *    Time-ordered, not "ever installed": a missing key that lands AFTER the
 *    sender's install completed and names an index that install did NOT set
 *    is an index this side never got — the one local sign that a commit was
 *    withheld from it (re-review, M1) — and stands until an install of that
 *    sender that ADVANCES us (fills a slot we did not hold) proves we caught
 *    up. A replay of keys we already hold, which LiveKit performs on every
 *    worker `enable` ack, is not catching up and supersedes nothing. One that names a pair the sender's
 *    latest install DID set is the join race whenever it lands: the worker
 *    raises MissingKey only while the slot is empty, `setKey` fills it and
 *    no path ever empties a slot again for the life of the worker, so the
 *    frame was judged before the worker processed that `setKey` — superseded
 *    (second re-review, the exact discriminator). A missing key for a sender
 *    never installed at all is one at an index this side does not hold, its
 *    index silenced after the one error: it holds the heal while the sender
 *    is still in the SFU (`errorSince`'s `present`), regardless of when it
 *    landed, and stops mattering once the sender is gone.
 *  - The worker holds no ack for `setKey`: a `deriveKeys` failure inside the
 *    worker leaves the slot empty with nothing posted, and the one MissingKey
 *    it would have answered is treated as superseded here. Only malformed key
 *    material reaches that path (the §4.2 HKDF import guards it); a worker
 *    that acknowledges `setKey` should gate `noteInstalled` on the ack.
 */
export class MediaErrorLedger {
  /** `-Infinity` until an error lands: "no error yet" must never read as at-or-after a reference of 0. */
  #hardErrorAt = -Infinity;
  /** Missing-key pairs no install has covered yet, by the time observed. */
  #missing = new Map<string, { identity: string; at: number }>();
  /**
   * Per sender since the last `reset`: every key pair this side has pushed to
   * the worker (which mirrors the worker's FILLED ring slots — `setKeySet`
   * only ever assigns, the auto-ratchet is off at `ratchetWindowSize: 0`, and
   * nothing empties a slot), and when it last filled a slot it did not
   * already hold.
   */
  #installed = new Map<
    string,
    { advancedAt: number; pairs: Map<string, number> }
  >();
  /**
   * Every missing-key pair EVER observed, by sender — never swept by the
   * advance rule, so `unfilledPairs` can answer "is this sender still sending
   * at an index we do not hold?" exactly.
   *
   * `#missing` cannot answer it. Its supersession forgives a pair once an
   * install ADVANCED us for that sender (`at <= advancedAt`), which exists for
   * the Welcome joiner that heard `P@E` before holding any key and can never
   * fill that slot (H1) — but it also forgives the index a sender is
   * CURRENTLY using when we are two epochs behind it. Then `errorSince` reads
   * clean while the worker drops that peer's every frame at an index it
   * marked invalid, which is precisely the silent drop the heal's peer
   * witness exists to catch (media-E2EE review, 2026-09-08).
   */
  #everMissing = new Map<string, Map<string, boolean>>();

  /** Whether `pair` from `identity` is answered by an install since. */
  #superseded(identity: string, pair: string, at: number): boolean {
    const rec = this.#installed.get(identity);
    if (!rec) return false;
    // A pair we have pushed: that ring slot has been full ever since, and the
    // worker raises MissingKey only for an EMPTY slot, so the frame was judged
    // before it processed that setKey.
    if (rec.pairs.has(pair)) return true;
    // Otherwise only an install that ADVANCED us — filled a slot we did not
    // hold — proves we caught up with the sender. LiveKit re-pushes every key
    // it already knows on each worker `enable` ack; such a replay changes
    // nothing about the index that was missing and must not supersede it.
    return at <= rec.advancedAt;
  }

  /** Record a media-plane error observed at `now` (monotonic clock). */
  noteError(
    error: unknown,
    now: number,
    beforeFirstKey = false,
  ): MediaErrorClass {
    const cls = classifyMediaError(error);
    if (cls.kind === "hard") this.#hardErrorAt = now;
    else {
      const seen =
        this.#everMissing.get(cls.identity) ?? new Map<string, boolean>();
      if (!seen.has(cls.pair)) seen.set(cls.pair, beforeFirstKey);
      this.#everMissing.set(cls.identity, seen);
      if (!this.#superseded(cls.identity, cls.pair, now)) {
        this.#missing.set(cls.pair, { identity: cls.identity, at: now });
      }
    }
    return cls;
  }

  /**
   * Record the entries an install pushed to the worker, completing at
   * `completedAt` (the same monotonic clock as the error stamps).
   */
  noteInstalled(
    entries: readonly { livekit_identity: string; key_index: number }[],
    completedAt: number,
    installSeq = 0,
  ): void {
    const bySender = new Map<string, Set<string>>();
    for (const entry of entries) {
      const pairs = bySender.get(entry.livekit_identity) ?? new Set<string>();
      pairs.add(keyPairId(entry.livekit_identity, entry.key_index));
      bySender.set(entry.livekit_identity, pairs);
    }
    for (const [identity, pairs] of bySender) {
      const rec = this.#installed.get(identity) ?? {
        advancedAt: -Infinity,
        pairs: new Map<string, number>(),
      };
      let advanced = false;
      for (const pair of pairs) {
        // `advanced` is a FIRST-fill fact (it dates the supersession rule);
        // the sequence stamp is the LATEST fill, because the ring reuses an
        // index every 16 epochs and a stamp frozen at the epoch-3 fill would
        // make `pairFilledAtSeq > latchedInstallSeq` false forever from
        // epoch 16 on — the bystander heal expiring silently on any long
        // call (media-E2EE review, 2026-09-08).
        if (!rec.pairs.has(pair)) advanced = true;
        rec.pairs.set(pair, installSeq);
      }
      if (advanced) rec.advancedAt = completedAt;
      this.#installed.set(identity, rec);
    }
    for (const [pair, record] of this.#missing) {
      if (this.#superseded(record.identity, pair, record.at)) {
        this.#missing.delete(pair);
      }
    }
  }

  /**
   * Whether an error the install at `installRef` did not supersede stands: a
   * hard error at or after the reference, or a missing key for a sender no
   * install has covered that is still `present` in the SFU.
   */
  errorSince(
    installRef: number,
    present: (identity: string) => boolean = () => true,
  ): boolean {
    if (this.#hardErrorAt >= installRef) return true;
    for (const record of this.#missing.values()) {
      if (present(record.identity)) return true;
    }
    return false;
  }

  /**
   * Whether this side has pushed this EXACT pair to the worker, and the
   * install sequence at which it first did (`undefined` if never).
   *
   * This is the only fact that answers a missing key at that index, and it is
   * deliberately narrower than `#superseded`: that rule also accepts an
   * install which merely ADVANCED us past the index (`at <= advancedAt`),
   * which is right for `errorSince` — where `loudHealVerdict`'s peer witness
   * still has to clear — and WRONG anywhere it is the only test. The worker
   * marks an index invalid after one failure (`failureTolerance: 0`) and
   * drops every later frame at it SILENTLY; only a `setKey` for that exact
   * index calls `resetKeyStatus` and re-validates it, and with the ring at 16
   * slots nothing rewrites it for sixteen epochs. A sender two epochs ahead
   * of us therefore satisfies `advancedAt` while its frames keep being
   * dropped at an index we never filled (media-E2EE review, 2026-09-08).
   */
  pairFilledAtSeq(identity: string, pair: string): number | undefined {
    return this.#installed.get(identity)?.pairs.get(pair);
  }

  /**
   * Pairs this sender has failed at SINCE `sinceSeq` that this side has STILL
   * not filled —
   * indexes the worker marked invalid and that only a `setKey` for that exact
   * index re-validates. Non-empty means the sender may be sending into one of
   * them right now, silently dropped, with no further error to prove it.
   *
   * Deliberately not derived from `#missing`. Exactly one exemption: pairs
   * heard BEFORE this device held any key of the group. A device joined by
   * Welcome hears the members' frames first and native snapshots `previous`
   * only across a commit it applied, so an index they were using at an epoch
   * older than our admission can never be filled here and would otherwise read
   * as a permanent failure for the life of the group (the H1 shape `#missing`
   * exempts too).
   *
   * 🔴 The exemption is NOT sound in one case, and this is a blind spot `main`
   * shares rather than one this branch introduces: if such a pair is an index
   * the sender is STILL using — it advanced while we were joining and the
   * commit that would give us that key is withheld — the exemption hides an
   * invalid index for the life of the group. It cannot be told apart locally
   * from the ordinary stale-index case, because the worker emits one error per
   * index and then drops silently. Scoping it to "before the latch" instead
   * was wider still, and giving those pairs a bounded verdict turns the
   * ordinary Welcome into a guaranteed false red. It wants the worker `setKey`
   * ack, or a per-index re-check that re-arms on the sender's next epoch —
   * its own piece of work (media-E2EE reviews, 2026-09-08).
   */
  unfilledPairs(identity: string): string[] {
    const seen = this.#everMissing.get(identity);
    if (!seen) return [];
    const filled = this.#installed.get(identity)?.pairs;
    return [...seen]
      .filter(([pair, beforeFirstKey]) => !beforeFirstKey && !filled?.has(pair))
      .map(([pair]) => pair);
  }

  /** The missing-key pairs still uncovered by an install (diagnostics). */
  uncoveredPairs(): string[] {
    return [...this.#missing.keys()];
  }

  /** Forget the hard-error stamp (a healed latch). */
  forgetHardError(): void {
    this.#hardErrorAt = -Infinity;
  }

  /** Forget everything: the group, and with it every key index, is replaced. */
  reset(): void {
    this.#hardErrorAt = -Infinity;
    this.#missing.clear();
    this.#installed.clear();
    this.#everMissing.clear();
  }
}

/**
 * What the session does when a FRESH reconcile reports a non-enrolled
 * participant (the roster is not consistent), by the current mode:
 *
 *  - `declare` — declare the mix: assert the `mixed` publish pause and set
 *    the `mixed` label (the 6.4 `#onMixDetected` mechanics), so the banner
 *    names the participant and offers the native-confirmed downgrade. From
 *    `e2ee` this is T1. From `negotiating` it is T0c — a JOINER that lands in
 *    a call which already holds a non-enrolled participant. That case used to
 *    be gated on "E2EE already enabled", which a joiner never is (enable
 *    waits for a consistent roster), so it sat in `negotiating` forever:
 *    publishing paused by the negotiating gate, chip amber, no banner, no
 *    way to consent to plaintext — parked muted behind a chip. From `mixed`
 *    it re-declares (idempotent).
 *  - `transition` — run `mix_detected` through the machine: in an interlude
 *    the mode does not change and only a pending re-upgrade is cancelled.
 *  - `ignore` — `off` (a plain voice call has no group to be consistent
 *    with) and `call_full` (terminal, auto-leaving).
 */
export function mixDetectedAction(
  mode: CallMode,
): "declare" | "transition" | "ignore" {
  switch (mode.kind) {
    case "negotiating":
    case "e2ee":
    case "mixed":
      return "declare";
    case "interlude":
      return "transition";
    case "off":
    case "call_full":
      return "ignore";
  }
}
