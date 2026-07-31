import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";

import {
  overlaySessionType,
  overlayShellAvailable,
} from "@revolt/rtc/overlay/shell";
import { useState } from "@revolt/state";
import { CategoryButton, Checkbox, Column, Slider, Text } from "@revolt/ui";

/**
 * In-game voice overlay options (desktop shells only).
 *
 * Lives with Voice rather than on the Electron-only `Native` page: this is a
 * voice feature, and `Native` is gated on `!!window.native`, which does not
 * exist on the Tauri shell at all.
 *
 * Unlike the overlay WINDOW's own components, this one runs in the main
 * window with the full provider stack, so lingui macros are correct here.
 */
export function OverlaySettings() {
  const { voice } = useState();

  return (
    <Show when={overlayShellAvailable()}>
      <Text class="title">
        <Trans>In-game overlay</Trans>
      </Text>
      <CategoryButton.Group>
        <CategoryButton
          icon="blank"
          // The Checkbox in the `action` slot is DISPLAY-ONLY — it does not
          // receive the click. The toggle belongs on the row (fix 6ffc305c).
          action={<Checkbox checked={voice.overlayEnabled} />}
          onClick={() => (voice.overlayEnabled = !voice.overlayEnabled)}
          description={
            <Trans>
              Show who is talking on top of your game during a call. Works in
              borderless-windowed games; exclusive fullscreen cannot be drawn
              over.
            </Trans>
          }
        >
          <Trans>Show overlay during calls</Trans>
        </CategoryButton>
      </CategoryButton.Group>

      <Show when={voice.overlayEnabled}>
        <Show when={overlaySessionType() === "wayland"}>
          <Text class="label">
            <Trans>
              Wayland session detected — the overlay may not stay above games on
              this desktop. X11 sessions are fully supported.
            </Trans>
          </Text>
        </Show>

        <CategoryButton.Group>
          <CategoryButton.Select
            icon="blank"
            title={<Trans>What the overlay shows</Trans>}
            options={{
              avatars: { title: <Trans>Avatars only</Trans> },
              "avatars-names": { title: <Trans>Avatars and names</Trans> },
              names: { title: <Trans>Names only</Trans> },
            }}
            value={voice.overlayDisplayMode}
            onUpdate={(mode) => (voice.overlayDisplayMode = mode)}
          />
          <CategoryButton.Select
            icon="blank"
            title={<Trans>Screen corner</Trans>}
            options={{
              "top-left": { title: <Trans>Top left</Trans> },
              "top-right": { title: <Trans>Top right</Trans> },
              "bottom-left": { title: <Trans>Bottom left</Trans> },
              "bottom-right": { title: <Trans>Bottom right</Trans> },
            }}
            value={voice.overlayCorner}
            onUpdate={(corner) => (voice.overlayCorner = corner)}
          />
          <CategoryButton
            icon="blank"
            action={<Checkbox checked={voice.overlayShowLatency} />}
            onClick={() =>
              (voice.overlayShowLatency = !voice.overlayShowLatency)
            }
            description={
              <Trans>
                Round-trip time for your own microphone stream. Shows a dash
                while your mic is not transmitting.
              </Trans>
            }
          >
            <Trans>Show latency</Trans>
          </CategoryButton>
        </CategoryButton.Group>

        <CategoryButton.Group>
          <CategoryButton
            icon="blank"
            description={
              <Column gap="sm">
                <Text class="label">
                  <Trans>
                    Opacity: {Math.round(voice.overlayOpacity * 100)}%
                  </Trans>
                </Text>
                <Slider
                  min={20}
                  max={100}
                  step={5}
                  value={Math.round(voice.overlayOpacity * 100)}
                  onInput={(e) =>
                    (voice.overlayOpacity = Number(e.currentTarget.value) / 100)
                  }
                  labelFormatter={(v) => `${v}%`}
                />
              </Column>
            }
          >
            <Trans>Overlay opacity</Trans>
          </CategoryButton>
          <CategoryButton
            icon="blank"
            description={
              <Column gap="sm">
                <Text class="label">
                  <Trans>Size: {Math.round(voice.overlayScale * 100)}%</Trans>
                </Text>
                <Slider
                  min={60}
                  max={200}
                  step={10}
                  value={Math.round(voice.overlayScale * 100)}
                  onInput={(e) =>
                    (voice.overlayScale = Number(e.currentTarget.value) / 100)
                  }
                  labelFormatter={(v) => `${v}%`}
                />
              </Column>
            }
          >
            <Trans>Overlay size</Trans>
          </CategoryButton>
        </CategoryButton.Group>
      </Show>
    </Show>
  );
}
