// Unit spec for the §3.4 mode machine + §4.4 chip + ctl parser (slice 6.5).
//   node --test components/rtc/mlsCallModePolicy.test.ts   (Node >=23.6 strips types)
// Focus: every numbered transition T0a–T7, the confirm-order invariant
// (set_e2ee(false) strictly before resume), T6-is-the-sole-interlude-exit
// (no warm-enable after a confirmed interlude), the chip precedence table
// (the seven-row loud order — `cannot_verify` from row 4 only) + each
// fail-closed degradation, the banner every loud chip carries, the escape's
// `via` split, and default-closed ctl parsing.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallBannerInputs,
  type CallMode,
  type CallModeEffect,
  type ChipInputs,
  type ChipLatch,
  type DecodeWitness,
  type LoudHealInputs,
  DECODE_WITNESS_UNAVAILABLE,
  MediaErrorLedger,
  bannerParksFloat,
  callBannerState,
  callModeTransition,
  chipState,
  classifyEncryptionError,
  classifyMediaError,
  interludeStickyAcrossResecure,
  isTerminalLoud,
  keyPairId,
  latestPresentAddedAt,
  loudHealVerdict,
  loudModeFallback,
  mixDetectedAction,
  modeUnderLoudLatch,
  parseCtlPayload,
  plaintextReleaseAvailable,
  rotationWindowMs,
  summarizeDecodeWitness,
} from "./mlsCallModePolicy.ts";

const NEGOTIATING: CallMode = { kind: "negotiating" };
const E2EE: CallMode = { kind: "e2ee" };
const MIXED: CallMode = { kind: "mixed" };
const INTERLUDE_UNCONF: CallMode = { kind: "interlude", localConfirmed: false };
const INTERLUDE_CONF: CallMode = { kind: "interlude", localConfirmed: true };
// What `local_confirm` mints since wave 2: every confirmed interlude carries
// WHO authorized it. `INTERLUDE_CONF` above is the shape with no
// `confirmedVia` — still a valid INPUT to the transitions that keep the mode.
const INTERLUDE_NATIVE: CallMode = {
  kind: "interlude",
  localConfirmed: true,
  confirmedVia: "native",
};
const INTERLUDE_APP: CallMode = {
  kind: "interlude",
  localConfirmed: true,
  confirmedVia: "app",
};

// ---- Mode machine ----------------------------------------------------------

test("T0a negotiating → off releases the negotiating gate (feature/toggle off)", () => {
  const t = callModeTransition(NEGOTIATING, { type: "verdict_plaintext" });
  assert.deepEqual(t.mode, { kind: "off" });
  assert.deepEqual(t.effects, [{ do: "resume", reason: "negotiating" }]);
});

test("T0b negotiating → e2ee on enable", () => {
  const t = callModeTransition(NEGOTIATING, { type: "enabled" });
  assert.deepEqual(t.mode, { kind: "e2ee" });
});

test("T0c negotiating → mixed swaps the gate (never publishes plaintext pre-enable)", () => {
  const t = callModeTransition(NEGOTIATING, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "mixed" });
  // Asserts the mixed gate BEFORE releasing negotiating — never a gap.
  assert.deepEqual(t.effects[0], { do: "pause", reason: "mixed" });
  assert.ok(
    t.effects.some((e) => e.do === "resume" && e.reason === "negotiating"),
  );
});

test("T1 e2ee → mixed pauses", () => {
  const t = callModeTransition(E2EE, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "mixed" });
  assert.ok(t.effects.some((e) => e.do === "pause" && e.reason === "mixed"));
});

test("T2 mixed → schedule warm reupgrade (viaSuccessor false) on mix clear", () => {
  const t = callModeTransition(MIXED, { type: "mix_cleared" });
  assert.deepEqual(t.mode, MIXED); // mode unchanged until the timer fires
  assert.deepEqual(t.effects, [
    { do: "schedule_reupgrade", viaSuccessor: false },
  ]);
});

test("T3 mixed → interlude(confirmed): set_e2ee(false) STRICTLY before resume, then announce", () => {
  const t = callModeTransition(MIXED, { type: "local_confirm" });
  assert.deepEqual(t.mode, INTERLUDE_NATIVE);
  const order = t.effects.map((e) => e.do);
  const iE2ee = order.indexOf("set_e2ee");
  const iResume = order.indexOf("resume");
  const iAnnounce = order.indexOf("announce");
  assert.ok(iE2ee >= 0 && iResume >= 0, "both present");
  assert.ok(iE2ee < iResume, "E2EE-off before resume (invariant 1)");
  assert.ok(iAnnounce > iResume || iAnnounce >= 0, "announce present");
  const setE2ee = t.effects.find((e) => e.do === "set_e2ee");
  assert.deepEqual(setE2ee, { do: "set_e2ee", enabled: false });
});

test("ME-10 terminal escape: local_confirm from negotiating → interlude(confirmed), E2EE-off first; releases enable-window but NOT negotiating (the lockstep releases that after effects)", () => {
  const t = callModeTransition(NEGOTIATING, { type: "local_confirm" });
  assert.deepEqual(t.mode, INTERLUDE_NATIVE);
  const order = t.effects.map((e) => e.do);
  assert.equal(order[0], "set_e2ee", "E2EE-off is the FIRST effect");
  assert.deepEqual(t.effects[0], { do: "set_e2ee", enabled: false });
  assert.ok(
    !t.effects.some((e) => e.do === "resume" && e.reason === "negotiating"),
    "no explicit `negotiating` resume — the mode lockstep releases it AFTER the effects complete",
  );
  // MED-B: a failed #enable leaves `enable-window` held — a confirmed
  // interlude must release it or the user stays paused forever.
  assert.ok(
    t.effects.some((e) => e.do === "resume" && e.reason === "enable-window"),
    "releases the enable-window gate reason",
  );
  const iE2ee = order.indexOf("set_e2ee");
  const iEnableResume = t.effects.findIndex(
    (e) => e.do === "resume" && e.reason === "enable-window",
  );
  assert.ok(iE2ee < iEnableResume, "E2EE-off strictly before any resume");
  assert.ok(order.includes("announce"));
});

test("MED-B: local_confirm from mixed ALSO releases enable-window (after set_e2ee + the mixed resume)", () => {
  const t = callModeTransition(MIXED, { type: "local_confirm" });
  const iE2ee = t.effects.findIndex((e) => e.do === "set_e2ee");
  const iEnableResume = t.effects.findIndex(
    (e) => e.do === "resume" && e.reason === "enable-window",
  );
  assert.ok(iEnableResume >= 0, "enable-window released");
  assert.ok(iE2ee < iEnableResume, "E2EE-off strictly first");
});

// The full effect list of a confirm, per route. Pinned as a WHOLE (not just by
// membership) so the ORDER — set_e2ee(false) strictly before any resume, the
// announce after the gate releases — cannot drift while the members stay.
const CONFIRM_EFFECTS_NATIVE: CallModeEffect[] = [
  { do: "set_e2ee", enabled: false },
  { do: "resume", reason: "mixed" },
  { do: "resume", reason: "enable-window" },
  { do: "announce" },
  { do: "cancel_reupgrade" },
];
const CONFIRM_EFFECTS_APP: CallModeEffect[] = CONFIRM_EFFECTS_NATIVE.filter(
  (e) => e.do !== "announce",
);

test("🔴 C1: local_confirm from negotiating ALSO releases `mixed` (kills escape-negotiating-keeps-mixed-held)", () => {
  // After a mix was declared and a re-establish ran, `#resetEnableState`
  // drops `#mixPaused` WITHOUT releasing the `mixed` gate reason, so a
  // terminal confirm from `negotiating` used to leave `mixed` held — paused,
  // under a banner saying the media was being sent. Releasing an un-held
  // reason is a no-op on the reason set, and `negotiating` itself stays held
  // until `#setMode` runs after these effects, so this cannot produce a
  // premature 1→0 edge.
  const t = callModeTransition(NEGOTIATING, { type: "local_confirm" });
  const iMixed = t.effects.findIndex(
    (e) => e.do === "resume" && e.reason === "mixed",
  );
  assert.ok(iMixed >= 0, "the mixed gate reason is released");
  const iE2ee = t.effects.findIndex((e) => e.do === "set_e2ee");
  assert.ok(iE2ee < iMixed, "E2EE-off strictly before the mixed resume");
  assert.deepEqual(t.effects, CONFIRM_EFFECTS_NATIVE);
});

test("local_confirm stamps confirmedVia: native when `via` is absent or native, and announces", () => {
  for (const mode of [MIXED, INTERLUDE_UNCONF, NEGOTIATING]) {
    const absent = callModeTransition(mode, { type: "local_confirm" });
    assert.deepEqual(absent.mode, INTERLUDE_NATIVE, mode.kind);
    const native = callModeTransition(mode, {
      type: "local_confirm",
      via: "native",
    });
    assert.deepEqual(native.mode, INTERLUDE_NATIVE, mode.kind);
    assert.deepEqual(native.effects, absent.effects, mode.kind);
    assert.ok(
      native.effects.some((e) => e.do === "announce"),
      mode.kind + ": the native route announces",
    );
  }
});

test("🔴 local_confirm via app OMITS the announce and stamps confirmedVia: app (kills escape-app-confirm-announces)", () => {
  // `callAnnounce` is native-gated on `mls_not_confirmed`; the in-app route
  // never armed a grant, so the announce would be refused (and a later T6
  // `callClearDowngrade` would run against a grant that never existed).
  // Everything else is identical: E2EE-off first, the same gate releases in
  // the same order, the same re-upgrade cancel.
  for (const mode of [MIXED, INTERLUDE_UNCONF, NEGOTIATING]) {
    const t = callModeTransition(mode, { type: "local_confirm", via: "app" });
    assert.deepEqual(t.mode, INTERLUDE_APP, mode.kind);
    assert.ok(
      !t.effects.some((e) => e.do === "announce"),
      mode.kind + ": no announce on the in-app route",
    );
    assert.deepEqual(t.effects, CONFIRM_EFFECTS_APP, mode.kind);
  }
});

