import { For, JSX, Show, batch, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import {
  LAYOUT_SECTIONS,
  SERVER_RAIL_EXPANDED_DEFAULT,
} from "@revolt/state/stores/Layout";
import { LayoutSide, MembersSide } from "@revolt/state/stores/Settings";
import { Button, Row, Text, useLayoutSides } from "@revolt/ui";

/**
 * A movable panel in the schematic
 */
type Panel = "nav" | "members";

/**
 * Named arrangements. Not a stored key — the active preset is *derived* from
 * the two real settings keys so it can never drift from them; anything that
 * matches none of these reads as "Custom".
 */
type Preset = "sloga" | "discord" | "mirrored";

const PRESETS: {
  id: Preset;
  nav: LayoutSide;
  members: MembersSide;
  label: () => JSX.Element;
}[] = [
  {
    id: "sloga",
    nav: "left",
    members: "auto",
    label: () => <Trans>Sloga</Trans>,
  },
  {
    id: "discord",
    nav: "left",
    members: "right",
    label: () => <Trans>Discord</Trans>,
  },
  {
    id: "mirrored",
    nav: "right",
    members: "left",
    label: () => <Trans>Mirrored</Trans>,
  },
];

/**
 * Settings → Appearance → Layout: choose which side of the window the
 * navigation block (server rail + channel list) and the member list sit on.
 *
 * Three views of the same two keys — presets, a draggable schematic, and
 * plain button rows — so the arrangement can be picked by whichever the user
 * reaches for (pointer, keyboard, or a name). Changes apply to the real app
 * behind the settings dialog immediately; there is no apply step.
 */
export function LayoutArrangement() {
  const state = useState();
  const { t } = useLingui();
  const sides = useLayoutSides();

  const navSide = () =>
    state.settings.getValue("appearance:layout_nav_side") ?? "left";
  const membersPref = () =>
    state.settings.getValue("appearance:layout_members_side") ?? "auto";

  /** Which preset (if any) the two keys currently spell */
  const activePreset = (): Preset | "custom" =>
    PRESETS.find((p) => p.nav === navSide() && p.members === membersPref())
      ?.id ?? "custom";

  function applyPreset(preset: (typeof PRESETS)[number]) {
    batch(() => {
      state.settings.setValue("appearance:layout_nav_side", preset.nav);
      state.settings.setValue("appearance:layout_members_side", preset.members);
    });

    // Discord's server rail is icons-only. One-shot on purpose: this writes
    // the section state once when the preset is picked and never enforces
    // it, so re-expanding the rail afterwards is allowed and does not flip
    // the preset label (rail state is not part of the match above).
    if (preset.id === "discord") {
      state.layout.setSectionState(
        LAYOUT_SECTIONS.SERVER_RAIL_EXPANDED,
        false,
        SERVER_RAIL_EXPANDED_DEFAULT,
      );
    }
  }

  function movePanel(panel: Panel, side: LayoutSide) {
    if (panel === "nav") {
      state.settings.setValue("appearance:layout_nav_side", side);
    } else {
      state.settings.setValue("appearance:layout_members_side", side);
    }
  }

  // --- schematic drag -----------------------------------------------------

  let schematicRef: HTMLDivElement | undefined;
  const [dragging, setDragging] = createSignal<Panel>();
  const [hoverSide, setHoverSide] = createSignal<LayoutSide>();

  /** Which half of the schematic a pointer is over */
  function sideAt(clientX: number): LayoutSide {
    const rect = schematicRef!.getBoundingClientRect();
    return clientX < rect.left + rect.width / 2 ? "left" : "right";
  }

  function beginDrag(panel: Panel, event: PointerEvent) {
    // Primary button only; a right-click must keep opening the context menu.
    if (event.button !== 0) return;
    // The member band nests inside the nav tile — without this, grabbing it
    // would start a nav drag as well.
    event.stopPropagation();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    setDragging(panel);
    setHoverSide(sideAt(event.clientX));

    const move = (e: PointerEvent) => setHoverSide(sideAt(e.clientX));
    const end = (e: PointerEvent) => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", cancel);
      if (target.hasPointerCapture(e.pointerId)) {
        target.releasePointerCapture(e.pointerId);
      }
      const side = hoverSide();
      setDragging(undefined);
      setHoverSide(undefined);
      if (side) movePanel(panel, side);
    };
    const cancel = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", end);
      target.removeEventListener("pointercancel", cancel);
      setDragging(undefined);
      setHoverSide(undefined);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", end);
    target.addEventListener("pointercancel", cancel);
  }

  /** Arrow keys move the focused tile; Enter/Space flips it to the other side */
  function onTileKey(panel: Panel, event: KeyboardEvent) {
    const current = panel === "nav" ? sides().nav : sides().members;
    let next: LayoutSide | undefined;
    if (event.key === "ArrowLeft") next = "left";
    else if (event.key === "ArrowRight") next = "right";
    else if (event.key === "Enter" || event.key === " ")
      next = current === "left" ? "right" : "left";
    if (!next) return;
    event.preventDefault();
    event.stopPropagation();
    movePanel(panel, next);
  }

  /** Human-readable state for assistive tech; the schematic is decorative */
  const navLabel = () =>
    sides().nav === "left"
      ? t`Server list and channels: on the left. Press left or right arrow to move.`
      : t`Server list and channels: on the right. Press left or right arrow to move.`;
  const membersLabel = () =>
    sides().members === "left"
      ? t`Member list: on the left. Press left or right arrow to move.`
      : t`Member list: on the right. Press left or right arrow to move.`;

  /**
   * The nav column tile: rail band + channel band, with the member band
   * stacked under the channels when the two share a side (which is exactly
   * what the real column does).
   */
  const NavTile = () => (
    <Tile
      role="button"
      tabIndex={0}
      aria-label={navLabel()}
      dragging={dragging() === "nav"}
      // Rail at the window edge, channels inside — as the real block does.
      reversed={sides().nav === "right"}
      onPointerDown={[beginDrag, "nav"]}
      onKeyDown={[onTileKey, "nav"]}
    >
      <Rail>
        <RailDot />
        <RailDot />
        <RailDot />
      </Rail>
      <Column>
        <Band grow>
          <Trans>Channels</Trans>
        </Band>
        <Show when={!sides().membersOwnColumn}>
          <MembersBand
            role="button"
            tabIndex={0}
            aria-label={membersLabel()}
            dragging={dragging() === "members"}
            onPointerDown={[beginDrag, "members"]}
            onKeyDown={[onTileKey, "members"]}
          >
            <Trans>Members</Trans>
          </MembersBand>
        </Show>
      </Column>
    </Tile>
  );

  /** The member list as its own column, opposite the nav */
  const MembersTile = () => (
    <Tile
      role="button"
      tabIndex={0}
      aria-label={membersLabel()}
      dragging={dragging() === "members"}
      onPointerDown={[beginDrag, "members"]}
      onKeyDown={[onTileKey, "members"]}
      narrow
    >
      <Band grow>
        <Trans>Members</Trans>
      </Band>
    </Tile>
  );

  const Gutter = (props: { side: LayoutSide }) => (
    <GutterBase
      side={props.side}
      target={dragging() !== undefined && hoverSide() === props.side}
    >
      <Show when={sides().nav === props.side}>
        <NavTile />
      </Show>
      <Show when={sides().membersOwnColumn && sides().members === props.side}>
        <MembersTile />
      </Show>
    </GutterBase>
  );

  return (
    <>
      <Text class="label">
        <Trans>Arrangement</Trans>
      </Text>
      <Row justify="stretch">
        <For each={PRESETS}>
          {(preset, index) => (
            <Button
              size="xs"
              group={index() === 0 ? "connected-start" : "connected"}
              groupActive={activePreset() === preset.id}
              onPress={() => applyPreset(preset)}
            >
              {preset.label()}
            </Button>
          )}
        </For>
        {/* Display-only: lights up when the keys match no preset. */}
        <Button
          size="xs"
          group="connected-end"
          groupActive={activePreset() === "custom"}
          onPress={() => {}}
        >
          <Trans>Custom</Trans>
        </Button>
      </Row>

      <Schematic ref={schematicRef} dragging={dragging() !== undefined}>
        <Gutter side="left" />
        <Chat>
          <ChatHeader />
          <ChatLine w={62} />
          <ChatLine w={40} />
          <ChatLine w={74} />
          <ChatLine w={30} />
          <ChatComposer />
        </Chat>
        <Gutter side="right" />
      </Schematic>

      <Text class="label">
        <Trans>Server list and channels</Trans>
      </Text>
      <Row justify="stretch">
        <Button
          size="xs"
          group="connected-start"
          groupActive={navSide() === "left"}
          onPress={() => movePanel("nav", "left")}
        >
          <Trans>Left</Trans>
        </Button>
        <Button
          size="xs"
          group="connected-end"
          groupActive={navSide() === "right"}
          onPress={() => movePanel("nav", "right")}
        >
          <Trans>Right</Trans>
        </Button>
      </Row>

      <Text class="label">
        <Trans>Member list</Trans>
      </Text>
      <Row justify="stretch">
        <Button
          size="xs"
          group="connected-start"
          groupActive={membersPref() === "auto"}
          onPress={() =>
            state.settings.setValue("appearance:layout_members_side", "auto")
          }
        >
          <Trans>Auto</Trans>
        </Button>
        <Button
          size="xs"
          group="connected"
          groupActive={membersPref() === "left"}
          onPress={() => movePanel("members", "left")}
        >
          <Trans>Left</Trans>
        </Button>
        <Button
          size="xs"
          group="connected-end"
          groupActive={membersPref() === "right"}
          onPress={() => movePanel("members", "right")}
        >
          <Trans>Right</Trans>
        </Button>
      </Row>
      <Text class="label">
        <Show
          when={membersPref() === "auto"}
          fallback={
            <Trans>
              On the same side as the channels, the member list shares their
              column. Overrides Ultrawide layout's member list placement.
            </Trans>
          }
        >
          <Trans>
            Auto keeps the member list with the channels, unless Ultrawide
            layout moves it to the other side. Applies to this device only.
          </Trans>
        </Show>
      </Text>
    </>
  );
}

