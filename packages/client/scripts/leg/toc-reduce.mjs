#!/usr/bin/env node
/*
 * toc-reduce.mjs — the frame-tap × [gate-trace] reducer for the "never publish
 * unpaused" fix (rejoin-leak-HANDOFF.md §7.8 / §7.9, wave 3, lane L11).
 *
 *   node packages/client/scripts/leg/toc-reduce.mjs \
 *     --trace subject.gate-trace.jsonl \
 *     --tap toc-tap.json | --tap-log toc-tap-run3.json \
 *     --carrier <ssrc> [--skew-ms <n>] [--end-margin-ms <n>] \
 *     [--require-processor-after-empty] [--json]
 *
 *   node .../toc-reduce.mjs --selftest
 *
 * It reads the OBSERVER's per-frame tap dump (toc-tap.js, or the run-3 ad-hoc
 * `window.__tocLog` shape) and the SUBJECT seat's `[gate-trace]` JSONL, joins
 * them on WALL CLOCK, and answers, per PUBLISH EPISODE: "how many
 * subject-originated frames reached the wire before the gate first emptied?"
 * PASS iff that is zero everywhere and every episode landed paused (`op:
 * "none"`), closed, held its gate, and was actually tapped. Run 3 (§7.9) is
 * the pre-fix control: it reads FAIL.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE REFUSES TO DO. Each is a way a bytes-only observer has
 * already produced a confident wrong answer in this slice.
 *
 *  - It NEVER classifies a frame as an SFU blank BY LENGTH. The blank is 81 B
 *    on a RED publication and 80 B after the E2EE flip (no RED byte), and a
 *    length rule proves nothing about content. A blank is a SIGNATURE
 *    (`f8 ff fe` at head offset 0, or at offset 1 after the RED byte) AND an
 *    all-zero tail AND membership in a run of >= BLANK_MIN_RUN CONSECUTIVE
 *    frames with an identical hash, consecutive in that ssrc's own frame order
 *    across the WHOLE dump. A lone signature-bearing frame COUNTS as subject.
 *  - It NEVER starts the window at `localTrackPublished.entry`. The frames the
 *    fix closes PRECEDE that record (F18): the window opens at the microphone
 *    `localSenderCreated`, or earlier still if the first frame of a new ssrc
 *    lands before it (observer clock ahead of the subject's).
 *  - It NEVER ends the count silently at the gate-empty wall time (F1).
 *    Subject -> SFU -> observer transit plus residual skew can push a leaked
 *    frame of a ~250 ms episode PAST the gate-empty `t`. Non-blank frames in
 *    `[end, end + --end-margin-ms)` are the GREY ZONE: they never make a
 *    PASS, they turn a would-be PASS into `PASS-WITH-GREY` (exit 1), and the
 *    reader decides with the frames in front of them.
 *  - It NEVER assumes the skew (F2). A `--tap` dump carries `clockProbes`
 *    measured against the server at arm and at save; without `--skew-ms` the
 *    LAST valid probe is the skew, both probes and their drift are printed,
 *    and a dump with NO valid probe is exit 3. `--tap-log` (run 3) has no
 *    probes: `--skew-ms` or a printed WARNING `skew unmeasured` at 0.
 *  - It NEVER trusts a tap that reports its own failure (F3). `--tap` with
 *    `stats.errors` non-empty or `stats.dropped > 0` is exit 3. And a PASS
 *    needs a POSITIVE CONTROL per episode: EITHER at least one frame on a
 *    never-before-seen non-carrier ssrc at or after S.t (before the next
 *    episode's S.t), OR (R1) receiver-level evidence — a `stats.trackEvents`
 *    entry whose trackSid is the episode's landed sid AND some frame in the
 *    dump carrying `rx` equal to that receiverIndex. The second arm exists
 *    because a CORRECT fix produces a publish with NOTHING to tap: a
 *    born-paused sender sends zero packets for the whole hold and the SFU
 *    injects no blanks for a downtrack that never bound (live pass A: 0
 *    frames on any new ssrc for episodes 1 and 3, `packetsSent` 0). What
 *    remains provable is that the receiver for that sid was attached and
 *    that the transform on that receiver demonstrably delivers — so the arm
 *    is named `transformDelivers`, and the trackEvent must sit (on the
 *    subject clock) BEFORE the episode's temporal bound: `end` for a
 *    gate-empty / disconnect close, the next S.t otherwise (F3). An episode
 *    with neither is `untapped`, not clean.
 *  - It NEVER claims the tap COVERED the D0 window (F1). On this SFU the
 *    downtrack forwards only after the observer's answer binds, which is
 *    after `localTrackPublished.entry` — so the tap cannot cover S..P+~80 ms
 *    at all. `windowCoverage` says so per episode (`none` / `marginal` /
 *    `partial` / `late`, from the receiver-attach time vs publishedAt). D0
 *    itself is proven by the SUBJECT-side counters (packetsSent 0 through the
 *    hold); the tap proves that no leak PERSISTED past coverage and supplies
 *    the post-resume positive control. Informational, no verdict change.
 *  - It NEVER reads the legitimate resume as a grey frame when the trace
 *    says otherwise (R2). The gate's resume follows the gate-empty by
 *    microseconds BY DESIGN, so a plain "150 ms after end" always catches
 *    the resumed audio. The first `track.upstreamResumed` for the landed sid
 *    at or after `end` is the fiducial — but ONLY when the episode closed by
 *    a gate-empty AND that record carries `gateHeld === false` (F2): under a
 *    held gate a "resume" is the repause's resume-then-pause beat, not the
 *    resume (pass A ep1 picked exactly that record, on the stale sid). A
 *    grey-zone frame at or after resume.t + U is `postResume` (informational,
 *    never a reason), where U is the clock uncertainty — `clockDriftMs` with
 *    >= 2 valid probes, else rttMs/2 of the probe used, else 0 with a
 *    WARNING. Frames before resume.t + U stay grey; with no valid fiducial
 *    nothing is reclassified.
 *  - It NEVER reads an empty gate as a clean publish (F5). An episode whose
 *    `localSenderCreated` carries `gateHeld !== true` proves nothing about
 *    D0 and FAILS `gateNotHeld`.
 *  - It NEVER runs without a pinned carrier. Without one, nothing separates
 *    the subject's ssrc from the other seat's, and it REFUSES a carrier that
 *    has ZERO frames in the dump: a tap that never saw the positive control
 *    cannot be trusted to have seen the subject, and a PASS on it is vacuous.
 *  - It NEVER interprets a partial input. A trace line that is not JSON, a
 *    frame missing a pinned key, a dump without its top-level key, a `--tap`
 *    whose `schema` is not `sloga-leg-toc/1`: exit 3, no report.
 *  - It NEVER GUESSES A PAYLOAD KEY NAME. See "PINNED KEYS" below.
 *
 * Exit status:
 *   0  PASS — every episode closed, zero subject frames, zero grey-zone
 *      frames, landed with `op: "none"`, gate held at S, tapped
 *      (or: --selftest, every control behaved)
 *   1  FAIL or PASS-WITH-GREY — `reasons[]` names each failing condition
 *      (or: --selftest, at least one control misbehaved)
 *   3  input error — missing / unreadable / wrong-schema input, no carrier,
 *      carrier with no frames, tap self-reported errors or drops, no usable
 *      skew, or no microphone episode at all. NO verdict.
 *   Nothing else.
 *
 * ---------------------------------------------------------------------------
 * 🔴 PINNED KEYS — the cross-lane contract. Verified against the real run-3
 * captures (`gate-trace-b-consent-run3.jsonl`, `toc-tap-run3-1789403829.json`)
 * and the L10 `toc-tap.js` dump schema. There are NO ALIASES.
 *
 * Trace record (JSONL, one per line, emission order):
 *   { t: <wall ms, Date.now on the subject>, p: <performance.now>, at, ... }
 *   "localSenderCreated"        subject, subjectSource, subjectSid (null on a
 *                               first publish; the STALE previous sid on a
 *                               republish), gate, gateHeld, connectGen
 *   "localTrackPublished.entry" subjectSid (the NEW sid), publications: [{
 *                               name, source, trackSid, upstreamPaused,
 *                               hasSender, senderHasTrack, transportState,
 *                               upstream, op }], op in pause|repause|resume|none
 *   "resumeGate"                reason, emptied: boolean
 *   "disconnect.entry"          (t only)
 *   "connect.add"               (t only; a window-start lower bound)
 *   "track.processorUpdate"     subjectSource, subjectSid (F5)
 *   "track.upstreamResumed"     subjectSid, gateHeld (R2/F2: the resume fiducial)
 *
 * Tap dump:
 *   --tap      { schema: "sloga-leg-toc/1", label, armedAtWall, savedAtWall,
 *                userAgent, stats, clockProbes, frames: [F...] }
 *              stats: { errors: [...], dropped, receiversTapped,
 *                       trackEvents: [{ t, trackSid, participantSid,
 *                                       receiverIndex }] ... }
 *              clockProbes: [ { t0, t1, serverMs, skewMs, rttMs } | { error } ]
 *              skewMs = subject clock − observer clock: the value ADDED.
 *   --tap-log  { stats, log: [F...] }             (run-3 ad-hoc shape)
 *   F = { t: <wall ms on the OBSERVER>, ssrc, len, head: [<=6 ints],
 *         tail: [<=4 ints], h: "<fnv1a32, UNPADDED lowercase hex>"
 *         [, rx: <receiverIndex>] }
 *
 * Clock: observer `t` + skew = subject `t`. Every comparison below is on the
 * SKEWED tap time.
 *
 * ---------------------------------------------------------------------------
 * EPISODES (the derivation, pinned by the wave-3 contract)
 *
 *  open   each microphone `localSenderCreated` record S
 *  close  the FIRST later record that is (a) `resumeGate` with emptied ===
 *         true, (b) `disconnect.entry`, or (c) another microphone
 *         `localSenderCreated` (the sender is being replaced), in file order;
 *         closedBy: "gateEmpty" | "disconnect" | "senderCreated". None: the
 *         episode is `open` (closedBy null, end null) and FAILS.
 *  start  min(S.t, firstNewSsrcFrame.t + skew), where firstNewSsrcFrame is the
 *         first non-carrier frame on an ssrc NOT seen in any earlier episode's
 *         window whose skewed t is < this episode's end and >= the LOWER
 *         BOUND: the t of the most recent `connect.add` or `disconnect.entry`
 *         that precedes S in file order (whichever is later); when neither
 *         exists before S, the previous episode's S.t; first episode with
 *         neither: no lower bound. Rationale: a fresh connection cannot carry
 *         a frame from before it. Without the bound, the run-3 shape (consent
 *         -> leave -> rejoin) lands the post-consent ssrc — which first flows
 *         AFTER the consent episode's gate-empty, so no earlier window holds
 *         it — in the REJOIN episode, 42 s before its own localSenderCreated,
 *         and reports 144 legitimately-flowing DTX frames as a leak.
 *         windowStartedBy: "senderCreated" | "firstFrame".
 *  end    the closing record's t (open: +Infinity).
 *  grey   non-blank non-carrier frames in [end, end + endMarginMs) (F1).
 *  landed the first microphone `localTrackPublished.entry` between S and the
 *         close; `op` is the `op` of the publication whose trackSid === that
 *         record's subjectSid, else null. When the close is a gate-empty and
 *         the first later microphone publish record arrives within 2000 ms,
 *         `landedAfterClose: { t, op }` is reported and the reason is
 *         `landedAfterClose` rather than `landed` (F7) — still a FAIL, but
 *         distinguishable from a publish that never landed at all.
 *  tapped a positive control (F3 + R1): `positiveControl: { kind: "frames",
 *         ssrc, t }` when some non-carrier ssrc's FIRST frame lies in
 *         [S.t, nextS.t); else `{ kind: "transformDelivers", receiverIndex,
 *         t }` when a trackEvent for the landed sid exists with skewed t
 *         before the episode's bound and some frame carries that `rx`; else
 *         null → `untapped`. Every trackEvent time is emitted on the SUBJECT
 *         clock (t + skew), like every other number here (F4).
 *  cover  `windowCoverage: { receiverAt, publishedAt, offsetFromPublishMs,
 *         covered }` and `rxFramesInWindow` (frames on that receiver inside
 *         [start, end)). covered: "none" (no trackEvent before the bound),
 *         "partial" (receiverAt < publishedAt − 100), "marginal" (within
 *         100 ms either side), "late" (> 100 ms after publishedAt).
 *  resume the first `track.upstreamResumed` whose subjectSid === newSid and
 *         t >= end, valid only with closedBy gateEmpty and gateHeld === false
 *         (R2/F2). `postResume: { n, list(cap 5), resumeAt, uncertaintyMs }`
 *         — grey-zone frames at or after resumeAt + U.
 *  F5     gateHeldAtS (S.gateHeld), processorUpdateAt (first microphone
 *         `track.processorUpdate` after S and before the next S),
 *         processorAfterGateEmpty (that t > the first gate-empty after S;
 *         false when no gate-empty ever follows; null when no processor).
 *
 * Verdict per episode — ALL of: closed, subjectFrames.n === 0, landed,
 * op === "none", gateHeldAtS === true, tapped, and (with
 * --require-processor-after-empty) not processorInsideHold. `reasons[]` names
 * each failing condition by its key (`open`, `subjectFrames`, `landed`,
 * `landedAfterClose`, `op`, `gateNotHeld`, `untapped`, `processorInsideHold`,
 * `greyZone`). Verdict: any non-grey reason → FAIL; only `greyZone` →
 * PASS-WITH-GREY; none → PASS.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TAP_SCHEMA = "sloga-leg-toc/1";
export const REPORT_SCHEMA = "sloga-leg-toc-reduce/1";

/** Every key a tap frame MUST carry. A frame missing one is exit 3. */
export const FRAME_KEYS = ["t", "ssrc", "len", "head", "tail", "h"];

