import { Match, Show, Switch } from "solid-js";
import {
  TrackLoop,
  TrackReference,
  VideoTrack,
  isTrackReference,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useMaybeTrackRefContext,
  useTrackRefContext,
  useTracks,
} from "solid-livekit-components";

import { Trans } from "@lingui-solid/solid/macro";
import { useLingui } from "@lingui-solid/solid/macro";
import { Track } from "livekit-client";
import { cva } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { UserContextMenu } from "@revolt/app";
import { useUser } from "@revolt/markdown/users";
import { InRoom, useVoice } from "@revolt/rtc";
import { Avatar, Button, IconButton } from "@revolt/ui/components/design";
import { OverflowingText } from "@revolt/ui/components/utils";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

import { VoiceStatefulUserIcons } from "../VoiceStatefulUserIcons";

/**
 * Call card (active)
 */
export function VoiceCallCardActiveRoom() {
  const voice = useVoice();
  const { t } = useLingui();

  return (
    <View>
      <Call>
        <InRoom>
          <Participants />
        </InRoom>
      </Call>
      <Status status={voice.state()}>
        <Switch>
          <Match when={voice.state() === "CONNECTED"}>
            <Symbol>wifi_tethering</Symbol> <Trans>Connected</Trans>
          </Match>
          <Match when={voice.state() === "CONNECTING"}>
            <Symbol>wifi_tethering</Symbol> <Trans>Connecting</Trans>
          </Match>
          <Match when={voice.state() === "DISCONNECTED"}>
            <Symbol>wifi_tethering_error</Symbol> <Trans>Disconnected</Trans>
          </Match>
          <Match when={voice.state() === "RECONNECTING"}>
            <Symbol>wifi_tethering</Symbol> <Trans>Reconnecting</Trans>
          </Match>
        </Switch>
      </Status>
      <Actions>
        <IconButton
          variant={voice.microphone() ? "filled" : "tonal"}
          onPress={() => voice.toggleMute()}
          use:floating={{
            tooltip: voice.speakingPermission
              ? undefined
              : {
                  placement: "top",
                  content: t`Missing permission`,
                },
          }}
          isDisabled={!voice.speakingPermission}
        >
          <Show when={voice.microphone()} fallback={<Symbol>mic_off</Symbol>}>
            <Symbol>mic</Symbol>
          </Show>
        </IconButton>
        <IconButton
          variant={
            voice.deafen() || !voice.listenPermission ? "tonal" : "filled"
          }
          onPress={() => voice.toggleDeafen()}
          use:floating={{
            tooltip: voice.listenPermission
              ? undefined
              : {
                  placement: "top",
                  content: t`Missing permission`,
                },
          }}
          isDisabled={!voice.listenPermission}
        >
          <Show
            when={voice.deafen() || !voice.listenPermission}
            fallback={<Symbol>headset</Symbol>}
          >
            <Symbol>headset_off</Symbol>
          </Show>
        </IconButton>
        <IconButton
          variant={"tonal"}
          use:floating={{
            tooltip: {
              placement: "top",
              content: "Coming soon! 👀",
            },
          }}
          isDisabled
        >
          <Symbol>camera_video</Symbol>
        </IconButton>
        <IconButton
          variant={"tonal"}
          use:floating={{
            tooltip: {
              placement: "top",
              content: "Coming soon! 👀",
            },
          }}
          isDisabled
        >
          <Symbol>screen_share</Symbol>
        </IconButton>
        <Button variant="_error" onPress={() => voice.disconnect()}>
          <Symbol>call_end</Symbol>
        </Button>
      </Actions>
    </View>
  );
}

const View = styled("div", {
  base: {
    minHeight: 0,
    height: "100%",
    width: "100%",

    display: "flex",
    flexDirection: "column",
  },
});

const Status = styled("div", {
  base: {
    flexShrink: 0,
    gap: "var(--gap-md)",

    display: "flex",
    justifyContent: "center",
  },
  variants: {
    status: {
      READY: {},
      CONNECTED: {
        color: "var(--md-sys-color-primary)",
      },
      CONNECTING: {
        color: "var(--md-sys-color-outline)",
      },
      DISCONNECTED: {
        color: "var(--md-sys-color-outline)",
      },
      RECONNECTING: {
        color: "var(--md-sys-color-outline)",
      },
    },
  },
});

const Actions = styled("div", {
  base: {
    flexShrink: 0,
    gap: "var(--gap-md)",
    margin: "var(--gap-md)",
    padding: "var(--gap-md)",

    display: "flex",
    width: "fit-content",
    justifyContent: "center",
    alignSelf: "center",

    borderRadius: "var(--borderRadius-full)",
    background: "var(--md-sys-color-surface-container)",
  },
});

