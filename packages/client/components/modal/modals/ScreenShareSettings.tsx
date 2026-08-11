import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { Show } from "solid-js";
import { ScreenShareQualityLabel } from "./ScreenShareQualityLabel";
import { Modals } from "../types";

export function ScreenShareSettingsModal(
  props: DialogProps & Modals & { type: "screen_share_settings" },
) {
  const { voice } = useState();
  const voiceContext = useVoice();
  const { t } = useLingui();

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(
      voice.screenShareQuality || "low",
      { required: true },
    ),
    audio: createFormControl(props.audio && voice.screenShareAudio, {
      disabled: !props.audio,
    }),
    shield: createFormControl(voice.screenShareShield),
    dontAsk: createFormControl(false),
  });

  async function onSubmit() {
    if (group.controls.dontAsk.value) {
      voice.screenShareQuality = group.controls.qualityName.value;
      voice.screenShareQualityAsk = false;
      voice.screenShareAudio = group.controls.audio.value;
    }

    // The shield persists unconditionally (unlike quality, it is a privacy
    // preference, not a per-share tweak) and syncs the LIVE track — this
    // modal opens after the track has already published.
    voice.screenShareShield = group.controls.shield.value;
    void voiceContext.applyScreenShareShield();

    props.callback(
      group.controls.qualityName.value,
      group.controls.audio.value && props.audio,
    );
    props.onClose();
  }

  const submit = Form2.useSubmitHandler(group, onSubmit);

  return (
    // 700 is deliberately past Dialog's own 560px maxWidth -- an inline
    // min-width beats max-width in CSS, which is the only way to widen this.
    // It has to be wide: Form2.ButtonGroup renders its Row with
    // justify="stretch", i.e. `& * { flex: 1 }`, so every tier button is
    // forced to an identical flex-basis:0 width no matter what it says.
    // Content width is ignored, so total dialog width is the ONLY lever, and
    // below ~700px the button is narrower than "Source" and splits the word.
    <Dialog
      minWidth={700}
      show={props.show}
      onClose={() => {
        props.onCancel();
        props.onClose();
      }}
      title={t`Screen Share Settings`}
      actions={[
        { text: <Trans>Cancel</Trans> },
        {
          text: <Trans>Go</Trans>,
          onClick: () => {
            onSubmit();
            return false;
          },
        },
      ]}
    >
      <VideoTrack
        trackRef={props.trackReference}
        style={{
          padding: "var(--gap-md)",
          "border-radius": "var(--borderRadius-lg)",
          "max-height": "440px",
          "justify-self": "center",
        }}
      />
      <form onSubmit={submit}>
        <Column>
          <Form2.ButtonGroup
            control={group.controls.qualityName}
            buttonDefinitions={props.qualities.map((quality) => {
              return {
                children: (
                  <ScreenShareQualityLabel fullName={quality.fullName} />
                ),
                value: quality.name,
              };
            })}
          />
          <Show when={props.audio}>
            <Form2.Checkbox control={group.controls.audio}>
              <Trans>Share audio</Trans>
            </Form2.Checkbox>
          </Show>
          <Form2.Checkbox control={group.controls.shield}>
            <Trans>
              Privacy shield — hide pop-up notifications (blurs the corner of
              full-screen shares when something appears there)
            </Trans>
          </Form2.Checkbox>
          <Form2.Checkbox control={group.controls.dontAsk}>
            <Trans>Don't ask me again</Trans>
          </Form2.Checkbox>
          <Show when={!props.audio}>
            <small>
              <Trans>Audio disabled by browser</Trans>
            </small>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
