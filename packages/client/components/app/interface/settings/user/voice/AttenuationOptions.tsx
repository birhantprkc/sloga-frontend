import { Show, createResource } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import { useVoice } from "@revolt/rtc";
import { attenuationSupported } from "@revolt/rtc/attenuation";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Slider, Text } from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Global attenuation: lower every other application while someone speaks.
 * Desktop (Windows) only — the section renders nothing where the shell
 * cannot set per-application volumes, rather than showing a slider that
 * does nothing.
 */
export function AttenuationOptions() {
  const { voice } = useState();
  const voiceContext = useVoice();
  const [supported] = createResource(attenuationSupported);

  return (
    <Show when={supported() === true}>
      <Column>
        <Text class="title">
          <Trans>Attenuation</Trans>
        </Text>
        <Text class="label">
          <Trans>
            Lower the volume of your games and other applications by this much
            while someone is speaking. Set to 0% to turn it off. Sloga's own
            audio is never lowered.
          </Trans>
        </Text>
        <CategoryButton.Group>
          <CategoryButton
            icon={<Symbol>volume_down</Symbol>}
            description={
              <Column gap="sm">
                {/* The share-audio suspension is otherwise invisible and has
                    been read as "the slider is broken" more than once. */}
                <Show when={voiceContext.attenuationSuspended()}>
                  <Text class="label">
                    <span style={{ color: "var(--md-sys-color-primary)" }}>
                      <Trans>
                        Paused while you share your screen with audio — lowering
                        other applications would also lower the audio your share
                        is sending. It resumes when the share stops.
                      </Trans>
                    </span>
                  </Text>
                </Show>
                <Text class="label">
                  <Show
                    when={voice.attenuationStrength > 0}
                    fallback={<Trans>Off</Trans>}
                  >
                    <Trans>
                      Other applications drop to{" "}
                      {100 - voice.attenuationStrength}% while someone speaks.
                    </Trans>
                  </Show>
                </Text>
                <Slider
                  min={0}
                  max={100}
                  step={5}
                  value={voice.attenuationStrength}
                  onInput={(e) =>
                    (voice.attenuationStrength = Number(e.currentTarget.value))
                  }
                  labelFormatter={(v) => `${v}%`}
                />
              </Column>
            }
          >
            <Trans>Attenuation Strength</Trans>
          </CategoryButton>
          <CategoryButton
            icon="blank"
            action={<Checkbox checked={voice.attenuateWhenISpeak} />}
            onClick={() =>
              (voice.attenuateWhenISpeak = !voice.attenuateWhenISpeak)
            }
          >
            <Trans>When I speak</Trans>
          </CategoryButton>
          <CategoryButton
            icon="blank"
            action={<Checkbox checked={voice.attenuateWhenOthersSpeak} />}
            onClick={() =>
              (voice.attenuateWhenOthersSpeak = !voice.attenuateWhenOthersSpeak)
            }
          >
            <Trans>When others speak</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Column>
    </Show>
  );
}
