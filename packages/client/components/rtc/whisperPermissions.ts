import type { ParticipantTrackPermission } from "livekit-client";

/**
 * Pure half of the whisper feature (see whisper.ts for the controller and
 * the privacy model): track-name addressing and the subscription-permission
 * table. Kept free of runtime imports so the specs run under plain Node.
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

/** Identities are device-qualified (`user:device`) on E2EE calls — same
 * convention as participantIdentity.ts, duplicated here because rtc/ must not
 * import from ui/. */
export function identityUserId(identity: string): string {
  return identity.split(":")[0];
}

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
    identityUserId(identity) === targetUserId
      ? { participantIdentity: identity, allowAll: true }
      : {
          participantIdentity: identity,
          allowedTrackSids: [...normalTrackSids],
        },
  );
}
