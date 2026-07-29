import { Room, RoomEvent, Track } from "livekit-client";

/**
 * Local call recording (call-recording plan §1).
 *
 * Mixes every participant's audio — remote microphones, remote screen-share
 * audio, and the local microphone — into one file written on THIS machine by
 * a `MediaRecorder`. Nothing is uploaded and nothing is recorded server-side.
 *
 * **Why local.** Media E2EE for calls is mandatory (see the
 * `e2eeCallsEnabled` accessor: it returns true unconditionally), so the server
 * holds no media keys and a server-side egress recorder is not merely
 * unimplemented — it is precluded by the design. The decrypted frames exist
 * only in the participants' clients, so a participant is the only thing that
 * *can* record. This module makes that capability explicit and disclosed
 * rather than leaving it to a screen recorder nobody is told about.
 *
 * **Audio only, deliberately.** A video composite would need a canvas
 * compositor surviving joins, leaves, layout changes and resolution swaps,
 * and would put real encode load on the recorder's machine mid-call. Audio
 * covers the "record the meeting" case at ~1 MB/min with no per-frame work.
 *
 * ## Two behaviours worth stating plainly
 *
 * - **Deafen does not stop capture.** Deafen mutes local *playback*; the
 *   tracks keep arriving. Honouring it here would silently produce a file
 *   with everyone missing, discovered only on playback. The recording follows
 *   what was *said*, not what you listened to.
 * - **Late joiners are mixed in live.** A participant who joins mid-recording
 *   is added to the graph on their first audio track, so the file matches the
 *   call rather than the roster at the moment Record was pressed.
 */

/** Wire format. Opus in WebM is the only combination every target shell
 *  reliably encodes; the ordered list degrades rather than throwing. */
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

/** Chunk cadence. Small enough that a crash loses seconds, not minutes. */
const TIMESLICE_MS = 5_000;

/**
 * A hard ceiling on buffered audio, because chunks accumulate in memory until
 * the recording stops. At Opus voice bitrates ~120 MB is on the order of a
 * couple of days of talking, so this is a runaway guard (a stuck recorder in
 * a forgotten tab), not a duration limit anyone will meet by using it.
 */
const MAX_BUFFERED_BYTES = 120 * 1024 * 1024;

export type CallRecorderState =
  | { kind: "idle" }
  | { kind: "recording"; startedAt: number }
  | { kind: "stopping" };

export function callRecordingSupported(): boolean {
  return (
    typeof MediaRecorder !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    MIME_CANDIDATES.some((type) => MediaRecorder.isTypeSupported(type))
  );
}

function pickMimeType(): string | undefined {
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type));
}

/**
 * Owns one recording. Constructed per recording rather than per call so a
 * stop/start cycle cannot inherit a half-torn-down audio graph.
 */
export class CallRecorder {
  #room: Room;
  #context: AudioContext | undefined;
  #destination: MediaStreamAudioDestinationNode | undefined;
  #recorder: MediaRecorder | undefined;
  #chunks: Blob[] = [];
  #bufferedBytes = 0;
  /** trackSid → the graph node holding it, so unpublish can disconnect it. */
  #sources = new Map<string, MediaStreamAudioSourceNode>();
  #startedAt = 0;
  #overflowed = false;
  #onAutoStop: (reason: string) => void;

  constructor(room: Room, onAutoStop: (reason: string) => void) {
    this.#room = room;
    this.#onAutoStop = onAutoStop;
  }

  get startedAt(): number {
    return this.#startedAt;
  }

  /**
   * Build the graph and start capturing. Throws if the shell cannot record or
   * there is no audio to record — callers must not light the indicator until
   * this resolves, or the call would be told about a recording that is not
   * happening.
   */
  async start(): Promise<void> {
    if (this.#recorder) return;

    const mimeType = pickMimeType();
    if (!mimeType) {
      throw new Error("This device can't record audio.");
    }

    const context = new AudioContext();
    // Chrome starts contexts suspended without a gesture; the click that got
    // us here is one, but resume explicitly rather than trusting it.
    if (context.state === "suspended") await context.resume();

    const destination = context.createMediaStreamDestination();
    this.#context = context;
    this.#destination = destination;

    this.#connectExistingTracks();

    // Follow the roster for the life of the recording. Without these, anyone
    // who joins (or unmutes, or starts sharing) after Record was pressed is
    // silently absent from the file.
    this.#room.on(RoomEvent.TrackSubscribed, this.#onTrackSubscribed);
    this.#room.on(RoomEvent.TrackUnsubscribed, this.#onTrackUnsubscribed);
    this.#room.on(RoomEvent.LocalTrackPublished, this.#onLocalTrackPublished);
    this.#room.on(
      RoomEvent.LocalTrackUnpublished,
      this.#onLocalTrackUnpublished,
    );

    const recorder = new MediaRecorder(destination.stream, { mimeType });
    this.#recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (!event.data || event.data.size === 0) return;
      if (this.#bufferedBytes + event.data.size > MAX_BUFFERED_BYTES) {
        // Stop rather than grow without bound. Whatever was captured up to
        // here is kept and still saved — dropping it would be the worse
        // failure.
        this.#overflowed = true;
        this.#onAutoStop("The recording hit its size limit and was saved.");
        return;
      }
      this.#chunks.push(event.data);
      this.#bufferedBytes += event.data.size;
    };

    recorder.onerror = () => {
      this.#onAutoStop("Recording stopped unexpectedly.");
    };

