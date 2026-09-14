// Unit spec for the publish-kick decision (final-audit F1, 2026-09-14).
//   node --test --conditions=browser components/rtc/publishKickPolicy.test.ts
// Focus: a held gate always SWEEPS (the per-publication pause sweep is the
// sole implementation of "a desynced member publishes nothing", so a
// born-paused tag must never short-circuit it); with the gate empty a
// born-paused publication gets its deferred resume; with the gate empty and
// no tag there is nothing to do. The decision lives in a dependency-free
// module precisely so these rules are reachable by `node --test` and by
// `scripts/rtc-mutations.py`; the wiring in `state.tsx` is live-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PublishKickAction,
  publishKickAction,
} from "./publishKickPolicy.ts";

type Input = Parameters<typeof publishKickAction>[0];

// Every one of the 4 input combinations, in binary order over
// (gateHeld, bornPaused). This is the oracle the narrower specs below slice;
// the exhaustive spec proves it is complete and duplicate-free before
// anything reads it.
const TABLE: ReadonlyArray<readonly [Input, PublishKickAction]> = [
  [{ gateHeld: false, bornPaused: false }, "none"],
  [{ gateHeld: false, bornPaused: true }, "resumeLanded"],
  [{ gateHeld: true, bornPaused: false }, "sweep"],
  [{ gateHeld: true, bornPaused: true }, "sweep"],
];

const key = (i: Input) => `${i.gateHeld}/${i.bornPaused}`;

// All 4 inputs generated from the booleans, independent of TABLE, so a spec
// can enumerate the function's behaviour without trusting the hand-written
// oracle.
const ALL_INPUTS: readonly Input[] = [false, true].flatMap((gateHeld) =>
  [false, true].map((bornPaused) => ({ gateHeld, bornPaused })),
);

// ---- The three arms --------------------------------------------------------

/**
 * Kills `publish-kick-sweeps-only-born` (the gate check moved below the
 * born check): with the gate held, BOTH `bornPaused` rows must read "sweep".
 * The mutant reads "resumeLanded" on the held / born row. That arm passes the
 * live `gateHeld` thunk, so under a held gate `publishGateOp` still answers
 * pause/repause (never a resume); the real consequence is a bare
 * one-publication op outside the episode's coalescing sweep and its
 * `repauseSpent` / `repausePending` bookkeeping, with `unproven` dropped.
 */
test("a held gate sweeps regardless of the born-paused tag", () => {
  assert.equal(
    publishKickAction({ gateHeld: true, bornPaused: false }),
    "sweep",
  );
  assert.equal(
    publishKickAction({ gateHeld: true, bornPaused: true }),
    "sweep",
  );
});

/**
 * Kills `publish-kick-resumes-everything` (the born arm returns "sweep"):
 * with the gate empty, a born-paused publication must read "resumeLanded" —
 * its deferred resume is owed now, and a sweep on an empty gate would leave
 * it paused for good.
 */
test("an empty gate resumes a born-paused publication", () => {
  assert.equal(
    publishKickAction({ gateHeld: false, bornPaused: true }),
    "resumeLanded",
  );
});

/**
 * Kills `publish-kick-ignores-empty-gate` (the last arm returns
 * "resumeLanded"): with the gate empty and no born-paused tag there is no
 * deferred resume to land, so the row must read "none".
 */
test("an empty gate with no tag does nothing", () => {
  assert.equal(
    publishKickAction({ gateHeld: false, bornPaused: false }),
    "none",
  );
});

/**
 * Kills all three named mutants a second way: every row of the hand-written
 * oracle must match, AND enumerating the function over the 4 generated
 * inputs (not TABLE) must find exactly two "sweep" rows (both held), exactly
 * one "resumeLanded" (empty / born) and exactly one "none" (empty / untagged).
 * A mutant that flips any arm changes at least one of those partitions.
 */
test("the three arms over all 4 input combinations", () => {
  // The oracle itself: complete and duplicate-free, or every row assertion
  // below is checking a partial truth.
  assert.equal(TABLE.length, 4);
  assert.equal(new Set(TABLE.map(([input]) => key(input))).size, 4);
  for (const [input, want] of TABLE) {
    assert.equal(publishKickAction(input), want, key(input));
  }

  assert.equal(ALL_INPUTS.length, 4);
  const by = (action: PublishKickAction) =>
    ALL_INPUTS.filter((input) => publishKickAction(input) === action);
  assert.deepEqual(by("sweep"), [
    { gateHeld: true, bornPaused: false },
    { gateHeld: true, bornPaused: true },
  ]);
  assert.deepEqual(by("resumeLanded"), [{ gateHeld: false, bornPaused: true }]);
  assert.deepEqual(by("none"), [{ gateHeld: false, bornPaused: false }]);
});
