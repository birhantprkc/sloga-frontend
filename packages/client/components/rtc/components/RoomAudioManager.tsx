import { createEffect, createMemo } from "solid-js";
import { AudioTrack, useTracks } from "solid-livekit-components";

import { getTrackReferenceId, isLocal } from "@livekit/components-core";
import { Key } from "@solid-primitives/keyed";
import { RemoteTrackPublication, Track } from "livekit-client";

import { useState } from "@revolt/state";

import { useVoice } from "../state";
import { identityUserId, whisperTarget } from "../whisperPermissions";

export function RoomAudioManager() {
  const voice = useVoice();
  const state = useState();

  const myUserId = () => {
    const identity = voice.room()?.localParticipant.identity;
    return identity ? identityUserId(identity) : undefined;
  };

  const tracks = useTracks(
    [
      Track.Source.Microphone,
      Track.Source.ScreenShareAudio,
      Track.Source.Unknown,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: false,
    },
  );

  // Subscribe to remote video tracks (camera + screen share) so they are received
  const videoTracks = useTracks(
    [
      Track.Source.Camera,
      Track.Source.ScreenShare,
    ],
    {
      updateOnlyOn: [],
      onlySubscribed: false,
    },
  );

  const filteredTracks = createMemo(() =>
    tracks().filter((track) => {
      if (isLocal(track.participant)) return false;
      if (track.publication.kind !== Track.Kind.Audio) return false;
      // Whisper tracks addressed to someone else: the SFU already refuses us
      // the subscription, but don't even try — a permission gap must not
      // become audible here, and the retry churn is pointless.
      const addressee = whisperTarget(track.publication.trackName);
      if (addressee && addressee !== myUserId()) return false;
      return true;
    }),
  );

  // Receiving-side whisper indicator: the first whisper track addressed to
  // us that is actually flowing. Cleared when it goes away.
  createEffect(() => {
    const whisper = filteredTracks().find(
      (track) => whisperTarget(track.publication.trackName) === myUserId(),
    );
    voice.noteIncomingWhisper(whisper?.participant.identity);
  });

  const filteredVideoTracks = createMemo(() =>
    videoTracks().filter((track) => !isLocal(track.participant)),
  );

  createEffect(() => {
    const tracks = filteredTracks();
    console.info("[rtc] filtered tracks", filteredTracks());
    for (const track of tracks) {
      (track.publication as RemoteTrackPublication).setSubscribed(true);
      console.info(track.publication);
    }
  });

  // Subscribe to remote video tracks so screen share and camera are received
  createEffect(() => {
    for (const track of filteredVideoTracks()) {
      (track.publication as RemoteTrackPublication).setSubscribed(true);
    }
  });

  return (
    <div style={{ display: "none" }}>
      <Key each={filteredTracks()} by={(item) => getTrackReferenceId(item)}>
        {(track) => (
          <AudioTrack
            trackRef={track()}
            volume={
              state.voice.outputVolume *
              (track().source === Track.Source.ScreenShareAudio
                ? state.voice.getScreenShareVolume(track().participant.identity)
                : state.voice.getUserVolume(track().participant.identity))
            }
            muted={
              (track().source === Track.Source.ScreenShareAudio
                ? state.voice.getScreenShareMuted(track().participant.identity)
                : state.voice.getUserMuted(track().participant.identity)) ||
              voice.deafen()
            }
            enableBoosting
          />
        )}
      </Key>
    </div>
  );
}
