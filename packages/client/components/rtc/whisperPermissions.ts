import type { ParticipantTrackPermission } from "livekit-client";

import { participantUserId } from "../ui/components/features/voice/participantIdentity.ts";

/**
 * Pure half of the whisper feature (see whisper.ts for the controller and
 * the privacy model): track-name addressing and the subscription-permission
 * table. Kept free of runtime imports so the specs run under plain Node —
 * `participantIdentity.ts` is equally import-free, so reaching across to it
 * keeps that property.
 */

const WHISPER_PREFIX = "whisper:";

/** Track name addressing a whisper to a user (bare user id, all their devices). */
export function whisperTrackName(targetUserId: string): string {
  return `${WHISPER_PREFIX}${targetUserId}`;
}

/** The addressee user id of a whisper track name, or undefined. */
export function whisperTarget(trackName?: string): string | undefined {
  if (!trackName?.startsWith(WHISPER_PREFIX)) return undefined;
  const target = trackName.slice(WHISPER_PREFIX.length);
  return target || undefined;
}

/**
 * Identities are device-qualified (`user:device`) on E2EE calls, and a screen
 * leg adds a third segment (`user:device:screen`) — taking segment 0 is right
 * for all three shapes.
 *
 * This WAS a second copy of `participantUserId`, duplicated to keep rtc/ from
 * importing ui/. It is now that same function: two copies of an identity
 * parser is exactly how a leg-aware rule ends up applied on one path and not
 * the other. Re-exported under the old name so existing rtc/ call sites read
 * unchanged.
 */
export { participantUserId as identityUserId };

/**
 * The full permission table while whispering to `targetUserId`:
 * every device of the target may subscribe to everything (including the
 * whisper track, present or future); everyone else is pinned to the explicit
 * list of NORMAL track sids, so the whisper track — and any track not yet
 * published — stays dark to them until the next push.
 */
export function computeWhisperPermissions(
  targetUserId: string,
  remoteIdentities: string[],
  normalTrackSids: string[],
): ParticipantTrackPermission[] {
  return remoteIdentities.map((identity) =>
    participantUserId(identity) === targetUserId
      ? { participantIdentity: identity, allowAll: true }
      : {
          participantIdentity: identity,
          allowedTrackSids: [...normalTrackSids],
        },
  );
}
