import { useLingui } from "@lingui-solid/solid/macro";
import { createResizeObserver } from "@solid-primitives/resize-observer";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import { TrackLoop } from "solid-livekit-components";
import { styled } from "styled-system/jsx";

import { InRoom, useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";
import { scrollableStyles } from "@revolt/ui/directives";

import { ParticipantTile, tile } from "./ParticipantTile";
import { VoiceCallCardActions } from "./VoiceCallCardActions";
import {
  VoiceCallCardStatus,
  VoiceCallEncryptionChip,
} from "./VoiceCallCardStatus";
import { VoiceCallDowngradeBanner } from "./VoiceCallDowngradeBanner";
import { VoiceCallRecordingBanner } from "./VoiceCallRecordingBanner";
import { VoiceCallRosterPanel } from "./VoiceCallRosterPanel";

/**
 * Call card (active)
 */
export function VoiceCallCardActiveRoom() {
  const voice = useVoice();

  return (
    <View immersive={voice.immersive()}>
      {/* The §3.4 downgrade banner + §4.4 loud chip must remain visible in
          theater/fullscreen too (FE-12) — they render OUTSIDE the chrome
          `<Show>` below, overlaid on the participant grid. In immersive mode
          the chip gets its own overlay copy (the controls-bar instance is
          hidden with the rest of the chrome).

          Both top strips live in ONE stack rather than each pinning itself to
          `top: 0`: a mixed-encryption call that is also being recorded shows
          both, and two independently-absolute strips would sit exactly on top
          of each other — hiding whichever lost. Downgrade goes first because
          it is the blocking one (audio is paused pending a decision); the
          recording notice is informational. */}
      <TopBanners>
        <VoiceCallDowngradeBanner />
        <VoiceCallRecordingBanner />
      </TopBanners>
      <VoiceCallRosterPanel />
      <Show when={voice.immersive()}>
        <ImmersiveChipOverlay>
          <VoiceCallEncryptionChip />
        </ImmersiveChipOverlay>
      </Show>
      <Participants />
      {/* Dice-roll results flashed over the video (§ /roll → in-call overlay).
          Sits above the tiles in every mode (normal / fullscreen / theater). */}
      <DiceRollOverlay />
      {/* NOTE remote control's panels and its panic handler are NOT mounted
          here. They live in `<RemoteControlOverlays>` at app level
          (`src/Interface.tsx`), because every one of them is a way to STOP a
          live session and this component unmounts the moment the user browses
          to another channel. */}
      {/* Theater mode hides every control; the only chrome is the auto-dimming
          exit button overlaid on the selected window (Escape also exits). */}
      <Show when={!voice.immersive()} fallback={<ImmersiveExit />}>
        <VoiceCallControls>
          <VoiceCallControlHolder right>
            <VoiceCallTheater />
            <VoiceCallFullscreen />
          </VoiceCallControlHolder>
          <VoiceCallCardActions size="sm" />
          <VoiceCallControlHolder left overflow>
            <VoiceCallEncryptionChip />
            <VoiceCallCardStatus />
          </VoiceCallControlHolder>
        </VoiceCallControls>
      </Show>
    </View>
  );
}

function VoiceCallFullscreen() {
  const voice = useVoice();
  return (
    <IconButton
      size="sm"
      variant={"standard"}
      onPress={() => voice.toggleFullscreen()}
    >
      <Show when={voice.fullscreen()} fallback={<Symbol>fullscreen</Symbol>}>
        <Symbol>fullscreen_exit</Symbol>
      </Show>
    </IconButton>
  );
}

/**
 * Enter theater mode: only shown in fullscreen and only when there's a live
 * camera/screen-share to maximize. Picks the currently-focused window, or
 * auto-selects one if nothing is focused yet.
 */
function VoiceCallTheater() {
  const voice = useVoice();
  const { t } = useLingui();

  const hasVideo = () =>
    voice.vidTracks().some((tr) => "publication" in tr && tr.publication);

  return (
    <Show when={voice.fullscreen() && hasVideo()}>
      <IconButton
        size="sm"
        variant={"standard"}
        onPress={() => voice.toggleImmersive()}
        use:floating={{
          tooltip: {
            placement: "top",
            content: t`Maximize & hide participants`,
          },
        }}
      >
        <Symbol>open_in_full</Symbol>
      </IconButton>
    </Show>
  );
}

/** Auto-dimming control overlaid in theater mode to bring everyone back. */
function ImmersiveExit() {
  const voice = useVoice();
  const { t } = useLingui();

  return (
    <ImmersiveControls>
      <IconButton
        size="sm"
        variant={"standard"}
        onPress={() => voice.toggleImmersive(false)}
        use:floating={{
          tooltip: {
            placement: "bottom",
            content: t`Exit theater mode`,
          },
        }}
      >
        <Symbol>close_fullscreen</Symbol>
      </IconButton>
    </ImmersiveControls>
  );
}

const TILE_MIN_WIDTH = "250px",
  TILE_MIN_FOCUS_HEIGHT = "100px",
  /** Width of the side column of other participants in the focus layout. */
  SIDEBAR_WIDTH = "min(28%, 260px)",
  /** Card width it takes to earn a side column instead of a bottom strip. */
  SIDEBAR_MIN_CARD_WIDTH = 560;

/**
 * Show a grid of participants
 */
function Participants() {
  const voice = useVoice();
  const { t } = useLingui();

  // Modify this value to get test tracks
  const testTrackCount = 0;

  let callRef: HTMLDivElement | undefined;

  const [callWidth, setCallWidth] = createSignal(0);

  /**
   * Focus layout: everyone else goes into a vertical column down the left and
   * the focused window (typically a screen share) takes all the room that
   * leaves — instead of the focused window sharing its height with a strip.
   *
   * Gated on the CARD's width rather than the viewport's: the card is narrow on
   * a phone, in the docked column and in the floating window, and a side column
   * there would leave the share a sliver. Below the threshold the strip layout
   * is kept as-is. Theater mode hides the others entirely, so it never applies.
   *
   * Never while CONTROLLING someone's screen, at any width: the controller is
   * aiming a pointer at a whole remote desktop rendered into that tile, and
   * every pixel the column takes is aim they lose. Same reasoning that blocks
   * PiP for a controller (see VoiceCallCard) — and the controller's own float
   * is 640px wide, which would otherwise clear the threshold.
   */
  const sidebar = () =>
    !!voice.focusId() &&
    !voice.immersive() &&
    !voice.remoteControl.controlling() &&
    callWidth() >= SIDEBAR_MIN_CARD_WIDTH;

  const tileWidth = () => {
    if (!voice.focusId()) return TILE_MIN_WIDTH;

    const vidWidth = Math.round(
      100 / (voice.vidTracks().length + testTrackCount),
    );
    return `max(${TILE_MIN_WIDTH}, ${vidWidth}% - var(--gap-md))`;
  };

  // Clear out any focus when the track that was focused is no longer available;
  // a vanished window also drops theater mode (nothing left to maximize).
  createEffect(() => {
    if (!voice.focusTrack()) {
      voice.toggleFocus();
      voice.toggleImmersive(false);
    }
  });

  onMount(() => {
    createResizeObserver(callRef, ({ width, height }, el) => {
      if (el === callRef) {
        el.style.setProperty("--vc-w", `${width}px`);
        el.style.setProperty("--vc-h", `${height}px`);
        setCallWidth(width);
      }
    });
  });

  return (
    <Call
      ref={callRef}
      sidebar={sidebar()}
      class={voice.focusId() ? "" : scrollableStyles()}
    >
      <InRoom>
        <FocusedParticipant sidebar={sidebar()} />
        <Show when={voice.focusId() && !voice.immersive()}>
          <ShowBarButtonHolder sidebar={sidebar()}>
            <div style={{ "margin-bottom": "10px" }}>
              <IconButton
                size="xs"
                variant={"tonal"}
                onPress={() => voice.toggleShowBar()}
                use:floating={{
                  tooltip: {
                    placement: "top",
                    content: voice.showBar() ? t`Hide Others` : t`Show Others`,
                  },
                }}
              >
                <Show
                  when={voice.showBar()}
                  fallback={
                    <Symbol>
                      {sidebar() ? "keyboard_arrow_right" : "keyboard_arrow_up"}
                    </Symbol>
                  }
                >
                  <Symbol>
                    {sidebar() ? "keyboard_arrow_left" : "keyboard_arrow_down"}
                  </Symbol>
                </Show>
              </IconButton>
            </div>
          </ShowBarButtonHolder>
        </Show>
        <Grid
          /* One layout variant at a time: the column and the strip set the same
             properties to different values, and a recipe merges its variants in
             declaration order — so letting both match would make the layout a
             function of which one is written first in the file. */
          focus={!!voice.focusId() && !sidebar()}
          sidebar={sidebar()}
          show={voice.showBar()}
          class={
            sidebar()
              ? scrollableStyles({ direction: "y" })
              : voice.focusId()
                ? scrollableStyles({ direction: "x" })
                : ""
          }
          style={{ "--vc-tile-width": tileWidth() }}
        >
          <TrackLoop
            tracks={() => voice.vidTracks().filter((t) => !voice.isFocus(t))}
          >
            {() => <ParticipantTile />}
          </TrackLoop>
          <For each={Array(testTrackCount)}>
            {() => (
              <div
                class={tile({ fullscreen: voice.fullscreen() }) + " vc_tile"}
              />
            )}
          </For>
        </Grid>
      </InRoom>
    </Call>
  );
}

function FocusedParticipant(props: { sidebar: boolean }) {
  const voice = useVoice();

  const [focusEl, setFocusEl] = createSignal<HTMLDivElement>();
  const [focusSize, setFocusSize] = createSignal({ width: 0, height: 0 });

  createResizeObserver(focusEl, ({ width, height }) =>
    setFocusSize({ width, height }),
  );

  /**
   * Shadow the card-level `--vc-w`/`--vc-h` with the focus area's OWN size, so
   * the focused tile's aspect maths (ParticipantTile's `getHeight`) describes
   * the box it actually sits in. Without it the side column's width still
   * counts as available and the tile comes out taller than its video, which
   * letterboxes the picture inside the tile's own background.
   *
   * ONLY in the side-column layout, where flex gives this box a width of its
   * own (`flexBasis: 0` + `flexGrow`). In the strip layout the box hugs its
   * tile instead (auto margins, no definite width), so its width is partly a
   * function of the tile — feeding that back in as the tile's height input
   * would be circular. There the card-level values are already right.
   */
  createEffect(() => {
    const el = focusEl();
    if (!el) return;

    const { width, height } = focusSize();
    if (props.sidebar && width && height) {
      el.style.setProperty("--vc-w", `${width}px`);
      el.style.setProperty("--vc-h", `${height}px`);
    } else {
      el.style.removeProperty("--vc-w");
      el.style.removeProperty("--vc-h");
    }
  });

  return (
    <Show when={voice.focusTrack()}>
      <TrackLoop tracks={() => [voice.focusTrack()!]}>
        {() => (
          <FocusBox ref={setFocusEl} sidebar={props.sidebar}>
            <ParticipantTile focus />
          </FocusBox>
        )}
      </TrackLoop>
    </Show>
  );
}

/**
 * Transient dice-roll results overlaid on the call video. Reads the Voice
 * store's `diceRolls()` (populated when a server /roll lands in the channel
 * this call is in); each toast auto-removes after DICE_TOAST_MS. Purely
 * informational — `pointer-events: none`, so it never blocks the tiles.
 */
function DiceRollOverlay() {
  const voice = useVoice();

  return (
    <DiceOverlayHolder aria-live="polite">
      <For each={voice.diceRolls()}>
        {(roll) => (
          <DiceToast data-natural={roll.natural}>
            <Symbol size={20}>casino</Symbol>
            <DiceToastBody>
              <DiceToastHeadline>
                <DiceToastName>{roll.username}</DiceToastName> rolled a{" "}
                <DiceToastTotal data-natural={roll.natural}>
                  {roll.total}
                </DiceToastTotal>
              </DiceToastHeadline>
              <DiceToastMeta>
                {roll.notation}
                <Show when={roll.natural}>
                  {" · "}
                  {roll.natural === "crit" ? "Natural 20! 🎉" : "Natural 1"}
                </Show>
              </DiceToastMeta>
            </DiceToastBody>
          </DiceToast>
        )}
      </For>
    </DiceOverlayHolder>
  );
}

const View = styled("div", {
  base: {
    position: "relative",
    minHeight: 0,
    height: "100%",
    width: "100%",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
  },
  variants: {
    // Theater mode: drop the padding/gap so the selected window fills the frame.
    immersive: {
      true: {
        gap: 0,
        padding: 0,
      },
    },
  },
});

/**
 * Holder for the theater-mode exit button, pinned top-right over the maximized
 * window. Kept subtle so it doesn't distract, brightening to full on hover.
 */
const ImmersiveControls = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    right: "var(--gap-md)",
    zIndex: 4,

    opacity: 0.4,
    transition: "opacity .2s ease",
    _hover: {
      opacity: 1,
    },
  },
});

