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
import { TranscriptionQueue } from "./transcriptionQueue.ts";
import type { TranscriptStore } from "./transcriptStore.ts";
import { type AudioSegment, VadSegmenter } from "./vadSegmenter.ts";

export interface CallTranscriberOptions {
  /** ISO-639-1 spoken-language hint, or "" to let the model decide. */
  language?: string;
}

/**
 * Outstanding utterances allowed before speech starts being dropped.
 *
 * Twelve is far more headroom than a machine that is keeping up ever uses, and
 * small enough that the audio held in memory stays bounded and modest. The
 * reasoning behind having a cap at all lives in `transcriptionQueue.ts`.
 */
const MAX_PENDING = 12;

/** How long `stop()` waits for the backlog before giving up on it. */
const DRAIN_TIMEOUT_MS = 20_000;

export class CallTranscriber {
  #tapper: TrackTapper;
  #store: TranscriptStore;
  #options: CallTranscriberOptions;
  /** Bounded work queue in front of the model — see `transcriptionQueue.ts`. */
  #queue: TranscriptionQueue;

  /** identity → their own utterance detector. */
  #segmenters = new Map<string, VadSegmenter>();
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
    this.#store = store;
    this.#options = options;
    this.#queue = new TranscriptionQueue(engine, {
      maxPending: MAX_PENDING,
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
      onPending,
      onError,
    });
    this.#tapper = new TrackTapper(room, {
      onAudio: (identity, pcm) => this.#onAudio(identity, pcm),
      onEnded: (identity) => this.#onEnded(identity),
    });
  }

  /** Utterances still being transcribed — the panel shows this while stopping. */
  get pending(): number {
    return this.#queue.pending;
  }

  /** Utterances skipped because the model could not keep up. */
  get dropped(): number {
    return this.#queue.dropped;
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

  /** Resolve once the model queue is empty, or once its deadline passes. */
  #drain(): Promise<void> {
    return this.#queue.drain();
  }

  #segmenterFor(identity: string): VadSegmenter {
    let segmenter = this.#segmenters.get(identity);
    if (!segmenter) {
      // Anchor this speaker's clock to where the transcript already is. A
      // segmenter counts from its own first sample, so somebody who joins
      // mid-transcription would otherwise time their speech from zero and sort
      // to the top, scrambling the conversation. Everyone present at the start
      // gets ~0 here, which is why a two-party call reads correctly and only a
      // late arrival exposes it.
      segmenter = new VadSegmenter({
        originMs: Math.max(0, Date.now() - this.#startedAt),
      });
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
    this.#queue.submit(
      {
        pcm: segment.pcm,
        spokenMs: segment.speechMs,
        language: this.#options.language || undefined,
      },
      (text) => {
        // undefined means the model returned nothing believable; the segment is
        // dropped rather than attributed to this speaker.
        if (!text) return;
        this.#store.add({
          identity,
          startMs: segment.startMs,
          endMs: segment.endMs,
          text,
        });
      },
    );
  }

  get startedAt(): number {
    return this.#startedAt;
  }
}
