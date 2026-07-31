import { Room, RoomEvent, Track } from "livekit-client";

// Explicit `.ts`, unlike most imports here: this module is loaded directly by
// `node --test`, whose ESM resolver does not guess extensions. tsc allows it
// (`allowImportingTsExtensions`) and vite resolves it — dropping the extension
// compiles and builds fine but breaks the specs.
import { captureFilename } from "./captureFilename.ts";

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
/**
 * Container preference, most-compatible first.
 *
 * **`audio/mp4` (AAC in `.m4a`) leads deliberately, for playback compatibility
 * rather than quality.** A recording is the one thing this feature produces
 * that leaves the app: people open it in Windows Media Player, Audacity,
 * Premiere, a phone, or hand it to someone else. Opus-in-WebM is the better
 * codec per byte, and it is what a browser reaches for by default — but plenty
 * of ordinary desktop software still will not open a `.webm` audio file, and a
 * recording you cannot open is worth nothing.
 *
 * **MP3 is not an option and cannot be added here.** No browser ships an MP3
 * *encoder* — `MediaRecorder.isTypeSupported("audio/mpeg")` is false in
 * Chromium (verified live, Chrome 148); the MP3 support browsers advertise is
 * decode-only. A literal `.mp3` needs a WASM encoder (lamejs) fed from a PCM
 * tap, which is a different feature with real CPU cost. AAC is the natively
 * encodable format that opens in the same places, so it gets the same job done
 * for one line.
 *
 * WebM/Opus stays as the fallback for shells with no AAC encoder.
 */
export const MIME_CANDIDATES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
] as const;

/** Chunk cadence. Small enough that a crash loses seconds, not minutes. */
const TIMESLICE_MS = 5_000;

/**
 * A hard ceiling on buffered audio, for the FALLBACK path only (a shell with no
 * File System Access API, where chunks must accumulate in memory until the
 * recording stops). At Opus voice bitrates ~120 MB is on the order of a couple
 * of days of talking, so this is a runaway guard — a stuck recorder in a
 * forgotten tab — not a duration limit anyone meets by using the feature.
 *
 * The streaming path has NO ceiling: chunks go straight to disk.
 */
const MAX_BUFFERED_BYTES = 120 * 1024 * 1024;

/**
 * A file the user chose, that audio is written to AS IT IS CAPTURED.
 *
 * Streaming rather than buffer-then-save exists because of a live finding: in
 * an embedded webview (the Electron-based browser pane; plausibly the Tauri
 * shell too, on the `on_new_window` precedent) an `<a download>` click
 * **reports success and writes nothing**. It throws no error, logs nothing, and
 * the recording is simply gone. Streaming to a handle the user picked replaces
 * a silent-failure path with one that cannot silently fail — and as a bonus
 * removes the memory ceiling and leaves a valid partial file if the app dies
 * mid-call.
 */
export interface RecordingTarget {
  /** Name the user actually chose (may differ from what we suggested). */
  readonly name: string;
  /** Append one chunk. Calls are serialised internally — order is preserved. */
  write(chunk: Blob): Promise<void>;
  /** Flush and finalise. */
  close(): Promise<void>;
  /** Give up; leaves whatever was written. */
  abort(): Promise<void>;
}

/** The slice of the File System Access API used here. TS's DOM lib in this
 *  project does not declare it. */
type SaveFilePicker = (options: {
  suggestedName?: string;
  types?: { description?: string; accept: Record<string, string[]> }[];
}) => Promise<{
  name: string;
  createWritable(): Promise<{
    write(data: Blob): Promise<void>;
    close(): Promise<void>;
    abort?(): Promise<void>;
  }>;
}>;

function filePicker(): SaveFilePicker | undefined {
  return (window as unknown as { showSaveFilePicker?: SaveFilePicker })
    .showSaveFilePicker;
}

/** Whether this shell can show a real "save as" dialog. */
export function saveDialogSupported(): boolean {
  return typeof filePicker() === "function";
}

/** True for the DOMException a cancelled file picker throws. */
export function isSaveCancelled(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: string }).name === "AbortError"
  );
}

/**
 * Ask the user where to put the recording, and open it for writing.
 *
 * MUST be called synchronously from the click that starts recording — the
 * picker requires transient user activation, and anything awaited first spends
 * it. Returns undefined when the shell has no picker (caller falls back to
 * buffering); throws `AbortError` when the user cancels, which is not an error.
 */
