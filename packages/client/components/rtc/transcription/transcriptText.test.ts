// Specs for the post-model sanity check — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/transcription/transcriptText.test.ts
//
// The strings asserted here are not hypothetical. `" you"` is what
// onnx-community/whisper-tiny actually returned in this project for three
// seconds of digital silence AND for two seconds of -54 dB noise.
import assert from "node:assert/strict";
import { test } from "node:test";

import { cleanTranscript, isLikelyHallucination } from "./transcriptText.ts";

test("the artefact this model actually produces for silence is rejected", () => {
  assert.equal(isLikelyHallucination(" you"), true);
  assert.equal(isLikelyHallucination("You."), true);
  assert.equal(isLikelyHallucination("  YOU  "), true);
});

test("rejects the rest of the subtitle-corpus boilerplate", () => {
  for (const artefact of [
    "Thank you.",
    "Thanks for watching!",
    "Bye.",
    "Please subscribe",
    "so",
    "The",
  ]) {
    assert.equal(
      isLikelyHallucination(artefact),
      true,
      `${JSON.stringify(artefact)} should be rejected`,
    );
  }
});

test("rejects bracketed sound events", () => {
  assert.equal(isLikelyHallucination("[MUSIC]"), true);
  assert.equal(isLikelyHallucination("(applause)"), true);
  assert.equal(isLikelyHallucination("*laughs*"), true);
});

test("rejects empty and punctuation-only output", () => {
  assert.equal(isLikelyHallucination(""), true);
  assert.equal(isLikelyHallucination("   "), true);
  assert.equal(isLikelyHallucination("..."), true);
  assert.equal(isLikelyHallucination("?!"), true);
});

test("real speech is kept, including sentences that contain those words", () => {
  // The match is against the WHOLE output, so ordinary sentences survive.
  for (const real of [
    "thank you for setting that up",
    "you were right about the migration",
    "so I think we should ship it",
    "bye for now, I'll be back at three",
    "the deploy finished",
  ]) {
    assert.equal(
      isLikelyHallucination(real),
      false,
      `${JSON.stringify(real)} should be kept`,
    );
  }
});

test("a short lone word needs real speech behind it", () => {
  // Duration disagreement is the signal: two seconds of audio that transcribe
  // to one three-letter word is the shape every known artefact takes.
  assert.equal(isLikelyHallucination("hm", 300), true);
  assert.equal(isLikelyHallucination("hm", 1500), false);
  // Without a duration there is nothing to disagree with, so it is kept.
  assert.equal(isLikelyHallucination("hm"), false);
});

test("cleanTranscript returns undefined for anything discarded", () => {
  assert.equal(cleanTranscript(" you"), undefined);
  assert.equal(cleanTranscript("   "), undefined);
  assert.equal(cleanTranscript("[MUSIC]"), undefined);
});

test("cleanTranscript strips Whisper's leading space and tidies whitespace", () => {
  assert.equal(
    cleanTranscript(" And so my fellow  Americans"),
    "And so my fellow Americans",
  );
});

test("collapses a phrase the model got stuck repeating", () => {
  // Whisper latches onto a phrase on degraded audio and emits it until the
  // segment runs out. One is a person; a dozen is a loop.
  assert.equal(
    cleanTranscript("okay okay okay okay okay okay okay okay"),
    "okay",
  );
  assert.equal(
    cleanTranscript("see you later see you later see you later"),
    "see you later",
  );
});

test("does not collapse ordinary repetition in real speech", () => {
  assert.equal(
    cleanTranscript("no no I meant the other one"),
    "no no I meant the other one",
  );
  assert.equal(
    cleanTranscript("that is very very good news for us"),
    "that is very very good news for us",
  );
});
