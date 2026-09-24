/**
 * AFK channel — the PURE decision core for the client half of the
 * server-designated AFK channel (AFK plan A7), extracted so `node --test` can
 * load it. This module must stay dependency-free: no Solid, no stoat.js, no
 * lingui. The wiring in `state.tsx` reads the reactive accessors and hands the
 * booleans in; every rule below is reachable by a unit test and is called by
 * production, never re-typed there.
 *
 * Why the logic is here and not inline: what shipped before was four lines
 * inside the one-shot `room "connected"` handler, keyed off the channel's
 * NAME. `state.tsx` is ~9.7k lines and the class cannot be instantiated in a
 * unit test, so those four lines were untestable by construction — and they
 * were wrong in four separate ways (defeated by one Unmute press, screen share
 * never blocked, name-keyed so a rename granted it, nothing re-applied after
 * join). Rules that cannot be tested do not stay correct.
 *
 * 🔴 The AFK mute is NOT a permission. The backend gate (plan D2) sits outside
 * `calculate_channel_permissions` on purpose, because that calculus
 * short-circuits to `GrantAllSafe` for the server owner and for privileged
 * accounts — an AFK-as-permission-denial implementation would leave the owner
 * publishing in the AFK channel. The consequence for the client is that
 * `havePermission("Speak")` stays TRUE in the AFK channel, so every affordance
 * has to fold the AFK term in by hand. That is what `voicePublishPermission`
 * is for.
 */

/**
 * The AFK designation predicate.
 *
 * The designation is server-level (`Server.afk_channel_id`), so the test is
 * pointer identity against the channel we are in. `afkChannelId` is
 * `undefined` — never `null` — when no channel is designated, so an undefined
 * pointer can never match an undefined channel id: both guards below are load-
 * bearing, not defensive noise. Without them a call with no channel yet and a
 * server with no AFK channel would compare `undefined === undefined` and
 * report the user AFK.
 */
export function isAfkChannel(
  afkChannelId: string | undefined,
  channelId: string | undefined,
): boolean {
  if (!afkChannelId || !channelId) return false;
  return afkChannelId === channelId;
}

/**
 * One publish-affordance permission accessor, for microphone (`Speak`) or
 * video (`Video`).
 *
 * Order matters: AFK is checked BEFORE the DM/group short-circuit purely for
 * legibility — a DM or group has no server, so `isAfkChannel` is structurally
 * false there and the two orders agree. It is checked before `havePermission`
 * because that is the whole point (see the D2 note above).
 */
export function voicePublishPermission(input: {
  /** False before a channel is known — nothing is permitted yet. */
  hasChannel: boolean;
  /** A DM or a group DM: no server permissions exist, so always allow. */
  isPrivateChannel: boolean;
  isAfkChannel: boolean;
  /** `channel.havePermission("Speak")` / `("Video")`. */
  havePermission: boolean;
}): boolean {
  if (!input.hasChannel) return false;
  if (input.isAfkChannel) return false;
  if (input.isPrivateChannel) return true;
  return input.havePermission;
}

/** Why a publish toggle was refused, or `undefined` for "go ahead". */
export type PublishRefusal = "afk" | "denied";

/**
 * The guard on `toggleMute` / `toggleCamera` / `toggleScreenshare`.
 *
 * 🔴 Only the ENABLING direction is ever refused. A guard that also blocked
 * turning something OFF would trap a user hot: if a channel is designated AFK
 * while someone is already sharing, or a role edit removes `Video` mid-share,
 * the stop button must keep working. "Fail closed" means refusing to start,
 * not refusing to stop.
 *
 * `afk` is reported ahead of `denied` because it is the more specific and more
 * actionable answer — in the AFK channel `voicePublishPermission` is false
 * too, so both would otherwise apply and the user would be told they lack a
 * permission they actually hold.
 */
export function publishToggleRefusal(input: {
  enabling: boolean;
  isAfkChannel: boolean;
  /** The matching accessor: `speakingPermission` or `videoPermission`. */
  permitted: boolean;
}): PublishRefusal | undefined {
  if (!input.enabling) return undefined;
  if (input.isAfkChannel) return "afk";
  if (!input.permitted) return "denied";
  return undefined;
}

/**
 * What the join path does about AFK, replacing the four name-keyed lines that
 * used to sit inline in the `room "connected"` handler.
 *
 * `wantMic` keeps its pre-AFK meaning (honor the persisted pre-call state: a
 * deafened or explicitly muted user never joins with a hot microphone) and
 * adds the AFK term. `attachMicPipeline` is separate because the RNNoise /
 * shaper / gain processor chain is pointless work on a track that will never
 * be published. `forceCameraOff` is unconditional under AFK — the persisted
 * camera state must not survive into the AFK channel.
 */
export function afkJoinPlan(input: {
  isAfkChannel: boolean;
  deafened: boolean;
  micOn: boolean;
}): { wantMic: boolean; attachMicPipeline: boolean; forceCameraOff: boolean } {
  const wantMic = !input.isAfkChannel && !input.deafened && input.micOn;
  return {
    wantMic,
    attachMicPipeline: !input.isAfkChannel,
    forceCameraOff: input.isAfkChannel,
  };
}

/** A falling edge on the SFU's grants, classified for the user-facing copy. */
export type PermissionFallReason =
  | "afk-publish"
  | "moderator-mute"
  | "moderator-deafen";

/**
 * Classify a `RoomEvent.ParticipantPermissionsChanged` edge.
 *
 * 🔴 FALLING EDGES ONLY. The initial grant arrives as a change from
 * `undefined`, which is not a revocation, and a re-grant (the mute being
 * lifted) is not something to interrupt anyone about.
 *
 * 🔴 The AFK branch exists because the shipped copy said "A moderator muted
 * you in this server". Under AFK the publish grant falls for EVERY member who
 * enters the channel, including the server owner, so without this branch every
 * single AFK user would be told a moderator had muted them. The AFK answer
 * replaces the mute answer rather than joining it — they are two explanations
 * of one event, and showing both would be incoherent.
 *
 * The deafen edge is independent: AFK revokes publish, never subscribe, so an
 * AFK user who also loses `canSubscribe` really was deafened by a moderator.
 */
export function permissionFallReasons(input: {
  prevCanPublish: boolean | undefined;
  nowCanPublish: boolean | undefined;
  prevCanSubscribe: boolean | undefined;
  nowCanSubscribe: boolean | undefined;
  isAfkChannel: boolean;
}): PermissionFallReason[] {
  const reasons: PermissionFallReason[] = [];
  if (input.prevCanPublish && !input.nowCanPublish) {
    reasons.push(input.isAfkChannel ? "afk-publish" : "moderator-mute");
  }
  if (input.prevCanSubscribe && !input.nowCanSubscribe) {
    reasons.push("moderator-deafen");
  }
  return reasons;
}