test("local_confirm: the mixed / interlude arms keep their effect ORDER under the `via` split", () => {
  // T3 / T5 always ran set_e2ee(false) → resume mixed → resume enable-window
  // → announce → cancel_reupgrade; wave 2 only threads `via` through them.
  for (const mode of [MIXED, INTERLUDE_UNCONF])
    assert.deepEqual(
      callModeTransition(mode, { type: "local_confirm" }).effects,
      CONFIRM_EFFECTS_NATIVE,
      mode.kind,
    );
  // An already-confirmed interlude ignores a repeat confirm — no double
  // release, and an app confirm can never overwrite a native stamp.
  const repeat = callModeTransition(INTERLUDE_NATIVE, {
    type: "local_confirm",
    via: "app",
  });
  assert.deepEqual(repeat.mode, INTERLUDE_NATIVE);
  assert.deepEqual(repeat.effects, []);
});

test("T4 mixed → interlude(UNconfirmed) on remote announce — NEVER resumes publishing", () => {
  const t = callModeTransition(MIXED, { type: "remote_announce" });
  assert.deepEqual(t.mode, { kind: "interlude", localConfirmed: false });
  assert.ok(
    !t.effects.some((e) => e.do === "resume"),
    "a remote announce can never open the local plaintext path",
  );
  assert.ok(!t.effects.some((e) => e.do === "set_e2ee"));
});

test("T5 interlude(unconfirmed) → confirmed on local confirm, with the same confirm order", () => {
  const t = callModeTransition(INTERLUDE_UNCONF, { type: "local_confirm" });
  assert.deepEqual(t.mode, INTERLUDE_NATIVE);
  const order = t.effects.map((e) => e.do);
  assert.ok(order.indexOf("set_e2ee") < order.indexOf("resume"));
});

test("T6 interlude → schedule reupgrade viaSuccessor=true (fresh group, never warm)", () => {
  const t = callModeTransition(INTERLUDE_CONF, { type: "mix_cleared" });
  assert.deepEqual(t.effects, [
    { do: "schedule_reupgrade", viaSuccessor: true },
  ]);
});

test("T6 sole exit: an `enabled` event during an interlude NEVER warm-enables the old group (ME-6)", () => {
  for (const mode of [INTERLUDE_CONF, INTERLUDE_UNCONF]) {
    const t = callModeTransition(mode, { type: "enabled" });
    assert.deepEqual(
      t.mode,
      mode,
      "interlude ignores `enabled` — only mix_cleared→T6 exits",
    );
    assert.deepEqual(t.effects, []);
  }
});

test("T7 call_full is terminal + auto-leave, from any live mode", () => {
  for (const mode of [NEGOTIATING, E2EE, MIXED, INTERLUDE_CONF]) {
    const t = callModeTransition(mode, { type: "call_full" });
    assert.deepEqual(t.mode, { kind: "call_full" });
    assert.deepEqual(t.effects, [{ do: "auto_leave" }]);
  }
  // Terminal: further events keep call_full.
  const stay = callModeTransition(
    { kind: "call_full" },
    { type: "mix_cleared" },
  );
  assert.deepEqual(stay.mode, { kind: "call_full" });
});

test("interlude tolerates a NEW mix without changing mode (turnover, ME-16) but cancels reupgrade", () => {
  const t = callModeTransition(INTERLUDE_CONF, { type: "mix_detected" });
  assert.deepEqual(t.mode, INTERLUDE_CONF);
  assert.deepEqual(t.effects, [{ do: "cancel_reupgrade" }]);
});

test("resecure keeps the mode (the machine rides above group identity)", () => {
  for (const mode of [E2EE, MIXED, INTERLUDE_CONF]) {
    assert.deepEqual(callModeTransition(mode, { type: "resecure" }).mode, mode);
  }
});

test("🔴 interludeStickyAcrossResecure: only a NATIVE-confirmed interlude survives a re-secure (kills escape-app-interlude-sticky)", () => {
  // Consumed at `#dropModeToNegotiating` and `#resetEnableState` ONLY. A
  // native confirm is the per-device, group-bound authorization invariant 1
  // names and stays sticky; an app confirm authorized THIS plaintext window
  // and nothing about the group the re-secure is about to establish, so it is
  // withdrawn — without that the in-app route would mint a permanently
  // sticky interlude.
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_NATIVE), true);
  // No `confirmedVia` at all: nothing mints this shape any more (the
  // transition always stamps; `state.tsx`'s in-app writer stamps `app`), and
  // the rule is pinned to its contract expression, `confirmedVia !== "app"`.
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_CONF), true);
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_APP), false);
  assert.equal(interludeStickyAcrossResecure(INTERLUDE_UNCONF), false);
  assert.equal(
    interludeStickyAcrossResecure({
      kind: "interlude",
      localConfirmed: false,
      confirmedVia: "app",
    }),
    false,
  );
  for (const mode of [
    undefined,
    NEGOTIATING,
    E2EE,
    MIXED,
    { kind: "off" } as const,
    { kind: "call_full" } as const,
  ])
    assert.equal(
      interludeStickyAcrossResecure(mode),
      false,
      mode?.kind ?? "undefined",
    );
});

test("off is terminal for mode purposes (a non-E2EE call has no group)", () => {
  const t = callModeTransition({ kind: "off" }, { type: "mix_detected" });
  assert.deepEqual(t.mode, { kind: "off" });
});

// ---- Chip precedence + fail-closed -----------------------------------------

// The latch shapes the chip splits on (`ChipLatch`). `DIRECT_LATCH` is what
// the two direct `state.tsx` writers produce (no `#latchLoud` snapshot);
// the others are `#latchLoud`'s `{ origin, mediaKeyed }` meta.
const DIRECT_LATCH: ChipLatch = { origin: undefined, mediaKeyed: false };
const MEDIA_KEYED: ChipLatch = { origin: "media", mediaKeyed: true };
const MEDIA_UNKEYED: ChipLatch = { origin: "media", mediaKeyed: false };
const CONTROL_KEYED: ChipLatch = { origin: "control", mediaKeyed: true };
const CONTROL_UNKEYED: ChipLatch = { origin: "control", mediaKeyed: false };

const baseChip = (over: Partial<ChipInputs>): ChipInputs => ({
  hasSession: true,
  sessionState: "active",
  mode: E2EE,
  e2eeEnabled: true,
  hasLocalKey: true,
  resecuring: false,
  latch: undefined,
  publishingIdentities: [],
  observedEncrypted: new Map(),
  localPublicationsEncrypted: true,
  rosterVerified: [true, true],
  channelHasOpenGroup: true,
  deviceNeedsSetup: false,
  peerCouldEncrypt: true,
  decodeWitness: { available: true, dropping: [], live: [] },
  ...over,
});

test("chip green requires ALL of (a) native, (b) observed-encrypted, (c) verified", () => {
  // Everyone muted (no publishers) ⇒ (b) vacuous ⇒ green off (a)+(c).
  assert.equal(chipState(baseChip({})), "e2ee");
  // A publishing participant observed encrypted ⇒ still green.
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", true]]),
      }),
    ),
    "e2ee",
  );
});

test("chip (b) fail-closed: a LOCAL publication not declared GCM is NOT green", () => {
  // The shipped-desktop shape (2026-09-06): worker status TRUE for us, the
  // peer observed encrypted, roster verified — and our mic on the SFU's
  // record as NONE. Every gate the old chip read was green.
  const inputs = baseChip({
    publishingIdentities: ["me:d", "peer:d"],
    observedEncrypted: new Map([
      ["me:d", true],
      ["peer:d", true],
    ]),
    localPublicationsEncrypted: false,
  });
  assert.equal(inputs.e2eeEnabled && inputs.hasLocalKey, true);
  assert.equal(
    chipState(inputs),
    "resecuring",
    "a NONE-declared local publication must never read green",
  );
  // Same inputs once the session has re-declared it: green (an unverified
  // roster still drops to amber-unverified as before).
  assert.equal(
    chipState({ ...inputs, localPublicationsEncrypted: true }),
    "e2ee",
  );
  assert.equal(
    chipState({
      ...inputs,
      localPublicationsEncrypted: true,
      rosterVerified: [true, false],
    }),
    "e2ee_unverified",
  );
});

test("chip: the local declaration never outranks a loud verdict or a mix", () => {
  // Even the keyed control latch: row 4 needs the declaration, so a NONE
  // publication drops it to row 5.
  assert.equal(
    chipState(
      baseChip({ localPublicationsEncrypted: false, latch: CONTROL_KEYED }),
    ),
    "not_encrypted",
  );
  assert.equal(
    chipState(baseChip({ localPublicationsEncrypted: false, mode: MIXED })),
    "not_encrypted",
  );
  // And it says nothing about a call that is not an E2EE call.
  assert.equal(
    chipState(
      baseChip({ localPublicationsEncrypted: false, mode: { kind: "off" } }),
    ),
    "none",
  );
});

test("chip (b) fail-closed: a publishing participant with missing/false status is NOT green", () => {
  assert.equal(
    chipState(
      baseChip({ publishingIdentities: ["u:d"], observedEncrypted: new Map() }),
    ),
    "resecuring",
    "missing status ⇒ amber, not green",
  );
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", false]]),
      }),
    ),
    "resecuring",
  );
});

test("chip trackless listener never blocks green (FE-2: only publishers gate (b))", () => {
  // A muted listener is NOT in publishingIdentities, so it cannot pin amber.
  assert.equal(
    chipState(
      baseChip({ publishingIdentities: [], observedEncrypted: new Map() }),
    ),
    "e2ee",
  );
});

test("chip (c): an unverified roster member ⇒ e2ee_unverified, not green", () => {
  assert.equal(
    chipState(baseChip({ rosterVerified: [true, false] })),
    "e2ee_unverified",
  );
});

test("chip precedence: not_encrypted beats everything", () => {
  assert.equal(chipState(baseChip({ mode: MIXED })), "not_encrypted");
  assert.equal(chipState(baseChip({ mode: INTERLUDE_CONF })), "not_encrypted");
  assert.equal(
    chipState(baseChip({ mode: { kind: "call_full" } })),
    "not_encrypted",
  );
  assert.equal(
    chipState(baseChip({ sessionState: "failed" })),
    "not_encrypted",
  );
  // Every latch shape that is not row 4 (rows 2, 3 and 5).
  for (const latch of [
    DIRECT_LATCH,
    MEDIA_KEYED,
    MEDIA_UNKEYED,
    CONTROL_UNKEYED,
  ])
    assert.equal(chipState(baseChip({ latch })), "not_encrypted", latch.origin);
});

