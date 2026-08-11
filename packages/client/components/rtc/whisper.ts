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
  identityUserId,
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
  #busy = false;
  /** A stop requested while start() was mid-flight; honored when it settles,
   * so a banner-chip click during the getUserMedia window is never dropped. */
  #stopRequested = false;
  /** Invoked when the whisper's target leaves the call, so the owner can tear
   * the whisper down (and restore the mic) rather than keep an aside alive
   * addressed to nobody. */
  #onTargetGone: (() => void) | undefined;

  constructor(onTargetGone?: () => void) {
    const [target, setTarget] = createSignal<string | undefined>(undefined);
    this.target = target;
    this.#setTarget = setTarget;
    this.#onTargetGone = onTargetGone;
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

  #onParticipantChange = () => {
    const target = this.target();
    const room = this.#room;
    if (!target || !room) return;
    // If the target's last device has left, the aside has no audience — hand
    // back to the owner to tear down rather than re-fence a whisper nobody
    // can receive.
    const present = Array.from(room.remoteParticipants.values()).some(
      (p) => identityUserId(p.identity) === target,
    );
    if (!present) {
      this.#onTargetGone?.();
      return;
    }
    this.#push();
  };

  /**
   * Publish a whisper track to `targetUserId`. The caller (Voice) owns muting
   * the primary room mic through its pin-aware path; this manages only the
   * track and its subscription fence. Returns having torn everything back down
   * if a stop was requested while it was setting up.
   */
  async start(room: Room, targetUserId: string): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#stopRequested = false;
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

      const track = await createLocalAudioTrack({
        deviceId: room.getActiveDevice("audioinput") ?? undefined,
      });
      // A stop landing during the getUserMedia grant window must win — abort
      // before the track ever reaches the SFU.
      if (this.#stopRequested) {
        track.stop();
        await this.#stopInner();
        return;
      }
      this.#track = track;
      await room.localParticipant.publishTrack(track, {
        source: Track.Source.Unknown,
        name: whisperTrackName(targetUserId),
      });
      if (this.#stopRequested) await this.#stopInner();
    } catch (error) {
      await this.#stopInner();
      throw error;
    } finally {
      this.#busy = false;
      this.#stopRequested = false;
    }
  }

  async stop(): Promise<void> {
    // A stop mid-start latches and is honored when start() settles, rather
    // than being silently dropped.
    if (this.#busy) {
      this.#stopRequested = true;
      return;
    }
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

    // Unpublish the whisper track BEFORE reopening permissions, so there is no
    // window where the fence is down while a whisper publication still exists.
    // stop() always runs (unpublishTrack's `true` stops it) even if the
    // unpublish message itself throws.
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
    }
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
    this.#busy = false;
    this.#stopRequested = false;
  }
}
