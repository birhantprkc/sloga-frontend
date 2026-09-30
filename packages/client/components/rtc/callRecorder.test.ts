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
// overwrites someone's recording. `CallRecorder`'s audio graph needs
// MediaRecorder + AudioContext, so the recording itself is covered by the live
// legs; WHICH tracks it mixes (the watched-share filter, at the end of this
// file) runs here against minimal stand-ins for those globals and the room.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { type Room, RoomEvent, Track } from "livekit-client";

import {
  CallRecorder,
  MIME_CANDIDATES,
  isSaveCancelled,
  recordingFilename,
  recordsRemoteAudio,
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

// ---------------------------------------------------------------------------
// Watched-share filter (plan decision A; wave 3 audit follow-up). Screen
// shares are opt-in, but the SFU can still push a subscription we never asked
// for. A recording must hold only the audio the user chose to hear: remote
// microphones, whispers addressed to us, and the audio of the shares they are
// WATCHING.

const WATCHED: ReadonlySet<string> = new Set(["alice:d1"]);
const NONE: ReadonlySet<string> = new Set();

/** The share rules alone: a track with no addressee, decided as user "me". */
const recordsUnaddressed = (
  source: string,
  identity: string,
  watched: ReadonlySet<string>,
) => recordsRemoteAudio(source, identity, watched, "", "me");

// Whispers publish as `"unknown"` under the track name `whisper:{userId}`
// (whisper.ts, whisperPermissions.ts).

test("a whisper addressed to us is recorded", () => {
  assert.equal(
    recordsRemoteAudio("unknown", "bob:d1", NONE, "whisper:me", "me"),
    true,
  );
  assert.equal(
    recordsRemoteAudio("unknown", "bob:d1", WATCHED, "whisper:me", "me"),
    true,
  );
});

test("a remote track with no addressee is recorded whoever sent it", () => {
  for (const source of ["microphone", "unknown"]) {
    for (const trackName of ["", undefined, "mic", "whisper:"]) {
      assert.equal(
        recordsRemoteAudio(source, "bob:d1", NONE, trackName, "me"),
        true,
        `${source} ${String(trackName)}`,
      );
    }
    assert.equal(recordsUnaddressed(source, "bob:d1", WATCHED), true, source);
  }
});

test("a whisper addressed to someone else is left out", () => {
  // The SFU should never deliver it; if it does, the file must not hold it.
  assert.equal(
    recordsRemoteAudio("unknown", "bob:d1", NONE, "whisper:carol", "me"),
    false,
  );
  assert.equal(
    recordsRemoteAudio("microphone", "bob:d1", NONE, "whisper:carol", "me"),
    false,
  );
  // A watch on the sender does not admit it, whatever its source.
  assert.equal(
    recordsRemoteAudio(
      "screen_share_audio",
      "alice:d1",
      WATCHED,
      "whisper:carol",
      "me",
    ),
    false,
  );
  // The addressee is a USER id: our device-qualified identity never matches.
  assert.equal(
    recordsRemoteAudio("unknown", "bob:d1", NONE, "whisper:me:d0", "me"),
    false,
  );
});

test("with our own id unknown, every addressed whisper is left out", () => {
  for (const target of ["me", "carol"]) {
    assert.equal(
      recordsRemoteAudio(
        "unknown",
        "bob:d1",
        NONE,
        `whisper:${target}`,
        undefined,
      ),
      false,
      target,
    );
  }
  // Tracks with no addressee are unaffected.
  assert.equal(
    recordsRemoteAudio("microphone", "bob:d1", NONE, "", undefined),
    true,
  );
});

test("an unwatched share's audio is left out of the recording", () => {
  assert.equal(recordsUnaddressed("screen_share_audio", "bob:d1", NONE), false);
  assert.equal(
    recordsUnaddressed("screen_share_audio", "bob:d1", WATCHED),
    false,
  );
});

test("a watched share's audio is recorded", () => {
  assert.equal(
    recordsUnaddressed("screen_share_audio", "alice:d1", WATCHED),
    true,
  );
});

test("a watch covers its exact device-qualified identity and nothing else", () => {
  // The watch set is keyed like `watchShare`: the LiveKit identity, never the
  // user id. A device and its screen leg are different shares, and so is the
  // same user's other device.
  for (const other of ["alice:d1:screen", "alice:d2", "alice"]) {
    assert.equal(
      recordsUnaddressed("screen_share_audio", other, WATCHED),
      false,
      other,
    );
  }
  const legWatched: ReadonlySet<string> = new Set(["alice:d1:screen"]);
  assert.equal(
    recordsUnaddressed("screen_share_audio", "alice:d1:screen", legWatched),
    true,
  );
  assert.equal(
    recordsUnaddressed("screen_share_audio", "alice:d1", legWatched),
    false,
  );
});

test("video sources: camera is not the filter's call, share video fails closed", () => {
  // Video never reaches the mix (the recorder keeps `Track.Kind.Audio` only),
  // so this pins what the FILTER says if it is ever asked: the camera is not
  // a share, and a share's video source is gated like its audio.
  assert.equal(recordsUnaddressed("camera", "bob:d1", NONE), true);
  assert.equal(recordsUnaddressed("screen_share", "bob:d1", NONE), false);
  assert.equal(recordsUnaddressed("screen_share", "alice:d1", WATCHED), true);
});

test("the filter's source strings are livekit's own Track.Source values", () => {
  // The filter compares plain strings; an SDK rename must fail here, not
  // silently record every share.
  assert.equal(Track.Source.ScreenShareAudio, "screen_share_audio");
  assert.equal(Track.Source.ScreenShare, "screen_share");
  assert.equal(Track.Source.Microphone, "microphone");
  assert.equal(Track.Source.Unknown, "unknown");
});

// The recorder wiring, against stand-ins: an audio graph that records which
// MediaStreamTrack ids are connected to the mix, a MediaRecorder that only
// stops, and a Room that is an EventEmitter with the two participant maps.

interface FakeMediaTrack {
  id: string;
  kind: "audio";
}

interface FakePub {
  trackSid: string;
  kind: "audio";
  source: string;
  trackName: string;
  track?: { kind: "audio"; mediaStreamTrack: FakeMediaTrack };
}

interface FakeParticipant {
  identity: string;
  trackPublications: Map<string, FakePub>;
}

class FakeRoom extends EventEmitter {
  remoteParticipants = new Map<string, FakeParticipant>();
  localParticipant: FakeParticipant = {
    identity: "me:d0",
    trackPublications: new Map(),
  };

  join(identity: string, ...pubs: FakePub[]): FakeParticipant {
    const participant: FakeParticipant = {
      identity,
      trackPublications: new Map(pubs.map((pub) => [pub.trackSid, pub])),
    };
    this.remoteParticipants.set(identity, participant);
    return participant;
  }
}

/**
 * An audio publication; `withTrack` false = desired but not yet flowing.
 * `trackName` is `whisper:{userId}` for a whisper, empty otherwise.
 */
function audioPub(
  sid: string,
  source: string,
  withTrack = true,
  trackName = "",
): FakePub {
  return {
    trackSid: sid,
    kind: "audio",
    source,
    trackName,
    track: withTrack
      ? { kind: "audio", mediaStreamTrack: { id: sid, kind: "audio" } }
      : undefined,
  };
}

const STAND_INS = ["MediaRecorder", "AudioContext", "MediaStream"] as const;

async function withAudioStandIns(
  run: (mixed: ReadonlySet<string>) => Promise<void>,
): Promise<void> {
  const mixed = new Set<string>();
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = STAND_INS.map((name) => g[name]);

  g.MediaStream = class {
    tracks: FakeMediaTrack[];
    constructor(tracks: FakeMediaTrack[]) {
      this.tracks = tracks;
    }
  };
  g.AudioContext = class {
    state = "running";
    createMediaStreamDestination() {
      return { stream: {} };
    }
    createMediaStreamSource(stream: { tracks: FakeMediaTrack[] }) {
      const id = stream.tracks[0].id;
      return {
        connect: () => mixed.add(id),
        disconnect: () => mixed.delete(id),
      };
    }
    close() {
      return Promise.resolve();
    }
  };
  g.MediaRecorder = class extends EventTarget {
    static isTypeSupported(type: string) {
      return type === "audio/webm";
    }
    state = "inactive";
    mimeType = "audio/webm";
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.dispatchEvent(new Event("stop"));
    }
  };

  try {
    await run(mixed);
  } finally {
    STAND_INS.forEach((name, i) => {
      if (saved[i] === undefined) delete g[name];
      else g[name] = saved[i];
    });
  }
}