    recorder.start(TIMESLICE_MS);
    this.#startedAt = Date.now();
  }

  /**
   * Flush, tear the graph down and hand back the finished audio. Returns
   * undefined when nothing was captured (an immediate start/stop).
   *
   * Safe to call twice: the second call finds no recorder and returns
   * undefined, which matters because both the user's Stop and the
   * disconnect teardown can race here.
   */
  async stop(): Promise<{ blob: Blob; durationMs: number } | undefined> {
    const recorder = this.#recorder;
    if (!recorder) return undefined;
    this.#recorder = undefined;

    const durationMs = this.#startedAt ? Date.now() - this.#startedAt : 0;

    // `stop()` emits one final dataavailable before `stop` fires, so wait for
    // the event rather than the call, or the tail is lost.
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      recorder.addEventListener("stop", done, { once: true });
      try {
        if (recorder.state !== "inactive") {
          recorder.stop();
        } else {
          resolve();
        }
      } catch {
        resolve();
      }
    });

    this.#detach();

    const chunks = this.#chunks;
    this.#chunks = [];
    this.#bufferedBytes = 0;

    if (chunks.length === 0) return undefined;

    return {
      blob: new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
      durationMs,
    };
  }

  get overflowed(): boolean {
    return this.#overflowed;
  }

  #detach(): void {
    this.#room.off(RoomEvent.TrackSubscribed, this.#onTrackSubscribed);
    this.#room.off(RoomEvent.TrackUnsubscribed, this.#onTrackUnsubscribed);
    this.#room.off(RoomEvent.LocalTrackPublished, this.#onLocalTrackPublished);
    this.#room.off(
      RoomEvent.LocalTrackUnpublished,
      this.#onLocalTrackUnpublished,
    );

    for (const node of this.#sources.values()) {
      try {
        node.disconnect();
      } catch {
        /* already gone with its track */
      }
    }
    this.#sources.clear();

    this.#destination = undefined;
    const context = this.#context;
    this.#context = undefined;
    // Closing releases the audio hardware; a leaked context keeps the tab
    // marked as playing audio for the rest of the session.
    void context?.close().catch(() => undefined);
  }

  #connectExistingTracks(): void {
    for (const participant of this.#room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.kind !== Track.Kind.Audio) continue;
        const track = publication.track;
        if (track) this.#addTrack(publication.trackSid, track.mediaStreamTrack);
      }
    }

    for (const publication of this.#room.localParticipant.trackPublications.values()) {
      if (publication.kind !== Track.Kind.Audio) continue;
      const track = publication.track;
      if (track) this.#addTrack(publication.trackSid, track.mediaStreamTrack);
    }
  }

  /**
   * Add one audio track to the mix.
   *
   * Each track gets its own `MediaStream` wrapper: a
   * `MediaStreamAudioSourceNode` reads only the FIRST audio track of the
   * stream it is given, so reusing one stream would silently record a single
   * participant.
   *
   * Deliberately NO gain staging or per-user volume: those are playback
   * preferences. A recording that applied them would encode one listener's
   * mute settings into a file others may rely on.
   */
  #addTrack(sid: string, mediaStreamTrack: MediaStreamTrack): void {
    const context = this.#context;
    const destination = this.#destination;
    if (!context || !destination) return;
    if (this.#sources.has(sid)) return;
    if (mediaStreamTrack.kind !== "audio") return;

    try {
      const node = context.createMediaStreamSource(
        new MediaStream([mediaStreamTrack]),
      );
      node.connect(destination);
      this.#sources.set(sid, node);
    } catch (error) {
      // One unmixable track must never abort the whole recording — losing one
      // participant is better than losing everything.
      console.error("[rtc] could not add a track to the recording", error);
    }
  }

  #removeTrack(sid: string): void {
    const node = this.#sources.get(sid);
    if (!node) return;
    this.#sources.delete(sid);
    try {
      node.disconnect();
    } catch {
      /* already gone with its track */
    }
  }

  #onTrackSubscribed = (
    track: { kind: Track.Kind; mediaStreamTrack: MediaStreamTrack },
    publication: { trackSid: string },
  ) => {
    if (track.kind !== Track.Kind.Audio) return;
    this.#addTrack(publication.trackSid, track.mediaStreamTrack);
  };

  #onTrackUnsubscribed = (
    _track: unknown,
    publication: { trackSid: string },
  ) => {
    this.#removeTrack(publication.trackSid);
  };

  #onLocalTrackPublished = (publication: {
    trackSid: string;
    kind: Track.Kind;
    track?: { mediaStreamTrack: MediaStreamTrack };
  }) => {
    if (publication.kind !== Track.Kind.Audio) return;
    if (publication.track) {
      this.#addTrack(publication.trackSid, publication.track.mediaStreamTrack);
    }
  };

  #onLocalTrackUnpublished = (publication: { trackSid: string }) => {
    this.#removeTrack(publication.trackSid);
  };
}

/** Extension for a recorded blob's MIME type. */
function extensionFor(mimeType: string): string {
  if (mimeType.includes("ogg")) return "ogg";
  if (mimeType.includes("mp4")) return "m4a";
  return "webm";
}

/**
 * Build the filename for a finished recording: channel name, then a local
 * timestamp so several recordings of the same channel sort chronologically
 * and never collide.
 */
export function recordingFilename(
  channelName: string | undefined,
  startedAt: number,
  mimeType: string,
): string {
  const stamp = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
    `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;

  // Keep the channel name recognisable but filesystem-safe on every platform:
  // Windows rejects \ / : * ? " < > | outright.
  const safeName = (channelName ?? "call")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");

  return `${safeName || "call"}-${date}.${extensionFor(mimeType)}`;
}

/**
 * Hand the finished file to the user.
 *
 * An anchor download, which the desktop shell turns into its own save flow —
 * the same path the attachment download button uses, and the reason
 * `on_new_window` had to exist there. Kept as one seam so a future native
 * "save to…" only changes this function.
 */
export function saveRecording(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoke on a later tick — revoking synchronously can cancel the download
  // in Chromium before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
