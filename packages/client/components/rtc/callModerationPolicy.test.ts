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
  canOfferMove,
  hasCallModerationActions,
} from "./callModerationPolicy.ts";

/** A plain member of the call, ranked below the moderator. */
const subject = (
  overrides: Partial<CallModerationSubject> = {},
): CallModerationSubject => ({
  isSelf: false,
  isConnected: true,
  isInferiorToActor: true,
  ...overrides,
});

const perms = (
  overrides: Partial<CallModerationPermissions> = {},
): CallModerationPermissions => ({
  muteMembers: true,
  deafenMembers: true,
  moveMembersInSource: true,
  ...overrides,
});

/** Every permission withheld. */
const NONE: CallModerationPermissions = {
  muteMembers: false,
  deafenMembers: false,
  moveMembersInSource: false,
};

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
    callModerationActions(subject(), perms({ moveMembersInSource: false })),
    { mute: true, deafen: true, disconnect: false },
  );
});

test("server-level MoveMembers alone does not offer disconnect", () => {
  // `member_edit` checks MoveMembers on the SOURCE voice channel, so an actor
  // who holds it server-wide but has it overridden away on this channel is
  // refused. The call site reports that as `moveMembersInSource: false`, and
  // the entry must follow it rather than the server-level grant.
  const actions = callModerationActions(
    subject({ isConnected: true }),
    perms({ moveMembersInSource: false }),
  );
  assert.equal(actions.disconnect, false);
});

test("MoveMembers on the source channel offers disconnect", () => {
  // The reverse: a channel override granting MoveMembers on this voice channel
  // is enough, whatever the server-level value.
  const actions = callModerationActions(subject({ isConnected: true }), {
    ...NONE,
    moveMembersInSource: true,
  });
  assert.deepEqual(actions, { mute: false, deafen: false, disconnect: true });
});

test("disconnect needs someone actually in the call", () => {
  // Clearing VoiceChannel for a member with no voice state no-ops server-side,
  // so the entry would report success and do nothing. Mute and deafen stay:
  // those are stored on the member and hold for their next join.
  const actions = callModerationActions(
    subject({ isConnected: false }),
    perms(),
  );
  assert.deepEqual(actions, { mute: true, deafen: true, disconnect: false });
});

test("an unresolved rank offers nothing", () => {
  // The call site passes false while the member is uncached or partial: a
  // partial has no roles yet and would otherwise read as the lowest rank,
  // making everyone — including admins — look safe to moderate.
  const actions = callModerationActions(
    subject({ isInferiorToActor: false }),
    perms(),
  );
  assert.equal(hasCallModerationActions(actions), false);
});

test("no permissions at all offers nothing", () => {
  const actions = callModerationActions(subject(), NONE);
  assert.equal(hasCallModerationActions(actions), false);
});

test("move: no server context offers no move", () => {
  // A DM or group call has no other voice channel to go to, and undefined
  // must never read as "allowed".
  assert.equal(canOfferMove(subject(), undefined), false);
  assert.equal(canOfferMove(subject({ isSelf: true }), undefined), false);
});

test("move: someone not in voice is not movable", () => {
  // `member_edit` refuses with NotConnected, for others and for ourselves.
  assert.equal(canOfferMove(subject({ isConnected: false }), perms()), false);
  assert.equal(
    canOfferMove(subject({ isSelf: true, isConnected: false }), perms()),
    false,
  );
});

test("move: yourself needs no permission here", () => {
  // A self-move is a plain channel switch: Connect on the destination only,
  // no rank check. Rank is passed as false to prove it is not consulted.
  assert.equal(
    canOfferMove(
      subject({ isSelf: true, isConnected: true, isInferiorToActor: false }),
      NONE,
    ),
    true,
  );
});

test("move: someone else needs rank and MoveMembers on the source", () => {
  assert.equal(
    canOfferMove(subject(), { ...NONE, moveMembersInSource: true }),
    true,
  );
});

test("move: someone else at or above you is not movable", () => {
  // NotElevated, whatever permissions the actor holds.
  assert.equal(
    canOfferMove(subject({ isInferiorToActor: false }), perms()),
    false,
  );
});

test("move: someone else without MoveMembers on the source is not movable", () => {
  // Mute and deafen are server-level and say nothing about moving.
  assert.equal(
    canOfferMove(subject(), perms({ moveMembersInSource: false })),
    false,
  );
});
