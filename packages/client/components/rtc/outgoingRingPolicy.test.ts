// Unit spec for the outgoing-ring policy — run with Node's built-in runner:
//   node --test components/rtc/outgoingRingPolicy.test.ts   (Node >=23.6 strips types)
// Focus: the caller rings exactly when their join OPENS a DM/Group call, and
// every signalled end of ringing (answer, cancel) maps to a stop — the
// unsignalled ends (decline, unanswered) are the ringtone's own 30-ring stop
// and have no case here to get wrong.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isRingableChannelType,
  outgoingRingOnVoiceJoin,
  outgoingRingOnVoiceLeave,
} from "./outgoingRingPolicy.ts";

test("only DM and Group channels are ringable", () => {
  assert.equal(isRingableChannelType("DirectMessage"), true);
  assert.equal(isRingableChannelType("Group"), true);
  // Server voice channels summon no one — joining one must never ring, which
  // was easy to get wrong because the SAME join event fires for them.
  assert.equal(isRingableChannelType("VoiceChannel"), false);
  assert.equal(isRingableChannelType("TextChannel"), false);
  assert.equal(isRingableChannelType("SavedMessages"), false);
});

test("our join that opens the call rings the outgoing leg", () => {
  for (const channelType of ["DirectMessage", "Group"] as const) {
    assert.equal(
      outgoingRingOnVoiceJoin({
        channelType,
        joinerIsSelf: true,
        selfIsParticipant: true,
        participantCount: 1,
      }),
      "play",
      channelType,
    );
  }
});

test("our join into an ongoing call is answering, not calling", () => {
  // Answering must stop any ring (this is the path that kills the INCOMING
  // ring when we accept) — playing the outgoing ring here would ring INTO
  // the live call.
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "DirectMessage",
      joinerIsSelf: true,
      selfIsParticipant: true,
      participantCount: 2,
    }),
    "stop",
  );
});

test("the callee answering stops the outgoing ring", () => {
  // Their join arrives with us already in the roster: participantCount 2 in
  // a DM, more in a group call.
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "DirectMessage",
      joinerIsSelf: false,
      selfIsParticipant: true,
      participantCount: 2,
    }),
    "stop",
  );
  // A later joiner of an ongoing group call also lands here — stop must be
  // the action (a harmless no-op), never "play".
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "Group",
      joinerIsSelf: false,
      selfIsParticipant: true,
      participantCount: 3,
    }),
    "stop",
  );
});

test("a call we are not in is the incoming side's business", () => {
  // Someone ringing US must not touch the outgoing leg — the incoming ring
  // and popup are NotificationsWorker's own path.
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "DirectMessage",
      joinerIsSelf: false,
      selfIsParticipant: false,
      participantCount: 1,
    }),
    "none",
  );
});

test("server voice channel joins never ring, even our own solo join", () => {
  assert.equal(
    outgoingRingOnVoiceJoin({
      channelType: "VoiceChannel",
      joinerIsSelf: true,
      selfIsParticipant: true,
      participantCount: 1,
    }),
    "none",
  );
});

test("our own leave cancels the outgoing ring", () => {
  assert.equal(
    outgoingRingOnVoiceLeave({
      channelType: "DirectMessage",
      leaverIsSelf: true,
    }),
    "stop",
  );
  assert.equal(
    outgoingRingOnVoiceLeave({ channelType: "Group", leaverIsSelf: true }),
    "stop",
  );
});

test("remote leaves and non-ringable channels leave the ring alone", () => {
  assert.equal(
    outgoingRingOnVoiceLeave({
      channelType: "DirectMessage",
      leaverIsSelf: false,
    }),
    "none",
  );
  assert.equal(
    outgoingRingOnVoiceLeave({
      channelType: "VoiceChannel",
      leaverIsSelf: true,
    }),
    "none",
  );
});
