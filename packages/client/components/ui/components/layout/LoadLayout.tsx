import { Accessor, createEffect } from "solid-js";

import { useDevice } from "@revolt/common";
import { useState } from "@revolt/state";
import { CONTENT_WIDTHS, LayoutSide } from "@revolt/state/stores/Settings";

/**
 * Mount the message width preference onto the root element.
 *
 * Kept out of `main`'s stylesheet so the cva keeps knowing nothing about the
 * settings store: it reads two custom properties and does not care where they
 * came from, and clearing them reverts the feature wholesale.
 *
 * Mounted on <html> for the same reason the theme variables are — see
 * `LoadTheme`.
 */
export function LoadLayout() {
  const state = useState();

  createEffect(() => {
    const preset =
      state.settings.getValue("appearance:content_width") ?? "full";
    const width = CONTENT_WIDTHS[preset];
    const centred =
      (state.settings.getValue("appearance:content_align") ?? "start") ===
      "center";

    const root = document.documentElement.style;

    // "full" removes the properties rather than writing a no-op value, so the
    // fallbacks baked into `main` are what apply and the computed style of a
    // user who never touched this is byte-identical to before the feature.
    if (width === null) {
      root.removeProperty("--layout-max-content-width");
      root.removeProperty("--layout-content-margin-inline");
      return;
    }

    root.setProperty("--layout-max-content-width", `${width}px`);
    root.setProperty(
      "--layout-content-margin-inline",
      centred ? "auto" : "var(--gap-md)",
    );
  });

  return null;
}

/**
 * Whether the ultrawide rearrangement should apply right now.
 *
 * Two conditions, deliberately measuring different things:
 * - the user asked for it, on a display wide enough for the control to have
 *   been offered at all (screen aspect, see `Device.ultrawideDisplay`)
 * - the *window* currently has room for the extra column (`Device.wideEnough`)
 *
 * The second is what makes a half-screen-snapped window fall back on its own
 * and recover on un-snap, with no extra bookkeeping.
 */
export function useUltrawideLayout(): Accessor<boolean> {
  const state = useState();
  const device = useDevice();

  return () =>
    state.settings.getValue("appearance:ultrawide_layout") === true &&
    device.wideEnough();
}

/**
 * The resolved arrangement of the shell's movable panels.
 */
export interface LayoutSides {
  /** Side the navigation block (server rail + channel list) sits on */
  nav: LayoutSide;
  /** Side the member list sits on */
  members: LayoutSide;
  /**
   * Whether the member list gets its own full-height column (opposite side
   * from the nav) rather than sharing the channel column behind the divider
   * (same side as the nav). Derived: `members !== nav`.
   */
  membersOwnColumn: boolean;
}

const DEFAULT_SIDES: LayoutSides = {
  nav: "left",
  members: "left",
  membersOwnColumn: false,
};

/**
 * Where the movable panels go right now. The single source of truth for
 * `Interface`, `TextChannel`, `ServerSidebar` and the headers — nothing else
 * should read the two `appearance:layout_*` keys directly.
 *
 * - Phone widths ignore the preference entirely: the slide drawer owns the
 *   layout there and always slides in from the left.
 * - `members: "auto"` reproduces the pre-designer behaviour — in the channel
 *   column, unless the ultrawide layout is active, which moves it opposite.
 */
export function useLayoutSides(): Accessor<LayoutSides> {
  const state = useState();
  const device = useDevice();
  const ultrawide = useUltrawideLayout();

  return () => {
    if (device.layout() === "phone") return DEFAULT_SIDES;

    const nav = state.settings.getValue("appearance:layout_nav_side") ?? "left";
    const pref =
      state.settings.getValue("appearance:layout_members_side") ?? "auto";
    const opposite: LayoutSide = nav === "left" ? "right" : "left";
    const members: LayoutSide =
      pref === "auto" ? (ultrawide() ? opposite : nav) : pref;

    return { nav, members, membersOwnColumn: members !== nav };
  };
}