const VoiceCallControls = styled("div", {
  base: {
    display: "flex",
    flexShrink: "0",
    overflow: "hidden",
    flexDirection: "row-reverse",
  },
});

const VoiceCallControlHolder = styled("div", {
  base: {
    display: "flex",
    flex: "1",
    alignSelf: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
  },
  variants: {
    right: {
      true: {
        justifyContent: "flex-end",
      },
    },
    empty: {
      true: {
        gap: "0px",
        padding: "0px",
      },
    },
    left: {
      true: {
        justifyContent: "flex-start",
      },
    },
    overflow: {
      true: {
        overflow: "hidden",
      },
    },
  },
});

const ShowBarButtonHolder = styled("div", {
  base: {
    height: "0px",
    alignSelf: "center",
    overflow: "visible",
    display: "flex",
    flexDirection: "column-reverse",
  },
  variants: {
    /**
     * In the side-column layout the toggle comes out of the flow (it would
     * otherwise sit between the column and the video as a zero-height item)
     * and pins to the bottom-left corner, so it stays in the same place
     * whether the column is showing or collapsed.
     */
    sidebar: {
      true: {
        position: "absolute",
        left: "var(--gap-md)",
        bottom: "var(--gap-md)",
        zIndex: 3,
        height: "auto",
        alignSelf: "auto",
      },
    },
  },
});

