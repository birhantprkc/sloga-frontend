#!/usr/bin/env node
/*
 * selftest-sampler.mjs — drives observer-sampler.js against synthetic
 * getStats() reports, asserts its REFUSALS, checks the reducer's payload-key
 * contract AGAINST THE EMITTERS, and generates every trace fixture FROM the
 * key sets it extracted from those emitters.
 *
 *   node selftest-sampler.mjs <outdir>
 *
 * ---------------------------------------------------------------------------
 * 🔴 THE DEFECT THIS FILE EXISTS TO PREVENT (wave 0, lane W0-C).
 *
 * Wave 0's fixtures were HAND-WRITTEN using key names the lane had GUESSED
 * (`size`, `censusSize`, `subjectSidPresent`, `publications: [{...}]`), and
 * the reducer read those same guesses through an alias list. The emitters
 * emitted `gateSize`, `publicationCount`, `subjectInPublications` and
 * `publications: [ "..." ]` — STRINGS. The selftest was green. Decision-table
 * case G2 passed on a fixture that could not occur; measured against the real
 * key sets, the same capture read `DECISION (§2.5) : no row`.
 *
 * Fixing the aliases would not have fixed that. The METHOD was the defect:
 * a harness that validates a re-typed copy of the needle instead of the
 * artifact. So:
 *
 *   - there are no aliases in the reducer any more;
 *   - the `at` literals and payload key sets are EXTRACTED from
 *     `components/rtc/state.tsx` and `components/rtc/mlsCallSession.ts`
 *     (read-only — this lane does not own them);
 *   - the check runs BOTH WAYS: the reducer may not read a key no emitter
 *     emits, and an emitter may not emit a key the reducer does not know;
 *   - every trace fixture is GENERATED from the extracted key set, and a key
 *     with no declared fixture value is a hard failure, not a blank;
 *   - and the whole extraction is itself proved against a deliberately
 *     CORRUPTED COPY of an emitter before any of it is believed.
 *
 * The controls asserted here (each must FAIL first, then the good case pass):
 *   S1  start() with NO RTCPeerConnection captured  -> throws
 *   S2  start() with no carrier pinned              -> throws
 *   S3  start() with no shape                       -> throws
 *   S4  a run whose carrier byte series stalls      -> "discarded"
 *   S5  the same run with a live carrier            -> "continuous"
 *   S6  the dead-carrier dump DIFFERS from the good one
 *   E*  the emitter <-> reducer key contract, both directions
 *   X*  the emitter check itself, against a corrupted emitter copy
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { extractEmitters } from "./emitter-extract.mjs";
import {
  COMMON_KEYS,
  GATE_CONTEXT_KEYS,
  REQUIRE_CURRENT_ROOM,
  PUB_ENTRY_KEYS,
  PUB_ENTRY_READS,
  READS,
  SEAMS,
  SEAM_KEYS,
  seriesByRole,
  ssrcChanges,
  subjectFlowWindows,
  pinLeakWindow,
} from "./gate-trace-reduce.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "observer-sampler.js"), "utf8");
// The emitters. SLOGA_EMITTERS (colon separated) overrides the default pair
// so this harness can be run from a COPY of the leg directory; the paths
// actually used are PRINTED, because a check pointed at the wrong file is a
// check that proves nothing.
const EMITTER_FILES = process.env.SLOGA_EMITTERS
  ? process.env.SLOGA_EMITTERS.split(":").filter((x) => x !== "")
  : [
      path.resolve(HERE, "../../components/rtc/state.tsx"),
      path.resolve(HERE, "../../components/rtc/mlsCallSession.ts"),
    ];

const outdir = process.argv[2];
if (!outdir) {
  process.stderr.write("usage: node selftest-sampler.mjs <outdir>\n");
  process.exit(2);
}
fs.mkdirSync(outdir, { recursive: true });

let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    process.stdout.write(`  CONTROL PASS  ${name}\n`);
  } else {
    failures += 1;
    process.stdout.write(`  CONTROL FAIL  ${name}${detail ? " — " + detail : ""}\n`);
  }
}
function expectThrow(name, fn, needle) {
  let threw = null;
  try {
    fn();
  } catch (e) {
    threw = e;
  }
  if (!threw) {
    check(name, false, "it did NOT throw — the refusal is missing, so a bad run would look green");
    return;
  }
  if (needle && !String(threw.message).includes(needle)) {
    check(name, false, `threw, but without ${JSON.stringify(needle)}: ${threw.message}`);
    return;
  }
  check(name, true);
}

function writeAtomic(file, text) {
  const buf = Buffer.from(text, "utf8");
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  try {
    fs.writeSync(fd, buf, 0, buf.length, 0);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

// --------------------------------------------------------------------------
// A minimal browser surface: only what observer-sampler.js actually touches.
// --------------------------------------------------------------------------

class FakeTrack {
  constructor(id) {
    this.id = id;
    this.kind = "audio";
    this.muted = false;
    this.enabled = false; // a gate-held pause reads exactly this
    this.readyState = "live";
  }
}

function makeSampler({ scenario }) {
  const win = {};
  const nav = { userAgent: "selftest/1 (node)" };
  let intervalCb = null;

  class FakePC {
    constructor() {
      this._listeners = [];
      this._rows = [];
    }
    addEventListener(type, fn) {
      if (type === "track") this._listeners.push(fn);
    }
    emitTrack(ev) {
      for (const fn of this._listeners) fn(ev);
    }
    getStats() {
      const rows = this._rows;
      return Promise.resolve({
        forEach(cb) {
          for (const r of rows) cb(r);
        },
      });
    }
  }

  win.RTCPeerConnection = FakePC;
  const fn = new Function("window", "navigator", "performance", "console", "setInterval", "clearInterval", SRC);
  fn(
    win,
    nav,
    performance,
    { info() {}, warn() {}, error() {}, log() {}, table() {} },
    (cb) => {
      intervalCb = cb;
      return 1;
    },
    () => {
      intervalCb = null;
    },
  );

  return { win, FakePC, api: win.SLOGA_LEG, tick: () => intervalCb && intervalCb(), scenario };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

// --------------------------------------------------------------------------
// S1 / S2 / S3 — the refusals
// --------------------------------------------------------------------------

process.stdout.write("=== sampler refusals (known-bad controls) ===\n");
{
  const s = makeSampler({ scenario: "refusals" });
  expectThrow("S1 start() with no RTCPeerConnection captured", () => s.api.start({ shape: "b", label: "x", consent: "yes" }), "no RTCPeerConnection was captured");
  const pc = new s.win.RTCPeerConnection();
  expectThrow("S2 start() with no carrier pinned", () => s.api.start({ shape: "b", label: "x", consent: "yes" }), "no carrier pinned");
  s.api.carrier("PA_CARRIER");
  expectThrow("S3 start() with no shape", () => s.api.start({ label: "x", consent: "yes" }), "shape");
  // 🔴 wave-0c item 11. The dump carried no `consent`, so the reducer's
  // cross-check `if (dump.consent && dump.consent !== args.consent)` was DEAD
  // CODE and the whole H3 polarity rule rested on a CLI flag with nothing on
  // the capture to check it against.
  expectThrow("S3b start() with no consent arm", () => s.api.start({ shape: "b", label: "x" }), "which arm this run belongs to");
  check("S1b the peer connection WAS captured through the constructor hook", s.api._state.pcs.length === 1, `pcs=${s.api._state.pcs.length}`);
  void pc;
}

// --------------------------------------------------------------------------
// Scenario runner
// --------------------------------------------------------------------------

// 🔴 The cadence is REAL wall-clock time, not a fast loop. The dead-carrier
// control has to produce a stall that exceeds the tools' REAL 500 ms default
// threshold; on a fast loop that control PASSED AS CONTINUOUS — exactly the
// vacuous control this harness exists to prevent. Found by this harness.
const TICK_MS = 60;
const TICKS = 40;
const SSRC_CARRIER = 111111;
const SSRC_SUBJECT_PRE = 222222;
const SSRC_SUBJECT_POST = 333333; // the fresh SSRC on rejoin — the fiducial
const CALL1_START_TICK = 2; // `plaintextcall1` only: the operator speaking in call 1
const CALL1_END_TICK = 6;
const REJOIN_TICK = 18;
const LEAK_END_TICK = 30;
const CARRIER_DEATH_TICK = 20;
const LINGER_TICKS = 4; // how long the OLD inbound-rtp row survives the rejoin
const STALL_THRESHOLD_MS = 500; // the reducer's real default

/**
 * @param {"plaintext"|"plaintextcall1"|"ciphertext"|"bytesonly"|"deadcarrier"|"nocontrol"|"lingering"} scenario
 */