/** The trace points this file reads, by their exact `at` literal. */
export const POINTS = {
  senderCreated: "localSenderCreated",
  published: "localTrackPublished.entry",
  resumeGate: "resumeGate",
  disconnect: "disconnect.entry",
  connectAdd: "connect.add",
  processorUpdate: "track.processorUpdate",
  upstreamResumed: "track.upstreamResumed",
};

/** The blank signature: LiveKit-server's OpusSilenceFrame head. */
export const BLANK_SIGNATURE = [0xf8, 0xff, 0xfe];
/** A blank must sit in a run of at least this many identical-hash frames. */
export const BLANK_MIN_RUN = 3;
/** subjectFrames.list / greyZone.list are capped here; the rest is a count. */
export const LIST_CAP = 20;
/** R2: postResume.list is capped here. */
export const POST_RESUME_LIST_CAP = 5;
/** F1: |receiverAt − publishedAt| within this is "marginal" coverage. */
export const COVERAGE_MARGIN_MS = 100;
/** F1: default grey-zone width after the closing record. */
export const DEFAULT_END_MARGIN_MS = 150;
/** F2: probe-to-probe skew drift above this prints a WARNING. */
export const DRIFT_WARN_MS = 10;
/** F7: a publish landing this soon after a gate-empty close is reported as landedAfterClose. */
export const LANDED_AFTER_CLOSE_MS = 2000;

class InputError extends Error {}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

function die(code, msg) {
  process.stderr.write(`toc-reduce: ${msg}\n`);
  process.exit(code);
}

const HELP = `toc-reduce.mjs — join the observer frame tap with the subject [gate-trace]
and count subject-originated frames on the wire before the gate first emptied.

  --trace <file>      REQUIRED. Subject [gate-trace] JSONL.
  --tap <file>        toc-tap.js dump (schema ${TAP_SCHEMA}, frames under \`frames\`).
  --tap-log <file>    run-3 ad-hoc dump (frames under \`log\`).
                      Exactly one of --tap / --tap-log.
  --carrier <ssrc>    REQUIRED. The carrier seat's ssrc; every frame on it is
                      excluded, every other ssrc is subject material.
  --skew-ms <n>       Added to every tap t before comparing. Optional for --tap
                      (the last valid clockProbes entry is used); for --tap-log
                      it defaults to 0 with a WARNING.
  --end-margin-ms <n> Grey-zone width after the closing record (default ${DEFAULT_END_MARGIN_MS}).
  --require-processor-after-empty
                      FAIL an episode whose track.processorUpdate ran inside the hold.
  --json              Print the report as JSON only (warnings go to stderr).
  --selftest          Run the built-in fixture controls; exit 0 iff all behave.

Exit: 0 PASS, 1 FAIL / PASS-WITH-GREY, 3 input error. Nothing else.
`;

function parseArgs(argv) {
  const out = {
    trace: null,
    tap: null,
    tapLog: null,
    carrier: null,
    skewMs: null,
    endMarginMs: DEFAULT_END_MARGIN_MS,
    requireProcessorAfterEmpty: false,
    json: false,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) die(3, `${a} needs a value`);
      return v;
    };
    const num = () => {
      const v = Number(next());
      if (!Number.isFinite(v)) die(3, `${a} must be a number`);
      return v;
    };
    switch (a) {
      case "--trace": out.trace = next(); break;
      case "--tap": out.tap = next(); break;
      case "--tap-log": out.tapLog = next(); break;
      case "--carrier": {
        const raw = next();
        const v = Number(raw);
        if (!/^\d+$/.test(raw) || !Number.isSafeInteger(v)) {
          die(3, `--carrier must be a non-negative integer ssrc, got ${JSON.stringify(raw)}`);
        }
        out.carrier = v;
        break;
      }
      case "--skew-ms": out.skewMs = num(); break;
      case "--end-margin-ms": {
        out.endMarginMs = num();
        if (out.endMarginMs < 0) die(3, "--end-margin-ms must be >= 0");
        break;
      }
      case "--require-processor-after-empty": out.requireProcessorAfterEmpty = true; break;
      case "--json": out.json = true; break;
      case "--selftest": out.selftest = true; break;
      case "-h":
      case "--help":
        process.stdout.write(HELP);
        process.exit(0);
        break;
      default:
        die(3, `unknown argument ${a}`);
    }
  }
  if (out.selftest) return out;
  if (!out.trace) die(3, "--trace <file> is required; there are no episodes without the subject trace");
  if (!!out.tap === !!out.tapLog) {
    die(3, "exactly one of --tap <file> / --tap-log <file> is required");
  }
  if (out.carrier === null) {
    die(3, "--carrier <ssrc> is REQUIRED: a run with no pinned carrier cannot separate the subject");
  }
  return out;
}

// --------------------------------------------------------------------------
// Inputs
// --------------------------------------------------------------------------

function readText(file, what) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    throw new InputError(`${what} ${file}: ${e.message}`);
  }
}

/** JSONL → records. Every line must parse and carry a numeric t and a string at. */
export function parseTraceText(text, what = "trace") {
  const lines = text.split(/\r?\n/);
  const records = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (e) {
      throw new InputError(`${what}: line ${i + 1} is not JSON (${e.message}) — a truncated trace is not reduced`);
    }
    if (!rec || typeof rec !== "object" || Array.isArray(rec)) {
      throw new InputError(`${what}: line ${i + 1} is not a record object`);
    }
    if (!Number.isFinite(rec.t)) throw new InputError(`${what}: line ${i + 1} has no numeric t`);
    if (typeof rec.at !== "string") throw new InputError(`${what}: line ${i + 1} has no string at`);
    records.push(rec);
  }
  if (records.length === 0) throw new InputError(`${what}: no records`);
  return records;
}

function validateFrame(f, i, what) {
  if (!f || typeof f !== "object" || Array.isArray(f)) {
    throw new InputError(`${what}: frame[${i}] is not an object`);
  }
  for (const k of FRAME_KEYS) {
    if (!(k in f)) throw new InputError(`${what}: frame[${i}] is missing ${k}`);
  }
  if (!Number.isFinite(f.t)) throw new InputError(`${what}: frame[${i}].t is not a number`);
  if (!Number.isFinite(f.ssrc)) throw new InputError(`${what}: frame[${i}].ssrc is not a number`);
  if (!Number.isFinite(f.len)) throw new InputError(`${what}: frame[${i}].len is not a number`);
  if (!Array.isArray(f.head) || !f.head.every((b) => Number.isInteger(b))) {
    throw new InputError(`${what}: frame[${i}].head is not an int array`);
  }
  if (!Array.isArray(f.tail) || !f.tail.every((b) => Number.isInteger(b))) {
    throw new InputError(`${what}: frame[${i}].tail is not an int array`);
  }
  if (typeof f.h !== "string" || f.h.length === 0) {
    throw new InputError(`${what}: frame[${i}].h is not a hash string`);
  }
}

/**
 * A parsed dump object → its frames array, validated. `kind` is "tap" (L10
 * schema, `frames`, schema-checked) or "tap-log" (run-3 ad-hoc, `log`).
 */
export function framesFromDump(obj, kind, what = kind) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
    throw new InputError(`${what}: not a JSON object`);
  }
  let frames;
  if (kind === "tap") {
    if (obj.schema !== TAP_SCHEMA) {
      throw new InputError(`${what}: schema ${JSON.stringify(obj.schema)} is not ${JSON.stringify(TAP_SCHEMA)}`);
    }
    if (!Array.isArray(obj.frames)) throw new InputError(`${what}: no \`frames\` array`);
    frames = obj.frames;
  } else if (kind === "tap-log") {
    if (!Array.isArray(obj.log)) throw new InputError(`${what}: no \`log\` array`);
    frames = obj.log;
  } else {
    throw new InputError(`${what}: unknown dump kind ${kind}`);
  }
  frames.forEach((f, i) => validateFrame(f, i, what));
  return frames;
}

