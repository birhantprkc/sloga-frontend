// Specs for the screen-shield trigger — run with Node's built-in runner:
//   node --test components/rtc/screenShieldDetector.test.ts
//
// The state machine is the behavior of the feature; these pin its promises:
// busy corners never trigger, a toast on a calm corner always does, and the
// shield never lifts while the corner is still showing something new.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ScreenShieldDetector,
  changedFraction,
} from "./screenShieldDetector.ts";

/** Drive the detector with (fraction, atMs) pairs; returns the last verdict. */
function run(
  detector: ScreenShieldDetector,
  samples: [number, number][],
): boolean {
  let out = false;
  for (const [fraction, at] of samples) out = detector.feed(fraction, at);
  return out;
}

test("calm corner arms, toast triggers, hold keeps it shielded", () => {
  const d = new ScreenShieldDetector();
  // 0..2s calm at 150ms cadence → armed.
  const calm: [number, number][] = [];
  for (let t = 0; t <= 2000; t += 150) calm.push([0.0, t]);
  assert.equal(run(d, calm), false);
  assert.equal(d.phase, "armed");

  // Toast slides in: big change → shield immediately.
  assert.equal(d.feed(0.4, 2150), true);
  assert.equal(d.phase, "shielding");

  // Calm again but inside the hold window → still shielded.
  assert.equal(d.feed(0.0, 4000), true);

  // Past the hold and calm → released, and it must RE-ARM (a second toast
  // right away is caught only after stability returns).
  assert.equal(d.feed(0.0, 9500), false);
  assert.equal(d.phase, "arming");
});

test("constantly busy corner never triggers", () => {
  const d = new ScreenShieldDetector();
  const busy: [number, number][] = [];
  for (let t = 0; t <= 30_000; t += 150) busy.push([0.3, t]);
  assert.equal(run(d, busy), false);
  assert.equal(d.phase, "arming");
});

test("a lingering toast outlasts the hold timer", () => {
  const d = new ScreenShieldDetector();
  for (let t = 0; t <= 2000; t += 150) d.feed(0, t);
  d.feed(0.5, 2150); // trigger
  // Way past the hold, but the corner keeps changing (toast stack animating,
  // progress toast, etc.) → stays shielded.
  assert.equal(d.feed(0.2, 60_000), true);
  // Only calm releases it.
  assert.equal(d.feed(0.0, 60_150), false);
});

test("brief flicker during arming restarts the stability clock", () => {
  const d = new ScreenShieldDetector();
  for (let t = 0; t <= 1200; t += 150) d.feed(0, t);
  d.feed(0.5, 1350); // busy blip before STABLE_MS elapsed
  for (let t = 1500; t <= 2400; t += 150) d.feed(0, t);
  // 1350→2400 is under the stability requirement measured from the blip...
  assert.equal(d.phase, "arming");
  d.feed(0, 3000);
  assert.equal(d.phase, "armed");
});

test("changedFraction counts meaningfully-changed pixels", () => {
  const a = new Uint8ClampedArray(16); // 4 black pixels
  const b = new Uint8ClampedArray(16);
  assert.equal(changedFraction(a, b), 0);
  // Flip 1 of 4 pixels to white.
  b[0] = b[1] = b[2] = 255;
  assert.equal(changedFraction(a, b), 0.25);
  // Tiny luma wiggle (sensor noise) does not count.
  const c = new Uint8ClampedArray(16).fill(10);
  const e = new Uint8ClampedArray(16).fill(20);
  assert.equal(changedFraction(c, e), 0);
  assert.equal(changedFraction(new Uint8ClampedArray(0), b), 0);
});
