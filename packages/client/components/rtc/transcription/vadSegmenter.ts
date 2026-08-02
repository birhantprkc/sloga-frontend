/**
 * Cuts one participant's audio into utterances for the transcriber.
 *
 * Whisper is a chunk transcriber, not a streaming one: it wants a few seconds
 * of speech with the silence trimmed off. Feeding it fixed-length windows would
 * slice words in half at every boundary, and feeding it the whole call at once
 * would return nothing until the call ended. So a voice-activity detector finds
 * the gaps between utterances and cuts there.
 *
 * **The energy gates are not an optimisation — they are a correctness gate.**
 * Whisper hallucinates fluent, confident sentences when handed silence or room
 * noise ("Thank you for watching", subtitle-credit boilerplate from its
 * training data). In a transcript those do not read as glitches; they read as
 * something a named participant said, in an artifact that leaves the app and
 * that people may rely on. Dropping a real half-second of speech is a much
 * cheaper mistake than inventing one, so everything here is biased toward
 * discarding a doubtful segment.
 *
 * Timestamps come from the sample count, never the wall clock: they must line
 * up with the audio regardless of how late a chunk was delivered, and it makes
 * the whole thing deterministic to test.
 */

export interface VadOptions {
  /** Samples per second of the PCM being pushed. */
  sampleRate: number;
  /** Frame RMS at or above this counts as voiced. */
  silenceThreshold: number;
  /** Consecutive voiced frames needed to start an utterance. */
  onsetFrames: number;
  /** Silence this long ends an utterance. */
  hangoverMs: number;
  /** Keep this much audio from before the onset, so onsets aren't clipped. */
  preRollMs: number;
  /** Keep this much of the trailing silence, so final consonants survive. */
  tailMs: number;
  /** Cut here even mid-speech, so a monologue still reaches the transcript. */
  maxSegmentMs: number;
  /** Utterances with less voiced audio than this are discarded as noise. */
  minSpeechMs: number;
  /** Mean voiced RMS below this is discarded — breath, hum, keyboard. */
  minSegmentRms: number;
  /**
   * Milliseconds already elapsed in the transcript when this segmenter was
   * created, added to every timestamp it emits.
   *
   * One segmenter per speaker, each counting frames from its own first sample
   * — so without this, a participant who joins after transcription has already
   * started would time their speech from zero and sort to the TOP of the
   * transcript, scrambling the conversation. Everyone present at the start
   * gets 0 and is unaffected, which is why a two-party call reads correctly
   * and only a late arrival exposes it.
   */
  originMs: number;
}

/**
 * Defaults tuned for close-talk call audio that has already been through
 * WebRTC's own noise suppression, so the noise floor arriving here is low.
 */
export const DEFAULT_VAD_OPTIONS: VadOptions = {
  sampleRate: 16_000,
  silenceThreshold: 0.01,
  onsetFrames: 2,
  hangoverMs: 700,
  preRollMs: 240,
  tailMs: 160,
  maxSegmentMs: 15_000,
  minSpeechMs: 320,
  minSegmentRms: 0.014,
  originMs: 0,
};

/** 20 ms — short enough to place a cut precisely, long enough for stable RMS. */
const FRAME_MS = 20;

export interface AudioSegment {
  /** Milliseconds from the start of this track's capture. */
  startMs: number;
  endMs: number;
  /** Voiced milliseconds within the segment, excluding the pre-roll and tail. */
  speechMs: number;
  pcm: Float32Array;
}

interface Frame {
  samples: Float32Array;
  rms: number;
  voiced: boolean;
}

function rmsOf(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / (samples.length || 1));
}

export class VadSegmenter {
  #options: VadOptions;
  #frameSamples: number;
  #preRollFrames: number;
  #hangoverFrames: number;
  #tailFrames: number;
  #maxFrames: number;
  #minSpeechFrames: number;

  /** Samples that did not fill a frame; prepended to the next push. */
  #remainder = new Float32Array(0);
  /** Frames consumed since capture began — the clock for every timestamp. */
  #framesConsumed = 0;

  /** Rolling pre-onset context, kept only while idle. */
  #preRoll: Frame[] = [];
  /** Frames of the utterance being built, once one has started. */
  #current: Frame[] = [];
  /** Frame index of `#current[0]`, for timestamps. */
  #currentStart = 0;
  /** Consecutive voiced frames seen while idle, for onset detection. */
  #onsetRun = 0;
  /** Trailing silent frames inside `#current`. */
  #trailingSilence = 0;

  constructor(options: Partial<VadOptions> = {}) {
    const merged = { ...DEFAULT_VAD_OPTIONS, ...options };
    this.#options = merged;

    const perMs = merged.sampleRate / 1000;
    this.#frameSamples = Math.max(1, Math.round(FRAME_MS * perMs));
    const frames = (ms: number) => Math.max(1, Math.round(ms / FRAME_MS));
    this.#preRollFrames = Math.max(0, Math.round(merged.preRollMs / FRAME_MS));
    this.#hangoverFrames = frames(merged.hangoverMs);
    this.#tailFrames = Math.max(0, Math.round(merged.tailMs / FRAME_MS));
    this.#maxFrames = frames(merged.maxSegmentMs);
    this.#minSpeechFrames = frames(merged.minSpeechMs);
  }

