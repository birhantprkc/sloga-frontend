#!/bin/bash
# selftest.sh — the known-bad-control harness for lane W0-C's leg tools.
#
#   packages/client/scripts/leg/selftest.sh [workdir]
#
# 🔴 THE CONTROL COMES FIRST. Every check below is run against a deliberately
# corrupted, truncated, dead-carrier or WRONG-WINDOW input BEFORE it is trusted
# on a good one. A check that has never failed is not evidence.
#
# 🔴 AND THE FIXTURES ARE NOT TYPED BY HAND. selftest-sampler.mjs EXTRACTS the
# `at` literals and payload key sets from `components/rtc/state.tsx` and
# `components/rtc/mlsCallSession.ts` and generates every trace fixture from
# them, checking BOTH directions (the reducer may not read a key no emitter
# emits; an emitter may not emit a key the reducer does not know). Wave 0's
# harness proved the reducer against a re-typed copy of the needle: its
# fixtures used `size` / `censusSize` / `publications:[{...}]` while the
# emitters emitted `gateSize` / `publicationCount` / `publications:["..."]`,
# and decision-table case G2 passed on a capture that could not occur.
#
# It judges each case on the tool's EXIT STATUS and on a required substring of
# its OUTPUT, never on a grep of a summary line, and never through a pipe (a
# `cmd | tail` makes $? tail's, and `set -o pipefail` plus `grep -q` inverts an
# assertion so that it fails BECAUSE it matched). Output is captured to a file
# first; the status is captured immediately; only then is the output read.
#
# Exit status: the number of failing controls. 0 means every known-bad input
# was rejected AND every good input was accepted.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${1:-${TMPDIR:-/tmp}/w0c_selftest.$$}"
mkdir -p "$WORK" || exit 99
REDUCE="$HERE/gate-trace-reduce.mjs"
fails=0

note_fail() {
  echo ">>> CONTROL FAIL: $*"
  fails=$((fails + 1))
}

# case <name> <expected-exit> <expected-substring|-> -- <cmd...>
case_run() {
  local name="$1" want="$2" needle="$3"
  shift 4 # name, want, needle, "--"
  local out="$WORK/$(echo "$name" | tr -c 'A-Za-z0-9' '_').out"
  "$@" >"$out" 2>&1
  local rc=$?
  local verdict="ok"
  if [ "$rc" -ne "$want" ]; then
    verdict="bad"
    note_fail "$name: exit $rc, expected $want"
  fi
  if [ "$needle" != "-" ] && ! grep -qF -- "$needle" "$out"; then
    verdict="bad"
    note_fail "$name: output does not contain $needle (see $out)"
  fi
  if [ "$verdict" = "ok" ]; then
    echo "  CONTROL PASS  $name (exit $rc)"
  else
    echo "  ---- captured output of $name ----"
    sed -n '1,60p' "$out"
    echo "  ----------------------------------"
  fi
}

# differs <control> <good>
differs() {
  if [ ! -f "$WORK/$1" ]; then
    note_fail "fixture $1 was not produced"
    return
  fi
  if cmp -s "$WORK/$1" "$WORK/$2"; then
    note_fail "$1 is BYTE-IDENTICAL to $2 — it is not a control"
  else
    echo "  CONTROL PASS  $1 differs from $2"
  fi
}

echo "############ W0-C self-test — workdir $WORK ############"
echo
echo "=== stage 1: sampler refusals, the EMITTER<->REDUCER key contract, and fixture generation ==="
node "$HERE/selftest-sampler.mjs" "$WORK"
rc=$?
if [ $rc -ne 0 ]; then
  note_fail "selftest-sampler.mjs exited $rc — a sampler refusal, an emitter-contract direction, or a fixture generation did not hold"
fi
echo

echo "=== stage 2: prove each control DIFFERS from the good input ==="
for f in sampler-truncated.json sampler-empty.json sampler-wrongschema.json sampler-zeroticks.json \
  sampler-deadcarrier.json sampler-bytesonly.json sampler-plaintextcall1.json sampler-lingering.json \
  sampler-boundary.json sampler-uncorrelated.json; do
  differs "$f" "sampler-plaintext.json"
done
for f in trace-c0-staledrop.log trace-c0-negated.log trace-c0-emptymap.log trace-c3.log \
  trace-c6.log trace-c6-negated.log trace-c4.log trace-c4-negated.log trace-c4-farresumed.log \
  trace-c4-noroom.log trace-h1-stale-resume.log trace-h2-abandoned.log trace-unaligned.log \
  trace-c1.log trace-c1-negated.log trace-c1-staleleave.log trace-mixed.log \
  trace-m4-twoseq.log trace-objectobject.log trace-truncated.log; do
  differs "$f" "trace-c0.log"
done
echo

echo "=== stage 3: the reducer must REJECT known-bad inputs ==="

case_run "R1 empty sampler file" 3 "is EMPTY" -- \
  node "$REDUCE" --sampler "$WORK/sampler-empty.json" --shape b --consent yes

case_run "R2 truncated sampler JSON" 3 "not valid JSON" -- \
  node "$REDUCE" --sampler "$WORK/sampler-truncated.json" --shape b --consent yes