async function runScenario(scenario) {
  const s = makeSampler({ scenario });
  const pc = new s.win.RTCPeerConnection();

  const carrierTrack = new FakeTrack("carrier-track");
  const subjPreTrack = new FakeTrack("subject-track-pre");
  const subjPostTrack = new FakeTrack("subject-track-post");

  const emit = (track, participantSid, trackSid, lkFlag) => {
    const receiver = { track };
    if (lkFlag) receiver.lk_e2ee = true;
    pc.emitTrack({ track, streams: [{ id: `${participantSid}|${trackSid}` }], receiver, transceiver: { mid: "0" } });
  };
  emit(carrierTrack, "PA_CARRIER", "TR_carrier", false);
  emit(subjPreTrack, "PA_SUBJECT1", "TR_subject_pre", false);

  s.api.carrier("PA_CARRIER");
  // The no-consent ARM of this harness. The reducer refuses a dump whose
  // declared arm disagrees with --consent, so the scenarios reduced with
  // `--consent no` must declare it here.
  const armOf = (sc) => (sc === "bytesonly" || sc === "ciphertext" || sc === "nocontrol" ? "no" : "yes");
  s.api.start({ shape: "b", label: `selftest-${scenario}`, consent: armOf(scenario), intervalMs: 100 });

  let cBytes = 10000;
  let cEnergy = 1.0;
  let sBytes = 5000;
  let sEnergy = 0.5;
  let sConceal = 100;

  for (let i = 0; i < TICKS; i++) {
    if (i === REJOIN_TICK) emit(subjPostTrack, "PA_SUBJECT2", "TR_subject_post", false);

    const carrierAlive = scenario === "deadcarrier" ? i < CARRIER_DEATH_TICK : true;
    if (carrierAlive) {
      cBytes += 200;
      cEnergy += 0.01;
    }
    const carrierRow = {
      type: "inbound-rtp",
      kind: "audio",
      ssrc: SSRC_CARRIER,
      trackIdentifier: carrierTrack.id,
      timestamp: 1000 + i,
      bytesReceived: cBytes,
      packetsReceived: 100 + i * 5,
      audioLevel: carrierAlive ? 0.2 : 0,
      totalAudioEnergy: cEnergy,
      concealedSamples: 10,
      totalSamplesReceived: 48000 + i * 480,
    };
    if (scenario === "nocontrol") carrierRow.totalAudioEnergy = 1.0; // carrier flat: NO positive control

    // 🔴 `plaintextcall1` reproduces §2.4's actual protocol: the operator is
    // already speaking BEFORE the rejoin and the sampler was started BEFORE
    // joining, so there is a FLOW WINDOW IN CALL 1, on the OLD ssrc. Wave 0's
    // reducer read `flow[0].from` as the leak instant and measured M3 against
    // that window.
    const call1 = scenario === "plaintextcall1" && i >= CALL1_START_TICK && i < CALL1_END_TICK;
    const leaking = i >= REJOIN_TICK && i < LEAK_END_TICK;
    if (call1) {
      sBytes += 1000;
      sEnergy += 0.02;
    }
    if (leaking) {
      sBytes += 1000;
      if (scenario === "plaintext" || scenario === "plaintextcall1" || scenario === "lingering") sEnergy += 0.02;
      if (scenario !== "plaintext" && scenario !== "plaintextcall1" && scenario !== "lingering") sConceal += 480;
    }
    const subjectRow = {
      type: "inbound-rtp",
      kind: "audio",
      ssrc: i < REJOIN_TICK ? SSRC_SUBJECT_PRE : SSRC_SUBJECT_POST,
      trackIdentifier: i < REJOIN_TICK ? subjPreTrack.id : subjPostTrack.id,
      timestamp: 1000 + i,
      bytesReceived: sBytes,
      packetsReceived: 50 + (leaking || call1 ? i * 5 : 0),
      audioLevel: (scenario === "plaintext" || scenario === "plaintextcall1" || scenario === "lingering") && (leaking || call1) ? 0.3 : 0,
      totalAudioEnergy: sEnergy,
      concealedSamples: sConceal,
      totalSamplesReceived: 48000 + i * 480,
    };
    if (scenario === "bytesonly") {
      // 🔴 The control for "bytesReceived alone can NEVER establish plaintext":
      // bytes flow exactly as in the plaintext run, but the energy fields are
      // ABSENT from the stats report. A missing field is not flatness.
      delete subjectRow.audioLevel;
      delete subjectRow.totalAudioEnergy;
      delete subjectRow.concealedSamples;
    }

    // 🔴 THE LINGERING ROW (wave-0c item 9, previously untested). Real
    // `getStats()` reports the OLD inbound-rtp beside the new one for some
    // hundreds of ms after a republish, and `roleOf` answers "subject" for
    // every remote audio row that is not the pinned carrier. Read pairwise
    // over the flattened list, that alternation emitted a "change" on nearly
    // every tick — the earliest inside call 1 — which moved the fiducial and
    // silently disabled 2.4's fiducial-disagreement discard. The selftest
    // never produced this shape: `pc._rows` was always exactly two rows.
    const lingerRow =
      scenario === "lingering" && i >= REJOIN_TICK && i < REJOIN_TICK + LINGER_TICKS
        ? {
            ...subjectRow,
            ssrc: SSRC_SUBJECT_PRE,
            trackIdentifier: subjPreTrack.id,
            bytesReceived: sBytes - 1000,
            audioLevel: 0,
          }
        : null;
    pc._rows = lingerRow ? [carrierRow, subjectRow, lingerRow] : [carrierRow, subjectRow];
    s.tick();
    await flush();
    await new Promise((r) => setTimeout(r, TICK_MS));
  }

  s.api.stop();
  return { dump: s.api.dump(), s };
}

process.stdout.write("=== sampler scenarios ===\n");

const results = {};
for (const scenario of ["plaintext", "plaintextcall1", "ciphertext", "bytesonly", "deadcarrier", "nocontrol", "lingering"]) {
  const { dump } = await runScenario(scenario);
  results[scenario] = dump;
  const file = path.join(outdir, `sampler-${scenario}.json`);
  writeAtomic(file, JSON.stringify(dump));
  process.stdout.write(`  wrote ${file}  ticks=${dump.ticks.length} carrier=${dump.carrierContinuity.verdict}\n`);
}

check("S4 dead carrier => carrierContinuity DISCARDED", results.deadcarrier.carrierContinuity.verdict === "discarded", `got ${results.deadcarrier.carrierContinuity.verdict}`);
check("S5 live carrier => carrierContinuity CONTINUOUS", results.plaintext.carrierContinuity.verdict === "continuous", `got ${results.plaintext.carrierContinuity.verdict}`);
check("S6 the dead-carrier control DIFFERS from the good input", JSON.stringify(results.deadcarrier.ticks) !== JSON.stringify(results.plaintext.ticks), "the control is byte-identical to the real input and therefore proves nothing");

// 🔴 A control has to CROSS the threshold it targets. Wave 0's dead-carrier
// fixture ticked ~2 ms apart, so its ~80 ms stall never crossed the real
// 500 ms threshold and read as CONTINUOUS. Assert the crossing itself.
{
  const stalls = results.deadcarrier.carrierContinuity.stalls ?? [];
  const worst = stalls.reduce((m, s) => Math.max(m, s.ms ?? 0), 0);
  check(
    "S4b the dead-carrier control's stall actually CROSSES the 500 ms threshold it targets",
    worst > STALL_THRESHOLD_MS,
    `the longest carrier stall in the control is ${worst} ms, which does NOT exceed ${STALL_THRESHOLD_MS} ms — the control is VACUOUS`,
  );
  const span = results.plaintext.ticks.length ? results.plaintext.ticks[results.plaintext.ticks.length - 1].t - results.plaintext.ticks[0].t : 0;
  check("S4c the good run spans real wall-clock time (not a fast loop)", span > STALL_THRESHOLD_MS * 2, `the good capture spans only ${span} ms`);
}

check(
  "S7 the subject's fresh SSRC on rejoin is recorded",
  results.plaintext.ticks.some((tk) => tk.samples.some((x) => x.role === "subject" && x.ssrc === SSRC_SUBJECT_POST)) &&
    results.plaintext.ticks.some((tk) => tk.samples.some((x) => x.role === "subject" && x.ssrc === SSRC_SUBJECT_PRE)),
  "the fiducial is missing from the series",
);
check("S8 role-by-elimination survives the subject's participant-sid change", results.plaintext.publications.filter((p) => p.role === "subject").length === 2, `subject publications = ${results.plaintext.publications.filter((p) => p.role === "subject").length}`);
check("S9 muted/enabled are recorded ONLY under annotationOnly", results.plaintext.ticks[0].samples.every((x) => x.annotationOnly && !("muted" in x) && !("enabled" in x)), "a mute flag escaped into the top level of a sample, where it could reach a verdict");