/**
 * F3: a `--tap` dump that reports its own failure is not an input. Returns
 * the informational bits (receiversTapped, trackEvents) or throws.
 */
export function checkTapStats(stats, what = "tap") {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) {
    throw new InputError(`${what}: no \`stats\` object`);
  }
  const errors = Array.isArray(stats.errors) ? stats.errors : [];
  if (errors.length > 0) {
    throw new InputError(`${what}: stats.errors has ${errors.length} entr${errors.length === 1 ? "y" : "ies"} — the tap reported failure: ${JSON.stringify(errors).slice(0, 2000)}`);
  }
  const dropped = Number(stats.dropped === undefined ? 0 : stats.dropped);
  if (dropped > 0) throw new InputError(`${what}: stats.dropped = ${dropped} — frames were lost; a count on a lossy tap is not a count`);
  return {
    receiversTapped: stats.receiversTapped === undefined ? null : stats.receiversTapped,
    trackEvents: Array.isArray(stats.trackEvents) ? stats.trackEvents : null,
  };
}

/**
 * F2: where the skew comes from. `skewFlag` is the --skew-ms value or null.
 * Returns { skewMs, skewSource, clockProbes, clockDriftMs, warnings,
 * resumeUncertaintyMs, resumeUncertaintySource } — the last two are R2's U.
 */
export function resolveSkew({ skewFlag, kind, probes }) {
  const out = {
    skewMs: 0,
    skewSource: "unmeasured",
    clockProbes: [],
    clockDriftMs: null,
    resumeUncertaintyMs: 0,
    resumeUncertaintySource: "unmeasured",
    warnings: [],
  };
  if (kind === "tap") {
    const list = Array.isArray(probes) ? probes : [];
    out.clockProbes = list;
    const valid = list.filter((p) => p && typeof p === "object" && !("error" in p) && Number.isFinite(p.skewMs));
    if (valid.length >= 2) {
      const vals = valid.map((p) => p.skewMs);
      out.clockDriftMs = Math.max(...vals) - Math.min(...vals);
      if (out.clockDriftMs > DRIFT_WARN_MS) {
        out.warnings.push(`clock drift between probes is ${out.clockDriftMs} ms (> ${DRIFT_WARN_MS} ms): probes ${vals.join(", ")}`);
      }
      out.resumeUncertaintyMs = out.clockDriftMs;
      out.resumeUncertaintySource = "drift";
    } else if (valid.length === 1 && Number.isFinite(valid[0].rttMs)) {
      out.resumeUncertaintyMs = valid[0].rttMs / 2;
      out.resumeUncertaintySource = "rtt/2";
    } else {
      out.warnings.push("resume uncertainty unmeasured: no valid clockProbes entry with rttMs; grey frames are reclassified postResume from resume.t exactly (U = 0)");
    }
    if (skewFlag !== null && skewFlag !== undefined) {
      out.skewMs = skewFlag;
      out.skewSource = "flag";
    } else if (valid.length > 0) {
      out.skewMs = valid[valid.length - 1].skewMs;
      out.skewSource = "probe";
    } else {
      throw new InputError(`tap: no valid clockProbes entry (${list.length} probe(s), all missing skewMs or carrying error) and --skew-ms was not given: the skew is unknown and the window cannot be placed`);
    }
  } else if (skewFlag !== null && skewFlag !== undefined) {
    out.skewMs = skewFlag;
    out.skewSource = "flag";
  } else {
    out.skewMs = 0;
    out.skewSource = "unmeasured";
    out.warnings.push("skew unmeasured: --tap-log carries no clockProbes and --skew-ms was not given; using 0");
  }
  if (kind !== "tap") {
    out.warnings.push("resume uncertainty unmeasured: --tap-log carries no clockProbes; grey frames are reclassified postResume from resume.t exactly (U = 0)");
  }
  return out;
}

function loadDump(file, kind) {
  const text = readText(file, kind);
  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    throw new InputError(`${kind} ${file}: not JSON (${e.message})`);
  }
  const frames = framesFromDump(obj, kind, `${kind} ${file}`);
  return { obj, frames };
}

// --------------------------------------------------------------------------
// Blanks
// --------------------------------------------------------------------------

function signatureAt(head, off) {
  if (head.length < off + BLANK_SIGNATURE.length) return false;
  for (let k = 0; k < BLANK_SIGNATURE.length; k++) {
    if (head[off + k] !== BLANK_SIGNATURE[k]) return false;
  }
  return true;
}

/** `f8 ff fe` at offset 0 (no RED byte) or offset 1 (after the RED byte). */
export function hasBlankSignature(head) {
  return signatureAt(head, 0) || signatureAt(head, 1);
}

/** An EMPTY tail is not "all zero": there is no zero padding to observe. */
export function tailAllZero(tail) {
  return tail.length > 0 && tail.every((b) => b === 0);
}

/**
 * Marks blanks over the WHOLE dump. Returns a boolean per dump index. A frame
 * is a blank iff signature AND zero tail AND it sits in a run of >=
 * BLANK_MIN_RUN consecutive frames (in its ssrc's own dump order) sharing one
 * `h`. Never by length.
 */
export function markBlanks(frames) {
  const bySsrc = new Map();
  frames.forEach((f, i) => {
    let idxs = bySsrc.get(f.ssrc);
    if (!idxs) bySsrc.set(f.ssrc, (idxs = []));
    idxs.push(i);
  });
  const blank = new Array(frames.length).fill(false);
  for (const idxs of bySsrc.values()) {
    let runStart = 0;
    for (let k = 1; k <= idxs.length; k++) {
      const runEnds = k === idxs.length || frames[idxs[k]].h !== frames[idxs[runStart]].h;
      if (!runEnds) continue;
      if (k - runStart >= BLANK_MIN_RUN) {
        for (let m = runStart; m < k; m++) {
          const f = frames[idxs[m]];
          if (hasBlankSignature(f.head) && tailAllZero(f.tail)) blank[idxs[m]] = true;
        }
      }
      runStart = k;
    }
  }
  return blank;
}

// --------------------------------------------------------------------------
// Episodes
// --------------------------------------------------------------------------

function isMicSender(r) {
  return r.at === POINTS.senderCreated && r.subjectSource === "microphone";
}

function isMicPublished(r) {
  return r.at === POINTS.published && r.subjectSource === "microphone";
}

function hex(bytes) {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, "0")).join("");
}

function publicationOp(rec) {
  const pubs = rec.publications;
  if (!Array.isArray(pubs) || pubs.length === 0) return null;
  const p = pubs.find((x) => x && x.trackSid === rec.subjectSid);
  if (!p) return null;
  return typeof p.op === "string" ? p.op : null;
}

function frameRow(s, S) {
  const row = {
    t: s.t,
    offsetMs: s.t - S.t,
    ssrc: s.f.ssrc,
    len: s.f.len,
    head: hex(s.f.head),
    h: s.f.h,
  };
  if ("rx" in s.f) row.rx = s.f.rx;
  return row;
}

/** The condition name a reason string carries: `key: detail`. */
export function reasonKey(r) {
  return r.split(":")[0];
}

/**
 * The pure reduction: trace records + dump frames + options → report (minus
 * the skew/tap metadata main() adds). Throws InputError for "no episode" /
 * "carrier has no frames".
 */