case_run "R3 wrong sampler schema" 3 "expected sloga-leg-sampler/1" -- \
  node "$REDUCE" --sampler "$WORK/sampler-wrongschema.json" --shape b --consent yes

case_run "R4 zero ticks" 3 "ZERO ticks" -- \
  node "$REDUCE" --sampler "$WORK/sampler-zeroticks.json" --shape b --consent yes

case_run "R5 missing sampler file" 3 "cannot read sampler dump" -- \
  node "$REDUCE" --sampler "$WORK/does-not-exist.json" --shape b --consent yes

case_run "R6 no --shape" 3 "--shape a|b is required" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --consent yes

case_run "R6b no --consent: polarity is a required OUTPUT, so a run must name its arm" 3 "--consent yes|no is required" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b

case_run "R7 shape declared b, reduced as a" 3 "refusing to reduce a run under the wrong shape" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape a --consent yes

case_run "R8 empty log file" 3 "refusing to report" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --log /dev/null

echo
echo "=== stage 4: a DEAD CARRIER is discarded, not interpreted ==="
case_run "R9 dead carrier => exit 4, DISCARDED" 4 "DISCARDED          : YES" -- \
  node "$REDUCE" --sampler "$WORK/sampler-deadcarrier.json" --shape b --consent yes --audible-subject yes
case_run "R9b dead carrier selects NO row even with the operator saying 'audible'" 4 "selects no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-deadcarrier.json" --shape b --consent yes --audible-subject yes

echo
echo "=== stage 5: bytes ALONE can never establish plaintext ==="
case_run "R10 bytes flowing, energy fields missing => M1 unknown" 0 "M1 (plaintext?)   : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --consent no --audible-subject unknown
case_run "R10b the same run under --require-verdict => exit 5" 5 "-" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --consent no --audible-subject unknown --require-verdict
case_run "R10c a missing field is reported as missing, not as flat" 0 "A missing field is not flatness" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --consent no --audible-subject unknown

echo
echo "=== stage 6: ciphertext needs a SAME-TICK POSITIVE CONTROL ==="
case_run "R11 flat energy + climbing concealment + rising carrier => ciphertext" 0 "M1 (plaintext?)   : ciphertext" -- \
  node "$REDUCE" --sampler "$WORK/sampler-ciphertext.json" --shape b --consent no --audible-subject no
case_run "R11b the SAME shape with a FLAT carrier (no positive control) => unknown" 0 "M1 (plaintext?)   : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-nocontrol.json" --shape b --consent no --audible-subject no

echo
echo "=== stage 7: shape (a) can never select a row ==="
case_run "R12 shape (a) => M1 unknown" 0 "M1 (plaintext?)   : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-shapea.json" --shape a --consent yes --audible-subject yes
case_run "R12b shape (a) => no row" 0 "never SELECT one" -- \
  node "$REDUCE" --sampler "$WORK/sampler-shapea.json" --shape a --consent yes --audible-subject yes

echo
echo "=== stage 8: a degraded / truncated [gate-trace] log yields unknown, not a guess ==="
case_run "R13 [object Object] payloads => M2 unknown" 0 "M2 (real leave?)  : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-objectobject.log"
case_run "R13b and the degradation is REPORTED, not silent" 0 "an object ARGUMENT reached Chromium's log serializer" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-objectobject.log"
case_run "R13c a degraded log selects NO row" 0 "no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-objectobject.log"
case_run "R14 a truncated log line is reported as unrecoverable" 0 "DEGRADED [gate-trace] lines" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-truncated.log"
case_run "R15 a log with no records at all still yields no M2 guess" 0 "M2 (real leave?)  : unknown" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-empty-of-records.log"

echo
echo "=== stage 8b: fiducial disagreement discards the run (H1) ==="
case_run "R16 fiducials disagree beyond one sampling interval => exit 4" 4 "unaligned" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-unaligned.log"
case_run "R16b an UNVERIFIED alignment is NOT treated as unaligned" 0 "UNVERIFIED" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-empty-of-records.log"
# 🔴 H1's control. The SAME unaligned run, plus ONE non-qualifying resumeGate
# sitting exactly on the ssrc change: a release of "mixed" that did not empty
# the set, on a stale room. Wave 0 took ANY `at === "resumeGate"`, so that one
# stale record rescued a genuinely unaligned run (measured: unaligned ->
# aligned). It must STILL be discarded.
case_run "H1 a stale/non-emptying resumeGate may NOT rescue an unaligned run" 4 "unaligned" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-h1-stale-resume.log"
case_run "H1b and the rejected fiducial candidates are REPORTED with the reason" 4 "staleRoom=true" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-h1-stale-resume.log"

