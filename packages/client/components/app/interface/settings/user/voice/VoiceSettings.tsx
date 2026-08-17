import { Column } from "@revolt/ui";

import { AttenuationOptions } from "./AttenuationOptions";
import { EntranceSoundOptions } from "./EntranceSoundOptions";
import { MicrophoneLevelMeter } from "./MicrophoneLevelMeter";
import { MicrophoneTest } from "./MicrophoneTest";
import { VoiceInputOptions } from "./VoiceInputOptions";
import { VoiceProcessingOptions } from "./VoiceProcessingOptions";

/**
 * Voice page: microphone and speaker devices, tests, processing, mic mode
 * and push-to-talk. Camera + screen share moved to the Video page and the
 * in-game overlay to its own page — one "Voice & Video" page had grown to
 * a dozen sections and the camera controls were a long scroll away.
 */
export function VoiceSettings() {
  return (
    <Column gap="lg">
      <VoiceInputOptions />
      <MicrophoneLevelMeter />
      <MicrophoneTest />
      <VoiceProcessingOptions />
      <EntranceSoundOptions />
      {/* Renders nothing off desktop: the shell probe answers unsupported. */}
      <AttenuationOptions />
    </Column>
  );
}
