// Specs for transcript export — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/transcription/transcriptExport.test.ts
//
// These files leave the app, so they have to be valid for a player or an editor
// that knows nothing about us — and they carry display names typed by other
// people, which is the part that can quietly corrupt the format.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type TranscriptSegment,
  toTxt,
  toVtt,
  transcriptFilename,
} from "./transcriptExport.ts";

/** 2026-07-30 14:05 local time. */
const AT = new Date(2026, 6, 30, 14, 5, 0).getTime();

const NAMES = new Map([
  ["u1", "Jeff"],
  ["u2", "Sam"],
]);

function segment(over: Partial<TranscriptSegment> = {}): TranscriptSegment {
  return {
    id: "s1",
    identity: "u1",
    startMs: 1000,
    endMs: 3500,
    text: "hello there",
    ...over,
  };
}

test("writes a VTT a player will accept", () => {
  const vtt = toVtt([segment()], NAMES);

  assert.equal(
    vtt,
    [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:03.500",
      "<v Jeff>hello there",
      "",
    ].join("\n"),
  );
});

test("VTT timings carry hours and milliseconds", () => {
  const vtt = toVtt([segment({ startMs: 3_723_004, endMs: 3_725_000 })], NAMES);
  assert.match(vtt, /^01:02:03\.004 --> 01:02:05\.000$/m);
});

test("cues are numbered in sequence", () => {
  const vtt = toVtt(
    [
      segment({ id: "a", startMs: 0, endMs: 1000 }),
      segment({ id: "b", identity: "u2", startMs: 2000, endMs: 3000 }),
    ],
    NAMES,
  );
  assert.match(vtt, /\n1\n/);
  assert.match(vtt, /\n2\n/);
  assert.match(vtt, /<v Sam>/);
});

test("a display name cannot break out of the voice tag", () => {
  // Names are typed by other people. `<` and `>` inside a cue payload are
  // markup, so an unescaped one swallows the rest of the line.
  const vtt = toVtt([segment()], { u1: "<b>Jeff</b>" });

  // Angle brackets become spaces rather than vanishing, so the remaining
  // characters cannot silently fuse into a different word.
  assert.match(vtt, /<v b Jeff \/b>hello there/);
  assert.doesNotMatch(vtt, /<b>/);
  // Exactly one tag on the line: the one we opened.
  const cue = vtt.split("\n").find((line) => line.startsWith("<v "))!;
  assert.equal(cue.slice(3).split(">")[0].includes("<"), false);
});

test("a newline in a name cannot terminate the cue", () => {
  const vtt = toVtt([segment()], {
    u1: "Jeff\n\n00:00:00.000 --> 00:00:01.000",
  });
  const arrows = vtt.match(/-->/g) ?? [];
  assert.equal(arrows.length, 1, "a name must not be able to forge a cue");
});

test("a blank line inside an utterance cannot split the cue", () => {
  const vtt = toVtt([segment({ text: "hello\n\n\nthere" })], NAMES);
  assert.match(vtt, /<v Jeff>hello\nthere/);
  assert.equal((vtt.match(/-->/g) ?? []).length, 1);
});

test("an unknown speaker falls back to their identity", () => {
  const vtt = toVtt([segment({ identity: "ghost" })], NAMES);
  assert.match(vtt, /<v ghost>/);

  // ...and so does a blank name, rather than producing `<v >`.
  assert.match(toVtt([segment()], { u1: "   " }), /<v u1>/);
});

test("empty utterances are dropped rather than emitted as blank cues", () => {
  const vtt = toVtt(
    [segment({ text: "   " }), segment({ id: "s2", text: "real" })],
    NAMES,
  );
  assert.equal((vtt.match(/-->/g) ?? []).length, 1);
  assert.match(vtt, /<v Jeff>real/);
});

test("a zero-length utterance still gets a visible cue", () => {
  const vtt = toVtt([segment({ startMs: 5000, endMs: 5000 })], NAMES);
  assert.match(vtt, /00:00:05\.000 --> 00:00:05\.200/);
});

test("an empty transcript is still a valid VTT", () => {
  assert.equal(toVtt([], NAMES), "WEBVTT\n");
});

test("writes readable text with a header that says what the file is", () => {
  const txt = toTxt([segment()], NAMES, {
    channelName: "general",
    startedAt: AT,
  });

  assert.equal(
    txt,
    [
      "Transcript — general",
      "2026-07-30 14:05",
      "",
      "[0:01] Jeff: hello there",
      "",
    ].join("\n"),
  );
});

test("text timestamps grow an hours field only when needed", () => {
  const txt = toTxt(
    [
      segment({ startMs: 65_000 }),
      segment({ id: "s2", startMs: 3_725_000, identity: "u2" }),
    ],
    NAMES,
    { channelName: "general", startedAt: AT },
  );
  assert.match(txt, /\[1:05\] Jeff:/);
  assert.match(txt, /\[1:02:05\] Sam:/);
});

test("an empty transcript says so instead of looking truncated", () => {
  const txt = toTxt([], NAMES, { channelName: "general", startedAt: AT });
  assert.match(txt, /no speech was transcribed/);
});

test("a transcript is named to sit beside its recording", () => {
  // Same stem as `recordingFilename` produces for the same call, so the pair
  // sorts together in a folder.
  assert.equal(
    transcriptFilename("general", AT, "vtt"),
    "general-2026-07-30-1405.vtt",
  );
  assert.equal(
    transcriptFilename("general", AT, "txt"),
    "general-2026-07-30-1405.txt",
  );
  assert.equal(
    transcriptFilename(undefined, AT, "txt"),
    "call-2026-07-30-1405.txt",
  );
  assert.equal(
    transcriptFilename('dev/ops: "the sequel"?', AT, "vtt"),
    "devops-the-sequel-2026-07-30-1405.vtt",
  );
});