// --- schematic styles -----------------------------------------------------

const Schematic = styled("div", {
  base: {
    display: "flex",
    height: "168px",
    padding: "var(--gap-sm)",
    gap: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-high)",
    userSelect: "none",
    touchAction: "none",
  },
  variants: {
    dragging: {
      true: {
        cursor: "grabbing",
      },
    },
  },
});

/**
 * One side of the schematic. Always rendered, even when empty, so there is
 * a drop target on both sides and the chat block stays centred in what is
 * left. Highlights while a tile is dragged over it.
 */
const GutterBase = styled("div", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    minWidth: "40px",
    borderRadius: "var(--borderRadius-md)",
    outline: "2px dashed transparent",
    outlineOffset: "-2px",
    transition: "outline-color 0.1s ease",
  },
  variants: {
    side: {
      left: { justifyContent: "flex-start" },
      right: { justifyContent: "flex-end", flexDirection: "row-reverse" },
    },
    target: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
        background: "var(--md-sys-color-primary-container)",
      },
    },
  },
});

const Tile = styled("div", {
  base: {
    display: "flex",
    gap: "2px",
    padding: "2px",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-highest)",
    cursor: "grab",
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "1px",
    },
  },
  variants: {
    reversed: {
      true: { flexDirection: "row-reverse" },
    },
    narrow: {
      true: { width: "44px" },
      false: { width: "88px" },
    },
    dragging: {
      true: {
        opacity: 0.6,
        cursor: "grabbing",
      },
    },
  },
  defaultVariants: {
    narrow: false,
  },
});

