/**
 * Whether a double-click on a channel row in the channel list should join
 * that channel's call (PURE, so the decision is unit-testable away from the
 * sidebar — a sibling of `joinRefusalPolicy`).
 *
 * WHY THIS EXISTS. The channel list used to offer no way into a call at all:
 * clicking a voice channel opened it, and the join lived behind a second
 * press on the header's call button. Double-click closes that gap without
 * touching what the single click means — which is the property the whole
 * design rests on, because it is what makes the setting safe to turn off and
 * what keeps a plain click on a voice channel from ever joining by surprise.
 *
 * The guards are not decoration. A double-click is the easiest affordance in
 * the app to fire twice by accident, and `Voice.connect()` LEAVES the call
 * you are in before it asks the server anything (see `joinRefusalPolicy` and
 * the 2026-09-06 refusal storm) — so a second pair of clicks arriving while
 * the first join is still in flight, or after the server has already refused
 * this channel, must not reach `connect()`. `joinBlocked` covers both; it is
 * the same signal the header buttons disable on.
 */

export type DoubleClickJoinInput = {
  /** Only voice channels have a call to join. */
  isVoiceChannel: boolean;
  /** `voice.joinVoiceOnDoubleClick` — the user's opt-out. */
  settingEnabled: boolean;
  /** `Connect` permission on the channel. */
  canConnect: boolean;
  /** Already connected to THIS channel: a re-join would be a no-op teardown. */
  alreadyInThisCall: boolean;
  /**
   * `Voice.joinBlocked(channel)` is truthy — an attempt for this channel is
   * in flight, or a terminal refusal for it still holds.
   */
  joinBlocked: boolean;
};

/**
 * True when the double-click should call `Voice.connect()` for this channel.
 * Every false case leaves the row behaving exactly as it did before the
 * feature existed: the click pair just navigates, twice.
 */
export function shouldJoinOnDoubleClick(input: DoubleClickJoinInput): boolean {
  if (!input.isVoiceChannel) return false;
  if (!input.settingEnabled) return false;
  if (!input.canConnect) return false;
  if (input.alreadyInThisCall) return false;
  if (input.joinBlocked) return false;
  return true;
}
