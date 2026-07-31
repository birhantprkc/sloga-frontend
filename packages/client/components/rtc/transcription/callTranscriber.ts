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

export class CallTranscriber {
  #tapper: TrackTapper;
  #engine: TranscriptionEngine;
  #store: TranscriptStore;
  #options: CallTranscriberOptions;
  #onError: (message: string) => void;

  /** identity → their own utterance detector. */
  #segmenters = new Map<string, VadSegmenter>();
  /** Utterances handed to the model but not yet returned. */
  #inFlight = 0;
  #stopped = false;
  /** Wall-clock epoch of the moment capture began, for absolute timings. */
  #startedAt = 0;

  constructor(
    room: Room,
    engine: TranscriptionEngine,
    store: TranscriptStore,
    options: CallTranscriberOptions,
    onError: (message: string) => void,
  ) {
    this.#engine = engine;
    this.#store = store;
    this.#options = options;
    this.#onError = onError;
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

  /** Resolve once nothing is left in the model queue. */
  async #drain(): Promise<void> {
    // The queue is serialised inside the engine, so polling is enough and
    // avoids threading a barrier through every job.
    while (this.#inFlight > 0) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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
    this.#inFlight++;
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
      });
  }

  get startedAt(): number {
    return this.#startedAt;
  }
}