// The B4 control's own precondition: the call-1 dump must really carry a flow
// window BEFORE the fiducial, or the control proves nothing.
//
// 🔴 "Pre-fiducial" is now `w.from < fid` — the EXACT complement of
// `pinLeakWindow`'s acceptance rule. It used to be `w.from < fid - intervalMs`,
// i.e. the exact complement of the TOLERANCE, so the control could never probe
// the boundary the tolerance created and the tolerance went untested for the
// whole of wave 0b.
{
  const rows = seriesByRole(results.plaintextcall1, "subject", 0);
  const flow = subjectFlowWindows(rows, 500);
  const changes = ssrcChanges(rows);
  const pre = changes.length ? flow.filter((w) => w.from < changes[0].t) : [];
  check(
    "S10 the call-1 control really has a flow window BEFORE the ssrc-change fiducial",
    pre.length > 0 && flow.length > pre.length,
    `flow windows=${flow.length} pre-fiducial=${pre.length} ssrcChanges=${changes.length} — without a pre-fiducial window the B4 control is vacuous`,
  );
}

// 🔴 THE BOUNDARY the deleted tolerance used to admit (wave-0c item 9): a
// call-1 flow window that opens LESS THAN ONE SAMPLING INTERVAL before the
// fiducial. Under `w.from >= fid - intervalMs` it QUALIFIED, and M3 was then
// measured against a window on the OLD ssrc, before the rejoin.
{
  const d = JSON.parse(JSON.stringify(results.plaintext));
  const idx = d.ticks.findIndex((tk) => tk.samples.some((s) => s.role === "subject" && s.ssrc === SSRC_SUBJECT_POST));
  const fid = d.ticks[idx].t;
  let injected = 0;
  for (const k of [idx - 1, idx]) {
    const tk = d.ticks[k];
    const model = tk.samples.find((s) => s.role === "subject");
    tk.samples.push({ ...model, ssrc: SSRC_SUBJECT_PRE, trackIdentifier: "subject-track-pre", trackIdentity: "subject-track-pre", bytesReceived: 900000 + injected * 1000, audioLevel: 0, annotationOnly: model.annotationOnly });
    injected += 1;
  }
  writeAtomic(path.join(outdir, "sampler-boundary.json"), JSON.stringify(d));
  const rows = seriesByRole(d, "subject", 0);
  const flow = subjectFlowWindows(rows, 500);
  const changes = ssrcChanges(rows);
  const boundary = flow.filter((w) => w.ssrc === SSRC_SUBJECT_PRE && w.from < fid && w.from >= fid - d.intervalMs);
  check(
    "S10b the boundary control really has a call-1 window INSIDE the deleted tolerance (from < fiducial, within one interval)",
    boundary.length > 0,
    `windows on the old ssrc inside [fid-${d.intervalMs}, fid): ${boundary.length} — without one this control cannot probe the tolerance`,
  );
  const pinned = pinLeakWindow(flow, changes, null);
  check(
    "S10c and it is REJECTED: the leak window is still the one on the FRESH ssrc",
    pinned.window !== null && pinned.window.ssrc === SSRC_SUBJECT_POST && pinned.rejected.some((w) => w.ssrc === SSRC_SUBJECT_PRE && w.from >= fid - d.intervalMs),
    `pinned ssrc=${pinned.window ? pinned.window.ssrc : "none"} rejected=${JSON.stringify(pinned.rejected.map((w) => [w.ssrc, w.from - fid]))}`,
  );
  check(
    "S10d the ssrc-change fiducial is UNMOVED by the lingering old rows (exactly one change, at the fresh ssrc's first tick)",
    changes.length === 1 && changes[0].t === fid,
    `changes=${JSON.stringify(changes.map((c) => [c.t - fid, c.to]))}`,
  );
}

// 🔴 THE LINGERING-ROW control (wave-0c item 9). Untested until now: the
// selftest only ever produced two rows per tick, so the pairwise reading of
// ssrcChanges was never exercised against the shape real getStats() produces.
{
  const rows = seriesByRole(results.lingering, "subject", 0);
  const changes = ssrcChanges(rows);
  const firstPost = rows.find((r) => r.ssrc === SSRC_SUBJECT_POST);
  // What the OLD pairwise reading would have said, computed here so the control
  // is not vacuous: it must genuinely differ.
  let pairwise = 0;
  let last = null;
  for (const r of rows) {
    if (last !== null && r.ssrc !== last) pairwise += 1;
    last = r.ssrc;
  }
  check(
    "S11 a lingering old inbound-rtp row does NOT manufacture ssrc changes (one change, at the fresh ssrc's first tick)",
    changes.length === 1 && firstPost && changes[0].t === firstPost.t,
    `changes=${JSON.stringify(changes.map((c) => c.t))} firstPost=${firstPost ? firstPost.t : "none"}`,
  );
  check(
    "S11b the control is NOT vacuous: read pairwise, the same rows produce MANY changes",
    pairwise > 2,
    `the pairwise reading found ${pairwise} change(s), so this capture does not contain the interleaving the fix targets`,
  );
  check(
    "S11c and the lingering rows really are in the capture (two subject ssrcs in one tick)",
    results.lingering.ticks.some((tk) => new Set(tk.samples.filter((s) => s.role === "subject").map((s) => s.ssrc)).size > 1),
    "no tick carries two subject rows",
  );
}

// --------------------------------------------------------------------------
// The emitter <-> reducer key contract, BOTH DIRECTIONS
// --------------------------------------------------------------------------

process.stdout.write("=== emitter <-> reducer payload-key contract ===\n");

function checkEmitterContract(extracted) {
  const problems = [];
  for (const at of SEAMS) {
    if (!extracted.seams.has(at)) problems.push(`E3 the reducer knows seam ${at} but NO emitter emits it`);
  }
  for (const at of extracted.seams.keys()) {
    if (!SEAMS.includes(at)) problems.push(`E4 an emitter emits seam ${at} but the reducer's SEAMS list lacks it`);
  }
  for (const [at, v] of extracted.seams) {
    const known = new Set([...COMMON_KEYS, ...GATE_CONTEXT_KEYS, ...(SEAM_KEYS[at] ?? [])]);
    for (const k of v.keys) {
      if (!known.has(k)) problems.push(`E2 ${at}.${k} is EMITTED but the reducer does not know it (it would be silently IGNORED)`);
    }
    for (const k of READS[at] ?? []) {
      if (!v.keys.has(k)) problems.push(`E1 the reducer READS ${at}.${k} but no emitter emits it`);
    }
  }
  if (!extracted.pubEntryKeys) {
    problems.push("E5 the publications[] entry key set could not be extracted from the emitters, so nothing about it is verified");
  } else {
    for (const k of extracted.pubEntryKeys) {
      if (!PUB_ENTRY_KEYS.includes(k)) problems.push(`E2 publications[].${k} is EMITTED but the reducer does not know it`);
    }
    for (const k of PUB_ENTRY_READS) {
      if (!extracted.pubEntryKeys.has(k)) problems.push(`E1 the reducer READS publications[].${k} but no emitter emits it`);
    }
  }
  for (const p of extracted.problems) {
    problems.push(`E6 ${p.kind} ${path.basename(p.file ?? "?")}:${p.line ?? "?"} — ${p.detail}`);
  }
  // E7 — `currentRoom` is REQUIRED, not merely known. A rename is caught by E2
  // above; a DELETION would otherwise be a NOTE, and it turns the H2
  // abandoned-Room filter into a pass-through.
  for (const at of REQUIRE_CURRENT_ROOM) {
    const v = extracted.seams.get(at);
    if (!v) continue; // E3 already reports a seam nobody emits
    if (!v.keys.has("currentRoom")) {
      problems.push(`E7 ${at} does not emit currentRoom. Records of that seam then cannot be attributed to the live Room, and the H2 filter that keeps an ABANDONED Room's records out of a verdict becomes a pass-through for them.`);
    }
  }
  return problems;
}

