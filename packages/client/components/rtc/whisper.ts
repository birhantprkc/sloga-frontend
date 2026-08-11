import type { LocalAudioTrack, Room } from "livekit-client";
import { RoomEvent, Track, createLocalAudioTrack } from "livekit-client";
import { type Accessor, type Setter, createSignal } from "solid-js";

/**
 * Whisper: a private aside to ONE person while in a group call, carried as a
 * second audio track whose subscription the SFU restricts to the target.
 *
 * The privacy model, stated plainly (see also the RC ladder rule about never
 * overclaiming): the whisper track is E2EE-encrypted like all call media, but
 * the per-participant frame keys are shared room-wide — everyone in the call
 * COULD decrypt it. What keeps it private is the SFU honoring the publisher's
 * subscription permissions, i.e. the server never forwards the frames to
 * anyone but the target. That is server-enforced access control, not
 * cryptographic exclusion, and UI copy must not claim otherwise.
 *
 * Because of that, the controller is built fail-closed around LiveKit's one
 * sharp edge: once `setTrackSubscriptionPermissions` switches to track-level
 * grants, any NEWER published track defaults to no-permissions-for-anyone
 * until the table is pushed again. We exploit the edge instead of fighting
 * it — the restriction goes up BEFORE the whisper track exists, so there is
 * no instant where a non-target could subscribe to it; and every publication
 * change while whispering re-pushes the table so normal tracks (PTT mic
 * republish, camera, screenshare) keep flowing to everyone.
 */

import {
  computeWhisperPermissions,
  whisperTarget,
  whisperTrackName,
} from "./whisperPermissions";

export {
  computeWhisperPermissions,
  whisperTarget,
  whisperTrackName,
} from "./whisperPermissions";

export class WhisperController {
  /** User id being whispered to, undefined when not whispering. */
  target: Accessor<string | undefined>;
  #setTarget: Setter<string | undefined>;

  #room: Room | undefined;
  #track: LocalAudioTrack | undefined;
  #micWasEnabled = false;
  #busy = false;

  constructor() {
    const [target, setTarget] = createSignal<string | undefined>(undefined);
    this.target = target;
    this.#setTarget = setTarget;
  }

  /** Sids of every local publication EXCEPT the whisper track itself. */
  #normalTrackSids(room: Room): string[] {
    const sids: string[] = [];
    for (const pub of room.localParticipant.trackPublications.values()) {
      if (whisperTarget(pub.trackName)) continue;
      if (pub.trackSid) sids.push(pub.trackSid);
    }
    return sids;
  }

  #push = () => {
    const room = this.#room;
    const target = this.target();
    if (!room || !target) return;
    room.localParticipant.setTrackSubscriptionPermissions(
      false,
      computeWhisperPermissions(
        target,
        Array.from(room.remoteParticipants.values()).map((p) => p.identity),
        this.#normalTrackSids(room),
      ),
    );
  };

  #onParticipantChange = () => this.#push();

  async start(room: Room, targetUserId: string): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      if (this.target()) await this.#stopInner();

      this.#room = room;
      this.#setTarget(targetUserId);

      // Restriction FIRST: from here on, a track the SFU has not been given
      // explicit permissions for reaches nobody but the target.
      this.#push();
      room.on(RoomEvent.ParticipantConnected, this.#onParticipantChange);
      room.on(RoomEvent.ParticipantDisconnected, this.#onParticipantChange);
      room.on(RoomEvent.LocalTrackPublished, this.#onParticipantChange);
      room.on(RoomEvent.LocalTrackUnpublished, this.#onParticipantChange);

      // A whisper is an aside: the room must not hear it through the open
      // mic. Remembered and restored on stop; if the user unmutes mid-whisper
      // that is their call and we leave it alone.
      this.#micWasEnabled = room.localParticipant.isMicrophoneEnabled;
      if (this.#micWasEnabled)
        await room.localParticipant.setMicrophoneEnabled(false);

      const track = await createLocalAudioTrack({
        deviceId: room.getActiveDevice("audioinput") ?? undefined,
      });
      this.#track = track;
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Unknown,
        name: whisperTrackName(targetUserId),
      });
    } catch (error) {
      await this.#stopInner();
      throw error;
    } finally {
      this.#busy = false;
    }
  }

  async stop(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.#stopInner();
    } finally {
      this.#busy = false;
    }
  }

  async #stopInner(): Promise<void> {
    const room = this.#room;
    this.#setTarget(undefined);

    if (room) {
      room.off(RoomEvent.ParticipantConnected, this.#onParticipantChange);
      room.off(RoomEvent.ParticipantDisconnected, this.#onParticipantChange);
      room.off(RoomEvent.LocalTrackPublished, this.#onParticipantChange);
      room.off(RoomEvent.LocalTrackUnpublished, this.#onParticipantChange);
    }

    if (this.#track) {
      try {
        await room?.localParticipant.unpublishTrack(this.#track, true);
      } catch {
        this.#track.stop();
      }
      this.#track = undefined;
    }

    if (room) {
      // Back to the default: everyone may subscribe to everything published.
      room.localParticipant.setTrackSubscriptionPermissions(true, []);
      if (this.#micWasEnabled && !room.localParticipant.isMicrophoneEnabled)
        await room.localParticipant
          .setMicrophoneEnabled(true)
          .catch(() => undefined);
    }
    this.#micWasEnabled = false;
    this.#room = undefined;
  }

  /** Synchronous teardown for call disconnect: the room is going away, so
   * permission restoration and unpublish are moot — just drop state and stop
   * the capture so the mic light goes off. */
  reset(): void {
    this.#setTarget(undefined);
    this.#track?.stop();
    this.#track = undefined;
    this.#room = undefined;
    this.#micWasEnabled = false;
    this.#busy = false;
  }
}
