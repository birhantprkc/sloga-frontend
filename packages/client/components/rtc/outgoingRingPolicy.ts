/**
 * Outgoing-ring decision for DM/Group calls (a sibling of `mlsAdmitPolicy` —
 * PURE so it is unit-testable in isolation).
 *
 * WHY THIS EXISTS. The sound controller has synthesized BOTH ringtone legs
 * since ringtones shipped, and the outgoing leg was even user-configurable in
 * Settings → Notifications — but nothing ever called
 * `playSound("ringtoneOutgoing")` outside that settings preview. The caller
 * sat in silence with no feedback that peers were being rung, while the
 * callee's side rang normally. This module is the missing decision: given a
 * voice-channel membership event, should the OUTGOING ring start, stop, or be
 * left alone.
 *
 * Model. There is no separate "ringing" signalling: starting a call IS
 * joining the empty voice channel of a DM/Group, and peers ring off the
 * resulting `VoiceChannelJoin` fan-out (`NotificationsWorker`). So the
 * outgoing-ring state is fully derivable from the same events:
 *
 * - OUR join that OPENS the call (we are the sole participant) — we are the
 *   caller, waiting: ring.
 * - Any remote join while we are a participant — the callee answered (or a
 *   later group member joined an ongoing call, where stopping is a no-op):
 *   stop.
 * - OUR join into an already-populated call — we are the answerer, not the
 *   caller: stop (this also kills the INCOMING ring, as before).
 * - OUR leave — we hung up before anyone answered: stop. (The local
 *   `disconnect()` path stops the ring synchronously as well; this event
 *   covers server-driven removals, e.g. being kicked from the call.)
 *
 * A callee's Decline is deliberately local-only (`IncomingCallOverlay`) — no
 * event reaches the caller — so the decline case, like the plain unanswered
 * case, ends at the synthesized ringtone's natural stop (30 rings, ~45 s;
 * the same bound `INCOMING_CALL_TIMEOUT_MS` mirrors on the incoming side).
 * No timer is needed here.
 *
 * The inputs describe the channel state AFTER the event was applied:
 * stoat.js mutates `voiceParticipants` before emitting, so on a join the
 * joiner is already counted, and on a leave the leaver is already gone.
 */

/** What the sound controller should do with the outgoing ring. */
export type OutgoingRingAction = "play" | "stop" | "none";

/**
 * Only DM and Group calls ring anybody — joining a server voice channel
 * summons no one, so it plays no outgoing ring (mirroring the incoming
 * side's gate).
 */
export function isRingableChannelType(channelType: string): boolean {
  return channelType === "DirectMessage" || channelType === "Group";
}

/**
 * Decide the outgoing-ring action for a `voiceChannelJoin` event.
 *
 * `participantCount` and `selfIsParticipant` reflect the roster WITH the
 * joiner already in it (see module doc). "We joined and the call has exactly
 * one participant" therefore means we opened the call — the only case that
 * rings. Whether the ring is actually audible stays the sound controller's
 * business (`canPlay` honors the user's "Outgoing Call Ringtone" toggle).
 *
 * Note the asymmetry with the incoming leg: incoming is suppressed on native
 * platforms because the Android call notification already rings, but there
 * is no native ringer for the outgoing leg, so "play" applies on every
 * platform.
 */
export function outgoingRingOnVoiceJoin(input: {
  channelType: string;
  joinerIsSelf: boolean;
  /** Whether WE are in the call, after the join was applied. */
  selfIsParticipant: boolean;
  /** Roster size after the join was applied (>= 1 by construction). */
  participantCount: number;
}): OutgoingRingAction {
  if (!isRingableChannelType(input.channelType)) return "none";

  if (input.joinerIsSelf) {
    // Sole participant: our join opened the call, so we are ringing peers.
    // Anything else: we answered (or rejoined) an ongoing call — make sure
    // no ring (incoming OR a stale outgoing) survives into it.
    return input.participantCount === 1 ? "play" : "stop";
  }

  // A remote join is only our business while we are in the call — that is
  // the callee answering (or a later group joiner, where stop is a no-op).
  // Otherwise it is the INCOMING side's event, not ours.
  return input.selfIsParticipant ? "stop" : "none";
}

/**
 * Decide the outgoing-ring action for a `voiceChannelLeave` event.
 *
 * Only OUR OWN leave stops the ring here: it is the caller cancelling (or
 * being removed). A remote leave never affects the outgoing ring — while we
 * ring we are the sole participant, so there is no remote to leave; and the
 * incoming side's own "caller gave up" stop (roster emptied) already lives
 * in `NotificationsWorker`.
 */
export function outgoingRingOnVoiceLeave(input: {
  channelType: string;
  leaverIsSelf: boolean;
}): OutgoingRingAction {
  if (!isRingableChannelType(input.channelType)) return "none";
  return input.leaverIsSelf ? "stop" : "none";
}
