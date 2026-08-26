import { For, Show, createSignal } from "solid-js";

import { Trans, useLingui } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Tooltip } from "@revolt/ui";

import { Text, typography } from "../../design";

import { ProfileCard } from "./ProfileCard";

/**
 * Display names for game-account link platforms. Brand names — deliberately
 * not translated.
 */
export const LINK_PLATFORM_NAMES: Record<string, string> = {
  Steam: "Steam",
  EpicGames: "Epic Games",
  Rockstar: "Rockstar",
  UbisoftConnect: "Ubisoft Connect",
  Activision: "Activision",
  BattleNet: "Battle.net",
  Xbox: "Xbox",
  PlayStation: "PlayStation",
  Nintendo: "Nintendo",
  RiotGames: "Riot ID",
  EaApp: "EA",
  Gog: "GOG",
  GrindingGearGames: "GGG",
};

/**
 * Self-declared game-account handles. Display-only, click-to-copy — most of
 * these platforms have no canonical public profile URL (Activision IDs,
 * friend codes), so no row links anywhere.
 */
export function ProfileGameIds(props: {
  links?: { platform: string; handle: string }[];
}) {
  const { t } = useLingui();
  const [copiedIndex, setCopiedIndex] = createSignal<number | null>(null);

  function copy(handle: string, index: number) {
    navigator.clipboard.writeText(handle);
    setCopiedIndex(index);
    setTimeout(() => setCopiedIndex(null), 2000);
  }

  return (
    <Show when={props.links?.length}>
      <ProfileCard width={2}>
        <Text class="title" size="large">
          <Trans>Game IDs</Trans>
        </Text>
        <Rows>
          <For each={props.links}>
            {(link, index) => (
              <Tooltip
                content={
                  copiedIndex() === index() ? t`Copied!` : t`Click to copy`
                }
                placement="top"
              >
                <RowButton onClick={() => copy(link.handle, index())}>
                  <Platform>
                    {LINK_PLATFORM_NAMES[link.platform] ?? link.platform}
                  </Platform>
                  <Handle>{link.handle}</Handle>
                </RowButton>
              </Tooltip>
            )}
          </For>
        </Rows>
      </ProfileCard>
    </Show>
  );
}

const Rows = styled("div", {
  base: {
    display: "flex",
    flexWrap: "wrap",
    gap: "var(--gap-sm)",
  },
});

const RowButton = styled("button", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-sm)",
    minWidth: 0,

    cursor: "pointer",
    padding: "var(--gap-xs) var(--gap-md)",
    borderRadius: "var(--borderRadius-md)",
    background: "var(--md-sys-color-surface-container-high)",

    "&:hover": {
      background: "var(--md-sys-color-surface-container-highest)",
    },
  },
});

const Platform = styled("span", {
  base: {
    ...typography.raw({ class: "label", size: "small" }),
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Handle = styled("span", {
  base: {
    ...typography.raw({ class: "label" }),
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    minWidth: 0,
  },
});
