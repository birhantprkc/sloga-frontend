import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import { screenAudioAvailableSync, useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { Match, Show, Switch, createMemo } from "solid-js";
import { Modals } from "../types";
import { ScreenShareQualityLabel } from "./ScreenShareQualityLabel";

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

  // Audio is on the table either because a track already exists (every
  // other platform, and a Linux share that auto-matched) or because the
  // Linux shell can capture it as soon as the user says which app
  // (screenshare-audio design §9 — the chooser opens after this dialog).
  // Both answer the checkbox the same way; only the note below differs.
  const audioOffered = createMemo(
    () => props.audio || props.audioChoice === true,
  );

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(
      voice.screenShareQuality || "low",
      { required: true },
    ),
    audio: createFormControl(audioOffered() && voice.screenShareAudio, {
      disabled: !audioOffered(),
    }),
    shield: createFormControl(voice.screenShareShield),
    dontAsk: createFormControl(false),
  });

  async function onSubmit() {
    if (group.controls.dontAsk.value) {
      voice.screenShareQuality = group.controls.qualityName.value;
      voice.screenShareQualityAsk = false;
      // Only when audio was actually on offer. When the capture failed
      // (or this platform has none) the checkbox is hidden and reads
      // false, so persisting it would let one PipeWire hiccup turn screen
      // audio off for good — and with the ask dialog now gone too, the
      // user never sees the checkbox again to notice.
      if (audioOffered()) {
        voice.screenShareAudio = group.controls.audio.value;
      }
    }

    // The shield persists unconditionally (unlike quality, it is a privacy
    // preference, not a per-share tweak) and syncs the LIVE track — this
    // modal opens after the track has already published.
    voice.screenShareShield = group.controls.shield.value;
    void voiceContext.applyScreenShareShield();

    props.callback(
      group.controls.qualityName.value,
      group.controls.audio.value && audioOffered(),
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
          <Show when={audioOffered()}>
            <Form2.Checkbox control={group.controls.audio}>
              <Trans>Share audio</Trans>
            </Form2.Checkbox>
            {/* Reason-agnostic on purpose: the chooser is raised by an
                opaque Wayland portal, an unreadable or lying window pid,
                two applications in one process tree, and a resolution
                that timed out. Naming one would be wrong for the rest. */}
            <Show when={props.audioChoice}>
              <small>
                <Trans>
                  Sloga can't tell which app's sound belongs to this share —
                  you'll pick one next.
                </Trans>
              </small>
            </Show>
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
          <Show when={!audioOffered()}>
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
                {/* Capability-keyed, not UA-keyed (screenshare-audio design
                    §5): a shell with the native PipeWire path must not claim
                    Linux can't do this — it falls through to the generic
                    copy until the slice-3 matrix lands (F7: the lighting
                    release requires that matrix for exactly this reason).
                    Web browsers on Linux, old shells and PulseAudio hosts
                    keep the message. */}
                <Match when={isLinux && !screenAudioAvailableSync()}>
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
