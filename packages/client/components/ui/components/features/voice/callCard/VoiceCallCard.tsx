import { Show } from "solid-js";

import { Channel } from "stoat.js";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useVoice } from "@revolt/rtc";

import { VoiceCallCardActiveRoom } from "./VoiceCallCardActiveRoom";
import { VoiceCallCardPreview } from "./VoiceCallCardPreview";

type State =
  | {
      type: "floating";
      corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    }
  | {
      type: "fixed";
      x: number;
      width: number;
    };

/**
 * Voice call card context
 */
export function VoiceCallCardContext() {
  return null;
}

/**
 * 'Marker' to send position information for mounting the floating call card
 */
export function VoiceChannelCallCardMount(props: { channel: Channel }) {
  // todo: do not allow override if channel different
  return (
    <div class={css({ position: "relative" })}>
      <VoiceCallCard channel={props.channel} />
    </div>
  );
}

/**
 * Call card
 */
function VoiceCallCard(props: { channel: Channel }) {
  const voice = useVoice();
  const inCall = () => voice.channel()?.id === props.channel.id;

  return (
    <Base>
      <Card active={inCall()}>
        <Show
          when={inCall()}
          fallback={<VoiceCallCardPreview channel={props.channel} />}
        >
          <VoiceCallCardActiveRoom />
        </Show>
      </Card>
    </Base>
  );
}

const Base = styled("div", {
  base: {
    // todo: temp for Mount
    top: "var(--gap-md)",
    padding: "var(--gap-md)",

    width: "100%",
    position: "absolute",

    zIndex: 2,
    userSelect: "none",

    display: "flex",
    alignItems: "center",
    flexDirection: "column",
  },
});

const Card = styled("div", {
  base: {
    maxWidth: "100%",
    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease-in-out",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-secondary-container)",
  },
  variants: {
    active: {
      true: {
        width: "100%",
        height: "40vh",
      },
      false: {
        width: "360px",
        height: "120px",
        cursor: "pointer",
      },
    },
  },
  defaultVariants: {
    active: false,
  },
});