export function reduce(
  records,
  frames,
  {
    carrier,
    skewMs = 0,
    endMarginMs = DEFAULT_END_MARGIN_MS,
    requireProcessorAfterEmpty = false,
    trackEvents = null,
    resumeUncertaintyMs = 0,
  },
) {
  const blank = markBlanks(frames);

  // Non-carrier frames on the SUBJECT clock, in (t, dump index) order.
  const subj = [];
  let carrierFrames = 0;
  frames.forEach((f, i) => {
    if (f.ssrc === carrier) carrierFrames++;
    else subj.push({ i, f, t: f.t + skewMs, blank: blank[i] });
  });
  subj.sort((a, b) => a.t - b.t || a.i - b.i);

  if (carrierFrames === 0) {
    throw new InputError(`carrier ${carrier} has ZERO frames in the dump: the tap never saw its positive control, so a verdict on it would be vacuous`);
  }

  // First (skewed) frame per non-carrier ssrc, in t order — the F3 positive
  // control looks for an ssrc whose first frame lies in [S.t, nextS.t).
  const firstBySsrc = new Map();
  for (const s of subj) if (!firstBySsrc.has(s.f.ssrc)) firstBySsrc.set(s.f.ssrc, s);
  const framesHaveRx = subj.some((s) => "rx" in s.f);
  // R1: every receiverIndex that demonstrably delivered a frame (any ssrc).
  const rxWithFrames = new Set();
  for (const f of frames) if ("rx" in f && Number.isFinite(f.rx)) rxWithFrames.add(f.rx);

  const senderIdx = [];
  records.forEach((r, i) => {
    if (isMicSender(r)) senderIdx.push(i);
  });
  if (senderIdx.length === 0) {
    throw new InputError(`no microphone ${POINTS.senderCreated} record in the trace: nothing to reduce`);
  }

  const episodes = [];
  const seen = new Set();
  let prevSenderT = null;

  senderIdx.forEach((si, n) => {
    const S = records[si];
    const nextSi = n + 1 < senderIdx.length ? senderIdx[n + 1] : records.length;
    const nextST = n + 1 < senderIdx.length ? records[senderIdx[n + 1]].t : Infinity;

    // Window-start lower bound: the latest connect.add / disconnect.entry
    // before S in file order; else the previous episode's S.t; else none.
    // A fresh connection cannot carry a frame from before it.
    let lowerBound = -Infinity;
    let boundary = null;
    for (let j = si - 1; j >= 0; j--) {
      const r = records[j];
      if (r.at === POINTS.connectAdd || r.at === POINTS.disconnect) {
        boundary = r;
        break;
      }
    }
    if (boundary) lowerBound = boundary.t;
    else if (prevSenderT !== null) lowerBound = prevSenderT;

    // Close: first later (a) gate-empty, (b) disconnect, (c) mic sender.
    let closeIdx = -1;
    let closedBy = null;
    for (let j = si + 1; j < records.length; j++) {
      const r = records[j];
      if (r.at === POINTS.resumeGate && r.emptied === true) { closeIdx = j; closedBy = "gateEmpty"; break; }
      if (r.at === POINTS.disconnect) { closeIdx = j; closedBy = "disconnect"; break; }
      if (isMicSender(r)) { closeIdx = j; closedBy = "senderCreated"; break; }
    }
    const end = closeIdx >= 0 ? records[closeIdx].t : Infinity;
    const scanEnd = closeIdx >= 0 ? closeIdx : records.length;

    // Landed: first microphone publish record before the close.
    let pubRec = null;
    for (let j = si + 1; j < scanEnd; j++) {
      if (isMicPublished(records[j])) { pubRec = records[j]; break; }
    }
    const landed = pubRec !== null;
    const op = pubRec ? publicationOp(pubRec) : null;

    // F7: not landed, closed by a gate-empty, and the publish arrives soon after.
    let landedAfterClose = null;
    if (!landed && closedBy === "gateEmpty") {
      for (let j = closeIdx + 1; j < records.length; j++) {
        const r = records[j];
        if (!isMicPublished(r)) continue;
        if (r.t < end + LANDED_AFTER_CLOSE_MS) landedAfterClose = { t: r.t, op: publicationOp(r) };
        break;
      }
    }

    // F5: gate held at S; processor re-attach placement.
    const gateHeldAtS = typeof S.gateHeld === "boolean" ? S.gateHeld : null;
    let processorUpdateAt = null;
    for (let j = si + 1; j < nextSi; j++) {
      const r = records[j];
      if (r.at === POINTS.processorUpdate && r.subjectSource === "microphone") { processorUpdateAt = r.t; break; }
    }
    let firstGateEmptyAfterS = null;
    for (let j = si + 1; j < records.length; j++) {
      const r = records[j];
      if (r.at === POINTS.resumeGate && r.emptied === true) { firstGateEmptyAfterS = r.t; break; }
    }
    const processorAfterGateEmpty =
      processorUpdateAt === null ? null : firstGateEmptyAfterS === null ? false : processorUpdateAt > firstGateEmptyAfterS;

    // Window start: S.t, or the first frame of a new ssrc if it lands earlier.
    let firstNew = null;
    for (const s of subj) {
      if (s.t >= end) break;
      if (s.t < lowerBound) continue;
      if (seen.has(s.f.ssrc)) continue;
      firstNew = s;
      break;
    }
    let start = S.t;
    let windowStartedBy = "senderCreated";
    if (firstNew && firstNew.t < S.t) {
      start = firstNew.t;
      windowStartedBy = "firstFrame";
    }

    const inWindow = subj.filter((s) => s.t >= start && s.t < end);
    for (const s of inWindow) seen.add(s.f.ssrc);
    const subjectFrames = inWindow.filter((s) => !s.blank);
    const blanks = inWindow.filter((s) => s.blank);
    const hashes = [...new Set(blanks.map((s) => s.f.h))];

    // F1: the grey zone after the close.
    const greyAll = closeIdx >= 0 ? subj.filter((s) => !s.blank && s.t >= end && s.t < end + endMarginMs) : [];

    // R2/F2: the resume fiducial — first track.upstreamResumed for the landed
    // sid at or after end, valid only for a gate-empty close and only when
    // that record itself reads gateHeld === false (a held-gate "resume" is
    // the repause beat). Grey frames at/after resumeAt + U are postResume.
    let resumeAt = null;
    if (closedBy === "gateEmpty" && pubRec) {
      for (let j = si + 1; j < records.length; j++) {
        const r = records[j];
        if (r.at !== POINTS.upstreamResumed || r.subjectSid !== pubRec.subjectSid || r.t < end) continue;
        if (r.gateHeld === false) resumeAt = r.t;
        break;
      }
    }
    const postResumeFrames = resumeAt === null ? [] : greyAll.filter((s) => s.t >= resumeAt + resumeUncertaintyMs);
    const greyFrames = resumeAt === null ? greyAll : greyAll.filter((s) => s.t < resumeAt + resumeUncertaintyMs);

    // F1 / F3 / F4: the receiver attached for the landed sid, on the SUBJECT
    // clock, before the episode's temporal bound (end for a gate-empty or
    // disconnect close, the next S.t otherwise).
    const evT = (e) => e.t + skewMs;
    const rxBound = closedBy === "gateEmpty" || closedBy === "disconnect" ? end : nextST;
    let coverageEv = null;
    if (pubRec && Array.isArray(trackEvents)) {
      coverageEv = trackEvents.find((e) => e && e.trackSid === pubRec.subjectSid && Number.isFinite(e.receiverIndex) && Number.isFinite(e.t) && evT(e) < rxBound) || null;
    }
    const receiverAt = coverageEv ? evT(coverageEv) : null;
    const rxFramesInWindow = coverageEv
      ? frames.filter((f) => f.rx === coverageEv.receiverIndex && f.t + skewMs >= start && f.t + skewMs < end).length
      : null;
    const publishedAt = pubRec ? pubRec.t : null;
    const offsetFromPublishMs = receiverAt !== null && publishedAt !== null ? receiverAt - publishedAt : null;
    let covered = "none";
    if (offsetFromPublishMs !== null) {
      if (offsetFromPublishMs <= -COVERAGE_MARGIN_MS) covered = "partial";
      else if (offsetFromPublishMs <= COVERAGE_MARGIN_MS) covered = "marginal";
      else covered = "late";
    }
    const windowCoverage = { receiverAt, publishedAt, offsetFromPublishMs, covered };

    // F3 + R1: positive control — an ssrc first seen in [S.t, nextS.t), else
    // the receiver attached for the landed sid (before the bound) whose
    // transform delivered frames somewhere in the dump.
    let positiveControl = null;
    for (const [ssrc, s] of firstBySsrc) {
      if (s.t >= S.t && s.t < nextST) { positiveControl = { kind: "frames", ssrc, t: s.t }; break; }
    }
    if (!positiveControl && coverageEv && rxWithFrames.has(coverageEv.receiverIndex)) {
      positiveControl = { kind: "transformDelivers", receiverIndex: coverageEv.receiverIndex, t: receiverAt };
    }

    // F3 informational: which receiver carried the landed sid.
    let subjectRx = null;
    let subjectFramesOnOtherRx = null;
    if (framesHaveRx && Array.isArray(trackEvents) && pubRec) {
      const matches = trackEvents.filter((e) => e && e.trackSid === pubRec.subjectSid && Number.isFinite(e.receiverIndex));
      if (matches.length) subjectRx = matches[matches.length - 1].receiverIndex;
      if (subjectRx !== null) subjectFramesOnOtherRx = subjectFrames.filter((s) => s.f.rx !== subjectRx).length;
    }

    const reasons = [];
    if (closedBy === null) reasons.push("open: no gateEmpty / disconnect / senderCreated after localSenderCreated");
    if (subjectFrames.length > 0) reasons.push(`subjectFrames: ${subjectFrames.length} non-blank frame(s) in the window`);
    if (!landed && landedAfterClose) reasons.push(`landedAfterClose: microphone localTrackPublished.entry at ${landedAfterClose.t} (+${landedAfterClose.t - end} ms after the gate-empty close, op ${JSON.stringify(landedAfterClose.op)})`);
    if (!landed && !landedAfterClose) reasons.push("landed: no microphone localTrackPublished.entry before the close");
    if (op !== "none") reasons.push(`op: ${op === null ? "null" : JSON.stringify(op)} (want "none")`);
    if (gateHeldAtS !== true) reasons.push(`gateNotHeld: localSenderCreated.gateHeld is ${JSON.stringify(gateHeldAtS)} — an empty gate proves nothing about D0`);
    if (!positiveControl) reasons.push(`untapped: no non-carrier ssrc first seen in [${S.t}, ${nextST === Infinity ? "end of dump" : nextST}) and no trackEvent for ${pubRec ? JSON.stringify(pubRec.subjectSid) : "an unlanded sid"} before ${rxBound === Infinity ? "end of dump" : rxBound} on a receiver that delivered frames — the tap never saw this publish`);
    if (requireProcessorAfterEmpty && processorUpdateAt !== null && processorAfterGateEmpty === false) reasons.push(`processorInsideHold: track.processorUpdate at ${processorUpdateAt} ran before the first gate-empty${firstGateEmptyAfterS === null ? " (none ever followed)" : ` at ${firstGateEmptyAfterS}`}`);
    if (greyFrames.length > 0) reasons.push(`greyZone: ${greyFrames.length} non-blank frame(s) in [end, end + ${endMarginMs} ms) — transit/skew may have pushed a leaked frame past the close; read them`);

    episodes.push({
      index: n + 1,
      senderCreatedAt: S.t,
      staleSid: S.subjectSid === undefined ? null : S.subjectSid,
      gateHeldAtS,
      landed,
      publishedAt: pubRec ? pubRec.t : null,
      newSid: pubRec ? (pubRec.subjectSid === undefined ? null : pubRec.subjectSid) : null,
      op,
      landedAfterClose,
      windowStart: start,
      windowStartedBy,
      windowLowerBound: Number.isFinite(lowerBound) ? lowerBound : null,
      end: closeIdx >= 0 ? records[closeIdx].t : null,
      closedBy,
      firstFrameOffsetMs: subjectFrames.length ? subjectFrames[0].t - S.t : null,
      subjectFrames: {
        n: subjectFrames.length,
        list: subjectFrames.slice(0, LIST_CAP).map((s) => frameRow(s, S)),
        truncated: Math.max(0, subjectFrames.length - LIST_CAP),
      },
      blanksExcluded: { n: blanks.length, hashes },
      greyZone: {
        n: greyFrames.length,
        list: greyFrames.slice(0, LIST_CAP).map((s) => frameRow(s, S)),
        truncated: Math.max(0, greyFrames.length - LIST_CAP),
      },
      postResume: {
        n: postResumeFrames.length,
        list: postResumeFrames.slice(0, POST_RESUME_LIST_CAP).map((s) => frameRow(s, S)),
        truncated: Math.max(0, postResumeFrames.length - POST_RESUME_LIST_CAP),
        resumeAt,
        uncertaintyMs: resumeUncertaintyMs,
      },
      positiveControl,
      windowCoverage,
      rxFramesInWindow,
      subjectRx,
      subjectFramesOnOtherRx,
      processorUpdateAt,
      processorAfterGateEmpty,
      reasons,
    });

    prevSenderT = S.t;
  });

  const hard = episodes.some((e) => e.reasons.some((r) => reasonKey(r) !== "greyZone"));
  const grey = episodes.some((e) => e.greyZone.n > 0);
  const verdict = hard ? "FAIL" : grey ? "PASS-WITH-GREY" : "PASS";
  return {
    schema: REPORT_SCHEMA,
    verdict,
    carrier,
    skewMs,
    endMarginMs,
    requireProcessorAfterEmpty,
    episodes,
    totals: {
      frames: frames.length,
      carrierFrames,
      subjectFramesAll: episodes.reduce((a, e) => a + e.subjectFrames.n, 0),
      blanksAll: episodes.reduce((a, e) => a + e.blanksExcluded.n, 0),
      greyAll: episodes.reduce((a, e) => a + e.greyZone.n, 0),
      postResumeAll: episodes.reduce((a, e) => a + e.postResume.n, 0),
    },
  };
}

// --------------------------------------------------------------------------
// Output
// --------------------------------------------------------------------------

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function fmtOffset(ms) {
  return `${ms >= 0 ? "+" : ""}${ms}ms`;
}

