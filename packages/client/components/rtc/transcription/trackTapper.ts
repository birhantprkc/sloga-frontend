/**
 * Reads every participant's audio out of the call, one stream per person.
 *
 * **Why per-track and not the recorder's mix.** `CallRecorder` sums everyone
 * into a single graph because a recording is one file. A transcript has to say
 * who spoke, and the cheapest possible answer to that question is already in
 * the call: each participant arrives as their own LiveKit track, so audio
 * tapped from that track IS that person. No diarisation model, no clustering,
 * no guessing — and it stays correct when two people talk at once, which is
 * exactly where a diarisation model would fail.
 *
 * **Its own AudioContext, at 16kHz.** Whisper wants 16kHz mono; asking the
 * browser for a 16kHz context makes its resampler do that work natively and
 * cuts the data crossing to the main thread by two thirds. The context is
 * private to this tapper rather than shared with the recorder, because the two
 * features start and stop independently and either may run without the other.
 *
 * Nothing here is connected to speakers. The graph terminates in a
 * `MediaStreamAudioDestinationNode` that nobody plays — a destination is needed
 * only so the worklets keep getting scheduled.
 */

import { type Room, RoomEvent, Track } from "livekit-client";

/** Where the tap worklet is served from — self-hosted, never a CDN (the
 *  desktop shell's CSP blocks external script origins outright). */
function workletUrl(): string {
  return new URL(
    `${import.meta.env.BASE_URL}transcription/TranscriptionTapWorklet.js`,
    window.location.origin,
  ).href;
}

/** Whisper's sample rate. Asking for it here avoids resampling by hand. */
export const TAP_SAMPLE_RATE = 16_000;

export interface TrackTapperEvents {
  /** A chunk of one participant's audio, 16kHz mono. */
  onAudio(identity: string, pcm: Float32Array): void;
  /**
   * This participant's audio has ended (they left, muted, or unpublished).
   * The segmenter must flush: whatever is buffered is the last thing they
   * said, and it is the part someone will go looking for.
   */
  onEnded(identity: string): void;
}

interface Tap {
  identity: string;
  source: MediaStreamAudioSourceNode;
  node: AudioWorkletNode;
}

export class TrackTapper {
  #room: Room;
  #events: TrackTapperEvents;
  #context: AudioContext | undefined;
  #sink: MediaStreamAudioDestinationNode | undefined;
  /** trackSid → the nodes reading it. */
  #taps = new Map<string, Tap>();
  #stopped = false;

  constructor(room: Room, events: TrackTapperEvents) {
    this.#room = room;
    this.#events = events;
  }

