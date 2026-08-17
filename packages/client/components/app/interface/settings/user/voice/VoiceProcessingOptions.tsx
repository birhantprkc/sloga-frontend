import { createSignal, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { DISABLE_WEB_AUDIO_MIX_KEY } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Slider, Text } from "@revolt/ui";

import { InputSensitivity } from "./InputSensitivity";

/**
 * Voice processing options
 */
export function VoiceProcessingOptions() {
  const { voice } = useState();
  const [bindingKey, setBindingKey] = createSignal(false);

  function startBinding() {
    setBindingKey(true);

    function onKey(e: KeyboardEvent) {
      e.preventDefault();
      voice.pushToTalkKey = e.code;
      setBindingKey(false);
      window.removeEventListener("keydown", onKey);
    }

    window.addEventListener("keydown", onKey);
  }

  function formatKey(code: string) {
    return code
      .replace("Key", "")
      .replace("Digit", "")
      .replace("Arrow", "↑↓←→".includes(code) ? "" : "Arrow ")
      .replace("Space", "Space");
  }

  return (
    <Column>
      <Text class="title">
        <Trans>Microphone Gain</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          description={
            <Column gap="sm">
              <Text class="label"><Trans>Gain: {voice.microphoneGain}%</Trans></Text>
              <Slider
                min={0}
                max={200}
                step={1}
                value={voice.microphoneGain}
                onInput={(e) => (voice.microphoneGain = Number(e.currentTarget.value))}
                labelFormatter={(v) => `${v}%`}
              />
            </Column>
          }
        >
          <Trans>Input Gain</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Voice Processing</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton.Select
          icon={"blank"}
          title={<Trans>Select noise suppression</Trans>}
          options={{
            disabled: { title: <Trans>Disabled</Trans> },
            browser: { title: <Trans>Browser</Trans> },
            enhanced: {
              title: <Trans>Enhanced</Trans>,
              description: <Trans>Powered by RNNoise</Trans>,
              shortDesc: <Trans>Enhanced (RNNoise)</Trans>,
            },
          }}
          value={voice.noiseSupression}
          onUpdate={(ns) => (voice.noiseSupression = ns)}
        />
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.echoCancellation} />}
          onClick={() => (voice.echoCancellation = !voice.echoCancellation)}
        >
          <Trans>Browser Echo Cancellation</Trans>
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.autoGainControl} />}
          onClick={() => (voice.autoGainControl = !voice.autoGainControl)}
        >
          <Trans>Automatic Gain Control</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Incoming Voices</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.audioNormalization} />}
          onClick={() => (voice.audioNormalization = !voice.audioNormalization)}
          description={
            <Column gap="sm">
              <Trans>
                Evens out loud and quiet people automatically. Only voices are
                leveled — music and screen share audio are never touched.
              </Trans>
              {/* §0.3: a feature that silently does nothing is worse than one
                  that says why it is off. The shared mix is what the leveler
                  builds its processing into — and it is read at join time,
                  so turning it back on cannot help the CURRENT call. The
                  localStorage escape hatch disables the mix just as hard as
                  the setting does; check both or this reads as available
                  while support has kill-switched it. */}
              <Show
                when={
                  !voice.webAudioMix ||
                  localStorage.getItem(DISABLE_WEB_AUDIO_MIX_KEY) === "1"
                }
              >
                <Text class="label">
                  <Trans>
                    Unavailable while the shared audio mix is off. Turning the
                    mix back on takes effect when you next join a call.
                  </Trans>
                </Text>
              </Show>
            </Column>
          }
        >
          <Trans>Level Incoming Voices</Trans>
        </CategoryButton>
        <Show when={voice.audioNormalization}>
          <CategoryButton
            icon="blank"
            description={
              <Column gap="sm">
                <Text class="label">
                  <Trans>Strength: {voice.audioNormalizationStrength}%</Trans>
                </Text>
                <Slider
                  min={0}
                  max={100}
                  step={1}
                  value={voice.audioNormalizationStrength}
                  onInput={(e) =>
                    (voice.audioNormalizationStrength = Number(
                      e.currentTarget.value,
                    ))
                  }
                  labelFormatter={(v) => `${v}%`}
                />
                <Text class="label">
                  <Trans>
                    How far a quiet voice may be raised. Loud voices are always
                    tamed, at any strength.
                  </Trans>
                </Text>
              </Column>
            }
          >
            <Trans>Leveling Strength</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Microphone Mode</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.openMic} />}
          onClick={() => voice.setMicrophoneMode("openMic")}
          description={<Trans>Microphone stays on automatically when in a voice channel.</Trans>}
        >
          <Trans>Open Microphone</Trans>
        </CategoryButton>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.vadEnabled} />}
          onClick={() => voice.setMicrophoneMode("vad")}
          description={<Trans>Mic only activates when your volume exceeds the threshold below.</Trans>}
        >
          <Trans>Voice Activity Detection</Trans>
        </CategoryButton>
        <Show when={voice.vadEnabled}>
          <InputSensitivity />
        </Show>
      </CategoryButton.Group>

      <Text class="title">
        <Trans>Push to Talk</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          action={<Checkbox checked={voice.pushToTalk} />}
          onClick={() => voice.setMicrophoneMode("pushToTalk")}
          description={
            <Column gap="sm">
              <Trans>Hold a key to unmute while in a voice channel.</Trans>
              {/* EL-PTT honesty (P5): say which key source this build has
                  instead of silently degrading. */}
              <Show
                when={"__TAURI__" in window}
                fallback={
                  <Text class="label">
                    <Trans>
                      In this build the key only registers while the app is
                      focused — the desktop app supports global push to talk.
                    </Trans>
                  </Text>
                }
              >
                <Text class="label">
                  <Trans>
                    Works globally: the key registers even while your game or
                    another app is focused.
                  </Trans>
                </Text>
              </Show>
            </Column>
          }
        >
          <Trans>Enable Push to Talk</Trans>
        </CategoryButton>
        <Show when={voice.pushToTalk}>
          <CategoryButton
            icon="blank"
            action={
              <span style={{ "font-size": "0.8em", opacity: "0.7", "font-family": "monospace" }}>
                {bindingKey() ? <Trans>Press any key...</Trans> : formatKey(voice.pushToTalkKey)}
              </span>
            }
            onClick={startBinding}
            description={<Trans>Click to change the push to talk keybind.</Trans>}
          >
            <Trans>Push to Talk Key</Trans>
          </CategoryButton>
        </Show>
      </CategoryButton.Group>
    </Column>
  );
}