const Call = styled("div", {
  base: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    flexGrow: 1,
    minHeight: 0,
  },
  variants: {
    // Others down the left, focused window filling what's left of the row.
    sidebar: {
      true: {
        flexDirection: "row",
        alignItems: "stretch",
        gap: "var(--gap-md)",
      },
    },
  },
});

const Grid = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexWrap: "nowrap",
    justifyContent: "flex-start",
    alignItems: "flex-start",
    alignSelf: "flex-start",
    minHeight: "auto",
    width: "fit-content",
    gap: "var(--gap-md)",
  },

  variants: {
    focus: {
      true: {
        flexDirection: "column",
        flexWrap: "nowrap",
        alignSelf: "stretch",
        width: "auto",
        height: `max(20%, ${TILE_MIN_FOCUS_HEIGHT})`,
        minHeight: 0,
        transition: "height .3s ease",

        "& .vc_tile": {
          width: "auto",
          height: "100%",
        },
      },
    },
    /**
     * The focus layout's side column: a scrolling vertical stack of everyone
     * else, pulled ahead of the focused window with `order` so it lands on the
     * left while the DOM keeps the focused track first.
     */
    sidebar: {
      true: {
        flexDirection: "column",
        flexWrap: "nowrap",
        order: -1,
        alignSelf: "stretch",
        alignItems: "stretch",
        width: SIDEBAR_WIDTH,
        flexShrink: 0,
        height: "100%",
        minHeight: 0,
        transition: "width .3s ease",

        "& .vc_tile": {
          width: "100%",
          height: "auto",
          maxWidth: "none",
          // Tiles keep their 16:9 box and the column scrolls; without this
          // they would squash to share the card's height between them.
          flexShrink: 0,
        },
      },
    },
    // Hiding is per-layout (collapse the strip's height, the column's width),
    // so the styles live in the compound variants below.
    show: {
      false: {},
    },
  },
  /**
   * Hiding collapses whichever axis the active layout owns — so it depends on
   * both variants, which is why it lives here rather than in `show`. Clipping
   * the tiles is left to the scrollable class the JSX already applies (the
   * strip hides overflow-y, the column overflow-x).
   */
  compoundVariants: [
    {
      sidebar: [false],
      show: [false],
      css: {
        height: 0,
      },
    },
    {
      sidebar: [true],
      show: [false],
      css: {
        width: 0,
      },
    },
  ],
});

