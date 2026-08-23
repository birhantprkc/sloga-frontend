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
 * SCREEN LEGS (Android screen-share plan §0.2). A phone cannot hand a native
 * MediaProjection capture to the WebView's sealed WebRTC stack, and rejoining
 * under the same identity would evict the call — so a share from a phone is a
 * SECOND SFU participant, `"{user_id}:{device_id}:screen"`, publishing screen
 * share only and subscribing to nothing.
 *
 * The grammar is always THREE segments. A bare (non-device-qualified) primary
 * — a plaintext call, or a client that never provisioned E2EE — gives
 * `"{user_id}::screen"` with an EMPTY device segment, never the two-segment
 * `"{user_id}:screen"`. That shorter form was the rev-1 bug (§0-R.3): it is
 * indistinguishable from the legitimate primary of a device whose id is
 * literally `screen`, so it is deliberately not recognized as a leg here.
 *
 * Every existing parser takes segment 0 (user) or 1 (device) and survives the
 * third, so `participantUserId` is unchanged and correct for a leg.
 */
const LEG_SUFFIX = ":screen";

/**
 * The leg kind of an identity (`"screen"`), or undefined for a primary. Named
 * for the shape rather than the value so a later iOS ReplayKit leg joins the
 * same grammar without a second parser.
 */
export function participantLeg(identity: string): string | undefined {
  const segments = identity.split(":");
  return segments.length === 3 ? segments[2] : undefined;
}

/** Whether this identity is a screen leg rather than a primary participant. */
export function isScreenLeg(identity: string): boolean {
  return participantLeg(identity) === "screen";
}

/**
 * The OWNER primary identity of a leg — `"u:d:screen"` → `"u:d"`, and the bare
 * grammar `"u::screen"` → `"u"`. Idempotent on a primary, so it is safe
 * anywhere an identity is compared against a primary-shaped one.
 *
 * Use it wherever a leg must be treated AS its owner: the per-device lock
 * badge, the annotation overlay's `target_identity` match (the server resolves
 * annotations through the mapping to the PRIMARY), and the encryption chip's
 * own-device check. Do NOT use it where the raw identity is the point — the
 * roster's ghost direction and `#removeMember` compare against the SFU set
 * exactly, and canonicalizing there resurrects the ghost hole (§0-R.4).
 */
export function stripLeg(identity: string): string {
  if (!isScreenLeg(identity)) return identity;
  const owner = identity.slice(0, -LEG_SUFFIX.length);
  // `"u:"` — the bare grammar's empty device segment; the owner is the user id.
  return owner.endsWith(":") ? owner.slice(0, -1) : owner;
}

/**
 * Drop the phantom placeholder rows a leg produces.
 *
 * `useTracks([{source, withPlaceholder: true}])` synthesizes a
 * `{participant, source}` entry (no `publication`) for every participant with
 * no track of that source — so a leg, which publishes screen share and nothing
 * else, gets a Camera or Microphone placeholder and renders as a second,
 * permanently-muted avatar tile for the same person. Its REAL screen-share
 * publication is kept: that tile is the whole feature.
 *
 * Applied at all three `useTracks` call sites that pass `withPlaceholder`
 * (§6.2). The placeholders are created inside the `solid-livekit-components`
 * submodule, consumed from a gitignored `dist/` — filtering here keeps the fix
 * in the app, where it ships without a submodule rebuild.
 */
export function dropLegPlaceholders<
  T extends { participant: { identity: string }; publication?: unknown },
>(tracks: readonly T[]): T[] {
  return tracks.filter(
    (track) =>
      track.publication !== undefined ||
      !isScreenLeg(track.participant.identity),
  );
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
 * SCREEN LEGS ARE SKIPPED. A leg is a publisher, not a person you can offer
 * anything to: it is minted `can_subscribe: false`, so it would never see an
 * offer, and it holds no session the server could route one to.
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
    if (isScreenLeg(participant.identity)) continue;
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
 *
 * 🔴 SCREEN LEGS ARE SKIPPED, and this one is load-bearing rather than tidy.
 * This returns the FIRST match and remote-control binds per-peer trust to
 * exactly that identity; the SFU lists participants in join order, so a phone
 * whose leg joined before its primary would hand RC a trust binding for
 * `user:device:screen` — an identity that can never accept control (it holds
 * no session and cannot subscribe), while the real device is passed over. The
 * grant would be remembered natively against a participant that ceases to
 * exist when the share stops.
 */
export function identityForUserId(
  participants: Iterable<{ identity: string }>,
  userId: string,
): string {
  for (const participant of participants) {
    if (isScreenLeg(participant.identity)) continue;
    if (participantUserId(participant.identity) === userId) {
      return participant.identity;
    }
  }
  return "";
}
