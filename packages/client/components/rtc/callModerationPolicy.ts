/**
 * Which server-side moderation actions a call participant's menu may offer.
 *
 * Pure and runtime-import free so the specs run under plain Node. Every rule
 * here mirrors a check the API performs in `member_edit` — an entry offered
 * where the server would refuse is a button that only ever produces an error
 * toast, and an entry withheld where the server would allow it is a
 * moderator who cannot do their job.
 *
 * The actions map to:
 *   - `mute`       → `can_publish: false` (server mute), MuteMembers
 *                    (server level)
 *   - `deafen`     → `can_receive: false` (server deafen), DeafenMembers
 *                    (server level)
 *   - `disconnect` → `remove: ["VoiceChannel"]`, MoveMembers (channel level,
 *                    on the voice channel they are in)
 *   - move         → `voice_channel: <id>`, MoveMembers (channel level, on
 *                    the voice channel they are in) for someone else; see
 *                    `canOfferMove`. The destination is checked separately
 *                    by `moveTargets` in `voiceMovePolicy`.
 *
 * `disconnect` removes the member from the CALL. It is not a server kick and
 * does not stop them rejoining.
 */

/** The member the menu is open on, as the call sees them. */
export type CallModerationSubject = {
  /** Whether this is the acting user's own participant. */
  isSelf: boolean;
  /**
   * Whether the target is currently connected to the call's voice channel.
   *
   * The API does NOT refuse this one: clearing `VoiceChannel` for a member
   * with no voice state simply no-ops (the `NotConnected` error belongs to
   * the MOVE path, not the disconnect path). This gate is ours — offering
   * "Disconnect from call" against someone who already left would report
   * success while doing nothing at all.
   */
  isConnected: boolean;
  /**
   * Whether the acting user outranks the target.
   *
   * The API refuses ANY edit of a member ranked at or above the actor with
   * `NotElevated`, whatever permissions the actor holds — so this gates every
   * action against someone else, not just some.
   */
  isInferiorToActor: boolean;
};

/**
 * The acting user's permissions, each resolved at the level `member_edit`
 * checks it. The two levels differ, and mixing them up offers entries the API
 * then refuses (or withholds ones it would allow).
 *
 * `muteMembers` and `deafenMembers` are SERVER level: `member_edit` resolves
 * them through `calculate_server_permissions`, so a channel override that
 * grants MuteMembers on one voice channel does NOT let the actor mute there.
 *
 * `moveMembersInSource` is CHANNEL level, on the SOURCE voice channel (the one
 * the target is in, i.e. the call's channel): `member_edit` checks MoveMembers
 * against that channel for any disconnect or move of someone else, so a
 * channel override can grant or revoke it there. Resolve it with
 * `channel.havePermission("MoveMembers")`, never the server-level value.
 * (The API falls back to server-level MoveMembers only when the target has no
 * source channel: not in voice, or that channel was deleted. Neither is a
 * participant this menu acts on.)
 */
export type CallModerationPermissions = {
  muteMembers: boolean;
  deafenMembers: boolean;
  moveMembersInSource: boolean;
};

/** Which entries to render. */
export type CallModerationActions = {
  mute: boolean;
  deafen: boolean;
  disconnect: boolean;
};

const NOTHING: CallModerationActions = {
  mute: false,
  deafen: false,
  disconnect: false,
};

/**
 * Decide which moderation entries the menu may show.
 *
 * `permissions` is undefined when there is no server context at all — a DM
 * or group call. Those calls have no moderators, so nothing is offered; that
 * is a real case, not a loading state, and it must not fall through to
 * "allowed".
 */
export function callModerationActions(
  subject: CallModerationSubject,
  permissions?: CallModerationPermissions,
): CallModerationActions {
  if (!permissions) return NOTHING;

  // Acting on yourself is never offered. Self-mute and self-deafen already
  // exist as ordinary call controls, and a server mute applied to yourself
  // is only liftable from this same menu.
  if (subject.isSelf) return NOTHING;

  // Rank gates everything, so check it before the per-action permissions.
  if (!subject.isInferiorToActor) return NOTHING;

  return {
    // Offered in BOTH states: these render as toggles, and withholding the
    // entry while someone is muted would make a server mute permanent as far
    // as the UI is concerned. The current state is read at the call site.
    mute: permissions.muteMembers,
    deafen: permissions.deafenMembers,
    // Disconnecting someone who already left silently does nothing.
    disconnect: permissions.moveMembersInSource && subject.isConnected,
  };
}

/**
 * Whether the menu may offer "Move to…" for this participant at all.
 *
 * This is the SOURCE-side gate only. Which destinations to list is decided by
 * `moveTargets` in `voiceMovePolicy`, which checks Connect and MoveMembers on
 * each destination.
 *
 * Unlike the moderation entries, moving yourself IS offered: a self-move is
 * an ordinary channel switch that `member_edit` allows with Connect on the
 * destination alone, so no permission here is needed for it.
 */
export function canOfferMove(
  subject: CallModerationSubject,
  permissions?: CallModerationPermissions,
): boolean {
  // No server context (a DM or group call): there is no other voice channel
  // to move to. Same "not loaded is not allowed" rule as above.
  if (!permissions) return false;

  // Moving someone who is not in voice is refused with `NotConnected`.
  if (!subject.isConnected) return false;

  if (subject.isSelf) return true;

  // Moving someone else needs MoveMembers on the channel they are taken out
  // of, and a strictly higher rank (`NotElevated` otherwise).
  return subject.isInferiorToActor && permissions.moveMembersInSource;
}

/** Whether any entry is offered, i.e. whether to render the section at all. */
export function hasCallModerationActions(
  actions: CallModerationActions,
): boolean {
  return actions.mute || actions.deafen || actions.disconnect;
}
