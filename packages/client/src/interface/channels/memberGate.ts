/**
 * The two questions asked about a channel's client gates (age, password,
 * spoiler) outside the gates themselves.
 *
 * - `channelHasClientGate`: is there any gate on this channel at all, for
 *   anyone? This is the backend's `Channel::has_client_gate`
 *   (`crates/core/database/src/models/channels/model.rs`), which refuses a
 *   gated channel as the server's AFK channel; the channel settings ask it
 *   before offering that designation.
 * - `isChannelGatedForMember`: does a gate still stand for THIS member, given
 *   the unlocks stored in their layout? The server sidebar, the member menus
 *   and the voice client ask it before showing or joining a channel.
 *
 * Kept free of solid-js, the stores and stoat.js so it runs under
 * `node --test`. It depends only on the two leaves below, which import
 * nothing.
 */
import { parseChannelPassword } from "../../lib/channelPassword.ts";
import { gateSource, isChannelGated } from "./channelGates.ts";

/**
 * The fields the gate checks read. A stoat.js `Channel` satisfies it as is
 * (pinned by the type check in `memberGate.test.ts`).
 */
export interface GateCheckChannel {
  id: string;
  isThread: boolean;
  parent?: GateCheckChannel;
  mature?: boolean;
  isSpoiler?: boolean;
  description?: string;
}

/**
 * Whether the description carries a password hash, decided by the client's
 * own parser: only the last line, split on `\n` alone, counts; the marker is
 * case-sensitive and untrimmed; an empty hash is no password.
 */
function hasPassword(description: string | undefined): boolean {
  return !!parseChannelPassword(description).passwordHash;
}

/**
 * Whether the channel sits behind any client gate, with every per-member
 * unlock treated as not granted.
 *
 * Mirrors the backend's `Channel::has_client_gate` (wave BG): mature, or
 * spoiler, or a non-empty `[acupass:…]` hash on the last description line.
 * A thread answers `true` whatever its parent says, as the backend does: it
 * has no gate fields of its own, and the backend fails closed rather than
 * look up the parent. Asking this of a thread never finds it ungated.
 */
export function channelHasClientGate(channel: GateCheckChannel): boolean {
  if (channel.isThread) return true;
  return (
    !!channel.mature || !!channel.isSpoiler || hasPassword(channel.description)
  );
}

/**
 * Whether one of the channel's gates still stands for this member.
 *
 * A thread answers to its parent's gates and unlocks (`gateSource`); every
 * gate on that channel has to have been passed.
 *
 * @param channel The channel (a thread resolves to its loaded parent)
 * @param sectionState Reads a layout section flag (false when unset)
 * @param matureKey The global age-attestation section key
 */
export function isChannelGatedForMember(
  channel: GateCheckChannel,
  sectionState: (key: string) => boolean,
  matureKey: string,
): boolean {
  const source = gateSource(channel);
  return isChannelGated(
    {
      id: source.id,
      mature: !!source.mature,
      isSpoiler: !!source.isSpoiler,
      hasPassword: hasPassword(source.description),
    },
    sectionState,
    matureKey,
  );
}
