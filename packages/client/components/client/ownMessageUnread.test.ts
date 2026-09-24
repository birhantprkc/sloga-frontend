// Unit spec for "your own last message shows as unread" in stoat.js — run
// with Node's built-in runner from packages/client:
//   node --test --conditions=browser components/client/ownMessageUnread.test.ts
//
// Focus: the server acks the author at send, so the author's sessions see
// `Message` and then `ChannelAck`. Locally, a message this user wrote must
// never add to the unread count, attachments or mentions; a foreign message
// counts only once and only when it sits past the read pointer; the channel's
// last message id only ever moves forward, including when the HTTP response
// cached the message before the WebSocket event arrived; and a send supersedes
// a read still waiting on the debounce, so no stale ack goes out after it.
// Everything is driven through public paths (events, sendMessage, ack) with
// the REST calls stubbed.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { Client } from "stoat.js";

// Valid 26-character Crockford ULIDs. Message ids share one prefix and end in
// a zero-padded decimal counter, so MSG(n) sorts by n.
const ME = "01J9QCRE7M0000000000000001";
const OTHER = "01J9QCRE7M0000000000000002";
const WEBHOOK = "01J9QCRE7M0000000000000003";
const SERVER = "01J9QCRE7M00000000000000S1";
const CHANNEL = "01J9QCRE7M00000000000000C1";
const SOURCE_CHANNEL = "01J9QCRE7M00000000000000C2";
const MSG = (n: number) => `01J9QCRE7N${String(n).padStart(16, "0")}`;

/** A preset node configuration, so the constructor never fetches `GET /`
 * (tests must not touch the network). */
const CONFIG = {
  revolt: "test",
  features: {
    autumn: { enabled: false, url: "" },
    january: { enabled: false, url: "" },
  },
  ws: "ws://127.0.0.1:9",
  app: "",
  vapid: "",
  build: {},
};

/** A client with one text channel whose tail is MSG(9), read up to MSG(9). */
function setup() {
  const client = new Client(
    { syncUnreads: true, autoReconnect: false },
    CONFIG as never,
  );
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
    server: SERVER,
    name: "general",
    last_message_id: MSG(9),
  } as never);

  client.channelUnreads.getOrCreate(CHANNEL, {
    _id: { channel: CHANNEL, user: ME },
    last_id: MSG(9),
    mentions: [],
  });
  client.channelUnreads.updateUnderlyingObject(CHANNEL, "unreadCount", 0);

  return { client, channel };
}

/** The unread row's own fields, which (unlike the Channel getters) are not
 * gated on the channel currently reading as unread. */
function row(client: Client) {
  const unread = client.channelUnreads.get(CHANNEL);
  assert.ok(unread, "the fixture's unread row exists");
  return unread;
}

/** A `Message` event arriving over the WebSocket. */
function wsMessage(
  client: Client,
  id: string,
  author: string,
  extra: Record<string, unknown> = {},
) {
  client.events.emit("event", {
    type: "Message",
    _id: id,
    channel: CHANNEL,
    author,
    content: `message ${id}`,
    ...extra,
  } as never);
}

/** The server's `ChannelAck` for this user. */
function channelAck(client: Client, messageId: string) {
  client.events.emit("event", {
    type: "ChannelAck",
    id: CHANNEL,
    user: ME,
    message_id: messageId,
  } as never);
}

/** Stub the send route so it answers with `id`, authored by this user. */
function stubSend(client: Client, id: string) {
  const posts: string[] = [];
  (client.api as { post: unknown }).post = (path: string) => {
    posts.push(path);
    return Promise.resolve({
      _id: id,
      channel: CHANNEL,
      author: ME,
      content: `message ${id}`,
    });
  };
  return posts;
}

test("own message on the WebSocket, then the server's ChannelAck, reads as read", () => {
  const { client, channel } = setup();
  wsMessage(client, MSG(10), ME);
  channelAck(client, MSG(10));

  assert.equal(channel.lastMessageId, MSG(10));
  assert.equal(channel.unread, false);
  assert.equal(channel.unreadCount, 0);
  assert.equal(row(client).unreadCount, 0);
  assert.equal(row(client).lastMessageId, MSG(10));
});

test("sendMessage whose HTTP response beats the WebSocket event reads as read", async () => {
  const { client, channel } = setup();
  const posts = stubSend(client, MSG(10));

  await channel.sendMessage("hello");
  assert.deepEqual(posts, [`/channels/${CHANNEL}/messages`]);

  // The same message now arrives on the WebSocket, already cached.
  wsMessage(client, MSG(10), ME);

  assert.equal(
    channel.lastMessageId,
    MSG(10),
    "the channel's last message id follows the sent message",
  );
  assert.equal(
    row(client).lastMessageId,
    MSG(10),
    "the read pointer covers the sent message",
  );
  assert.equal(channel.unread, false);
  assert.equal(channel.unreadCount, 0);
  assert.equal(row(client).unreadCount, 0);
});

test("a ChannelAck that lands before its own Message does not leak a count", () => {
  const { client, channel } = setup();
  channelAck(client, MSG(10));
  wsMessage(client, MSG(10), ME);

  assert.equal(
    row(client).unreadCount,
    0,
    "an own message already covered by the pointer adds nothing",
  );
  assert.equal(channel.unread, false);
  assert.equal(channel.unreadCount, 0);

  wsMessage(client, MSG(11), OTHER);
  assert.equal(channel.unread, true);
  assert.equal(
    channel.unreadCount,
    1,
    "only the foreign message counts, not 2",
  );
});

