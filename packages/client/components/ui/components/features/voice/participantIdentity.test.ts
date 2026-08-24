// node --experimental-strip-types --conditions=browser --test components/ui/components/features/voice/participantIdentity.test.ts
//
// Per-user audio settings (mute / volume, person and screenshare alike) are
// stored under the bare user id, but the SFU identity is device-qualified on
// encrypted calls. Every settings read must go through `participantUserId`;
// a raw identity key misses the store and the control is silently inert.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  identityForUserId,
  participantUserId,
  remoteParticipantUserIds,
} from "./participantIdentity.ts";

test("strips the device qualifier from an encrypted-call identity", () => {
  assert.equal(participantUserId("01ABCDEF:device123"), "01ABCDEF");
});

test("passes a bare user id through unchanged (plaintext calls)", () => {
  assert.equal(participantUserId("01ABCDEF"), "01ABCDEF");
});

test("is idempotent, so double-stripping is safe", () => {
  assert.equal(
    participantUserId(participantUserId("01ABCDEF:device123")),
    "01ABCDEF",
  );
});

test("keeps only the first segment when the device half contains colons", () => {
  assert.equal(participantUserId("01ABCDEF:a:b"), "01ABCDEF");
});

test("dedupes a user joined on two devices to one row", () => {
  const users = remoteParticipantUserIds(
    [
      { identity: "01AAA:desktop" },
      { identity: "01AAA:phone" },
      { identity: "01BBB:desktop" },
      { identity: "01ME:desktop" },
    ],
    "01ME",
  );
  assert.deepEqual(users, ["01AAA", "01BBB"]);
});

test("identityForUserId returns the full device-qualified identity", () => {
  const participants = [
    { identity: "01AAA:desktop" },
    { identity: "01BBB" },
  ];
  assert.equal(identityForUserId(participants, "01AAA"), "01AAA:desktop");
  assert.equal(identityForUserId(participants, "01BBB"), "01BBB");
  assert.equal(identityForUserId(participants, "01CCC"), "");
});