const FocusBox = styled("div", {
  base: {
    height: 0,
    flexGrow: 1,
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    margin: "0 auto",
  },
  variants: {
    /**
     * In a row, `height: 0` would collapse the focus area — it grows along the
     * main axis now, so the height comes back and the auto margins go.
     * `flexBasis: 0` + `minWidth: 0` make the width purely flex-driven (exactly
     * the space the column leaves) rather than content-driven, which is what
     * lets it be measured and fed back as the tile's aspect input.
     */
    sidebar: {
      true: {
        height: "100%",
        flexBasis: 0,
        minWidth: 0,
        margin: 0,
      },
    },
  },
});

/**
 * The top-of-call strip stack: whole-call notices that must be seen in every
 * mode, in priority order, never overlapping each other.
 *
 * `pointerEvents: none` on the container with `auto` restored on its children
 * so the empty gap either side of a small chip does not swallow clicks meant
 * for the participant tiles underneath.
 */
const TopBanners = styled("div", {
  base: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 5,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    pointerEvents: "none",
    "& > *": {
      pointerEvents: "auto",
    },
  },
});

/**
 * Positions the encryption chip's immersive-mode copy (FE-12): theater mode
 * hides all chrome, but an amber/loud encryption state must stay visible.
 */
const ImmersiveChipOverlay = styled("div", {
  base: {
    position: "absolute",
    left: "var(--gap-md)",
    top: "var(--gap-md)",
    zIndex: 5,
  },
});