// ---- The loud order of record (wave 2): rows 1–6 ----------------------------
//
// `cannot_verify` is reachable from exactly ONE rule (row 4): a CONTROL latch
// taken while this device was KEYED, with every local publication declared
// GCM and the decode witness reporting nothing dropping. Everything above it
// (a downgrade mode, an origin-less direct write, a media latch) and
// everything below it (any other latch, a `failed` nothing latched) reads
// `not_encrypted`. One spec per row; each names the mutation it kills.

test("chip row 1: a downgrade mode outranks even a keyed control latch", () => {
  for (const mode of [
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    { kind: "call_full" } as const,
  ])
    assert.equal(
      chipState(baseChip({ mode, latch: CONTROL_KEYED })),
      "not_encrypted",
      mode.kind,
    );
});

test("chip row 2: a latch with no origin (the direct state.tsx writers) → not_encrypted", () => {
  // The store-owner identity mismatch and `sessionSetupDecision`'s `hold_loud`
  // never went through `#latchLoud`, so there is no snapshot to split on —
  // whatever `mediaKeyed` says.
  assert.equal(chipState(baseChip({ latch: DIRECT_LATCH })), "not_encrypted");
  assert.equal(
    chipState(baseChip({ latch: { origin: undefined, mediaKeyed: true } })),
    "not_encrypted",
  );
});

test("chip row 3: a MEDIA latch → not_encrypted, even keyed", () => {
  // Frames failed to decrypt outside every window, or a re-securing never
  // resolved: the media plane itself is broken. Our send side being keyed
  // (the helper's path snapshots `mediaKeyed: true`) softens nothing.
  assert.equal(chipState(baseChip({ latch: MEDIA_KEYED })), "not_encrypted");
  assert.equal(chipState(baseChip({ latch: MEDIA_UNKEYED })), "not_encrypted");
});

test("🔴 chip row 4: control ∧ keyed ∧ local GCM ∧ witness not dropping → cannot_verify (kills chip-cannot-verify-collapses-to-not-encrypted)", () => {
  assert.equal(chipState(baseChip({ latch: CONTROL_KEYED })), "cannot_verify");
  // Unmoved by the gates below the loud rows: a publishing peer, an unverified
  // roster, a live witness, a rotation debounce.
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", true]]),
        rosterVerified: [true, false],
        resecuring: true,
        decodeWitness: { available: true, dropping: [], live: ["u:d"] },
      }),
    ),
    "cannot_verify",
  );
});

test("🔴 chip row 4 → 5: a DROPPING decode witness makes the keyed control latch not_encrypted (kills chip-cannot-verify-ignores-witness)", () => {
  // A sender's frames are arriving and being discarded: the media plane IS
  // failing, so "we can't confirm" would understate it.
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        decodeWitness: { available: true, dropping: ["u:d"], live: [] },
      }),
    ),
    "not_encrypted",
  );
});

test("🔴 chip row 4 → 5: an UN-KEYED control latch is not_encrypted (kills chip-cannot-verify-ignores-media-keyed)", () => {
  // `mediaKeyed: false` is what `#latchLoud` snapshots for a spent join
  // ladder, a media→control upgrade, a re-establish cap reached after the key
  // wipe, and a `MissingLocalFrameKeyError` (keyed while the CURRENT epoch
  // key is absent) — none may soften to "can't verify".
  assert.equal(
    chipState(baseChip({ latch: CONTROL_UNKEYED })),
    "not_encrypted",
  );
});

test("chip row 4 → 5: a local publication NOT declared GCM makes the keyed control latch not_encrypted", () => {
  assert.equal(
    chipState(
      baseChip({ latch: CONTROL_KEYED, localPublicationsEncrypted: false }),
    ),
    "not_encrypted",
  );
});

test("🔴 chip row 4 has NO `decodeWitness.available` conjunct: an unavailable witness still reads cannot_verify", () => {
  // An unpatched bundle, a dead worker, a stale tick — none can support the
  // POSITIVE claim "not encrypted"; "we can't confirm" is exactly what
  // `unavailable` means. (First-join control latches are un-keyed regardless,
  // so this cannot soften a first-join failure.)
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        decodeWitness: DECODE_WITNESS_UNAVAILABLE,
      }),
    ),
    "cannot_verify",
  );
});

test("🔴 chip row 6 sits BELOW row 4: `failed` + keyed control latch → cannot_verify (the #onLoud shape)", () => {
  // `#onLoud` sets `failed` BEFORE it calls `#latchLoud` — the only
  // `#setState("failed")` in the session — so every keyed mid-call control
  // site (a native build that threw, a DS commit arbitration classified
  // failed, a destroyed envelope) latches with `sessionState === "failed"`
  // and must still reach row 4.
  assert.equal(
    chipState(baseChip({ sessionState: "failed", latch: CONTROL_KEYED })),
    "cannot_verify",
  );
  // ...and it fails closed for a witness that IS dropping, as everywhere.
  assert.equal(
    chipState(
      baseChip({
        sessionState: "failed",
        latch: CONTROL_KEYED,
        decodeWitness: { available: true, dropping: ["u:d"], live: [] },
      }),
    ),
    "not_encrypted",
  );
});

test("chip row 6: `failed` with NO latch is the fail-closed backstop → not_encrypted", () => {
  assert.equal(
    chipState(baseChip({ sessionState: "failed", latch: undefined })),
    "not_encrypted",
  );
  // With an un-keyed latch it is row 5 — the same reading.
  assert.equal(
    chipState(baseChip({ sessionState: "failed", latch: CONTROL_UNKEYED })),
    "not_encrypted",
  );
});

test("chip resecuring beats unverified/green", () => {
  assert.equal(
    chipState(baseChip({ sessionState: "resecuring" })),
    "resecuring",
  );
  assert.equal(chipState(baseChip({ resecuring: true })), "resecuring");
});

// T-06-EXTENDED (6.6): a clean rotation's transient missing-key window must
// classify AMBER (resecuring), NEVER flip the chip loud to not_encrypted, and
// must RECOVER to green once media is observed encrypted again. Only a LATCHED
// error (past the session's 10 s escalation) is allowed to flip loud.
test("T-06-ext: a transient rotation-window resecuring stays amber, never not_encrypted", () => {
  // Rotation debounce active (media-plane), session still active, no latch.
  assert.equal(
    chipState(baseChip({ resecuring: true, latch: undefined })),
    "resecuring",
  );
  // Its media-plane form: a publishing participant momentarily lacks an
  // observed-encrypted status during the key swap ⇒ amber, NOT loud.
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map(), // status transiently missing mid-rotation
      }),
    ),
    "resecuring",
  );
});

test("T-06-ext: chip RECOVERS to green after the rotation window closes (no flap)", () => {
  // Same participant, status now observed encrypted again ⇒ back to green.
  assert.equal(
    chipState(
      baseChip({
        resecuring: false,
        publishingIdentities: ["u:d"],
        observedEncrypted: new Map([["u:d", true]]),
      }),
    ),
    "e2ee",
  );
});

test("T-06-ext: ONLY a latched error (post-escalation) flips a rotating call loud", () => {
  // Rotation window + a latched structured error ⇒ the latch wins (loud). This
  // is the 10 s-escalation outcome, not the transient window itself.
  assert.equal(
    chipState(baseChip({ resecuring: true, latch: MEDIA_KEYED })),
    "not_encrypted",
  );
  // The re-securing BACKSTOP (a control latch taken while re-securing, keys
  // intact, witness clean) is loud too — `cannot_verify`: the gate is held
  // and the copy says "can't confirm", never the positive "not encrypted".
  assert.equal(
    chipState(baseChip({ resecuring: true, latch: CONTROL_KEYED })),
    "cannot_verify",
  );
});

test("chip starting → none (no chrome flash on a plain voice call, FE-13)", () => {
  assert.equal(
    chipState(baseChip({ sessionState: "starting", mode: NEGOTIATING })),
    "none",
  );
});

test("chip plaintext/off/no-session with no open group → none", () => {
  assert.equal(
    chipState(
      baseChip({ sessionState: "plaintext", channelHasOpenGroup: false }),
    ),
    "none",
  );
  assert.equal(
    chipState(baseChip({ mode: { kind: "off" }, channelHasOpenGroup: false })),
    "none",
  );
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latch: undefined,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: false,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
      decodeWitness: { available: true, dropping: [], live: [] },
    }),
    "none",
  );
});

test("chip ME-7/R2-4 + §0.2#9: NO session in a channel with an open group ⇒ not_encrypted", () => {
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latch: undefined,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: true,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
      decodeWitness: { available: true, dropping: [], live: [] },
    }),
    "not_encrypted",
  );
});

test("chip: the open-group branch speaks for any shell, capable or not", () => {
  assert.equal(
    chipState({
      hasSession: false,
      e2eeEnabled: false,
      hasLocalKey: false,
      resecuring: false,
      latch: undefined,
      publishingIdentities: [],
      observedEncrypted: new Map(),
      localPublicationsEncrypted: true,
      rosterVerified: [],
      channelHasOpenGroup: true,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
      decodeWitness: { available: true, dropping: [], live: [] },
    }),
    "not_encrypted",
  );
});

test("chip negotiating with an open group → amber (not green, not none)", () => {
  assert.equal(
    chipState(
      baseChip({ mode: NEGOTIATING, e2eeEnabled: false, hasLocalKey: false }),
    ),
    "resecuring",
  );
});

// ---- terminal-loud banner predicate (ME-10) ---------------------------------

test("terminal-loud: loud failure while negotiating (original ME-10 shape)", () => {
  assert.equal(isTerminalLoud(NEGOTIATING, "not_encrypted", true), true);
  // Retry exhaustion can go loud without a structured error latched while
  // the mode still reads negotiating — the original condition, unchanged.
  assert.equal(isTerminalLoud(NEGOTIATING, "not_encrypted", false), true);
});

test("terminal-loud: refusal inside establish() — failed before ANY mode verdict (store-owner mismatch)", () => {
  // The session dies before onCallModeChanged ever fires, so the UI's mode
  // signal still reads undefined. This is the case the banner's Reset
  // encryption leg exists for; requiring `negotiating` made it unreachable.
  assert.equal(isTerminalLoud(undefined, "not_encrypted", true), true);
});

