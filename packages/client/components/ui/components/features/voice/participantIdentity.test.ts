// Specs for the participant-identity grammar, including SCREEN LEGS (the
// Android screen-share plan §0.2 / §6.1-6.2) — run with Node's built-in
// runner:
//   node --test components/ui/components/features/voice/participantIdentity.test.ts
//
// Per-user audio settings (mute / volume, person and screenshare alike) are
// stored under the bare user id, but the SFU identity is device-qualified on
// encrypted calls. Every settings read must go through `participantUserId`;
// a raw identity key misses the store and the control is silently inert.
//
// Three further properties are load-bearing rather than cosmetic:
//  1. the two-segment `user:screen` is NOT a leg (§0-R.3) — reading it as one
//     would silently reattribute the primary of a device named "screen";
//  2. `identityForUserId` skips legs, because remote control binds per-peer
//     trust to the FIRST match and SFU listing order can put the leg first;
//  3. `dropLegPlaceholders` drops only PLACEHOLDERS — the leg's real
//     screen-share publication is the feature, and filtering it would ship a
//     share nobody can see.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  dropLegPlaceholders,
  identityForUserId,
  isScreenLeg,
  participantLeg,
  participantUserId,
  remoteParticipantUserIds,
  stripLeg,
} from "./participantIdentity.ts";

const DEV = "0123456789abcdef0123456789abcdef";

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

test("participantUserId takes segment 0 for all three identity shapes", () => {
  assert.equal(participantUserId("01ALICE"), "01ALICE");
  assert.equal(participantUserId(`01ALICE:${DEV}`), "01ALICE");
  // A leg resolves to its owner's user for display, unchanged.
  assert.equal(participantUserId(`01ALICE:${DEV}:screen`), "01ALICE");
  assert.equal(participantUserId("01ALICE::screen"), "01ALICE");
});

test("a leg is exactly three segments; the rev-1 two-segment form is not one", () => {
  assert.equal(isScreenLeg(`01ALICE:${DEV}:screen`), true);
  assert.equal(participantLeg(`01ALICE:${DEV}:screen`), "screen");

  // Bare-primary grammar: an EMPTY device segment, still three segments.
  assert.equal(isScreenLeg("01ALICE::screen"), true);

  // Primaries.
  assert.equal(isScreenLeg("01ALICE"), false);
  assert.equal(isScreenLeg(`01ALICE:${DEV}`), false);
  assert.equal(participantLeg(`01ALICE:${DEV}`), undefined);

  // 🔴 §0-R.3: `01ALICE:screen` is the legitimate primary of a device whose id
  // is "screen". Treating it as a leg would canonicalize a real participant
  // onto a bare user id — exempting them from the non-enrolled check and
  // hiding their lock badge.
  assert.equal(isScreenLeg("01ALICE:screen"), false);
  assert.equal(stripLeg("01ALICE:screen"), "01ALICE:screen");

  // A fourth segment is not the grammar either.
  assert.equal(isScreenLeg(`01ALICE:${DEV}:screen:screen`), false);
});

test("stripLeg inverts the grammar and is idempotent on primaries", () => {
  assert.equal(stripLeg(`01ALICE:${DEV}:screen`), `01ALICE:${DEV}`);
  assert.equal(stripLeg("01ALICE::screen"), "01ALICE");

  // Idempotent — safe to apply on an already-primary identity, which is what
  // lets call sites use it unconditionally.
  assert.equal(stripLeg(`01ALICE:${DEV}`), `01ALICE:${DEV}`);
  assert.equal(stripLeg("01ALICE"), "01ALICE");
  assert.equal(stripLeg(stripLeg(`01ALICE:${DEV}:screen`)), `01ALICE:${DEV}`);
});

test("remoteParticipantUserIds skips legs and still dedupes by user", () => {
  const participants = [
    { identity: `01ALICE:${DEV}` },
    { identity: `01BOB:${DEV}` },
    { identity: `01BOB:${DEV}:screen` },
    { identity: "01SELF:dev" },
  ];
  assert.deepEqual(remoteParticipantUserIds(participants, "01SELF"), [
    "01ALICE",
    "01BOB",
  ]);

  // A user present ONLY as a leg is not an offer target: the leg is minted
  // can_subscribe:false and holds no session to route an offer to.
  assert.deepEqual(
    remoteParticipantUserIds([{ identity: "01GHOST::screen" }], "01SELF"),
    [],
  );
});

test("identityForUserId never returns a leg, whatever the listing order", () => {
  // 🔴 The leg FIRST — the order that breaks a naive first-match. LiveKit
  // lists participants in join order and a phone's leg can join before its
  // primary reconnects.
  const legFirst = [
    { identity: `01BOB:${DEV}:screen` },
    { identity: `01BOB:${DEV}` },
  ];
  assert.equal(identityForUserId(legFirst, "01BOB"), `01BOB:${DEV}`);

  // Primary first — same answer.
  assert.equal(
    identityForUserId([...legFirst].reverse(), "01BOB"),
    `01BOB:${DEV}`,
  );

  // Only a leg present ⇒ no bindable identity, rather than an unusable one.
  assert.equal(identityForUserId([{ identity: "01BOB::screen" }], "01BOB"), "");

  // Unrelated user unaffected.
  assert.equal(identityForUserId(legFirst, "01ALICE"), "");
});

test("dropLegPlaceholders drops only the leg's synthesized placeholders", () => {
  const pub = { source: "screen_share" };
  const tracks = [
    // A real camera track from a primary — kept.
    { participant: { identity: `01ALICE:${DEV}` }, publication: pub },
    // A camera PLACEHOLDER for a primary with no camera — kept (that is the
    // ordinary avatar tile every non-video participant gets).
    { participant: { identity: `01BOB:${DEV}` } },
    // The leg's REAL screen-share publication — kept. This tile is the feature.
    { participant: { identity: `01BOB:${DEV}:screen` }, publication: pub },
    // The leg's phantom camera placeholder — DROPPED. Without this the sharer
    // appears twice in the grid: once properly, once as a muted avatar.
    { participant: { identity: `01BOB:${DEV}:screen` } },
    // Same for the bare-primary grammar.
    { participant: { identity: "01CAROL::screen" } },
  ];

  const kept = dropLegPlaceholders(tracks);
  assert.equal(kept.length, 3);
  assert.deepEqual(
    kept.map((t) => t.participant.identity),
    [`01ALICE:${DEV}`, `01BOB:${DEV}`, `01BOB:${DEV}:screen`],
  );

  // Non-destructive and stable when there is no leg at all.
  const noLegs = tracks.slice(0, 2);
  assert.deepEqual(dropLegPlaceholders(noLegs), noLegs);
  assert.deepEqual(dropLegPlaceholders([]), []);
});
