import { useNavigate } from "@solidjs/router";
import { Show, createSignal, onCleanup, onMount } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { useState } from "@revolt/state";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { VoiceCaptionsButton } from "./VoiceCaptionsButton";
import { VoiceDeviceSelector } from "./VoiceDeviceSelector";
import { VoiceGiveControlButton } from "./VoiceGiveControlButton";
import { VoiceRecordButton } from "./VoiceRecordButton";
import { VoiceSoundboardButton } from "./VoiceSoundboardButton";
import { VoiceStatsOverlay } from "./VoiceStatsOverlay";
import { VoiceTranscribeButton } from "./VoiceTranscribeButton";
import { VoiceWatchButton } from "./VoiceWatchButton";

/** Extra width required before an overflowed bar unfolds, so the boundary
 *  doesn't flip back and forth while the window is being dragged. */
const EXPAND_SLACK = 8;

export function VoiceCallCardActions(props: { size: "xs" | "sm" }) {
  const voice = useVoice();
  const state = useState();
  const navigate = useNavigate();
  const { t } = useLingui();

  const enableVideo = CONFIGURATION.ENABLE_VIDEO;

  // The floating PiP card is a fixed 300px wide — only the essential controls
  // fit there. Secondary controls stay available on the full docked card.
  const compact = () => props.size === "xs";

  // Screen sharing goes through getDisplayMedia on web/desktop. Android WebView
  // has no getDisplayMedia (needs a native MediaProjection plugin), so gate the
  // button on the capability actually being present instead of throwing.
  const screenShareSupported =
    typeof navigator !== "undefined" &&
    typeof navigator.mediaDevices?.getDisplayMedia === "function";

  // When the docked card is too narrow for every control, the secondary set
  // folds into an overflow menu so the essentials (mic / deafen / camera /
  // share / hang up) always stay on one visible row. The secondary controls
  // can't be counted from here — several gate themselves on flags, permissions
  // and live call state — so fitting is decided by measurement instead:
  // whenever the rendered set is on one row its width is the fold threshold,
  // and the bar wrapping is the signal that it no longer fits.
  const [collapsed, setCollapsed] = createSignal(false);
  const [overflowOpen, setOverflowOpen] = createSignal(false);
  let actionsEl: HTMLDivElement | undefined;
  let overflowEl: HTMLDivElement | undefined;
  let fullSetWidth = 0;

  function evaluateFit() {
    const el = actionsEl;
    const parent = el?.parentElement;
    if (!el || !parent) return;
    // The whole controls row is the width to fit into: the side holders have
    // flex-basis 0 / min-width 0, so they yield before the bar has to wrap.
    const available = parent.clientWidth;

    if (collapsed()) {
      if (fullSetWidth && available >= fullSetWidth + EXPAND_SLACK) {
        // Optimistic unfold: if the control set grew while folded, the next
        // observer pass sees the wrap and folds again with a raised threshold.
        setOverflowOpen(false);
        setCollapsed(false);
      }
      return;
    }

    const children = Array.from(el.children) as HTMLElement[];
    const wrapped =
      children.length > 1 &&
      children.some((c) => c.offsetTop !== children[0].offsetTop);
    if (!wrapped) {
      // Single row: this is the true full-set width, remember it as the
      // unfold threshold.
      fullSetWidth = el.offsetWidth;
      return;
    }
    // Wrapped before a single-row width was ever observed (mounted into an
    // already-narrow window): all that's known is "wider than what's here".
    fullSetWidth = Math.max(fullSetWidth, available + 1);
    setCollapsed(true);
  }

  onMount(() => {
    // The PiP card never collapses — it already renders only the essentials.
    if (compact() || !actionsEl?.parentElement) return;
    createResizeObserver(
      () => [actionsEl!, actionsEl!.parentElement!],
      evaluateFit,
    );
  });

  function onPointerDown(event: PointerEvent) {
    if (overflowEl && !overflowEl.contains(event.target as Node)) {
      setOverflowOpen(false);
      document.removeEventListener("pointerdown", onPointerDown);
    }
  }

  function toggleOverflow() {
    if (overflowOpen()) {
      setOverflowOpen(false);
      document.removeEventListener("pointerdown", onPointerDown);
    } else {
      setOverflowOpen(true);
      document.addEventListener("pointerdown", onPointerDown);
    }
  }

  onCleanup(() => document.removeEventListener("pointerdown", onPointerDown));

  return (
    <Actions ref={actionsEl}>
      <Show when={props.size === "xs"}>
        <IconButton
          variant="standard"
          size={props.size}
          onPress={() => {
            navigate(voice.channel()?.path ?? "");
            state.appDrawer()?.setShown(true);
          }}
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Return to voice channel`,
            },
          }}
        >
          <Symbol>arrow_top_left</Symbol>
        </IconButton>
      </Show>
      <IconButton
        size={props.size}
        variant={voice.microphone() ? "filled" : "tonal"}
        onPress={() => voice.toggleMute()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: voice.speakingPermission
              ? voice.microphone()
                ? t`Mute`
                : t`Unmute`
              : t`Missing permission`,
          },
        }}
        isDisabled={!voice.speakingPermission}
      >
        <Show when={voice.microphone()} fallback={<Symbol>mic_off</Symbol>}>
          <Symbol>mic</Symbol>
        </Show>
      </IconButton>
      <IconButton
        size={props.size}
        variant={voice.deafen() || !voice.listenPermission ? "tonal" : "filled"}
        onPress={() => voice.toggleDeafen()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: voice.listenPermission
              ? voice.deafen()
                ? t`Undeafen`
                : t`Deafen`
              : t`Missing permission`,
          },
        }}
        isDisabled={!voice.listenPermission}
      >
        <Show
          when={voice.deafen() || !voice.listenPermission}
          fallback={<Symbol>headset</Symbol>}
        >
          <Symbol>headset_off</Symbol>
        </Show>
      </IconButton>
      <IconButton
        size={props.size}
        variant={enableVideo && voice.video() ? "filled" : "tonal"}
        onPress={() => {
          if (enableVideo) voice.toggleCamera();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: enableVideo
              ? voice.video()
                ? t`Stop camera`
                : t`Start camera`
              : t`Coming soon! 👀`,
          },
        }}
        isDisabled={!enableVideo}
      >
        <Symbol>camera_video</Symbol>
      </IconButton>
      <Show when={!compact() && !collapsed()}>
        <CameraSettingsButton size={props.size} />
      </Show>
      <IconButton
        size={props.size}
        variant={
          enableVideo && screenShareSupported && voice.screenshare()
            ? "filled"
            : "tonal"
        }
        onPress={() => {
          if (enableVideo && screenShareSupported) voice.toggleScreenshare();
        }}
        use:floating={{
          tooltip: {
            placement: "top",
            content: !enableVideo
              ? t`Coming soon! 👀`
              : !screenShareSupported
                ? t`Screen sharing isn't supported on this device`
                : voice.screenshare()
                  ? t`Stop sharing`
                  : t`Share screen`,
          },
        }}
        isDisabled={!enableVideo || !screenShareSupported}
      >
        <Show
          when={!enableVideo || !screenShareSupported || voice.screenshare()}
          fallback={<Symbol>screen_share</Symbol>}
        >
          <Symbol>stop_screen_share</Symbol>
        </Show>
      </IconButton>
      <Show when={!compact() && !collapsed()}>
        <SecondaryControls size={props.size} />
      </Show>
      {/* The active states hidden by folding all keep a visible surface of
          their own on the docked card (recording banner, captions display,
          transcript panel), so the trigger itself carries no state badge. */}
      <Show when={!compact() && collapsed()}>
        <OverflowAnchor ref={overflowEl}>
          <Show when={overflowOpen()}>
            <OverflowPanel>
              <CameraSettingsButton size={props.size} />
              <SecondaryControls size={props.size} />
            </OverflowPanel>
          </Show>
          <IconButton
            size={props.size}
            variant={overflowOpen() ? "filled" : "tonal"}
            onPress={toggleOverflow}
            use:floating={{
              tooltip: {
                placement: "top",
                content: t`More call controls`,
              },
            }}
          >
            <Symbol>more_horiz</Symbol>
          </IconButton>
        </OverflowAnchor>
      </Show>
      <Button
        size={props.size}
        variant="_error"
        onPress={() => voice.disconnect()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`End call`,
          },
        }}
      >
        <Symbol>call_end</Symbol>
      </Button>
    </Actions>
  );
}