export async function pickRecordingTarget(
  suggestedName: string,
): Promise<RecordingTarget | undefined> {
  const picker = filePicker();
  if (!picker) return undefined;

  // Derive the accepted type from the suggested name so the dialog's filter
  // matches the container we will actually write (see `recordingMimeType`).
  const ext = suggestedName.slice(suggestedName.lastIndexOf("."));
  const mime =
    ext === ".ogg" ? "audio/ogg" : ext === ".m4a" ? "audio/mp4" : "audio/webm";

  const handle = await picker({
    suggestedName,
    types: [{ description: "Audio recording", accept: { [mime]: [ext] } }],
  });
  const writable = await handle.createWritable();

  // Serialise writes: MediaRecorder can deliver a chunk while the previous
  // write is still in flight, and concurrent writes to one stream interleave.
  let queue: Promise<void> = Promise.resolve();

  return {
    name: handle.name || suggestedName,
    write(chunk) {
      queue = queue.then(() => writable.write(chunk));
      return queue;
    },
    async close() {
      await queue;
      await writable.close();
    },
    async abort() {
      // Swallow a failed pending write — we are already giving up, and the
      // point is to leave the bytes that did land.
      await queue.catch(() => undefined);
      if (writable.abort) await writable.abort().catch(() => undefined);
      else await writable.close().catch(() => undefined);
    },
  };
}

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
 * The container this shell will actually encode into.
 *
 * Exported so the save dialog can suggest a filename whose extension matches
 * the bytes. Suggesting `.webm` and then writing Ogg produces a file players
 * refuse on the strength of its name alone.
 */
export function recordingMimeType(): string | undefined {
  return pickMimeType();
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
  /** Where audio goes as it is captured; undefined = buffer-then-save fallback. */
  #target: RecordingTarget | undefined;
  /** Bytes handed to the target, for the "saved N MB" confirmation. */
  #bytesWritten = 0;
  /** First streaming-write failure — a full disk must not pass as a save. */
  #writeError: unknown;

  constructor(
    room: Room,
    onAutoStop: (reason: string) => void,
    target?: RecordingTarget,
  ) {
    this.#room = room;
    this.#onAutoStop = onAutoStop;
    this.#target = target;
  }

  /** The file being written, when streaming. */
  get targetName(): string | undefined {
    return this.#target?.name;
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

      // Streaming path: straight to the file the user chose. No ceiling, and a
      // crash leaves a valid partial recording rather than nothing.
      if (this.#target) {
        this.#bytesWritten += event.data.size;
        void this.#target.write(event.data).catch((error) => {
          // A disk that filled up (or a revoked handle) must be LOUD — a
          // truncated file that reported success is the failure mode this
          // whole design exists to remove.
          this.#writeError ??= error;
          this.#onAutoStop("Couldn't write to the recording file.");
        });
        return;
      }

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
   * Flush, tear the graph down, and finalise the recording.
   *
   * Returns `{ savedAs }` when it was streamed to a file the user picked (it is
   * already on disk — the caller has nothing to save), or `{ blob }` for the
   * fallback path (the caller must hand it over). Returns undefined when
   * nothing was captured at all.
   *
   * Safe to call twice: the second call finds no recorder and returns
   * undefined, which matters because both the user's Stop and the disconnect
   * teardown can race here.
   */
  async stop(): Promise<
    | {
        durationMs: number;
        bytes: number;
        /** Set when streamed: the file is already written. */
        savedAs?: string;
        /** Set on the fallback path: the caller still has to save this. */
        blob?: Blob;
      }
    | undefined
  > {
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

    // Streaming path: the bytes are already on disk, so all that remains is to
    // close the handle. A write that failed earlier is rethrown here rather
    // than reported as a successful save.
    const target = this.#target;
    if (target) {
      this.#target = undefined;
      try {
        await target.close();
      } catch (error) {
        this.#writeError ??= error;
      }
      if (this.#writeError) throw this.#writeError;
      if (this.#bytesWritten === 0) return undefined;
      return {
        durationMs,
        bytes: this.#bytesWritten,
        savedAs: target.name,
      };
    }

    const chunks = this.#chunks;
    this.#chunks = [];
    const bytes = this.#bufferedBytes;
    this.#bufferedBytes = 0;

    if (chunks.length === 0) return undefined;

    return {
      blob: new Blob(chunks, { type: recorder.mimeType || "audio/webm" }),
      durationMs,
      bytes,
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
 *
 * The naming itself is shared with the transcript exporter — a recording and
 * its transcript should land side by side.
 */
export function recordingFilename(
  channelName: string | undefined,
  startedAt: number,
  mimeType: string,
): string {
  return captureFilename(channelName, startedAt, extensionFor(mimeType));
}

/**
 * FALLBACK save, for shells with no File System Access API.
 *
 * 🔴 **This path cannot be trusted, and cannot detect its own failure.**
 * Verified live 2026-07-30 in the Electron-based browser pane: the `click()`
 * below throws nothing, logs nothing, and **no file is written**. Real
 * Chrome/Edge honour it; embedded webviews may not (compare the `wry`
 * `on_new_window` bug, where every `window.open` was dropped silently).
 *
 * There is no API to confirm a download started, so a caller must never report
 * "saved" off the back of this — say the file was handed to the browser's
 * downloads, and prefer {@link pickRecordingTarget} whenever it exists.
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
