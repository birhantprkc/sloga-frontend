import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { Match, Show, Switch } from "solid-js";
import { ScreenShareQualityLabel } from "./ScreenShareQualityLabel";
import { Modals } from "../types";

// Why the capture came back without audio differs by OS, and the old
// one-liner ("Audio disabled by browser") read as breakage everywhere.
// Android's WebView reports platform "Linux armv8l", so exclude it rather
// than tell phone users about desktop Linux.
const isLinux =
  navigator.platform.includes("Linux") && !/Android/i.test(navigator.userAgent);
const isMac = navigator.platform.startsWith("Mac");

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
    // 820 is deliberately past Dialog's own 560px maxWidth -- an inline
    // min-width beats max-width in CSS, which is the only way to widen this.
    // It has to be wide: Form2.ButtonGroup renders its Row with
    // justify="stretch", i.e. `& * { flex: 1 }`, so every tier button is
    // forced to an identical flex-basis:0 width no matter what it says.
    // Content width is ignored, so total dialog width is the ONLY lever;
    // below ~117px/button the button is narrower than "Source" and splits
    // the word. 700 covered six tiers; the Game tier makes seven.
    <Dialog
      minWidth={820}
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
              Privacy shield — hide pop-up notifications (pixelates the corner
              of full-screen shares when something appears there)
            </Trans>
          </Form2.Checkbox>
          <Form2.Checkbox control={group.controls.dontAsk}>
            <Trans>Don't ask me again</Trans>
          </Form2.Checkbox>
          <Show when={!props.audio}>
            <small>
              <Switch
                fallback={
                  <Trans>
                    This share has no audio. To include sound, restart the share
                    and pick a tab or your entire screen with "Share system
                    audio" enabled.
                  </Trans>
                }
              >
                <Match when={isLinux}>
                  <Trans>
                    System audio capture isn't supported on Linux yet.
                  </Trans>
                </Match>
                <Match when={isMac}>
                  <Trans>
                    On macOS the browser can only capture audio when sharing a
                    tab — restart the share and pick a tab to include its sound.
                  </Trans>
                </Match>
              </Switch>
            </small>
          </Show>
        </Column>
      </form>
    </Dialog>
  );
}
