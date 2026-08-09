// Unit spec for the friends-list voice lookup — run with Node's built-in
// runner:
//   node --test components/client/voicePresence.test.ts   (Node >=23.6 strips types)
// `voicePresence.ts` imports nothing at runtime (its stoat.js imports are
// type-only), so a hand-rolled stub client is enough and this stays fast.
//
// What is worth pinning: the lookup must MISS silently rather than guess.
// Everything it cannot see — a call in a server we are not in — has to come
// back `undefined`, because the friends row treats "no channel" as "safe to
// ring". A lookup that got creative here would tell people not to call someone
// who is perfectly free.
import assert from "node:assert/strict";
import { test } from "node:test";

import { voiceChannelOf } from "./voicePresence.ts";

/**
 * Minimal stand-in for a Channel: an id plus the roster the real one exposes
 * as a ReactiveMap. Only `has` is reached.
 */
const channel = (id: string, participants: string[]) => ({
  id,
  voiceParticipants: new Map(participants.map((user) => [user, {}])),
});

/**
 * Minimal stand-in for a Client: only `channels.values()` is reached.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = (...channels: ReturnType<typeof channel>[]): any => ({
  channels: { values: () => channels.values() },
});

test("finds the channel whose roster holds the user", () => {
  const general = channel("general", ["alice", "bob"]);
  const found = voiceChannelOf(
    client(channel("empty", []), general, channel("other", ["carol"])),
    "bob",
  );

  assert.equal(found?.id, "general");
});

test("a user in no roster is not in voice", () => {
  const found = voiceChannelOf(
    client(channel("general", ["alice"]), channel("other", ["carol"])),
    "bob",
  );

  assert.equal(found, undefined);
});

test("empty rosters never match", () => {
  // A channel whose call has ended keeps its entry with an empty roster; it
  // must not be mistaken for one somebody is sitting in.
  assert.equal(
    voiceChannelOf(client(channel("general", [])), "bob"),
    undefined,
  );
});

test("no visible channels at all is not in voice", () => {
  // The shape of the invisible-server case: the friend IS in a call, we simply
  // never received the roster for it. Must read as free, not as an error.
  assert.equal(voiceChannelOf(client(), "bob"), undefined);
});

test("a DM roster counts the same as a server channel", () => {
  // DM and group calls are ordinary voice channels here — the friends row
  // falls back to the bare label for them because they have no name, but the
  // lookup itself must not treat them differently.
  const dm = channel("dm", ["bob"]);

  assert.equal(voiceChannelOf(client(dm), "bob")?.id, "dm");
});
