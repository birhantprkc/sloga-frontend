import { createEffect, untrack } from "solid-js";

import { useVoice } from "@revolt/rtc";

import { useSnackbar } from "../../../design/Snackbar";

/**
 * Turns a followed server-side move ("Moved to #channel") into a snackbar.
 *
 * **Why this component exists at all.** The `Voice` instance is constructed
 * inside `VoiceContext`, which wraps `SnackbarProvider`, so Voice sits OUTSIDE
 * the snackbar context and cannot show one itself. It publishes a
 * `moveNotice` signal instead and this reads it. Same shape and reasoning as
 * `CallRecordingNotices`.
 *
 * **Why it is mounted at APP level** (`Interface.tsx`), not in the call card:
 * following a move is a full `connect()` to the destination, which tears down
 * the source call and its card. Mounted there, this would be destroyed around
 * the very move it has to announce.
 *
 * **Success only, so it auto-closes.** `#followMove` sets `moveNotice` only
 * once the destination call has actually been joined. Every failure of a move
 * (an unavailable destination, a join that could not be made) goes through
 * `onErr` instead, and a latched refusal is already reported by `connect()`.
 *
 * Shows `notice.message` and nothing else: state.tsx builds it from the
 * destination's cached display name only, never from the move event, which
 * carries a live SFU credential.
 */
export function VoiceMoveNotices() {
  const voice = useVoice();
  const snackbar = useSnackbar();

  // Keyed on `at`, not on the message: being moved twice to the same channel
  // still produces a snackbar each time, while any re-run of this effect that
  // is not a new notice (should it ever track something else) does not replay
  // the current one. Seeded from the notice already standing: `Voice` lives
  // above the router, so a remount of `Interface` (sign out and back in)
  // would otherwise replay the last move as if it had just happened.
  let lastSeen = untrack(voice.moveNotice)?.at ?? 0;

  createEffect(() => {
    const notice = voice.moveNotice();
    if (!notice || notice.at === lastSeen) return;
    lastSeen = notice.at;

    snackbar.show({
      message: notice.message,
      autoCloseDelay: 6000,
      closeable: true,
      messageLine: 2,
    });
  });

  return null;
}
