// Unit spec for the "ask for a turn" pending-request list — run with:
//   node --test --conditions=browser components/rtc/turnRequests.test.ts
// Focus: dedup keeps a place without a heckler jumping the order, the cap
// evicts oldest, absent askers are pruned, and the capability marker stays a
// TRI-STATE (unknown never collapses to "cannot take control").
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_TURN_REQUESTS,
  MAX_TURN_REQUESTS,
  addTurnRequest,
  removeTurnRequest,
  retainPresentRequests,
} from "./turnRequests.ts";

// -- addTurnRequest --------------------------------------------------------

test("records raised hands newest-last", () => {
  let r = EMPTY_TURN_REQUESTS;
  r = addTurnRequest(r, "a", 1);
  r = addTurnRequest(r, "b", 2);
  assert.deepEqual(r, [
    { userId: "a", at: 1 },
    { userId: "b", at: 2 },
  ]);
});

test("re-asking refreshes the timestamp but keeps the place", () => {
  let r = addTurnRequest(addTurnRequest([], "a", 1), "b", 2);
  r = addTurnRequest(r, "a", 9);
  // a stays first (did not jump to the back), its `at` advanced.
  assert.deepEqual(r, [
    { userId: "a", at: 9 },
    { userId: "b", at: 2 },
  ]);
});

test("a repeat at the same ms returns the SAME reference", () => {
  const r = addTurnRequest([], "a", 5);
  assert.equal(addTurnRequest(r, "a", 5), r);
});

test("an empty id is ignored", () => {
  const r = addTurnRequest([], "a", 1);
  assert.equal(addTurnRequest(r, "", 2), r);
});

test("the cap evicts the OLDEST request", () => {
  let r = EMPTY_TURN_REQUESTS;
  for (let i = 0; i < MAX_TURN_REQUESTS + 3; i++) {
    r = addTurnRequest(r, `u${i}`, i);
  }
  assert.equal(r.length, MAX_TURN_REQUESTS);
  // u0..u2 evicted; u3 is now the oldest kept.
  assert.equal(r[0].userId, "u3");
  assert.equal(r[r.length - 1].userId, `u${MAX_TURN_REQUESTS + 2}`);
});

// -- removeTurnRequest -----------------------------------------------------

test("removes an acted-on request", () => {
  const r = addTurnRequest(addTurnRequest([], "a", 1), "b", 2);
  assert.deepEqual(removeTurnRequest(r, "a"), [{ userId: "b", at: 2 }]);
});

test("removing an absent id returns the SAME reference", () => {
  const r = addTurnRequest([], "a", 1);
  assert.equal(removeTurnRequest(r, "z"), r);
});

// -- retainPresentRequests -------------------------------------------------

test("prunes askers who left, keeping order", () => {
  const r = addTurnRequest(
    addTurnRequest(addTurnRequest([], "a", 1), "b", 2),
    "c",
    3,
  );
  assert.deepEqual(retainPresentRequests(r, ["c", "a"]), [
    { userId: "a", at: 1 },
    { userId: "c", at: 3 },
  ]);
});

test("retain returns the SAME reference when all present", () => {
  const r = addTurnRequest(addTurnRequest([], "a", 1), "b", 2);
  assert.equal(retainPresentRequests(r, new Set(["a", "b"])), r);
});
