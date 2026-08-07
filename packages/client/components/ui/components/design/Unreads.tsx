import { Match, Switch } from "solid-js";

import { styled } from "styled-system/jsx";

/**
 * What the unread indicator is signalling, highest priority first. A tail that
 * mentions you outranks one that merely carries an attachment, which in turn
 * outranks plain unread messages.
 */
export type UnreadTone = "mention" | "attachment" | "unread";

/** Fill and ink per tone. Attachment pink is the brand's own `a` colour. */
const TONES: Record<UnreadTone, { fill: string; ink: string }> = {
  mention: {
    fill: "var(--md-sys-color-error)",
    ink: "var(--md-sys-color-on-error)",
  },
  attachment: { fill: "#C05FC8", ink: "#FFFFFF" },
  unread: { fill: "#FF8A00", ink: "#3A1F00" },
};

export type Props = {
  /**
   * Number of unread messages. Zero means "unknown" (an un-upgraded server, or
   * a channel read past on another device) and falls back to a plain dot.
   */
  count: number;

  /**
   * Whether there is anything unread at all
   */
  unread: boolean;

  /**
   * Which signal to colour for
   * @default unread
   */
  tone?: UnreadTone;
};

/**
 * The badge is a stadium anchored to the avatar's top-right corner, growing
 * leftwards as digits are added. Coordinates are in the avatar's 32x32 viewBox.
 */
type Geometry = { x: number; width: number; fontSize: number; mask: string };

const DOT: Geometry = {
  x: 22,
  width: 10,
  fontSize: 8,
  mask: "top-right",
};

/**
 * Box for a given label — each widening step has a matching holepunch mask so
 * the avatar is cut away behind the whole badge, not just behind a dot.
 */
function geometry(label: string): Geometry {
  if (label.length <= 1) return DOT;
  if (label.length === 2)
    return { x: 18, width: 14, fontSize: 8, mask: "top-right-wide" };
  return { x: 13, width: 19, fontSize: 7, mask: "top-right-wider" };
}

/**
 * The number to render, or an empty string when there is nothing countable.
 * The server stops counting at 100, and live increments saturate there too, so
 * the cap always reads as "99+".
 */
export function unreadLabel(count: number): string {
  if (count <= 0) return "";
  return count >= 100 ? "99+" : String(count);
}

/**
 * Holepunch to pass to the `Avatar` this badge overlays. Avatars that show no
 * badge get `"none"` so nothing is cut out of them.
 */
export function unreadHolepunch(
  count: number,
  unread: boolean,
): "none" | "top-right" | "top-right-wide" | "top-right-wider" {
  if (!unread) return "none";
  return geometry(unreadLabel(count)).mask as ReturnType<
    typeof unreadHolepunch
  >;
}

/**
 * Pick the tone for an unread tail. Mentions outrank attachments, which
 * outrank plain unread messages.
 */
export function unreadTone(mentions: number, attachments: boolean): UnreadTone {
  if (mentions > 0) return "mention";
  if (attachments) return "attachment";
  return "unread";
}

/**
 * Styles for the counter
 */
const UnreadCounter = styled("div", {
  base: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",

    fontWeight: 700,
    lineHeight: 1,
    fontVariantNumeric: "tabular-nums",
  },
});

/**
 * Unreads count SVG graphic
 */
function UnreadsGraphic(props: Props) {
  const tone = () => TONES[props.tone ?? "unread"];
  const label = () => unreadLabel(props.count);
  const box = () => geometry(label());

  return (
    <Switch>
      <Match when={label()}>
        <rect
          x={box().x}
          y="0"
          width={box().width}
          height="10"
          rx="5"
          fill={tone().fill}
        />
        <foreignObject
          x={box().x}
          y="0"
          width={box().width}
          height="10"
          // Keep the glyphs off the rounded ends on the widest badge
          style={{ overflow: "visible" }}
        >
          <UnreadCounter
            style={{ "font-size": `${box().fontSize}px`, color: tone().ink }}
          >
            {label()}
          </UnreadCounter>
        </foreignObject>
      </Match>
      <Match when={props.unread}>
        <circle cx="27" cy="5" r="5" fill={tone().fill} />
      </Match>
    </Switch>
  );
}

/**
 * Standalone unreads count element
 */
export function Unreads(props: Props & { size: string }) {
  const box = () => geometry(unreadLabel(props.count));

  return (
    <svg
      viewBox={`${box().x} 0 ${box().width} 10`}
      // Sized through CSS rather than the width/height attributes: the badge
      // widens with its digits, and `calc()` is not reliable in an SVG
      // presentation attribute
      style={{
        height: props.size,
        width: `calc(${props.size} * ${box().width / 10})`,
      }}
    >
      <UnreadsGraphic {...props} />
    </svg>
  );
}

Unreads.Graphic = UnreadsGraphic;
