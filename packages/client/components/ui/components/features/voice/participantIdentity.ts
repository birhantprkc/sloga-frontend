/**
 * Voice/LiveKit participant identities have been DEVICE-QUALIFIED since E2EE
 * slice 6.1/6.4 — the SFU identity is `"{user_id}:{device_id}"` so media frame
 * keys can be matched per device. Resolving a Sloga user for DISPLAY (name /
 * avatar / per-user settings) must therefore use the USER id only: passing the
 * raw device-qualified identity to `useUser` finds no user and the tile falls
 * back to "Unknown User".
 *
 * Non-E2EE / not-yet-provisioned calls carry a bare `user_id` with no
 * `:device_id`, so this is idempotent — safe to apply everywhere a participant
 * identity is turned into a user. Keep the FULL `participant.identity` for
 * track/keying paths; only strip for display lookups.
 */
export function participantUserId(identity: string): string {
  return identity.split(":")[0];
}

/**
 * Remote participants as a list of USER ids, deduped and in room order —
 * the candidate set for anything addressed to a person rather than a device.
 *
 * DEDUPED BY USER, not by participant: identities are device-qualified, so
 * someone in the call on both their desktop and their phone appeared twice
 * with the same name and no way to tell the rows apart. Anything addressed
 * to a USER (a control offer — the server picks the session) has only one
 * real choice there.
 *
 * Shared by the give-control picker and the pass-the-controller rotation
 * panel. The rotation panel must NOT reach into the picker for it: the
 * picker's whole subtree is gated on `canOffer()`, which requires
 * `!rc.sharing()`, so it unmounts the instant a session goes active —
 * exactly when rotation needs this list.
 *
 * Structurally typed rather than importing LiveKit's `Room` so it stays a
 * cheap leaf both callers can use.
 */
export function remoteParticipantUserIds(
  participants: Iterable<{ identity: string }>,
  selfUserId: string,
): string[] {
  const seen = new Set<string>();
  const users: string[] = [];
  for (const participant of participants) {
    const userId = participantUserId(participant.identity);
    if (userId === selfUserId || seen.has(userId)) continue;
    seen.add(userId);
    users.push(userId);
  }
  return users;
}

/**
 * The FULL device-qualified identity for a user in the call, which per-peer
 * remote-control trust is bound to.
 *
 * `remoteParticipantUserIds` deliberately dedupes to bare user ids because an
 * OFFER is addressed to a user and the server picks the session — but trust
 * is bound to a DEVICE, so the offer has to carry the identity back. Where
 * the same person is in the call on two devices this takes the first, the
 * same arbitrary-but-consistent choice the deduped row already represents.
 *
 * Returns `""` when there is no device half (a non-E2EE participant carries a
 * bare user id). Native refuses to remember that, which is correct: "any
 * device of theirs" is not what the dialog asks.
 */
export function identityForUserId(
  participants: Iterable<{ identity: string }>,
  userId: string,
): string {
  for (const participant of participants) {
    if (participantUserId(participant.identity) === userId) {
      return participant.identity;
    }
  }
  return "";
}
