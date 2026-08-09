import { useLingui } from "@lingui-solid/solid/macro";
import {
  For,
  Show,
  createEffect,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

import { styled } from "styled-system/jsx";

import { CONFIGURATION } from "@revolt/common";
import { useVoice } from "@revolt/rtc";
import { IconButton } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import {
  minigameChipVisible,
  minigameInterruptedByJoin,
} from "./minigamePolicy.ts";

/**
 * "Play while you wait" (slice 1): a chip offered while sitting ALONE in a
 * call, opening a game over the empty tile area. Someone joining auto-pauses
 * and collapses it — the WoW-Peggle rule: the game exists to absorb the wait,
 * never to compete with the call.
 *
 * Two games now, so the chip opens a PICKER rather than a game. The picker is
 * the only part that has to know they exist: everything else here is
 * game-agnostic, and a third game is a row in `GamePicker`'s list plus a
 * branch in the loader inside `MinigameOverlay`.
 *
 * Mounted inside the participant area's relative container (the `<Call>` div
 * in VoiceCallCardActiveRoom) rather than over the whole card, so the controls
 * bar below stays visible and clickable mid-game — muting yourself must not
 * require quitting a game. The card's absolutely-positioned notices (TopBanners
 * z5, dice toasts z6) stay above the overlay's z4: the E2EE downgrade banner
 * is blocking and always wins.
 *
 * Each engine is a separate lazy chunk (`await import`, the transcriptionEngine
 * precedent) — the main bundle carries only this file, and opening one game
 * never downloads the other.
 */

export type GameId = "slogaball" | "slogatron";

/**
 * All the chip needs from an engine. Both games declare this shape themselves
 * rather than importing it, which is what lets them keep their no-imports rule
 * and still run under `node --test`; TypeScript is structural, so they stay
 * interchangeable here.
 */
type MinigameHandle = {
  pause(): void;
  resume(): void;
  dispose(): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
};

/**
 * The parked game survives the overlay unmounting (join-collapse, browsing to
 * another channel) so coming back resumes the same run. It dies with the call:
 * the effect below disposes it when the voice state leaves CONNECTED, and
 * adopting it under a DIFFERENT channel disposes it first — a leftover from a
 * previous call must not resurrect in the next one.
 *
 * Deliberately ONE game at a time, not one per game: switching games mid-call
 * ends the run you left. Two parked engines would mean two canvases and two
 * audio contexts held open underneath a live call, which is a poor trade for
 * "you can flip back to your other unfinished game".
 */
let parked: {
  channelId: string;
  gameId: GameId;
  canvas: HTMLCanvasElement;
  game: MinigameHandle;
} | null = null;

function disposeParked() {
  parked?.game.dispose();
  parked?.canvas.remove();
  parked = null;
}

export function MinigameChip() {
  const voice = useVoice();
  const { t } = useLingui();
  const [open, setOpen] = createSignal(false);
  /** Which game the overlay is showing; null means the picker. */
  const [picked, setPicked] = createSignal<GameId | null>(null);

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
      setPicked(null);
    }
  });

  return (
    <>
      <Show when={visible() && !open()}>
        <ChipHolder>
          <ChipPill
            type="button"
            onClick={() => {
              // Straight back into a run in progress; the picker is one tap
              // away from there if they actually wanted the other game.
              setPicked(parked?.gameId ?? null);
              setOpen(true);
            }}
          >
            <Symbol size={18}>sports_esports</Symbol>
            {t`Play while you wait?`}
          </ChipPill>
        </ChipHolder>
      </Show>
      <Show when={open() && visible()}>
        {/* `keyed` on purpose: the overlay adopts its game in onMount, so
            swapping which game is picked has to REMOUNT it, not just hand the
            existing one a new id. */}
        <Show
          when={picked()}
          keyed
          fallback={
            <GamePicker
              onPick={(id) => setPicked(id)}
              onClose={() => setOpen(false)}
            />
          }
        >
          {(id) => (
            <MinigameOverlay
              gameId={id}
              onBack={() => {
                // Back to the picker parks rather than quits, so wandering in
                // to look at the other game doesn't cost you the run.
                parked?.game.pause();
                setPicked(null);
              }}
              onClose={() => {
                disposeParked();
                setPicked(null);
                setOpen(false);
              }}
            />
          )}
        </Show>
      </Show>
    </>
  );
}

function GamePicker(props: {
  onPick: (id: GameId) => void;
  onClose: () => void;
}) {
  const { t } = useLingui();

  const games: {
    id: GameId;
    name: string;
    icon: string;
    blurb: string;
  }[] = [
    {
      id: "slogaball",
      name: "Slogaball",
      icon: "sports_soccer",
      blurb: t`Drop the ball, clear the pegs.`,
    },
    {
      id: "slogatron",
      name: "Slogatron",
      icon: "radar",
      blurb: t`Hold the rim, clear the web.`,
    },
  ];

  return (
    <Overlay>
      <OverlayHeader>
        <OverlayTitle>{t`Play while you wait`}</OverlayTitle>
        <HeaderActions>
          <IconButton
            size="sm"
            variant="standard"
            aria-label={t`Close`}
            onPress={() => props.onClose()}
          >
            <Symbol>close</Symbol>
          </IconButton>
        </HeaderActions>
      </OverlayHeader>
      <PickerGrid>
        <For each={games}>
          {(game) => (
            <GameTile type="button" onClick={() => props.onPick(game.id)}>
              <Symbol size={34}>{game.icon}</Symbol>
              <TileName>{game.name}</TileName>
              <TileBlurb>{game.blurb}</TileBlurb>
            </GameTile>
          )}
        </For>
      </PickerGrid>
    </Overlay>
  );
}