  /** Participants currently being tapped, for the panel's speaker list. */
  get identities(): string[] {
    return [...new Set([...this.#taps.values()].map((tap) => tap.identity))];
  }

  /**
   * Build the graph and start reading. Throws if the shell cannot run a
   * worklet — the caller must not claim to be transcribing until this resolves.
   */
  async start(): Promise<void> {
    if (this.#context) return;

    const context = new AudioContext({ sampleRate: TAP_SAMPLE_RATE });
    // Chrome starts contexts suspended without a gesture; the click that got
    // here is one, but resume explicitly rather than trusting it.
    if (context.state === "suspended") await context.resume();
    await context.audioWorklet.addModule(workletUrl());

    // A destination nobody plays. Without one the worklets are never pulled.
    this.#sink = context.createMediaStreamDestination();
    this.#context = context;

    if (this.#stopped) {
      // Stopped while the module was loading.
      this.#teardown();
      return;
    }

    this.#attachExisting();
    this.#room.on(RoomEvent.TrackSubscribed, this.#onSubscribed);
    this.#room.on(RoomEvent.TrackUnsubscribed, this.#onUnsubscribed);
    this.#room.on(RoomEvent.LocalTrackPublished, this.#onLocalPublished);
    this.#room.on(RoomEvent.LocalTrackUnpublished, this.#onLocalUnpublished);
  }

  /**
   * Stop reading.
   *
   * The listener removal and node disconnection happen SYNCHRONOUSLY, so the
   * capture boundary lands in this turn even though the context closes later.
   * Call teardown cannot await (see `disconnect()` in `state.tsx`), and audio
   * already posted to the main thread is unaffected by the context going away.
   */
  stop(): void {
    this.#stopped = true;
    this.#teardown();
  }

  #teardown(): void {
    this.#room.off(RoomEvent.TrackSubscribed, this.#onSubscribed);
    this.#room.off(RoomEvent.TrackUnsubscribed, this.#onUnsubscribed);
    this.#room.off(RoomEvent.LocalTrackPublished, this.#onLocalPublished);
    this.#room.off(RoomEvent.LocalTrackUnpublished, this.#onLocalUnpublished);

    for (const sid of [...this.#taps.keys()]) this.#removeTap(sid);

    this.#sink = undefined;
    const context = this.#context;
    this.#context = undefined;
    // Releases the audio hardware; a leaked context keeps the tab marked as
    // playing audio for the rest of the session.
    void context?.close().catch(() => undefined);
  }

  #attachExisting(): void {
    for (const participant of this.#room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind !== Track.Kind.Audio) continue;
        const track = publication.track;
        if (track) {
          this.#addTap(
            publication.trackSid,
            participant.identity,
            track.mediaStreamTrack,
          );
        }
      }
    }

    const local = this.#room.localParticipant;
    for (const publication of local.trackPublications.values()) {
      if (publication.kind !== Track.Kind.Audio) continue;
      const track = publication.track;
      if (track) {
        this.#addTap(publication.trackSid, local.identity, localAudio(track));
      }
    }
  }

  #addTap(
    sid: string,
    identity: string,
    mediaStreamTrack: MediaStreamTrack,
  ): void {
    const context = this.#context;
    const sink = this.#sink;
    if (!context || !sink) return;
    if (this.#taps.has(sid)) return;
    if (mediaStreamTrack.kind !== "audio") return;

    try {
      // One MediaStream per track: a MediaStreamAudioSourceNode reads only the
      // FIRST audio track of the stream it is given, so a shared stream would
      // silently transcribe one participant and attribute everyone to them.
      const source = context.createMediaStreamSource(
        new MediaStream([mediaStreamTrack]),
      );
      const node = new AudioWorkletNode(context, "TranscriptionTap", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        this.#events.onAudio(identity, event.data);
      };
      source.connect(node);
      node.connect(sink);
      this.#taps.set(sid, { identity, source, node });
    } catch (error) {
      // One untappable track must not end the whole transcription: losing a
      // participant is better than losing everyone.
      console.error("[rtc] could not tap a track for transcription", error);
    }
  }

  #removeTap(sid: string): void {
    const tap = this.#taps.get(sid);
    if (!tap) return;
    this.#taps.delete(sid);

    try {
      // Ask the worklet to flush before tearing it down, then let the
      // controller close out this speaker's pending utterance.
      tap.node.port.postMessage("stop");
      tap.source.disconnect();
      tap.node.disconnect();
    } catch {
      /* already gone with its track */
    }

    // Only when they have no other audio track left — a device switch briefly
    // has two, and flushing on the first would cut a sentence in half.
    const stillTapped = [...this.#taps.values()].some(
      (other) => other.identity === tap.identity,
    );
    if (!stillTapped) this.#events.onEnded(tap.identity);
  }

  #onSubscribed = (
    track: { kind: Track.Kind; mediaStreamTrack: MediaStreamTrack },
    publication: { trackSid: string },
    participant: { identity: string },
  ) => {
    if (track.kind !== Track.Kind.Audio) return;
    this.#addTap(
      publication.trackSid,
      participant.identity,
      track.mediaStreamTrack,
    );
  };

  #onUnsubscribed = (_track: unknown, publication: { trackSid: string }) => {
    this.#removeTap(publication.trackSid);
  };

  #onLocalPublished = (publication: {
    trackSid: string;
    kind: Track.Kind;
    track?: {
      mediaStreamTrack: MediaStreamTrack;
      processedTrack?: MediaStreamTrack;
    };
  }) => {
    if (publication.kind !== Track.Kind.Audio) return;
    if (!publication.track) return;
    this.#addTap(
      publication.trackSid,
      this.#room.localParticipant.identity,
      localAudio(publication.track),
    );
  };

  #onLocalUnpublished = (publication: { trackSid: string }) => {
    this.#removeTap(publication.trackSid);
  };
}

/**
 * The local microphone, denoised if the pipeline is running.
 *
 * `processedTrack` is what RNNoise and the gain stage produce and what every
 * remote participant actually hears; `mediaStreamTrack` is the raw capture.
 * Transcribing the processed signal keeps the local speaker on equal terms with
 * everyone else, whose audio has already been through the same treatment by the
 * time it arrives.
 */
function localAudio(track: {
  mediaStreamTrack: MediaStreamTrack;
  processedTrack?: MediaStreamTrack;
}): MediaStreamTrack {
  return track.processedTrack ?? track.mediaStreamTrack;
}
