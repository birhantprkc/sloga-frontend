// Unit spec for the taskbar/dock unread badge — run with Node's built-in
// runner:
//   node --test components/client/unreadBadge.test.ts   (Node >=23.6 strips types)
// Focus: the three ways the total goes wrong — a muted server that still
// reports itself unread, a zero count that means "unknown" rather than "none",
// and a mention flag that has to survive being found on either kind of entry.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type BadgeConversation,
  type BadgeServer,
  sameBadge,
  stripBadgePrefix,
  titleForBadge,
  unreadBadge,
} from "./unreadBadge.ts";

/** A server with nothing unread, for tests to override one field of. */
function server(over: Partial<BadgeServer> = {}): BadgeServer {
  return { unread: false, unreadCount: 0, mentions: [], ...over };
}

/** A conversation with nothing unread. */
function dm(over: Partial<BadgeConversation> = {}): BadgeConversation {
  return { unread: false, unreadCount: 0, ...over };
}

const nothingMuted = () => false;

function badge(
  servers: BadgeServer[],
  conversations: BadgeConversation[] = [],
  isServerMuted: (s: BadgeServer) => boolean = nothingMuted,
) {
  return unreadBadge({ servers, conversations, isServerMuted });
}

test("a fully read account badges nothing", () => {
  assert.deepEqual(badge([server()], [dm()]), { count: 0, mention: false });
  assert.deepEqual(badge([], []), { count: 0, mention: false });
});

test("servers and conversations add into one total", () => {
  const result = badge(
    [
      server({ unread: true, unreadCount: 12 }),
      server({ unread: true, unreadCount: 3 }),
    ],
    [dm({ unread: true, unreadCount: 5 })],
  );
  assert.equal(result.count, 20);
});

test("a read entry contributes nothing even carrying a stale count", () => {
  // `unreadCount` is only defined while `unread` — reading the count without
  // the flag would badge a channel the user has already caught up on.
  const result = badge(
    [server({ unread: false, unreadCount: 40 })],
    [dm({ unread: false, unreadCount: 9 })],
  );
  assert.equal(result.count, 0);
});

test("a muted server is skipped even though it reports itself unread", () => {
  // The trap: Server.unread is true when ANY channel is unread, and a channel
  // only reports its OWN mute — so a muted server whose channels are not
  // individually muted arrives here unread, with unreadCount already 0. Left
  // unskipped the `|| 1` floor below would badge it as 1.
  const muted = server({ unread: true, unreadCount: 0, mentions: ["a"] });
  const result = badge([muted], [], (s) => s === muted);
  assert.deepEqual(result, { count: 0, mention: false });
});

test("an unread entry with no count still contributes one", () => {
  // Zero means "the server did not tell us", which is exactly when the rail
  // draws a plain dot — an empty taskbar beside a rail full of dots is the bug
  // this prevents.
  assert.equal(badge([server({ unread: true, unreadCount: 0 })]).count, 1);
  assert.equal(badge([], [dm({ unread: true, unreadCount: 0 })]).count, 1);
});

test("a mention on either kind of entry colours the badge", () => {
  assert.equal(
    badge([server({ unread: true, unreadCount: 2, mentions: ["m1"] })]).mention,
    true,
  );
  assert.equal(
    badge([], [dm({ unread: true, unreadCount: 2, mentions: new Set(["m1"]) })])
      .mention,
    true,
  );
});

test("a plain unread DM is not a mention", () => {
  // The rail colours an unmentioned DM with the plain unread tone; the taskbar
  // must not promote it to the mention colour just for being a DM.
  const result = badge([], [dm({ unread: true, unreadCount: 4 })]);
  assert.deepEqual(result, { count: 4, mention: false });
});

test("a mention inside a muted server does not colour the badge", () => {
  const muted = server({ unread: true, unreadCount: 7, mentions: ["m1"] });
  const loud = server({ unread: true, unreadCount: 2 });
  const result = badge([muted, loud], [], (s) => s === muted);
  assert.deepEqual(result, { count: 2, mention: false });
});

test("sameBadge compares both fields", () => {
  assert.equal(
    sameBadge({ count: 3, mention: false }, { count: 3, mention: false }),
    true,
  );
  assert.equal(
    sameBadge({ count: 3, mention: false }, { count: 4, mention: false }),
    false,
  );
  // The colour alone changing is still a repaint: a mention landing in an
  // already-unread channel leaves the count alone and must still go through.
  assert.equal(
    sameBadge({ count: 3, mention: false }, { count: 3, mention: true }),
    false,
  );
});

test("the title prefix does not accumulate across updates", () => {
  // The title is both input and output of the web badge, so this is the case
  // that produces "(3) (5) Sloga" if the base is not re-derived every time.
  let title = "Sloga";
  title = titleForBadge(title, 3);
  assert.equal(title, "(3) Sloga");
  title = titleForBadge(title, 5);
  assert.equal(title, "(5) Sloga");
  title = titleForBadge(title, 0);
  assert.equal(title, "Sloga");
});

test("stripBadgePrefix leaves an unprefixed title alone", () => {
  assert.equal(stripBadgePrefix("Sloga"), "Sloga");
  assert.equal(stripBadgePrefix("(12) Sloga"), "Sloga");
  // Not a badge prefix: a parenthesised word must survive untouched.
  assert.equal(stripBadgePrefix("(draft) Sloga"), "(draft) Sloga");
});