  /** Whether an utterance is currently being built — drives "…speaking". */
  get speaking(): boolean {
    return this.#current.length > 0;
  }

  /** Milliseconds of audio consumed so far. */
  get elapsedMs(): number {
    return this.#framesConsumed * FRAME_MS;
  }

  /**
   * Feed newly captured audio. Returns the utterances that completed inside
   * this chunk — usually none, occasionally more than one.
   */
  push(samples: Float32Array): AudioSegment[] {
    const joined = this.#join(samples);
    const usable = Math.floor(joined.length / this.#frameSamples);
    this.#remainder = joined.subarray(usable * this.#frameSamples).slice();

    const out: AudioSegment[] = [];
    for (let i = 0; i < usable; i++) {
      const start = i * this.#frameSamples;
      const raw = joined.subarray(start, start + this.#frameSamples);
      const rms = rmsOf(raw);
      const segment = this.#consume({
        samples: raw.slice(),
        rms,
        voiced: rms >= this.#options.silenceThreshold,
      });
      if (segment) out.push(segment);
    }
    return out;
  }

  /**
   * End the stream and emit whatever was in progress.
   *
   * Called when a capture stops and — importantly — when a participant leaves
   * mid-sentence. Their last words are sitting in this buffer, and dropping the
   * buffer with the track would lose exactly the part someone is most likely to
   * go looking for.
   */
  flush(): AudioSegment[] {
    const segment = this.#close();
    this.#preRoll = [];
    this.#onsetRun = 0;
    this.#remainder = new Float32Array(0);
    return segment ? [segment] : [];
  }

  #join(samples: Float32Array): Float32Array {
    if (this.#remainder.length === 0) return samples;
    const joined = new Float32Array(this.#remainder.length + samples.length);
    joined.set(this.#remainder, 0);
    joined.set(samples, this.#remainder.length);
    return joined;
  }

  #consume(frame: Frame): AudioSegment | undefined {
    this.#framesConsumed++;

    if (this.#current.length === 0) {
      // Idle: watch for an onset, and keep a little history so the utterance
      // does not begin halfway through its first word.
      this.#preRoll.push(frame);
      if (this.#preRoll.length > this.#preRollFrames) this.#preRoll.shift();

      this.#onsetRun = frame.voiced ? this.#onsetRun + 1 : 0;
      if (this.#onsetRun < this.#options.onsetFrames) return undefined;

      this.#current = this.#preRoll;
      this.#currentStart = this.#framesConsumed - this.#current.length;
      this.#preRoll = [];
      this.#onsetRun = 0;
      this.#trailingSilence = 0;
      return undefined;
    }

    this.#current.push(frame);
    this.#trailingSilence = frame.voiced ? 0 : this.#trailingSilence + 1;

    // A long enough gap means the utterance is over.
    if (this.#trailingSilence >= this.#hangoverFrames) return this.#close();

    // A speaker who does not pause still has to reach the transcript, so cut
    // at the ceiling and carry straight on. No pre-roll on the continuation:
    // the audio is contiguous, and re-sending the tail would duplicate words.
    if (this.#current.length >= this.#maxFrames) {
      const segment = this.#close({ trimTrailingSilence: false });
      this.#current = [];
      this.#currentStart = this.#framesConsumed;
      this.#trailingSilence = 0;
      return segment;
    }

    return undefined;
  }

  /** Finish the utterance in progress, applying the discard gates. */
  #close(
    opts: { trimTrailingSilence?: boolean } = {},
  ): AudioSegment | undefined {
    const frames = this.#current;
    if (frames.length === 0) return undefined;

    this.#current = [];
    this.#trailingSilence = 0;

    let end = frames.length;
    if (opts.trimTrailingSilence !== false) {
      // Drop the hangover silence but keep a short tail: trailing consonants
      // sit below the voiced threshold and get eaten by an exact cut.
      let silent = 0;
      while (
        silent < frames.length &&
        !frames[frames.length - 1 - silent].voiced
      ) {
        silent++;
      }
      end = frames.length - silent + Math.min(silent, this.#tailFrames);
    }

    const kept = frames.slice(0, Math.max(1, end));
    const voiced = kept.filter((f) => f.voiced);

    // Gate 1: too little actual speech. A door, a cough, a chair.
    if (voiced.length < this.#minSpeechFrames) return undefined;

    // Gate 2: loud enough to be a voice at all. Sustained low-level noise can
    // clear the frame threshold for long enough to pass gate 1.
    const meanRms =
      voiced.reduce((sum, f) => sum + f.rms, 0) / (voiced.length || 1);
    if (meanRms < this.#options.minSegmentRms) return undefined;

    const pcm = new Float32Array(kept.length * this.#frameSamples);
    kept.forEach((f, i) => pcm.set(f.samples, i * this.#frameSamples));

    return {
      startMs: this.#options.originMs + this.#currentStart * FRAME_MS,
      endMs:
        this.#options.originMs + (this.#currentStart + kept.length) * FRAME_MS,
      speechMs: voiced.length * FRAME_MS,
      pcm,
    };
  }
}
