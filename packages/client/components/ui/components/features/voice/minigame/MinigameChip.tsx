import { useLingui } from "@lingui-solid/solid/macro";
import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";

import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  minigameChipVisible,
  minigameInterruptedByJoin,
} from "./minigamePolicy.ts";
import type { SlogaballHandle } from "./slogaballGame.ts";

/**
 * Slogaball, "play while you wait" (slice 1): a chip offered while sitting
 * ALONE in a call, opening a single-player game over the empty tile area.
 * Someone joining auto-pauses and collapses it — the WoW-Peggle rule: the
 * game exists to absorb the wait, never to compete with the call.
 *
 * Mounted inside the participant area's relative container (the `<Call>` div
 * in VoiceCallCardActiveRoom) rather than over the whole card, so the
 * controls bar below stays visible and clickable mid-game — muting yourself
 * must not require quitting a game. The card's absolutely-positioned notices
 * (TopBanners z5, dice toasts z6) stay above the overlay's z4: the E2EE
 * downgrade banner is blocking and always wins.
 *
 * The game engine is a separate lazy chunk (`await import`, the
 * transcriptionEngine precedent) — the main bundle carries only this file.
 */

/**
 * The parked game survives the overlay unmounting (join-collapse, browsing to
 * another channel) so coming back resumes the same field mid-run. It dies
 * with the call: the effect below disposes it when the voice state leaves
 * CONNECTED, and adopting it under a DIFFERENT channel disposes it first —
 * a leftover from a previous call must not resurrect in the next one.
 */
let parked: {
  channelId: string;
  canvas: HTMLCanvasElement;
  game: SlogaballHandle;
} | null = null;

function disposeParked() {
  parked?.game.dispose();
  parked = null;
}

export function MinigameChip() {
  const voice = useVoice();
  const { t } = useLingui();
  const [open, setOpen] = createSignal(false);

  const participants = () => voice.channel()?.voiceParticipants.size ?? 0;

  const visible = () =>
    minigameChipVisible({
      enabled: CONFIGURATION.ENABLE_CALL_MINIGAME,
      connected: voice.state() === "CONNECTED",
      participants: participants(),
      immersive: voice.immersive(),
      focused: !!voice.focusId(),
    });

  // Park on join: pause + collapse, keeping the run for when they leave again.
  createEffect(() => {
    if (open() && minigameInterruptedByJoin(participants())) {
      parked?.game.pause();
      setOpen(false);
    }
  });

  // The game dies with the call.
  createEffect(() => {
    if (voice.state() !== "CONNECTED") {
      disposeParked();
      setOpen(false);
    }
  });

  return (
    <>
      <Show when={visible() && !open()}>
        <ChipHolder>
          <ChipPill type="button" onClick={() => setOpen(true)}>
            <Symbol size={18}>sports_esports</Symbol>
            {t`Play while you wait?`}
          </ChipPill>
        </ChipHolder>
      </Show>
      <Show when={open() && visible()}>
        <MinigameOverlay onClose={() => setOpen(false)} />
      </Show>
    </>
  );
}

function MinigameOverlay(props: { onClose: () => void }) {
  const voice = useVoice();
  const { t } = useLingui();

  let host: HTMLDivElement | undefined;
  let unmounted = false;

  // Mirrors the engine's per-device mute preference; synced once the (maybe
  // still downloading) game chunk is up, since the engine owns persistence.
  const [muted, setMuted] = createSignal(false);

  onMount(async () => {
    const channelId = voice.channel()?.id ?? "";
    if (parked && parked.channelId !== channelId) disposeParked();

    if (!parked) {
      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      // Aiming is pointermove — without this a touch drag scrolls instead.
      canvas.style.touchAction = "none";
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", t`Slogaball minigame`);

      // The chunk boundary. Everything game-shaped lives behind this await.
      const { createSlogaball } = await import("./slogaballGame.ts");
      parked = {
        channelId,
        canvas,
        game: createSlogaball(canvas, {
          outOfBalls: t`Out of balls!`,
          cleared: t`Field cleared!`,
          playAgain: t`Click to play again`,
          freeBall: t`Free ball!`,
        }),
      };
    }

    setMuted(parked.game.isMuted());

    // The overlay may have collapsed while the chunk downloaded (someone
    // joined on a slow link) — leave the game parked instead of hosting it
    // in a detached element.
    if (unmounted || !host) {
      parked.game.pause();
      return;
    }
    host.appendChild(parked.canvas);
    parked.game.resume();
  });

  onCleanup(() => {
    // Collapse ≠ quit: parking keeps the run alive (see `parked`). Quitting
    // is the close button below, which disposes explicitly.
    unmounted = true;
    parked?.game.pause();
    parked?.canvas.remove();
  });

  return (
    <Overlay>
      <OverlayHeader>
        <OverlayTitle>Slogaball</OverlayTitle>
        <HeaderActions>
          <IconButton
            size="sm"
            variant="standard"
            aria-label={muted() ? t`Unmute game sounds` : t`Mute game sounds`}
            onPress={() => {
              // No-op until the game chunk lands; the engine persists it.
              if (!parked) return;
              const next = !parked.game.isMuted();
              parked.game.setMuted(next);
              setMuted(next);
            }}
          >
            <Symbol>{muted() ? "volume_off" : "volume_up"}</Symbol>
          </IconButton>
          <IconButton
            size="sm"
            variant="standard"
            onPress={() => {
              disposeParked();
              props.onClose();
            }}
          >
            <Symbol>close</Symbol>
          </IconButton>
        </HeaderActions>
      </OverlayHeader>
      <GameHost ref={host} />
    </Overlay>
  );
}

const ChipHolder = styled("div", {
  base: {
    position: "absolute",
    bottom: "var(--gap-md)",
    left: "50%",
    transform: "translateX(-50%)",
    zIndex: 3,
  },
});

/**
 * Snackbar-style pill (inverse surface), same treatment as the dice toasts —
 * it has to read over a camera preview as well as the flat voice background.
 */
const ChipPill = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    padding: "8px 14px",
    borderRadius: "14px",
    border: "none",
    cursor: "pointer",

    fontSize: "0.9rem",
    fontWeight: "600",
    background: "var(--md-sys-color-inverse-surface)",
    color: "var(--md-sys-color-inverse-on-surface)",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.35)",

    transition: "transform .15s ease",
    _hover: {
      transform: "translateY(-1px)",
    },
  },
});

/**
 * Fills the participant AREA only — the controls bar and the top banners are
 * outside/above it on purpose (see the component comment).
 */
const Overlay = styled("div", {
  base: {
    position: "absolute",
    inset: 0,
    zIndex: 4,

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",
    padding: "var(--gap-md)",
    borderRadius: "12px",

    background:
      "color-mix(in srgb, var(--md-sys-color-surface-container-low) 92%, transparent)",
    backdropFilter: "blur(6px)",
  },
});

const HeaderActions = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
  },
});

const OverlayHeader = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    flexShrink: 0,
  },
});

const OverlayTitle = styled("span", {
  base: {
    fontWeight: "700",
    fontSize: "1rem",
    color: "var(--md-sys-color-on-surface)",
  },
});

const GameHost = styled("div", {
  base: {
    flexGrow: 1,
    minHeight: 0,
  },
});
