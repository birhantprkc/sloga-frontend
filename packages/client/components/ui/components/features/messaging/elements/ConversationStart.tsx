import { Match, Show, Switch } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { Channel } from "stoat.js";
import { styled } from "styled-system/jsx";

import { Text } from "../../../design";
import { DisplayName } from "../../DisplayName";
import { isSlogaStaff } from "../../legacy/Username";

interface Props {
  /**
   * Channel information
   */
  channel: Channel;
}

/**
 * Mark the beginning of a conversation
 */
export function ConversationStart(props: Props) {
  return (
    <Base>
      <Show when={props.channel.type !== "SavedMessages"}>
        <Text class="headline" size="large">
          <Show when={props.channel.recipient} fallback={props.channel.name}>
            {(recipient) => (
              <DisplayName
                user={recipient()}
                name={props.channel.name ?? recipient().username}
                brand={isSlogaStaff(recipient())}
              />
            )}
          </Show>
        </Text>
      </Show>
      <Text class="title">
        <Switch
          fallback={<Trans>This is the start of your conversation.</Trans>}
        >
          <Match when={props.channel.type === "SavedMessages"}>
            <Trans>This is the start of your notes.</Trans>
          </Match>
        </Switch>
      </Text>
    </Base>
  );
}

/**
 * Base styles
 */
const Base = styled("div", {
  base: {
    display: "flex",
    userSelect: "none",
    flexDirection: "column",
    margin: "18px 16px 10px 16px",

    color: "var(--md-sys-color-on-surface)",
  },
});
