/**
 * Owns one transcription session: taps → segmenters → model → transcript.
 *
 * The analogue of `CallRecorder`, and built per session for the same reason —
 * a stop/start cycle must not inherit a half-torn-down audio graph. The one
 * thing NOT rebuilt is the model, which is a module-level singleton because
 * loading it costs tens of megabytes of fetch and parse (see
 * `transcriptionEngine.ts`).
 *
 * Each participant gets their own segmenter, so silence from one person never
 * ends another's sentence, but all of them feed ONE model queue. People mostly
 * take turns, so a single queue keeps up; when they don't, utterances land a
 * few seconds late and in the right order anyway, because the transcript is
 * sorted by when audio was captured rather than when the model finished.
 */

import type { Room } from "livekit-client";

import { TrackTapper } from "./trackTapper.ts";
import type { TranscriptionEngine } from "./transcriptionEngine.ts";
import type { TranscriptStore } from "./transcriptStore.ts";
import { type AudioSegment, VadSegmenter } from "./vadSegmenter.ts";

export interface CallTranscriberOptions {
  /** ISO-639-1 spoken-language hint, or "" to let the model decide. */
  language?: string;
}

/**
 * How far behind the model is allowed to fall before speech starts being
 * dropped.
 *
 * Whisper-tiny runs faster than real time on a normal machine, so with one
 * person pausing between sentences the queue never builds. Two people talking
 * continuously on a busy machine is a different story: utterances arrive faster
 * than they clear, and because each one holds its raw PCM, an unbounded queue
 * grows without limit until the tab dies. That was measured in a real
 * two-party call, not theorised.
 *
 * Twelve outstanding utterances is far more headroom than a keeping-up machine
 * ever uses, and small enough that the memory held is bounded and modest.
 */
const MAX_PENDING = 12;

/**
 * How long `stop()` will wait for the backlog before giving up on it.
 *
 * Stop must ALWAYS complete. Waiting on a queue that might never drain is how
 * a stop button becomes a button that does nothing, and the user is left with
 * no way to end a capture that is still running.
 */
const DRAIN_TIMEOUT_MS = 20_000;

export class CallTranscriber {
  #tapper: TrackTapper;
  #engine: TranscriptionEngine;
  #store: TranscriptStore;
  #options: CallTranscriberOptions;
  #onError: (message: string) => void;
  /** Reports the backlog so the UI can say "finishing N" rather than look stuck. */
  #onPending: (count: number) => void;

  /** identity → their own utterance detector. */
  #segmenters = new Map<string, VadSegmenter>();
  /** Utterances handed to the model but not yet returned. */
  #inFlight = 0;
  /** Utterances thrown away because the model could not keep up. */
  #dropped = 0;
  /** So the "couldn't keep up" warning is said once, not once per utterance. */
  #warnedDropping = false;
  #stopped = false;
  /** Wall-clock epoch of the moment capture began, for absolute timings. */
  #startedAt = 0;