const sorted = (mixed: ReadonlySet<string>) => [...mixed].sort();

test("the recorder mixes the call, and no unwatched share, as tracks arrive", async () => {
  await withAudioStandIns(async (mixed) => {
    const room = new FakeRoom();
    const watched: ReadonlySet<string> = new Set(["alice:d1"]);
    room.join(
      "alice:d1",
      audioPub("A-mic", "microphone"),
      audioPub("A-ssa", "screen_share_audio"),
    );
    // Bob's share audio is subscribed though nobody watches it: a push.
    room.join(
      "bob:d1",
      audioPub("B-mic", "microphone"),
      audioPub("B-ssa", "screen_share_audio"),
    );
    // Our own tracks are never filtered, share audio included.
    room.localParticipant.trackPublications.set(
      "L-ssa",
      audioPub("L-ssa", "screen_share_audio"),
    );

    const recorder = new CallRecorder(
      room as unknown as Room,
      () => undefined,
      undefined,
      () => watched,
    );
    await recorder.start();
    assert.deepEqual(sorted(mixed), ["A-mic", "A-ssa", "B-mic", "L-ssa"]);

    // Late arrivals go through the same filter.
    const carol = room.join("carol:d1");
    const mic = audioPub("C-mic", "microphone");
    const share = audioPub("C-ssa", "screen_share_audio");
    room.emit(RoomEvent.TrackSubscribed, share.track, share, carol);
    room.emit(RoomEvent.TrackSubscribed, mic.track, mic, carol);
    const alice = room.remoteParticipants.get("alice:d1");
    const aliceSecond = audioPub("A-ssa2", "screen_share_audio");
    room.emit(RoomEvent.TrackSubscribed, aliceSecond.track, aliceSecond, alice);
    assert.deepEqual(sorted(mixed), [
      "A-mic",
      "A-ssa",
      "A-ssa2",
      "B-mic",
      "C-mic",
      "L-ssa",
    ]);

    // The ordinary unsubscribe path still takes a track out.
    room.emit(RoomEvent.TrackUnsubscribed, mic.track, mic, carol);
    assert.equal(mixed.has("C-mic"), false);

    await recorder.stop();
  });
});