function printHuman(report) {
  const out = [];
  const T = report.totals;
  out.push(
    `toc-reduce: carrier=${report.carrier} frames=${T.frames} carrier=${T.carrierFrames} non-carrier=${T.frames - T.carrierFrames} end-margin=${report.endMarginMs}ms`,
  );
  out.push(`skew: ${report.skewMs}ms (source ${report.skewSource})`);
  for (const p of report.clockProbes) {
    out.push(`  probe: ${JSON.stringify(p)}`);
  }
  if (report.clockDriftMs !== null) out.push(`  drift between probes: ${report.clockDriftMs}ms`);
  out.push(`resume uncertainty U: ${report.resumeUncertaintyMs}ms (source ${report.resumeUncertaintySource})`);
  if (report.receiversTapped !== null) out.push(`receiversTapped: ${JSON.stringify(report.receiversTapped)}`);
  if (report.trackEvents) {
    out.push(`trackEvents (${report.trackEvents.length}):`);
    for (const e of report.trackEvents) out.push(`  ${JSON.stringify(e)}`);
  }
  for (const w of report.warnings) out.push(`WARNING: ${w}`);
  out.push(
    [
      pad("ep", 3),
      pad("senderCreated", 14),
      pad("held", 5),
      pad("start(by)", 27),
      pad("end(closedBy)", 28),
      pad("landed/op", 26),
      pad("subj", 5),
      pad("blanks", 7),
      pad("grey", 5),
      pad("postR", 6),
      pad("tapped", 22),
      pad("coverage", 18),
      pad("processor", 22),
      "firstOff",
    ].join(" "),
  );
  for (const e of report.episodes) {
    out.push(
      [
        pad(e.index, 3),
        pad(e.senderCreatedAt, 14),
        pad(e.gateHeldAtS === null ? "null" : e.gateHeldAtS, 5),
        pad(`${e.windowStart}(${e.windowStartedBy})`, 27),
        pad(e.end === null ? "OPEN" : `${e.end}(${e.closedBy})`, 28),
        pad(e.landed ? `${e.newSid ?? "?"}/${e.op ?? "null"}` : e.landedAfterClose ? `AFTER-CLOSE +${e.landedAfterClose.t - e.end}ms/${e.landedAfterClose.op ?? "null"}` : "no", 26),
        pad(e.subjectFrames.n, 5),
        pad(e.blanksExcluded.n, 7),
        pad(e.greyZone.n, 5),
        pad(e.postResume.n, 6),
        pad(
          e.positiveControl
            ? e.positiveControl.kind === "frames"
              ? `ssrc ${e.positiveControl.ssrc}`
              : `xform rx${e.positiveControl.receiverIndex}@${fmtOffset(e.positiveControl.t - e.senderCreatedAt)}`
            : "NONE",
          22,
        ),
        pad(
          e.windowCoverage.covered === "none"
            ? "none"
            : `${e.windowCoverage.covered}(${fmtOffset(e.windowCoverage.offsetFromPublishMs)} rxfr=${e.rxFramesInWindow})`,
          18,
        ),
        pad(e.processorUpdateAt === null ? "none" : `${fmtOffset(e.processorUpdateAt - e.senderCreatedAt)} afterEmpty=${e.processorAfterGateEmpty}`, 22),
        e.firstFrameOffsetMs === null ? "-" : fmtOffset(e.firstFrameOffsetMs),
      ].join(" "),
    );
    if (e.blanksExcluded.n) out.push(`    blanks excluded under h=${e.blanksExcluded.hashes.join(",")}`);
    if (e.subjectRx !== null) out.push(`    subjectRx=${e.subjectRx} subjectFramesOnOtherRx=${e.subjectFramesOnOtherRx}`);
    for (const f of e.subjectFrames.list) {
      out.push(`    ${fmtOffset(f.offsetMs)} t=${f.t} ssrc=${f.ssrc} len=${f.len} head=${f.head} h=${f.h}${"rx" in f ? ` rx=${f.rx}` : ""}`);
    }
    if (e.subjectFrames.truncated) out.push(`    ... ${e.subjectFrames.truncated} more subject frame(s)`);
    for (const f of e.greyZone.list) {
      out.push(`    GREY ${fmtOffset(f.offsetMs)} t=${f.t} ssrc=${f.ssrc} len=${f.len} head=${f.head} h=${f.h}${"rx" in f ? ` rx=${f.rx}` : ""}`);
    }
    if (e.greyZone.truncated) out.push(`    ... ${e.greyZone.truncated} more grey-zone frame(s)`);
    if (e.postResume.n) out.push(`    post-resume: resume at ${e.postResume.resumeAt} (${fmtOffset(e.postResume.resumeAt - e.end)} after end) + U ${e.postResume.uncertaintyMs}ms`);
    for (const f of e.postResume.list) {
      out.push(`    POST-RESUME ${fmtOffset(f.offsetMs)} t=${f.t} ssrc=${f.ssrc} len=${f.len} head=${f.head} h=${f.h}${"rx" in f ? ` rx=${f.rx}` : ""}`);
    }
    if (e.postResume.truncated) out.push(`    ... ${e.postResume.truncated} more post-resume frame(s)`);
  }
  out.push(`VERDICT: ${report.verdict}`);
  for (const e of report.episodes) {
    for (const r of e.reasons) out.push(`  ep${e.index}: ${r}`);
  }
  process.stdout.write(out.join("\n") + "\n");
}

// --------------------------------------------------------------------------
// Selftest — hand-written fixtures, carrier ssrc 1, subject ssrc 2
// --------------------------------------------------------------------------

const fx = {
  S: (t, sid = null, gateHeld = true) => ({
    t,
    p: t,
    at: POINTS.senderCreated,
    subject: sid ? `microphone/${sid}` : "microphone/no-sid",
    subjectSource: "microphone",
    subjectSid: sid,
    gate: gateHeld ? ["negotiating"] : [],
    gateHeld,
    connectGen: 1,
  }),
  P: (t, sid, op) => ({
    t,
    p: t,
    at: POINTS.published,
    subject: `microphone/${sid}`,
    subjectSource: "microphone",
    subjectSid: sid,
    publications: [
      {
        name: `microphone/${sid}`,
        source: "microphone",
        trackSid: sid,
        upstreamPaused: true,
        hasSender: false,
        senderHasTrack: false,
        transportState: "connected",
        upstream: "paused",
        op,
      },
    ],
  }),
  G: (t) => ({ t, p: t, at: POINTS.resumeGate, reason: "negotiating", emptied: true, gate: [], gateHeld: false }),
  D: (t) => ({ t, p: t, at: POINTS.disconnect, connectGenPhase: "pre-bump" }),
  C: (t) => ({ t, p: t, at: POINTS.connectAdd, e2eeCapable: true, gate: ["negotiating"], gateHeld: true }),
  PU: (t, sid = "TR_A") => ({ t, p: t, at: POINTS.processorUpdate, subject: `microphone/${sid}`, subjectSource: "microphone", subjectSid: sid }),
  UR: (t, sid = "TR_A", gateHeld = false) => ({ t, p: t, at: POINTS.upstreamResumed, subject: `microphone/${sid}`, subjectSource: "microphone", subjectSid: sid, gateHeld, gate: gateHeld ? ["mixed"] : [] }),
  carrier: (from, to, step = 20) => {
    const out = [];
    for (let t = from; t <= to; t += step) {
      out.push({ t, ssrc: 1, len: 247, head: [239, 15, 0, 121, 111, 252], tail: [1, 254, 124, 137], h: `c${t.toString(16)}` });
    }
    return out;
  },
  speech: (t, ssrc = 2) => ({ t, ssrc, len: 186, head: [239, 15, 0, 88, 111, 124], tail: [191, 135, 146, 64], h: `s${t.toString(16)}` }),
  blank81: (t, ssrc = 2) => ({ t, ssrc, len: 81, head: [111, 248, 255, 254, 0, 0], tail: [0, 0, 0, 0], h: "54dd8641" }),
  blank80: (t, ssrc = 2) => ({ t, ssrc, len: 80, head: [248, 255, 254, 0, 0, 0], tail: [0, 0, 0, 0], h: "badcafe" }),
  /** signature + identical hash, but a NON-zero tail: the tail rule's control. */
  sigNonZeroTail: (t, ssrc = 2) => ({ t, ssrc, len: 81, head: [111, 248, 255, 254, 0, 0], tail: [0, 0, 0, 7], h: "deadbee" }),
  /** identical DTX frames, no signature: the signature rule's control. */
  dtx: (t, ssrc = 2) => ({ t, ssrc, len: 2, head: [111, 252], tail: [111, 252], h: "d3335046" }),
  /** the positive control: post-resume flow well past the grey zone. */
  post: (t = 3000, ssrc = 2) => ({ t, ssrc, len: 186, head: [239, 15, 0, 88, 111, 124], tail: [9, 9, 9, 9], h: `p${t.toString(16)}` }),
};

const BASE_TRACE = () => [fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)];

function dump(subjectFrames) {
  // Dump order is t order (the tap posts frames as they arrive); stable sort
  // keeps each ssrc's own order.
  return [...fx.carrier(900, 5100), ...subjectFrames].sort((a, b) => a.t - b.t);
}

function run(records, frames, opts = {}) {
  return reduce(records, frames, { carrier: 1, skewMs: 0, ...opts });
}

function has(e, key) {
  return e.reasons.some((r) => reasonKey(r) === key);
}

function expectThrows(fn) {
  try {
    fn();
  } catch (e) {
    if (e instanceof InputError) return e.message;
    throw e;
  }
  return null;
}

