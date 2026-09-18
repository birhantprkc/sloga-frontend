/**
 * What number the operating system should paint on the app's icon.
 *
 * Pure on purpose, and deliberately free of imports: the arithmetic is where a
 * badge goes wrong — by double counting, by counting a muted server, or by
 * reading a zero as "nothing unread" — so it has a spec sitting next to it
 * (`unreadBadge.test.ts`, `node --test`). Where the number then GOES is the
 * other half, in `unreadBadgeShell.ts`, and that half is platform glue with
 * nothing to prove.
 *
 * The number is deliberately the same one the server rail already shows: the
 * sum of the per-server and per-conversation counts rendered by `ServerList`,
 * under the same mute rules, so the taskbar and the rail can never disagree.
 * `interface/navigation/servers/ServerList.tsx` is the other side of that
 * contract — changing which entries it badges means changing this.
 */

/** What the OS should show: a total, and whether any of it is a mention. */
export type UnreadBadge = {
  count: number;
  /**
   * Only picks the colour of the drawn Windows badge (red for a mention, the
   * logo blue otherwise, matching `Unreads.tsx`). A mention never changes the
   * count — it is already one of the unread messages being counted.
   */
  mention: boolean;
};

/**
 * A server as the badge reads it. Structural rather than `Server` so the spec
 * can construct one; the real class satisfies this.
 */
export type BadgeServer = {
  unread: boolean;
  unreadCount: number;
  /** Message ids we are mentioned in, across the server's channels. */
  mentions: { length: number };
};

/** A DM or group conversation as the badge reads it. */
export type BadgeConversation = {
  unread: boolean;
  unreadCount: number;
  /** Undefined for Saved Notes, which is never unread anyway. */
  mentions?: { size: number };
};

/**
 * Total the shell should show, and whether to colour it as a mention.
 *
 * Three rules that are each easy to get wrong:
 *
 * 1. **A muted server is skipped even though it reports `unread`.**
 *    `Server.unread` is true when any channel is unread, and a channel only
 *    reports itself muted for its OWN mute — the server's mute is not folded
 *    in there. `Server.unreadCount` *does* fold it in and would return 0, so
 *    the count alone would already be right; the explicit skip is what stops a
 *    muted server contributing the `|| 1` floor below. The rail gates on the
 *    same `isMuted(server)` for the same reason.
 * 2. **Zero means "unknown", not "none".** The server seeds these counts on
 *    connect and an older one supplies none at all, so an entry can be unread
 *    with a count of 0 — that is exactly when the rail draws a plain dot.
 *    Counting it as 0 would show an empty taskbar next to a rail full of dots,
 *    so an unread entry contributes at least 1.
 * 3. **Conversations are not re-checked for mutes.** `Channel.unread` is
 *    already false for a muted DM (`channelExclusiveMuted`), and a DM has no
 *    server to inherit a mute from.
 */
export function unreadBadge<S extends BadgeServer>(input: {
  servers: S[];
  conversations: BadgeConversation[];
  /**
   * Generic in the server type only so the caller's predicate keeps receiving
   * a real `Server` — `state.notifications.isMuted` wants the class, and a
   * cast at the call site would be a cast on the one argument that decides
   * whether a muted server is counted.
   */
  isServerMuted: (server: S) => boolean;
}): UnreadBadge {
  let count = 0;
  let mention = false;

  for (const server of input.servers) {
    if (!server.unread || input.isServerMuted(server)) continue;
    count += server.unreadCount || 1;
    if (server.mentions.length > 0) mention = true;
  }

  for (const conversation of input.conversations) {
    if (!conversation.unread) continue;
    count += conversation.unreadCount || 1;
    if ((conversation.mentions?.size ?? 0) > 0) mention = true;
  }

  return { count, mention };
}

/** Whether two badges would paint the same thing. */
export function sameBadge(a: UnreadBadge, b: UnreadBadge): boolean {
  return a.count === b.count && a.mention === b.mention;
}

/**
 * Strip a badge prefix back off a document title.
 *
 * Load-bearing rather than tidiness: the title is both the input and the
 * output of the web badge, so re-deriving the base from the live title is what
 * stops `(3) (5) Sloga` accumulating across updates — and a dev-server hot
 * reload re-runs this module against an already-prefixed title, which is the
 * case a value captured once at import would get wrong.
 */
export function stripBadgePrefix(title: string): string {
  return title.replace(/^\(\d+\)\s+/, "");
}

/**
 * The document title for a given count.
 *
 * The browser tab is the web's taskbar: `setAppBadge` only reaches an
 * INSTALLED app, so a plain tab would otherwise show nothing. Unlike the drawn
 * Windows badge this is not capped — a title bar has room for the real number,
 * and "99+" where it could have said 248 is a worse answer.
 */
export function titleForBadge(base: string, count: number): string {
  // Stripped on BOTH branches. The zero case is the one that looks like it
  // needs no work and is exactly where the prefix would otherwise survive the
  // last message being read.
  const plain = stripBadgePrefix(base);
  return count > 0 ? `(${count}) ${plain}` : plain;
}
