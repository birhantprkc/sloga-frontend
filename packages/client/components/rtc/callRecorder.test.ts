// Unit spec for the pure half of local call recording — run with Node's
// built-in runner:
//   node --conditions=browser --test components/rtc/callRecorder.test.ts
//
// `--conditions=browser` is required for the same reason as every other spec
// in this directory (Node otherwise resolves solid-js to its server build,
// where `createEffect` is a no-op). Nothing here uses reactivity, but the
// flag keeps the whole directory runnable with one command.
//
// What is testable without a DOM is the FILENAME, and it is worth testing:
// it is the only part of the recorder a user sees after the call, it has to
// survive channel names people actually use, and a collision silently
// overwrites someone's recording. `CallRecorder` itself needs MediaRecorder +
// AudioContext, so it is covered by the live legs rather than here.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MIME_CANDIDATES,
  isSaveCancelled,
  recordingFilename,
} from "./callRecorder.ts";

/** 2026-07-29 14:05 local time, as a millisecond epoch. */
const AT = new Date(2026, 6, 29, 14, 5, 0).getTime();

test("names the file after the channel and the local start time", () => {
  assert.equal(
    recordingFilename("general", AT, "audio/webm;codecs=opus"),
    "general-2026-07-29-1405.webm",
  );
});

test("maps each container to the extension its players expect", () => {
  assert.equal(
    recordingFilename("a", AT, "audio/ogg;codecs=opus"),
    "a-2026-07-29-1405.ogg",
  );
  assert.equal(
    recordingFilename("a", AT, "audio/mp4"),
    "a-2026-07-29-1405.m4a",
  );
  // Anything unrecognised falls back to webm rather than producing a file with
  // no extension, which Windows refuses to open at all.
  assert.equal(recordingFilename("a", AT, ""), "a-2026-07-29-1405.webm");
});

test("strips characters Windows rejects outright", () => {
  // A channel called `dev/ops: "the sequel"?` is entirely legal in-app and
  // would produce an unwritable path on NTFS.
  const name = recordingFilename('dev/ops: "the sequel"?', AT, "audio/webm");
  assert.equal(name, "devops-the-sequel-2026-07-29-1405.webm");
  assert.doesNotMatch(name, /[\\/:*?"<>|]/);
});

test("collapses whitespace so the name survives a shell without quoting", () => {
  assert.equal(
    recordingFilename("  team   standup  ", AT, "audio/webm"),
    "team-standup-2026-07-29-1405.webm",
  );
});

test("falls back to 'call' when there is no usable channel name", () => {
  assert.equal(
    recordingFilename(undefined, AT, "audio/webm"),
    "call-2026-07-29-1405.webm",
  );
  // A name made ENTIRELY of stripped characters must not leave a filename
  // that begins with the separator (`-2026-…` reads as a flag to CLI tools).
  assert.equal(
    recordingFilename("///", AT, "audio/webm"),
    "call-2026-07-29-1405.webm",
  );
  assert.equal(
    recordingFilename("???", AT, "audio/webm"),
    "call-2026-07-29-1405.webm",
  );
});

test("keeps long channel names bounded but still recognisable", () => {
  const name = recordingFilename("x".repeat(200), AT, "audio/webm");
  assert.ok(name.length < 80, `expected a bounded name, got ${name.length}`);
  assert.ok(name.startsWith("xxx"));
});

test("two recordings a minute apart cannot overwrite each other", () => {
  const first = recordingFilename("general", AT, "audio/webm");
  const second = recordingFilename("general", AT + 60_000, "audio/webm");
  assert.notEqual(first, second);
});

// The container ORDER is a product decision, not an implementation detail, and
// it looks exactly like a list someone would "tidy" back into codec-quality
// order. AAC leads because the recording LEAVES the app — plenty of ordinary
// desktop software still refuses a .webm audio file, and a recording you cannot
// open is worth nothing. Opus-in-WebM is the better codec and the wrong default.
test("AAC is preferred over Opus, because the file has to open elsewhere", () => {
  assert.equal(
    MIME_CANDIDATES[0],
    "audio/mp4",
    "AAC must be tried first — see the comment on MIME_CANDIDATES",
  );
  // Opus must still be present as the fallback for shells with no AAC encoder.
  assert.ok(
    MIME_CANDIDATES.some((type) => type.includes("opus")),
    "an Opus fallback must remain for shells that cannot encode AAC",
  );
  // And every candidate must map to an extension the filename helper knows,
  // or a file lands with a name its own player will reject.
  for (const type of MIME_CANDIDATES) {
    const name = recordingFilename("c", AT, type);
    assert.match(name, /\.(m4a|webm|ogg)$/, `unmapped container: ${type}`);
  }
});

// A cancelled save dialog must read as a DECISION, not a failure: it decides
// whether the click leaves an error on screen, and whether the recording claim
// (which is sent to everyone in the call) goes out at all.
test("a cancelled file picker is recognised, and nothing else is", () => {
  const abort = new Error("The user aborted a request.");
  abort.name = "AbortError";
  assert.equal(isSaveCancelled(abort), true);

  assert.equal(isSaveCancelled(new Error("disk full")), false);
  assert.equal(isSaveCancelled({ name: "NotAllowedError" }), false);
  assert.equal(isSaveCancelled(undefined), false);
  assert.equal(isSaveCancelled(null), false);
  assert.equal(isSaveCancelled("AbortError"), false);
});

test("names sort chronologically as strings", () => {
  // Zero-padding is what makes this true; without it "2026-7-9" sorts after
  // "2026-11-1" and a directory listing stops being a timeline.
  const names = [
    recordingFilename("c", new Date(2026, 10, 1, 9, 5).getTime(), "audio/webm"),
    recordingFilename(
      "c",
      new Date(2026, 6, 9, 14, 30).getTime(),
      "audio/webm",
    ),
    recordingFilename("c", new Date(2026, 6, 9, 9, 5).getTime(), "audio/webm"),
  ];
  assert.deepEqual([...names].sort(), [names[2], names[1], names[0]]);
});
