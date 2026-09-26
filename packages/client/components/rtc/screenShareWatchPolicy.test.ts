// Unit spec for click-to-watch screen shares — run with Node's built-in
// runner, from packages/client:
//   node --test --conditions=browser components/rtc/screenShareWatchPolicy.test.ts
// Focus: no remote share (video or its audio) is subscribed until its
// identity is watched; mic, camera and whisper tracks are never gated; our own
// media is never pulled back down; a watch dies with its share; and a
// watch-set change only ever subscribes share AUDIO, never share video (the
// VideoTrack visibility observer owns that), while ending a watch releases
// both.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Track } from "livekit-client";

import {
  type ReconcilePub,
  type WatchPub,
  isShareSource,
  liveShareIdentities,
  pruneWatched,
  reconcileShareSubscriptions,
  SHARE_SOURCES,
  shouldSubscribeRemote,
  watchedAfterStop,
  watchedAfterWatch,
} from "./screenShareWatchPolicy.ts";

// Type-level pins, checked by tsc and erased at runtime. The module keeps no
// livekit-client import, so these tie its source strings to livekit-client's
// Track.Source values: a renamed enum value fails to compile here.
const SCREEN_SHARE: `${Track.Source.ScreenShare}` = "screen_share";
const SCREEN_SHARE_AUDIO: `${Track.Source.ScreenShareAudio}` =
  "screen_share_audio";
const PINNED_SHARE_SOURCES: readonly [
  typeof SCREEN_SHARE,
  typeof SCREEN_SHARE_AUDIO,
] = SHARE_SOURCES;

const ALICE = "alice:d1";
const ALICE_OTHER_DEVICE = "alice:d2";
const ALICE_LEG = "alice:d2:screen";
const BOB = "bob:d9";

/** A remote publication; each test overrides what it varies. */
function pub(identity: string, source: string, over?: Partial<WatchPub>) {
  return { identity, source, isLocal: false, isSelfLeg: false, ...over };
}

function rpub(
  identity: string,
  source: string,
  isDesired: boolean,
  over?: Partial<WatchPub>,
): ReconcilePub {
  return { ...pub(identity, source, over), isDesired };
}

const NONE: ReadonlySet<string> = new Set();

test("the share sources are LiveKit's Track.Source string values", () => {
  assert.deepEqual([...SHARE_SOURCES], [SCREEN_SHARE, SCREEN_SHARE_AUDIO]);
  assert.deepEqual(
    [...PINNED_SHARE_SOURCES],
    [SCREEN_SHARE, SCREEN_SHARE_AUDIO],
  );
  assert.equal(isShareSource(SCREEN_SHARE), true);
  assert.equal(isShareSource(SCREEN_SHARE_AUDIO), true);
  for (const other of ["microphone", "camera", "unknown", "", "ScreenShare"]) {
    assert.equal(isShareSource(other), false, other);
  }
});

test("mic, camera and whisper tracks pass through, watched or not", () => {
  // Non-share sources keep today's behavior: this gate never blocks them.
  for (const source of ["microphone", "camera", "unknown"]) {
    assert.equal(shouldSubscribeRemote(pub(BOB, source), NONE), true, source);
    assert.equal(
      shouldSubscribeRemote(pub(BOB, source), new Set([BOB])),
      true,
      source,
    );
  }
});

test("an unwatched remote share is never subscribed, video or audio", () => {
  for (const source of SHARE_SOURCES) {
    assert.equal(shouldSubscribeRemote(pub(BOB, source), NONE), false, source);
    // Watching someone else does not open this one.
    assert.equal(
      shouldSubscribeRemote(pub(BOB, source), new Set([ALICE])),
      false,
      source,
    );
  }
});

test("a watched remote share is subscribed, video and audio", () => {
  const watched = new Set([BOB]);
  for (const source of SHARE_SOURCES) {
    assert.equal(shouldSubscribeRemote(pub(BOB, source), watched), true);
  }
});

test("local media is never subscribed, whatever the source or watch", () => {
  const watched = new Set([ALICE]);
  for (const source of [...SHARE_SOURCES, "microphone", "camera", "unknown"]) {
    assert.equal(
      shouldSubscribeRemote(pub(ALICE, source, { isLocal: true }), watched),
      false,
      source,
    );
  }
});

