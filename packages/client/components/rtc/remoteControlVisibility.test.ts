// Unit spec for the channel-wide remote-control visibility map — run with
// Node's built-in runner:
//   node --test --conditions=browser components/rtc/remoteControlVisibility.test.ts
// Focus: Active upserts per (channel, sharer), Ended clears exactly that key
// regardless of cause, and no-op ends return the same reference.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EMPTY_REMOTE_CONTROL_SESSIONS,
  applyRemoteControlActive,
  applyRemoteControlEnded,
} from "./remoteControlVisibility.ts";

const ACTIVE_A = {
  channelId: "ch1",
  sharerId: "alice",
  controllerId: "bob",
};

test("active records the controller for the sharer's channel entry", () => {
  const map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  assert.equal(map.get("ch1")?.get("alice"), "bob");
});

test("a later active for the same sharer replaces the controller (handoff)", () => {
  let map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  map = applyRemoteControlActive(map, { ...ACTIVE_A, controllerId: "carol" });
  assert.equal(map.get("ch1")?.get("alice"), "carol");
  assert.equal(map.get("ch1")?.size, 1);
});

test("several sharers in one channel coexist (§0.7 permits several sharers)", () => {
  let map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  map = applyRemoteControlActive(map, {
    channelId: "ch1",
    sharerId: "dave",
    controllerId: "erin",
  });
  assert.equal(map.get("ch1")?.get("alice"), "bob");
  assert.equal(map.get("ch1")?.get("dave"), "erin");
});

test("channels are independent", () => {
  let map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  map = applyRemoteControlActive(map, { ...ACTIVE_A, channelId: "ch2" });
  map = applyRemoteControlEnded(map, { channelId: "ch2", sharerId: "alice" });
  assert.equal(map.get("ch1")?.get("alice"), "bob");
  assert.equal(map.get("ch2"), undefined);
});

test("ended clears only the (channel, sharer) it names", () => {
  let map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  map = applyRemoteControlActive(map, {
    channelId: "ch1",
    sharerId: "dave",
    controllerId: "erin",
  });
  map = applyRemoteControlEnded(map, { channelId: "ch1", sharerId: "alice" });
  assert.equal(map.get("ch1")?.get("alice"), undefined);
  assert.equal(map.get("ch1")?.get("dave"), "erin");
});

test("ending the last sharer drops the channel entry entirely", () => {
  let map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  map = applyRemoteControlEnded(map, { channelId: "ch1", sharerId: "alice" });
  assert.equal(map.size, 0);
});

test("an ended for an unknown session returns the SAME reference (no notify)", () => {
  const map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  // Unknown sharer in a known channel, and a wholly unknown channel: an
  // Ended can outlive our state (reset on disconnect, missed Active) and
  // must not churn the signal.
  assert.equal(
    applyRemoteControlEnded(map, { channelId: "ch1", sharerId: "zoe" }),
    map,
  );
  assert.equal(
    applyRemoteControlEnded(map, { channelId: "ch9", sharerId: "alice" }),
    map,
  );
});

test("a re-delivered identical active returns the SAME reference (no notify)", () => {
  const map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  assert.equal(applyRemoteControlActive(map, ACTIVE_A), map);
});

test("updates never mutate the input map", () => {
  const map = applyRemoteControlActive(EMPTY_REMOTE_CONTROL_SESSIONS, ACTIVE_A);
  applyRemoteControlActive(map, { ...ACTIVE_A, controllerId: "carol" });
  applyRemoteControlEnded(map, { channelId: "ch1", sharerId: "alice" });
  assert.equal(map.get("ch1")?.get("alice"), "bob");
  assert.equal(EMPTY_REMOTE_CONTROL_SESSIONS.size, 0);
});
