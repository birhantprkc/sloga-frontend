import { cva } from "styled-system/css";

/**
 * Styles for the main content of a page
 *
 * This creates a surface on the lowest level with appropriate padding and separation.
 */
export const main = cva({
  base: {
    flexGrow: 1,
    minWidth: 0,
    minHeight: 0,

    display: "flex",
    overflow: "hidden",
    flexDirection: "column",

    paddingInline: "var(--gap-md)",
    marginInline: "var(--gap-md)",
    marginBlockEnd: "var(--gap-md)",
    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-lowest)",

    _tablet: {
      margin: 0,
      borderBottomRightRadius: 0,
      borderBottomLeftRadius: 0,
    },

    _phone: {
      margin: 0,
      borderRadius: 0,

      // The floating user bar belongs to the nav block, but on a phone that
      // block is a drawer the content slides straight over — so the bar ends
      // up pinned to the bottom of every screen, on top of whatever is there
      // (it was hiding the composer's input row). Reserve its height here so
      // the message list and the two composer bars sit above it. The strip
      // this leaves is painted in this surface, so there is no visible seam
      // behind the bar.
      paddingBlockEnd: "var(--layout-height-user-footer)",
    },
  },
});