echo
echo "=== stage 9: the GOOD inputs must now be ACCEPTED (otherwise the checks above are vacuous) ==="
case_run "G1 plaintext + C0 trace => plaintext" 0 "M1 (plaintext?)   : plaintext" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G2 plaintext + C0 trace => C0 selected, on the REAL emitted key names" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G2b B5: the C0 pair is read from TWO seams and its ABSENT half is POSITIVE evidence, with its class named" 0 "C0 absent half (localSenderCreated): ESTABLISHED [absent-from-populated-map]" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G2c and the PRESENT half is read from the mute seam that NAMES the leaking publication" 0 "C0 present half (localTrackPublished.entry): subjectSidInPublications = true" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G3 M2 positively witnessed as a real (via=user) disconnect" 0 "M2 (real leave?)  : disconnect-ran" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "G4 in-place arm + empty set => C1 selected" 0 "DECISION (§2.5)   : C1" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1.log"
case_run "G5 B6: a via=\"connect-leading\" pre-clear is NOT a leave" 0 "M2 (real leave?)  : no-disconnect" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1.log"
case_run "G5b and it is COUNTED and named, not silently dropped" 0 'via="connect-leading" (fires on EVERY rejoin press and is NOT evidence of a leave)' -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1.log"
case_run "G6 --out writes a report" 0 "-" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log" --out "$WORK/report-consent-c0.json"
if [ ! -s "$WORK/report-consent-c0.json" ]; then
  note_fail "G6 --out produced a MISSING or ZERO-BYTE report"
else
  node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$WORK/report-consent-c0.json"
  rc=$?
  if [ $rc -ne 0 ]; then
    note_fail "G6 --out produced a report that is not valid JSON (exit $rc)"
  else
    echo "  CONTROL PASS  G6 --out wrote $(wc -c <"$WORK/report-consent-c0.json") bytes of valid JSON"
  fi
fi

# The payload coverage table is the one output that says which fields were
# UNREADABLE, and the decision's windowRow is what --aggregate consumes.
node -e '
const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const cov = r.coverage;
if (!cov || Object.keys(cov).length === 0) { console.error("coverage table is EMPTY in the JSON report"); process.exit(1); }
for (const [k, v] of Object.entries(cov)) {
  if (typeof v.found !== "number" || typeof v.missing !== "number") { console.error("coverage." + k + " is malformed: " + JSON.stringify(v)); process.exit(1); }
}
if (r.decision.windowRow !== "C0") { console.error("decision.windowRow is " + r.decision.windowRow + ", expected C0"); process.exit(1); }
if (r.inputs.consent !== "yes") { console.error("the report does not carry its consent arm"); process.exit(1); }
console.log("  coverage keys in the JSON report: " + Object.keys(cov).length + ", windowRow=" + r.decision.windowRow + ", consent=" + r.inputs.consent);
' "$WORK/report-consent-c0.json"
rc=$?
if [ $rc -ne 0 ]; then
  note_fail "G7 the JSON report lost its coverage table, its windowRow or its consent arm (exit $rc)"
else
  echo "  CONTROL PASS  G7 the JSON report carries the coverage table, the windowRow and the consent arm"
fi

echo
echo "=== stage 9b: B3 — a STALE, GUARD-DISCARDED drop from another drive may not select C3 ==="
# 🔴 Measured on wave 0's reducer: adding ONE drop 5 s earlier with
# stillCurrent:false and sweeperGen:3 against gateGen:4 flipped the whole run
# from `no row` to C3. `measureM3` filtered sweeper.dropped over the ENTIRE
# capture with no time bound and no guard filter, and `selectRow` tested
# `dropped` FIRST for every publication.
case_run "B3 a stale, guard-discarded drop does NOT change the row" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0-staledrop.log"
case_run "B3b and the discarded drop is REPORTED with its reason" 0 "DISCARDED drop" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0-staledrop.log"
case_run "B3c a drop that LANDED in the leak's own drive, same generation, DOES select C3" 0 "DECISION (§2.5)   : C3" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c3.log"

echo
echo "=== stage 9c: B4 — the leak instant is pinned to the SSRC-change fiducial, not flow[0] ==="
# 🔴 §2.4 has the operator speaking BEFORE the rejoin and the sampler started
# BEFORE joining, so the first flow window in the capture is CALL 1. Wave 0
# read `flow[0].from` as the leak instant.
case_run "B4 a capture with a CALL-1 flow window still selects C0 at the rejoin" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintextcall1.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.call1.log"
case_run "B4b and the call-1 window is REPORTED as rejected, not silently skipped" 0 "REJECTED as pre-fiducial (call 1)" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintextcall1.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.call1.log"
# The same capture and the same log, with the leak instant forced back to
# flow[0] — wave 0's behaviour. It must NOT reach C0.
case_run "B4c forcing the leak instant onto the CALL-1 window selects NO row" 0 "DECISION (§2.5)   : no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintextcall1.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.call1.log" --leak-after 0

echo
echo "=== stage 9d: H2 — records from an ABANDONED Room may not reach a verdict ==="
case_run "H2 currentRoom=false records select NO row" 0 "DECISION (§2.5)   : no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-h2-abandoned.log"
case_run "H2b and the exclusion is COUNTED in the report" 0 "ABANDONED-ROOM records EXCLUDED (currentRoom === false): 3" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-h2-abandoned.log"

