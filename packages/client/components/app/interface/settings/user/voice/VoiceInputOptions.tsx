import { Show, createMemo } from "solid-js";
import { useMediaDeviceSelect } from "solid-livekit-components";

import { Trans } from "@lingui-solid/solid/macro";

import {
  type DeviceListVerdict,
  deviceListVerdict,
  permissionNameFor,
} from "@revolt/rtc/mediaAccessPolicy";
import { createMediaPermissionState } from "@revolt/rtc/mediaPermission";
import { useState } from "@revolt/state";
import {
  CategoryButton,
  CategorySelectOption,
  Column,
  Slider,
  Text,
} from "@revolt/ui";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

/**
 * Audio device selection + output volume (Voice page).
 */
export function VoiceInputOptions() {
  return (
    <Column>
      <CategoryButton.Group>
        <SelectInput kind="audioinput" />
        <SelectInput kind="audiooutput" />
      </CategoryButton.Group>
      <VolumeSliders />
    </Column>
  );
}

/**
 * Camera device selection (Video page). Same select as the audio devices,
 * split out so the camera has a page of its own instead of sharing a group
 * with the microphone and speakers.
 */
export function VideoInputOptions() {
  return (
    <CategoryButton.Group>
      <SelectInput kind="videoinput" />
    </CategoryButton.Group>
  );
}

/**
 * Select input device w/ type
 */
function SelectInput(props: { kind: MediaDeviceKind }) {
  const state = useState();
  const media = createMemo(() => useMediaDeviceSelect({ kind: props.kind }));

  const setKey = () =>
    props.kind === "videoinput"
      ? "preferredVideoDevice"
      : props.kind === "audioinput"
        ? "preferredAudioInputDevice"
        : "preferredAudioOutputDevice";

  const icon = () =>
    props.kind === "videoinput" ? (
      <Symbol>camera_video</Symbol>
    ) : props.kind === "audioinput" ? (
      <Symbol>mic</Symbol>
    ) : (
      <Symbol>speaker</Symbol>
    );

  const title = () =>
    props.kind === "videoinput" ? (
      <Trans>Select video input</Trans>
    ) : props.kind === "audioinput" ? (
      <Trans>Select audio input</Trans>
    ) : (
      <Trans>Select audio output</Trans>
    );

  const activeId = createMemo(() => state.voice[setKey()] ?? "default");

  const devOpts = createMemo(() => {
    const devs = media().devices(),
      opts: { [k in string]: CategorySelectOption } = {};

    //Ensure default is at top
    let d = devs.find((d) => d.deviceId === "default");
    opts.default = { title: d?.label ?? "Default" };

    // Pre-permission enumerateDevices yields placeholder entries with empty
    // deviceId/label — hide them rather than list unselectable rows (and
    // never let "" be persisted as a device preference). Mirrors the in-call
    // VoiceDeviceSelector.
    for (d of devs)
      if (d.deviceId && d.deviceId !== "default")
        opts[d.deviceId] = { title: d.label };
    return opts;
  });

  // Why the list may be empty — hiding the placeholder rows above used to
  // leave a bare "Default" with no explanation when access was denied
  // (support report 2026-09-03: "it doesn't even appear to select").
  const permission = createMediaPermissionState(() =>
    permissionNameFor(props.kind),
  );
  const verdict = createMemo(() =>
    deviceListVerdict({ devices: media().devices(), permission: permission() }),
  );

  return (
    <>
      <CategoryButton.Select
        icon={icon()}
        title={title()}
        value={activeId()}
        options={devOpts()}
        onUpdate={(id) => {
          const mMedia = media();
          if (
            id === "default" ||
            mMedia.devices().find((d) => d.deviceId === id)
          ) {
            //Can't setActiveMediaDevice to "default" for video, only audio
            //But it can be applied on livekit init, so this choice will be remembered
            if (props.kind !== "videoinput" || id !== "default")
              mMedia.setActiveMediaDevice(id);
            state.voice[setKey()] = id === "default" ? undefined : id;
          }
        }}
      />
      <Show when={verdict() !== "ok"}>
        <CategoryButton
          icon={
            <Symbol>
              {props.kind === "videoinput"
                ? "videocam_off"
                : verdict() === "denied"
                  ? "mic_off"
                  : "info"}
            </Symbol>
          }
          description={
            <DeviceListNotice kind={props.kind} verdict={verdict()} />
          }
        >
          <DeviceListNoticeTitle kind={props.kind} verdict={verdict()} />
        </CategoryButton>
      </Show>
    </>
  );
}

/**
 * One-line reason an empty device list is empty (settings page wording; the
 * in-call VoiceDeviceSelector carries a shorter form of the same verdicts).
 */
function DeviceListNoticeTitle(props: {
  kind: MediaDeviceKind;
  /** Never `ok` in practice — the caller renders these only when it is not. */
  verdict: DeviceListVerdict;
}) {
  return (
    <Show
      when={props.kind === "videoinput"}
      fallback={
        <Show
          when={props.verdict === "denied"}
          fallback={
            <Show
              when={props.verdict === "none"}
              fallback={<Trans>Waiting for microphone access</Trans>}
            >
              <Show
                when={props.kind === "audiooutput"}
                fallback={<Trans>No microphone found</Trans>}
              >
                <Trans>No audio output found</Trans>
              </Show>
            </Show>
          }
        >
          <Trans>Microphone access is blocked</Trans>
        </Show>
      }
    >
      <Show
        when={props.verdict === "denied"}
        fallback={
          <Show
            when={props.verdict === "none"}
            fallback={<Trans>Waiting for camera access</Trans>}
          >
            <Trans>No camera found</Trans>
          </Show>
        }
      >
        <Trans>Camera access is blocked</Trans>
      </Show>
    </Show>
  );
}

/**
 * What to do about it. Output devices have no permission of their own —
 * their labels unlock with the microphone's — so their copy says so instead
 * of asking for a permission that does not exist.
 */
function DeviceListNotice(props: {
  kind: MediaDeviceKind;
  /** Never `ok` in practice — the caller renders these only when it is not. */
  verdict: DeviceListVerdict;
}) {
  return (
    <Show
      when={props.verdict === "none"}
      fallback={
        <Show
          when={props.kind === "audiooutput"}
          fallback={
            <Show
              when={props.verdict === "denied"}
              fallback={
                <Show
                  when={props.kind === "videoinput"}
                  fallback={
                    <Trans>
                      Devices appear here once you allow the microphone.
                    </Trans>
                  }
                >
                  <Trans>Devices appear here once you allow the camera.</Trans>
                </Show>
              }
            >
              <Show
                when={props.kind === "videoinput"}
                fallback={
                  <Trans>
                    Allow the microphone in your system or browser settings,
                    then reopen this page.
                  </Trans>
                }
              >
                <Trans>
                  Allow the camera in your system or browser settings, then
                  reopen this page.
                </Trans>
              </Show>
            </Show>
          }
        >
          <Trans>
            Output devices are listed once the microphone is allowed.
          </Trans>
        </Show>
      }
    >
      <Trans>Connect a device and it will appear here.</Trans>
    </Show>
  );
}

/**
 * Select volume
 */
function VolumeSliders() {
  const state = useState();

  return (
    <Column>
      <Text class="label">
        <Trans>Output Volume</Trans>
      </Text>
      <Slider
        min={0}
        max={3}
        step={0.1}
        value={state.voice.outputVolume}
        onInput={(event) =>
          (state.voice.outputVolume = event.currentTarget.value)
        }
        labelFormatter={(label) => (label * 100).toFixed(0) + "%"}
      />
    </Column>
  );
}
