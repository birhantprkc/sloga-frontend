import { JSXElement, Show, Suspense, createSignal } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useState } from "@revolt/state";
import { LAYOUT_SECTIONS } from "@revolt/state/stores/Layout";
import { Button, Checkbox, CircularProgress, Text, iconSize } from "@revolt/ui";

import MdWarning from "@material-design-icons/svg/round/warning.svg?component-solid";

/**
 * Age gate filter for any content
 *
 * Entirely local, and a single global attestation: one "I am at least 18"
 * confirmation covers every mature channel on this device. There used to be a
 * second, per-channel consent key alongside it, which meant an imported server
 * with 30+ mature channels prompted on every one of them; that key is gone.
 * Spoiler and password gates stay per-channel by design — an age attestation
 * is about the person, not the channel.
 *
 * There is deliberately no region lookup. The upstream client asked a
 * third-party geolocation service on every mature-channel view, which handed
 * the viewer's IP to a server we do not operate — at odds with the no-IP-logs
 * posture — and in the shells whose CSP does not allow that origin the request
 * was refused, so the channel was gated permanently. A region check that only
 * works with a third party in the loop is not one we want; if a jurisdiction
 * ever needs one it belongs on our own API.
 */
export function AgeGate(props: {
  enabled: boolean;
  contentName: string;
  children: JSXElement;
}) {
  const state = useState();

  const confirmed = () =>
    state.layout.getSectionState(LAYOUT_SECTIONS.MATURE, false);

  /**
   * Whether the box is ticked, held locally rather than in the store.
   *
   * The gate unmounts the instant the attestation is written, so binding the
   * checkbox straight to the store would leave "Enter Channel" unreachable and
   * would fire an irreversible, device-wide attestation on one stray tap.
   * Ticking arms the button; pressing it commits.
   */
  const [agreed, setAgreed] = createSignal(false);

  return (
    // Suspense boundary for the channel views underneath. Not dead
    // scaffolding: AgeGate mounts on *every* text channel, mature or not, and
    // this is the only boundary wrapping TextChannel in this subtree, so
    // removing it changes loading behaviour app-wide.
    <Suspense fallback={<CircularProgress />}>
      <Show when={props.enabled && !confirmed()} fallback={props.children}>
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
              checked={agreed()}
              onChange={(event) => setAgreed(event.currentTarget.checked)}
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
              isDisabled={!agreed()}
              onPress={() =>
                // setSectionState, not toggleSectionState: idempotent, and it
                // cannot accidentally un-attest.
                state.layout.setSectionState(LAYOUT_SECTIONS.MATURE, true)
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
