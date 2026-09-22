// Unit spec for the channel-list double-click join — run with Node's built-in
// runner:
//   node --test --conditions=browser components/rtc/doubleClickJoinPolicy.test.ts
// Focus: the double-click joins only a voice channel the user may connect to
// and is not already in, the setting is a true opt-out, and a join that is
// already in flight (or a refusal that still holds) is never re-driven — the
// guard that keeps an accidental second pair of clicks from tearing down the
// call the first pair just started.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type DoubleClickJoinInput,
  shouldJoinOnDoubleClick,
} from "./doubleClickJoinPolicy.ts";

/** The one case that joins; each test varies a single field away from it. */
const joins: DoubleClickJoinInput = {
  isVoiceChannel: true,
  settingEnabled: true,
  canConnect: true,
  alreadyInThisCall: false,
  joinBlocked: false,
};

test("a double-click on a joinable voice channel joins it", () => {
  assert.equal(shouldJoinOnDoubleClick(joins), true);
});

test("a text, forum or announcement channel never joins", () => {
  assert.equal(
    shouldJoinOnDoubleClick({ ...joins, isVoiceChannel: false }),
    false,
  );
});

test("the setting is a true opt-out", () => {
  // Off means the row behaves exactly as it did before the feature existed,
  // no matter how joinable the channel is.
  assert.equal(
    shouldJoinOnDoubleClick({ ...joins, settingEnabled: false }),
    false,
  );
});

test("no Connect permission, no join", () => {
  // Without this the double-click would drive connect() into a refusal the
  // client can see coming, and the refusal latch would then hold the channel
  // inert for everything else too.
  assert.equal(shouldJoinOnDoubleClick({ ...joins, canConnect: false }), false);
});

test("double-clicking the call you are already in does nothing", () => {
  // connect() leaves the current call before it asks the server anything, so
  // a "re-join" here is a real teardown of a working call.
  assert.equal(
    shouldJoinOnDoubleClick({ ...joins, alreadyInThisCall: true }),
    false,
  );
});

test("a join in flight or a holding refusal is never re-driven", () => {
  // joinBlocked carries both (joinRefusalPolicy). This is the guard that
  // matters most for a double-click: it is the affordance most likely to be
  // fired twice by accident.
  assert.equal(shouldJoinOnDoubleClick({ ...joins, joinBlocked: true }), false);
});

test("every guard stands alone — no single true field can force a join", () => {
  // Guards must not be OR-ed by a later edit: flipping any one of them off
  // blocks the join even when everything else says go.
  const guards: (keyof DoubleClickJoinInput)[] = [
    "isVoiceChannel",
    "settingEnabled",
    "canConnect",
  ];
  for (const key of guards) {
    assert.equal(
      shouldJoinOnDoubleClick({ ...joins, [key]: false }),
      false,
      key + " alone should block the join",
    );
  }
  for (const key of ["alreadyInThisCall", "joinBlocked"] as const) {
    assert.equal(
      shouldJoinOnDoubleClick({ ...joins, [key]: true }),
      false,
      key + " alone should block the join",
    );
  }
});