echo
echo "=== stage 9e: H3 — C4's 'immediately before the mute' is a BOUNDED window ==="
case_run "H3 an UpstreamResumed inside the window selects C4" 0 "DECISION (§2.5)   : C4" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c4.log"
case_run "H3b the SAME run with the resume 30 s earlier does NOT select C4" 0 "Do NOT default to C4" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c4-farresumed.log"
case_run "H3c and the window actually used is PRINTED" 0 "ms window before the mute)" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c4.log"
case_run "H3d C6 is still reachable (the C4 bound did not swallow it)" 0 "DECISION (§2.5)   : C6" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c6.log"

echo
echo "=== stage 9f: M4 — one re-establish counts ONCE, two count TWICE ==="
case_run "M4 the two rejoinFresh records of ONE #rejoinFresh share a seq" 0 "rejoinFresh records 2 => 1 distinct seq" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1.log"
case_run "M4b TWO genuine re-establishes are NOT collapsed into one" 0 "rejoinFresh records 2 => 2 distinct seq" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-m4-twoseq.log"

echo
echo "=== stage 9g: L1 — a LOSSY CDP preview is PRINTED, not left as an unexplained gap ==="
case_run "L1 the lossy-preview count reaches the human report" 0 "CDP LOSSY-PREVIEW records (V8's 5-property cap truncated them) : 1" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-cdp-lossy.jsonl"
case_run "L1b a clean capture reports ZERO of them (the counter is not a constant)" 0 "CDP LOSSY-PREVIEW records (V8's 5-property cap truncated them) : 0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"

echo
echo "=== stage 9h: M1 — §2.5's H3 POLARITY rule across the two arms ==="
node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --consent no --audible-subject unknown \
  --log "$WORK/trace-c0.bytesonly.log" --out "$WORK/report-noconsent-c0.json" --quiet
rc=$?
[ $rc -eq 0 ] || note_fail "could not produce the no-consent C0-window report (exit $rc)"
node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --consent no --audible-subject unknown \
  --log "$WORK/trace-c1.bytesonly.log" --out "$WORK/report-noconsent-c1.json" --quiet
rc=$?
[ $rc -eq 0 ] || note_fail "could not produce the no-consent C1-window report (exit $rc)"

# 🔴 The SAME row fires in both arms while the leak appears only in the consent
# arm. That is the INCOMPLETE outcome, and it exits 6 so no script can read it
# as done.
case_run "M1 same row in BOTH arms, leak only in the consent arm => POLARITY UNEXPLAINED" 6 "C0 confirmed as the WINDOW — POLARITY UNEXPLAINED" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-c0.json"
case_run "M1b and it says §4.1 stays OPEN and the banked entry is untouched" 6 "the banked 2/2-vs-0/2 entry stands untouched" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-c0.json"
case_run "M1c a row that fires ONLY in the consent arm is a COMPLETE confirmation" 0 "POLARITY OUTCOME  : C0 confirmed" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-c1.json"
case_run "M1d a series with no usable CONSENT run selects NOTHING" 7 "POLARITY OUTCOME  : NOTHING SELECTED" -- \
  node "$REDUCE" --aggregate "$WORK/report-noconsent-c0.json"
node -e '
const fs=require("fs");
const r=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
delete r.inputs.consent;
fs.writeFileSync(process.argv[2], JSON.stringify(r));
' "$WORK/report-consent-c0.json" "$WORK/report-noarm.json"
rc=$?
[ $rc -eq 0 ] || note_fail "could not build the no-arm control (exit $rc)"
case_run "M1e a report that does not name its arm is REFUSED, not defaulted" 3 "does not name its consent arm" -- \
  node "$REDUCE" --aggregate "$WORK/report-noarm.json"

# 🔴 B2 — THE MIRROR GUARD. `runAggregate` guarded `usable("yes").length === 0`
# and had NO guard for the no-consent arm, so an aggregate with the no-consent
# arm ABSENT, DISCARDED or shape (a) printed "the row accounts for the polarity
# as well as the window" and exited 0. Measured all three ways.
case_run "B2 an aggregate with NO no-consent arm at all is POLARITY UNMEASURED, not a confirmation" 7 "the no-consent arm contributed 0 usable runs, so polarity is UNMEASURED" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json"
node -e '
const fs = require("fs");
const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
r.discarded = true;
fs.writeFileSync(process.argv[2], JSON.stringify(r));
const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
s.inputs.shape = "a";
fs.writeFileSync(process.argv[3], JSON.stringify(s));
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
m.decision.windowRow = "MIXED";
fs.writeFileSync(process.argv[4], JSON.stringify(m));
' "$WORK/report-noconsent-c1.json" "$WORK/report-noconsent-discarded.json" "$WORK/report-noconsent-shapea.json" "$WORK/report-noconsent-mixed.json"
rc=$?
[ $rc -eq 0 ] || note_fail "could not build the no-consent arm controls (exit $rc)"
for f in report-noconsent-discarded.json report-noconsent-shapea.json report-noconsent-mixed.json; do
  if [ ! -s "$WORK/$f" ]; then note_fail "the control $f was not produced"; fi
  if cmp -s "$WORK/$f" "$WORK/report-noconsent-c1.json"; then note_fail "$f is BYTE-IDENTICAL to the report it was derived from"; else echo "  CONTROL PASS  $f differs from report-noconsent-c1.json"; fi
