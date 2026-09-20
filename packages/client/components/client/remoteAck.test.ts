// Unit spec for read-pointer sync in stoat.js — run with Node's built-in
// runner from packages/client:
//   node --test --conditions=browser components/client/remoteAck.test.ts
// Focus: a ChannelAck from another session of the same user must clear the
// local unread state (it used to be ignored, so badges stayed lit until a
// reload); the pointer must never move backwards; a failed ack request is
// retried unless a newer one superseded it; and a read still waiting on the
// debounce is sent with keepalive when the page hides.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { Client } from "stoat.js";

const ME = "01ME00000000000000000000000";
const OTHER = "01OTHER00000000000000000000";
const CHANNEL = "01CHANNEL000000000000000000";
const MSG = (n: number) => `01MSG${String(n).padStart(22, "0")}`;

/** A client with one text channel, read up to MSG(1) with two mentions. */
function setup() {
  const client = new Client({ syncUnreads: true, autoReconnect: false });
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

  client.channelUnreads.getOrCreate(CHANNEL, {
    _id: { channel: CHANNEL, user: ME },
    last_id: MSG(1),
    mentions: [MSG(5), MSG(9)],
  });
  client.channelUnreads.updateUnderlyingObject(CHANNEL, "unreadCount", 8);

  return { client, channel };
}

function remoteAck(client: Client, messageId: string, user = ME) {
  client.events.emit("event", {
    type: "ChannelAck",
    id: CHANNEL,
    user,
    message_id: messageId,
  } as never);
}

test("the fixture starts unread with a count and two mentions", () => {
  const { channel } = setup();
  assert.equal(channel.unread, true);
  assert.equal(channel.unreadCount, 8);
  assert.equal(channel.mentions?.size, 2);
});

test("a remote ack at the tail clears unread, count and mentions", () => {
  const { client, channel } = setup();
  remoteAck(client, MSG(9));
  assert.equal(channel.unread, false);
  assert.equal(channel.unreadCount, 0);
  assert.equal(channel.mentions?.size, 0);
  assert.equal(client.channelUnreads.get(CHANNEL)?.lastMessageId, MSG(9));
});

test("a partial remote ack moves the pointer and drops only older mentions", () => {
  const { client, channel } = setup();
  remoteAck(client, MSG(5));
  assert.equal(client.channelUnreads.get(CHANNEL)?.lastMessageId, MSG(5));
  assert.equal(channel.unread, true);
  assert.deepEqual([...(channel.mentions ?? [])], [MSG(9)]);
  // What is left past a partial pointer is unknown: zero renders as a dot.
  assert.equal(channel.unreadCount, 0);
});

test("the pointer never moves backwards", () => {
  const { client, channel } = setup();
  remoteAck(client, MSG(9));
  remoteAck(client, MSG(1));
  assert.equal(client.channelUnreads.get(CHANNEL)?.lastMessageId, MSG(9));
  assert.equal(channel.unread, false);
});

test("another user's ack is ignored", () => {
  const { client, channel } = setup();
  remoteAck(client, MSG(9), OTHER);
  assert.equal(channel.unread, true);
  assert.equal(channel.mentions?.size, 2);
});

test("channelAcknowledged still fires for listeners", () => {
  const { client } = setup();
  const seen: string[] = [];
  client.on("channelAcknowledged", (_channel, messageId) =>
    seen.push(messageId),
  );
  remoteAck(client, MSG(9));
  assert.deepEqual(seen, [MSG(9)]);
});

test("acknowledge() reports whether anything changed", () => {
  const { client } = setup();
  assert.equal(client.channelUnreads.acknowledge(CHANNEL, MSG(9)), true);
  assert.equal(client.channelUnreads.acknowledge(CHANNEL, MSG(9)), false);
});