/**
 * Opens the camera settings modal. Sits beside the camera toggle when the bar
 * has room, and folds into the overflow menu with the other secondary
 * controls when it doesn't.
 */
function CameraSettingsButton(props: { size: "xs" | "sm" }) {
  const modals = useModals();
  const { t } = useLingui();

  return (
    <Show when={CONFIGURATION.ENABLE_VIDEO}>
      <IconButton
        size={props.size}
        variant="tonal"
        onPress={() => modals.openModal({ type: "camera_settings" })}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Camera settings`,
          },
        }}
      >
        <Symbol>tune</Symbol>
      </IconButton>
    </Show>
  );
}

/**
 * The secondary controls of the docked call card — everything beyond
 * mic / deafen / camera / share / hang up. Rendered inline while the bar has
 * room, and inside the overflow panel when it has folded. Never on the
 * compact PiP card: the 300px card only fits the essentials, and controls
 * whose side effect is telling everyone in the call something (recording,
 * transcription, captions) are poor candidates for a cramped row where they
 * could be hit by accident — the docked card stays reachable for those.
 */
function SecondaryControls(props: { size: "xs" | "sm" }) {
  const voice = useVoice();

  return (
    <>
      {/* "Give control" sits on the sharer's own share, Teams-style, so it
          renders right beside the share button it acts on (adjacency is lost
          in the overflow panel, where the label carries the meaning). The
          component gates itself on `CONFIGURATION.ENABLE_VIDEO`, a native
          command probe, and an actually-live screenshare, so it simply is not
          there on a shell that cannot do it. */}
      <VoiceGiveControlButton size={props.size} />
      <Show
        when={
          voice.channel()?.serverId &&
          voice.channel()?.havePermission("UseSoundboard")
        }
      >
        <VoiceSoundboardButton size={props.size} />
      </Show>
      {/* Watch together: gates itself on the ENABLE_WATCH_TOGETHER flag +
          the UseWatchTogether bit via watchPolicy. */}
      <VoiceWatchButton size={props.size} />
      <VoiceRecordButton size={props.size} />
      <VoiceTranscribeButton size={props.size} />
      <VoiceCaptionsButton size={props.size} />
      <VoiceDeviceSelector size={props.size} />
      <VoiceStatsOverlay size={props.size} />
    </>
  );
}

const Actions = styled("div", {
  base: {
    // Shrinkable on purpose: `maxWidth: 100%` alone only caps the bar at the
    // full controls-row width, so with non-empty side holders there was a
    // band of window widths where the row overflowed (and clipped) before
    // the bar ever hit its cap. Letting the bar shrink converts that
    // pressure into wrapping instead — the side holders have flex-basis 0,
    // so the shrink lands entirely here.
    flexShrink: 1,
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    zIndex: 2,

    display: "flex",
    width: "fit-content",
    // Never spill past the card (and off-screen) — wrap onto another row when
    // the available width can't fit every control.
    maxWidth: "100%",
    flexWrap: "wrap",
    justifyContent: "center",
    alignSelf: "center",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container)",
  },
});

// NOTE: intentionally NOT position:relative — same containing-block trick as
// VoiceDeviceSelector. The bar lives inside `VoiceCallControls` which has
// `overflow: hidden`; leaving this static lets the absolute panel resolve its
// containing block to the call Card above the clipping box. The wrapper still
// groups button + panel for click-outside detection.
const OverflowAnchor = styled("div", {
  base: {
    display: "flex",
  },
});

const OverflowPanel = styled("div", {
  base: {
    position: "absolute",
    // Fixed offset (not `100%`) because the containing block is the call
    // Card, not this wrapper — sit just above the controls bar.
    bottom: "64px",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 10,

    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    maxWidth: "90%",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container-highest)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});