test("a foreign Message replayed twice is counted once", () => {
  const { client, channel } = setup();
  wsMessage(client, MSG(10), OTHER);
  wsMessage(client, MSG(10), OTHER);

  assert.equal(channel.unread, true);
  assert.equal(channel.unreadCount, 1);
  assert.equal(row(client).unreadCount, 1);
});

test("an older message never moves the channel's last message id backwards", () => {
  const { client, channel } = setup();
  wsMessage(client, MSG(5), ME);

  assert.equal(
    channel.lastMessageId,
    MSG(9),
    "an older own message leaves the tail where it was",
  );
  assert.equal(channel.unread, false);
  assert.equal(row(client).unreadCount, 0);

  // A foreign message delivered out of order, behind the read pointer.
  wsMessage(client, MSG(7), OTHER);
  assert.equal(channel.lastMessageId, MSG(9));
  assert.equal(channel.unread, false);
  assert.equal(
    row(client).unreadCount,
    0,
    "a foreign message at or before the read pointer is not counted",
  );
});

test("a webhook message counts as unread", () => {
  const { client, channel } = setup();
  wsMessage(client, MSG(10), WEBHOOK, {
    webhook: { name: "Deploys", avatar: null },
  });

  assert.equal(channel.lastMessageId, MSG(10));
  assert.equal(channel.unread, true);
  assert.equal(channel.unreadCount, 1);
});

test("an own message that mentions this user records no mention", () => {
  const { client, channel } = setup();
  wsMessage(client, MSG(10), ME, { mentions: [ME] });

  assert.equal(
    channel.mentions?.size,
    0,
    "mentioning yourself is not a mention",
  );
  assert.equal(row(client).messageMentionIds.size, 0);
  assert.equal(row(client).unreadCount, 0);
});

test("a send supersedes a read still waiting on the ack debounce", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { client, channel } = setup();
    const puts: string[] = [];
    (client.api as { put: unknown }).put = (path: string) => {
      puts.push(path);
      return Promise.resolve(null);
    };

    wsMessage(client, MSG(10), OTHER);
    assert.equal(channel.unread, true);

    // Read the foreign message: the request waits on the 1.5 s debounce.
    await channel.ack();
    mock.timers.tick(1000);
    assert.equal(puts.length, 0, "the ack is still waiting on the debounce");

    // Send within the debounce window: the server acks the author at send.
    stubSend(client, MSG(11));
    await channel.sendMessage("reply");

    mock.timers.tick(5000);
    await Promise.resolve();
    assert.deepEqual(
      puts,
      [],
      "no ack PUT goes out once a send has superseded it",
    );
    assert.equal(row(client).lastMessageId, MSG(11));
    assert.equal(channel.unread, false);
  } finally {
    mock.timers.reset();
  }
});

test("an own message with no ChannelAck leaves a foreign unread untouched", () => {
  const { client, channel } = setup();
  wsMessage(client, MSG(10), OTHER);
  assert.equal(channel.unreadCount, 1);

  // A scheduled delivery the author had not caught up to: no self-ack.
  wsMessage(client, MSG(11), ME);

  assert.equal(channel.lastMessageId, MSG(11));
  assert.equal(channel.unread, true);
  assert.equal(
    channel.unreadCount,
    1,
    "the own message does not add to the count",
  );
});

test("a forward cached by its HTTP response still moves the channel's last message id", async () => {
  const { client, channel } = setup();

  // The forward route goes through `apiReq` (a raw fetch), not `client.api`.
  const requests: { method: string; path: string; body: unknown }[] = [];
  (client.channels as { apiReq: unknown }).apiReq = (
    method: string,
    path: string,
    options?: { body?: unknown },
  ) => {
    requests.push({ method, path, body: options?.body });
    return Promise.resolve({
      _id: MSG(10),
      channel: CHANNEL,
      author: ME,
      content: `message ${MSG(3)}`,
    });
  };

  const source = client.messages.getOrCreate(MSG(3), {
    _id: MSG(3),
    channel: SOURCE_CHANNEL,
    author: OTHER,
    content: `message ${MSG(3)}`,
  } as never);

  const forwarded = await source.forwardTo(CHANNEL, "nonce");
  assert.deepEqual(requests, [
    {
      method: "POST",
      path: `/channels/${SOURCE_CHANNEL}/messages/${MSG(3)}/forward`,
      body: { destination: CHANNEL, nonce: "nonce" },
    },
  ]);
  assert.equal(forwarded.id, MSG(10));
  assert.ok(
    client.messages.has(MSG(10)),
    "the HTTP response cached the forward before the WebSocket event",
  );
  assert.equal(
    channel.lastMessageId,
    MSG(9),
    "forwardTo does not note its own message, so only the event can move the tail",
  );

  // The forward arrives on the WebSocket, already cached: the dedupe guard
  // skips it, and the tail must still move.
  wsMessage(client, MSG(10), ME);
  assert.equal(
    channel.lastMessageId,
    MSG(10),
    "the forward-only bump runs outside the dedupe guard",
  );

  channelAck(client, MSG(10));
  assert.equal(channel.unread, false);
  assert.equal(channel.unreadCount, 0);
  assert.equal(row(client).unreadCount, 0);
  assert.equal(row(client).lastMessageId, MSG(10));
});
