/**
 * Publishes the in-game overlay's state, and owns the overlay window's
 * lifetime.
 *
 * Mounted in `Interface.tsx`'s worker list, so it only ever runs in the main
 * window — popout windows bounce at `Interface.tsx` and the overlay window
 * never mounts `Interface` at all. That matters: this is the window that owns
 * the LiveKit `Room`, and `participant.isSpeaking` has no other source.
 *
 * Renders null.
 */
import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import {
  LocalParticipant,
  Participant,
  RemoteParticipant,
  RoomEvent,
  Track,
} from "livekit-client";

import { useClient } from "@revolt/client";
import { userInformation } from "@revolt/markdown/users";
import { useState } from "@revolt/state";
import { participantUserId } from "@revolt/ui/components/features/voice/participantIdentity";

import { readRttMs } from "../rtt";
import { useVoice } from "../state";

import { openOverlayBridge } from "./bridge";
import {
  OVERLAY_PROTOCOL_VERSION,
  OverlayConfig,
  OverlayDeviceState,
  OverlayParticipant,
  OverlayRosterEntry,
  collapseParticipants,
  overlayInCall,
} from "./protocol";
import { overlayShell, overlayShellAvailable } from "./shell";

/** At most one `state` per this many ms (trailing edge). */
const PUBLISH_THROTTLE_MS = 100;
/** Re-send the current snapshot this often even when nothing changed. */
const HEARTBEAT_MS = 3000;
/** How often to sample RTT, when the latency readout is on. */
const RTT_POLL_MS = 2000;