test("the server's echo of this session's own ack is a no-op", () => {
  const { client, channel } = setup();
  (client.api as { put: unknown }).put = () => Promise.resolve(null);
  channel.ack(undefined, true, true);
  const before = client.channelUnreads.get(CHANNEL)?.lastMessageId;
  assert.equal(before, MSG(9));
  assert.equal(client.channelUnreads.acknowledge(CHANNEL, MSG(9)), false);
  remoteAck(client, MSG(9));
  assert.equal(client.channelUnreads.get(CHANNEL)?.lastMessageId, before);
  assert.equal(channel.unread, false);
});

test("a remote ack for a channel with no unread row still marks it read", () => {
  const { client } = setup();
  const fresh = client.channels.getOrCreate("01FRESH0000000000000000000", {
    _id: "01FRESH0000000000000000000",
    channel_type: "TextChannel",
    server: "01SERVER0000000000000000000",
    name: "fresh",
    last_message_id: MSG(3),
  } as never);
  assert.equal(fresh.unread, true, "no row means unread");
  client.events.emit("event", {
    type: "ChannelAck",
    id: fresh.id,
    user: ME,
    message_id: MSG(3),
  } as never);
  assert.equal(fresh.unread, false);
  assert.equal(client.channelUnreads.get(fresh.id)?.lastMessageId, MSG(3));
});

test("a failed ack request is retried, and gives up after three attempts", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client, channel } = setup();
    const calls: string[] = [];
    (client.api as { put: unknown }).put = (path: string) => {
      calls.push(path);
      return Promise.reject(new Error("502"));
    };

    channel.ack(undefined, true);
    return Promise.resolve()
      .then(() => {
        assert.equal(calls.length, 1);
        mock.timers.tick(2000);
      })
      .then(() => {
        assert.equal(calls.length, 2);
        mock.timers.tick(4000);
      })
      .then(() => {
        assert.equal(calls.length, 3);
        mock.timers.tick(10000);
      })
      .then(() => {
        assert.equal(calls.length, 3);
        assert.match(
          calls[0],
          new RegExp(`/channels/${CHANNEL}/ack/${MSG(9)}$`),
        );
      })
      .finally(() => mock.timers.reset());
  } catch (error) {
    mock.timers.reset();
    throw error;
  }
});

test("a retry is skipped once a newer ack has been requested", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client, channel } = setup();
    const calls: string[] = [];
    let fail = true;
    (client.api as { put: unknown }).put = (path: string) => {
      calls.push(path);
      return fail ? Promise.reject(new Error("502")) : Promise.resolve(null);
    };

    channel.ack(MSG(5), true);
    return Promise.resolve()
      .then(() => {
        fail = false;
        channel.ack(MSG(9), true);
      })
      .then(() => {
        mock.timers.tick(10000);
      })
      .then(() => {
        assert.deepEqual(
          calls.map((path) => path.split("/").pop()),
          [MSG(5), MSG(9)],
        );
      })
      .finally(() => mock.timers.reset());
  } catch (error) {
    mock.timers.reset();
    throw error;
  }
});

test("flushAcks sends a debounced ack with keepalive and cancels the timer", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client, channel } = setup();
    const puts: string[] = [];
    (client.api as { put: unknown }).put = (path: string) => {
      puts.push(path);
      return Promise.resolve(null);
    };
    const fetches: { url: string; init: RequestInit }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((url: string, init: RequestInit) => {
      fetches.push({ url, init });
      return Promise.resolve({ ok: true } as Response);
    }) as typeof fetch;

    try {
      channel.ack();
      assert.equal(puts.length, 0, "the request waits on the debounce");

      client.flushAcks();
      assert.equal(fetches.length, 1);
      assert.match(
        fetches[0].url,
        new RegExp(`/channels/${CHANNEL}/ack/${MSG(9)}$`),
      );
      assert.equal(fetches[0].init.method, "PUT");
      assert.equal(fetches[0].init.keepalive, true);

      mock.timers.tick(5000);
      assert.equal(puts.length, 0, "the debounced send was cancelled");
      assert.equal(fetches.length, 1);

      client.flushAcks();
      assert.equal(fetches.length, 1, "nothing pending, nothing sent");
    } finally {
      globalThis.fetch = realFetch;
    }
  } finally {
    mock.timers.reset();
  }
});
