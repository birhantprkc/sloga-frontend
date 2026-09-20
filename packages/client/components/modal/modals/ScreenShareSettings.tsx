import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { createFormControl, createFormGroup } from "solid-forms";

import {
  screenAudioAvailableSync,
  useVoice,
  winScreenAudioPickerSuppressed,
  winScreenAudioSupported,
} from "@revolt/rtc";
import { useState } from "@revolt/state";
import { ScreenShareQualityName } from "@revolt/state/stores/Voice";
import { Column, Dialog, DialogProps, Form2 } from "@revolt/ui";
import { VideoTrack } from "solid-livekit-components";

import { Match, Show, Switch, createMemo, createResource } from "solid-js";
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

  // WINDOWS. Read ONCE and synchronously, exactly as the share path reads it,
  // so this dialog and the capture decision cannot disagree within one share.
  // True only for a lit build on a Windows Tauri shell — the set of hosts
  // where the browser's own "share system audio" checkbox has been removed.
  const pickerAudioGone = winScreenAudioPickerSuppressed();
  const [nativeAudio] = createResource(() => winScreenAudioSupported());

  // 🔴 Whether this share can carry audio at all is a PREFERENCE question on a
  // capable Windows shell, not only a live-track question. `props.audio` is
  // false whenever there is no audio publication — INCLUDING when the user
  // turned "Share audio" off — and hiding the checkbox in that state made the
  // setting a ONE-WAY DOOR: this component is the only writer of
  // `screenShareAudio` in the client, the browser checkbox that used to offer
  // it is gone on that shell, and Settings has no toggle for it. So the
  // checkbox stays visible and usable wherever it is the only lever.
  const audioIsPreference = () => audioOffered() || pickerAudioGone;

  // The state the checkbox exists to escape: capable shell, no audio
  // publication. There is no live track to untick, so the control has no
  // per-share meaning left and its only coherent meaning is the stored
  // preference — which is why it writes through on submit without requiring
  // "Don't ask me again".
  const recoveringPreference = () => pickerAudioGone && !props.audio;

  const group = createFormGroup({
    qualityName: createFormControl<ScreenShareQualityName>(
      voice.screenShareQuality || "low",
      { required: true },
    ),
    audio: createFormControl(audioIsPreference() && voice.screenShareAudio, {
      disabled: !audioIsPreference(),
    }),
    shield: createFormControl(voice.screenShareShield),
    dontAsk: createFormControl(false),
  });

  async function onSubmit() {
    if (group.controls.dontAsk.value) {
      voice.screenShareQuality = group.controls.qualityName.value;
      voice.screenShareQualityAsk = false;
      // Only when the control was actually usable. When the capture failed
      // (or this platform has none) the checkbox is hidden and reads
      // false, so persisting it would let one PipeWire hiccup turn screen
      // audio off for good — and with the ask dialog now gone too, the
      // user never sees the checkbox again to notice. 🔴 On a capable
      // Windows shell the same write is what cemented the one-way door:
      // "don't ask me again" wrote a DISABLED, forced-false checkbox over
      // the setting on a shell where nothing else can turn it back on.
      if (audioIsPreference()) {
        voice.screenShareAudio = group.controls.audio.value;
      }
    }

    // 🔴 The recovery case writes through WITHOUT "don't ask me again":
    // there is no audio publication for the checkbox to govern this time
    // round, so the preference is the only thing it can mean, and requiring
    // a second, unrelated checkbox to make it stick is what made the setting
    // a one-way door in the first place.
    if (recoveringPreference()) {
      voice.screenShareAudio = group.controls.audio.value;
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
          <Show when={audioIsPreference()}>
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
          {/* The Windows capability resource is only consulted on shells that
              could be capable, so a Linux or macOS user's help text is never a
              hostage of a Windows probe that will answer "no" anyway. */}
          <Show
            when={!audioOffered() && (!pickerAudioGone || !nativeAudio.loading)}
          >
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
                {/* Capability-keyed, never UA-keyed (screenshare-audio
                    design §9), and capability ALONE here: a true probe
                    already implies the Linux shell, while ANDing `isLinux`
                    in would mean that the day `navigator.platform` stops
                    saying "Linux" (Chromium keeps reducing that surface)
                    neither Linux branch matches and the shell falls through
                    to the generic fallback below — which tells the user to
                    restart the share and pick a tab or a screen, the exact
                    wrong instruction this matrix exists to delete.

                    The states that actually reach this branch, traced
                    through state.tsx rather than taken from §9's prose: the
                    capture failed, or the shell answered `skip` because it
                    cannot say what the share covers. "The user unticked" is
                    NOT among them — this dialog only opens while consent is
                    pending, which forces a capture attempt, and an unticked
                    user gets the checkbox shown unticked instead.

                    So this states an OUTCOME and names no control. The
                    checkbox lives under the complementary `Show`, so it is
                    never on screen beside this line; and on the `skip` path
                    the shell could not have captured sound however the user
                    answered. A capture failure separately raises its own
                    error dialog (onErr) — slice 1's deliberate loud-failure
                    signal — so this has to agree with that, not argue with
                    it. */}
                <Match when={screenAudioAvailableSync()}>
                  <Trans>
                    Sloga couldn't capture this computer's sound for this share.
                  </Trans>
                </Match>
                {/* Web browsers on Linux, shells without the native path,
                    PulseAudio-only hosts, and every build with the flag
                    dark. Must not be removed globally: web Chrome on Linux
                    still cannot capture system audio at all. */}
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
                {/* ------------------------------------------------------- */}
                {/* WINDOWS — the shells with no checkbox.

                    Order inside this group matters: each branch rules out the
                    reason above it. The first two are the ones the user can
                    act on; the last is the catch-all, and it is keyed on the
                    checkbox being GONE rather than on the capture being
                    available, so a shell whose probe never settled lands here
                    instead of on the fallback's tick-the-box advice.

                    Order against the Linux and macOS branches above does NOT
                    matter, and that is by construction rather than by luck:
                    `pickerAudioGone` and `nativeAudio()` can only be true on a
                    lit Windows Tauri shell, where `isMac` is false and
                    `screenAudioAvailableSync()` — which reads the Electron
                    PipeWire surface — has nothing to find. The two groups are
                    mutually exclusive. */}
                <Match when={nativeAudio() && !props.entireScreen}>
                  <Trans>
                    Only entire-screen shares carry your computer's audio.
                    Restart the share and pick a whole screen instead of a
                    window.
                  </Trans>
                </Match>
                <Match when={nativeAudio() && !voice.screenShareAudio}>
                  <Trans>
                    This share is silent because "Share audio" is turned off.
                    Tick it above and restart the share to include your
                    computer's sound.
                  </Trans>
                </Match>
                {/* 🔴 No "your screen is still being shared" reassurance
                    here. This branch is also what renders after an E2EE
                    teardown stopped the audio, and in that case the cause is
                    a missing transform — which livekit installs per sender
                    from the same worker, so the screen VIDEO is in the same
                    state. Telling the user the screen is still going out
                    would be presenting the bad half as good news. The
                    encryption failure raises its own blocking modal, which is
                    where that story belongs; this line stays narrow. */}
                <Match when={pickerAudioGone}>
                  <Trans>
                    Sloga couldn't capture your computer's audio for this share.
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
