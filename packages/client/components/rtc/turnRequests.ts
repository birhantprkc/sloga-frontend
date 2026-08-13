/**
 * "Ask for a turn" — the sharer's pending-request list (pass-the-controller
 * slice 2, §2.4).
 *
 * A dependency-free leaf, same as `remoteControlQueue.ts`, so the ordering and
 * cap rules run under Node's built-in test runner without Solid or LiveKit.
 *
 * These are SUGGESTIONS, not authorizations. A `CallControlRequest` event is
 * relayed to the sharer when someone raises a hand; it grants nothing, enters
 * no queue by itself, and every turn it might lead to still costs a native
 * `RcArm` on the sharer's machine (§0.1). The sharer decides whether a request
 * becomes a queue entry — nothing here calls the server or mutates the queue.
 *
 * A list rather than a set because order carries meaning (who asked first),
 * and it is capped: request spam is the obvious abuse of a social feature, and
 * the server's own ratelimit is the real bound — this cap only keeps a hostile
 * peer from growing the sharer's on-screen list without limit between windows.
 */

/**
 * Pending turn requests, newest LAST, one entry per requester. `at` is the
 * wall-clock ms the request was received (the client's clock — it orders and
 * ages the list, it is not trusted for anything).
 */
export type TurnRequest = { readonly userId: string; readonly at: number };
export type TurnRequests = readonly TurnRequest[];

export const EMPTY_TURN_REQUESTS: TurnRequests = [];

/**
 * The most requests one sharer's list holds at once. Well above any real game
 * night; it exists only so a hostile peer cycling identities cannot grow the
 * list unbounded. When full, the OLDEST request is evicted — a fresh raised
 * hand is more actionable than a stale one the sharer already ignored.
 */
export const MAX_TURN_REQUESTS = 32;

/**
 * Record a raised hand.
 *
 * A repeat from someone already waiting refreshes their timestamp but does NOT
 * move them to the back: re-asking must not let a heckler jump the visual
 * order, and it must not cost them their place either — so the entry stays put
 * and only its `at` advances. (The server ratelimit is what actually bounds
 * re-asks; this is just the display rule.)
 *
 * Returns the same reference when nothing changed (a repeat at the same ms),
 * so a signal setter can skip notifying.
 */
export function addTurnRequest(
  requests: TurnRequests,
  userId: string,
  at: number,
): TurnRequests {
  if (!userId) return requests;

  const existing = requests.findIndex((r) => r.userId === userId);
  if (existing !== -1) {
    if (requests[existing].at === at) return requests;
    const copy = requests.slice();
    copy[existing] = { userId, at };
    return copy;
  }

  const appended = [...requests, { userId, at }];
  // Evict from the FRONT (oldest) when over the cap.
  return appended.length > MAX_TURN_REQUESTS
    ? appended.slice(appended.length - MAX_TURN_REQUESTS)
    : appended;
}

/**
 * Clear one request — the sharer acted on it (added the asker to the queue) or
 * dismissed it. Returns the same reference when it was not present.
 */
export function removeTurnRequest(
  requests: TurnRequests,
  userId: string,
): TurnRequests {
  if (!requests.some((r) => r.userId === userId)) return requests;
  return requests.filter((r) => r.userId !== userId);
}

/**
 * Drop requests from anyone no longer in the call — a request from someone who
 * left is nothing the sharer can act on. Preserves the order of those who
 * remain; returns the same reference when everyone is still present.
 */
export function retainPresentRequests(
  requests: TurnRequests,
  present: Iterable<string>,
): TurnRequests {
  const here = present instanceof Set ? present : new Set(present);
  if (requests.every((r) => here.has(r.userId))) return requests;
  return requests.filter((r) => here.has(r.userId));
}

// NOTE on the capability marker (§0.5): the "Desktop" chip is drawn only when
// a participant's `rc_capable` reads TRUE — never on false, which is
// indistinguishable from "hasn't announced" (a capable slice-1/0.34 desktop
// that predates the beacon), so absence must never grey or filter a row. That
// tri-state rule lives where it is enforced — `Voice.participantRcCapable`'s
// doc comment and the chip's `<Show when>` — rather than in a helper here that
// nothing could wire without an "announced" bit the roster does not carry.
