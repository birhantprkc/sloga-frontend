// Specs for the call-moderation menu gate — run with Node's built-in runner:
//   node --test components/rtc/callModerationPolicy.test.ts
//
// Each rule here stands in for a refusal the API would otherwise produce, so
// the specs pin both directions: an entry offered where `member_edit` says no
// is a dead button, and an entry withheld where it says yes is a moderator
// locked out of their own server.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type CallModerationPermissions,
  type CallModerationSubject,
  callModerationActions,
  hasCallModerationActions,
} from "./callModerationPolicy.ts";

/** A plain member of the call, ranked below the moderator. */
const subject = (
  overrides: Partial<CallModerationSubject> = {},
): CallModerationSubject => ({
  isSelf: false,
  isConnected: true,
  isInferiorToActor: true,
  serverMuted: false,
  serverDeafened: false,
  ...overrides,
});

const perms = (
  overrides: Partial<CallModerationPermissions> = {},
): CallModerationPermissions => ({
  muteMembers: true,
  deafenMembers: true,
  moveMembers: true,
  ...overrides,
});

test("a moderator with every permission gets every entry", () => {
  const actions = callModerationActions(subject(), perms());
  assert.deepEqual(actions, { mute: true, deafen: true, disconnect: true });
  assert.equal(hasCallModerationActions(actions), true);
});

test("no server context offers nothing", () => {
  // A DM or group call. Undefined permissions must read as "no moderators
  // here", never as "not loaded yet, allow".
  const actions = callModerationActions(subject(), undefined);
  assert.deepEqual(actions, { mute: false, deafen: false, disconnect: false });
  assert.equal(hasCallModerationActions(actions), false);
});

test("never offered against yourself", () => {
  const actions = callModerationActions(subject({ isSelf: true }), perms());
  assert.equal(hasCallModerationActions(actions), false);
});

test("rank gates all three, whatever the permissions say", () => {
  // `member_edit` refuses with NotElevated before it looks at permissions, so
  // a peer or a superior must produce an empty menu even for an owner-ish
  // actor holding everything.
  const actions = callModerationActions(
    subject({ isInferiorToActor: false }),
    perms(),
  );
  assert.deepEqual(actions, { mute: false, deafen: false, disconnect: false });
});

test("each permission gates only its own entry", () => {
  assert.deepEqual(
    callModerationActions(subject(), perms({ muteMembers: false })),
    { mute: false, deafen: true, disconnect: true },
  );
  assert.deepEqual(
    callModerationActions(subject(), perms({ deafenMembers: false })),
    { mute: true, deafen: false, disconnect: true },
  );
  assert.deepEqual(
    callModerationActions(subject(), perms({ moveMembers: false })),
    { mute: true, deafen: true, disconnect: false },
  );
});

test("disconnect needs someone actually in the call", () => {
  // The API refuses a disconnect for a member with no voice state, so the
  // entry must go — while mute and deafen stay, since those are stored on the
  // member and hold for their next join.
  const actions = callModerationActions(
    subject({ isConnected: false }),
    perms(),
  );
  assert.deepEqual(actions, { mute: true, deafen: true, disconnect: false });
});

test("the mute entry is offered while already muted, so it can be lifted", () => {
  // The toggle has to render in BOTH states or a server mute becomes
  // permanent from the UI's point of view.
  const actions = callModerationActions(
    subject({ serverMuted: true, serverDeafened: true }),
    perms(),
  );
  assert.deepEqual(actions, { mute: true, deafen: true, disconnect: true });
});

test("no permissions at all offers nothing", () => {
  const actions = callModerationActions(
    subject(),
    perms({ muteMembers: false, deafenMembers: false, moveMembers: false }),
  );
  assert.equal(hasCallModerationActions(actions), false);
});
