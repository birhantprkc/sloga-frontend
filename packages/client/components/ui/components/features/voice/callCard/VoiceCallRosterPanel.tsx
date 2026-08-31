import { For, Show } from "solid-js";

import { Trans } from "@lingui-solid/solid/macro";
import { styled } from "styled-system/jsx";

import { useUser, useUsers } from "@revolt/markdown/users";
import { useModals } from "@revolt/modal";
import { useVoice } from "@revolt/rtc";
import { Avatar, Text } from "@revolt/ui/components/design";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { participantUserId } from "../participantIdentity";

/**
 * The §4.4 call roster / verification panel (slice 6.5). Rendered from the
 * VERIFIED MLS ROSTER (crypto truth) — NOT the LiveKit tracks — so a trackless
 * MLS leaf is visible and a divergent ghost / non-enrolled SFU identity is
 * flagged. Each member links to the slice-5 safety-number screen (§1.3: the
 * number shown IS the slice-5 number). Opened by clicking the encryption chip.
 */
export function VoiceCallRosterPanel() {
  const voice = useVoice();
  const { openModal } = useModals();

  const members = () => voice.callRoster().members;
  const ghosts = () => voice.callRoster().ghosts;
  const nonEnrolled = () => voice.callNonEnrolled();

  const memberIds = () => members().map((m) => m.user_id);
  const memberUsers = useUsers(memberIds);
  const nonEnrolledIds = () =>
    nonEnrolled().map((identity) => participantUserId(identity));
  const nonEnrolledUsers = useUsers(nonEnrolledIds);

  /**
   * Active control sessions in THIS call's channel, from the channel-wide
   * redacted `RemoteControlActive`/`Ended` map (pass-the-controller slice 0,
   * §2.2) — sessions we are not a party to included; that is the
   * third-party/moderator visibility this panel exists to give.
   */
  const controlSessions = () => {
    const channelId = voice.channel()?.id;
    if (!channelId) return [];
    const sessions = voice.remoteControlSessions().get(channelId);
    if (!sessions) return [];
    return [...sessions].map(([sharerId, controllerId]) => ({
      sharerId,
      controllerId,
    }));
  };

  return (
    <Show when={voice.callRosterPanelOpen()}>
      <Panel>
        <Header>
          <Text class="title">
            <Trans>Call encryption</Trans>
          </Text>
          <CloseButton
            title="Close"
            onClick={() => voice.toggleCallRosterPanel()}
          >
            <Symbol size={18}>close</Symbol>
          </CloseButton>
        </Header>

        <List>
          <For each={members()}>
            {(member, i) => (
              <Row
                onClick={() =>
                  openModal({
                    type: "e2ee_verify",
                    peerUserId: member.user_id,
                    context: "call",
                  })
                }
              >
                <Avatar
                  size={28}
                  src={memberUsers()[i()]?.avatar}
                  fallback={memberUsers()[i()]?.username ?? member.user_id}
                />
                <RowText>
                  <Text class="body">
                    {memberUsers()[i()]?.username ?? member.user_id}
                  </Text>
                  <Show
                    when={ghosts().includes(
                      `${member.user_id}:${member.device_id}`,
                    )}
                  >
                    <Flag divergent>
                      <Trans>no media — divergent leaf</Trans>
                    </Flag>
                  </Show>
                </RowText>
                <Symbol
                  size={18}
                  color={
                    member.user_verified
                      ? "var(--md-sys-color-primary)"
                      : "var(--md-sys-color-outline)"
                  }
                >
                  {member.user_verified ? "verified_user" : "shield"}
                </Symbol>
              </Row>
            )}
          </For>

          <For each={nonEnrolled()}>
            {(_identity, i) => (
              <Row inert>
                <Avatar
                  size={28}
                  src={nonEnrolledUsers()[i()]?.avatar}
                  fallback={nonEnrolledUsers()[i()]?.username ?? "?"}
                />
                <RowText>
                  <Text class="body">
                    {nonEnrolledUsers()[i()]?.username ?? "Unknown"}
                  </Text>
                  <Flag>
                    <Trans>not encrypted</Trans>
                  </Flag>
                </RowText>
                <Symbol size={18} color="var(--md-sys-color-error)">
                  no_encryption
                </Symbol>
              </Row>
            )}
          </For>
        </List>

        {/* Live remote-control sessions in this channel (slice 0), shown to
            every viewer of this panel, party to the session or not. Not part
            of the MLS roster above — the map is not crypto truth. Note the
            reach limit: this panel's only entry point today is the
            encryption chip, which does not mount on a chip-less plain call,
            so there the tile badge is the sole surface; a dedicated entry
            point is a later-slice question. */}
        <Show when={controlSessions().length > 0}>
          <Header>
            <Text class="title">
              <Trans>Remote control</Trans>
            </Text>
          </Header>
          <List>
            <For each={controlSessions()}>
              {(session) => (
                <ControlSessionRow
                  sharerId={session.sharerId}
                  controllerId={session.controllerId}
                />
              )}
            </For>
          </List>
        </Show>
      </Panel>
    </Show>
  );
}

