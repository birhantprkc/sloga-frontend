/**
 * The streamer's rotation queue (pass-the-controller slice 1).
 *
 * A dependency-free leaf on the `remoteControlVisibility.ts` /
 * `remoteControlMapping.ts` precedent, so the ordering rules can be exercised
 * by Node's built-in test runner without dragging in Solid or LiveKit. That
 * matters here because the queue is the piece whose being wrong is INVISIBLE:
 * a bad `next` hands the keyboard to the wrong person, and the only thing on
 * screen is a native dialog naming someone the streamer did not choose.
 *
 * The queue lives entirely on the streamer's client (§2.1) — there is no
 * server-side queue and there must not be one, because a server-ordered
 * rotation would be a server-chosen controller, which §0.4's claim discipline
 * forbids from meaning anything. It is an ORDER, not an authorization: every
 * turn still costs a native `RcArm` on the streamer's machine (§0.1).
 *
 * The current controller is deliberately a MEMBER of the queue rather than
 * held aside, so wrap-around is the ordinary case and "whose turn is after
 * mine" has one answer at every position.
 */

/** Rotation order, by bare user id. Never device-qualified — the offer is
 *  addressed to a USER and the server picks the session (see `eligible()`). */
export type RemoteControlQueue = readonly string[];

export const EMPTY_REMOTE_CONTROL_QUEUE: RemoteControlQueue = [];

/**
 * Append someone to the end of the rotation.
 *
 * Idempotent, and deliberately does NOT move an existing member to the back:
 * re-adding someone already waiting would push them behind people who joined
 * after them, which reads as the queue losing their place.
 *
 * Returns the same reference when nothing changed, so a signal setter fed
 * with this can skip notifying subscribers.
 */
export function addToQueue(
  queue: RemoteControlQueue,
  userId: string,
): RemoteControlQueue {
  if (!userId) return queue;
  if (queue.includes(userId)) return queue;
  return [...queue, userId];
}

/**
 * Drop someone from the rotation.
 *
 * Returns the same reference when they were not in it.
 */
export function removeFromQueue(
  queue: RemoteControlQueue,
  userId: string,
): RemoteControlQueue {
  if (!queue.includes(userId)) return queue;
  return queue.filter((id) => id !== userId);
}

/**
 * Drop anyone who is no longer in the call, preserving the order of those
 * who remain.
 *
 * Called against the same deduped-by-user list the offer picker builds. A
 * queue member who left is not merely stale: offering to them dead-ends at
 * the server's 90 s offer TTL, and in a rotation that reads as the queue
 * being stuck on someone who is not there (§2.3's failure, which slice 1
 * avoids by pruning rather than by a capability beacon).
 *
 * Returns the same reference when everyone is still present.
 */
export function retainPresent(
  queue: RemoteControlQueue,
  present: Iterable<string>,
): RemoteControlQueue {
  const here = present instanceof Set ? present : new Set(present);
  if (queue.every((id) => here.has(id))) return queue;
  return queue.filter((id) => here.has(id));
}

/**
 * Whose turn is next, or `undefined` if there is nobody to pass to.
 *
 * - No current controller (the ordinary "start the rotation" case): the head
 *   of the queue.
 * - Current controller is in the queue: the next member, wrapping to the
 *   head. Wrap is what makes a three-person circle work without the streamer
 *   re-adding people every lap.
 * - Current controller is NOT in the queue — they were removed mid-turn, or
 *   control was handed over outside the rotation by the tile menu: the head
 *   of the queue. Falling back to the head is the only position that is not
 *   an arbitrary guess, and it keeps "Next" working rather than dead.
 * - The current controller is the queue's ONLY member: `undefined`. Handing
 *   off to the person already driving would tear down a live session and
 *   spend a native dialog to arrive exactly where it started, so the button
 *   must be disabled instead of doing that.
 */
export function nextInQueue(
  queue: RemoteControlQueue,
  currentControllerId?: string,
): string | undefined {
  if (queue.length === 0) return undefined;
  if (!currentControllerId) return queue[0];

  const at = queue.indexOf(currentControllerId);
  if (at === -1) return queue[0];
  if (queue.length === 1) return undefined;
  return queue[(at + 1) % queue.length];
}

/**
 * Has the current turn run out?
 *
 * Split out as a pure predicate so the "should we rotate now" decision is
 * testable without a clock: the caller passes `Date.now()`. A `deadline` of
 * `undefined` means the streamer set no timer, which is the default — an
 * automatic handoff is a session ending on a schedule the person at the
 * keyboard did not choose, so it is opt-in.
 */
export function turnExpired(
  deadline: number | undefined,
  now: number,
): boolean {
  if (deadline === undefined) return false;
  return now >= deadline;
}