/** Top-centred stack that holds the transient dice-roll toasts. */
const DiceOverlayHolder = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-md)",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 6,

    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "var(--gap-sm)",

    // Informational only — never intercept clicks meant for the tiles/controls.
    pointerEvents: "none",
    maxWidth: "90%",
  },
});

/**
 * A single dice-roll toast. Snackbar-style (inverse surface) so it stays legible
 * over any camera/screen-share frame. `diceRollToast` runs the whole show — fade
 * in, hold ~3s, fade out — matched to DICE_TOAST_MS in rtc/state.tsx.
 */
const DiceToast = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    padding: "8px 14px",
    borderRadius: "14px",

    background: "var(--md-sys-color-inverse-surface)",
    color: "var(--md-sys-color-inverse-on-surface)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",
    border: "1px solid transparent",

    // Full-lifecycle animation (enter → hold → exit); `both` keeps the final
    // (faded-out) frame until the node is unmounted.
    animation: "diceRollToast 3400ms ease both",

    "&[data-natural='crit']": {
      borderColor: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      borderColor: "var(--md-sys-color-error)",
    },
  },
});

const DiceToastBody = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    lineHeight: 1.25,
  },
});

const DiceToastHeadline = styled("div", {
  base: {
    fontSize: "0.95rem",
  },
});

const DiceToastName = styled("span", {
  base: {
    fontWeight: "700",
  },
});

const DiceToastTotal = styled("span", {
  base: {
    fontWeight: "800",
    fontSize: "1.05rem",
    "&[data-natural='crit']": {
      color: "#3BA55D",
    },
    "&[data-natural='fumble']": {
      color: "var(--md-sys-color-error)",
    },
  },
});

const DiceToastMeta = styled("div", {
  base: {
    fontSize: "0.7rem",
    opacity: 0.7,
    fontFamily: "monospace",
  },
});
