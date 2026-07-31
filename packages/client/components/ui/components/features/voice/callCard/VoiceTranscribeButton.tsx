import { Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Transcribe button for the call bar.
 *
 * Turns the call into text on THIS machine — the audio never leaves it, which
 * is forced rather than chosen (the server holds no media keys, see
 * `transcriptionEngine.ts`). Like recording, pressing this has two
 * consequences and the tooltip names both: a transcript starts, and everyone
 * in the call is told.
 *
 * Permission is not pre-checked, for the same reason as the record button: the
 * route is the authority on the `RecordCall` bit and a client-side copy of that
 * rule would drift. Shell capability IS checked, because a button that cannot
 * work should not look available.
 */
export function VoiceTranscribeButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const state = useState();
  const { t } = useLingui();

  const supported = voice.transcriptionSupported;
  const transcribing = () => voice.transcribing();
  const busy = () => voice.transcriptionBusy();
  const loading = () => voice.transcriptionLoading();

  const tooltip = () => {
    if (!supported) return t`Transcription isn't supported on this device`;

    const progress = loading();
    if (progress !== undefined) {
      // The first run fetches the speech model. Say so, or a button that sits
      // disabled for half a minute reads as broken.
      return t`Downloading the speech model… ${Math.round(progress * 100)}%`;
    }

    const error = voice.transcriptionError();
    if (error) return error;
    if (transcribing()) return t`Stop transcribing`;
    return t`Write down what's said, on this device — everyone in the call will be told`;
  };

  return (
    <IconButton
      size={props.size}
      variant={transcribing() ? "filled" : "tonal"}
      isDisabled={!supported || busy()}
      onPress={() =>
        void voice.toggleTranscription({
          language:
            (state.settings.getValue("transcription:language") as string) || "",
        })
      }
      use:floating={{
        tooltip: { placement: "top", content: tooltip() },
      }}
    >
      <Show
        when={transcribing()}
        fallback={
          <Symbol>
            {loading() !== undefined ? "downloading" : "subtitles"}
          </Symbol>
        }
      >
        <TranscribingMark>
          <Symbol>subtitles</Symbol>
        </TranscribingMark>
      </Show>
    </IconButton>
  );
}

/**
 * Live-transcription pulse, matching the recording dot: a slow low-contrast
 * fade rather than a blink, and simply on under `prefers-reduced-motion`. The
 * state is carried by the filled button, never by the animation alone.
 */
const TranscribingMark = styled("span", {
  base: {
    display: "inline-flex",
    color: "var(--md-sys-color-error)",

    animation: "voiceRecordingPulse 2s ease-in-out infinite",

    "@media (prefers-reduced-motion: reduce)": {
      animation: "none",
    },
  },
});
