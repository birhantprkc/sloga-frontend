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

    // Message width preference. Both variables are unset until the user asks
    // for a cap, and their fallbacks are the values that were hardcoded here
    // before, so this reduces exactly to the previous behaviour for anyone who
    // never opens the setting.
    //
    // Custom properties rather than cva variants on purpose: a variant merges
    // *after* the base and would quietly win over anything a consumer sets,
    // and `main` is applied from several call sites. A property set on the
    // root element carries no such ordering surprise, and the whole feature
    // reverts by clearing it.
    //
    // Hugging the left needs no margin work at all — `maxWidth` alone stops
    // the flex item growing and the leftover space collects after it, which is
    // the default packing. Only centring needs the `auto` margins.
    maxWidth: "var(--layout-max-content-width, none)",
    marginInline: "var(--layout-content-margin-inline, var(--gap-md))",

    display: "flex",
    overflow: "hidden",
    flexDirection: "column",

    paddingInline: "var(--gap-md)",
    marginBlockEnd: "var(--gap-md)",
    borderRadius: "var(--borderRadius-xl)",
    background: "var(--md-sys-color-surface-container-lowest)",

    _tablet: {
      margin: 0,
      borderBottomRightRadius: 0,
      borderBottomLeftRadius: 0,
      // `_tablet` is `max-width: 840px` (plus a short-window clause), so it
      // covers phones too. No cap makes sense at those sizes, and the existing
      // `margin: 0` already neutralises the alignment margin.
      maxWidth: "none",
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
