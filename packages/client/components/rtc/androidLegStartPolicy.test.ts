// Specs for the Android screen-leg start-path policy (screen-leg plan §7.2) —
// run with Node's built-in runner:
//   node --test components/rtc/androidLegStartPolicy.test.ts
//
// These cover the window the original slice-3 code left unowned: everything
// between `prepare()` (OS consent granted, capture permitted) and `connect()`
// resolving. Throughout it the leg is NOT `active()`, so every §7.4 stop hook
// used to no-op against it — a hang-up, kick or publish gate during those
// seconds left the share to come up into a call that had already ended, and an
// MLS epoch rotation during them left it publishing under a key the rotation
// had just removed a member from.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type LegSendKey,
  keyToPushAfterConnect,
  startAttemptStale,
} from "./androidLegStartPolicy.ts";

const world = (
  over: Partial<Parameters<typeof startAttemptStale>[0]> = {},
) => ({
  generation: 7,
  currentGeneration: 7,
  roomChanged: false,
  publishGateSize: 0,
  ...over,
});

test("an undisturbed attempt is not stale", () => {
  assert.equal(startAttemptStale(world()), false);
});

test("a stop hook during connect orphans the attempt", () => {
  // Every §7.4 hook bumps the generation BEFORE it looks at the leg, which is
  // the whole mechanism: the hook that fires while nothing is active yet is
  // exactly the one that has to cancel the start.
  assert.equal(startAttemptStale(world({ currentGeneration: 8 })), true);
});

test("a competing tap orphans the earlier attempt, not the later one", () => {
  // Second tap claimed 8; the first attempt still holds 7 and must abandon.
  assert.equal(startAttemptStale(world({ currentGeneration: 8 })), true);
  assert.equal(
    startAttemptStale(world({ generation: 8, currentGeneration: 8 })),
    false,
  );
});

test("leaving or switching the call orphans the attempt", () => {
  assert.equal(startAttemptStale(world({ roomChanged: true })), true);
});

test("any publish-gate reason orphans the attempt", () => {
  // §0.4: the leg STOPS whenever the primary pauses. A share must never come
  // up into a call that is re-securing or mixed.
  assert.equal(startAttemptStale(world({ publishGateSize: 1 })), true);
  assert.equal(startAttemptStale(world({ publishGateSize: 3 })), true);
});

test("each condition is independently sufficient", () => {
  // Negative control for the three-way OR: none of these may be masked by the
  // others being clean.
  for (const over of [
    { currentGeneration: 8 },
    { roomChanged: true },
    { publishGateSize: 1 },
  ]) {
    assert.equal(startAttemptStale(world(over)), true, JSON.stringify(over));
  }
});

const key = (keyB64: string, keyIndex: number): LegSendKey => ({
  keyB64,
  keyIndex,
});

test("no re-key when the epoch did not move during connect", () => {
  assert.equal(keyToPushAfterConnect(key("AAA", 1), key("AAA", 1)), undefined);
});

test("a rotation during connect is pushed once the sender exists", () => {
  // The dropped-rotation case: `onLocalScreenKey` saw this while the leg was
  // still connecting and returned, so the attempt reconciles here instead.
  assert.deepEqual(
    keyToPushAfterConnect(key("AAA", 1), key("BBB", 2)),
    key("BBB", 2),
  );
});

test("changed key MATERIAL at the same index still re-keys", () => {
  // A key index is unique only within an epoch, so two epochs can reuse one.
  // Comparing indices alone would skip a required rotation and leave the leg
  // publishing under the key a removed member holds.
  assert.deepEqual(
    keyToPushAfterConnect(key("AAA", 1), key("BBB", 1)),
    key("BBB", 1),
  );
});

test("a plaintext leg is never handed a key here", () => {
  // An unannounced upgrade would be a downgrade of a different kind: the rest
  // of the call has not agreed to it.
  assert.equal(keyToPushAfterConnect(undefined, key("AAA", 1)), undefined);
});

test("no current key means nothing to push", () => {
  assert.equal(keyToPushAfterConnect(key("AAA", 1), undefined), undefined);
});
