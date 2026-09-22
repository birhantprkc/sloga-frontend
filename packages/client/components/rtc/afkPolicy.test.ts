// Unit spec for the AFK-channel client rules (AFK plan A7, 2026-09-21).
//   node --test --conditions=browser components/rtc/afkPolicy.test.ts
//
// Focus: the designation predicate never fires on an undesignated server, the
// publish accessors fold AFK in even though the permission bits say yes (the
// D2 consequence — `havePermission("Speak")` stays true in the AFK channel),
// the toggle guard refuses only the ENABLING direction, the join plan
// reproduces the four lines it replaced, and the permission-fall classifier
// tells an AFK user the truth instead of blaming a moderator.
//
// 🔴 Every assertion calls the production function. Nothing here re-types the
// rule it is checking — a spec that restates the logic passes a revert.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type PermissionFallReason,
  afkJoinPlan,
  isAfkChannel,
  permissionFallReasons,
  publishToggleRefusal,
  voicePublishPermission,
} from "./afkPolicy.ts";

const CHANNEL = "01JAFKCHANNELAAAAAAAAAAAAA";
const OTHER = "01JOTHERCHANNELAAAAAAAAAAA";

test("the designation is pointer identity against the server's AFK channel", () => {
  assert.equal(isAfkChannel(CHANNEL, CHANNEL), true);
  assert.equal(isAfkChannel(OTHER, CHANNEL), false);
});

test("no designation never reads as AFK, whatever the channel", () => {
  // The shipped bug this replaces was name-keyed; the replacement must be
  // inert on every server that has not designated a channel.
  assert.equal(isAfkChannel(undefined, CHANNEL), false);
  assert.equal(isAfkChannel("", CHANNEL), false);
});

test("undefined === undefined must not report the user AFK", () => {
  // Before a channel is known AND with no designation, a bare `===` would be
  // true. This is the one input that makes both guards load-bearing.
  assert.equal(isAfkChannel(undefined, undefined), false);
  assert.equal(isAfkChannel(CHANNEL, undefined), false);
});

test("AFK denies the publish accessor even with the permission bit granted", () => {
  // 🔴 The backend gate is deliberately outside the permission calculus, so
  // `havePermission` is TRUE here — for the server owner it is true by
  // short-circuit and can never be anything else. If this ever passes with
  // the AFK term removed, the owner gets a working mic button in the AFK
  // channel and an opaque SFU refusal when they press it.
  assert.equal(
    voicePublishPermission({
      hasChannel: true,
      isPrivateChannel: false,
      isAfkChannel: true,
      havePermission: true,
    }),
    false,
  );
});

test("outside the AFK channel the permission bit still decides", () => {
  for (const havePermission of [true, false]) {
    assert.equal(
      voicePublishPermission({
        hasChannel: true,
        isPrivateChannel: false,
        isAfkChannel: false,
        havePermission,
      }),
      havePermission,
    );
  }
});

test("DMs and groups always publish; no channel never does", () => {
  assert.equal(
    voicePublishPermission({
      hasChannel: true,
      isPrivateChannel: true,
      isAfkChannel: false,
      havePermission: false,
    }),
    true,
  );
  assert.equal(
    voicePublishPermission({
      hasChannel: false,
      isPrivateChannel: false,
      isAfkChannel: false,
      havePermission: true,
    }),
    false,
  );
});

test("the toggle guard refuses an enable in the AFK channel", () => {
  // The defect being removed: join muted, press Unmute, you are live. The
  // guard is what makes the flag survive past the join handler.
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: true,
      permitted: false,
    }),
    "afk",
  );
});

test("the toggle guard never refuses a disable", () => {
  // 🔴 Turning something OFF must always work, or a designation change mid-
  // share would trap the sharer hot with a dead stop button.
  for (const isAfk of [true, false]) {
    for (const permitted of [true, false]) {
      assert.equal(
        publishToggleRefusal({
          enabling: false,
          isAfkChannel: isAfk,
          permitted,
        }),
        undefined,
      );
    }
  }
});

test("AFK is reported ahead of a plain permission denial", () => {
  // In the AFK channel the accessor is false too, so both rules apply. Saying
  // "denied" would tell the user they lack a permission they in fact hold.
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: true,
      permitted: true,
    }),
    "afk",
  );
});

test("a missing permission outside AFK reports denied, and a granted one passes", () => {
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: false,
      permitted: false,
    }),
    "denied",
  );
  assert.equal(
    publishToggleRefusal({
      enabling: true,
      isAfkChannel: false,
      permitted: true,
    }),
    undefined,
  );
});