test("a Watch or Stop watching mid-recording moves the share in or out at once", async () => {
  await withAudioStandIns(async (mixed) => {
    const room = new FakeRoom();
    let watched: ReadonlySet<string> = new Set();
    const mic = audioPub("B-mic", "microphone");
    const share = audioPub("B-ssa", "screen_share_audio");
    const bob = room.join("bob:d1", mic, share);

    const recorder = new CallRecorder(
      room as unknown as Room,
      () => undefined,
      undefined,
      () => watched,
    );
    await recorder.start();
    assert.deepEqual(sorted(mixed), ["B-mic"]);

    // Watch a share the SFU had ALREADY pushed: no new TrackSubscribed, only
    // the status change `setSubscribed(true)` emits. The watch set is a new
    // object, as the real signal's is, so a snapshot would miss it.
    watched = new Set(["bob:d1"]);
    room.emit(
      RoomEvent.TrackSubscriptionStatusChanged,
      share,
      "subscribed",
      bob,
    );
    assert.deepEqual(sorted(mixed), ["B-mic", "B-ssa"]);

    // Stop watching: out on the status change alone, even if the SFU never
    // follows with a TrackUnsubscribed.
    watched = new Set();
    room.emit(
      RoomEvent.TrackSubscriptionStatusChanged,
      share,
      "unsubscribed",
      bob,
    );
    assert.deepEqual(sorted(mixed), ["B-mic"]);

    // A status change on a microphone never drops it.
    room.emit(
      RoomEvent.TrackSubscriptionStatusChanged,
      mic,
      "unsubscribed",
      bob,
    );
    assert.deepEqual(sorted(mixed), ["B-mic"]);

    // Watched but not yet flowing: nothing to add, and no throw.
    const pending = audioPub("B-ssa2", "screen_share_audio", false);
    watched = new Set(["bob:d1"]);
    room.emit(
      RoomEvent.TrackSubscriptionStatusChanged,
      pending,
      "desired",
      bob,
    );
    assert.deepEqual(sorted(mixed), ["B-mic"]);

    await recorder.stop();
  });
});

