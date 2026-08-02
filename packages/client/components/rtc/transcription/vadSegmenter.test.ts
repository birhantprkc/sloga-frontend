// Specs for utterance segmentation — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/transcription/vadSegmenter.test.ts
//
// The gates here decide what the speech model is allowed to see, and the
// expensive mistake is the one that lets near-silence through: Whisper answers
// noise with fluent invented sentences, which land in the transcript attributed
// to a real person. So several of these tests assert that NOTHING comes out.
import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_VAD_OPTIONS, VadSegmenter } from "./vadSegmenter.ts";

const RATE = DEFAULT_VAD_OPTIONS.sampleRate;

/** Samples for `ms` of audio at a given amplitude, as a plausible waveform. */
function tone(ms: number, amplitude: number): Float32Array {
  const samples = new Float32Array(Math.round((ms / 1000) * RATE));
  for (let i = 0; i < samples.length; i++) {
    // 220 Hz: inside the range a voice occupies, so RMS behaves like speech.
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / RATE) * amplitude;
  }
  return samples;
}

/** Loud enough to be a voice. A sine's RMS is amplitude / sqrt(2). */
const speech = (ms: number) => tone(ms, 0.2);
/** Digital silence. */
const silence = (ms: number) =>
  new Float32Array(Math.round((ms / 1000) * RATE));
/** Room tone: audible, but nowhere near a voice. */
const quietNoise = (ms: number) => tone(ms, 0.004);

function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

test("emits an utterance once the speaker pauses", () => {
  const vad = new VadSegmenter();

  // Mid-utterance there is nothing to emit — the sentence is not over.
  assert.deepEqual(vad.push(speech(1000)), []);
  assert.equal(vad.speaking, true);

  const segments = vad.push(silence(900));
  assert.equal(segments.length, 1);
  assert.equal(vad.speaking, false);

  const [segment] = segments;
  assert.ok(segment.speechMs >= 900, `only ${segment.speechMs}ms voiced`);
  // The pause itself is trimmed, bar a short tail.
  assert.ok(
    segment.endMs - segment.startMs < 1400,
    `segment ran to ${segment.endMs - segment.startMs}ms`,
  );
});

test("keeps audio from before the onset so words are not clipped", () => {
  const vad = new VadSegmenter();
  vad.push(silence(500));
  const [segment] = vad.push(concat(speech(800), silence(900)));

  // The utterance starts BEFORE the moment speech was detected.
  assert.ok(
    segment.startMs < 500,
    `expected pre-roll before 500ms, started at ${segment.startMs}ms`,
  );
  assert.ok(segment.startMs >= 500 - DEFAULT_VAD_OPTIONS.preRollMs - 40);
});

test("separates two utterances across a pause", () => {
  const vad = new VadSegmenter();
  const segments = vad.push(
    concat(speech(700), silence(900), speech(700), silence(900)),
  );

  assert.equal(segments.length, 2);
  assert.ok(
    segments[1].startMs > segments[0].endMs,
    "the second utterance must begin after the first ends",
  );
});

test("a brief noise burst is not an utterance", () => {
  // A door, a cough, a chair — long enough to cross the frame threshold,
  // too short to be speech. This is the shape that produces a hallucinated
  // sentence attributed to whoever's mic picked it up.
  const vad = new VadSegmenter();
  assert.deepEqual(vad.push(concat(speech(120), silence(900))), []);
});

test("sustained room tone is not an utterance", () => {
  // Long enough to pass a duration gate, far too quiet to be a voice: this is
  // what the mean-RMS gate exists for.
  const vad = new VadSegmenter();
  const segments = vad.push(concat(quietNoise(4000), silence(900)));
  assert.deepEqual(segments, []);
});

test("silence alone produces nothing", () => {
  const vad = new VadSegmenter();
  assert.deepEqual(vad.push(silence(5000)), []);
  assert.deepEqual(vad.flush(), []);
});

test("cuts a monologue at the ceiling instead of buffering it forever", () => {
  const vad = new VadSegmenter();
  const segments = vad.push(speech(35_000));

  assert.ok(
    segments.length >= 2,
    `expected repeated cuts, got ${segments.length}`,
  );
  for (const segment of segments) {
    assert.ok(
      segment.endMs - segment.startMs <= DEFAULT_VAD_OPTIONS.maxSegmentMs + 40,
      `segment of ${segment.endMs - segment.startMs}ms exceeds the ceiling`,
    );
  }
  // Contiguous: a forced cut must not duplicate or drop audio between pieces.
  for (let i = 1; i < segments.length; i++) {
    assert.equal(segments[i].startMs, segments[i - 1].endMs);
  }
  // Still talking when the chunk ran out.
  assert.equal(vad.speaking, true);
});

