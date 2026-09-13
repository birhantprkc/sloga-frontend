import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { ServerMember, User } from "stoat.js";
import { styled } from "styled-system/jsx";

import { timeLocale, useTime } from "@revolt/i18n";

import { Text } from "../../design";
import { OverflowingText } from "../../utils";

import { ProfileCard } from "./ProfileCard";

export function ProfileJoined(props: { user: User; member?: ServerMember }) {
  const dayjs = useTime();

  return (
    <ProfileCard>
      <Text class="title" size="large">
        <Trans>Joined</Trans>
      </Text>
      <Rows>
        <Text class="label">
          <OverflowingText>Sloga</OverflowingText>
          {/* <Trans>Account Created</Trans> */}
        </Text>
        <Text>
          {dayjs(props.user.createdAt).format(
            timeLocale()[1]
              .formats.L?.replace("MM", "MMM")
              .replaceAll("/", " ")
              .replaceAll("-", " "),
          )}
        </Text>
        <Show when={props.member}>
          <Text class="label">
            <OverflowingText>{props.member!.server!.name}</OverflowingText>
            {/* <Trans>Member Since</Trans> */}
          </Text>
          <Text>
            {dayjs(props.member!.joinedAt).format(
              timeLocale()[1]
                .formats.L?.replace("MM", "MMM")
                .replaceAll("/", " ")
                .replaceAll("-", " "),
            )}
          </Text>
        </Show>
      </Rows>
    </ProfileCard>
  );
}

/**
 * The rows under the "Joined" title, as their own shrinkable column.
 *
 * This tile takes ProfileCard's default `width: 1` variant, which is a hard
 * square (`overflow: hidden` + `aspect-ratio: 1/1`). Viewed inside a server
 * the column is five rows tall (title, "Sloga", account date, server name,
 * join date) — about 116px — while the tile is only ~116px *square*, leaving
 * ~86px of content box on a 412px phone. The square used to shear the last
 * row with no signal at all.
 *
 * Clamping the individual rows would do nothing: every one of them is already
 * a single line. It is the column that overflows, so the column is what has to
 * give. It shrinks inside the square and scrolls, and its bottom edge fades so
 * the truncation is visible — Android paints no persistent scrollbar for an
 * overlay scroll box, so a bare scroll box would read as a clip, which is the
 * symptom being fixed.
 *
 * The trailing padding is what keeps the fade honest: when the column fits,
 * the faded strip is that padding rather than real text, so nothing appears
 * faded; when it overflows, the strip lands on content; and at the end of the
 * scroll the last row clears the strip and is fully legible.
 *
 * The scrollbar itself is hidden — the same pair of rules the
 * `invisibleScrollable` directive applies. A classic (non-overlay) scrollbar
 * on desktop Chrome/Firefox would eat ~15px out of a tile that is only ~116px
 * wide on a phone and ~170px on desktop, reflowing every row inside a box that
 * is a hard square. The mask fade is the truncation signal on every platform,
 * so the bar is redundant where it is drawn and harmful where it is inline.
 * These are written out rather than applied via `use:invisibleScrollable`
 * because Solid only compiles `use:` on a native element — it silently does
 * nothing on a `styled()` component.
 */
const Rows = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    // matches ProfileCard's own gap, so row spacing is unchanged
    gap: "var(--gap-sm)",

    flex: "1",
    minHeight: 0,
    overflowY: "auto",
    overscrollBehavior: "contain",

    scrollbarWidth: "none",
    "&::-webkit-scrollbar": {
      display: "none",
    },

    paddingBottom: "16px",
    WebkitMaskImage:
      "linear-gradient(to bottom, black calc(100% - 16px), transparent)",
    maskImage:
      "linear-gradient(to bottom, black calc(100% - 16px), transparent)",
  },
});