test("our own screen leg is never subscribed, even if its identity is watched", () => {
  // The phone must not download its own screen showing its screen.
  const watched = new Set([ALICE_LEG]);
  for (const source of SHARE_SOURCES) {
    assert.equal(
      shouldSubscribeRemote(
        pub(ALICE_LEG, source, { isSelfLeg: true }),
        watched,
      ),
      false,
      source,
    );
  }
});

test("each device of the same user is a distinct watch", () => {
  // Keyed by device-qualified identity, never by user id.
  const watched = new Set([ALICE]);
  assert.equal(
    shouldSubscribeRemote(pub(ALICE, "screen_share"), watched),
    true,
  );
  assert.equal(
    shouldSubscribeRemote(pub(ALICE_OTHER_DEVICE, "screen_share"), watched),
    false,
  );
  // Another device's screen leg is a genuine remote share with its own key.
  assert.equal(
    shouldSubscribeRemote(pub(ALICE_LEG, "screen_share"), watched),
    false,
  );
  assert.equal(
    shouldSubscribeRemote(
      pub(ALICE_LEG, "screen_share"),
      new Set([ALICE_OTHER_DEVICE]),
    ),
    false,
  );
});

test("live share identities: video or audio-only shares, never own media", () => {
  const live = liveShareIdentities([
    pub(ALICE, "screen_share"),
    pub(BOB, "screen_share_audio"), // audio-only share counts as live
    pub("carol:d1", "microphone"),
    pub("carol:d1", "camera"),
    pub("dave:d1", "unknown"),
    pub("me:d1", "screen_share", { isLocal: true }),
    pub("me:d1:screen", "screen_share", { isSelfLeg: true }),
    pub(ALICE_LEG, "screen_share"),
  ]);
  assert.deepEqual([...live].sort(), [ALICE, ALICE_LEG, BOB].sort());
});

test("prune keeps only watches whose identity still shares", () => {
  const watched = new Set([ALICE, BOB, "gone:d1"]);
  const live = new Set([BOB, "carol:d1"]);
  const next = pruneWatched(watched, live);
  assert.deepEqual([...next], [BOB]);
  // A new set; neither input is touched.
  assert.notEqual(next, watched);
  assert.deepEqual([...watched], [ALICE, BOB, "gone:d1"]);
  assert.deepEqual([...live], [BOB, "carol:d1"]);
});

test("a re-share after the watch was pruned needs a new Watch", () => {
  let watched: Set<string> = watchedAfterWatch(NONE, BOB);
  assert.equal(shouldSubscribeRemote(pub(BOB, "screen_share"), watched), true);
  // Bob stops sharing: nothing of his is live, so the watch goes.
  watched = pruneWatched(watched, liveShareIdentities([pub(BOB, "camera")]));
  assert.equal(watched.size, 0);
  // Bob shares again: not subscribed until the viewer presses Watch again.
  const again = [pub(BOB, "screen_share"), pub(BOB, "screen_share_audio")];
  watched = pruneWatched(watched, liveShareIdentities(again));
  for (const p of again) {
    assert.equal(shouldSubscribeRemote(p, watched), false, p.source);
  }
});

test("a watch survives while the identity still shares either source", () => {
  // Video ended, audio still flowing: still the same share.
  const watched = pruneWatched(
    new Set([BOB]),
    liveShareIdentities([pub(BOB, "screen_share_audio")]),
  );
  assert.deepEqual([...watched], [BOB]);
});

test("watch/stop helpers return new sets and leave the input alone", () => {
  const base: ReadonlySet<string> = new Set([ALICE]);
  const added = watchedAfterWatch(base, BOB);
  assert.deepEqual([...added].sort(), [ALICE, BOB].sort());
  const stopped = watchedAfterStop(added, ALICE);
  assert.deepEqual([...stopped], [BOB]);
  assert.deepEqual([...base], [ALICE]);
  assert.deepEqual([...added].sort(), [ALICE, BOB].sort());
  assert.notEqual(watchedAfterStop(base, "nobody:d1"), base);
});

test("reconcile: a new watch subscribes share audio, never share video", () => {
  const changes = reconcileShareSubscriptions(NONE, new Set([BOB]), [
    rpub(BOB, "screen_share", false),
    rpub(BOB, "screen_share_audio", false),
  ]);
  assert.deepEqual(changes, [
    { identity: BOB, source: "screen_share_audio", subscribe: true },
  ]);
});