done
case_run "B2b a DISCARDED no-consent arm is POLARITY UNMEASURED" 7 "the no-consent arm contributed 0 usable runs, so polarity is UNMEASURED" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-discarded.json"
case_run "B2c a shape-(a) no-consent arm is POLARITY UNMEASURED (§2.5 is evaluated on shape b)" 7 "the no-consent arm contributed 0 usable runs, so polarity is UNMEASURED" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-shapea.json"
case_run "B2d a MIXED no-consent run is NOT evidence that the row did not fire there" 6 "MIXED run(s)" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-mixed.json"
case_run "B2e the minimum run count is ENFORCED and stated (§2.4 specifies five per arm)" 7 "polarity is UNMEASURED" -- \
  node "$REDUCE" --min-arm-runs 5 --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-c1.json"
case_run "B2f and the run that DOES have both arms still confirms, naming the arm sizes it compared" 0 "arms compared: 1 usable consent run(s) vs 1 usable no-consent run(s)" -- \
  node "$REDUCE" --aggregate "$WORK/report-consent-c0.json" "$WORK/report-noconsent-c1.json"

echo
echo "=== stage 9i: B1 — C0 needs POSITIVE evidence of an absence, never an unassigned sid ==="
# 🔴 MEASURED on wave 0b's reducer: `subjectSidPresent` at localSenderCreated is
# `false` BY CONSTRUCTION (the emit precedes `track.sid = ti.sid` and, on a
# republish, `unpublishTrack` deleted the map entry), so setting ONLY that field
# to its reachable value flipped the C6 and C4 fixtures to C0 — and because
# §2.5 is first-match-wins, C6 and C4 were unreachable.
case_run "B1 an ASSIGNED (stale) sid absent from a POPULATED map selects C0" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "B1b the same absence over an EMPTY map still selects C0, but is REPORTED as the weaker class" 0 "ESTABLISHED [absent-with-stale-sid]" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0-emptymap.log"
case_run "B1c an UNASSIGNED sid (a first publish) does NOT select C0" 0 "DECISION (§2.5)   : no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0-negated.log"
case_run "B1d and it says WHY, naming the sid-not-yet-assigned case" 0 "NOT evidence of an absence" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0-negated.log"

echo
echo "=== stage 9j: the §2.5 ROW MATRIX — every row reachable, every discriminator load-bearing ==="
# Data-driven from row-matrix.json, which selftest-sampler.mjs writes from the
# fixtures it generated: a row cannot go untested by simply not being listed
# here, because the generator asserts the matrix is complete.
matrix_rows=0
ROWS_TXT="$WORK/row-matrix.txt"
node -e '
const fs = require("fs");
const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const lines = Object.entries(m).map(([r, v]) => r + " " + v.positive + " " + v.negated);
fs.writeFileSync(process.argv[2], lines.join("\n") + "\n");
' "$WORK/row-matrix.json" "$ROWS_TXT"
rc=$?
[ $rc -eq 0 ] || note_fail "could not read the row matrix (exit $rc)"
while read -r row pos neg; do
  [ -n "$row" ] || continue
  matrix_rows=$((matrix_rows + 1))
  case_run "MX $row is SELECTED by its positive fixture" 0 "DECISION (§2.5)   : $row" -- \
    node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
    --log "$WORK/$pos"
  out="$WORK/mx_${row}_negated.out"
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
    --log "$WORK/$neg" >"$out" 2>&1
  rc=$?
  dec=$(sed -n 's/^DECISION (§2.5)   : //p' "$out" | head -1)
  if [ $rc -ne 0 ]; then
    note_fail "MX $row negated: the reducer exited $rc on $neg"
  elif [ "$dec" = "$row" ]; then
    note_fail "MX $row negated ($neg) STILL selected $row — its discriminator does not discriminate"
  else
    echo "  CONTROL PASS  MX $row negated ($neg) selects '$dec', not $row"
  fi
done <"$ROWS_TXT"
if [ "$matrix_rows" -lt 5 ]; then
  note_fail "the row matrix covered only $matrix_rows row(s); C0/C1/C3/C4/C6 must all be covered"
else
  echo "  CONTROL PASS  MX the matrix covered $matrix_rows rows, positive AND negated"
fi

echo
echo "=== stage 9k: B4 — C4 must MATCH the publication under test ==="
# 🔴 MEASURED: `evaluateWindow` tested `m3.upstreamResumed.length > 0` — every
# resume in the window, for ANY track — so retargeting the fixture's resume to
# screen_share/TR_TOTALLY_OTHER still read C4.
case_run "B4S a resume naming ANOTHER track does not select C4" 0 "DECISION (§2.5)   : no row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c4-negated.log"
case_run "B4Sb and it says which subjects it saw instead" 0 "NONE names" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c4-negated.log"
case_run "B4Sc a resume that cannot be attributed to the live Room may not select a row" 0 "may not select a row" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c4-noroom.log"
case_run "B4Sd MIXED is still reachable when the sampler could not correlate a trackSid" 0 "DECISION (§2.5)   : MIXED" -- \
  node "$REDUCE" --sampler "$WORK/sampler-uncorrelated.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-mixed.log"
