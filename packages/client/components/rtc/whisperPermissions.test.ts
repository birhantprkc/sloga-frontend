// Specs for the whisper permission table — run with Node's built-in runner:
//   node --test components/rtc/whisperPermissions.test.ts
//
// The table is the security boundary of the whole feature (the SFU forwards
// exactly what it grants), so the specs pin its failure directions: a
// non-target must NEVER gain the whisper track, and the target must never
// lose it — across device-qualified identities, roster changes, and the
// "newer tracks get nothing" default the controller relies on.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeWhisperPermissions,
  whisperTarget,
  whisperTrackName,
} from "./whisperPermissions.ts";

test("track names address a user and roundtrip", () => {
  assert.equal(whisperTrackName("01ABC"), "whisper:01ABC");
  assert.equal(whisperTarget("whisper:01ABC"), "01ABC");
  assert.equal(whisperTarget("microphone"), undefined);
  assert.equal(whisperTarget(undefined), undefined);
  // A bare prefix addresses nobody rather than "everyone".
  assert.equal(whisperTarget("whisper:"), undefined);
});

test("target gets allowAll, others get pinned sids only", () => {
  const perms = computeWhisperPermissions(
    "bob",
    ["alice:dev1", "bob:dev1", "bob:dev2", "carol"],
    ["TR_mic", "TR_cam"],
  );

  const byIdentity = new Map(perms.map((p) => [p.participantIdentity, p]));
  assert.equal(perms.length, 4);

  // Both of bob's devices may subscribe to everything, present and future.
  assert.deepEqual(byIdentity.get("bob:dev1"), {
    participantIdentity: "bob:dev1",
    allowAll: true,
  });
  assert.deepEqual(byIdentity.get("bob:dev2"), {
    participantIdentity: "bob:dev2",
    allowAll: true,
  });

  // Everyone else is pinned to the explicit normal-track list — the whisper
  // track's sid is absent, and (per LiveKit semantics) so is any track
  // published later, until the controller re-pushes.
  assert.deepEqual(byIdentity.get("alice:dev1"), {
    participantIdentity: "alice:dev1",
    allowedTrackSids: ["TR_mic", "TR_cam"],
  });
  assert.deepEqual(byIdentity.get("carol"), {
    participantIdentity: "carol",
    allowedTrackSids: ["TR_mic", "TR_cam"],
  });
});

test("a user id that merely prefixes another does not match", () => {
  // "bob" whispered-to must not grant "bobby" anything.
  const perms = computeWhisperPermissions("bob", ["bobby:dev1"], ["TR_mic"]);
  assert.deepEqual(perms, [
    { participantIdentity: "bobby:dev1", allowedTrackSids: ["TR_mic"] },
  ]);
});

test("empty roster and empty track list still shape correctly", () => {
  assert.deepEqual(computeWhisperPermissions("bob", [], []), []);
  // No normal tracks published (all-muted PTT user): others get an EMPTY
  // allow list, not a missing entry — omitted participants would get nothing,
  // but an explicit empty list is the same and keeps the table total.
  assert.deepEqual(computeWhisperPermissions("bob", ["carol"], []), [
    { participantIdentity: "carol", allowedTrackSids: [] },
  ]);
});