export function OverlayBridgeWorker() {
  const voice = useVoice();
  const state = useState();
  const client = useClient();

  // Both reads are genuinely reactive: `AbstractStore.get()` is a solid-store
  // read, so flipping the setting arms or disarms this worker live.
  const armed = () => overlayShellAvailable() && state.voice.overlayEnabled;

  const inCall = () => overlayInCall(voice.room(), voice.state());

  const config = (): OverlayConfig => ({
    opacity: state.voice.overlayOpacity,
    scale: state.voice.overlayScale,
    displayMode: state.voice.overlayDisplayMode,
    showLatency: state.voice.overlayShowLatency,
    corner: state.voice.overlayCorner,
  });

  /**
   * Bumped by LiveKit room events. `remoteParticipants` and `isSpeaking` are
   * plain mutable objects, not reactive sources, so the snapshot memo needs an
   * explicit dependency to re-run against.
   */
  const [liveVersion, setLiveVersion] = createSignal(0);
  const [rttMs, setRttMs] = createSignal<number | undefined>(undefined);
  const [seq, setSeq] = createSignal(0);

  /**
   * Roster comes from the CHANNEL, not the room: `channel.voiceParticipants`
   * is populated from the roster fetch, so it is already correct for someone
   * who joined before us, and it is a `ReactiveMap` so iterating it tracks.
   * (Same reason `recordersInCall()` reads it.) The room then contributes the
   * things only it knows — speaking and muted, per device.
   */
  const snapshot = createMemo<OverlayParticipant[]>(() => {
    liveVersion(); // reactive dependency on LiveKit-side churn

    const channel = voice.channel();
    if (!channel) return [];

    const currentClient = client();
    const selfId = currentClient?.user?.id;
    const serverId = channel.server?.id;

    const roster: OverlayRosterEntry[] = [];
    for (const participant of channel.voiceParticipants.values()) {
      const userId = participant.userId;
      const user = currentClient?.users.get(userId);
      const member = serverId
        ? currentClient?.serverMembers.getByKey({
            server: serverId,
            user: userId,
          })
        : undefined;
      // Member-aware resolution, evaluated MAIN-SIDE — the overlay window has
      // no client and cannot do any of this. Resolved against the VOICE
      // channel's server rather than the route's, so nicknames stay correct
      // while the user browses another server mid-call.
      const info = userInformation(user, member);
      roster.push({
        userId,
        name: info.username,
        // A finished URL string. Autumn URLs and `default_avatar` are plain
        // unauthenticated GETs, so a session-less <img src> renders them.
        avatarUrl: info.avatar ?? user?.defaultAvatarURL,
        self: userId === selfId,
      });
    }

    const room = voice.room();
    const devices: OverlayDeviceState[] = [];
    if (room) {
      const all: Participant[] = [
        room.localParticipant as LocalParticipant,
        ...(Array.from(
          room.remoteParticipants.values(),
        ) as RemoteParticipant[]),
      ];
      for (const participant of all) {
        const mic = participant.getTrackPublication(Track.Source.Microphone);
        devices.push({
          identity: participant.identity,
          speaking: participant.isSpeaking,
          // No mic publication at all reads as muted: they are not
          // transmitting, which is what the badge means to a viewer.
          muted: mic ? mic.isMuted : true,
        });
      }
    }

    return collapseParticipants(roster, devices, participantUserId);
  });

  createEffect(() => {
    if (!armed()) return;

    const bridge = openOverlayBridge();
    if (!bridge) return;
    const shell = overlayShell();

    let throttleTimer: ReturnType<typeof setTimeout> | undefined;
    let lastPublishAt = 0;

    function publishNow() {
      lastPublishAt = Date.now();
      setSeq((value) => value + 1);
      bridge!.publish({
        v: OVERLAY_PROTOCOL_VERSION,
        type: "state",
        seq: seq(),
        participants: snapshot(),
        rttMs: state.voice.overlayShowLatency ? rttMs() : undefined,
        config: config(),
      });
    }

    /** Trailing-edge throttle — speaking changes are the only fast source. */
    function publishThrottled() {
      const since = Date.now() - lastPublishAt;
      if (since >= PUBLISH_THROTTLE_MS) {
        publishNow();
        return;
      }
      if (throttleTimer) return;
      throttleTimer = setTimeout(() => {
        throttleTimer = undefined;
        publishNow();
      }, PUBLISH_THROTTLE_MS - since);
    }

    // A boot snapshot request from a freshly-opened overlay window.
    //
    // The lint rule is right that this callback reads signals outside a
    // tracked scope, and that is exactly what it must do: `hello` asks for
    // the state AS OF NOW, once. Making it reactive would turn one reply
    // into a standing subscription that re-publishes on every roster change
    // — which the throttled effects below already do.
    // eslint-disable-next-line solid/reactivity
    const unsubscribe = bridge.subscribe((msg) => {
      if (msg.type === "hello") publishNow();
    });

    // Open on the call appearing, close on it going away. The predicate is
    // the audited one (see `overlayInCall`) — watching `room()` alone would
    // leave the overlay floating over the game forever after a Wi-Fi drop,
    // because LiveKit's drop path leaves `room()` set.
    createEffect(
      on(inCall, (active, previous) => {
        if (active) {
          shell?.open();
          publishNow();
        } else if (previous) {
          bridge.publish({ v: OVERLAY_PROTOCOL_VERSION, type: "bye" });
          shell?.close();
        }
      }),
    );

    // Re-publish immediately when a setting moves mid-call, so a slider drag
    // is live rather than waiting for the next heartbeat.
    createEffect(
      on(config, () => {
        if (inCall()) publishThrottled();
      }),
    );

    createEffect(
      on(snapshot, () => {
        if (inCall()) publishThrottled();
      }),
    );

    // Heartbeat: re-send the snapshot AND ensure-open the window. The
    // ensure-open half is not redundant — the open effect above is
    // edge-triggered on the call appearing, so without this any timer stall
    // over 30 s (OS sleep/resume mid-call is the common one) would let the
    // overlay self-close permanently with nothing left to re-open it. The
    // slice-0 spike verified `open`'s refocus arm never takes the foreground,
    // so calling it every 3 s is safe.
    const heartbeat = setInterval(() => {
      if (!inCall()) return;
      shell?.open();
      publishNow();
    }, HEARTBEAT_MS);

    // LiveKit-side churn. These are the only sources of speaking/mute state,
    // and none of them is reactive on its own.
    const room = voice.room();
    const bump = () => setLiveVersion((value) => value + 1);
    if (room) {
      room
        .on(RoomEvent.ActiveSpeakersChanged, bump)
        .on(RoomEvent.TrackMuted, bump)
        .on(RoomEvent.TrackUnmuted, bump)
        .on(RoomEvent.ParticipantConnected, bump)
        .on(RoomEvent.ParticipantDisconnected, bump);
    }

    // RTT, only when the readout is on. The figure comes from the ICE
    // candidate pair (see `readRttMs`) — the RTCP-derived one this used to
    // read showed 6293 ms on a healthy call in the first live game test.
    // Still sampled off the mic publication, so it yields nothing at all when
    // the mic is not published and the overlay shows "—" rather than a zero.
    const rttPoll = setInterval(() => {
      if (!state.voice.overlayShowLatency || !inCall()) return;
      const current = voice.room();
      void current?.localParticipant
        // `Track.Source.Microphone`, not the bare "microphone" string the
        // stats overlay uses — that spelling is one of this tree's standing
        // tsc errors and there is no reason to add a second one.
        .getTrackPublication(Track.Source.Microphone)
        ?.track?.getRTCStatsReport?.()
        .then((reports) => setRttMs(readRttMs(reports)))
        .catch(() => setRttMs(undefined));
    }, RTT_POLL_MS);

    onCleanup(() => {
      if (throttleTimer) clearTimeout(throttleTimer);
      clearInterval(heartbeat);
      clearInterval(rttPoll);
      if (room) {
        room
          .off(RoomEvent.ActiveSpeakersChanged, bump)
          .off(RoomEvent.TrackMuted, bump)
          .off(RoomEvent.TrackUnmuted, bump)
          .off(RoomEvent.ParticipantConnected, bump)
          .off(RoomEvent.ParticipantDisconnected, bump);
      }
      // Disarming (setting switched off, or the app tearing down) must take
      // the window with it — an overlay with no publisher is exactly the
      // ghost the staleness timers exist to catch, and we can do better than
      // making the user wait 30 s for them.
      bridge.publish({ v: OVERLAY_PROTOCOL_VERSION, type: "bye" });
      shell?.close();
      unsubscribe();
      bridge.close();
    });
  });

  return null;
}