test("terminal-loud: attribution chips without a latched error are not a LOUD failure", () => {
  // chipState reads not_encrypted with NO session for the ME-7/§0.2#9
  // branches (web participant, a device with no encryption set up). Nothing
  // was attempted, so nothing latched and nothing is paused — the loud
  // banner's copy and its "Stay unencrypted" release would both be wrong.
  // They are NOT bannerless: `callBannerState` gives them the device arms.
  assert.equal(isTerminalLoud(undefined, "not_encrypted", false), false);
});

test("terminal-loud: any emitted mode verdict other than negotiating is not terminal", () => {
  // mixed/interlude have their own banner arms; off is a quiet plain call.
  assert.equal(isTerminalLoud({ kind: "off" }, "not_encrypted", true), false);
  assert.equal(isTerminalLoud(MIXED, "not_encrypted", true), false);
});

test("terminal-loud: requires the loud chip", () => {
  assert.equal(isTerminalLoud(NEGOTIATING, "resecuring", true), false);
  assert.equal(isTerminalLoud(undefined, "none", true), false);
});

test("🔴 terminal-loud: cannot_verify counts exactly like not_encrypted (kills terminal-loud-cannot-verify-arm-dropped)", () => {
  // A keyed control latch is folded to `negotiating` by `#onLoud` (or lands
  // before any verdict) exactly like a media one; the gate is held either way
  // and the same escape serves it. Both shapes, and both non-shapes.
  assert.equal(isTerminalLoud(NEGOTIATING, "cannot_verify", true), true);
  assert.equal(isTerminalLoud(NEGOTIATING, "cannot_verify", false), true);
  assert.equal(isTerminalLoud(undefined, "cannot_verify", true), true);
  assert.equal(isTerminalLoud(undefined, "cannot_verify", false), false);
  const modes: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    { kind: "call_full" },
  ];
  for (const mode of modes)
    for (const latchedError of [false, true])
      assert.equal(
        isTerminalLoud(mode, "cannot_verify", latchedError),
        isTerminalLoud(mode, "not_encrypted", latchedError),
        JSON.stringify({ mode, latchedError }),
      );
});

// ---- Which banner a chip carries (the no-dead-end invariant) ----------------

const baseBanner = (over: Partial<CallBannerInputs>): CallBannerInputs => ({
  chip: "not_encrypted",
  mode: undefined,
  latchedError: false,
  readiness: "needs_setup",
  ...over,
});

test("banner: the §3.4 downgrade modes keep their own banners", () => {
  assert.equal(
    callBannerState(baseBanner({ mode: MIXED, readiness: "ready" })),
    "mixed",
  );
  assert.equal(
    callBannerState(baseBanner({ mode: INTERLUDE_CONF, readiness: "ready" })),
    "interlude",
  );
  assert.equal(
    callBannerState(baseBanner({ mode: INTERLUDE_UNCONF, readiness: "ready" })),
    "interlude",
  );
});

test("banner: a ready device with a red chip is a CALL failure — terminal loud", () => {
  assert.equal(
    callBannerState(
      baseBanner({ mode: NEGOTIATING, latchedError: true, readiness: "ready" }),
    ),
    "terminal_loud",
  );
  // The capable-but-sessionless R2-4 hold: `negotiating` is still in the
  // publish gate and the error IS latched, so "your audio and video stay
  // paused" is true.
  assert.equal(
    callBannerState(baseBanner({ latchedError: true, readiness: "ready" })),
    "terminal_loud",
  );
});

test("🔴 banner: call_full is no longer silent (it latches, and the gate is held)", () => {
  // `#onCallFull` runs `#onLoud` before `#applyMode({type:"call_full"})`, so
  // the error is latched and `loudModeFallback` has re-asserted the
  // negotiating gate — the loud copy is true. `isTerminalLoud` returns false
  // here (the mode is not negotiating), which is precisely why routing the
  // banner through it left this red chip bare.
  assert.equal(
    isTerminalLoud({ kind: "call_full" }, "not_encrypted", true),
    false,
  );
  assert.equal(
    callBannerState(
      baseBanner({
        mode: { kind: "call_full" },
        latchedError: true,
        readiness: "ready",
      }),
    ),
    "terminal_loud",
  );
});

test("banner: a device that cannot encrypt owns the banner, whatever the call did", () => {
  // Nothing about the CALL is the cause, so the loud copy and a per-call
  // escape would both be wrong: this is the §7.4 red-chip-with-no-banner
  // state. Holds even with a latched error, which `owned_elsewhere` always
  // has (it stays capable and the setup decision holds it loud).
  assert.equal(
    callBannerState(baseBanner({ readiness: "needs_setup" })),
    "device_not_set_up",
  );
  assert.equal(
    callBannerState(
      baseBanner({ readiness: "owned_elsewhere", latchedError: true }),
    ),
    "device_not_set_up",
  );
  assert.equal(
    callBannerState(baseBanner({ readiness: "unsupported" })),
    "device_unsupported",
  );
});

test("🔴 banner: an unknown-cause red chip never falls back to 'this app can't encrypt'", () => {
  // `unsupported` is a POSITIVE fact the shell knows about itself. Making it
  // the fallback for "we don't know" tells someone whose call just failed the
  // most reassuring and least actionable thing available (reviewer F4). The
  // floor is the loud banner when something latched, and the no-claims notice
  // when nothing did — never a statement about the shell.
  for (const latchedError of [false, true])
    assert.notEqual(
      callBannerState(
        baseBanner({ readiness: "ready", mode: { kind: "off" }, latchedError }),
      ),
      "device_unsupported",
    );
  assert.equal(
    callBannerState(
      baseBanner({
        readiness: "ready",
        mode: { kind: "off" },
        latchedError: true,
      }),
    ),
    "terminal_loud",
  );
});

test("banner: nothing to say on a green, amber or chrome-less chip", () => {
  for (const chip of ["e2ee", "e2ee_unverified", "resecuring", "none"] as const)
    for (const readiness of [
      "ready",
      "needs_setup",
      "owned_elsewhere",
      "unsupported",
    ] as const)
      assert.equal(
        callBannerState(baseBanner({ chip, mode: E2EE, readiness })),
        "none",
      );
});

test("🔴 banner: a cannot_verify chip is never bannerless (kills banner-state-cannot-verify-bannerless)", () => {
  // It is only reachable WITH a session (a keyed control latch), so the
  // device is `ready` by construction — but the rule is total, and it sits
  // ahead of the device arms and of the `!== "not_encrypted"` guard that
  // would otherwise read it as "not red" and return `none`.
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    { kind: "call_full" },
  ];
  for (const mode of MODES)
    for (const latchedError of [false, true])
      for (const readiness of [
        "ready",
        "needs_setup",
        "owned_elsewhere",
        "unsupported",
      ] as const)
        assert.equal(
          callBannerState({
            chip: "cannot_verify",
            mode,
            latchedError,
            readiness,
          }),
          "cannot_verify",
          JSON.stringify({ mode, latchedError, readiness }),
        );
  // The §3.4 downgrade modes keep their own banners ahead of it (row 1 wins
  // the chip too, so the pair never co-occurs; the banner rule is still
  // total).
  assert.equal(
    callBannerState(
      baseBanner({ chip: "cannot_verify", mode: MIXED, readiness: "ready" }),
    ),
    "mixed",
  );
  assert.equal(
    callBannerState(
      baseBanner({
        chip: "cannot_verify",
        mode: INTERLUDE_NATIVE,
        readiness: "ready",
      }),
    ),
    "interlude",
  );
  // ...and it parks the Watch Together player like the other actionable ones.
  assert.equal(bannerParksFloat("cannot_verify"), true);
});

test("🔴 a REFUSED device is loud with no dependence on the open-group probe", () => {
  // The hole the first cut of this fix opened (reviewer F1, CRITICAL): a
  // device treated as non-capable asserts no gate, latches nothing, and
  // `chipState`'s no-session branches are gated on `channelHasOpenGroup` — so
  // alone in a channel with no group yet it published plaintext under chip
  // `none` with NO chrome at all. Staying CAPABLE is what fixes it: the setup
  // decision holds loud, the error latches as a direct `state.tsx` write (no
  // origin — row 2 of the chip's loud order), ahead of every probe-dependent
  // branch.
  for (const channelHasOpenGroup of [false, true]) {
    const chip = chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        latch: DIRECT_LATCH,
        rosterVerified: [],
        channelHasOpenGroup,
        deviceNeedsSetup: false,
        peerCouldEncrypt: true,
      }),
    );
    assert.equal(chip, "not_encrypted", `probe=${channelHasOpenGroup}`);
    assert.equal(
      callBannerState({
        chip,
        mode: undefined,
        latchedError: true,
        readiness: "owned_elsewhere",
      }),
      "device_not_set_up",
    );
  }
});

test("🔴 a device that could be set up is loud with NO open group, if a peer can encrypt", () => {
  // Was a pinned KNOWN GAP. A never-enrolled desktop is not capable, so it
  // latches nothing, and `channelHasOpenGroup` is probed ONCE at connect: if
  // the group opened afterwards the device stayed on chip `none` for the whole
  // call while every peer paused behind a banner naming it. `deviceNeedsSetup`
  // is LOCAL and `peerCouldEncrypt` is LIVE, so together they cannot go stale.
  for (const channelHasOpenGroup of [false, true]) {
    const chip = chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        rosterVerified: [],
        channelHasOpenGroup,
        deviceNeedsSetup: true,
        peerCouldEncrypt: true,
      }),
    );
    assert.equal(chip, "not_encrypted", `probe=${channelHasOpenGroup}`);
    assert.equal(
      callBannerState({
        chip,
        mode: undefined,
        latchedError: false,
        readiness: "needs_setup",
      }),
      "device_not_set_up",
    );
  }
});

test("🔴 ...and says NOTHING on a call where nobody can encrypt", () => {
  // `shellSupported` is true on every Tauri desktop and every native Android
  // build, not just where media E2EE has shipped, so an unqualified local term
  // would put a red chip and an undismissable strip on EVERY call for every
  // install that never turned encryption on — including plain calls with
  // nothing to downgrade (media-e2ee-reviewer round 3, finding 2).
  assert.equal(
    chipState(
      baseChip({
        hasSession: false,
        sessionState: undefined,
        mode: undefined,
        e2eeEnabled: false,
        hasLocalKey: false,
        rosterVerified: [],
        channelHasOpenGroup: false,
        deviceNeedsSetup: true,
        peerCouldEncrypt: false,
      }),
    ),
    "none",
  );
});

