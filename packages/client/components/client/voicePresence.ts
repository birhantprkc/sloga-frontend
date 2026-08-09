import type { Channel, Client } from "stoat.js";

/**
 * The voice channel a user is currently sitting in, if we can see one.
 *
 * Reactive: `client.channels` and each channel's `voiceParticipants` are both
 * reactive maps, so calling this inside a tracking scope re-runs whenever
 * anybody joins or leaves a call we can see.
 *
 * SCOPE — this only ever finds calls in channels THIS client can see: a DM or
 * group we are part of, or a voice channel in a server we share. A friend
 * sitting in a voice channel of a server we are not in is invisible here and
 * will read as "not in voice", because the roster for that channel is never
 * sent to us (`Ready` carries `voice_states` for visible channels only, and
 * `UserVoiceStateUpdate` is published to the channel topic). Closing that gap
 * needs a presence-level signal fanned out per user, not a wider client scan —
 * do not try to paper over it here.
 */
export function voiceChannelOf(
  client: Client,
  userId: string,
): Channel | undefined {
  for (const channel of client.channels.values()) {
    if (channel.voiceParticipants.has(userId)) return channel;
  }

  return undefined;
}
