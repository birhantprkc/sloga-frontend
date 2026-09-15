import { Show } from "solid-js";

import { useLingui } from "@lingui-solid/solid/macro";

import { useClient } from "@revolt/client";
import { useState } from "@revolt/state";

import { Symbol } from "../../utils/Symbol";
import { participantUserId } from "./participantIdentity";

/**
 * Component that shows user voice status icons populated with client state
 */
export function VoiceStatefulUserIcons(props: {
  /** Bare user id, or a device-qualified participant identity — both accepted */
  userId: string;
  muted?: boolean;
  deafened?: boolean;
  camera?: boolean;
  screenshare?: boolean;
  /** In the channel's watch party (a self-reported roster hint — absence
   * means "hasn't said", older clients never claim it). */
  watching?: boolean;
  /**
   * Server that owns the channel being rendered, when there is one.
   *
   * Passed in rather than read off the call the viewer happens to be in:
   * this row also renders in the sidebar for channels the viewer is NOT in,
   * and a member of two servers would have been badged with the wrong
   * server's mute. Absent for a DM or group call, which have no server mute.
   */
  serverId?: string;
}) {
  const { t } = useLingui();
  const state = useState();
  const client = useClient();

  const isMuted = () =>
    state.voice.getUserMuted(participantUserId(props.userId))
      ? "by-user"
      : props.muted || false;

  /**
   * This participant as a member of the channel's server, when there is one.
   */
  const member = () => {
    if (!props.serverId) return undefined;

    return client().serverMembers.getByKey({
      server: props.serverId,
      user: participantUserId(props.userId),
    });
  };

  // A server mute is enforced at the SFU, so without a badge the muted person
  // sees a live-looking mic that transmits nothing, and everyone else sees
  // silence with no reason for it.
  const isServerMuted = () => !!member()?.serverMuted;
  const isServerDeafened = () => !!member()?.serverDeafened;

  return (
    <>
      <Show when={isServerMuted()}>
        <Symbol
          size={16}
          color="var(--md-sys-color-error)"
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Muted by a moderator. They cannot speak in this server.`,
            },
          }}
        >
          voice_over_off
        </Symbol>
      </Show>
      <Show when={isMuted() && !isServerMuted()}>
        <Symbol
          size={16}
          color={
            isMuted() === "by-user" ? "var(--md-sys-color-error)" : undefined
          }
          use:floating={{
            tooltip:
              isMuted() === "by-user"
                ? {
                    placement: "top",
                    content: t`You muted this user.`,
                  }
                : undefined,
          }}
        >
          mic_off
        </Symbol>
      </Show>
      <Show when={isServerDeafened()}>
        <Symbol
          size={16}
          color="var(--md-sys-color-error)"
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Deafened by a moderator. They cannot hear this call.`,
            },
          }}
        >
          headset_off
        </Symbol>
      </Show>
      <Show when={props.deafened && !isServerDeafened()}>
        <Symbol size={16}>headset_off</Symbol>
      </Show>
      <Show when={props.camera}>
        <Symbol size={16}>camera_video</Symbol>
      </Show>
      <Show when={props.screenshare}>
        <Symbol size={16}>screen_share</Symbol>
      </Show>
      <Show when={props.watching}>
        <Symbol
          size={16}
          use:floating={{
            tooltip: {
              placement: "top",
              content: t`Watching together`,
            },
          }}
        >
          movie
        </Symbol>
      </Show>
    </>
  );
}