test("a shell that can NEVER encrypt still rides the probe — no nagging on a plain call", () => {
  // `unsupported` has nothing to set up, so telling it on every call in every
  // channel would be noise. It speaks only when someone else in the call is
  // actually encrypting, which is what the open-group probe answers.
  const quiet = chipState(
    baseChip({
      hasSession: false,
      sessionState: undefined,
      mode: undefined,
      e2eeEnabled: false,
      hasLocalKey: false,
      rosterVerified: [],
      channelHasOpenGroup: false,
      deviceNeedsSetup: false,
      peerCouldEncrypt: true,
    }),
  );
  assert.equal(quiet, "none");
  assert.equal(
    callBannerState({
      chip: quiet,
      mode: undefined,
      latchedError: false,
      readiness: "unsupported",
    }),
    "none",
  );
});

test("🔴 an unlatched red chip on a ready device promises nothing (MEDIUM-1)", () => {
  // The term that decides whether a banner may say "your audio and video stay
  // paused". It was accepted and ignored once, and that is how a red strip
  // came to promise a pause over a live, ungated mic.
  assert.equal(
    callBannerState(baseBanner({ readiness: "ready", latchedError: false })),
    "unencrypted_notice",
  );
  assert.equal(
    callBannerState(baseBanner({ readiness: "ready", latchedError: true })),
    "terminal_loud",
  );
});

// ---- who may be offered a plaintext release --------------------------------

test("the release is offered with a session, and on the R2-4 hold", () => {
  assert.equal(
    plaintextReleaseAvailable({
      mode: NEGOTIATING,
      hasSession: true,
      e2eeCapable: true,
      latchedError: false,
    }),
    true,
  );
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: false,
      e2eeCapable: true,
      latchedError: true,
    }),
    true,
  );
});

test("🔴 a session alone is not enough — the gate must actually be held", () => {
  // `hasSession` used to be the whole test, which would offer "Turn off
  // encryption" on any session-bound red chip that had not latched: the same
  // silent no-op the `call_full` arm exists to prevent. `confirmPlaintext`
  // returns immediately once terminal, and its `confirmReachable()` guard
  // refuses a session that is neither in a downgrade mode nor
  // failed / re-securing / latched loud; a MISSING group no longer
  // short-circuits it (the escape routes to the in-app confirm,
  // `confirmLocalPlaintext`), so the latch is what proves there is a held
  // gate to release. The session's OWN downgrade states hold a gate by
  // construction; anything else has to show that latch.
  for (const mode of [MIXED, INTERLUDE_CONF, NEGOTIATING])
    assert.equal(
      plaintextReleaseAvailable({
        mode,
        hasSession: true,
        e2eeCapable: true,
        latchedError: false,
      }),
      true,
    );
  for (const mode of [E2EE, { kind: "off" } as const, undefined])
    assert.equal(
      plaintextReleaseAvailable({
        mode,
        hasSession: true,
        e2eeCapable: true,
        latchedError: false,
      }),
      false,
    );
  // ...and the latch restores it wherever the mode cannot vouch.
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: true,
      e2eeCapable: true,
      latchedError: true,
    }),
    true,
  );
});

test("🔴 the release is NOT offered where nothing is paused, nor once terminal", () => {
  // A never-enrolled device and an unsupported shell assert no gate, so the
  // press is a silent no-op; `call_full` is terminal in the session
  // (`#terminal()`), so `confirmReachable()` is false and `confirmPlaintext`
  // returns immediately — it is the terminal check that stops it, not a
  // missing group (a missing group now routes to the in-app confirm).
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: false,
      e2eeCapable: false,
      latchedError: false,
    }),
    false,
  );
  assert.equal(
    plaintextReleaseAvailable({
      mode: undefined,
      hasSession: false,
      e2eeCapable: true,
      latchedError: false,
    }),
    false,
  );
  assert.equal(
    plaintextReleaseAvailable({
      mode: { kind: "call_full" },
      hasSession: true,
      e2eeCapable: true,
      latchedError: true,
    }),
    false,
  );
});

test("🔴 INVARIANT: every LOUD chip (not_encrypted or cannot_verify) carries a banner (exhaustive)", () => {
  // The design rule this whole change exists to make checkable: a loud chip is
  // never a dead end. Swept over every input that can PRODUCE a loud chip —
  // which is not the same as every input, and saying so matters: the sweep
  // leaves the mode/state/latch/no-session axes free, because those are the
  // ones that make it loud, and since wave 2 ALSO sweeps
  // `localPublicationsEncrypted` and a clean-vs-dropping decode witness,
  // because row 4 reads both to pick WHICH loud value (neither can mint a red
  // — gate (d) may only WITHHOLD green — but each turns `cannot_verify` into
  // `not_encrypted`). The witness's third value (`unavailable`), the un-keyed
  // media latch and the app-confirmed interlude are held out of this product
  // — each is inert for the loud rows and pinned by its own spec (the next
  // one sweeps `unavailable` against every shape) — to keep the sweep at
  // ~1.3M shapes rather than 2.6M.
  // Written out rather than trusted to the handful of shapes anyone thought
  // of, which is how the ME-7 and §0.2 #9 no-session branches sat bannerless
  // through five reviews — and it is still no proof about a chip that is
  // NEVER red, which is the hole that got through twice.
  //
  // 🔴 The COMPUTED chip goes into `callBannerState`. The first cut of this
  // sweep hard-coded `chip: "not_encrypted"` here, which sampled the banner
  // for a chip the sweep never produced and would have kept a bannerless
  // `cannot_verify` green (round-1 audit, B3) — the filter and the argument
  // move together, and the sweep must be shown to REACH `cannot_verify`.
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    { kind: "call_full" },
  ];
  const STATES: ChipInputs["sessionState"][] = [
    undefined,
    "starting",
    "active",
    "plaintext",
    "resecuring",
    "failed",
    "closed",
  ];
  const READINESS = [
    "ready",
    "needs_setup",
    "owned_elsewhere",
    "unsupported",
  ] as const;
  const BOOLS = [false, true];
  const LATCHES: (ChipLatch | undefined)[] = [
    undefined,
    DIRECT_LATCH,
    MEDIA_KEYED,
    CONTROL_KEYED,
    CONTROL_UNKEYED,
  ];
  const WITNESSES: DecodeWitness[] = [
    { available: true, dropping: [], live: [] },
    { available: true, dropping: ["u:d"], live: [] },
  ];
  const PUBLISHERS: { p: string[]; o: Map<string, boolean> }[] = [
    { p: [], o: new Map() },
    { p: ["u:d"], o: new Map([["u:d", true]]) },
    { p: ["u:d"], o: new Map() },
  ];

  let red = 0;
  let cannotVerify = 0;
  for (const hasSession of BOOLS)
    for (const sessionState of STATES)
      for (const mode of MODES)
        for (const e2eeEnabled of BOOLS)
          for (const hasLocalKey of BOOLS)
            for (const resecuring of BOOLS)
              for (const latch of LATCHES)
                for (const channelHasOpenGroup of BOOLS)
                  for (const deviceNeedsSetup of BOOLS)
                    for (const peerCouldEncrypt of BOOLS)
                      for (const rosterVerified of [[], [true], [false]])
                        for (const localPublicationsEncrypted of BOOLS)
                          for (const decodeWitness of WITNESSES)
                            for (const pub of PUBLISHERS) {
                              const inputs: ChipInputs = {
                                hasSession,
                                sessionState,
                                mode,
                                e2eeEnabled,
                                hasLocalKey,
                                resecuring,
                                latch,
                                publishingIdentities: pub.p,
                                observedEncrypted: pub.o,
                                localPublicationsEncrypted,
                                rosterVerified,
                                channelHasOpenGroup,
                                deviceNeedsSetup,
                                peerCouldEncrypt,
                                decodeWitness,
                              };
                              const chip = chipState(inputs);
                              if (
                                chip !== "not_encrypted" &&
                                chip !== "cannot_verify"
                              )
                                continue;
                              red++;
                              const shape = () =>
                                JSON.stringify({
                                  chip,
                                  hasSession,
                                  sessionState,
                                  mode,
                                  latch,
                                  localPublicationsEncrypted,
                                  decodeWitness,
                                  channelHasOpenGroup,
                                  deviceNeedsSetup,
                                  peerCouldEncrypt,
                                });
                              if (chip === "cannot_verify") {
                                cannotVerify++;
                                // Exactly ONE rule yields it (row 4): pin
                                // every conjunct, and that no row above
                                // fired.
                                if (
                                  !(
                                    latch?.origin === "control" &&
                                    latch.mediaKeyed &&
                                    localPublicationsEncrypted &&
                                    decodeWitness.dropping.length === 0 &&
                                    mode?.kind !== "mixed" &&
                                    mode?.kind !== "interlude" &&
                                    mode?.kind !== "call_full"
                                  )
                                )
                                  assert.fail(
                                    `cannot_verify outside row 4: ${shape()}`,
                                  );
                              }
                              // The banner takes the boolean the product
                              // passes it: "a gate is held".
                              const latchedError = latch !== undefined;
                              for (const readiness of READINESS)
                                if (
                                  callBannerState({
                                    chip,
                                    mode,
                                    latchedError,
                                    readiness,
                                  }) === "none"
                                )
                                  assert.fail(
                                    `loud chip with no banner: ${shape()} readiness=${readiness}`,
                                  );
                            }
  // A sweep that found no loud chips would pass vacuously — and one that never
  // produced `cannot_verify` would prove nothing about its banner.
  assert.ok(red > 1000, `expected a large loud-chip sample, got ${red}`);
  assert.ok(
    cannotVerify > 0,
    `the sweep never reached cannot_verify (${cannotVerify})`,
  );
});

