import { Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { Markdown } from "@revolt/markdown";

import { Ripple, Text, typography } from "../../design";

import { ProfileCard } from "./ProfileCard";

interface Props {
  full?: boolean;
  content?: string;
  /** The profile could not be fetched because the user limits it to friends */
  isPrivate?: boolean;
  onClick?: () => void;
}

/**
 * Whether a profile fetch failed because the user limits their profile to
 * friends (checked on both error shapes the API client produces)
 */
export function isProfilePrivateError(error: unknown): boolean {
  const err = error as {
    type?: string;
    response?: { data?: { type?: string } };
  } | null;
  return (
    err?.type === "ProfileIsPrivate" ||
    err?.response?.data?.type === "ProfileIsPrivate"
  );
}

/**
 * Profile biography
 */
export function ProfileBio(props: Props) {
  return (
    <Show when={props.content || props.isPrivate}>
      <ProfileCard
        onClick={props.onClick}
        isLink={typeof props.onClick !== "undefined"}
        width={props.full ? 3 : 2}
        constraint={props.full ? undefined : "half"}
      >
        <Show when={props.onClick}>
          <Ripple />
        </Show>

        <Show
          when={!props.isPrivate}
          fallback={
            <PrivateNotice>
              <Trans>This profile is private.</Trans>
            </PrivateNotice>
          }
        >
          <Text class="title" size="large">
            Bio
          </Text>

          <Bio>
            <Markdown content={props.content} />
          </Bio>
        </Show>
      </ProfileCard>
    </Show>
  );
}

const PrivateNotice = styled("span", {
  base: {
    ...typography.raw({ class: "_messages" }),
    fontStyle: "italic",
    color: "var(--md-sys-color-on-surface-variant)",
  },
});

const Bio = styled("span", {
  base: {
    ...typography.raw({ class: "_messages" }),
    userSelect: "text",
  },
});
