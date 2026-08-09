import { cva } from "styled-system/css";

import { typography } from "./Text";

/**
 * Red LIVE pill, shown beside a username while that user is broadcasting.
 *
 * Two surfaces share it and have to keep looking alike: a linked streaming
 * channel that has gone live (member sidebar, profile) and a screenshare
 * running in a voice channel. The red is a fixed value rather than a theme
 * colour on purpose — "live" is a cross-platform convention people read at a
 * glance, and it should not drift with whichever accent colour a user picked.
 *
 * Applied to a plain element rather than wrapped in a component so that
 * `use:floating` still compiles as a directive at the call site.
 */
export const livePill = cva({
  base: {
    ...typography.raw({ class: "label", size: "small" }),

    flexShrink: 0,
    background: "#e91916",
    color: "#fff",
    borderRadius: "var(--borderRadius-sm)",
    padding: "0 var(--gap-sm)",
    marginInlineStart: "var(--gap-sm)",
    fontWeight: 700,
    lineHeight: "1.4",
    verticalAlign: "middle",
  },
});