case_run "B4Se and the uncorrelated capture SAYS it could not correlate" 0 "trackSid=UNCORRELATED" -- \
  node "$REDUCE" --sampler "$WORK/sampler-uncorrelated.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-mixed.log"

echo
echo "=== stage 9l: B5 — M2 is scoped to THIS leg's transition ==="
# 🔴 MEASURED on wave 0b's reducer, which filtered disconnect.preclear over the
# WHOLE capture: injecting one via:"user" record 60 s before the window flipped
# `M2: no-disconnect / DECISION: C1` to `M2: both / DECISION: no row`.
case_run "B5 a via=user teardown 60 s before the fiducial does NOT flip the in-place arm" 0 "M2 (real leave?)  : no-disconnect" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1-staleleave.log"
case_run "B5b and the row stays C1" 0 "DECISION (§2.5)   : C1" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1-staleleave.log"
case_run "B5c and the exclusion is REPORTED with its reason, not silent" 0 "outside this leg's transition window" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1-staleleave.log"
case_run "B5d a via=user teardown INSIDE the transition DOES witness a leave (the scope is not just 'ignore everything')" 0 "M2 (real leave?)  : both" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c1-negated.log"
case_run "B5e the disconnect.entry seam is CONSUMED, so a teardown that throws is still witnessed" 0 "disconnect.entry seam present" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "B5f the entry/preclear pair of ONE teardown counts as ONE leave" 0 "=> 1 distinct via=\"user\" leave(s)" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"

echo
echo "=== stage 9m: the leak window is on the FRESH ssrc, at or after the fiducial ==="
# 🔴 The deleted tolerance only ever widened acceptance BACKWARDS; this capture
# has a call-1 window opening INSIDE it, and a lingering old inbound-rtp row.
case_run "W1 a call-1 window INSIDE the deleted tolerance is still rejected" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-boundary.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "W1b and it is REPORTED as rejected, not silently skipped" 0 "REJECTED as pre-fiducial" -- \
  node "$REDUCE" --sampler "$WORK/sampler-boundary.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.log"
case_run "W2 a LINGERING old inbound-rtp row does not move the fiducial or the window" 0 "DECISION (§2.5)   : C0" -- \
  node "$REDUCE" --sampler "$WORK/sampler-lingering.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.lingering.log"
case_run "W2b and the run still reads ALIGNED for the right reason" 0 "aligned — fiducials agree" -- \
  node "$REDUCE" --sampler "$WORK/sampler-lingering.json" --shape b --consent yes --audible-subject yes \
  --log "$WORK/trace-c0.lingering.log"

echo
echo "=== stage 9n: the capture NAMES ITS ARM, and the cross-check bites ==="
# 🔴 The dump carried no `consent`, so the reducer's cross-check was dead code
# and the H3 polarity rule rested on a CLI flag alone.
case_run "P1 a consent=yes capture reduced with --consent no is REFUSED" 3 "refusing to file a run into the wrong arm" -- \
  node "$REDUCE" --sampler "$WORK/sampler-plaintext.json" --shape b --consent no --audible-subject yes
case_run "P1b and a no-consent capture reduced as consent=yes is refused too" 3 "refusing to file a run into the wrong arm" -- \
  node "$REDUCE" --sampler "$WORK/sampler-bytesonly.json" --shape b --consent yes --audible-subject unknown

echo
echo "=== stage 10: the launcher must FAIL LOUDLY on a broken rig ==="
FAKESHELL="$WORK/fakeshell"
mkdir -p "$FAKESHELL"
case_run "L1r nonexistent shell worktree => exit 1" 1 "does not exist" -- \
  env SLOGA_SHELL_DIR="$WORK/no-such-dir" SLOGA_APPIMAGE="$WORK/no-such.AppImage" \
  bash "$HERE/launch-seats.sh" check
case_run "L2 shell dir with no BUILD_INFO / no AppImage => exit 1" 1 "frontend-dist provenance is unknown" -- \
  env SLOGA_SHELL_DIR="$FAKESHELL" SLOGA_APPIMAGE="$FAKESHELL/nope.AppImage" \
  bash "$HERE/launch-seats.sh" check
case_run "L3 an unpackaged seat with NO --profile is refused" 1 "--profile is REQUIRED" -- \
  bash "$HERE/launch-seats.sh" carrier --dry-run
case_run "L4 steps names the native confirm dialog as operator-only" 0 "Turn off encryption" -- \
  bash "$HERE/launch-seats.sh" steps
case_run "L5 steps never asks anyone to hand credentials to a script" 0 "All credential entry" -- \
  bash "$HERE/launch-seats.sh" steps
case_run "L6 steps carries the polarity step and says it is not optional" 0 "Step 9 is not optional" -- \
  bash "$HERE/launch-seats.sh" steps
