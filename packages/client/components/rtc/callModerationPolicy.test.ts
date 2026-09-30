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

/** A plain (human) member of the call, ranked below the moderator. */
const subject = (
  overrides: Partial<CallModerationSubject> = {},
): CallModerationSubject => ({
  isSelf: false,
  isConnected: true,
  isInferiorToActor: true,
  isBot: false,
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

/**
 * Every subject shape and permission set the bot specs sweep, so a bot rule
 * that only holds for the default subject cannot pass.
 */
const SWEEP_SUBJECTS: CallModerationSubject[] = [false, true].flatMap(
  (isSelf) =>
    [false, true].flatMap((isConnected) =>
      [false, true].map((isInferiorToActor) =>
        subject({ isSelf, isConnected, isInferiorToActor }),
      ),
    ),
);
const SWEEP_PERMISSIONS: (CallModerationPermissions | undefined)[] = [
  undefined,
  NONE,
  perms(),
  perms({ muteMembers: false }),
  perms({ deafenMembers: false }),
  perms({ moveMembersInSource: false }),
  { ...NONE, moveMembersInSource: true },
];

test("move: a bot is never movable, even by a moderator holding everything", () => {
  // `member_edit` refuses any move of a bot with IsBot (400). The same
  // subject as a human IS movable, so the bot flag alone withholds it.
  assert.equal(canOfferMove(subject(), perms()), true);
  assert.equal(canOfferMove(subject({ isBot: true }), perms()), false);
});

test("move: a bot cannot be offered a move of itself", () => {
  // The API refuses a bot moving itself with IsBot too, so the self path
  // (which otherwise needs no permission) must not reopen it.
  const self = { isSelf: true, isInferiorToActor: false };
  assert.equal(canOfferMove(subject(self), NONE), true);
  assert.equal(canOfferMove(subject({ ...self, isBot: true }), NONE), false);
});

test("move: no subject shape or permission set offers a move for a bot", () => {
  let humanMovable = 0;
  for (const base of SWEEP_SUBJECTS) {
    for (const permissions of SWEEP_PERMISSIONS) {
      if (canOfferMove(base, permissions)) humanMovable++;
      assert.equal(
        canOfferMove({ ...base, isBot: true }, permissions),
        false,
        JSON.stringify({ base, permissions }),
      );
    }
  }
  // Not vacuous: some of these shapes are movable as a human.
  assert.ok(humanMovable > 0);
});

test("a bot's moderation entries match a human's, disconnect included", () => {
  // Only MOVING a bot is refused. Disconnecting one (`remove:
  // ["VoiceChannel"]`) never reaches the IsBot check, and mute and deafen are
  // member edits like any other, so every entry follows the same rules.
  let disconnectOffered = 0;
  for (const base of SWEEP_SUBJECTS) {
    for (const permissions of SWEEP_PERMISSIONS) {
      const human = callModerationActions(base, permissions);
      if (human.disconnect) disconnectOffered++;
      assert.deepEqual(
        callModerationActions({ ...base, isBot: true }, permissions),
        human,
        JSON.stringify({ base, permissions }),
      );
    }
  }
  // Not vacuous: disconnect is offered for some of these shapes.
  assert.ok(disconnectOffered > 0);
});

test("a bot a moderator could disconnect is offered Disconnect but not Move", () => {
  const bot = subject({ isBot: true });
  assert.deepEqual(callModerationActions(bot, perms()), {
    mute: true,
    deafen: true,
    disconnect: true,
  });
  assert.equal(canOfferMove(bot, perms()), false);
});

test("isBot is a required field", () => {
  // A call site that leaves it out must fail to compile rather than offer a
  // move the server refuses. tsc checks this directive; if `isBot` ever
  // became optional the directive would be unused, which tsc reports.
  // @ts-expect-error -- isBot is missing
  const missing: CallModerationSubject = {
    isSelf: false,
    isConnected: true,
    isInferiorToActor: true,
  };
  assert.equal("isBot" in missing, false);
});