function MinigameOverlay(props: {
  gameId: GameId;
  onBack: () => void;
  onClose: () => void;
}) {
  const voice = useVoice();
  const { t } = useLingui();

  let host: HTMLDivElement | undefined;
  let unmounted = false;

  // Mirrors the engine's per-device mute preference; synced once the (maybe
  // still downloading) game chunk is up, since the engine owns persistence.
  const [muted, setMuted] = createSignal(false);

  const title = () =>
    props.gameId === "slogatron" ? "Slogatron" : "Slogaball";

  onMount(async () => {
    const channelId = voice.channel()?.id ?? "";
    // A parked game from another channel, or a different game entirely, is
    // not ours to adopt.
    if (
      parked &&
      (parked.channelId !== channelId || parked.gameId !== props.gameId)
    )
      disposeParked();

    if (!parked) {
      const canvas = document.createElement("canvas");
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      // Steering is pointermove — without this a touch drag scrolls instead.
      canvas.style.touchAction = "none";
      canvas.setAttribute("role", "img");
      canvas.setAttribute(
        "aria-label",
        props.gameId === "slogatron"
          ? t`Slogatron minigame`
          : t`Slogaball minigame`,
      );

      // The chunk boundary. Everything game-shaped lives behind these awaits,
      // and only the game actually opened is ever fetched.
      let game: MinigameHandle;
      if (props.gameId === "slogatron") {
        const { createSlogatron } = await import("./slogatronGame.ts");
        game = createSlogatron(canvas, {
          gameOver: t`Game over`,
          playAgain: t`Click to play again`,
          webCleared: t`Web cleared!`,
          zap: t`Zap`,
          start: t`Click to start`,
          webLabel: (n) => t`Web ${n}`,
        });
      } else {
        const { createSlogaball } = await import("./slogaballGame.ts");
        game = createSlogaball(canvas, {
          outOfBalls: t`Out of balls!`,
          cleared: t`Field cleared!`,
          playAgain: t`Click to play again`,
          freeBall: t`Free ball!`,
        });
      }

      parked = { channelId, gameId: props.gameId, canvas, game };
    }

    setMuted(parked.game.isMuted());

    // The overlay may have collapsed while the chunk downloaded (someone
    // joined on a slow link) — leave the game parked instead of hosting it in
    // a detached element.
    if (unmounted || !host) {
      parked.game.pause();
      return;
    }
    host.appendChild(parked.canvas);
    parked.game.resume();
  });

  onCleanup(() => {
    // Collapse ≠ quit: parking keeps the run alive (see `parked`). Quitting is
    // the close button below, which disposes explicitly.
    unmounted = true;
    parked?.game.pause();
    parked?.canvas.remove();
  });

  return (
    <Overlay>
      <OverlayHeader>
        <HeaderActions>
          <IconButton
            size="sm"
            variant="standard"
            aria-label={t`Back to games`}
            onPress={() => props.onBack()}
          >
            <Symbol>arrow_back</Symbol>
          </IconButton>
          <OverlayTitle>{title()}</OverlayTitle>
        </HeaderActions>
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
            aria-label={t`Close`}
            onPress={() => props.onClose()}
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

/**
 * Auto-fit rather than a fixed two-up: the call card is as narrow as a sidebar
 * on mobile and as wide as the window in a maximized call, and the tiles
 * should stack rather than squeeze.
 */
const PickerGrid = styled("div", {
  base: {
    flexGrow: 1,
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
    gap: "var(--gap-md)",
    alignContent: "center",
    justifyContent: "center",
    overflowY: "auto",
    padding: "var(--gap-sm)",
  },
});

const GameTile = styled("button", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    padding: "var(--gap-lg) var(--gap-md)",

    cursor: "pointer",
    borderRadius: "12px",
    border: "1px solid var(--md-sys-color-outline-variant)",
    background: "var(--md-sys-color-surface-container-high)",
    color: "var(--md-sys-color-on-surface)",

    transition: "transform .15s ease, background .15s ease",
    _hover: {
      transform: "translateY(-2px)",
      background: "var(--md-sys-color-surface-container-highest)",
    },
  },
});

const TileName = styled("span", {
  base: {
    fontWeight: "700",
    fontSize: "0.95rem",
  },
});

const TileBlurb = styled("span", {
  base: {
    fontSize: "0.8rem",
    textAlign: "center",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});
