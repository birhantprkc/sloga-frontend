import { styled } from "styled-system/jsx";

import { typography } from "@revolt/ui/components/design";

/**
 * Common styles for the floating indicators
 */
export const FloatingIndicator = styled("div", {
  base: {
    // for <Ripple />:
    position: "relative",

    display: "flex",
    userSelect: "none",
    alignItems: "center",

    width: "100%",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",

    cursor: "pointer",
    backdropFilter: "var(--effects-blur-md)",

    ...typography.raw({ size: "small" }),

    fill: "var(--md-sys-color-on-primary)",
    color: "var(--md-sys-color-on-primary)",
    // 85%, not 55%. --md-sys-color-on-primary is only guaranteed legible on
    // *solid* primary, and at 55% this blended down to a mid-tone that neither
    // a light nor a dark label could clear: measured 2.5-3.2:1 across both
    // presets in both modes. 85% is the lowest share where every combination
    // clears AA (worst 4.61:1) while the chip still reads as glass, which the
    // backdrop-filter above needs.
    backgroundColor:
      "color-mix(in srgb, var(--md-sys-color-primary) 85%, transparent)",

    animation: "slideIn 340ms cubic-bezier(0.2, 0.9, 0.5, 1.16) forwards",
  },
  variants: {
    position: {
      top: {
        "--translateY": "-33px",
      },
      bottom: {
        "--translateY": "33px",
      },
    },
  },
});