const Call = styled("div", {
  base: {
    flexGrow: 1,
    minHeight: 0,
    overflowY: "scroll",
  },
});

/**
 * Show a grid of participants
 */
function Participants() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  return (
    <Grid>
      <TrackLoop tracks={tracks}>{() => <ParticipantTile />}</TrackLoop>
    </Grid>
  );
}

const Grid = styled("div", {
  base: {
    display: "grid",
    gap: "var(--gap-md)",
    padding: "var(--gap-md)",
    gridTemplateColumns: "repeat(2, 1fr)",
  },
});

/**
 * Individual participant tile
 */
function ParticipantTile() {
  const track = useTrackRefContext();

  return (
    <Switch fallback={<UserTile />}>
      <Match when={track.source === Track.Source.ScreenShare}>
        <ScreenshareTile />
      </Match>
    </Switch>
  );
}

/**
 * Shown when the track source is a camera or placeholder
 */
function UserTile() {
  const participant = useEnsureParticipant();
  const track = useMaybeTrackRefContext();

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });

  const isSpeaking = useIsSpeaking(participant);

  const user = useUser(participant.identity);

  return (
    <div
      class={tile({
        speaking: isSpeaking(),
      })}
      use:floating={{
        userCard: {
          user: user().user!,
          member: user().member,
        },
        contextMenu: () => (
          <UserContextMenu user={user().user!} member={user().member} inVoice />
        ),
      }}
    >
      <Switch
        fallback={
          <AvatarOnly>
            <Avatar
              src={user().avatar}
              fallback={user().username}
              size={48}
              interactive={false}
            />
          </AvatarOnly>
        }
      >
        <Match when={isTrackReference(track)}>
          <VideoTrack
            style={{ "grid-area": "1/1" }}
            trackRef={track as TrackReference}
            manageSubscription={true}
          />
        </Match>
      </Switch>

      <Overlay>
        <OverlayInner>
          <OverflowingText>{user().username}</OverflowingText>
          <VoiceStatefulUserIcons
            userId={participant.identity}
            muted={isMuted()}
          />
        </OverlayInner>
      </Overlay>
    </div>
  );
}

const AvatarOnly = styled("div", {
  base: {
    gridArea: "1/1",
    display: "grid",
    placeItems: "center",
  },
});

/**
 * Shown when the track source is a screenshare
 */
function ScreenshareTile() {
  const participant = useEnsureParticipant();
  const track = useMaybeTrackRefContext();
  const user = useUser(participant.identity);

  const isMuted = useIsMuted({
    participant,
    source: Track.Source.ScreenShareAudio,
  });

  return (
    <div class={tile() + " group"}>
      <VideoTrack
        style={{ "grid-area": "1/1" }}
        trackRef={track as TrackReference}
        manageSubscription={true}
      />

      <Overlay showOnHover>
        <OverlayInner>
          <OverflowingText>{user().username}</OverflowingText>
          <Show when={isMuted()}>
            <Symbol size={18}>no_sound</Symbol>
          </Show>
        </OverlayInner>
      </Overlay>
    </div>
  );
}

const tile = cva({
  base: {
    display: "grid",
    aspectRatio: "16/9",
    transition: ".3s ease all",
    borderRadius: "var(--borderRadius-lg)",

    color: "var(--md-sys-color-on-surface)",
    background: "#0002",

    overflow: "hidden",
    outlineWidth: "3px",
    outlineStyle: "solid",
    outlineOffset: "-3px",
    outlineColor: "transparent",
  },
  variants: {
    speaking: {
      true: {
        outlineColor: "var(--md-sys-color-primary)",
      },
    },
  },
});

const Overlay = styled("div", {
  base: {
    minWidth: 0,
    gridArea: "1/1",

    padding: "var(--gap-md) var(--gap-lg)",

    opacity: 1,
    display: "flex",
    alignItems: "end",
    flexDirection: "row",

    transition: "var(--transitions-fast) all",
    transitionTimingFunction: "ease",
  },
  variants: {
    showOnHover: {
      true: {
        opacity: 0,

        _groupHover: {
          opacity: 1,
        },
      },
      false: {
        opacity: 1,
      },
    },
  },
  defaultVariants: {
    showOnHover: false,
  },
});

const OverlayInner = styled("div", {
  base: {
    minWidth: 0,

    display: "flex",
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",

    _first: {
      flexGrow: 1,
    },
  },
});