test("🔴 an UNAVAILABLE decode witness never changes a loud reading (no `available` conjunct, every shape)", () => {
  // The exhaustive sweep above holds the witness to clean / dropping; this
  // pins the third value across every mode × state × latch × declaration:
  // whatever the clean witness reads, the unavailable one reads the same —
  // it can neither rescue a red nor turn "can't verify" into the positive
  // "not encrypted".
  const MODES: (CallMode | undefined)[] = [
    undefined,
    NEGOTIATING,
    { kind: "off" },
    E2EE,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_NATIVE,
    INTERLUDE_APP,
    { kind: "call_full" },
  ];
  const STATES: ChipInputs["sessionState"][] = [
    undefined,
    "starting",
    "active",
    "plaintext",
    "resecuring",
    "failed",
    "closed",
  ];
  const LATCHES: (ChipLatch | undefined)[] = [
    undefined,
    DIRECT_LATCH,
    MEDIA_KEYED,
    MEDIA_UNKEYED,
    CONTROL_KEYED,
    CONTROL_UNKEYED,
  ];
  let loud = 0;
  let cannotVerify = 0;
  for (const hasSession of [false, true])
    for (const mode of MODES)
      for (const sessionState of STATES)
        for (const latch of LATCHES)
          for (const localPublicationsEncrypted of [false, true]) {
            const shape = {
              hasSession,
              mode,
              sessionState,
              latch,
              localPublicationsEncrypted,
            };
            const clean = chipState(
              baseChip({
                ...shape,
                decodeWitness: { available: true, dropping: [], live: [] },
              }),
            );
            if (clean !== "not_encrypted" && clean !== "cannot_verify")
              continue;
            loud++;
            if (clean === "cannot_verify") cannotVerify++;
            assert.equal(
              chipState(
                baseChip({
                  ...shape,
                  decodeWitness: DECODE_WITNESS_UNAVAILABLE,
                }),
              ),
              clean,
              JSON.stringify(shape),
            );
          }
  assert.ok(loud > 0, `expected loud shapes, got ${loud}`);
  assert.ok(
    cannotVerify > 0,
    `expected cannot_verify shapes, got ${cannotVerify}`,
  );
});

test("🔴 only a banner the user can clear parks the Watch Together player", () => {
  // The player host floats above the card, so a banner the user must act on
  // has to displace it — and each §3.4 state, and `cannot_verify` (Rejoin /
  // Leave / Stay unencrypted), has an in-call control that clears it, so the
  // park is transient by construction.
  for (const kind of [
    "mixed",
    "interlude",
    "terminal_loud",
    "cannot_verify",
  ] as const)
    assert.equal(bannerParksFloat(kind), true, kind);
  // The DEVICE banners describe the device; NOTHING in the call clears them,
  // so parking on one un-anchors the video for the whole call with no control
  // that brings it back and no copy that says why.
  for (const kind of [
    "device_not_set_up",
    "device_unsupported",
    "unencrypted_notice",
    "none",
  ] as const)
    assert.equal(bannerParksFloat(kind), false, kind);
});

// ---- ctl parser (default-closed) -------------------------------------------

test("parseCtlPayload accepts exactly {v:1, kind:mode, mode:plaintext, ids}", () => {
  const ok = parseCtlPayload(
    JSON.stringify({
      v: 1,
      kind: "mode",
      mode: "plaintext",
      channel_id: "c",
      group_id: "g",
    }),
  );
  assert.deepEqual(ok, {
    kind: "mode",
    mode: "plaintext",
    channelId: "c",
    groupId: "g",
  });
});

test("parseCtlPayload default-closed: unknown v/kind/mode, bad JSON, missing ids → null", () => {
  const cases = [
    "not json",
    JSON.stringify({
      v: 2,
      kind: "mode",
      mode: "plaintext",
      channel_id: "c",
      group_id: "g",
    }),
    JSON.stringify({
      v: 1,
      kind: "other",
      mode: "plaintext",
      channel_id: "c",
      group_id: "g",
    }),
    // There is NO mode:"e2ee" trigger — re-upgrade is automatic-only.
    JSON.stringify({
      v: 1,
      kind: "mode",
      mode: "e2ee",
      channel_id: "c",
      group_id: "g",
    }),
    JSON.stringify({ v: 1, kind: "mode", mode: "plaintext", group_id: "g" }),
    JSON.stringify(null),
    JSON.stringify(42),
  ];
  for (const c of cases) assert.equal(parseCtlPayload(c), null, c);
});

// ---- encryptionError classification (§4.4 debounce, 6.7b joiner window) -----

test("encryptionError inside a rotation window classifies resecuring", () => {
  assert.equal(classifyEncryptionError(true, false), "resecuring");
});

test("encryptionError while awaiting the first key classifies resecuring (6.7b joiner window)", () => {
  // A mid-call joiner receives already-encrypted frames before its Welcome
  // resolves — expected noise, bounded by the same resecure escalation.
  assert.equal(classifyEncryptionError(false, true), "resecuring");
});

test("encryptionError with keys installed and no window is immediately loud", () => {
  assert.equal(classifyEncryptionError(false, false), "loud");
});

test("both windows open still resecuring (no double-count to loud)", () => {
  assert.equal(classifyEncryptionError(true, true), "resecuring");
});

// ---- rotation-window length by opener (§4.4; the lost-arbitration race) -----

const BOUNDS = { addGraceMs: 2_000, settleMs: 2_000, submitTimeoutMs: 10_000 };

test("rotation window: an Add-grace install stays known through grace + settle", () => {
  assert.equal(rotationWindowMs("grace", BOUNDS), 4_000);
});

test("rotation window: an immediate install stays known through the settle only", () => {
  assert.equal(rotationWindowMs("immediate", BOUNDS), 2_000);
});

test("🔴 rotation window: a submitted commit is a known rotation for the whole round trip", () => {
  // The loser of a Remove race eats the winner's new-index frames while its
  // own submit is still in flight (its copy of the winning commit is queued
  // behind the same lock), so the window must already be open at submit and
  // outlast the submit bound — the install-opened windows start too late.
  assert.equal(rotationWindowMs("arbitration", BOUNDS), 12_000);
  assert.ok(
    rotationWindowMs("arbitration", BOUNDS) > rotationWindowMs("grace", BOUNDS),
  );
});

// ---- loud after e2ee: fold into the terminal-loud shape ---------------------

test("🔴 a loud latch in e2ee drops the mode to negotiating (banner + escape hatch)", () => {
  // The known gap "loud after mode reached e2ee → red chip, no banner, no
  // way out": isTerminalLoud and confirmPlaintext both key on negotiating.
  const fallback = loudModeFallback(E2EE);
  assert.deepEqual(fallback, NEGOTIATING);
  assert.equal(isTerminalLoud(fallback!, "not_encrypted", true), true);
});

test("a loud latch anywhere else keeps the mode", () => {
  // negotiating already renders the terminal banner; mixed/interlude carry
  // their own banners with the same native-confirmed escape; off is a plain
  // call; call_full is terminal.
  const keep: CallMode[] = [
    NEGOTIATING,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_CONF,
    { kind: "off" },
    { kind: "call_full" },
  ];
  for (const mode of keep)
    assert.equal(loudModeFallback(mode), null, mode.kind);
});

// ---- the label a latched session may write ----------------------------------

test("🔴 under a loud latch, e2ee is unreachable: it folds to negotiating", () => {
  // The R2 dead end (2026-09-07): after the latch the machine kept running
  // and a mix_detected → mix_cleared cycle wrote `e2ee` back — red chip from
  // the latched error, no banner, no escape, the promised pause lifted.
  const folded = modeUnderLoudLatch(E2EE, true);
  assert.deepEqual(folded, NEGOTIATING);
  assert.equal(isTerminalLoud(folded, "not_encrypted", true), true);
});

test("without a latch the label passes through unchanged", () => {
  assert.deepEqual(modeUnderLoudLatch(E2EE, false), E2EE);
  assert.deepEqual(modeUnderLoudLatch(MIXED, false), MIXED);
});

test("every other label passes under a latch (they carry their own banners or are terminal)", () => {
  const pass: CallMode[] = [
    NEGOTIATING,
    MIXED,
    INTERLUDE_UNCONF,
    INTERLUDE_CONF,
    { kind: "off" },
    { kind: "call_full" },
  ];
  for (const mode of pass)
    assert.deepEqual(modeUnderLoudLatch(mode, true), mode, mode.kind);
});

test("composition: latch → mix → mix cleared → the T2 resume cannot reach e2ee", () => {
  // Latch in e2ee folds to negotiating; a rejoining peer's beat declares a
  // mix (T0c declare = the session sets `mixed`); the mix clears and the T2
  // timer labels e2ee — which must fold back to the terminal-loud shape.
  const latched = loudModeFallback(E2EE)!;
  assert.deepEqual(latched, NEGOTIATING);
  const mixed: CallMode = MIXED; // #onMixDetected's direct label
  const cleared = callModeTransition(mixed, { type: "mix_cleared" });
  assert.deepEqual(cleared.effects, [
    { do: "schedule_reupgrade", viaSuccessor: false },
  ]);
  const t2 = modeUnderLoudLatch(E2EE, true); // what the timer may write
  assert.deepEqual(t2, NEGOTIATING);
  assert.equal(isTerminalLoud(t2, "not_encrypted", true), true);
});

test("chip: negotiating + latched error is loud; negotiating without one is amber", () => {
  const base: ChipInputs = {
    hasSession: true,
    sessionState: "active",
    mode: NEGOTIATING,
    e2eeEnabled: false,
    hasLocalKey: false,
    resecuring: false,
    latch: undefined,
    publishingIdentities: [],
    observedEncrypted: new Map(),
    localPublicationsEncrypted: true,
    rosterVerified: [],
    channelHasOpenGroup: true,
    deviceNeedsSetup: false,
    peerCouldEncrypt: true,
    decodeWitness: { available: true, dropping: [], live: [] },
  };
  // A first-join control latch is un-keyed (`#hasLocalKey` is only set after
  // a Welcome install), so it reads not_encrypted at row 5, never row 4.
  assert.equal(chipState({ ...base, latch: CONTROL_UNKEYED }), "not_encrypted");
  // The heal's intermediate: the latch is gone, the label is still folded
  // until the chained `e2ee` lands.
  assert.equal(chipState(base), "resecuring");
});

// ---- healing a media latch: the peer-scoped witness ------------------------

const LEFT = { present: false, readdedAfterLatch: false, sidsAllNew: false };
const REKEYED = { present: true, readdedAfterLatch: true, sidsAllNew: true };
const HEAL_OK: LoudHealInputs = {
  origin: "media",
  latchedInstallSeq: 3,
  installSeq: 4,
  errorSinceInstall: false,
  settleElapsed: true,
  rosterConsistent: true,
  peers: [LEFT],
};

