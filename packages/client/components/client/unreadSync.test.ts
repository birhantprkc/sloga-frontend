// Unit spec for the connect-time unread seed in stoat.js — run with Node's
// built-in runner from packages/client:
//   node --test --conditions=browser components/client/unreadSync.test.ts
//
// Focus: `/sync/unreads` is the server's read pointer and must win, even when
// the collection already holds a row for that channel.
//
// It normally does hold one. `Channel.unread` reaches `channelUnreads.for()`,
// which CREATES a placeholder row (last_id null, i.e. fully unread) for any
// channel it is asked about. The Ready handler hydrates every channel in a
// batch, Solid flushes effects, and only then awaits `/sync/unreads`, while
// the taskbar badge effect mounts outside the lifecycle gate and reads every
// server's unread state. So a placeholder for every visible channel is the
// ordinary case, not a corner one — and `sync()` used to hand those straight
// back via `getOrCreate` and drop the server's pointer on the floor, leaving
// channels with nothing new in them lit for the whole session, every launch.
import assert from "node:assert/strict";
import { test } from "node:test";

import { offlineClient } from "./offlineClient.ts";

const ME = "01ME00000000000000000000000";
const CHANNEL = "01CHANNEL000000000000000000";
const MSG = (n: number) => `01MSG${String(n).padStart(22, "0")}`;

/** One text channel whose tail is MSG(9); the server reports it fully read. */
function setup() {
  const client = offlineClient({ syncUnreads: true, autoReconnect: false });
  client.user = client.users.getOrCreate(ME, {
    _id: ME,
    username: "me",
    discriminator: "0001",
    relationship: "User",
    online: true,
  } as never);

  const channel = client.channels.getOrCreate(CHANNEL, {
    _id: CHANNEL,
    channel_type: "TextChannel",
    server: "01SERVER0000000000000000000",
    name: "general",
    last_message_id: MSG(9),
  } as never);

  (client.api as unknown as { get: unknown }).get = async (path: string) => {
    if (path === "/sync/unreads")
      return [
        { _id: { channel: CHANNEL, user: ME }, last_id: MSG(9), mentions: [] },
      ];
    throw new Error(`unexpected request: ${path}`);
  };

  return { client, channel };
}

test("an unknown channel reads as unread before the seed arrives", () => {
  const { channel } = setup();
  assert.equal(channel.unread, true);
});

test("sync() applies the server pointer to a collection with no row", async () => {
  const { client, channel } = setup();
  await client.channelUnreads.sync();
  assert.equal(channel.unread, false);
});

test("sync() overwrites the placeholder a pre-seed read left behind", async () => {
  const { client, channel } = setup();
  // The badge effect touches the channel while /sync/unreads is in flight,
  // which creates the placeholder row via `for()`.
  assert.equal(channel.unread, true);
  await client.channelUnreads.sync();
  assert.equal(
    channel.unread,
    false,
    "the server's read pointer must win over a placeholder",
  );
});

test("sync() overwrites a stale pointer from an earlier connect", async () => {
  const { client, channel } = setup();
  client.channelUnreads.getOrCreate(CHANNEL, {
    _id: { channel: CHANNEL, user: ME },
    last_id: MSG(1),
    mentions: [MSG(5)],
  });
  assert.equal(channel.unread, true);
  await client.channelUnreads.sync();
  assert.equal(channel.unread, false, "a reconnect must re-seed, not keep");
  assert.equal(client.channelUnreads.get(CHANNEL)?.lastMessageId, MSG(9));
});

test("reset() empties the collection", () => {
  const { client } = setup();
  client.channelUnreads.getOrCreate(CHANNEL, {
    _id: { channel: CHANNEL, user: ME },
    last_id: MSG(1),
    mentions: [],
  });
  assert.equal(client.channelUnreads.has(CHANNEL), true);
  client.channelUnreads.reset();
  assert.equal(client.channelUnreads.has(CHANNEL), false);
});