/**
 * One active control session: "controller is controlling sharer's screen".
 * Both ends resolve through the user cache; ids we have never seen (a
 * moderator watching from the text channel) fall back to "Unknown User"
 * rather than hiding the row — the visibility is the point.
 */
function ControlSessionRow(props: { sharerId: string; controllerId: string }) {
  const sharer = useUser(() => props.sharerId);
  const controller = useUser(() => props.controllerId);

  return (
    <Row inert>
      <Avatar
        size={28}
        src={controller().avatar}
        fallback={controller().username}
      />
      <RowText>
        <Text class="body">
          <Trans>
            {controller().username} is controlling {sharer().username}'s screen
          </Trans>
        </Text>
      </RowText>
      <Symbol size={18} color="var(--md-sys-color-primary)">
        arrow_selector_tool
      </Symbol>
    </Row>
  );
}

const Panel = styled("div", {
  base: {
    position: "absolute",
    top: "var(--gap-lg)",
    right: "var(--gap-lg)",
    zIndex: 6,
    width: "min(280px, calc(100% - 2 * var(--gap-lg)))",
    maxHeight: "70%",
    overflowY: "auto",

    display: "flex",
    flexDirection: "column",
    gap: "var(--gap-sm)",

    padding: "var(--gap-md)",
    borderRadius: "var(--borderRadius-lg)",
    background: "var(--md-sys-color-surface-container-highest)",
    // Text color must be pinned WITH the surface: this panel mounts inside
    // the call card, where an ancestor sets `inverse-on-surface` for the
    // on-video chrome — inherited here, that painted the title and usernames
    // dark-on-dark (only the icons survived, they set explicit colors).
    color: "var(--md-sys-color-on-surface)",
    border: "1px solid var(--md-sys-color-outline-variant)",
    boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
  },
});

const Header = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
  },
});

const CloseButton = styled("button", {
  base: {
    border: "none",
    background: "transparent",
    cursor: "pointer",
    color: "var(--md-sys-color-on-surface-variant)",
    display: "flex",
  },
});

const List = styled("div", {
  base: {
    display: "flex",
    flexDirection: "column",
    gap: "2px",
  },
});

const Row = styled("div", {
  base: {
    display: "flex",
    alignItems: "center",
    gap: "var(--gap-md)",
    padding: "var(--gap-sm)",
    borderRadius: "var(--borderRadius-md)",
    cursor: "pointer",
    _hover: { background: "var(--md-sys-color-surface-container-high)" },
  },
  variants: {
    inert: {
      true: { cursor: "default", _hover: { background: "transparent" } },
    },
  },
});

const RowText = styled("div", {
  base: {
    flex: 1,
    minWidth: 0,
    display: "flex",
    flexDirection: "column",
  },
});

const Flag = styled("span", {
  base: {
    fontSize: "0.6875rem",
    color: "var(--md-sys-color-error)",
  },
  variants: {
    divergent: { true: { color: "var(--md-sys-color-on-surface-variant)" } },
  },
});