test("reconcile: a new watch on an already-desired audio pub is a no-op", () => {
  assert.deepEqual(
    reconcileShareSubscriptions(NONE, new Set([BOB]), [
      rpub(BOB, "screen_share_audio", true),
    ]),
    [],
  );
});

test("reconcile: ending a watch unsubscribes both desired share pubs", () => {
  const changes = reconcileShareSubscriptions(new Set([BOB]), NONE, [
    rpub(BOB, "screen_share", true),
    rpub(BOB, "screen_share_audio", true),
  ]);
  assert.deepEqual(changes, [
    { identity: BOB, source: "screen_share", subscribe: false },
    { identity: BOB, source: "screen_share_audio", subscribe: false },
  ]);
});

test("reconcile: ending a watch on pubs that are not desired is a no-op", () => {
  assert.deepEqual(
    reconcileShareSubscriptions(new Set([BOB]), NONE, [
      rpub(BOB, "screen_share", false),
      rpub(BOB, "screen_share_audio", false),
    ]),
    [],
  );
});

test("reconcile: identities whose watch did not change produce nothing", () => {
  const pubs = [
    // Watched before and after: newly published audio is the audio
    // effect's job, not a transition.
    rpub(ALICE, "screen_share_audio", false),
    rpub(ALICE, "screen_share", true),
    // Watched neither before nor after.
    rpub(BOB, "screen_share", false),
    rpub(BOB, "screen_share_audio", false),
  ];
  const both = new Set([ALICE]);
  assert.deepEqual(reconcileShareSubscriptions(both, both, pubs), []);
});

test("reconcile: own media and non-share sources never change", () => {
  const prev = new Set([BOB, "me:d1", "me:d1:screen"]);
  const pubs = [
    // Bob's mic and camera stay subscribed when his share watch ends.
    rpub(BOB, "microphone", true),
    rpub(BOB, "camera", true),
    rpub(BOB, "unknown", true),
    rpub("me:d1", "screen_share_audio", true, { isLocal: true }),
    rpub("me:d1:screen", "screen_share", true, { isSelfLeg: true }),
  ];
  assert.deepEqual(reconcileShareSubscriptions(prev, NONE, pubs), []);
  // And a new watch on them subscribes nothing either.
  const addPubs = pubs.map((p) => ({ ...p, isDesired: false }));
  assert.deepEqual(reconcileShareSubscriptions(NONE, prev, addPubs), []);
});

test("reconcile: changes come out in input order, per device identity", () => {
  // Alice's d1 watch ends while her d2 watch starts: distinct identities.
  const changes = reconcileShareSubscriptions(
    new Set([ALICE, BOB]),
    new Set([ALICE_OTHER_DEVICE, BOB]),
    [
      rpub(ALICE_OTHER_DEVICE, "screen_share_audio", false),
      rpub(ALICE, "screen_share_audio", true),
      rpub(BOB, "screen_share_audio", true),
      rpub(ALICE, "screen_share", true),
      rpub(ALICE_OTHER_DEVICE, "screen_share", false),
    ],
  );
  assert.deepEqual(changes, [
    {
      identity: ALICE_OTHER_DEVICE,
      source: "screen_share_audio",
      subscribe: true,
    },
    { identity: ALICE, source: "screen_share_audio", subscribe: false },
    { identity: ALICE, source: "screen_share", subscribe: false },
  ]);
});

test("reconcile never asks to subscribe share video, in any combination", () => {
  // Exhaustive over watch transition x desired x own-media flags: the
  // VideoTrack observer and the video effect are the only owners of a
  // share-video subscribe, so this module must never compete with them.
  const sets = [NONE, new Set([BOB])];
  for (const prev of sets) {
    for (const next of sets) {
      for (const isDesired of [false, true]) {
        for (const flags of [
          {},
          { isLocal: true },
          { isSelfLeg: true },
        ] as Partial<WatchPub>[]) {
          const changes = reconcileShareSubscriptions(prev, next, [
            rpub(BOB, "screen_share", isDesired, flags),
            rpub(BOB, "screen_share_audio", isDesired, flags),
          ]);
          for (const c of changes) {
            assert.ok(
              !(c.source === "screen_share" && c.subscribe),
              `video subscribe emitted: ${JSON.stringify({ prev: [...prev], next: [...next], isDesired, flags })}`,
            );
          }
        }
      }
    }
  }
});
