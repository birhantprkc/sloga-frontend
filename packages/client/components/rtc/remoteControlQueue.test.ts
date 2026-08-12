// Unit spec for the pass-the-controller rotation queue — run with Node's
// built-in runner:
//   node --test --conditions=browser components/rtc/remoteControlQueue.test.ts
// Focus: order is stable under re-adds, absent members never stall the
// rotation, wrap-around keeps a circle going, and the sole-member case
// refuses rather than handing someone the controller they already hold.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_REMOTE_CONTROL_QUEUE,
  addToQueue,
  nextInQueue,
  removeFromQueue,
  retainPresent,
  turnExpired,
} from "./remoteControlQueue.ts";

// -- addToQueue ------------------------------------------------------------

test("adds in join order", () => {
  let q = EMPTY_REMOTE_CONTROL_QUEUE;
  q = addToQueue(q, "a");
  q = addToQueue(q, "b");
  assert.deepEqual(q, ["a", "b"]);
});

test("re-adding never costs someone their place", () => {
  const q = addToQueue(addToQueue(addToQueue([], "a"), "b"), "a");
  assert.deepEqual(q, ["a", "b"]);
});

test("adding an existing member returns the SAME reference", () => {
  const q = addToQueue([], "a");
  assert.equal(addToQueue(q, "a"), q);
});

test("an empty id is ignored", () => {
  const q = addToQueue([], "a");
  assert.equal(addToQueue(q, ""), q);
});

// -- removeFromQueue -------------------------------------------------------

test("removing drops the member and preserves order", () => {
  assert.deepEqual(removeFromQueue(["a", "b", "c"], "b"), ["a", "c"]);
});

test("removing a non-member returns the SAME reference", () => {
  const q = ["a", "b"];
  assert.equal(removeFromQueue(q, "z"), q);
});

// -- retainPresent ---------------------------------------------------------

test("everyone who left the call is dropped, in order", () => {
  assert.deepEqual(retainPresent(["a", "b", "c"], ["c", "a"]), ["a", "c"]);
});

test("retaining an unchanged queue returns the SAME reference", () => {
  const q = ["a", "b"];
  assert.equal(retainPresent(q, new Set(["a", "b", "extra"])), q);
});

test("an emptied call empties the rotation", () => {
  assert.deepEqual(retainPresent(["a", "b"], []), []);
});

// -- nextInQueue -----------------------------------------------------------

test("an empty queue has no next, driver or not", () => {
  assert.equal(nextInQueue([], undefined), undefined);
  assert.equal(nextInQueue([], "a"), undefined);
});

test("with nobody driving the rotation starts at the head", () => {
  assert.equal(nextInQueue(["a", "b"], undefined), "a");
});

test("next advances to the following member", () => {
  assert.equal(nextInQueue(["a", "b", "c"], "a"), "b");
  assert.equal(nextInQueue(["a", "b", "c"], "b"), "c");
});

test("next wraps so a circle keeps going", () => {
  assert.equal(nextInQueue(["a", "b", "c"], "c"), "a");
});

test("a driver who is not in the queue falls back to the head", () => {
  // Removed mid-turn, or control was handed over outside the rotation.
  // Falling back keeps Next working instead of dead.
  assert.equal(nextInQueue(["a", "b"], "stranger"), "a");
});

test("the sole member driving has no next", () => {
  // Passing to yourself would tear down a live session and spend a native
  // dialog to arrive exactly where it started.
  assert.equal(nextInQueue(["a"], "a"), undefined);
});

test("the sole member IS next when somebody else is driving", () => {
  assert.equal(nextInQueue(["a"], "b"), "a");
});

// -- turnExpired -----------------------------------------------------------

test("no deadline never expires (turn timers are opt-in)", () => {
  assert.equal(turnExpired(undefined, 1_000_000), false);
});

test("a turn expires only at or past its deadline", () => {
  assert.equal(turnExpired(1000, 999), false);
  assert.equal(turnExpired(1000, 1000), true);
  assert.equal(turnExpired(1000, 1001), true);
});
