/**
 * Shared state for the three channel gates (age, password, spoiler).
 *
 * Each gate remembers its answer as a layout section flag. The gates own the
 * prompts; anything rendered OUTSIDE them that shows channel content (the
 * server sidebar's member list is the one that matters) must ask the same
 * question with the same keys, or it leaks what the gate is holding back.
 *
 * Kept free of solid-js and the stores so it runs under `node --test`.
 */

/** Section key a password gate stores its unlock under. */
export function passwordGateKey(channelId: string): string {
  return `${channelId}-pw`;
}

/** Section key a spoiler gate stores its reveal under. */
export function spoilerGateKey(channelId: string): string {
  return `${channelId}-spoiler`;
}

/**
 * The channel whose gates apply. A thread (a forum post included) carries no
 * mature, spoiler or password flags of its own, so it answers to its parent's:
 * gating a thread on its own flags left every post under a mature or
 * password-protected forum open, page and member list alike. Unlocking the
 * parent therefore unlocks its threads too, which is the point. A thread whose
 * parent is not loaded falls back to itself, the behavior it always had.
 */
export function gateSource<T extends { isThread: boolean; parent?: T }>(
  channel: T,
): T {
  return channel.isThread && channel.parent ? channel.parent : channel;
}

export interface GatedChannel {
  id: string;
  mature: boolean;
  isSpoiler: boolean;
  /** Whether the channel carries a password hash in its description. */
  hasPassword: boolean;
}

/**
 * Whether any gate still stands in front of this channel.
 *
 * @param channel The channel's gate-relevant flags
 * @param sectionState Reads a layout section flag (false when unset)
 * @param matureKey The global age-attestation section key
 */
export function isChannelGated(
  channel: GatedChannel,
  sectionState: (key: string) => boolean,
  matureKey: string,
): boolean {
  if (channel.mature && !sectionState(matureKey)) return true;
  if (channel.hasPassword && !sectionState(passwordGateKey(channel.id)))
    return true;
  if (channel.isSpoiler && !sectionState(spoilerGateKey(channel.id)))
    return true;
  return false;
}
