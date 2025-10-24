import { styled } from "styled-system/jsx";

import { VoiceCallCardActions } from "./VoiceCallCardActions";
import { VoiceCallCardStatus } from "./VoiceCallCardStatus";

export function VoiceCallCardPiP() {
  return (
    <MiniCard>
      <VoiceCallCardStatus />
      <VoiceCallCardActions />
    </MiniCard>
  );
}

const MiniCard = styled("div", {
  base: {
    pointerEvents: "all",
    width: "100%",
    height: "100%",

    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    padding: "var(--gap-md)",

    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-secondary-container)",
  },
});