case_run "L6b steps tells the operator to record the ARM on the capture itself" 0 'consent: "yes"|"no"' -- \
  bash "$HERE/launch-seats.sh" steps
case_run "L6c steps runs the aggregate with an enforced per-arm minimum" 0 "--min-arm-runs 5 --aggregate" -- \
  bash "$HERE/launch-seats.sh" steps

# 🔴 B7 — the frontend pin. It defaulted to a LITERAL commit that predates the
# instrumentation, so `check_frontend_dist` and `check_bundle_serialization`
# were guaranteed to disagree: before the mandatory re-stage the first passed
# and the second failed; after it they INVERT. `check` could then never exit 0
# and `require_ok` refuses every seat, so the leg was unrunnable either way.
PINSHELL="$WORK/pinshell"
mkdir -p "$PINSHELL/frontend-dist/assets" "$PINSHELL/src"
printf 'frontend_commit=1111111111111111111111111111111111111111
dirty=false
shell_commit=fc4855e4c1b544b8bbaef6fe39317b127a1c95a4
shell_dirty=false
' >"$PINSHELL/frontend-dist/BUILD_INFO.txt"
printf 'x=1;console.error("[gate-trace] "+JSON.stringify({a:1}));
' >"$PINSHELL/frontend-dist/assets/index-abc.js"
case_run "L7 a dist staged from ANOTHER commit is refused, and the message names BOTH halves of the pair" 1 "THIS IS ONE HALF OF A PAIR" -- \
  env SLOGA_SHELL_DIR="$PINSHELL" SLOGA_APPIMAGE="$PINSHELL/nope.AppImage" \
  bash "$HERE/launch-seats.sh" check
case_run "L7b the pin is EXPLICITLY settable, and then that half passes" 1 "ok: frontend-dist staged from 1111111111111111111111111111111111111111" -- \
  env SLOGA_SHELL_DIR="$PINSHELL" SLOGA_APPIMAGE="$PINSHELL/nope.AppImage" \
  SLOGA_EXPECT_FRONTEND_COMMIT=1111111111111111111111111111111111111111 \
  bash "$HERE/launch-seats.sh" check
case_run "L7c and it says WHERE the expected commit came from" 1 "from SLOGA_EXPECT_FRONTEND_COMMIT" -- \
  env SLOGA_SHELL_DIR="$PINSHELL" SLOGA_APPIMAGE="$PINSHELL/nope.AppImage" \
  SLOGA_EXPECT_FRONTEND_COMMIT=1111111111111111111111111111111111111111 \
  bash "$HERE/launch-seats.sh" check

# 🔴 `shell_dirty` was read by NOBODY: the packaged seat's own provenance went
# unchecked while the dist's was gated.
DIRTYSHELL="$WORK/dirtyshell"
mkdir -p "$DIRTYSHELL/frontend-dist/assets"
printf 'frontend_commit=1111111111111111111111111111111111111111
dirty=false
shell_commit=fc4855e4c1b544b8bbaef6fe39317b127a1c95a4
shell_dirty=true
' >"$DIRTYSHELL/frontend-dist/BUILD_INFO.txt"
printf 'x=1;console.error("[gate-trace] "+JSON.stringify({a:1}));
' >"$DIRTYSHELL/frontend-dist/assets/index-abc.js"
if cmp -s "$DIRTYSHELL/frontend-dist/BUILD_INFO.txt" "$PINSHELL/frontend-dist/BUILD_INFO.txt"; then
  note_fail "the dirty-shell control is BYTE-IDENTICAL to the clean-shell one"
else
  echo "  CONTROL PASS  the dirty-shell BUILD_INFO differs from the clean-shell one"
fi
case_run "L8 a packaged seat built from a DIRTY shell tree is refused by default" 1 "built from a DIRTY shell tree" -- \
  env SLOGA_SHELL_DIR="$DIRTYSHELL" SLOGA_APPIMAGE="$DIRTYSHELL/nope.AppImage" \
  SLOGA_EXPECT_FRONTEND_COMMIT=1111111111111111111111111111111111111111 \
  bash "$HERE/launch-seats.sh" check
case_run "L8b it can be accepted DELIBERATELY, and then every result says the provenance is unproven" 1 "ACCEPTED because SLOGA_ALLOW_DIRTY_SHELL=1" -- \
  env SLOGA_SHELL_DIR="$DIRTYSHELL" SLOGA_APPIMAGE="$DIRTYSHELL/nope.AppImage" \
  SLOGA_EXPECT_FRONTEND_COMMIT=1111111111111111111111111111111111111111 \
  SLOGA_ALLOW_DIRTY_SHELL=1 \
  bash "$HERE/launch-seats.sh" check
case_run "L8c and a clean shell tree passes that check" 1 "ok: packaged seat built from a clean shell tree" -- \
  env SLOGA_SHELL_DIR="$PINSHELL" SLOGA_APPIMAGE="$PINSHELL/nope.AppImage" \
  SLOGA_EXPECT_FRONTEND_COMMIT=1111111111111111111111111111111111111111 \
  bash "$HERE/launch-seats.sh" check

