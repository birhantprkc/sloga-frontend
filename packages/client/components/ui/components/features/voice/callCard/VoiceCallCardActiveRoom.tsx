import { Match, Show, Switch } from "solid-js";
import {
  TrackLoop,
  useEnsureParticipant,
  useIsMuted,
  useIsSpeaking,
  useTrackRefContext,
  useTracks,
} from "solid-livekit-components";

import { Trans } from "@lingui-solid/solid/macro";
import { useLingui } from "@lingui-solid/solid/macro";
import { Track } from "livekit-client";
import { css } from "styled-system/css";
import { styled } from "styled-system/jsx";

import { useUser } from "@revolt/markdown/users";
import { InRoom, useVoice } from "@revolt/rtc";
import { Button, IconButton } from "@revolt/ui/components/design";
import { Tooltip } from "@revolt/ui/components/floating";
import { Symbol } from "@revolt/ui/components/utils/Symbol";

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
        <Button variant="_error" onPress={() => voice.disconnect()}>
          <Symbol>call_end</Symbol>
        </Button>
      </Actions>
    </View>
  );
}

function Participants() {
  const tracks = useTracks(
    [
      { source: Track.Source.Camera, withPlaceholder: true },
      { source: Track.Source.ScreenShare, withPlaceholder: false },
    ],
    { onlySubscribed: false },
  );

  return <TrackLoop tracks={tracks}>{() => <Temp />}</TrackLoop>;
}

function Temp() {
  const participant = useEnsureParticipant();
  const track = useTrackRefContext();
  const isMuted = useIsMuted({
    participant,
    source: Track.Source.Microphone,
  });
  const isSpeaking = useIsSpeaking(participant);

  const user = useUser(participant.identity);

  return (
    <div
      class={css({
        padding: "4px",
        color: "var(--md-sys-color-on-surface)",
      })}
    >
      {user().username} <Show when={isMuted()}>muted</Show>{" "}
      <Show when={isSpeaking()}>speaking</Show>
    </div>
  );
}

const View = styled("div", {
  base: {
    height: "100%",
    width: "100%",

    display: "flex",
    flexDirection: "column",
  },
});

const Call = styled("div", {
  base: {
    flexGrow: 1,
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
