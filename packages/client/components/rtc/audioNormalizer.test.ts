/**
 * Pure-function specs for the incoming-voice normalizer.
 *
 * Run with:
 *   node --conditions=browser --test components/rtc/audioNormalizer.test.ts
 *
 * (`--conditions=browser` is the house rule for this suite — without it Node
 * loads solid-js's server build whose createEffect is a no-op and reactive
 * suites silently rot. This file is pure functions, but keep one invocation
 * shape for the whole directory.)
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  NORMALIZER_GATE_CLOSE_DB,
  NORMALIZER_GATE_HOLD_MS,
  NORMALIZER_GATE_OPEN_DB,
  NORMALIZER_LIMITER_MAKEUP_DB,
  NORMALIZER_LIMITER_RATIO,
  NORMALIZER_LIMITER_THRESHOLD_DB,
  NORMALIZER_MAX_BOOST_DB,
  NORMALIZER_MAX_CUT_DB,
  NORMALIZER_TARGET_DB,
  NORMALIZER_TAU_DOWN_S,
  NORMALIZER_TAU_UP_S,
  NORMALIZER_TOTAL_GAIN_CEILING_DB,
  boostBudgetDb,
  clampStrength,
  dbToLinear,
  desiredGainDb,
  initialGateState,
  limiterMakeupDb,
  linearToDb,
  maxBoostForStrength,
  nextGateState,
  smoothingTauS,
} from "./audioNormalizer.ts";

describe("dB conversions", () => {
  test("known anchor points", () => {
    assert.equal(dbToLinear(0), 1);
    assert.ok(Math.abs(dbToLinear(-20) - 0.1) < 1e-12);
    assert.ok(Math.abs(dbToLinear(6) - 1.9952623149688795) < 1e-12);
    assert.equal(linearToDb(1), 0);
    assert.ok(Math.abs(linearToDb(0.1) - -20) < 1e-12);
  });

  test("round-trips", () => {
    for (const db of [-60, -24, -6, 0, 6, 18]) {
      assert.ok(Math.abs(linearToDb(dbToLinear(db)) - db) < 1e-9);
    }
  });

  test("silence is -Infinity, not NaN", () => {
    assert.equal(linearToDb(0), -Infinity);
    assert.equal(linearToDb(-1), -Infinity);
  });
});

describe("strength", () => {
  test("clamps to 0..100 and defaults garbage", () => {
    assert.equal(clampStrength(-5), 0);
    assert.equal(clampStrength(0), 0);
    assert.equal(clampStrength(73), 73);
    assert.equal(clampStrength(250), 100);
    assert.equal(clampStrength(NaN), 50);
    assert.equal(clampStrength(Infinity), 50);
    assert.equal(clampStrength("loud"), 50);
    assert.equal(clampStrength(undefined), 50);
  });

  test("scales only the boost side, linearly", () => {
    assert.equal(maxBoostForStrength(0), 0);
    assert.equal(maxBoostForStrength(50), NORMALIZER_MAX_BOOST_DB / 2);
    assert.equal(maxBoostForStrength(100), NORMALIZER_MAX_BOOST_DB);
  });
});

describe("desired gain", () => {
  test("steers toward the target", () => {
    // A talker at -40 dBFS with an 18 dB budget: wants +16.
    assert.equal(desiredGainDb(-40, 18), NORMALIZER_TARGET_DB - -40);
  });

  test("clamps the boost at the given budget", () => {
    // A whisper at -60 dBFS wants +36; the budget says otherwise.
    assert.equal(desiredGainDb(-60, 9), 9);
    assert.equal(desiredGainDb(-60, 0), 0);
  });

  test("clamps the cut at the fixed floor", () => {
    // A screamer at 0 dBFS wants -24; the floor is -12.
    assert.equal(desiredGainDb(0, 18), NORMALIZER_MAX_CUT_DB);
  });
});

describe("boost budget (§2.3 gain ceiling)", () => {
  test("unity manual gain leaves the full budget", () => {
    assert.equal(boostBudgetDb(1, 18), 18);
  });

  test("shrinks as manual gain rises", () => {
    // 3x output x 3x per-user = 9x ≈ +19.08 dB manual. Ceiling 24 leaves
    // less than 5 dB of AGC boost.
    const budget = boostBudgetDb(9, 18);
    assert.ok(budget < 5 && budget > 4.8, `budget was ${budget}`);
  });

  test("never goes negative: past the ceiling it stops boosting", () => {
    // A hypothetical +40 dB of manual gain must yield 0, not a cut.
    assert.equal(boostBudgetDb(100, 18), 0);
  });

  test("manual attenuation does not inflate the budget past the clamp", () => {
    // Someone turned DOWN to 10%: budget stays the strength clamp, it does
    // not borrow the unused ceiling headroom.
    assert.equal(boostBudgetDb(0.1, 18), 18);
  });

  test("the ceiling constant is what the maths uses", () => {
    // manual exactly at the ceiling -> zero budget.
    assert.equal(
      boostBudgetDb(dbToLinear(NORMALIZER_TOTAL_GAIN_CEILING_DB), 18),
      0,
    );
  });
});

describe("speech gate", () => {
  test("starts closed and stays closed on silence", () => {
    let s = initialGateState;
    s = nextGateState(s, -80, 50);
    assert.equal(s.open, false);
  });

  test("opens instantly above the open threshold", () => {
    const s = nextGateState(initialGateState, NORMALIZER_GATE_OPEN_DB, 50);
    assert.equal(s.open, true);
  });

  test("hysteresis: the band between close and open changes nothing", () => {
    const inBand = (NORMALIZER_GATE_OPEN_DB + NORMALIZER_GATE_CLOSE_DB) / 2;
    // Closed stays closed...
    assert.equal(nextGateState(initialGateState, inBand, 50).open, false);
    // ...open stays open, and the hold timer resets.
    const open = nextGateState(initialGateState, -20, 50);
    const held = nextGateState({ ...open, belowMs: 300 }, inBand, 50);
    assert.equal(held.open, true);
    assert.equal(held.belowMs, 0);
  });

  test("closes only after the hold time below the close threshold", () => {
    let s = nextGateState(initialGateState, -20, 50); // open
    // 350 ms below: still open (hold is 400 ms).
    s = nextGateState(s, -80, 350);
    assert.equal(s.open, true);
    // 50 more ms: now closed.
    s = nextGateState(s, -80, 50);
    assert.equal(s.open, false);
  });

  test("a word inside the hold window keeps it open", () => {
    let s = nextGateState(initialGateState, -20, 50);
    s = nextGateState(s, -80, NORMALIZER_GATE_HOLD_MS - 100);
    s = nextGateState(s, -20, 50); // spoke again
    assert.equal(s.open, true);
    assert.equal(s.belowMs, 0);
    // The countdown starts over, it does not resume.
    s = nextGateState(s, -80, NORMALIZER_GATE_HOLD_MS - 100);
    assert.equal(s.open, true);
  });
});

describe("smoothing asymmetry", () => {
  test("cuts fast, boosts slow", () => {
    assert.equal(smoothingTauS(0, -6), NORMALIZER_TAU_DOWN_S);
    assert.equal(smoothingTauS(0, 6), NORMALIZER_TAU_UP_S);
    assert.equal(smoothingTauS(6, 6), NORMALIZER_TAU_UP_S);
  });
});

describe("limiter makeup compensation", () => {
  test("matches the Web Audio spec formula for our curve", () => {
    // Spec: makeup = (1/|curve(1)|)^0.6, always applied. A 0 dBFS input
    // leaves our threshold -6 / ratio 12 curve at -5.5 dB, so makeup is
    // -0.6 x -5.5 = +3.3 dB. If someone retunes the limiter this pins the
    // compensation to the same numbers.
    const makeup = limiterMakeupDb(
      NORMALIZER_LIMITER_THRESHOLD_DB,
      NORMALIZER_LIMITER_RATIO,
    );
    assert.ok(Math.abs(makeup - 3.3) < 1e-9, `makeup was ${makeup}`);
    assert.equal(makeup, NORMALIZER_LIMITER_MAKEUP_DB);
  });

  test("pre-compensation cancels the makeup exactly at unity AGC", () => {
    // Gain node at dbToLinear(0 - makeup) times the limiter's dbToLinear(makeup)
    // must be unity: toggling normalization on must not change the loudness
    // of a talker already at target.
    const through =
      dbToLinear(0 - NORMALIZER_LIMITER_MAKEUP_DB) *
      dbToLinear(NORMALIZER_LIMITER_MAKEUP_DB);
    assert.ok(Math.abs(through - 1) < 1e-12);
  });
});

describe("threshold coherence (§2.4)", () => {
  test("target + typical speech crest stays under the limiter threshold", () => {
    // Speech crest factor runs 12-18 dB. At the -24 dBFS target, peaks land
    // at -12..-6 dBFS — at or below the -6 dB limiter threshold, so the
    // limiter works transients rather than running as a permanent
    // compressor. If someone retunes the target upward this goes red.
    const worstPeakDb = NORMALIZER_TARGET_DB + 18;
    assert.ok(worstPeakDb <= -6, `peaks would sit at ${worstPeakDb} dBFS`);
  });
});