test("flush emits the sentence a departing participant was mid-way through", () => {
  // Their track is about to be torn down; whatever is buffered is the last
  // thing they said, and it is the part someone will go looking for.
  const vad = new VadSegmenter();
  vad.push(speech(900));
  assert.equal(vad.speaking, true);

  const flushed = vad.flush();
  assert.equal(flushed.length, 1);
  assert.ok(flushed[0].speechMs >= 800);

  // Idempotent — teardown can race the user.
  assert.deepEqual(vad.flush(), []);
});

test("flush drops a fragment too short to be speech", () => {
  const vad = new VadSegmenter();
  vad.push(speech(120));
  assert.deepEqual(vad.flush(), []);
});

test("timestamps follow the audio, not the delivery", () => {
  // Chunk sizes are whatever the worklet hands over; identical audio must
  // produce identical timings however it is sliced.
  const audio = concat(silence(400), speech(900), silence(900));

  const whole = new VadSegmenter().push(audio);
  const dribbled: ReturnType<VadSegmenter["push"]> = [];
  const vad = new VadSegmenter();
  for (let at = 0; at < audio.length; at += 331) {
    dribbled.push(...vad.push(audio.subarray(at, at + 331)));
  }

  assert.equal(whole.length, 1);
  assert.equal(dribbled.length, 1);
  assert.equal(dribbled[0].startMs, whole[0].startMs);
  assert.equal(dribbled[0].endMs, whole[0].endMs);
});

test("the returned audio matches the segment's own timing", () => {
  const vad = new VadSegmenter();
  const [segment] = vad.push(concat(speech(1000), silence(900)));

  const expected = Math.round(
    ((segment.endMs - segment.startMs) / 1000) * RATE,
  );
  assert.equal(segment.pcm.length, expected);
});

test("a late arrival's speech is timed from when they joined, not from zero", () => {
  // One segmenter per speaker, each counting from its own first sample. Without
  // an origin, someone who joins 40s into a transcript times their first word
  // at ~0 and sorts to the TOP, scrambling the conversation. Everyone present
  // at the start gets origin 0, which is why a two-party call reads correctly
  // and only a late arrival exposes this.
  const audio = concat(silence(200), speech(900), silence(900));

  const fromStart = new VadSegmenter().push(audio);
  const lateJoiner = new VadSegmenter({ originMs: 40_000 }).push(audio);

  assert.equal(fromStart.length, 1);
  assert.equal(lateJoiner.length, 1);
  assert.equal(lateJoiner[0].startMs, fromStart[0].startMs + 40_000);
  assert.equal(lateJoiner[0].endMs, fromStart[0].endMs + 40_000);
  // The audio itself is untouched — only where it sits on the timeline moved.
  assert.equal(lateJoiner[0].speechMs, fromStart[0].speechMs);
  assert.equal(lateJoiner[0].pcm.length, fromStart[0].pcm.length);
});

test("the origin also applies to a flushed final utterance", () => {
  // A late joiner who leaves mid-sentence must not have their last words
  // relocated to the start of the transcript either.
  const vad = new VadSegmenter({ originMs: 12_000 });
  vad.push(speech(900));
  const [segment] = vad.flush();

  assert.ok(
    segment.startMs >= 12_000,
    `expected the flush to carry the origin, got ${segment.startMs}`,
  );
});

test("a quieter mic still transcribes when the threshold is lowered", () => {
  // The gates are defaults, not laws: the seam has to stay tunable for a
  // shell whose capture chain is quieter than Chrome's. A sine's RMS is
  // amplitude / sqrt(2), so 0.013 lands at ~0.0092 — under the default
  // threshold, over the lenient one.
  const audio = concat(tone(900, 0.013), silence(900));

  assert.deepEqual(new VadSegmenter().push(audio), []);
  const lenient = new VadSegmenter({
    silenceThreshold: 0.005,
    minSegmentRms: 0.008,
  });
  assert.equal(lenient.push(audio).length, 1);
});