  constructor(
    room: Room,
    engine: TranscriptionEngine,
    store: TranscriptStore,
    options: CallTranscriberOptions,
    onError: (message: string) => void,
    onPending: (count: number) => void = () => undefined,
  ) {
    this.#engine = engine;
    this.#store = store;
    this.#options = options;
    this.#onError = onError;
    this.#onPending = onPending;
    this.#tapper = new TrackTapper(room, {
      onAudio: (identity, pcm) => this.#onAudio(identity, pcm),
      onEnded: (identity) => this.#onEnded(identity),
    });
  }

  /** Utterances still being transcribed — the panel shows this while stopping. */
  get pending(): number {
    return this.#inFlight;
  }

  /**
   * Start capturing.
   *
   * The model must ALREADY be loaded: connecting taps is capture, and capture
   * may not begin before the room has been told. The caller warms the engine
   * first, then claims, then calls this.
   */
  async start(): Promise<void> {
    this.#startedAt = Date.now();
    this.#store.begin(this.#startedAt);
    await this.#tapper.start();
  }

  /**
   * Stop capturing immediately, and finish transcribing what was already
   * captured.
   *
   * The tap teardown is synchronous so the capture boundary lands in this turn
   * — call teardown cannot await. The returned promise resolves once the queue
   * has drained, which the export path waits on so the last thing said is not
   * missing from the file.
   */
  stop(): Promise<void> {
    if (this.#stopped) return this.#drain();
    this.#stopped = true;

    // Capture stops here, synchronously.
    this.#tapper.stop();

    // Whatever each speaker was mid-way through is still worth transcribing.
    for (const [identity, segmenter] of this.#segmenters) {
      for (const segment of segmenter.flush())
        this.#transcribe(identity, segment);
    }
    this.#segmenters.clear();
    this.#store.clearSpeaking();

    return this.#drain();
  }

  /**
   * Resolve once the model queue is empty — or once the deadline passes.
   *
   * **The timeout is the point.** Capture has already stopped by the time this
   * runs, so the only thing still outstanding is text. Waiting forever for a
   * backlog that may never clear would turn "stop" into a button that appears
   * to do nothing, which is exactly what a user reported. Whatever has landed
   * by the deadline is what the transcript gets.
   */
  async #drain(): Promise<void> {
    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.#inFlight > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (this.#inFlight > 0) {
      this.#onError(
        "Some speech was still being transcribed when this stopped.",
      );
    }
    this.#onPending(0);
  }

  #segmenterFor(identity: string): VadSegmenter {
    let segmenter = this.#segmenters.get(identity);
    if (!segmenter) {
      segmenter = new VadSegmenter();
      this.#segmenters.set(identity, segmenter);
    }
    return segmenter;
  }

  #onAudio(identity: string, pcm: Float32Array): void {
    if (this.#stopped) return;
    const segmenter = this.#segmenterFor(identity);
    const segments = segmenter.push(pcm);
    this.#store.setSpeaking(identity, segmenter.speaking);
    for (const segment of segments) this.#transcribe(identity, segment);
  }

  #onEnded(identity: string): void {
    const segmenter = this.#segmenters.get(identity);
    if (!segmenter) return;
    this.#segmenters.delete(identity);
    this.#store.setSpeaking(identity, false);
    // Their last sentence is in this buffer; it goes with the track otherwise.
    for (const segment of segmenter.flush())
      this.#transcribe(identity, segment);
  }

  #transcribe(identity: string, segment: AudioSegment): void {
    // Refuse to queue past the cap. Each pending job holds its own PCM, so an
    // unbounded backlog is unbounded memory — and a queue the model can never
    // catch up on only gets further behind, so the audio it holds is stale by
    // the time it would be transcribed anyway.
    if (this.#inFlight >= MAX_PENDING) {
      this.#dropped++;
      if (!this.#warnedDropping) {
        this.#warnedDropping = true;
        // Said once. Silence here would be the worst option: a transcript with
        // holes in it that claims to be complete.
        this.#onError(
          "This device can't transcribe as fast as people are talking — some speech is being skipped.",
        );
      }
      return;
    }

    this.#inFlight++;
    this.#onPending(this.#inFlight);
    void this.#engine
      .transcribe({
        pcm: segment.pcm,
        spokenMs: segment.speechMs,
        language: this.#options.language || undefined,
      })
      .then((text) => {
        // undefined means the model returned nothing believable; the segment is
        // dropped rather than attributed to this speaker.
        if (text) {
          this.#store.add({
            identity,
            startMs: segment.startMs,
            endMs: segment.endMs,
            text,
          });
        }
      })
      .catch((error) => {
        console.error("[rtc] an utterance could not be transcribed", error);
        this.#onError("Some speech could not be transcribed.");
      })
      .finally(() => {
        this.#inFlight--;
        this.#onPending(this.#inFlight);
      });
  }

  /** Utterances skipped because the model could not keep up. */
  get dropped(): number {
    return this.#dropped;
  }

  get startedAt(): number {
    return this.#startedAt;
  }
}
