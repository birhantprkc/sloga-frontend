// Unit spec for the mic-pipeline attach decision (D6, 2026-09-14).
//   node --test --conditions=browser components/rtc/micPipelinePolicy.test.ts
// Focus: an existing pipeline is tuned in place whatever the gate says, an
// all-default want never attaches, a held gate DEFERS the attach (nothing is
// stored — the caller re-reads its wants at the gate's single 1→0 edge), and
// an attach happens only with the gate empty and a non-default want. The
// decision lives in a dependency-free module precisely so these rules are
// reachable by `node --test` and by `scripts/rtc-mutations.py`; the wiring in
// `state.tsx` (`#syncMicPipeline`, `#resumeGate`) is live-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type MicPipelineAction,
  micPipelineAction,
} from "./micPipelinePolicy.ts";

type Input = Parameters<typeof micPipelineAction>[0];

// Every one of the 8 input combinations, in binary order over
// (gateHeld, hasPipeline, wantsDefault). This is the oracle the narrower specs
// below slice; the first spec proves it is complete and duplicate-free before
// anything reads it.
const TABLE: ReadonlyArray<readonly [Input, MicPipelineAction]> = [
  [{ gateHeld: false, hasPipeline: false, wantsDefault: false }, "attach"],
  [{ gateHeld: false, hasPipeline: false, wantsDefault: true }, "none"],
  [{ gateHeld: false, hasPipeline: true, wantsDefault: false }, "tune"],
  [{ gateHeld: false, hasPipeline: true, wantsDefault: true }, "tune"],
  [{ gateHeld: true, hasPipeline: false, wantsDefault: false }, "defer"],
  [{ gateHeld: true, hasPipeline: false, wantsDefault: true }, "none"],
  [{ gateHeld: true, hasPipeline: true, wantsDefault: false }, "tune"],
  [{ gateHeld: true, hasPipeline: true, wantsDefault: true }, "tune"],
];

const key = (i: Input) => `${i.gateHeld}/${i.hasPipeline}/${i.wantsDefault}`;

// All 8 inputs generated from the booleans, independent of TABLE, so a spec
// can enumerate the function's behaviour without trusting the hand-written
// oracle.
const ALL_INPUTS: readonly Input[] = [false, true].flatMap((gateHeld) =>
  [false, true].flatMap((hasPipeline) =>
    [false, true].map((wantsDefault) => ({
      gateHeld,
      hasPipeline,
      wantsDefault,
    })),
  ),
);

// ---- The four arms ---------------------------------------------------------

/**
 * Kills `mic-pipeline-attaches-under-a-held-gate` (the held-gate arm returns
 * "attach" instead of "defer"): the `{gateHeld: true, hasPipeline: false,
 * wantsDefault: false}` row must read "defer". Also kills
 * `mic-pipeline-tune-loses-to-gate` through the two held-gate `hasPipeline`
 * rows, which that mutant turns into "defer".
 */
test("the four arms over all 8 input combinations", () => {
  // The oracle itself: complete and duplicate-free, or every row assertion
  // below is checking a partial truth.
  assert.equal(TABLE.length, 8);
  assert.equal(new Set(TABLE.map(([input]) => key(input))).size, 8);
  for (const [input, want] of TABLE) {
    assert.equal(micPipelineAction(input), want, key(input));
  }
});

/**
 * Kills `mic-pipeline-tune-loses-to-gate` (the gate check moved above the
 * `hasPipeline` check): with the gate held, an existing pipeline must still
 * read "tune" — tuning is state-only (`setTonePreset` returns at `!this.#ctx`,
 * `setGain` writes a field) and never touches the sender, so there is nothing
 * for the gate to protect. The mutant reads "defer" on both rows.
 */
test("tune wins over the gate", () => {
  assert.equal(
    micPipelineAction({
      gateHeld: true,
      hasPipeline: true,
      wantsDefault: false,
    }),
    "tune",
  );
  assert.equal(
    micPipelineAction({
      gateHeld: true,
      hasPipeline: true,
      wantsDefault: true,
    }),
    "tune",
  );
});

/**
 * Kills `mic-pipeline-tune-loses-to-gate` ONLY when that mutant's gate check
 * lands above the all-default check too (gate → pipeline → default): the
 * held / no-pipeline / all-default row then reads "defer". If the mutant
 * merely rotates the arms (default → gate → pipeline), this spec
 * does not reach it and names no mutation of its own. Either way it pins the
 * "none" arm: a held gate must never DEFER an all-default want (the edge
 * would then run a pointless attach) and an empty gate must never attach a
 * default pipeline.
 */
test("all-default wants never attach, held or not", () => {
  assert.equal(
    micPipelineAction({
      gateHeld: false,
      hasPipeline: false,
      wantsDefault: true,
    }),
    "none",
  );
  assert.equal(
    micPipelineAction({
      gateHeld: true,
      hasPipeline: false,
      wantsDefault: true,
    }),
    "none",
  );
});

/**
 * Kills `mic-pipeline-attaches-under-a-held-gate` a second way: that mutant
 * makes TWO rows read "attach". Enumerates the function over all 8 generated
 * inputs (not the hand-written TABLE) and requires exactly one "attach", at
 * the gate-empty / no-pipeline / non-default row.
 */
test("attach only with the gate empty and a non-default want", () => {
  const attaches = ALL_INPUTS.filter(
    (input) => micPipelineAction(input) === "attach",
  );
  assert.equal(ALL_INPUTS.length, 8);
  assert.deepEqual(attaches, [
    { gateHeld: false, hasPipeline: false, wantsDefault: false },
  ]);
});
