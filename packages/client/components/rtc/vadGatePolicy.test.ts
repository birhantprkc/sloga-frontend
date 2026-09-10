// Unit spec for the voice-activity gate decision — run with Node's built-in
// runner:
//   node --test components/rtc/vadGatePolicy.test.ts   (Node >=23.6 strips types)
// Focus: a self-muted user is never unmuted by their own voice, and the open
// streak counts frames rather than ticks.
import assert from "node:assert/strict";
import { test } from "node:test";

import { type VadGateInputs, vadGateDecision } from "./vadGatePolicy.ts";
import { VAD_OPEN_FRAMES } from "./vadLevel.ts";

/** Loud speech, gate shut, nothing suppressing it. */
function talking(over: Partial<VadGateInputs> = {}): VadGateInputs {
  return {
    level: 80,
    threshold: 20,
    frames: 1,
    openStreak: 0,
    micLive: false,
    userMuted: false,
    whispering: false,
    ...over,
  };
}

test("sustained speech opens the gate once the streak is met", () => {
  let streak = 0;
  let opened = false;
  for (let i = 0; i < VAD_OPEN_FRAMES; i++) {
    const decision = vadGateDecision(talking({ openStreak: streak }));
    streak = decision.openStreak;
    opened ||= decision.open;
  }
  assert.equal(opened, true, "the gate should have opened within the streak");
});

test("a single frame over the line does not open the gate", () => {
  // A keyboard tap or a plosive pokes over the threshold for one frame.
  const decision = vadGateDecision(talking());
  assert.equal(decision.speaking, true);
  assert.equal(decision.open, false);
});

test("a self-muted user talking never opens the gate", () => {
  // THE REGRESSION. The gate hears them at full level whatever the published
  // track is doing, so muting has to be read here or the mic goes hot behind
  // a button that still reads "muted".
  let streak = 0;
  for (let i = 0; i < VAD_OPEN_FRAMES * 10; i++) {
    const decision = vadGateDecision(
      talking({ openStreak: streak, userMuted: true }),
    );
    streak = decision.openStreak;
    assert.equal(decision.open, false);
    assert.equal(decision.speaking, false);
  }
  assert.equal(streak, 0, "a muted user must not bank a streak either");
});

test("un-muting lets the very next tick start banking a streak again", () => {
  const muted = vadGateDecision(talking({ userMuted: true, openStreak: 0 }));
  assert.equal(muted.openStreak, 0);
  const live = vadGateDecision(talking({ openStreak: muted.openStreak }));
  assert.equal(live.speaking, true);
  assert.equal(live.openStreak, 1);
});

test("a whisper still suppresses the room gate", () => {
  const decision = vadGateDecision(
    talking({ whispering: true, openStreak: VAD_OPEN_FRAMES }),
  );
  assert.equal(decision.open, false);
  assert.equal(decision.openStreak, 0);
});

test("a stretched tick counts the frames it stood in for", () => {
  // A throttled window can hand the gate one tick worth several frames; the
  // streak is denominated in frames, so that one tick must satisfy it.
  const decision = vadGateDecision(talking({ frames: VAD_OPEN_FRAMES + 5 }));
  assert.equal(decision.open, true);
});

test("frames below one still advance the streak by one", () => {
  const decision = vadGateDecision(talking({ frames: 0.2, openStreak: 0 }));
  assert.equal(decision.openStreak, 1);
});

test("silence closes the streak without cutting the mic itself", () => {
  const decision = vadGateDecision(
    talking({ level: 5, micLive: true, openStreak: 12 }),
  );
  assert.equal(decision.speaking, false);
  assert.equal(decision.openStreak, 0);
  // The countdown is the caller's; a quiet tick is not a cut on its own.
  assert.equal(decision.open, false);
});

test("an already-live mic is not re-opened", () => {
  const decision = vadGateDecision(
    talking({ micLive: true, openStreak: VAD_OPEN_FRAMES }),
  );
  assert.equal(decision.speaking, true);
  assert.equal(decision.open, false);
});
