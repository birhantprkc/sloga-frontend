// Unit spec for the minigame visibility/interruption policy — run with Node's
// built-in runner:
//   node --test components/ui/components/features/voice/minigame/minigamePolicy.test.ts
// Focus: the chip appears ONLY while waiting alone, every veto input vetoes on
// its own, and the join interruption fires exactly on the alone→accompanied
// edge.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type MinigameVisibilityInputs,
  minigameChipVisible,
  minigameInterruptedByJoin,
} from "./minigamePolicy.ts";

const WAITING_ALONE: MinigameVisibilityInputs = {
  enabled: true,
  connected: true,
  participants: 1,
  immersive: false,
  focused: false,
};

test("visible while waiting alone with the flag on", () => {
  assert.equal(minigameChipVisible(WAITING_ALONE), true);
  // Roster not yet populated (0) still counts as alone — the WS event that
  // adds self can land a beat after the state flips to CONNECTED.
  assert.equal(
    minigameChipVisible({ ...WAITING_ALONE, participants: 0 }),
    true,
  );
});

test("each veto input vetoes on its own", () => {
  const vetoes: Partial<MinigameVisibilityInputs>[] = [
    { enabled: false },
    { connected: false },
    { participants: 2 },
    { immersive: true },
    { focused: true },
  ];
  for (const veto of vetoes) {
    assert.equal(
      minigameChipVisible({ ...WAITING_ALONE, ...veto }),
      false,
      `expected veto from ${JSON.stringify(veto)}`,
    );
  }
});

test("flag off hides the chip in EVERY state, not just the happy path", () => {
  // Exhaustive over the boolean inputs at both interesting roster sizes.
  for (const connected of [true, false])
    for (const immersive of [true, false])
      for (const focused of [true, false])
        for (const participants of [1, 2])
          assert.equal(
            minigameChipVisible({
              enabled: false,
              connected,
              participants,
              immersive,
              focused,
            }),
            false,
          );
});

test("join interruption fires exactly on the alone→accompanied edge", () => {
  assert.equal(minigameInterruptedByJoin(0), false);
  assert.equal(minigameInterruptedByJoin(1), false);
  assert.equal(minigameInterruptedByJoin(2), true);
  assert.equal(minigameInterruptedByJoin(7), true);
});
