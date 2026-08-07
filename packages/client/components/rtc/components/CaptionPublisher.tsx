import { createEffect, onCleanup } from "solid-js";

import { useState } from "@revolt/state";

import { useVoice } from "..";

/**
 * Headless controller that drives local caption broadcasting from settings +
 * call state. Mounted inside <InRoom>, so it only lives for the duration of a
 * connected call.
 *
 * Captions never broadcast on an E2EE call (recognition audio would reach
 * Google and the transcript would pass through the server in plaintext), nor
 * while the microphone is muted (a muted user must not leak speech as text).
 */
export function CaptionPublisher() {
  const voice = useVoice();
  const state = useState();

  createEffect(() => {
    const enabled = !!state.settings.getValue("captions:enabled");
    const spoken =
      (state.settings.getValue("captions:spoken") as string) ||
      navigator.language ||
      "en-US";
    const mode = voice.callMode();
    const micOn = voice.microphone();
    // Fail-closed E2EE gate: on a call that CAN be encrypted, broadcast only
    // when the mode is POSITIVELY plaintext ("off"). An undefined/negotiating
    // mode is treated as unsafe — during the E2EE negotiation window callMode()
    // is undefined, and recognition ships mic audio to the speech vendor while
    // the transcript passes through the SERVER in plaintext. That last part is
    // a stronger reason than it used to be: captions once rode a peer-to-SFU
    // data channel, and now the relay sees the text. A non-capable call
    // (e.g. web shell, or "Encrypt my calls" off) is always plaintext.
    const plaintextSafe = voice.callE2EECapable()
      ? mode?.kind === "off"
      : true;
    voice.captions.setLocalPublishing(enabled && micOn && plaintextSafe, spoken);
  });

  onCleanup(() => voice.captions.setLocalPublishing(false, "en-US"));

  return null;
}