const CONTROLS = [
  {
    name: "1. one speech-shaped frame INSIDE the window → FAIL, subjectFrames.n === 1",
    check: () => {
      const r = run(BASE_TRACE(), dump([fx.speech(1200)]));
      const e = r.episodes[0];
      return r.verdict === "FAIL" && e.subjectFrames.n === 1 && has(e, "subjectFrames")
        ? null
        : JSON.stringify({ verdict: r.verdict, n: e.subjectFrames.n, reasons: e.reasons });
    },
  },
  {
    name: "2. the same trace with that frame removed (post-resume positive control only) → PASS",
    check: () => {
      const r = run(BASE_TRACE(), dump([fx.post()]));
      return r.verdict === "PASS" && r.episodes[0].subjectFrames.n === 0 && r.episodes[0].reasons.length === 0
        ? null
        : JSON.stringify(r.episodes[0]);
    },
  },
  {
    name: "3. the speech frame AFTER the gate-empty record and past the grey zone → PASS (out of window)",
    check: () => {
      const r = run(BASE_TRACE(), dump([fx.speech(2500)]));
      const e = r.episodes[0];
      return r.verdict === "PASS" && e.subjectFrames.n === 0 && e.greyZone.n === 0 && e.closedBy === "gateEmpty" && e.end === 2000
        ? null
        : JSON.stringify(e);
    },
  },
  {
    name: "4. a SINGLE blank-signature frame (no ≥3 run) → COUNTS → FAIL, n === 1",
    check: () => {
      const r = run(BASE_TRACE(), dump([fx.blank81(1200)]));
      const e = r.episodes[0];
      return r.verdict === "FAIL" && e.subjectFrames.n === 1 && e.blanksExcluded.n === 0 ? null : JSON.stringify(e);
    },
  },
  {
    name: "5. five 80 B blanks (no RED byte, zero tail, one hash) → all excluded → PASS, blanksExcluded.n === 5",
    check: () => {
      const r = run(BASE_TRACE(), dump([1200, 1220, 1240, 1260, 1280].map((t) => fx.blank80(t))));
      const e = r.episodes[0];
      return r.verdict === "PASS" &&
        e.subjectFrames.n === 0 &&
        e.blanksExcluded.n === 5 &&
        e.blanksExcluded.hashes.length === 1 &&
        e.blanksExcluded.hashes[0] === "badcafe"
        ? null
        : JSON.stringify(e);
    },
  },
  {
    name: "6. no gate-empty AND no disconnect → episode open → FAIL naming open",
    check: () => {
      const r = run([fx.S(1000), fx.P(1300, "TR_A", "none")], dump([fx.post()]));
      const e = r.episodes[0];
      return r.verdict === "FAIL" && e.closedBy === null && e.end === null && has(e, "open") ? null : JSON.stringify(e);
    },
  },
  {
    name: "7. first frame 30 ms BEFORE S.t via --skew-ms → counted, windowStartedBy firstFrame, offset −30",
    check: () => {
      // Observer clock reads 940; skew +30 puts it at 970 on the subject clock,
      // 30 ms before S.t = 1000.
      const r = run(BASE_TRACE(), dump([fx.speech(940)]), { skewMs: 30 });
      const e = r.episodes[0];
      return r.verdict === "FAIL" &&
        e.windowStartedBy === "firstFrame" &&
        e.windowStart === 970 &&
        e.subjectFrames.n === 1 &&
        e.firstFrameOffsetMs === -30
        ? null
        : JSON.stringify(e);
    },
  },
  {
    name: '8. landed with op "repause" → FAIL naming op',
    check: () => {
      const r = run([fx.S(1000), fx.P(1300, "TR_A", "repause"), fx.G(2000), fx.D(5000)], dump([fx.post()]));
      const e = r.episodes[0];
      return r.verdict === "FAIL" && e.op === "repause" && has(e, "op") && e.reasons.length === 1 ? null : JSON.stringify(e);
    },
  },
  {
    name: "9. a second mic localSenderCreated closes the first episode (closedBy senderCreated); frames land in their own episodes",
    check: () => {
      const trace = [fx.S(1000), fx.P(1300, "TR_A", "none"), fx.S(1500, "TR_A"), fx.P(1800, "TR_B", "none"), fx.G(2000), fx.D(5000)];
      const r = run(trace, dump([fx.speech(1100, 2), fx.speech(1600, 3)]));
      const [a, b] = r.episodes;
      return r.episodes.length === 2 &&
        a.closedBy === "senderCreated" &&
        a.end === 1500 &&
        a.subjectFrames.n === 1 &&
        a.staleSid === null &&
        a.positiveControl && a.positiveControl.ssrc === 2 &&
        b.staleSid === "TR_A" &&
        b.newSid === "TR_B" &&
        b.closedBy === "gateEmpty" &&
        b.subjectFrames.n === 1 &&
        b.windowStartedBy === "senderCreated" &&
        b.positiveControl && b.positiveControl.ssrc === 3
        ? null
        : JSON.stringify(r.episodes);
    },
  },
  {
    name: "10. a blank run of 3 that STRADDLES the window end is still a run (consecutive across the whole dump) → PASS, blanksExcluded.n === 2, grey 0",
    check: () => {
      const r = run(BASE_TRACE(), dump([fx.blank81(1900), fx.blank81(1950), fx.blank81(2100)]));
      const e = r.episodes[0];
      return r.verdict === "PASS" && e.blanksExcluded.n === 2 && e.subjectFrames.n === 0 && e.greyZone.n === 0 ? null : JSON.stringify(e);
    },
  },
  {
    name: "11. signature + identical hash ×5 but NON-ZERO tail → not blanks → FAIL, n === 5 (the tail rule)",
    check: () => {
      const r = run(BASE_TRACE(), dump([1200, 1220, 1240, 1260, 1280].map((t) => fx.sigNonZeroTail(t))));
      const e = r.episodes[0];
      return r.verdict === "FAIL" && e.subjectFrames.n === 5 && e.blanksExcluded.n === 0 ? null : JSON.stringify(e);
    },
  },
  {
    name: "12. identical DTX frames ×3 with NO signature → not blanks → FAIL, n === 3 (the signature rule)",
    check: () => {
      const r = run(BASE_TRACE(), dump([fx.dtx(1200), fx.dtx(1220), fx.dtx(1240)]));
      const e = r.episodes[0];
      return r.verdict === "FAIL" && e.subjectFrames.n === 3 && e.blanksExcluded.n === 0 ? null : JSON.stringify(e);
    },
  },
  {
    name: "13. input refusals: wrong schema / missing top-level key / frame missing h / non-JSON trace / no mic episode / carrier with zero frames",
    check: () => {
      const good = { t: 1, ssrc: 1, len: 2, head: [1, 2], tail: [1, 2], h: "a" };
      const cases = [
        ["tap wrong schema", () => framesFromDump({ schema: "sloga-leg-toc/0", frames: [good] }, "tap")],
        ["tap missing schema", () => framesFromDump({ frames: [good] }, "tap")],
        ["tap missing frames", () => framesFromDump({ schema: TAP_SCHEMA, log: [good] }, "tap")],
        ["tap-log missing log", () => framesFromDump({ stats: {}, frames: [good] }, "tap-log")],
        ["frame missing h", () => framesFromDump({ stats: {}, log: [{ ...good, h: undefined }] }, "tap-log")],
        ["frame missing tail", () => framesFromDump({ stats: {}, log: [{ t: 1, ssrc: 1, len: 2, head: [1], h: "a" }] }, "tap-log")],
        ["trace not JSON", () => parseTraceText('{"t":1,"at":"x"}\n{oops')],
        ["trace record without t", () => parseTraceText('{"at":"x"}')],
        ["no mic episode", () => run([fx.G(2000), fx.D(5000)], dump([]))],
        ["carrier zero frames", () => reduce(BASE_TRACE(), [fx.speech(1200)], { carrier: 1, skewMs: 0 })],
      ];
      const notRefused = cases.filter(([, fn]) => expectThrows(fn) === null).map(([n]) => n);
      // And the good shapes are ACCEPTED.
      const accepted =
        framesFromDump({ schema: TAP_SCHEMA, frames: [good] }, "tap").length === 1 &&
        framesFromDump({ stats: {}, log: [good] }, "tap-log").length === 1;
      return notRefused.length === 0 && accepted ? null : JSON.stringify({ notRefused, accepted });
    },
  },
  {
    name: "14. a never-seen ssrc frame BEFORE the connect.add that precedes S does NOT move the window start (lower bound) → senderCreated, PASS",
    check: () => {
      const trace = [fx.C(950), fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)];
      const r = run(trace, dump([fx.speech(920), fx.post(3000, 3)]));
      const e = r.episodes[0];
      return r.verdict === "PASS" &&
        e.windowStartedBy === "senderCreated" &&
        e.windowStart === 1000 &&
        e.windowLowerBound === 950 &&
        e.subjectFrames.n === 0
        ? null
        : JSON.stringify(e);
    },
  },
  {
    name: "15. the same frame AFTER that connect.add and 30 ms before S.t DOES move it → firstFrame, counted, FAIL",
    check: () => {
      const trace = [fx.C(950), fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)];
      const r = run(trace, dump([fx.speech(970)]));
      const e = r.episodes[0];
      return r.verdict === "FAIL" &&
        e.windowStartedBy === "firstFrame" &&
        e.windowStart === 970 &&
        e.subjectFrames.n === 1 &&
        e.firstFrameOffsetMs === -30
        ? null
        : JSON.stringify(e);
    },
  },
  {
    name: "16. F1 grey zone: a non-blank frame 50 ms after the gate-empty close → PASS-WITH-GREY naming greyZone; margin 20 → PASS; blanks in the zone do not count",
    check: () => {
      const a = run(BASE_TRACE(), dump([fx.post(), fx.speech(2050)]));
      const ea = a.episodes[0];
      const b = run(BASE_TRACE(), dump([fx.post(), fx.speech(2050)]), { endMarginMs: 20 });
      const eb = b.episodes[0];
      const c = run(BASE_TRACE(), dump([fx.post(), fx.blank81(2050), fx.blank81(2060), fx.blank81(2070)]));
      const ec = c.episodes[0];
      // A hard failure elsewhere stays FAIL, with greyZone still named.
      const d = run(BASE_TRACE(), dump([fx.speech(1200), fx.speech(2050)]));
      return a.verdict === "PASS-WITH-GREY" &&
        ea.greyZone.n === 1 &&
        ea.greyZone.list.length === 1 &&
        ea.greyZone.list[0].offsetMs === 1050 &&
        ea.subjectFrames.n === 0 &&
        has(ea, "greyZone") &&
        ea.reasons.length === 1 &&
        a.totals.greyAll === 1 &&
        b.verdict === "PASS" &&
        eb.greyZone.n === 0 &&
        c.verdict === "PASS" &&
        ec.greyZone.n === 0 &&
        d.verdict === "FAIL" &&
        has(d.episodes[0], "greyZone")
        ? null
        : JSON.stringify({ a: ea, b: eb, c: ec, d: d.episodes[0] });
    },
  },
  {
    name: "17. F2 skew: last valid probe wins; drift > 10 ms warns; no valid probe refuses; --skew-ms overrides; --tap-log without flag warns unmeasured",
    check: () => {
      const ok = (p) => ({ t0: 1, t1: 2, serverMs: 3, skewMs: p, rttMs: 1 });
      const a = resolveSkew({ skewFlag: null, kind: "tap", probes: [ok(12), ok(15)] });
      const b = resolveSkew({ skewFlag: null, kind: "tap", probes: [ok(12), { error: "x" }, ok(35)] });
      const c = expectThrows(() => resolveSkew({ skewFlag: null, kind: "tap", probes: [{ error: "x" }, { error: "y" }] }));
      const c2 = expectThrows(() => resolveSkew({ skewFlag: null, kind: "tap", probes: undefined }));
      const d = resolveSkew({ skewFlag: 7, kind: "tap", probes: [ok(12), ok(15)] });
      const e = resolveSkew({ skewFlag: null, kind: "tap-log", probes: undefined });
      const f = resolveSkew({ skewFlag: 4, kind: "tap-log", probes: undefined });
      const skewWarn = (x) => x.warnings.filter((w) => /skew unmeasured/.test(w)).length;
      const driftWarn = (x) => x.warnings.filter((w) => /clock drift/.test(w)).length;
      return a.skewMs === 15 && a.skewSource === "probe" && a.clockDriftMs === 3 && a.warnings.length === 0 &&
        b.skewMs === 35 && b.clockDriftMs === 23 && driftWarn(b) === 1 && b.warnings.length === 1 &&
        c !== null && c2 !== null &&
        d.skewMs === 7 && d.skewSource === "flag" && d.clockDriftMs === 3 && d.warnings.length === 0 &&
        e.skewMs === 0 && e.skewSource === "unmeasured" && skewWarn(e) === 1 &&
        f.skewMs === 4 && f.skewSource === "flag" && skewWarn(f) === 0 && driftWarn(f) === 0
        ? null
        : JSON.stringify({ a, b, c, c2, d, e, f });
    },
  },
  {
    name: "18. F3 tap stats: errors non-empty refuses; dropped > 0 refuses; missing stats refuses; clean stats accepted with receiversTapped/trackEvents",
    check: () => {
      const errs = expectThrows(() => checkTapStats({ errors: ["boom"], dropped: 0 }));
      const drop = expectThrows(() => checkTapStats({ errors: [], dropped: 3 }));
      const none = expectThrows(() => checkTapStats(undefined));
      const ok = checkTapStats({ errors: [], dropped: 0, receiversTapped: 3, trackEvents: [{ t: 1, trackSid: "TR_A", participantSid: "PA", receiverIndex: 2 }] });
      const bare = checkTapStats({});
      return errs !== null && /errors/.test(errs) &&
        drop !== null && /dropped = 3/.test(drop) &&
        none !== null &&
        ok.receiversTapped === 3 && ok.trackEvents.length === 1 &&
        bare.receiversTapped === null && bare.trackEvents === null
        ? null
        : JSON.stringify({ errs, drop, none, ok, bare });
    },
  },
  {
    name: "19. F3 untapped: no frame on a never-seen ssrc at/after S.t → FAIL naming untapped; a pre-S-only ssrc is not a positive control",
    check: () => {
      const a = run(BASE_TRACE(), dump([]));
      const b = run([fx.C(950), fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)], dump([fx.speech(920)]));
      const c = run(BASE_TRACE(), dump([fx.post()]));
      return a.verdict === "FAIL" && has(a.episodes[0], "untapped") && a.episodes[0].positiveControl === null &&
        b.verdict === "FAIL" && has(b.episodes[0], "untapped") &&
        c.verdict === "PASS" && c.episodes[0].positiveControl && c.episodes[0].positiveControl.ssrc === 2 && c.episodes[0].positiveControl.t === 3000
        ? null
        : JSON.stringify({ a: a.episodes[0], b: b.episodes[0], c: c.episodes[0] });
    },
  },
  {
    name: "20. F5 gateNotHeld: localSenderCreated with gateHeld false (or absent) → FAIL naming gateNotHeld; true → clean",
    check: () => {
      const a = run([fx.S(1000, null, false), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)], dump([fx.post()]));
      const absent = fx.S(1000);
      delete absent.gateHeld;
      const b = run([absent, fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)], dump([fx.post()]));
      const c = run(BASE_TRACE(), dump([fx.post()]));
      return a.verdict === "FAIL" && a.episodes[0].gateHeldAtS === false && has(a.episodes[0], "gateNotHeld") && a.episodes[0].reasons.length === 1 &&
        b.verdict === "FAIL" && b.episodes[0].gateHeldAtS === null && has(b.episodes[0], "gateNotHeld") &&
        c.episodes[0].gateHeldAtS === true && !has(c.episodes[0], "gateNotHeld")
        ? null
        : JSON.stringify({ a: a.episodes[0], b: b.episodes[0], c: c.episodes[0] });
    },
  },
  {
    name: "21. F5 processor: inside the hold → processorAfterGateEmpty false, PASS without the flag, FAIL processorInsideHold with it; after the empty → true, PASS with it; none → null",
    check: () => {
      const inside = [fx.S(1000), fx.P(1300, "TR_A", "none"), fx.PU(1500), fx.G(2000), fx.D(5000)];
      const after = [fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.PU(2500), fx.D(5000)];
      const a = run(inside, dump([fx.post()]));
      const b = run(inside, dump([fx.post()]), { requireProcessorAfterEmpty: true });
      const c = run(after, dump([fx.post()]), { requireProcessorAfterEmpty: true });
      const d = run(BASE_TRACE(), dump([fx.post()]), { requireProcessorAfterEmpty: true });
      // Open episode with a processor: no gate-empty ever follows → false.
      const e = run([fx.S(1000), fx.P(1300, "TR_A", "none"), fx.PU(1500)], dump([fx.post()]), { requireProcessorAfterEmpty: true });
      return a.verdict === "PASS" && a.episodes[0].processorUpdateAt === 1500 && a.episodes[0].processorAfterGateEmpty === false &&
        b.verdict === "FAIL" && has(b.episodes[0], "processorInsideHold") && b.episodes[0].reasons.length === 1 &&
        c.verdict === "PASS" && c.episodes[0].processorUpdateAt === 2500 && c.episodes[0].processorAfterGateEmpty === true &&
        d.verdict === "PASS" && d.episodes[0].processorUpdateAt === null && d.episodes[0].processorAfterGateEmpty === null &&
        e.episodes[0].processorAfterGateEmpty === false && has(e.episodes[0], "processorInsideHold")
        ? null
        : JSON.stringify({ a: a.episodes[0], b: b.episodes[0], c: c.episodes[0], d: d.episodes[0], e: e.episodes[0] });
    },
  },
  {
    name: "22. F7 landedAfterClose: gate-empty close then the publish within 2000 ms → reason landedAfterClose (not landed); beyond 2000 ms → landed",
    check: () => {
      const soon = [fx.S(1000), fx.G(1200), fx.P(1500, "TR_A", "none"), fx.D(5000)];
      const late = [fx.S(1000), fx.G(1200), fx.P(3500, "TR_A", "none"), fx.D(5000)];
      const a = run(soon, dump([fx.post()]));
      const b = run(late, dump([fx.post()]));
      const ea = a.episodes[0];
      const eb = b.episodes[0];
      return a.verdict === "FAIL" && ea.landed === false && ea.landedAfterClose && ea.landedAfterClose.t === 1500 && ea.landedAfterClose.op === "none" &&
        has(ea, "landedAfterClose") && !has(ea, "landed") &&
        b.verdict === "FAIL" && eb.landedAfterClose === null && has(eb, "landed") && !has(eb, "landedAfterClose")
        ? null
        : JSON.stringify({ a: ea, b: eb });
    },
  },
  {
    name: "23. F3 subjectRx: frames with rx + trackEvents → subjectRx from the landed sid, subjectFramesOnOtherRx counted, verdict unchanged",
    check: () => {
      const trackEvents = [
        { t: 1290, trackSid: "TR_Z", participantSid: "PZ", receiverIndex: 1 },
        { t: 1300, trackSid: "TR_A", participantSid: "PA", receiverIndex: 2 },
      ];
      const f1 = { ...fx.speech(1200), rx: 2 };
      const f2 = { ...fx.speech(1210), rx: 5 };
      const a = run(BASE_TRACE(), dump([f1, f2]), { trackEvents });
      const b = run(BASE_TRACE(), dump([f1, f2]));
      const ea = a.episodes[0];
      return a.verdict === "FAIL" && ea.subjectRx === 2 && ea.subjectFramesOnOtherRx === 1 && ea.subjectFrames.n === 2 && ea.subjectFrames.list[0].rx === 2 &&
        b.episodes[0].subjectRx === null && b.episodes[0].subjectFramesOnOtherRx === null && b.verdict === "FAIL"
        ? null
        : JSON.stringify({ a: ea, b: b.episodes[0] });
    },
  },
  {
    name: "24. R1 receiver positive control: no frame on any new ssrc, but a trackEvent for the landed sid on a receiver that delivered frames → tapped (kind transformDelivers), PASS; no delivering rx / wrong sid → untapped; frames arm wins when present",
    check: () => {
      const trace = [fx.C(950), fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)];
      const evOk = [{ t: 1390, kind: "audio", trackSid: "TR_A", participantSid: "PA", receiverIndex: 1 }];
      const evWrongSid = [{ t: 1390, kind: "audio", trackSid: "TR_Z", participantSid: "PA", receiverIndex: 1 }];
      // A frame on ssrc 3 BEFORE the connect.add: not a frames-arm control
      // (first seen before S.t) and held out of the window by the lower bound.
      const rx1Frame = { ...fx.speech(920, 3), rx: 1 };
      const rx2Frame = { ...fx.speech(920, 3), rx: 2 };
      const a = run(trace, dump([rx1Frame]), { trackEvents: evOk });
      const b = run(trace, dump([rx2Frame]), { trackEvents: evOk });
      const c = run(trace, dump([rx1Frame]), { trackEvents: evWrongSid });
      const d = run(trace, dump([rx1Frame, { ...fx.post(), rx: 1 }]), { trackEvents: evOk });
      const e = run(trace, dump([rx1Frame]));
      const pa = a.episodes[0].positiveControl;
      return a.verdict === "PASS" && pa && pa.kind === "transformDelivers" && pa.receiverIndex === 1 && pa.t === 1390 && a.episodes[0].subjectFrames.n === 0 && a.episodes[0].rxFramesInWindow === 0 &&
        b.verdict === "FAIL" && has(b.episodes[0], "untapped") && b.episodes[0].positiveControl === null &&
        c.verdict === "FAIL" && has(c.episodes[0], "untapped") &&
        d.verdict === "PASS" && d.episodes[0].positiveControl.kind === "frames" && d.episodes[0].positiveControl.ssrc === 2 &&
        e.verdict === "FAIL" && has(e.episodes[0], "untapped")
        ? null
        : JSON.stringify({ a: a.episodes[0], b: b.episodes[0], c: c.episodes[0], d: d.episodes[0].positiveControl, e: e.episodes[0].reasons });
    },
  },
  {
    name: "25. R2 post-resume: grey frames at/after the landed sid's track.upstreamResumed + U are postResume (not a reason); before resume + U stay grey; no / wrong-sid / pre-end resume → nothing reclassified",
    check: () => {
      const T = (ur) => [fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), ...(ur ? [ur] : []), fx.D(5000)];
      const frames = dump([fx.post(), fx.speech(2050), fx.speech(2100)]);
      const a = run(T(fx.UR(2003)), frames);
      const b = run(T(fx.UR(2003)), frames, { resumeUncertaintyMs: 60 });
      const c = run(T(null), frames);
      const d = run(T(fx.UR(2003, "TR_Z")), frames);
      const e = run([fx.S(1000), fx.P(1300, "TR_A", "none"), fx.UR(1500), fx.G(2000), fx.D(5000)], frames);
      const ea = a.episodes[0];
      const eb = b.episodes[0];
      return a.verdict === "PASS" && ea.greyZone.n === 0 && ea.postResume.n === 2 && ea.postResume.list.length === 2 && ea.postResume.resumeAt === 2003 && ea.postResume.uncertaintyMs === 0 && ea.reasons.length === 0 && a.totals.postResumeAll === 2 &&
        b.verdict === "PASS-WITH-GREY" && eb.greyZone.n === 1 && eb.greyZone.list[0].offsetMs === 1050 && eb.postResume.n === 1 && eb.postResume.list[0].offsetMs === 1100 && has(eb, "greyZone") &&
        c.verdict === "PASS-WITH-GREY" && c.episodes[0].greyZone.n === 2 && c.episodes[0].postResume.n === 0 && c.episodes[0].postResume.resumeAt === null &&
        d.verdict === "PASS-WITH-GREY" && d.episodes[0].greyZone.n === 2 &&
        e.verdict === "PASS-WITH-GREY" && e.episodes[0].greyZone.n === 2 && e.episodes[0].postResume.resumeAt === null
        ? null
        : JSON.stringify({ a: ea, b: eb, c: c.episodes[0], d: d.episodes[0], e: e.episodes[0] });
    },
  },
  {
    name: "26. R2 uncertainty U: two valid probes → clockDriftMs; one probe → rttMs/2; none (or --tap-log) → 0 with a WARNING naming resume uncertainty",
    check: () => {
      const ok = (p, rtt) => ({ t0: 1, t1: 2, serverMs: 3, skewMs: p, rttMs: rtt });
      const a = resolveSkew({ skewFlag: null, kind: "tap", probes: [ok(12, 57), ok(15, 55)] });
      const b = resolveSkew({ skewFlag: null, kind: "tap", probes: [ok(12, 57)] });
      const c = resolveSkew({ skewFlag: 0, kind: "tap", probes: [{ error: "x" }] });
      const d = resolveSkew({ skewFlag: 0, kind: "tap-log", probes: undefined });
      return a.resumeUncertaintyMs === 3 && a.resumeUncertaintySource === "drift" &&
        b.resumeUncertaintyMs === 28.5 && b.resumeUncertaintySource === "rtt/2" && b.warnings.length === 0 &&
        c.resumeUncertaintyMs === 0 && c.resumeUncertaintySource === "unmeasured" && c.warnings.some((w) => /resume uncertainty unmeasured/.test(w)) &&
        d.resumeUncertaintyMs === 0 && d.warnings.some((w) => /resume uncertainty unmeasured/.test(w))
        ? null
        : JSON.stringify({ a, b, c, d });
    },
  },
  {
    name: "27. F2 fiducial under a held gate: a resume record with gateHeld true (or an episode not closed by gateEmpty) reclassifies nothing → grey stays grey; gateHeld false on a gateEmpty close does",
    check: () => {
      const frames = dump([fx.post(), fx.speech(2050), fx.speech(2100)]);
      const held = run([fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.UR(2003, "TR_A", true), fx.D(5000)], frames);
      const ok = run([fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.UR(2003, "TR_A", false), fx.D(5000)], frames);
      // Closed by senderCreated: the held resume-then-pause beat at end+3 must not be a fiducial.
      const sc = run([fx.S(1000), fx.P(1300, "TR_A", "none"), fx.S(2000, "TR_A"), fx.UR(2003, "TR_A", true), fx.P(2200, "TR_B", "none"), fx.G(2500), fx.D(5000)], dump([fx.post(), fx.speech(2050)]));
      // Closed by disconnect with an unheld resume after it: still not a fiducial (not a gate-empty close).
      const dc = run([fx.S(1000), fx.P(1300, "TR_A", "none"), fx.D(2000), fx.UR(2003, "TR_A", false)], dump([fx.post(), fx.speech(2050)]));
      return held.verdict === "PASS-WITH-GREY" && held.episodes[0].greyZone.n === 2 && held.episodes[0].postResume.n === 0 && held.episodes[0].postResume.resumeAt === null &&
        ok.verdict === "PASS" && ok.episodes[0].greyZone.n === 0 && ok.episodes[0].postResume.n === 2 &&
        sc.episodes[0].greyZone.n === 1 && sc.episodes[0].postResume.resumeAt === null &&
        dc.episodes[0].greyZone.n === 1 && dc.episodes[0].postResume.resumeAt === null
        ? null
        : JSON.stringify({ held: held.episodes[0], ok: ok.episodes[0], sc: sc.episodes[0], dc: dc.episodes[0] });
    },
  },
  {
    name: "28. F3/F4 receiver arm temporal check on the SUBJECT clock: trackEvent after the close → untapped; before it → transformDelivers; a skew that pushes it past end flips the answer; rxFramesInWindow counted",
    check: () => {
      const trace = [fx.C(950), fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)];
      const rx1Frame = { ...fx.speech(920, 3), rx: 1 };
      const ev = (t) => [{ t, kind: "audio", trackSid: "TR_A", participantSid: "PA", receiverIndex: 1 }];
      const late = run(trace, dump([rx1Frame]), { trackEvents: ev(2500) });
      const early = run(trace, dump([rx1Frame]), { trackEvents: ev(1390) });
      // Observer clock 1990; skew +30 → 2020 on the subject clock, past end 2000.
      const pushedOut = run(trace, dump([{ ...rx1Frame, t: 890 }]), { trackEvents: ev(1990), skewMs: 30 });
      // Observer clock 1990; skew −30 → 1960, inside; positiveControl.t is the skewed value.
      const pulledIn = run(trace, dump([{ ...rx1Frame, t: 950 }]), { trackEvents: ev(1990), skewMs: -30 });
      // A frame on that receiver inside the window is counted (and, being on a new ssrc, is a subject frame).
      const inWin = run(trace, dump([rx1Frame, { ...fx.speech(1500, 4), rx: 1 }]), { trackEvents: ev(1390) });
      return late.verdict === "FAIL" && has(late.episodes[0], "untapped") && late.episodes[0].positiveControl === null && late.episodes[0].windowCoverage.covered === "none" &&
        early.verdict === "PASS" && early.episodes[0].positiveControl.kind === "transformDelivers" && early.episodes[0].positiveControl.t === 1390 &&
        pushedOut.verdict === "FAIL" && has(pushedOut.episodes[0], "untapped") &&
        pulledIn.verdict === "PASS" && pulledIn.episodes[0].positiveControl.t === 1960 && pulledIn.episodes[0].windowCoverage.receiverAt === 1960 &&
        inWin.episodes[0].rxFramesInWindow === 1 && inWin.episodes[0].positiveControl.kind === "frames" && inWin.episodes[0].subjectFrames.n === 1
        ? null
        : JSON.stringify({ late: late.episodes[0], early: early.episodes[0], pushedOut: pushedOut.episodes[0].reasons, pulledIn: pulledIn.episodes[0].positiveControl, inWin: inWin.episodes[0] });
    },
  },
  {
    name: "29. F1 windowCoverage: none without a trackEvent before the bound; partial at −150 ms; marginal at −50 / +90 ms; late at +150 ms; offsetFromPublishMs reported",
    check: () => {
      const trace = [fx.C(950), fx.S(1000), fx.P(1300, "TR_A", "none"), fx.G(2000), fx.D(5000)];
      const rx1Frame = { ...fx.speech(920, 3), rx: 1 };
      const at = (t) => run(trace, dump([rx1Frame]), { trackEvents: [{ t, kind: "audio", trackSid: "TR_A", participantSid: "PA", receiverIndex: 1 }] }).episodes[0].windowCoverage;
      const none = run(trace, dump([rx1Frame])).episodes[0].windowCoverage;
      const partial = at(1150);
      const m1 = at(1250);
      const m2 = at(1390);
      const late = at(1450);
      return none.covered === "none" && none.receiverAt === null && none.publishedAt === 1300 && none.offsetFromPublishMs === null &&
        partial.covered === "partial" && partial.offsetFromPublishMs === -150 &&
        m1.covered === "marginal" && m1.offsetFromPublishMs === -50 &&
        m2.covered === "marginal" && m2.offsetFromPublishMs === 90 &&
        late.covered === "late" && late.offsetFromPublishMs === 150 && late.receiverAt === 1450
        ? null
        : JSON.stringify({ none, partial, m1, m2, late });
    },
  },
];