// 🔴 THE CONTROL COMES FIRST. Corrupt a COPY of an emitter (never the real
// file — this lane does not own it) and prove the check goes RED, before any
// green from it is believed.
const corruptDir = path.join(outdir, "emitters-corrupt");
fs.mkdirSync(corruptDir, { recursive: true });
{
  const real = fs.readFileSync(EMITTER_FILES[0], "utf8");
  // The renamed key must be one the reducer actually READS, or E1 cannot fire.
  const renamed = real.replaceAll("subjectSidAssigned:", "subjectSidAssignedXX:");
  const fileA = path.join(corruptDir, "state.renamed.tsx");
  writeAtomic(fileA, renamed);
  check("X0 the corrupted emitter copy DIFFERS from the real file", renamed !== real, "the replacement matched nothing, so the control is byte-identical and proves nothing");

  const probs = checkEmitterContract(extractEmitters([fileA, EMITTER_FILES[1]]));
  check(
    "X1 a RENAMED emitter key is caught in BOTH directions (E1 reads-but-unemitted, E2 emitted-but-unknown)",
    probs.some((p) => p.startsWith("E1") && p.includes("subjectSidAssigned")) && probs.some((p) => p.startsWith("E2") && p.includes("subjectSidAssignedXX")),
    `problems were: ${probs.join(" | ") || "(none — the check is VACUOUS)"}`,
  );

  // The `[object Object]` landmine at its source: an object ARGUMENT instead of
  // a pre-serialized string.
  const twoArg = real.replace(/"\[gate-trace\] "\s*\+\s*\n?\s*JSON\.stringify\(/, '"[gate-trace]", ');
  const fileB = path.join(corruptDir, "state.twoarg.tsx");
  writeAtomic(fileB, twoArg);
  check("X2a the two-argument control DIFFERS from the real file", twoArg !== real, "the replacement matched nothing");
  const probs2 = checkEmitterContract(extractEmitters([fileB, EMITTER_FILES[1]]));
  check(
    "X2 an emit site that passes an OBJECT ARGUMENT is caught (it renders as [object Object] in the packaged log)",
    probs2.some((p) => p.includes("not-pre-serialized")),
    `problems were: ${probs2.join(" | ") || "(none — the check is VACUOUS)"}`,
  );

  // A seam the reducer knows but nobody emits.
  const dropped = real.replaceAll('at: "localSenderCreated"', 'at: "localSenderCreatedXX"');
  const fileC = path.join(corruptDir, "state.dropseam.tsx");
  writeAtomic(fileC, dropped);
  const probs3 = checkEmitterContract(extractEmitters([fileC, EMITTER_FILES[1]]));
  check(
    "X3 a RENAMED seam literal is caught in both directions (E3 known-but-unemitted, E4 emitted-but-unknown)",
    probs3.some((p) => p.startsWith("E3") && p.includes("localSenderCreated")) && probs3.some((p) => p.startsWith("E4") && p.includes("localSenderCreatedXX")),
    `problems were: ${probs3.join(" | ") || "(none — the check is VACUOUS)"}`,
  );

  // 🔴 A DELETED `currentRoom`. A rename is caught as an unknown key; a
  // deletion used to be a NOTE, and it silently disarms the H2 filter.
  const noRoom = real.replaceAll("currentRoom: this.room() === room,", "");
  const fileD = path.join(corruptDir, "state.noroom.tsx");
  writeAtomic(fileD, noRoom);
  check("X5a the deleted-currentRoom control DIFFERS from the real file", noRoom !== real, "the replacement matched nothing");
  const probs4 = checkEmitterContract(extractEmitters([fileD, EMITTER_FILES[1]]));
  check(
    "X5 a seam that stops emitting currentRoom is caught (the H2 abandoned-Room filter would become a pass-through)",
    probs4.some((p) => p.startsWith("E7") && p.includes("localSenderCreated")) && probs4.some((p) => p.startsWith("E7") && p.includes("track.upstreamResumed")),
    `problems were: ${probs4.join(" | ") || "(none — the check is VACUOUS)"}`,
  );
}

const extracted = extractEmitters(EMITTER_FILES);
const contractProblems = checkEmitterContract(extracted);
process.stdout.write(`  emitters: ${EMITTER_FILES.join(', ')}\n  sites=${extracted.sites.length} seams=${extracted.seams.size}\n`);
for (const [at, v] of [...extracted.seams].sort((a, b) => a[0].localeCompare(b[0]))) {
  process.stdout.write(`    ${at.padEnd(28)} ${[...v.keys].join(",")}\n`);
}
process.stdout.write(`    ${"publications[]".padEnd(28)} ${extracted.pubEntryKeys ? [...extracted.pubEntryKeys].join(",") : "NOT EXTRACTABLE"}\n`);
check("E0 the emitter <-> reducer key contract holds in BOTH directions", contractProblems.length === 0, `\n      ${contractProblems.join("\n      ")}`);

// Keys the reducer knows but no emitter emits are reported, not failed: the
// reducer is allowed to know about a field it never sees, but nobody may be
// left guessing which.
{
  const info = [];
  for (const [at, v] of extracted.seams) {
    for (const k of SEAM_KEYS[at] ?? []) if (!v.keys.has(k)) info.push(`${at}.${k}`);
  }
  if (extracted.pubEntryKeys) for (const k of PUB_ENTRY_KEYS) if (!extracted.pubEntryKeys.has(k)) info.push(`publications[].${k}`);
  process.stdout.write(`  NOTE keys the reducer knows but no emitter currently emits (not read, so not a failure): ${info.join(", ") || "(none)"}\n`);
}

// --------------------------------------------------------------------------
// Fixture generation FROM the extracted key sets
// --------------------------------------------------------------------------

/**
 * 🔴 REACHABLE VALUES — the discipline this file already applied to key NAMES,
 * extended to key VALUES (wave-0c B3).
 *
 * `makeRec` validated that an override named a key an emitter EMITS. Nothing
 * validated that the VALUE could occur. So the C6 and C4 fixtures set
 * `subjectSidPresent: true` at `localSenderCreated` — a value pinned
 * livekit-client 2.15.13 cannot produce, because the emit at esm.mjs 23811
 * precedes both `track.sid = ti.sid` (23900) and `addTrackPublication` (23910),
 * and on a republish `unpublishTrack` deleted the map entry (24121) first.
 * "C6 is still reachable" and "an UpstreamResumed inside the window selects C4"
 * both passed ONLY because of that impossible value: with the field set to its
 * reachable value, both fixtures read C0.
 *
 * Every DECISION-BEARING field (everything in the reducer's READS /
 * PUB_ENTRY_READS) must therefore carry a declaration here, tied to the
 * emitter's own expression, and a fixture value outside it is a HARD ERROR.
 * A field with no declaration is also a hard error: adding a READ forces a
 * reachability justification rather than letting one be assumed.
 */
const SID_RE = /^TR_[A-Za-z0-9_-]+$/;
const SUBJECT_RE = /^[a-z_]+\/(TR_[A-Za-z0-9_-]+|no-sid)$/;
const isInt = (v) => typeof v === "number" && Number.isInteger(v) && v >= 0;

const REACHABLE = {
  // ---- gate context, shared by every seam that carries it -----------------
  "*.gate": {
    test: (v) => Array.isArray(v) && v.every((x) => ["negotiating", "enable-window", "mixed"].includes(x)),
    why: '`[...this.#publishGate]`, a Set of PublishGateReason — `export type PublishGateReason = "negotiating" | "enable-window" | "mixed"` (mlsCallSession.ts)',
  },
  "*.gateSize": { test: isInt, why: "`this.#publishGate.size`" },
  "*.gateGen": { test: isInt, why: "`this.#gateGen`, monotonic from 0" },
  "*.connectGen": { test: isInt, why: "`this.#connectGen`, monotonic from 0" },
  "*.passes": { test: (v) => v === null || isInt(v), why: "`this.#gateSweeper?.passes() ?? null` — null before a sweeper exists, a monotonic LIFETIME count after" },
  "*.currentRoom": { values: [true, false], why: "`this.room() === room`" },
  "*.subject": { test: (v) => typeof v === "string" && SUBJECT_RE.test(v), why: '`${track.source}/${gtSid ?? "no-sid"}` at the sender/track seams, `${pub.source}/${pub.trackSid}` at the publish seam' },
  "*.subjectSource": { test: (v) => typeof v === "string" && /^[a-z_]+$/.test(v), why: "`track.source` / `pub.source` — livekit's Track.Source enum" },
  "*.subjectSid": { test: (v) => v === null || SID_RE.test(v), why: "`track.sid ?? null`" },
  "*.publicationCount": { test: isInt, why: "`room.localParticipant.trackPublications.size`" },
  "*.publicationKeys": { test: (v) => Array.isArray(v) && v.every((x) => SID_RE.test(x)), why: "`[...room.localParticipant.trackPublications.keys()]` — the map is keyed by trackSid" },
  "*.publications": { test: (v) => Array.isArray(v), why: "`this.#gateTraceCensus(room)`; each ENTRY is validated against publications[].* below" },

  // ---- localSenderCreated ------------------------------------------------
  "localSenderCreated.subjectSidAssigned": {
    values: [true, false],
    why: "`gtSid !== null` where `gtSid = track.sid ?? null`. FALSE at a first publish (the emit at esm.mjs 23811 precedes `track.sid = ti.sid` at 23900); TRUE on a republish, where `unpublishTrack` deleted the map entry (24121) and never touched `track.sid`. BOTH are reachable, which is exactly why it can discriminate and `subjectSidPresent` could not.",
  },
  "localSenderCreated.subjectSidInPublications": {
    values: [false, null],
    why: "`gtSid === null ? null : trackPublications.has(gtSid)`. TRUE IS UNREACHABLE: at a first publish there is no sid at all, and on a republish the entry was deleted before this emit — `addTrackPublication` runs only at 23910, after the awaited `negotiate()` this emit sits inside.",
  },
  "localSenderCreated.upstreamPaused": { values: [true, false, null], why: "`isLocalTrack(track) ? track.isUpstreamPaused : null`" },
  "localSenderCreated.senderHasTrack": { values: [true, false], why: "`!!sender.track` — false exactly when a `replaceTrack(null)` has detached it" },
  "localSenderCreated.transportState": { values: ["new", "connecting", "connected", "disconnected", "failed", "closed", null], why: "`sender.transport?.state ?? null` — RTCDtlsTransportState" },

  // ---- localTrackPublished.entry -----------------------------------------
  "localTrackPublished.entry.subjectSidInPublications": {
    values: [true],
    why: "`trackPublications.has(pub.trackSid)` in the `localTrackPublished` handler. FALSE IS UNREACHABLE: `this.addTrackPublication(publication)` (esm.mjs 23910) runs immediately before `this.emit(ParticipantEvent.LocalTrackPublished, publication)` (23911) and the handler runs synchronously on that emit.",
  },
  "localTrackPublished.entry.subjectSid": { test: (v) => typeof v === "string" && SID_RE.test(v), why: "`pub.trackSid` — a publication always carries an assigned sid" },

  // ---- the rest ----------------------------------------------------------
  "disconnect.entry.via": { values: ["user", "connect-leading"], why: "`#gateTraceDisconnectVia`, declared `\"connect-leading\" | \"user\"`" },
  "disconnect.preclear.via": { values: ["user", "connect-leading"], why: "same field, consumed once at `disconnect()`'s first statement" },
  "disconnect.entry.connectGenPhase": { values: ["pre-bump"], why: "the entry record sits ABOVE the try, before `this.#connectGen++`" },
  "disconnect.preclear.connectGenPhase": { values: ["post-bump"], why: "the pre-clear record sits after `this.#connectGen++`" },
  "resumeGate.reason": { values: ["negotiating", "enable-window", "mixed"], why: "PublishGateReason" },
  "resumeGate.emptied": { values: [true, false], why: "whether the delete took the set to size 0" },
  "resumeGate.staleRoom": { values: [true, false], why: "the `this.room() !== room` early return is recorded under the same `at`" },
  "sweeper.dropped.stillCurrent": { values: [true, false], why: "`stillCurrent()` — the sweeper-scoped stale-writer guard, logged whether or not it holds" },
  "sweeper.dropped.sweeperGen": { test: isInt, why: "the `gen` captured when the sweeper was created (`const gen = ++this.#gateGen`) — bumped ONCE PER CALL, not per drive" },
  "rejoinFresh.phase": { values: ["enter", "afterDrop"], why: "the two literal phases #rejoinFresh emits" },
  "rejoinFresh.seq": { test: (v) => isInt(v) && v > 0, why: "`++this.#rejoinTraceSeq`" },

  // ---- publications[] entries -------------------------------------------
  "publications[].name": { test: (v) => typeof v === "string" && SUBJECT_RE.test(v), why: "`${gtPub.source}/${gtPub.trackSid}` — the key repauseSpent/repausePending use and the string track.upstreamResumed carries as its subject" },
  "publications[].source": { test: (v) => typeof v === "string" && /^[a-z_]+$/.test(v), why: "`gtPub.source`" },
  "publications[].trackSid": { test: (v) => typeof v === "string" && SID_RE.test(v), why: "`gtPub.trackSid`" },
  "publications[].upstreamPaused": { values: [true, false, null], why: "`gtTrack?.isUpstreamPaused ?? null`" },
  "publications[].hasSender": { values: [true, false], why: "`!!gtTrack?.sender` — genuinely two-valued for an arbitrary publication, unlike `hasSender` at localSenderCreated" },
  "publications[].senderHasTrack": { values: [true, false], why: "`!!gtTrack?.sender?.track`" },
  "publications[].transportState": { values: ["new", "connecting", "connected", "disconnected", "failed", "closed", null], why: "`gtTrack?.sender?.transport?.state ?? null`" },
  "publications[].upstream": { values: ["live", "quiet", "unpublished", "not-gated"], why: "`gtGated.upstream()` — UpstreamState is three-valued (`gatedPublicationsFrom`'s thunk) — plus the emitter's own `?? \"not-gated\"` for a publication the adapter SKIPPED (no track)" },
  "publications[].op": { values: ["pause", "repause", "none", "resume", "not-gated"], why: "`publishGateOp(...)`'s return type, plus the emitter's `?? \"not-gated\"`" },
};

function reachSpec(at, key) {
  return REACHABLE[`${at}.${key}`] ?? REACHABLE[`*.${key}`] ?? null;
}

function assertReachable(at, key, value) {
  const spec = reachSpec(at, key);
  if (!spec) {
    throw new Error(
      `${at}.${key} is DECISION-BEARING (the reducer READS it) but has no reachability declaration. Declare the values the emitter's own expression can produce, with the justification, rather than letting a fixture assume one.`,
    );
  }
  const ok = spec.values ? spec.values.some((v) => Object.is(v, value)) : spec.test(value);
  if (!ok) {
    throw new Error(
      `fixture value ${JSON.stringify(value)} for ${at}.${key} is NOT REACHABLE. ${spec.why}`,
    );
  }
}

/** Fixture values for the gate context, shared by every seam that carries it. */
const GATE_BASE = {
  gate: ["negotiating"],
  gateSize: 1,
  gateHeld: true,
  gateGen: 4,
  connectGen: 4,
  passes: 5,
  currentRoom: true,
};

const EMPTY_GATE = { gate: [], gateSize: 0, gateHeld: false };

const SEAM_BASE = {
  "connect.add": { e2eeCapable: true },
  "disconnect.entry": { via: "user", connectGenPhase: "pre-bump" },
  "disconnect.preclear": { via: "user", connectGenPhase: "post-bump" },
  pauseGate: { reason: "negotiating", edge: "add", staleRoom: false },
  "pauseGate.staleRoom": { reason: "negotiating", staleRoom: true },
  resumeGate: { reason: "negotiating", emptied: true, staleRoom: false, gate: [], gateSize: 0, gateHeld: false },
  "localTrackPublished.entry": {
    subject: "microphone/TR_subject_post",
    subjectSource: "microphone",
    subjectSid: "TR_subject_post",
    subjectSidInPublications: true,
    publicationCount: 1,
    publicationKeys: ["TR_subject_post"],
    publications: null, // filled from the extracted publications[] key set
  },
  localSenderCreated: {
    // The REPUBLISH shape: the track still carries the PREVIOUS publication's
    // sid (`unpublishTrack` never clears `track.sid`) and the map entry for it
    // is gone. That is C0's window, and every field here is reachable.
    subject: "microphone/TR_subject_pre",
    subjectSource: "microphone",
    subjectSid: "TR_subject_pre",
    subjectSidAssigned: true,
    subjectSidInPublications: false,
    publicationCount: 0,
    publicationKeys: [],
    publications: [],
    upstreamPaused: false,
    hasSender: true,
    senderHasTrack: true,
    transportState: "connected",
  },
  "sweeper.dropped": { stillCurrent: true, sweeperGen: 4 },
  "track.upstreamResumed": { subject: "microphone/TR_subject_post", subjectSource: "microphone", subjectSid: "TR_subject_post" },
  "track.processorUpdate": { subject: "microphone/TR_subject_post", subjectSource: "microphone", subjectSid: "TR_subject_post" },
  setMode: { branch: "lockstep", wasNegotiating: true, incoming: "e2ee", mode: "e2ee", latched: false, localConfirmed: null, hasMedia: true },
  "applyMode.effect": { event: "local_confirm", next: "interlude", do: "keep", enabled: false, reason: "local_confirm" },
  rejoinFresh: { phase: "enter", seq: 1, reason: "poisoned-successor", modeBefore: "e2ee", modeAfter: "negotiating", reestablishes: 0, state: "resecuring" },
  dropModeToNegotiating: { confirmedInterlude: true, modeBefore: "e2ee", modeAfter: "negotiating", state: "resecuring", ran: true },
};

/** The FIRST-PUBLISH shape of the sender seam: no sid to look up at all. */
const SENDER_NO_SID = {
  subject: "microphone/no-sid",
  subjectSid: null,
  subjectSidAssigned: false,
  subjectSidInPublications: null,
};

const PUB_ENTRY_BASE = {
  name: "microphone/TR_subject_post",
  source: "microphone",
  trackSid: "TR_subject_post",
  upstreamPaused: false,
  hasSender: true,
  senderHasTrack: true,
  transportState: "connected",
  upstream: "live",
  op: "pause",
};

function makePubEntry(overrides = {}) {
  if (!extracted.pubEntryKeys) throw new Error("cannot generate a publications[] entry: its key set was NOT EXTRACTABLE from the emitters");
  for (const k of Object.keys(overrides)) {
    if (!extracted.pubEntryKeys.has(k)) {
      throw new Error(`fixture override publications[].${k} names a key NO EMITTER EMITS — that is precisely the wave-0 defect`);
    }
  }
  const e = {};
  for (const k of extracted.pubEntryKeys) {
    if (k in overrides) e[k] = overrides[k];
    else if (k in PUB_ENTRY_BASE) e[k] = PUB_ENTRY_BASE[k];
    else throw new Error(`no fixture value declared for publications[].${k} — declare one rather than emitting a blank`);
    // 🔴 VALUES, not just names.
    if (PUB_ENTRY_READS.includes(k)) assertReachable("publications[]", k, e[k]);
  }
  return e;
}

/**
 * Build ONE record with EXACTLY the key set the emitter emits for that seam.
 * An override naming a key the emitter does not emit is a hard error, and so
 * is a value the emitter's own expression cannot produce.
 */
function makeRec(at, t, overrides = {}) {
  const seam = extracted.seams.get(at);
  if (!seam) throw new Error(`cannot generate a fixture for seam ${at}: no emitter emits it`);
  for (const k of Object.keys(overrides)) {
    if (!seam.keys.has(k)) {
      throw new Error(`fixture override ${at}.${k} names a key NO EMITTER EMITS — that is precisely the wave-0 defect`);
    }
  }
  const decisionBearing = new Set(READS[at] ?? []);
  const rec = { t, p: Math.round((t % 100000) * 1.0), at };
  for (const k of seam.keys) {
    if (COMMON_KEYS.includes(k)) continue;
    let v;
    if (k in overrides) v = overrides[k];
    else if (k in (SEAM_BASE[at] ?? {})) v = SEAM_BASE[at][k];
    else if (k in GATE_BASE) v = GATE_BASE[k];
    else throw new Error(`no fixture value declared for ${at}.${k} — declare one rather than emitting a blank`);
    if (k === "publications" && v === null) v = [makePubEntry()];
    if (decisionBearing.has(k) && k !== "publications") assertReachable(at, k, v);
    if (k === "publications" && Array.isArray(v)) {
      for (const e of v) {
        for (const pk of PUB_ENTRY_READS) if (pk in e) assertReachable("publications[]", pk, e[pk]);
      }
    }
    rec[k] = v;
  }
  return rec;
}

function chromiumLine(t, payload) {
  const d = new Date(t);
  const p2 = (n) => String(n).padStart(2, "0");
  const stamp = `${p2(d.getMonth() + 1)}${p2(d.getDate())}/${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, "0")}000`;
  // The PINNED emit form: ONE pre-serialized string.
  return `[4242:4242:${stamp}:INFO:CONSOLE(1)] "[gate-trace] ${JSON.stringify(payload)}", source: app://bundle/assets/index-abc.js (1)`;
}

function writeTrace(name, records) {
  writeAtomic(path.join(outdir, name), [...records].sort((a, b) => a.t - b.t).map((r) => chromiumLine(r.t, r)).join("\n") + "\n");
}

/** The wall-clock landmarks of a dump, computed with the reducer's own maths. */
function landmarks(dump) {
  const rows = seriesByRole(dump, "subject", 0);
  const changes = ssrcChanges(rows);
  const flow = subjectFlowWindows(rows, 500);
  const leak = pinLeakWindow(flow, changes, null);
  if (!leak.window) throw new Error(`the ${dump.label} dump has no post-fiducial flow window; the fixtures cannot be placed`);
  return { fiducial: changes[0].t, from: leak.window.from, to: leak.window.to };
}

// --------------------------------------------------------------------------
// 🔴 THE REACHABILITY CONTROLS. The registry has to REJECT the two values that
// made wave 0b's C6 and C4 controls vacuous, or it proves nothing.
// --------------------------------------------------------------------------
process.stdout.write("=== reachable-VALUE controls (the vacuous-fixture defect) ===\n");
expectThrow(
  "X4 the C6/C4 fixtures' old `subjectSidInPublications: true` at localSenderCreated is REFUSED as unreachable",
  () => makeRec("localSenderCreated", 1, { subjectSidInPublications: true }),
  "NOT REACHABLE",
);
expectThrow(
  "X4b `subjectSidInPublications: false` at localTrackPublished.entry is REFUSED (addTrackPublication precedes the emit)",
  () => makeRec("localTrackPublished.entry", 1, { subjectSidInPublications: false }),
  "NOT REACHABLE",
);
expectThrow(
  "X4c an invented publications[] op is REFUSED",
  () => makePubEntry({ op: "definitely-not-an-op" }),
  "NOT REACHABLE",
);
expectThrow(
  "X4d a key no emitter emits is still REFUSED (the wave-0 name defect)",
  () => makeRec("localSenderCreated", 1, { subjectSidPresent: false }),
  "NO EMITTER EMITS",
);
check(
  "X4e the same fixtures built from REACHABLE values are accepted (the registry is not simply refusing everything)",
  (() => {
    try {
      makeRec("localSenderCreated", 1, { subjectSidInPublications: false, subjectSidAssigned: true });
      makeRec("localTrackPublished.entry", 1, { subjectSidInPublications: true });
      makePubEntry({ op: "repause", upstreamPaused: true, upstream: "live" });
      return true;
    } catch (e) {
      return `threw: ${e.message}`;
    }
  })() === true,
  "a reachable fixture was refused, so every green above is vacuous",
);

process.stdout.write("=== trace fixtures (generated from the EXTRACTED key sets and REACHABLE values) ===\n");

/** row -> { positive, negated } fixture files. Consumed by selftest.sh. */
const rowMatrix = {};
let generated = 0;

try {
  // The teardown records of ONE real leave, and of the rejoin's own leading
  // teardown. Generations follow the MEASURED bump order in `state.tsx`:
  // entry (pre-bump), `#connectGen++`, preclear (post-bump), and
  // `#connectAttempt`'s own `++this.#connectGen` — so with the leak at
  // connectGen 4 the user's leave sits at 1/2 and the rejoin's teardown at 2/3.
  const userLeave = (fid, at = 3000) => [
    makeRec("disconnect.entry", fid - at, { via: "user", connectGen: 1, connectGenPhase: "pre-bump" }),
    makeRec("disconnect.preclear", fid - at + 10, { via: "user", connectGen: 2, connectGenPhase: "post-bump" }),
  ];
  const connectLeading = (fid) => [
    makeRec("disconnect.entry", fid - 500, { via: "connect-leading", connectGen: 2, connectGenPhase: "pre-bump" }),
    makeRec("disconnect.preclear", fid - 490, { via: "connect-leading", connectGen: 3, connectGenPhase: "post-bump" }),
  ];

  for (const [scenario, tag] of [["plaintext", ""], ["bytesonly", ".bytesonly"], ["plaintextcall1", ".call1"], ["lingering", ".lingering"]]) {
    const L = landmarks(results[scenario]);

    // C0 — the republish window: an ASSIGNED (stale) sid that the map no
    // longer holds, with the map still holding another publication.
    const c0 = () => [
      ...userLeave(L.fiducial),
      ...connectLeading(L.fiducial),
      makeRec("connect.add", L.fiducial - 300),
      makeRec("resumeGate", L.fiducial),
      makeRec("localSenderCreated", L.from - 20, {
        publicationCount: 1,
        publicationKeys: ["TR_camera"],
        publications: [makePubEntry({ name: "camera/TR_camera", source: "camera", trackSid: "TR_camera" })],
      }),
      makeRec("localTrackPublished.entry", L.to + 200),
    ];
    writeTrace(`trace-c0${tag}.log`, c0());
    generated += 1;

    // C1 — the in-place arm, EMPTY set, and only `connect-leading` teardowns
    // (B6): they fire on every rejoin press and are not a leave.
    writeTrace(`trace-c1${tag}.log`, [
      ...connectLeading(L.fiducial),
      makeRec("rejoinFresh", L.fiducial - 400, { phase: "enter", seq: 7 }),
      makeRec("rejoinFresh", L.fiducial - 380, { phase: "afterDrop", seq: 7 }),
      makeRec("dropModeToNegotiating", L.fiducial - 360),
      makeRec("resumeGate", L.fiducial),
      makeRec("localSenderCreated", L.from - 20, { ...EMPTY_GATE }),
      makeRec("localTrackPublished.entry", L.to + 200, { ...EMPTY_GATE }),
    ]);
    generated += 1;
  }

  const L = landmarks(results.plaintext);
  const base = () => [...userLeave(L.fiducial), ...connectLeading(L.fiducial), makeRec("resumeGate", L.fiducial)];

  rowMatrix.C0 = { positive: "trace-c0.log", negated: "trace-c0-negated.log" };

  // 🔴 C0's DISCRIMINATOR NEGATED: the same run with the sid NOT YET ASSIGNED
  // (a first publish). `subjectSidInPublications` is then `null`, and the old
  // reading — "subjectSidPresent === false" — fired here just as hard as on
  // the republish, which is what made C6 and C4 unreachable.
  writeTrace("trace-c0-negated.log", [
    ...base(),
    makeRec("localSenderCreated", L.from - 20, { ...SENDER_NO_SID }),
    makeRec("localTrackPublished.entry", L.to + 200),
  ]);
  generated += 1;

  // C0's weaker class: an assigned (stale) sid over an EMPTY map.
  writeTrace("trace-c0-emptymap.log", [
    ...base(),
    makeRec("localSenderCreated", L.from - 20),
    makeRec("localTrackPublished.entry", L.to + 200),
  ]);
  generated += 1;

  // 🔴 B3's control: ONE stale, guard-DISCARDED drop from a previous call,
  // 5 s before the leak, with a different sweeper generation. The row must
  // stay C0.
  writeTrace("trace-c0-staledrop.log", [
    ...base(),
    makeRec("localSenderCreated", L.from - 20, {
      publicationCount: 1,
      publicationKeys: ["TR_camera"],
      publications: [makePubEntry({ name: "camera/TR_camera", source: "camera", trackSid: "TR_camera" })],
    }),
    makeRec("localTrackPublished.entry", L.to + 200),
    makeRec("sweeper.dropped", L.from - 5000, { stillCurrent: false, sweeperGen: 3 }),
  ]);
  generated += 1;

  // C3 — a drop that LANDED, in the leak's own window, same generation.
  writeTrace("trace-c3.log", [
    ...base(),
    makeRec("localSenderCreated", L.from - 20),
    makeRec("sweeper.dropped", L.from - 10, { stillCurrent: true, sweeperGen: 4 }),
    makeRec("localTrackPublished.entry", L.to + 200),
  ]);
  generated += 1;
  rowMatrix.C3 = { positive: "trace-c3.log", negated: "trace-c0-staledrop.log" };

  // C6 — the publication PRESENT at the mute with livekit's pause flag
  // stale-true over a live sender. The sender seam is the FIRST-PUBLISH shape,
  // so C0's absent half is not established and this row is reachable at all.
  const c6Census = (paused) => [
    ...base(),
    makeRec("localSenderCreated", L.from - 20, { ...SENDER_NO_SID, upstreamPaused: paused, senderHasTrack: true }),
    makeRec("localTrackPublished.entry", L.to + 200, {
      publications: [makePubEntry({ upstreamPaused: paused, upstream: "live", op: paused ? "repause" : "pause" })],
    }),
  ];
  writeTrace("trace-c6.log", c6Census(true));
  generated += 1;
  // C6's discriminator negated: the same run with the flag FALSE and no
  // resume — it must select no row, not C6 and not C4.
  writeTrace("trace-c6-negated.log", c6Census(false));
  generated += 1;
  rowMatrix.C6 = { positive: "trace-c6.log", negated: "trace-c6-negated.log" };

  // C4 — flag false, UpstreamResumed inside the bounded window AND NAMING the
  // publication under test.
  const c4Base = c6Census(false);
  writeTrace("trace-c4.log", [...c4Base, makeRec("track.upstreamResumed", L.to - 200)]);
  generated += 1;
  // 🔴 C4's discriminator negated, TWO ways.
  // (i) the resume names ANOTHER track. Measured on wave 0b's reducer:
  //     retargeting it to screen_share/TR_TOTALLY_OTHER still read C4,
  //     because the row tested `m3.upstreamResumed.length > 0` for any track.
  writeTrace("trace-c4-negated.log", [
    ...c4Base,
    makeRec("track.upstreamResumed", L.to - 200, {
      subject: "screen_share/TR_totally_other",
      subjectSource: "screen_share",
      subjectSid: "TR_totally_other",
    }),
  ]);
  generated += 1;
  // (ii) the same run with the resume 30 s earlier: "immediately before the
  //      mute" is a BOUNDED window.
  writeTrace("trace-c4-farresumed.log", [...c4Base, makeRec("track.upstreamResumed", L.to - 30000)]);
  generated += 1;
  rowMatrix.C4 = { positive: "trace-c4.log", negated: "trace-c4-negated.log" };

  // 🔴 A DEGRADED capture (not an unreachable value): the resume record has
  // lost its `currentRoom` while its siblings keep theirs — a mixed-version or
  // truncated log. It may be kept and counted, but it may not SELECT a row.
  {
    const recs = [...c4Base, makeRec("track.upstreamResumed", L.to - 200)];
    const lines = [...recs]
      .sort((a, b) => a.t - b.t)
      .map((r) => {
        if (r.at !== "track.upstreamResumed") return chromiumLine(r.t, r);
        const { currentRoom, ...withoutRoom } = r;
        void currentRoom;
        return chromiumLine(r.t, withoutRoom);
      });
    // A second resume record that DOES carry currentRoom, so the seam
    // demonstrably carries the key in this capture.
    lines.push(chromiumLine(L.to - 900, makeRec("track.upstreamResumed", L.to - 900, { subject: "camera/TR_camera", subjectSource: "camera", subjectSid: "TR_camera" })));
    writeAtomic(path.join(outdir, "trace-c4-noroom.log"), lines.join("\n") + "\n");
    generated += 1;
  }

  // C1's discriminator negated: the SAME in-place run plus a real `via:"user"`
  // teardown INSIDE this leg's transition. M2 then witnesses both arms and the
  // row is not C1.
  const c1Records = [
    ...connectLeading(L.fiducial),
    makeRec("rejoinFresh", L.fiducial - 400, { phase: "enter", seq: 7 }),
    makeRec("rejoinFresh", L.fiducial - 380, { phase: "afterDrop", seq: 7 }),
    makeRec("dropModeToNegotiating", L.fiducial - 360),
    makeRec("resumeGate", L.fiducial),
    makeRec("localSenderCreated", L.from - 20, { ...EMPTY_GATE }),
    makeRec("localTrackPublished.entry", L.to + 200, { ...EMPTY_GATE }),
  ];
  writeTrace("trace-c1-negated.log", [...c1Records, ...userLeave(L.fiducial, 3000)]);
  generated += 1;
  rowMatrix.C1 = { positive: "trace-c1.log", negated: "trace-c1-negated.log" };

  // 🔴 B5's control: the SAME in-place run with a `via:"user"` teardown SIXTY
  // SECONDS before the fiducial — a hang-up, a failed-join teardown, an
  // autoLeave or a sign-out from an earlier call. Measured on wave 0b's
  // reducer, which filtered `disconnect.preclear` over the WHOLE capture:
  // exactly this flipped `M2: no-disconnect / C1` to `M2: both / no row`.
  writeTrace("trace-c1-staleleave.log", [
    ...c1Records,
    makeRec("disconnect.entry", L.fiducial - 60000, { via: "user", connectGen: 0, connectGenPhase: "pre-bump" }),
    makeRec("disconnect.preclear", L.fiducial - 59990, { via: "user", connectGen: 1, connectGenPhase: "post-bump" }),
  ]);
  generated += 1;

  // 🔴 H1's control: a resumeGate at exactly the fiducial that does NOT
  // qualify (the stale-room drop), plus the real edge 900 ms off.
  writeTrace("trace-h1-stale-resume.log", [
    ...userLeave(L.fiducial),
    makeRec("resumeGate", L.fiducial, { staleRoom: true, emptied: false, reason: "mixed" }),
    makeRec("resumeGate", L.fiducial + 900),
    makeRec("localSenderCreated", L.from - 20),
    makeRec("localTrackPublished.entry", L.to + 200),
  ]);
  generated += 1;

  // 🔴 H2's control: the C0 shape, but every record belongs to an ABANDONED
  // Room. None of it may reach a verdict.
  writeTrace("trace-h2-abandoned.log", [
    ...userLeave(L.fiducial),
    makeRec("resumeGate", L.fiducial, { currentRoom: false }),
    makeRec("localSenderCreated", L.from - 20, { currentRoom: false }),
    makeRec("localTrackPublished.entry", L.to + 200, { currentRoom: false }),
  ]);
  generated += 1;

  // M4's control: TWO re-establishes with DIFFERENT seq must count as two.
  writeTrace("trace-m4-twoseq.log", [
    makeRec("rejoinFresh", L.fiducial - 400, { phase: "enter", seq: 7 }),
    makeRec("rejoinFresh", L.fiducial - 380, { phase: "enter", seq: 8 }),
    makeRec("resumeGate", L.fiducial),
    makeRec("localSenderCreated", L.from - 20, { ...EMPTY_GATE }),
  ]);
  generated += 1;

  // The fiducial moved off the ssrc change: the run must be UNALIGNED.
  writeTrace("trace-unaligned.log", [
    ...userLeave(L.fiducial),
    makeRec("resumeGate", L.fiducial + 900),
    makeRec("localSenderCreated", L.from - 20),
    makeRec("localTrackPublished.entry", L.to + 200),
  ]);
  generated += 1;

  // 🔴 The DEGRADED control: an object ARGUMENT reached Chromium's serializer.
  // The lines ARE there; the fields are not.
  {
    const recs = [...userLeave(L.fiducial), makeRec("localSenderCreated", L.from - 20)];
    writeAtomic(path.join(outdir, "trace-objectobject.log"), recs.map((r) => chromiumLine(r.t, r).replace(/\{.*\}/, "[object Object]")).join("\n") + "\n");
    generated += 1;
  }

  // A TRUNCATED capture: the last record's payload is cut mid-object.
  {
    const full = [...userLeave(L.fiducial), makeRec("localSenderCreated", L.from - 20)].map((r) => chromiumLine(r.t, r)).join("\n");
    writeAtomic(path.join(outdir, "trace-truncated.log"), full.slice(0, full.length - 120) + "\n");
    generated += 1;
  }

  // A log with no [gate-trace] lines at all.
  writeAtomic(path.join(outdir, "trace-empty-of-records.log"), '[4242:4242:0910/120000.000000:INFO:CONSOLE(1)] "hello"\n');
  generated += 1;

  // A CDP capture whose object argument came back as a LOSSY 5-property
  // PREVIEW (L1).
  {
    const rec = makeRec("localSenderCreated", L.from - 20);
    const props = Object.entries(rec).slice(0, 5).map(([name, value]) => ({ name, type: typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : "string", value: String(value) }));
    const ev = { method: "Runtime.consoleAPICalled", params: { type: "error", args: [{ type: "string", value: "[gate-trace]" }, { type: "object", preview: { properties: props } }] } };
    writeAtomic(path.join(outdir, "trace-cdp-lossy.jsonl"), JSON.stringify(ev) + "\n");
    generated += 1;
  }

  // Pre-flight fixtures for launch-seats.sh's serialization check.
  writeAtomic(path.join(outdir, "preflight-good.log"), chromiumLine(L.fiducial, makeRec("connect.add", L.fiducial)) + "\n");
  writeAtomic(path.join(outdir, "preflight-objectobject.log"), chromiumLine(L.fiducial, makeRec("connect.add", L.fiducial)).replace(/\{.*\}/, "[object Object]") + "\n");
  generated += 2;

  // 🔴 MIXED stays reachable. Once a row must be about the LEAKING publication
  // (item 10), a census entry for another track is skipped rather than allowed
  // to select a row about the leak — so two rows can only "genuinely both
  // hold" when the sampler could NOT correlate a trackSid at all. That is a
  // real capture shape (a stream id the observer could not parse into
  // `${participantSid}|${trackSid}`), so it is produced and tested rather than
  // left as an untested branch.
  {
    const d = JSON.parse(JSON.stringify(results.plaintext));
    for (const tk of d.ticks) for (const s of tk.samples) if (s.role === "subject") s.trackSid = null;
    writeAtomic(path.join(outdir, "sampler-uncorrelated.json"), JSON.stringify(d));
    writeTrace("trace-mixed.log", [
      ...base(),
      makeRec("localSenderCreated", L.from - 20, { ...SENDER_NO_SID }),
      makeRec("localTrackPublished.entry", L.to + 200, {
        publicationCount: 2,
        publicationKeys: ["TR_subject_post", "TR_camera"],
        publications: [
          makePubEntry({ upstreamPaused: true, upstream: "live", op: "repause" }),
          makePubEntry({ name: "camera/TR_camera", source: "camera", trackSid: "TR_camera", upstreamPaused: false }),
        ],
      }),
      makeRec("track.upstreamResumed", L.to - 200, { subject: "camera/TR_camera", subjectSource: "camera", subjectSid: "TR_camera" }),
    ]);
    generated += 1;
  }

  writeAtomic(path.join(outdir, "row-matrix.json"), JSON.stringify(rowMatrix, null, 2) + "\n");
} catch (e) {
  check("F0 every trace fixture was generated from the extracted key sets and reachable values", false, e.message);
}
if (generated) process.stdout.write(`  generated ${generated} trace fixture(s)\n`);

// 🔴 EVERY §2.5 ROW MUST BE REACHABLE FROM A FIXTURE WHOSE FIELDS ARE ALL
// REACHABLE — and each row must have a fixture with its discriminator NEGATED.
// (That the fixtures SELECT those rows is asserted by selftest.sh, which runs
// the reducer; this half asserts the matrix is COMPLETE, so a row cannot go
// untested by simply not being listed.)
{
  const wanted = ["C0", "C1", "C3", "C4", "C6"];
  const missing = wanted.filter((r) => !rowMatrix[r]);
  check(
    "F1 every §2.5 row has a positive AND a negated fixture, all built from reachable values",
    missing.length === 0,
    `no fixture pair for: ${missing.join(", ")}`,
  );
  for (const r of wanted) {
    if (!rowMatrix[r]) continue;
    for (const half of ["positive", "negated"]) {
      const f = path.join(outdir, rowMatrix[r][half]);
      if (!fs.existsSync(f)) check(`F1-${r}-${half} the ${half} fixture exists`, false, `${f} was not written`);
    }
  }
  const same = wanted.filter((r) => rowMatrix[r] && fs.existsSync(path.join(outdir, rowMatrix[r].positive)) && fs.existsSync(path.join(outdir, rowMatrix[r].negated)) && fs.readFileSync(path.join(outdir, rowMatrix[r].positive), "utf8") === fs.readFileSync(path.join(outdir, rowMatrix[r].negated), "utf8"));
  check("F2 no row's negated fixture is byte-identical to its positive one", same.length === 0, `identical pairs: ${same.join(", ")}`);
}

// Corrupted sampler inputs.
const good = fs.readFileSync(path.join(outdir, "sampler-plaintext.json"), "utf8");
writeAtomic(path.join(outdir, "sampler-truncated.json"), good.slice(0, Math.floor(good.length * 0.6)));
writeAtomic(path.join(outdir, "sampler-empty.json"), "");
writeAtomic(path.join(outdir, "sampler-wrongschema.json"), JSON.stringify({ ...JSON.parse(good), schema: "something-else/9" }));
writeAtomic(path.join(outdir, "sampler-zeroticks.json"), JSON.stringify({ ...JSON.parse(good), ticks: [] }));
writeAtomic(path.join(outdir, "sampler-shapea.json"), JSON.stringify({ ...JSON.parse(good), shape: "a", e2eeManagerPresent: true }));

process.stdout.write(`=== sampler self-test: ${failures} failing control(s) ===\n`);
process.exit(failures === 0 ? 0 : 1);
