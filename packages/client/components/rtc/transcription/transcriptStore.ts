/**
 * The transcript being built during a call.
 *
 * Two things make this more than an array.
 *
 * **Utterances do not arrive in the order they were spoken.** One speech model
 * serves every participant through a single queue, so a short reply can finish
 * while a long sentence spoken before it is still being transcribed. Appending
 * in arrival order would produce a transcript where people answer questions
 * that have not been asked yet. Every insert is placed by its own timestamp
 * instead, and ties keep arrival order so a rapid exchange stays readable.
 *
 * **It has to outlive the call.** The transcript is the whole point of the
 * feature and it exists only here, in memory, on one machine. A call can end
 * without warning — the network drops, the other side hangs up, the last
 * participant leaves — and none of those give the user a chance to export
 * first. So nothing in call teardown clears this; only an explicit discard, or
 * the start of the next transcription, does. Compare the recorder, which is
 * crash-safe for the same reason by streaming to a file the user picked up
 * front.
 */

import { ReactiveMap } from "@solid-primitives/map";
import { type Accessor, createSignal } from "solid-js";

import type { TranscriptSegment } from "./transcriptExport.ts";

export class TranscriptStore {
  #segments: Accessor<TranscriptSegment[]>;
  #setSegments: (value: TranscriptSegment[]) => void;

  /** Who is mid-utterance, for the "…speaking" placeholder in the panel. */
  #speaking = new ReactiveMap<string, true>();

  /** Wall-clock epoch that `startMs: 0` refers to; undefined until started. */
  #startedAt: number | undefined;

  /** Ids are positional, so a re-render cannot reorder rows under the user. */
  #nextId = 0;

  constructor() {
    const [segments, setSegments] = createSignal<TranscriptSegment[]>([]);
    this.#segments = segments;
    this.#setSegments = setSegments;
  }

  /** Utterances so far, in spoken order. */
  get segments(): Accessor<readonly TranscriptSegment[]> {
    return this.#segments;
  }

  get startedAt(): number | undefined {
    return this.#startedAt;
  }

  get isEmpty(): boolean {
    return this.#segments().length === 0;
  }

  /**
   * Begin a transcript, discarding any previous one.
   *
   * This — not call teardown — is where the last transcript goes, so that
   * whatever was captured stays exportable right up until the user starts
   * another one.
   */
  begin(startedAt: number): void {
    this.#startedAt = startedAt;
    this.#nextId = 0;
    this.#speaking.clear();
    this.#setSegments([]);
  }

  /** Add a finished utterance, in its spoken position. */
  add(entry: {
    identity: string;
    startMs: number;
    endMs: number;
    text: string;
  }): TranscriptSegment | undefined {
    const text = entry.text.trim();
    // The model returns empty strings for audio it could not make anything of.
    // Those are not silences worth recording, they are non-results.
    if (!text) return undefined;

    const segment: TranscriptSegment = {
      id: `t${this.#nextId++}`,
      identity: entry.identity,
      startMs: entry.startMs,
      endMs: entry.endMs,
      text,
    };

    const current = this.#segments();
    // Walk from the end: transcription runs a few seconds behind, so the
    // correct slot is almost always at or near the tail.
    let at = current.length;
    while (at > 0 && current[at - 1].startMs > segment.startMs) at--;

    const next = current.slice();
    next.splice(at, 0, segment);
    this.#setSegments(next);
    return segment;
  }

  /** Whether this participant is currently mid-utterance. */
  isSpeaking(identity: string): boolean {
    return this.#speaking.has(identity);
  }

  setSpeaking(identity: string, speaking: boolean): void {
    if (speaking) this.#speaking.set(identity, true);
    else this.#speaking.delete(identity);
  }

  /** Nobody is mid-utterance any more — capture stopped, or the call ended. */
  clearSpeaking(): void {
    this.#speaking.clear();
  }

  /**
   * Throw the transcript away. Only ever called for an explicit discard: this
   * is the one action that loses the transcript, and it must never be reachable
   * from teardown.
   */
  discard(): void {
    this.#startedAt = undefined;
    this.#nextId = 0;
    this.#speaking.clear();
    this.#setSegments([]);
  }
}
