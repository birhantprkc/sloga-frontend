import { JSXElement, Show, Suspense } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { Button, Checkbox, CircularProgress, Text, iconSize } from "@revolt/ui";

import MdWarning from "@material-design-icons/svg/round/warning.svg?component-solid";

/**
 * Age gate filter for any content
 *
 * Entirely local: a one-time 18+ attestation plus a per-channel consent, both
 * kept in layout state. There is deliberately no region lookup. The upstream
 * client asked a third-party geolocation service on every mature-channel view,
 * which handed the viewer's IP to a server we do not operate — at odds with the
 * no-IP-logs posture — and in the shells whose CSP does not allow that origin
 * the request was refused, so the channel was gated permanently. A region
 * check that only works with a third party in the loop is not one we want; if
 * a jurisdiction ever needs one it belongs on our own API.
 */
export function AgeGate(props: {
  enabled: boolean;
  contentId: string;
  contentName: string;
  contentType: "channel";
  children: JSXElement;
}) {
  const state = useState();

  const confirmed = () =>
    state.layout.getSectionState(LAYOUT_SECTIONS.MATURE, false);
  const allowed = () =>
    state.layout.getSectionState(props.contentId + "-nsfw", false);

  return (
    // Suspense boundary for the channel views underneath, kept here so their
    // loading state does not change with the gate.
    <Suspense fallback={<CircularProgress />}>
      <Show
        when={props.enabled && (!confirmed() || !allowed())}
        fallback={props.children}
      >
        <Base>
          <MdWarning {...iconSize("8em")} />
          <Text class="headline" size="large">
            {props.contentName}
          </Text>

          <Text class="body" size="large">
            <Trans>This channel is marked as mature.</Trans>
          </Text>

          <Confirmation>
            <Checkbox
              checked={state.layout.getSectionState(
                LAYOUT_SECTIONS.MATURE,
                false,
              )}
              onChange={() =>
                state.layout.toggleSectionState(LAYOUT_SECTIONS.MATURE, false)
              }
            />
            <Text class="body" size="large">
              <Trans>I confirm that I am at least 18 years old.</Trans>
            </Text>
          </Confirmation>

          <Actions>
            <Button variant="text" onPress={() => history.back()}>
              <Trans>Back</Trans>
            </Button>
            <Button
              variant="filled"
              onPress={() =>
                confirmed() &&
                state.layout.setSectionState(props.contentId + "-nsfw", true)
              }
            >
              <Trans>Enter Channel</Trans>
            </Button>
          </Actions>
        </Base>
      </Show>
    </Suspense>
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

    "& svg": {
      // TODO
      fill: "orange",
    },

    gap: "var(--gap-md)",
  },
});

const Confirmation = styled("label", {
  base: {
    display: "flex",
    gap: "var(--gap-sm)",
    alignItems: "center",
  },
});

const Actions = styled("div", {
  base: {
    display: "flex",
    marginTop: "var(--gap-lg)",
    gap: "var(--gap-lg)",
  },
});