test("without a watch-set getter, no remote share audio is recorded", async () => {
  await withAudioStandIns(async (mixed) => {
    const room = new FakeRoom();
    room.join(
      "alice:d1",
      audioPub("A-mic", "microphone"),
      audioPub("A-ssa", "screen_share_audio"),
    );
    // The original three-argument shape still constructs, and fails closed.
    const recorder = new CallRecorder(room as unknown as Room, () => undefined);
    await recorder.start();
    assert.deepEqual(sorted(mixed), ["A-mic"]);
    await recorder.stop();
  });
});

test("a watch change lost in a signal resume is applied on Reconnected", async () => {
  await withAudioStandIns(async (mixed) => {
    const room = new FakeRoom();
    let watched: ReadonlySet<string> = new Set(["bob:d1"]);
    room.join(
      "bob:d1",
      audioPub("B-mic", "microphone"),
      audioPub("B-ssa", "screen_share_audio"),
    );

    const recorder = new CallRecorder(
      room as unknown as Room,
      () => undefined,
      undefined,
      () => watched,
    );
    await recorder.start();
    assert.deepEqual(sorted(mixed), ["B-mic", "B-ssa"]);

    // Stop watching during a resume: livekit drops the buffered status change
    // at SignalResumed, so NO event reaches the recorder and the share stays.
    watched = new Set();
    assert.deepEqual(sorted(mixed), ["B-mic", "B-ssa"]);
    room.emit(RoomEvent.Reconnected);
    assert.deepEqual(sorted(mixed), ["B-mic"]);

    // And back: a Watch lost the same way is applied on the next Reconnected.
    watched = new Set(["bob:d1"]);
    room.emit(RoomEvent.Reconnected);
    assert.deepEqual(sorted(mixed), ["B-mic", "B-ssa"]);

    // The resync is idempotent, and a watched share with no track yet is
    // skipped without a throw.
    room.join("carol:d1", audioPub("C-ssa", "screen_share_audio", false));
    watched = new Set(["bob:d1", "carol:d1"]);
    room.emit(RoomEvent.Reconnected);
    room.emit(RoomEvent.Reconnected);
    assert.deepEqual(sorted(mixed), ["B-mic", "B-ssa"]);

    await recorder.stop();
  });
});

test("a whisper the SFU pushes for someone else is never mixed", async () => {
  await withAudioStandIns(async (mixed) => {
    const room = new FakeRoom(); // we are "me:d0", user "me"
    const toCarol = audioPub("B-w-carol", "unknown", true, "whisper:carol");
    const bob = room.join(
      "bob:d1",
      audioPub("B-mic", "microphone"),
      audioPub("B-w-me", "unknown", true, "whisper:me"),
      toCarol,
    );

    const recorder = new CallRecorder(
      room as unknown as Room,
      () => undefined,
      undefined,
      () => NONE,
    );
    await recorder.start();
    // Present at Record: ours and the mic are in, carol's whisper is not.
    assert.deepEqual(sorted(mixed), ["B-mic", "B-w-me"]);

    // Pushed later, through every path that can add a track.
    const late = audioPub("B-w-carol2", "unknown", true, "whisper:carol");
    bob.trackPublications.set(late.trackSid, late);
    room.emit(RoomEvent.TrackSubscribed, late.track, late, bob);
    room.emit(
      RoomEvent.TrackSubscriptionStatusChanged,
      toCarol,
      "subscribed",
      bob,
    );
    room.emit(RoomEvent.Reconnected);
    assert.deepEqual(sorted(mixed), ["B-mic", "B-w-me"]);

    // Our own identity unknown: even a whisper addressed to "me" is refused.
    room.localParticipant.identity = "";
    const unsure = audioPub("B-w-me2", "unknown", true, "whisper:me");
    room.emit(RoomEvent.TrackSubscribed, unsure.track, unsure, bob);
    assert.deepEqual(sorted(mixed), ["B-mic", "B-w-me"]);

    await recorder.stop();
  });
});

test("stop() detaches every room listener it attached", async () => {
  await withAudioStandIns(async () => {
    const room = new FakeRoom();
    const recorder = new CallRecorder(
      room as unknown as Room,
      () => undefined,
      undefined,
      () => NONE,
    );
    await recorder.start();
    assert.ok(
      room.listenerCount(RoomEvent.TrackSubscriptionStatusChanged) > 0,
      "the status listener must be attached while recording",
    );
    assert.ok(
      room.listenerCount(RoomEvent.Reconnected) > 0,
      "the reconnect resync must be attached while recording",
    );
    await recorder.stop();
    assert.deepEqual(room.eventNames(), []);
  });
});