test("a media latch heals once the group re-keyed and the failing peer LEFT", () => {
  assert.equal(loudHealVerdict(HEAL_OK), "heal");
});

test("…or once that peer was re-added after the latch and publishes only NEW tracks", () => {
  assert.equal(loudHealVerdict({ ...HEAL_OK, peers: [REKEYED] }), "heal");
});

test("🔴 a present peer still publishing a latched-time track holds (silent drops at an invalid index)", () => {
  // The worker emits one error per key index and then drops silently; a peer
  // still sending at its old index after the re-key produces no error and no
  // decrypt. "No error since the install" alone would heal over dead air.
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [{ present: true, readdedAfterLatch: true, sidsAllNew: false }],
    }),
    "hold",
  );
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [{ present: true, readdedAfterLatch: false, sidsAllNew: true }],
    }),
    "hold",
  );
});

test("🔴 with no named device EVERY remote present at the latch must be gone or re-keyed", () => {
  // The worker posts a plain Error; only the MissingKey message names the
  // participant, so a decoy-key failure leaves the set = all remotes.
  assert.equal(loudHealVerdict({ ...HEAL_OK, peers: [LEFT, REKEYED] }), "heal");
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [
        REKEYED,
        { present: true, readdedAfterLatch: false, sidsAllNew: false },
      ],
    }),
    "hold",
  );
});

test("a bystander latch heals once this side installed the exact index it named", () => {
  // A missing key NAMES its participant, so the witness set is the bystander
  // that raised it — and a bystander never leaves and never re-publishes,
  // which is why leg 3a (2026-09-07) stayed red for the whole call. Filling
  // that index is the one witness such a latch can produce: `setKey` calls
  // `resetKeyStatus` for it, so a surviving failure re-emits inside the
  // settle and `errorSinceInstall` catches it.
  const stuck = { present: true, readdedAfterLatch: false, sidsAllNew: false };
  assert.equal(loudHealVerdict({ ...HEAL_OK, peers: [stuck] }), "hold");
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [stuck],
      originatingPairRefilled: true,
    }),
    "heal",
  );
});

test("🔴 the refilled-pair witness sits BEHIND the empty-witness hold, never in front", () => {
  // No device the failure could have come from means no witness at all, and
  // the latch holds whatever else is true. Ordering the refill clause ahead
  // of that check would let a latch with nothing to judge heal itself.
  assert.equal(
    loudHealVerdict({
      ...HEAL_OK,
      peers: [],
      originatingPairRefilled: true,
    }),
    "hold",
  );
});

test("🔴 the refilled-pair witness never substitutes for the other gates", () => {
  // It answers "was the failing index re-validated", nothing else: a hard
  // error since the install, an unsettled probe, a divergent roster and a
  // control-plane latch all still hold with it set.
  const holds: Partial<LoudHealInputs>[] = [
    { origin: "control" },
    { installSeq: 3 },
    { errorSinceInstall: true },
    { settleElapsed: false },
    { rosterConsistent: false },
  ];
  for (const over of holds)
    assert.equal(
      loudHealVerdict({
        ...HEAL_OK,
        peers: [{ present: true, readdedAfterLatch: false, sidsAllNew: false }],
        originatingPairRefilled: true,
        ...over,
      }),
      "hold",
      JSON.stringify(over),
    );
});

test("🔴 every other missing witness holds", () => {
  const holds: Partial<LoudHealInputs>[] = [
    { origin: "control" },
    { installSeq: 3 }, // no new epoch since the latch
    { installSeq: 2 },
    { errorSinceInstall: true },
    // Leg 9 (2026-09-07): judged before the settle since the latest Add.
    { settleElapsed: false },
    { rosterConsistent: false },
    { peers: [] }, // nobody the failure could have come from = no witness
  ];
  for (const over of holds)
    assert.equal(
      loudHealVerdict({ ...HEAL_OK, ...over }),
      "hold",
      JSON.stringify(over),
    );
});

test("the heal settle runs from the latest re-Add of a PRESENT witness only", () => {
  // Leg 9 (2026-09-07): the present rejoiner's later Add dominates.
  assert.equal(
    latestPresentAddedAt([
      { present: true, addedAt: 100 },
      { present: true, addedAt: 250 },
    ]),
    250,
  );
  // Leg 8: an absent witness's Add is ignored — its frames are gone.
  assert.equal(
    latestPresentAddedAt([
      { present: false, addedAt: 900 },
      { present: true, addedAt: 100 },
    ]),
    100,
  );
  // Never re-added / no witness: nothing later than the install.
  assert.equal(latestPresentAddedAt([{ present: true }]), 0);
  assert.equal(latestPresentAddedAt([]), 0);
});

// ---- media-plane errors vs. the install reference ---------------------------

const PEER = "01KWZ8SEDB282BE0ZS0H3TQA61:f5e41432ff82e08c83176f57c4a80a78";
const MISSING = (index: number, identity = PEER) =>
  new Error(
    `MissingKey: missing key at index ${index} for participant ${identity}`,
  );
const INVALID = new Error(
  "InvalidKey: Decryption failed: The operation failed for an operation-specific reason",
);
const entry = (index: number, identity = PEER) => ({
  livekit_identity: identity,
  key_index: index,
});

test("only the decode path's MissingKey names a key pair; everything else is hard", () => {
  assert.deepEqual(classifyMediaError(MISSING(13)), {
    kind: "missing_key",
    identity: PEER,
    pair: keyPairId(PEER, 13),
  });
  assert.deepEqual(classifyMediaError(MISSING(2, `${PEER}:screen`)), {
    kind: "missing_key",
    identity: `${PEER}:screen`,
    pair: `${PEER}:screen@2`,
  });
  // An index outside the worker's ring is a plaintext frame's last byte, not
  // a key pair (its failure count is NaN and it re-emits every frame).
  assert.deepEqual(classifyMediaError(MISSING(16)), { kind: "hard" });
  assert.deepEqual(classifyMediaError(MISSING(200)), { kind: "hard" });
  // The decoy / withheld key (leg 9): the key it holds is wrong.
  assert.deepEqual(classifyMediaError(INVALID), { kind: "hard" });
  // The encode path's missing key names no decode pair.
  assert.deepEqual(
    classifyMediaError(
      new Error(`MissingKey: key set not found for ${PEER} at index 3`),
    ),
    { kind: "hard" },
  );
  assert.deepEqual(classifyMediaError("not an error"), { kind: "hard" });
  assert.deepEqual(classifyMediaError(undefined), { kind: "hard" });
});

test("🔴 a hard error landing DURING the install counts against a reference taken before it", () => {
  // Review of 9e5fa880 (MED): the installer awaits importKey per entry after
  // each post; an InvalidKey between those awaits used to be stamped before a
  // reference taken after the install resolved, and the probe healed over the
  // silenced index 10 s later.
  const ledger = new MediaErrorLedger();
  const installRef = 1_000;
  ledger.noteError(INVALID, 1_005); // between the installer's awaits
  ledger.noteInstalled([entry(13)], 1_010); // the install resolves
  assert.equal(ledger.errorSince(installRef), true);
  // An error strictly before the reference is the latch's own, not since.
  const older = new MediaErrorLedger();
  older.noteError(INVALID, 999);
  older.noteInstalled([entry(13)], 1_010);
  assert.equal(older.errorSince(installRef), false);
  // At the reference itself: since (conservative).
  const same = new MediaErrorLedger();
  same.noteError(INVALID, installRef);
  assert.equal(same.errorSince(installRef), true);
  // No error ever: not "since" even a reference of 0.
  assert.equal(new MediaErrorLedger().errorSince(0), false);
});

test("a missing key for a pair the install covers is superseded, whichever lands first", () => {
  // The join-race MissingKey: the worker judged the frame before the setKey
  // message reached it, so the setKey resets the index afterwards.
  const before = new MediaErrorLedger();
  before.noteError(MISSING(13), 1_005);
  before.noteInstalled([entry(13)], 1_010);
  assert.equal(before.errorSince(1_000), false);
  assert.deepEqual(before.uncoveredPairs(), []);
  // Previous-epoch entries count as installed too.
  const prev = new MediaErrorLedger();
  prev.noteError(MISSING(12), 900);
  prev.noteInstalled([entry(12), entry(13)], 1_010);
  assert.equal(prev.errorSince(1_000), false);
});

test("🔴 a missing key that lands AFTER the sender's install completed is a withheld commit, and stands until the next install (M1)", () => {
  // Re-review of de4879c2: the DS withholds a roster-neutral Remove + re-Add
  // of P from this member only; P's new session sends at an index this side
  // never got. The one MissingKey is the only local sign — it must hold.
  const ledger = new MediaErrorLedger();
  ledger.noteInstalled([entry(2)], 1_010); // P installed at epoch 2
  ledger.noteError(MISSING(4), 5_000); // P sends at 4; this side never got 3, 4
  assert.equal(ledger.errorSince(1_000), true);
  assert.deepEqual(ledger.uncoveredPairs(), [keyPairId(PEER, 4)]);
  // A later install of P (any index) proves this side caught up.
  ledger.noteInstalled([entry(5)], 9_000);
  assert.equal(ledger.errorSince(1_000), false);
  // The join race whose error merely reached the main thread after the
  // install completed: the pair that install SET can only have been judged
  // before the worker processed the setKey (no path empties a slot), so it
  // is superseded whenever it lands — not a hold.
  const late = new MediaErrorLedger();
  late.noteInstalled([entry(13)], 1_010);
  late.noteError(MISSING(13), 1_020);
  assert.equal(late.errorSince(1_000), false);
  // ...while a pair that install did NOT set, landing after it, holds.
  late.noteError(MISSING(14), 1_030);
  assert.equal(late.errorSince(1_000), true);
  assert.deepEqual(late.uncoveredPairs(), [keyPairId(PEER, 14)]);
  // The sender's next install supersedes it whatever indexes it sets.
  late.noteInstalled([entry(15)], 2_000);
  assert.equal(late.errorSince(1_000), false);
  // LiveKit re-sets every known pair on each worker enable ack: a re-set of
  // an already-set pair records nothing and changes no verdict.
  const reset = new MediaErrorLedger();
  reset.noteInstalled([entry(13)], 1_010);
  reset.noteError(MISSING(14), 1_030); // foreign index: holds
  reset.noteInstalled([entry(13)], 1_500); // the replay, same pair
  assert.equal(reset.errorSince(1_000), true);
  assert.deepEqual(reset.uncoveredPairs(), [keyPairId(PEER, 14)]);
});

