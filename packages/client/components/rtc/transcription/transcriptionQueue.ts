/**
 * The bounded work queue in front of the speech model.
 *
 * Extracted from `CallTranscriber` so this logic can be tested without a room,
 * an AudioContext or a model — the same reason `CaptureClaim` is its own file.
 * Everything here was written in response to a real failure, so the specs
 * matter more than usual.
 *
 * **Why it is bounded.** Whisper-tiny runs faster than real time, so one person
 * pausing between sentences never builds a queue and every solo test looks
 * fine. Two people talking continuously on a busy machine is a different
 * regime: utterances arrive faster than they clear, and because each one holds
 * its own PCM, an unbounded queue is unbounded memory. Measured in a real
 * two-party call — the tab died.
 *
 * **Why draining has a deadline.** By the time anything drains, capture has
 * already stopped; the only thing outstanding is text. Waiting indefinitely for
 * a backlog that may never clear is how a stop button becomes a button that
 * does nothing, which is exactly how it was reported.
 *
 * **Why dropping is announced.** A transcript with holes that presents itself
 * as complete is worse than one that admits it missed something. The warning is
 * said once rather than per-utterance, because a hundred identical notices are
 * their own kind of silence.
 */

import type {
  TranscriptionEngine,
  TranscriptionJob,
} from "./transcriptionEngine.ts";

export interface TranscriptionQueueOptions {
  /** Outstanding utterances allowed before new ones are dropped. */
  maxPending: number;
  /** How long {@link TranscriptionQueue.drain} waits before giving up. */
  drainTimeoutMs: number;
  /** How often the drain loop re-checks. Small in tests, 50ms in the app. */
  pollMs?: number;
  /** Backlog size, so the UI can say "finishing N" rather than look stuck. */
  onPending(count: number): void;
  /** User-facing problems. Called at most once for the dropping case. */
  onError(message: string): void;
}

export const DROPPING_MESSAGE =
  "This device can't transcribe as fast as people are talking — some speech is being skipped.";
export const UNFINISHED_MESSAGE =
  "Some speech was still being transcribed when this stopped.";
export const FAILED_MESSAGE = "Some speech could not be transcribed.";

export class TranscriptionQueue {
  #engine: TranscriptionEngine;
  #options: Required<TranscriptionQueueOptions>;
  #pending = 0;
  #dropped = 0;
  #warnedDropping = false;

  constructor(engine: TranscriptionEngine, options: TranscriptionQueueOptions) {
    this.#engine = engine;
    this.#options = { pollMs: 50, ...options };
  }

  /** Utterances handed to the model and not yet returned. */
  get pending(): number {
    return this.#pending;
  }

  /** Utterances refused because the model could not keep up. */
  get dropped(): number {
    return this.#dropped;
  }

  /**
   * Hand an utterance to the model.
   *
   * Returns false if it was dropped because the backlog is full — the caller
   * has nothing to do about that, but the result makes the loss testable and
   * countable rather than invisible.
   */
  submit(
    job: TranscriptionJob,
    onResult: (text: string | undefined) => void,
  ): boolean {
    if (this.#pending >= this.#options.maxPending) {
      this.#dropped++;
      if (!this.#warnedDropping) {
        this.#warnedDropping = true;
        this.#options.onError(DROPPING_MESSAGE);
      }
      return false;
    }

    this.#pending++;
    this.#options.onPending(this.#pending);

    void this.#engine
      .transcribe(job)
      .then((text) => onResult(text))
      .catch((error) => {
        // One bad utterance must not take the rest of the call with it.
        console.error("[rtc] an utterance could not be transcribed", error);
        this.#options.onError(FAILED_MESSAGE);
      })
      .finally(() => {
        this.#pending--;
        this.#options.onPending(this.#pending);
      });

    return true;
  }

  /**
   * Wait for the backlog to clear, or for the deadline — whichever comes first.
   *
   * Always resolves. Whatever has landed by then is what the transcript gets.
   */
  async drain(): Promise<void> {
    const deadline = Date.now() + this.#options.drainTimeoutMs;
    while (this.#pending > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, this.#options.pollMs));
    }
    if (this.#pending > 0) this.#options.onError(UNFINISHED_MESSAGE);
  }
}
