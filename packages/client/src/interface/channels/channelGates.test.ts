// Unit spec for the shared channel-gate check — run with Node's built-in runner:
//   node --test src/interface/channels/channelGates.test.ts   (Node >=23.6 strips types)
// Focus: the server sidebar's member list asks this before rendering, so a
// gated channel must read as gated until its own gate has been passed.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  gateSource,
  isChannelGated,
  passwordGateKey,
  spoilerGateKey,
} from "./channelGates.ts";

const MATURE = "MATURE";
const plain = { id: "c1", mature: false, isSpoiler: false, hasPassword: false };
const flags =
  (...set: string[]) =>
  (key: string) =>
    set.includes(key);

test("an ungated channel is never gated", () => {
  assert.equal(isChannelGated(plain, flags(), MATURE), false);
});

test("a mature channel is gated until the age attestation is set", () => {
  const channel = { ...plain, mature: true };
  assert.equal(isChannelGated(channel, flags(), MATURE), true);
  assert.equal(isChannelGated(channel, flags(MATURE), MATURE), false);
});

test("a password channel is gated until THIS channel is unlocked", () => {
  const channel = { ...plain, hasPassword: true };
  assert.equal(isChannelGated(channel, flags(), MATURE), true);
  assert.equal(
    isChannelGated(channel, flags(passwordGateKey("other")), MATURE),
    true,
    "another channel's unlock does not count",
  );
  assert.equal(
    isChannelGated(channel, flags(passwordGateKey("c1")), MATURE),
    false,
  );
});

test("a spoiler channel is gated until THIS channel is revealed", () => {
  const channel = { ...plain, isSpoiler: true };
  assert.equal(isChannelGated(channel, flags(), MATURE), true);
  assert.equal(
    isChannelGated(channel, flags(spoilerGateKey("c1")), MATURE),
    false,
  );
});

test("every gate on a channel has to be passed", () => {
  const channel = {
    ...plain,
    mature: true,
    hasPassword: true,
    isSpoiler: true,
  };
  assert.equal(
    isChannelGated(channel, flags(MATURE, passwordGateKey("c1")), MATURE),
    true,
    "the spoiler gate still stands",
  );
  assert.equal(
    isChannelGated(
      channel,
      flags(MATURE, passwordGateKey("c1"), spoilerGateKey("c1")),
      MATURE,
    ),
    false,
  );
});

test("a thread answers to its parent's gates", () => {
  type C = { id: string; isThread: boolean; parent?: C };
  const forum: C = { id: "forum", isThread: false };
  const post: C = { id: "post", isThread: true, parent: forum };
  assert.equal(gateSource(post), forum);
  assert.equal(gateSource(forum), forum, "a non-thread is its own source");
  const orphan: C = { id: "orphan", isThread: true };
  assert.equal(
    gateSource(orphan),
    orphan,
    "a thread whose parent is not loaded falls back to itself",
  );
});

test("the keys match what the gates have always stored", () => {
  // Changing these would re-lock every channel a user already passed.
  assert.equal(passwordGateKey("abc"), "abc-pw");
  assert.equal(spoilerGateKey("abc"), "abc-spoiler");
});