test("🔴 a missing key for a sender NO install covers holds while that sender is present, regardless of when it landed", () => {
  // A sender at an index this side does not hold: its index is silenced after
  // the one error (failureTolerance 0), so silence proves nothing.
  const OTHER = "01KWHY6P2RPHWNJADM59F97JGE:bee76df73dbf46725e328509842750b4";
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(14, OTHER), 500); // before the reference
  ledger.noteInstalled([entry(13)], 1_010); // PEER installed, OTHER never
  assert.equal(ledger.errorSince(1_000), true);
  assert.deepEqual(ledger.uncoveredPairs(), [keyPairId(OTHER, 14)]);
  // Gone from the SFU: its frames are gone with it (review of e2163ead, H1a).
  assert.equal(
    ledger.errorSince(1_000, (identity) => identity !== OTHER),
    false,
  );
  // Back, still uncovered: holds again. An install of that sender answers it.
  assert.equal(ledger.errorSince(1_000), true);
  ledger.noteInstalled([entry(14, OTHER)], 2_000);
  assert.equal(ledger.errorSince(1_000), false);
});

test("🔴 a Welcome joiner's pre-Welcome missing key is superseded by the sender's FIRST install (H1)", () => {
  // Review of e2163ead: a device joined by Welcome hears P's frames at epoch
  // E before it holds any key, then installs E+1 with `previous: []` (native
  // snapshots previous only across a commit it applied). P@E is never
  // installed; superseding by sender keeps the heal alive for the joiner.
  const ledger = new MediaErrorLedger();
  ledger.noteError(MISSING(4), 100); // P@4, before the Welcome
  ledger.noteInstalled([entry(5)], 1_010); // first install: P@5 only
  assert.equal(ledger.errorSince(1_000), false);
  assert.deepEqual(ledger.uncoveredPairs(), []);
});

test("forgetHardError keeps the uncovered senders; reset forgets the replaced group", () => {
  const OTHER = "01KWHY6P2RPHWNJADM59F97JGE:bee76df73dbf46725e328509842750b4";
  const ledger = new MediaErrorLedger();
  ledger.noteError(INVALID, 1_005);
  ledger.noteError(MISSING(14, OTHER), 1_006);
  ledger.forgetHardError(); // a healed latch
  assert.equal(ledger.errorSince(1_000), true); // OTHER still uncovered
  ledger.reset(); // group re-established
  assert.equal(ledger.errorSince(1_000), false);
  // After a reset a sender installed under the old group is unknown again, so
  // a missing key for it is a real hold until the new group installs it.
  ledger.noteError(MISSING(0), 2_000);
  assert.equal(ledger.errorSince(1_500), true);
  ledger.noteInstalled([entry(0)], 2_500);
  assert.equal(ledger.errorSince(1_500), false);
});

test("🔴 leg 9 ordering: the rejoiner's first new-key frame fails inside the settle → hold; leg 7: decrypts → heal", () => {
  // The session-level sequence, composed from the pure parts: the latch at
  // install seq 3, the Remove epoch (seq 4, ref 1_000), the Add epoch (seq 5,
  // ref 2_000), the peer re-added and publishing all-new SIDs.
  const witness = { present: true, readdedAfterLatch: true, sidsAllNew: true };
  const judge = (ledger: MediaErrorLedger, installRef: number) =>
    loudHealVerdict({
      origin: "media",
      latchedInstallSeq: 3,
      installSeq: 5,
      errorSinceInstall: ledger.errorSince(installRef),
      settleElapsed: true,
      rosterConsistent: true,
      peers: [witness],
    });
  // Leg 9: the key withheld and never released.
  const leg9 = new MediaErrorLedger();
  leg9.noteError(INVALID, 100); // the latch's own error
  leg9.noteInstalled([entry(12)], 1_010); // Remove epoch at 1_000
  leg9.noteError(MISSING(13), 2_005); // join-race frame during the Add install
  leg9.noteInstalled([entry(13)], 2_010); // Add epoch at 2_000, supersedes it
  assert.equal(judge(leg9, 2_000), "heal"); // nothing since — so far
  leg9.noteError(INVALID, 2_400); // first frame under the new key fails
  assert.equal(judge(leg9, 2_000), "hold");
  // Leg 7: released before the rejoin; the new-key frames decrypt.
  const leg7 = new MediaErrorLedger();
  leg7.noteError(INVALID, 100);
  leg7.noteInstalled([entry(12)], 1_010);
  leg7.noteError(MISSING(13), 2_005);
  leg7.noteInstalled([entry(13)], 2_010);
  assert.equal(judge(leg7, 2_000), "heal");
});

// ---- mix detected: what the session does, by mode ---------------------------

test("🔴 a mix found while still negotiating is DECLARED (T0c — the joiner into a mixed call)", () => {
  // A joiner lands in a call that already holds a plaintext participant.
  // Enable waits for a consistent roster, so gating the declaration on
  // "E2EE enabled" left it in negotiating forever: paused, amber, no banner,
  // no way to consent to plaintext.
  assert.equal(mixDetectedAction(NEGOTIATING), "declare");
});

test("a mix found in e2ee (T1) or while already mixed is declared", () => {
  assert.equal(mixDetectedAction(E2EE), "declare");
  assert.equal(mixDetectedAction(MIXED), "declare");
});

test("a mix found in an interlude only runs the machine (re-upgrade cancel)", () => {
  assert.equal(mixDetectedAction(INTERLUDE_UNCONF), "transition");
  assert.equal(mixDetectedAction(INTERLUDE_CONF), "transition");
});

test("a mix is ignored on a plain call and after call_full", () => {
  assert.equal(mixDetectedAction({ kind: "off" }), "ignore");
  assert.equal(mixDetectedAction({ kind: "call_full" }), "ignore");
});

// ---- Gate (d): the decode witness -------------------------------------------

const witness = (over: Partial<DecodeWitness> = {}): DecodeWitness => ({
  available: true,
  dropping: [],
  live: [],
  ...over,
});

test("gate (d): a sender whose frames are being DROPPED takes the chip amber", () => {
  // Every other gate is satisfied: native healthy, every publisher observed
  // encrypted, our own declarations GCM, roster verified. Before gate (d) this
  // was green — and it was green in exactly the case the worker was discarding
  // a peer's every frame at an index it had marked invalid.
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["bob:d1"],
        observedEncrypted: new Map([["bob:d1", true]]),
      }),
    ),
    "e2ee",
  );
  assert.equal(
    chipState(
      baseChip({
        publishingIdentities: ["bob:d1"],
        observedEncrypted: new Map([["bob:d1", true]]),
        decodeWitness: witness({ dropping: ["bob:d1"], live: [] }),
      }),
    ),
    "resecuring",
  );
});

test("🔴 gate (d): NO witness is amber, never green", () => {
  // The heartbeat is the whole mechanism. A build that lost the worker patch,
  // a dead worker, a listener never armed — each stops the sample, and each
  // must degrade the chip rather than quietly remove the gate. Exempting on
  // "no evidence" is the reasoning that produced the silent green six review
  // rounds kept finding somewhere new.
  assert.equal(
    chipState(baseChip({ decodeWitness: witness({ available: false }) })),
    "resecuring",
  );
});

test("🔴 gate (d) can only WITHHOLD green — it never produces a red", () => {
  // One-way, by construction: the witness may cost a green and may not mint a
  // loud verdict. Two earlier attempts at this area died of a FALSE RED, so
  // this is pinned rather than left to reading the code.
  for (const w of [
    witness({ available: false }),
    witness({ dropping: ["bob:d1"] }),
  ]) {
    assert.equal(chipState(baseChip({ decodeWitness: w })), "resecuring");
  }
  // ...and it cannot mask one either: a latched error still reads loud.
  assert.equal(
    chipState(
      baseChip({
        latch: MEDIA_KEYED,
        decodeWitness: witness({ available: false }),
      }),
    ),
    "not_encrypted",
  );
  // ...nor pick the loud SHADE beyond its `dropping` check: a keyed control
  // latch under an UNAVAILABLE witness is still loud — `cannot_verify`, since
  // "no sample" cannot support the positive claim "not encrypted" either.
  assert.equal(
    chipState(
      baseChip({
        latch: CONTROL_KEYED,
        decodeWitness: witness({ available: false }),
      }),
    ),
    "cannot_verify",
  );
});

test("summarizeDecodeWitness: dropped counts as dropping, delivered counts as live", () => {
  const w = summarizeDecodeWitness([
    { identity: "bob:d1", indexes: [{ keyIndex: 3, seen: 30, dropped: 30 }] },
    { identity: "carol:d1", indexes: [{ keyIndex: 3, seen: 30, dropped: 0 }] },
  ]);
  assert.deepEqual(w.dropping, ["bob:d1"]);
  assert.deepEqual(w.live, ["carol:d1"]);
  assert.equal(w.available, true);
});

test("summarizeDecodeWitness: a sender mid-rotation is BOTH, and dropping is what gates", () => {
  // Two indexes in flight at once: the new one gets through, the old one is
  // still being discarded. The gate must read the drop — the sender is still
  // sending frames this device cannot read.
  const w = summarizeDecodeWitness([
    {
      identity: "bob:d1",
      indexes: [
        { keyIndex: 2, seen: 5, dropped: 5 },
        { keyIndex: 3, seen: 25, dropped: 0 },
      ],
    },
  ]);
  assert.deepEqual(w.dropping, ["bob:d1"]);
  assert.deepEqual(w.live, ["bob:d1"]);
  assert.equal(
    chipState(baseChip({ decodeWitness: w })),
    "resecuring",
    "a live new index excused a dead old one",
  );
});

test("summarizeDecodeWitness: an empty window is available and clean", () => {
  // Nothing arriving is not a failure — nothing is being dropped. The
  // heartbeat itself is what proves the witness is wired.
  const w = summarizeDecodeWitness([]);
  assert.deepEqual(w, { available: true, dropping: [], live: [] });
  assert.equal(chipState(baseChip({ decodeWitness: w })), "e2ee");
});