# 🔴 THE DEFAULT PIN ITSELF. Every case above passes an explicit override, so
# none of them would notice the pin going back to a FROZEN LITERAL — which is
# the defect: a literal that predates the instrumentation can never agree with
# the bundle check, and `check` then cannot exit 0 at all.
PIN_FRONTEND_DIR="${SLOGA_FRONTEND_DIR:-$(cd "$HERE/../.." && pwd)}"
head_sha=$(git -C "$PIN_FRONTEND_DIR" rev-parse HEAD 2>/dev/null)
if [ -z "$head_sha" ]; then
  note_fail "could not read the frontend worktree HEAD ($PIN_FRONTEND_DIR) — the derived-pin control cannot run, and it is not skipped silently"
else
  case_run "L9 with no override, the expected frontend commit IS this worktree's HEAD (not a frozen literal)" 1 "expecting frontend commit $head_sha (from the worktree HEAD" -- \
    env SLOGA_SHELL_DIR="$PINSHELL" SLOGA_APPIMAGE="$PINSHELL/nope.AppImage" \
    bash "$HERE/launch-seats.sh" check
fi

echo
echo "=== stage 11: B7 — the console-forwarding / serialization PRE-FLIGHT ==="
# 🔴 Wave 0's cmd_check had NO such pre-flight at all (measured:
# `grep -c "object Object" launch-seats.sh` -> 0, exit 1), so the whole capture
# route rested on the unproven assumption that a record survives to the log.
case_run "B7a --check-log REJECTS an [object Object] log" 3 "THE LINES BEING PRESENT IS NOT THE TELL" -- \
  node "$REDUCE" --check-log "$WORK/preflight-objectobject.log"
case_run "B7b --check-log ACCEPTS a parseable record" 0 "PRE-FLIGHT: PASS" -- \
  node "$REDUCE" --check-log "$WORK/preflight-good.log"
case_run "B7c --check-log REJECTS a log with no tagged lines at all" 3 "carries NO [gate-trace] lines at all" -- \
  node "$REDUCE" --check-log "$WORK/trace-empty-of-records.log"

# The bundle half, against a fake dist in each of the three shapes.
mkdir -p "$WORK/dist-good/frontend-dist/assets" "$WORK/dist-twoarg/frontend-dist/assets" "$WORK/dist-bare/frontend-dist/assets"
printf 'x=1;console.error("[gate-trace] "+JSON.stringify({a:1}));\n' >"$WORK/dist-good/frontend-dist/assets/index-abc.js"
printf 'x=1;console.error("[gate-trace]",{a:1});\n' >"$WORK/dist-twoarg/frontend-dist/assets/index-abc.js"
printf 'x=1;console.error("hello");\n' >"$WORK/dist-bare/frontend-dist/assets/index-abc.js"
case_run "B7d a bundle carrying the OBJECT-ARGUMENT form is refused" 1 "the packaged Chromium log will read" -- \
  env SLOGA_SHELL_DIR="$WORK/dist-twoarg" bash "$HERE/launch-seats.sh" preflight
case_run "B7e a bundle with NO [gate-trace] at all is refused" 1 "carries NO [gate-trace] string at all" -- \
  env SLOGA_SHELL_DIR="$WORK/dist-bare" bash "$HERE/launch-seats.sh" preflight
case_run "B7f a bundle carrying the pre-serialized form passes the static pre-flight" 0 "PRE-FLIGHT (static): OK" -- \
  env SLOGA_SHELL_DIR="$WORK/dist-good" bash "$HERE/launch-seats.sh" preflight
case_run "B7g the pre-flight proves its OWN instrument against a known-bad sample" 0 "pre-flight instrument: rejects [object Object]" -- \
  env SLOGA_SHELL_DIR="$WORK/dist-good" bash "$HERE/launch-seats.sh" preflight
case_run "B7h and it names the live half as still owed" 0 "Until this passes, the whole capture route is an ASSUMPTION" -- \
  bash "$HERE/launch-seats.sh" steps

echo
echo "=== stage 12: M2 — the subject seat's guidance must not repeat the wrong tell ==="
# cmd_subject cannot be RUN here (it requires the real rig), so its guidance is
# asserted on the file itself, in BOTH directions: the wrong tell must be gone
# AND the right one must be present. A one-sided grep would pass on an empty
# file.
if grep -qF -- 'If the log has no' "$HERE/launch-seats.sh"; then
  note_fail "M2 launch-seats.sh still tells the operator the tell is a log with no [gate-trace] lines"
else
  echo "  CONTROL PASS  M2 the old 'if the log has no [gate-trace] lines' guidance is gone"
fi
if grep -qF -- 'THE TELL IS NOT' "$HERE/launch-seats.sh" && grep -qF -- '--check-log' "$HERE/launch-seats.sh"; then
  echo "  CONTROL PASS  M2b cmd_subject now names the real tell and the command that judges it"
else
  note_fail "M2b launch-seats.sh does not tell the operator the real tell ([object Object]) or how to judge the log"
fi

echo
echo "############ W0-C self-test: $fails failing control(s) ############"
exit $fails