const Rail = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "4px",
    padding: "4px 0",
    width: "20px",
    borderRadius: "var(--borderRadius-sm)",
    background: "var(--md-sys-color-surface-container-low)",
  },
});

const RailDot = styled("div", {
  base: {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    background: "var(--md-sys-color-outline-variant)",
  },
});

const Column = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    gap: "2px",
  },
});

const Band = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "2px",
    borderRadius: "var(--borderRadius-sm)",
    background: "var(--md-sys-color-surface-container-low)",
    color: "var(--md-sys-color-on-surface-variant)",
    fontSize: "10px",
    lineHeight: 1,
    textAlign: "center",
    overflow: "hidden",
  },
  variants: {
    grow: {
      true: { flexGrow: 1 },
    },
  },
});

/** The member band inside the shared column is itself grabbable */
const MembersBand = styled(Band, {
  base: {
    minHeight: "36px",
    cursor: "grab",
    "&:focus-visible": {
      outline: "2px solid var(--md-sys-color-primary)",
      outlineOffset: "1px",
    },
  },
  variants: {
    dragging: {
      true: {
        opacity: 0.6,
        cursor: "grabbing",
      },
    },
  },
});

const Chat = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
    minWidth: 0,
    gap: "6px",
    padding: "6px",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-lowest)",
  },
});

const ChatHeader = styled("div", {
  base: {
    height: "8px",
    width: "35%",
    borderRadius: "4px",
    background: "var(--md-sys-color-outline-variant)",
  },
});

const ChatLine = styled("div", {
  base: {
    height: "6px",
    borderRadius: "3px",
    background: "var(--md-sys-color-surface-container-high)",
  },
  variants: {
    w: {
      30: { width: "30%" },
      40: { width: "40%" },
      62: { width: "62%" },
      74: { width: "74%" },
    },
  },
});

const ChatComposer = styled("div", {
  base: {
    marginTop: "auto",
    height: "12px",
    borderRadius: "6px",
    background: "var(--md-sys-color-surface-container-high)",
  },
});
