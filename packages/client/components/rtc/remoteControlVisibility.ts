/**
 * Channel-wide remote-control visibility (pass-the-controller slice 0).
 *
 * The backend fans the redacted `RemoteControlActive { channel_id, sharer_id,
 * controller_id }` / `RemoteControlEnded { channel_id, sharer_id, reason }`
 * pair out on the CHANNEL topic, whose boundary is `ViewChannel` — so text
 * members who never joined the call receive it too. That reach is the
 * feature: third parties and moderators are meant to see control being
 * passed. Nothing here filters on call membership; readers scope by the
 * channel they render.
 *
 * The map is `channelId → (sharerId → controllerId)`. A sharer holds at most
 * one grant per channel (server-enforced via SETNX), so the inner value is a
 * single controller, and `Ended` is keyed by `(channelId, sharerId)` alone.
 */

export type RemoteControlSessionMap = ReadonlyMap<
  string,
  ReadonlyMap<string, string>
>;

export const EMPTY_REMOTE_CONTROL_SESSIONS: RemoteControlSessionMap = new Map();

/** A control session went active: record who is driving whose screen. */
export function applyRemoteControlActive(
  map: RemoteControlSessionMap,
  detail: { channelId: string; sharerId: string; controllerId: string },
): RemoteControlSessionMap {
  const channel = new Map(map.get(detail.channelId));
  channel.set(detail.sharerId, detail.controllerId);
  const next = new Map(map);
  next.set(detail.channelId, channel);
  return next;
}

/**
 * A control session ended: clear the sharer's entry.
 *
 * `reason` is deliberately not a parameter. The server-side vocabulary is an
 * OPEN string — the doc-comment enumeration is already stale (it omits
 * `panic`, `anti_cheat`, …) and new causes keep being added — so nothing may
 * switch over it. Any end clears the entry, whatever the cause.
 *
 * Returns the same reference when nothing changed, so a signal setter fed
 * with this can skip notifying subscribers.
 */
export function applyRemoteControlEnded(
  map: RemoteControlSessionMap,
  detail: { channelId: string; sharerId: string },
): RemoteControlSessionMap {
  const channel = map.get(detail.channelId);
  if (!channel?.has(detail.sharerId)) return map;

  const next = new Map(map);
  if (channel.size === 1) {
    next.delete(detail.channelId);
  } else {
    const remaining = new Map(channel);
    remaining.delete(detail.sharerId);
    next.set(detail.channelId, remaining);
  }
  return next;
}
