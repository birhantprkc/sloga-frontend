import { JSXElement, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { Button, Text, iconSize } from "@revolt/ui";

import MdVisibilityOff from "@material-design-icons/svg/round/visibility_off.svg?component-solid";

/**
 * Click-to-reveal gate for spoiler channels. Wraps channel content and asks
 * the member to reveal it once; the choice is remembered per device, same as
 * the mature-channel confirmation.
 */
export function SpoilerGate(props: {
  enabled: boolean;
  channelId: string;
  channelName: string;
  children: JSXElement;
}) {
  const state = useState();
  const storageKey = () => `${props.channelId}-spoiler`;
  const revealed = () => state.layout.getSectionState(storageKey(), false);

  return (
    <Show when={props.enabled && !revealed()} fallback={props.children}>
      <Base>
        <MdVisibilityOff
          {...iconSize("5em")}
          style={{ fill: "var(--md-sys-color-on-surface-variant)" }}
        />
        <Text class="headline" size="large">
          {props.channelName}
        </Text>
        <Text class="body" size="large">
          <Trans>This channel may contain spoilers.</Trans>
        </Text>
        <Actions>
          <Button variant="text" onPress={() => history.back()}>
            <Trans>Back</Trans>
          </Button>
          <Button
            variant="filled"
            onPress={() => state.layout.setSectionState(storageKey(), true)}
          >
            <Trans>Reveal Channel</Trans>
          </Button>
        </Actions>
      </Base>
    </Show>
  );
}

const Base = styled("div", {
  base: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    padding: "var(--gap-lg)",
    userSelect: "none",
    overflowY: "auto",
    color: "var(--md-sys-color-on-surface)",
    gap: "var(--gap-md)",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    marginTop: "var(--gap-lg)",
    gap: "var(--gap-lg)",
  },
});
