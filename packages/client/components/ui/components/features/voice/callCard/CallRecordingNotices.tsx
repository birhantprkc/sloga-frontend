import { createEffect } from "solid-js";

import { useVoice } from "@revolt/rtc";

import { useSnackbar } from "../../../design/Snackbar";

/**
 * Turns a finished recording into a snackbar: where it was saved, or why it
 * wasn't.
 *
 * **Why this component exists at all.** The `Voice` instance is constructed
 * inside `VoiceContext`, which wraps `SnackbarProvider` — so Voice sits OUTSIDE
 * the snackbar context and cannot show one itself. It publishes a
 * `recordingNotice` signal instead and this reads it.
 *
 * **Why it is mounted at APP level** (`Interface.tsx`), not in the call card:
 * the most important notice is the one that fires when a recording ends, and a
 * recording very often ends by LEAVING THE CALL — which unmounts the card. Put
 * here, it would have been destroyed in the same tick as the message it needed
 * to deliver. Same reasoning as `RemoteControlOverlays`.
 *
 * **Why it is not optional.** The save path used to fail silently: the fallback
 * anchor download reports success and writes nothing in an embedded webview, so
 * a recording could disappear with no error in the UI or the console. Every
 * terminal outcome now says something out loud.
 */
export function CallRecordingNotices() {
  const voice = useVoice();
  const snackbar = useSnackbar();

  // Keyed on `at` so two identical outcomes in a row (stop, record, stop again
  // into the same file) still each produce their own snackbar.
  let lastSeen = 0;

  createEffect(() => {
    const notice = voice.recordingNotice();
    if (!notice || notice.at === lastSeen) return;
    lastSeen = notice.at;

    snackbar.show({
      message: notice.message,
      // A failure stays until dismissed; a success clears itself. Someone who
      // has just lost a recording should not have to catch a 5-second toast to
      // find out.
      autoCloseDelay: notice.kind === "failed" ? 0 : 6000,
      closeable: true,
      messageLine: 2,
    });
  });

  return null;
}
