/**
 * The overlay's participant list.
 *
 * ROOM-FREE AND CLIENT-FREE BY CONSTRUCTION. `VoiceCallCardPiP` is the visual
 * model, but none of it can be reused directly: its `TrackLoop` /
 * `useEnsureParticipant` / `useIsSpeaking` / `useUser` layer all require a
 * live LiveKit `Room` plus a `Client` (`useEnsureRoom` throws without one),
 * and this window has neither. What IS reused is the chip *shape* — a
 * circular avatar with a 2px ring when speaking, and a `mic_off` badge.
 *
 * Hard constraints, because the overlay window has no provider stack:
 *
 * - **No lingui.** No `<Trans>`, no `t` — they throw at runtime here and
 *   neither tsc nor the extractor will tell you. Every string is plain.
 * - **No modals, keybinds or snackbars.** Nothing interactive at all,
 *   in fact: the window is click-through for its whole life, so a control
 *   rendered here could never be clicked.
 * - Avatars are plain `<img>` on finished URLs (Autumn and `default_avatar`
 *   are unauthenticated GETs) — `<Avatar>` would want a hydrated `User`.
 */
import { For, Show } from "solid-js";

import { OverlayConfig, OverlayParticipant } from "./protocol";

/**
 * Material Symbols is a module-scope global import in src/index.tsx, so the
 * font is present in this window with zero providers mounted. Rendering the
 * glyph as plain text (rather than through `<Symbol>`, which is fine but
 * pulls in the ui package) keeps this component's dependency surface at
 * solid-js + the protocol types.
 */
function MicOffBadge(props: { scale: number }) {
  return (
    <span
      style={{
        position: "absolute",
        right: "-2px",
        bottom: "-2px",
        display: "grid",
        "place-items": "center",
        width: `${12 * props.scale}px`,
        height: `${12 * props.scale}px`,
        "border-radius": "50%",
        background: "var(--md-sys-color-error, #b3261e)",
        color: "var(--md-sys-color-on-error, #fff)",
        "font-family": "'Material Symbols Rounded'",
        "font-size": `${9 * props.scale}px`,
        // String, not the number 1 — Solid does not append units and the
        // style-prop lint rule flags the bare number.
        "line-height": "1",
      }}
    >
      mic_off
    </span>
  );
}

function Chip(props: {
  participant: OverlayParticipant;
  config: OverlayConfig;
}) {
  const size = () => 28 * props.config.scale;

  return (
    <div
      style={{
        position: "relative",
        width: `${size()}px`,
        height: `${size()}px`,
        "flex-shrink": 0,
      }}
    >
      <Show
        when={props.participant.avatarUrl}
        fallback={
          <div
            style={{
              width: "100%",
              height: "100%",
              "border-radius": "50%",
              background: "var(--md-sys-color-surface-variant, #2a2f37)",
            }}
          />
        }
      >
        <img
          src={props.participant.avatarUrl}
          alt=""
          style={{
            width: "100%",
            height: "100%",
            "border-radius": "50%",
            "object-fit": "cover",
            display: "block",
          }}
        />
      </Show>
      {/* The speaking ring is drawn as a separate ABSOLUTE layer rather than
          an outline on the image, so turning it on and off cannot reflow the
          row — a list that jitters every time someone starts talking is the
          one thing an always-on-top overlay must not do. */}
      <div
        style={{
          position: "absolute",
          inset: "-3px",
          "border-radius": "50%",
          border: `2px solid ${
            props.participant.speaking
              ? "var(--md-sys-color-primary, #7dd3a0)"
              : "transparent"
          }`,
        }}
      />
      <Show when={props.participant.muted}>
        <MicOffBadge scale={props.config.scale} />
      </Show>
    </div>
  );
}

function Name(props: {
  participant: OverlayParticipant;
  config: OverlayConfig;
}) {
  return (
    <span
      style={{
        // A dark chip behind the text, because the background is arbitrary
        // game footage — white-on-anything is not legible, and a text shadow
        // alone loses against a bright HUD.
        padding: `${1 * props.config.scale}px ${5 * props.config.scale}px`,
        "border-radius": `${6 * props.config.scale}px`,
        background: "rgba(6, 10, 14, 0.62)",
        color: props.participant.speaking
          ? "var(--md-sys-color-primary, #7dd3a0)"
          : "#e6edf3",
        "font-size": `${12 * props.config.scale}px`,
        "font-weight": 600,
        "white-space": "nowrap",
        "max-width": `${180 * props.config.scale}px`,
        overflow: "hidden",
        "text-overflow": "ellipsis",
      }}
    >
      {props.participant.name}
    </span>
  );
}

export function OverlayRoster(props: {
  participants: OverlayParticipant[];
  config: OverlayConfig;
  rttMs?: number;
}) {
  const gap = () => `${4 * props.config.scale}px`;

  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "flex-start",
        gap: gap(),
      }}
    >
      <For each={props.participants}>
        {(participant) => (
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: gap(),
            }}
          >
            <Show when={props.config.displayMode !== "names"}>
              <Chip participant={participant} config={props.config} />
            </Show>
            <Show when={props.config.displayMode !== "avatars"}>
              <Name participant={participant} config={props.config} />
            </Show>
          </div>
        )}
      </For>
      <Show when={props.config.showLatency}>
        <span
          style={{
            padding: `${1 * props.config.scale}px ${5 * props.config.scale}px`,
            "border-radius": `${6 * props.config.scale}px`,
            background: "rgba(6, 10, 14, 0.62)",
            color: "#9fb3c8",
            "font-size": `${11 * props.config.scale}px`,
            "font-variant-numeric": "tabular-nums",
          }}
        >
          {props.rttMs === undefined ? "— ms" : `${props.rttMs} ms`}
        </span>
      </Show>
    </div>
  );
}