function runSelftest() {
  let failed = 0;
  for (const c of CONTROLS) {
    let detail;
    try {
      detail = c.check();
    } catch (e) {
      detail = `threw ${e && e.stack ? e.stack : e}`;
    }
    if (detail === null) {
      process.stdout.write(`PASS  ${c.name}\n`);
    } else {
      failed++;
      process.stdout.write(`FAIL  ${c.name}\n      ${detail}\n`);
    }
  }
  process.stdout.write(`selftest: ${CONTROLS.length - failed}/${CONTROLS.length} controls behaved\n`);
  process.exit(failed === 0 ? 0 : 1);
}

// --------------------------------------------------------------------------
// main
// --------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) return runSelftest();
  let report;
  try {
    const records = parseTraceText(readText(args.trace, "trace"), `trace ${args.trace}`);
    const kind = args.tap ? "tap" : "tap-log";
    const { obj, frames } = loadDump(args.tap || args.tapLog, kind);
    let tapInfo = { receiversTapped: null, trackEvents: null };
    if (kind === "tap") tapInfo = checkTapStats(obj.stats, `tap ${args.tap}`);
    const skew = resolveSkew({ skewFlag: args.skewMs, kind, probes: kind === "tap" ? obj.clockProbes : undefined });
    const core = reduce(records, frames, {
      carrier: args.carrier,
      skewMs: skew.skewMs,
      endMarginMs: args.endMarginMs,
      requireProcessorAfterEmpty: args.requireProcessorAfterEmpty,
      trackEvents: tapInfo.trackEvents,
      resumeUncertaintyMs: skew.resumeUncertaintyMs,
    });
    report = {
      ...core,
      skewSource: skew.skewSource,
      clockProbes: skew.clockProbes,
      clockDriftMs: skew.clockDriftMs,
      resumeUncertaintyMs: skew.resumeUncertaintyMs,
      resumeUncertaintySource: skew.resumeUncertaintySource,
      receiversTapped: tapInfo.receiversTapped,
      // F4: every trackEvent time also on the subject clock.
      trackEvents: tapInfo.trackEvents
        ? tapInfo.trackEvents.map((e) => ({ ...e, tSubject: e && Number.isFinite(e.t) ? e.t + skew.skewMs : null }))
        : null,
      warnings: skew.warnings,
    };
  } catch (e) {
    if (e instanceof InputError) die(3, e.message);
    die(3, `internal error, no report: ${e && e.stack ? e.stack : e}`);
  }
  for (const w of report.warnings) process.stderr.write(`toc-reduce: WARNING: ${w}\n`);
  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else printHuman(report);
  process.exit(report.verdict === "PASS" ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
