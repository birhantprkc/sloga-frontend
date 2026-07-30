import { Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Record button for the call bar — DMs, group DMs and server voice channels.
 *
 * Records the call's audio to THIS machine (see `callRecorder.ts` for why it
 * cannot be server-side) and tells the call it is happening. The tooltip says
 * "everyone will be told" rather than promising privacy or consent: pressing
 * this both starts a recording and discloses it, and the button should not
 * hide either half.
 *
 * Permission is NOT pre-checked here. The `RecordCall` bit is a server-channel
 * concept with a DM/group carve-out and an owner/privileged short-circuit, so
 * mirroring that rule client-side would mean maintaining a second copy of it
 * that drifts. The route is the authority; a refusal surfaces as the button's
 * error state. What IS checked here is shell capability, because a button that
 * cannot possibly work should not look available.
 */
export function VoiceRecordButton(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const { t } = useLingui();

  const supported = voice.recordingSupported;
  const recording = () => voice.recording();
  const busy = () => voice.recordingBusy();

  const tooltip = () => {
    if (!supported) return t`Recording isn't supported on this device`;
    const error = voice.recordingError();
    if (error) return error;
    if (recording()) return t`Stop recording`;
    // Names BOTH consequences of the click, because both are surprising if
    // unmentioned: a file dialog opens, and everyone in the call is told.
    return voice.recordingSavesToFile
      ? t`Record the call audio — you'll choose where to save it, and everyone in the call will be told`
      : t`Record the call audio — everyone in the call will be told`;
  };

  return (
    <IconButton
      size={props.size}
      variant={recording() ? "filled" : "tonal"}
      isDisabled={!supported || busy()}
      onPress={() => void voice.toggleRecording()}
      use:floating={{
        tooltip: { placement: "top", content: tooltip() },
      }}
    >
      <Show when={recording()} fallback={<Symbol>radio_button_checked</Symbol>}>
        <RecordingDot>
          <Symbol>stop_circle</Symbol>
        </RecordingDot>
      </Show>
    </IconButton>
  );
}

/**
 * The live-recording pulse. Held to a slow, low-contrast fade rather than a
 * hard blink: this sits in a call bar for the whole recording, and something
 * flashing in peripheral vision for an hour is genuinely unpleasant. Honours
 * `prefers-reduced-motion` by simply staying on — the state is carried by the
 * filled button and the icon, never by the animation alone.
 */
const RecordingDot = styled("span", {
  base: {
    display: "inline-flex",
    color: "var(--md-sys-color-error)",

    animation: "voiceRecordingPulse 2s ease-in-out infinite",

    "@media (prefers-reduced-motion: reduce)": {
      animation: "none",
    },
  },
});
