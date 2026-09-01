import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { css } from "styled-system/css";

import {
  VAD_AUDIO_CONSTRAINTS,
  VAD_FFT_SIZE,
  createNoiseFloorTracker,
  levelFromFrequencyData,
} from "@revolt/rtc/vadLevel";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Text } from "@revolt/ui";

/**
 * Input sensitivity for voice-activity mode: an "automatically adjust"
 * switch and a LIVE meter of the microphone, coloured against the threshold
 * that is actually in force — red below it (nothing would be transmitted),
 * yellow up to it, green past it. In manual mode the threshold is a slider
 * knob drawn over the same bar, so moving it visibly changes where red
 * ends. In automatic mode the marker follows the tracked noise floor.
 *
 * The meter opens the microphone while this section is on screen (the
 * preferred input device, falling back to the default) and closes it on
 * unmount. Level and threshold use the SAME arithmetic as the call's VAD
 * gate (`@revolt/rtc/vadLevel`), so the picture here is the gate's picture.
 */
export function InputSensitivity() {
  const { voice } = useState();
  const [level, setLevel] = createSignal(0);
  const [autoThreshold, setAutoThreshold] = createSignal(0);
  const [denied, setDenied] = createSignal(false);

  let frame: number | undefined;
  let stream: MediaStream | undefined;
  let ctx: AudioContext | undefined;
  let stopped = false;

  async function start() {
    try {
      const preferred = voice.preferredAudioInputDevice;
      stream = await navigator.mediaDevices
        .getUserMedia({
          audio: preferred
            ? { ...VAD_AUDIO_CONSTRAINTS, deviceId: { exact: preferred } }
            : VAD_AUDIO_CONSTRAINTS,
          video: false,
        })
        .catch((error) => {
          if (!preferred) throw error;
          return navigator.mediaDevices.getUserMedia({
            audio: VAD_AUDIO_CONSTRAINTS,
            video: false,
          });
        });
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = VAD_FFT_SIZE;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.frequencyBinCount);
      const auto = createNoiseFloorTracker();
      const tick = () => {
        analyser.getByteFrequencyData(buf);
        const l = levelFromFrequencyData(buf);
        setLevel(l);
        setAutoThreshold(auto.update(l));
        frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      setDenied(true);
    }
  }

  function stop() {
    stopped = true;
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    stream?.getTracks().forEach((t) => t.stop());
    stream = undefined;
    void ctx?.close();
    ctx = undefined;
  }

  onMount(() => void start());
  onCleanup(stop);

  const threshold = () =>
    voice.vadAuto ? autoThreshold() : voice.vadThreshold;
  const open = () => level() > threshold();

  return (
    <>
      <CategoryButton
        icon="blank"
        action={<Checkbox checked={voice.vadAuto} />}
        onClick={() => (voice.vadAuto = !voice.vadAuto)}
        description={
          <Trans>
            Sloga follows the background noise in your room and opens the
            microphone when you speak over it. Turn off to set the level by
            hand.
          </Trans>
        }
      >
        <Trans>Automatically adjust input sensitivity</Trans>
      </CategoryButton>
      <CategoryButton
        icon="blank"
        description={
          <Column gap="sm">
            <Show
              when={!denied()}
              fallback={
                <Text class="label">
                  <Trans>
                    Microphone access was denied, so the meter cannot run.
                  </Trans>
                </Text>
              }
            >
              <Meter
                level={level()}
                threshold={threshold()}
                open={open()}
                editable={!voice.vadAuto}
                onThreshold={(value) => (voice.vadThreshold = value)}
              />
              <Text class="label">
                <Show
                  when={voice.vadAuto}
                  fallback={
                    <Trans>
                      Red is below the threshold and is not sent; drag the
                      handle so your voice lands in the green and room noise
                      stays in the red. Threshold: {voice.vadThreshold}%
                    </Trans>
                  }
                >
                  <Trans>
                    Red is below the level Sloga picked for your room and is not
                    sent; speak normally and your voice should land in the
                    green.
                  </Trans>
                </Show>
              </Text>
            </Show>
          </Column>
        }
      >
        <Trans>Input Sensitivity</Trans>
      </CategoryButton>
    </>
  );
}

/**
 * The bar. Fill = live level; colour = where that level sits against the
 * threshold. A transparent range input sits over the bar in manual mode so
 * the knob IS the threshold marker.
 */
function Meter(props: {
  level: number;
  threshold: number;
  open: boolean;
  editable: boolean;
  onThreshold: (value: number) => void;
}) {
  // Same green the input-level test uses; the theme has no reliable success
  // token (see feedback on --customColours-success).
  const fillColour = () => (props.open ? "#4caf50" : "#f44336");

  return (
    <div class={track}>
      {/* Yellow band from the threshold to the current level once the gate is
          open: "just over" reads as marginal, well over reads as green. */}
      <div
        class={fill}
        style={{
          width: `${Math.min(100, props.level)}%`,
          background: fillColour(),
        }}
      />
      <Show when={props.open}>
        <div
          class={fill}
          style={{
            left: `${props.threshold}%`,
            width: `${Math.max(0, Math.min(8, props.level - props.threshold))}%`,
            background: "#ffb300",
          }}
        />
      </Show>
      <div class={marker} style={{ left: `${props.threshold}%` }} />
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={props.threshold}
        disabled={!props.editable}
        aria-label="Input sensitivity threshold"
        class={range}
        onInput={(e) => props.onThreshold(Number(e.currentTarget.value))}
      />
    </div>
  );
}

const track = css({
  position: "relative",
  height: "14px",
  width: "100%",
  borderRadius: "var(--borderRadius-full)",
  background: "var(--md-sys-color-surface-container-highest)",
  overflow: "visible",
});

const fill = css({
  position: "absolute",
  top: 0,
  left: 0,
  height: "100%",
  borderRadius: "var(--borderRadius-full)",
  transition: "width 0.05s linear",
  pointerEvents: "none",
});

const marker = css({
  position: "absolute",
  top: "-3px",
  height: "20px",
  width: "2px",
  transform: "translateX(-1px)",
  background: "var(--md-sys-color-on-surface)",
  pointerEvents: "none",
});

const range = css({
  position: "absolute",
  inset: 0,
  width: "100%",
  height: "100%",
  margin: 0,
  appearance: "none",
  background: "transparent",
  cursor: "pointer",
  _disabled: { cursor: "default", opacity: 1 },
  "&::-webkit-slider-runnable-track": { background: "transparent" },
  "&::-moz-range-track": { background: "transparent" },
  "&::-webkit-slider-thumb": {
    appearance: "none",
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "var(--md-sys-color-primary)",
    border: "2px solid var(--md-sys-color-surface)",
    marginTop: "-2px",
  },
  "&::-moz-range-thumb": {
    width: "18px",
    height: "18px",
    borderRadius: "50%",
    background: "var(--md-sys-color-primary)",
    border: "2px solid var(--md-sys-color-surface)",
  },
  "&:disabled::-webkit-slider-thumb": { opacity: 0 },
  "&:disabled::-moz-range-thumb": { opacity: 0 },
});