test("the join plan keeps the microphone down in the AFK channel", () => {
  // All eight (deafened, micOn) x AFK combinations: under AFK nothing wants
  // the mic, the pipeline is not attached and the camera is forced off.
  for (const deafened of [true, false]) {
    for (const micOn of [true, false]) {
      const plan = afkJoinPlan({ isAfkChannel: true, deafened, micOn });
      assert.deepEqual(plan, {
        wantMic: false,
        attachMicPipeline: false,
        forceCameraOff: true,
      });
    }
  }
});

test("outside the AFK channel the join plan is the pre-AFK behaviour", () => {
  assert.deepEqual(
    afkJoinPlan({ isAfkChannel: false, deafened: false, micOn: true }),
    { wantMic: true, attachMicPipeline: true, forceCameraOff: false },
  );
  // Deafen still wins, and so does an explicit mute — AFK added a term, it
  // did not replace the persisted pre-call state.
  assert.equal(
    afkJoinPlan({ isAfkChannel: false, deafened: true, micOn: true }).wantMic,
    false,
  );
  assert.equal(
    afkJoinPlan({ isAfkChannel: false, deafened: false, micOn: false }).wantMic,
    false,
  );
});

const fall = (
  isAfkChannel: boolean,
  edges: Partial<Parameters<typeof permissionFallReasons>[0]> = {},
): PermissionFallReason[] =>
  permissionFallReasons({
    prevCanPublish: true,
    nowCanPublish: false,
    prevCanSubscribe: true,
    nowCanSubscribe: true,
    isAfkChannel,
    ...edges,
  });

test("an AFK publish revocation is not blamed on a moderator", () => {
  // 🔴 Under AFK the publish grant falls for everyone who enters, so the
  // shipped copy would tell every AFK member a moderator muted them.
  assert.deepEqual(fall(true), ["afk-publish"]);
  assert.deepEqual(fall(false), ["moderator-mute"]);
});

test("a rising or absent edge says nothing", () => {
  // The initial grant arrives as a change from undefined; a re-grant is not
  // an interruption.
  assert.deepEqual(
    fall(true, { prevCanPublish: undefined, nowCanPublish: true }),
    [],
  );
  assert.deepEqual(
    fall(false, { prevCanPublish: false, nowCanPublish: true }),
    [],
  );
  assert.deepEqual(
    fall(false, { prevCanPublish: true, nowCanPublish: true }),
    [],
  );
});

// --- Textual contract against state.tsx -----------------------------------
//
// `state.tsx` is ~9.8k lines and its class cannot be instantiated here (Solid
// signals, livekit `Room`, stoat.js client), so the wiring itself is
// unreachable by `node --test`. These two checks are the cheapest honest
// substitute: they hold the production file to CALLING the rules above rather
// than re-implementing them, which is the failure mode that lets a revert ship
// green. They are not a substitute for a live call — see the report.
const STATE = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");

test("state.tsx calls the extracted rules instead of restating them", () => {
  for (const fn of [
    "isAfkChannel(",
    "voicePublishPermission(",
    "publishToggleRefusal(",
    "afkJoinPlan(",
    "permissionFallReasons(",
  ]) {
    assert.ok(
      STATE.includes(fn),
      `state.tsx no longer calls ${fn} — the rule was inlined or dropped`,
    );
  }
});

test("the name-keyed AFK check is gone from state.tsx", () => {
  // The shipped implementation was `channel.name?.toLowerCase() === "afk"`.
  // Renaming any channel granted the behaviour; renaming the real one removed
  // it. If this string ever comes back, the server designation is being
  // second-guessed by a string compare.
  assert.ok(
    !/toLowerCase\(\)\s*===\s*"afk"/.test(STATE),
    'state.tsx still name-checks for "afk"',
  );
});

test("every publish entry point consults the guard", () => {
  // Four `publishToggleRefusal` call sites: toggleMute, toggleCamera,
  // toggleScreenshare and toggleDeafen. The fourth is not decoration —
  // pressing Unmute WHILE DEAFENED never enters toggleMute's body, it
  // delegates to toggleDeafen, so a three-site guard has a door in it. The
  // pre-AFK code had zero AFK references in any of them, which is why one
  // click defeated the whole feature.
  const calls = STATE.match(/publishToggleRefusal\(\{/g) ?? [];
  assert.equal(
    calls.length,
    4,
    `expected 4 guard call sites, saw ${calls.length}`,
  );
});

test("deafen is independent of AFK", () => {
  // AFK revokes publish, never subscribe — an AFK user who loses canSubscribe
  // really was deafened.
  assert.deepEqual(
    fall(true, { prevCanSubscribe: true, nowCanSubscribe: false }),
    ["afk-publish", "moderator-deafen"],
  );
  assert.deepEqual(
    fall(false, {
      prevCanPublish: true,
      nowCanPublish: true,
      prevCanSubscribe: true,
      nowCanSubscribe: false,
    }),
    ["moderator-deafen"],
  );
});
