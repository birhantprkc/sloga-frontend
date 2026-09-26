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
  nextWatchPruneAt,
  pruneWatchedWithGrace,
  reconcileShareSubscriptions,
  SHARE_SOURCES,
  sharesToUnsubscribe,
  shouldSubscribeRemote,
  WATCH_ABSENCE_GRACE_MS,
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

test("a watch survives while the identity still shares either source", () => {
  // Video ended, audio still flowing: still the same share.
  const res = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: liveShareIdentities([pub(BOB, "screen_share_audio")]),
    present: new Set([BOB]),
    goneSince: new Map<string, number>(),
    now: 1_000,
  });
  assert.deepEqual([...res.watched], [BOB]);
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

// --- sharesToUnsubscribe: the defence-in-depth backstop ---
// Under our autoSubscribe:false connect a remote publication starts
// undesired (livekit sets `subscribed = autoSubscribe`), so SyncState never
// requests an untouched share. This selector catches a share that some other
// path made desired while it is unwatched (a mounted VideoTrack visibility
// observer, a future surface, an SDK default change): left desired, the SFU
// forwards it and every resume's SyncState asks for it again. Only an
// explicit setSubscribed(false) stops that.

test("unsubscribe: a desired unwatched share (isDesired true) is returned", () => {
  const video = rpub(BOB, "screen_share", true);
  const audio = rpub(BOB, "screen_share_audio", true);
  assert.deepEqual(sharesToUnsubscribe([video, audio], NONE), [video, audio]);
  // Watching someone else does not cover Bob.
  assert.deepEqual(sharesToUnsubscribe([video, audio], new Set([ALICE])), [
    video,
    audio,
  ]);
});

test("unsubscribe: a watched remote share is left alone", () => {
  const pubs = [
    rpub(BOB, "screen_share", true),
    rpub(BOB, "screen_share_audio", true),
  ];
  assert.deepEqual(sharesToUnsubscribe(pubs, new Set([BOB])), []);
});

test("unsubscribe: our own screen leg is returned even when watched", () => {
  const leg = rpub("me:d1:screen", "screen_share", true, { isSelfLeg: true });
  assert.deepEqual(sharesToUnsubscribe([leg], NONE), [leg]);
  assert.deepEqual(sharesToUnsubscribe([leg], new Set(["me:d1:screen"])), [
    leg,
  ]);
});

test("unsubscribe: local publications are never returned", () => {
  for (const source of SHARE_SOURCES) {
    const local = rpub("me:d1", source, true, { isLocal: true });
    assert.deepEqual(sharesToUnsubscribe([local], NONE), [], source);
    assert.deepEqual(
      sharesToUnsubscribe([{ ...local, isSelfLeg: true }], NONE),
      [],
      source,
    );
  }
});

test("unsubscribe: non-share sources are never returned", () => {
  for (const source of ["microphone", "camera", "unknown"]) {
    assert.deepEqual(
      sharesToUnsubscribe([rpub(BOB, source, true)], NONE),
      [],
      source,
    );
    assert.deepEqual(
      sharesToUnsubscribe(
        [rpub("me:d1:screen", source, true, { isSelfLeg: true })],
        NONE,
      ),
      [],
      source,
    );
  }
});

test("unsubscribe: publications already set undesired are not returned", () => {
  const pubs = [
    rpub(BOB, "screen_share", false),
    rpub(BOB, "screen_share_audio", false),
    rpub("me:d1:screen", "screen_share", false, { isSelfLeg: true }),
  ];
  assert.deepEqual(sharesToUnsubscribe(pubs, NONE), []);
});

test("unsubscribe: an unwatched audio-only share is returned", () => {
  const audio = rpub(BOB, "screen_share_audio", true);
  assert.deepEqual(
    sharesToUnsubscribe([rpub(BOB, "microphone", true), audio], NONE),
    [audio],
  );
});

test("unsubscribe: results keep input order and skip everything else", () => {
  const a = rpub(ALICE, "screen_share_audio", true);
  const leg = rpub("me:d1:screen", "screen_share", true, { isSelfLeg: true });
  const c = rpub(ALICE_OTHER_DEVICE, "screen_share", true);
  const d = rpub(ALICE, "screen_share", true);
  const pubs = [
    a,
    rpub(BOB, "screen_share", true), // watched
    leg,
    rpub("me:d1", "screen_share", true, { isLocal: true }),
    c,
    rpub(ALICE_LEG, "screen_share", false), // already undesired
    rpub(ALICE, "camera", true),
    d,
  ];
  const out = sharesToUnsubscribe(pubs, new Set([BOB]));
  assert.deepEqual(out, [a, leg, c, d]);
  // The same objects, so the caller can act on the publications it passed.
  assert.equal(out[1], leg);
});

test("unsubscribe: extra caller fields ride through, typed", () => {
  const withHandle = { ...rpub(BOB, "screen_share", true), handle: 42 };
  const out = sharesToUnsubscribe([withHandle], NONE);
  // Typed as the caller's own shape: no cast needed to reach `handle`.
  const handles: number[] = out.map((p) => p.handle);
  assert.deepEqual(handles, [42]);
});

// --- pruneWatchedWithGrace ---

const EMPTY_GONE: ReadonlyMap<string, number> = new Map();

test("grace prune: a live share keeps its watch and forgets any absence", () => {
  const res = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: new Set([BOB]),
    present: new Set([BOB]),
    goneSince: new Map([[BOB, 1_000]]),
    now: 5_000,
  });
  assert.deepEqual([...res.watched], [BOB]);
  assert.equal(res.goneSince.size, 0);
});

test("grace prune: present but no longer sharing, never having left, drops at once", () => {
  // Bob is still in the call and stopped sharing without ever leaving: a
  // deliberate stop, no grace at all. (Another identity's absence record
  // does not lend him one.)
  const res = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: new Set([BOB]),
    goneSince: new Map([[ALICE, 1_000]]),
    now: 1_001,
  });
  assert.equal(res.watched.size, 0);
  assert.equal(res.goneSince.size, 0);
  // So a re-share needs a new Watch.
  const again = [pub(BOB, "screen_share"), pub(BOB, "screen_share_audio")];
  const next = pruneWatchedWithGrace({
    watched: res.watched,
    live: liveShareIdentities(again),
    present: new Set([BOB]),
    goneSince: res.goneSince,
    now: 1_002,
  });
  for (const p of again) {
    assert.equal(shouldSubscribeRemote(p, next.watched), false, p.source);
  }
});

test("grace prune: absent keeps within the grace and drops at exactly graceMs", () => {
  const t0 = 50_000;
  // First tick absent: recorded and kept.
  const first = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    goneSince: EMPTY_GONE,
    now: t0,
  });
  assert.deepEqual([...first.watched], [BOB]);
  assert.deepEqual([...first.goneSince], [[BOB, t0]]);
  // One ms short of the grace: still kept, the original stamp preserved.
  const almost = pruneWatchedWithGrace({
    watched: first.watched,
    live: NONE,
    present: NONE,
    goneSince: first.goneSince,
    now: t0 + WATCH_ABSENCE_GRACE_MS - 1,
  });
  assert.deepEqual([...almost.watched], [BOB]);
  assert.deepEqual([...almost.goneSince], [[BOB, t0]]);
  // Exactly the grace: dropped and forgotten.
  const at = pruneWatchedWithGrace({
    watched: almost.watched,
    live: NONE,
    present: NONE,
    goneSince: almost.goneSince,
    now: t0 + WATCH_ABSENCE_GRACE_MS,
  });
  assert.equal(at.watched.size, 0);
  assert.equal(at.goneSince.size, 0);
});

test("grace prune: the grace defaults to WATCH_ABSENCE_GRACE_MS = 10 s and is overridable", () => {
  assert.equal(WATCH_ABSENCE_GRACE_MS, 10_000);
  const base = {
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    goneSince: new Map([[BOB, 0]]),
  };
  assert.equal(pruneWatchedWithGrace({ ...base, now: 9_999 }).watched.size, 1);
  assert.equal(pruneWatchedWithGrace({ ...base, now: 10_000 }).watched.size, 0);
  assert.equal(
    pruneWatchedWithGrace({ ...base, now: 499, graceMs: 500 }).watched.size,
    1,
  );
  assert.equal(
    pruneWatchedWithGrace({ ...base, now: 500, graceMs: 500 }).watched.size,
    0,
  );
});

test("grace prune: returning within the grace keeps the watch and clears the absence", () => {
  const t0 = 1_000;
  const gone = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    goneSince: EMPTY_GONE,
    now: t0,
  });
  // Bob reconnects and republishes his share 3 s later.
  const back = pruneWatchedWithGrace({
    watched: gone.watched,
    live: new Set([BOB]),
    present: new Set([BOB]),
    goneSince: gone.goneSince,
    now: t0 + 3_000,
  });
  assert.deepEqual([...back.watched], [BOB]);
  assert.equal(back.goneSince.size, 0);
  // A second absence starts a fresh grace, not the stale t0 one.
  const again = pruneWatchedWithGrace({
    watched: back.watched,
    live: NONE,
    present: NONE,
    goneSince: back.goneSince,
    now: t0 + 20_000,
  });
  assert.deepEqual([...again.watched], [BOB]);
  assert.deepEqual([...again.goneSince], [[BOB, t0 + 20_000]]);
});

test("grace prune: back in the room, not yet sharing, within the grace keeps the watch", () => {
  // Reconnect churn: Bob rejoins before his share is republished. That is
  // the window the grace exists for.
  const t0 = 1_000;
  const gone = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    goneSince: EMPTY_GONE,
    now: t0,
  });
  const back = pruneWatchedWithGrace({
    watched: gone.watched,
    live: NONE,
    present: new Set([BOB]),
    goneSince: gone.goneSince,
    now: t0 + 2_000,
  });
  assert.deepEqual([...back.watched], [BOB]);
  // The ORIGINAL absence stamp is carried forward, not refreshed on return.
  assert.deepEqual([...back.goneSince], [[BOB, t0]]);
  // Kept at one ms short of the grace from the original stamp.
  const almost = pruneWatchedWithGrace({
    watched: back.watched,
    live: NONE,
    present: new Set([BOB]),
    goneSince: back.goneSince,
    now: t0 + WATCH_ABSENCE_GRACE_MS - 1,
  });
  assert.deepEqual([...almost.watched], [BOB]);
  assert.deepEqual([...almost.goneSince], [[BOB, t0]]);
  // He republishes: kept, and the absence record is cleared.
  const republished = [
    pub(BOB, "screen_share"),
    pub(BOB, "screen_share_audio"),
  ];
  const live = pruneWatchedWithGrace({
    watched: almost.watched,
    live: liveShareIdentities(republished),
    present: new Set([BOB]),
    goneSince: almost.goneSince,
    now: t0 + WATCH_ABSENCE_GRACE_MS - 1,
  });
  assert.deepEqual([...live.watched], [BOB]);
  assert.equal(live.goneSince.size, 0);
  for (const p of republished) {
    assert.equal(shouldSubscribeRemote(p, live.watched), true, p.source);
  }
});

test("grace prune: back in the room but still not sharing at the grace drops the watch", () => {
  const t0 = 1_000;
  const base = {
    watched: new Set([BOB]),
    live: NONE,
    present: new Set([BOB]),
    goneSince: new Map([[BOB, t0]]),
  };
  // Exactly the grace, measured from when he left: dropped and forgotten.
  const at = pruneWatchedWithGrace({
    ...base,
    now: t0 + WATCH_ABSENCE_GRACE_MS,
  });
  assert.equal(at.watched.size, 0);
  assert.equal(at.goneSince.size, 0);
  // Well past it: the same.
  const past = pruneWatchedWithGrace({ ...base, now: t0 + 60_000 });
  assert.equal(past.watched.size, 0);
  assert.equal(past.goneSince.size, 0);
  // So a share republished after that is a new share: no subscription
  // until the viewer presses Watch again.
  const again = [pub(BOB, "screen_share"), pub(BOB, "screen_share_audio")];
  const next = pruneWatchedWithGrace({
    watched: at.watched,
    live: liveShareIdentities(again),
    present: new Set([BOB]),
    goneSince: at.goneSince,
    now: t0 + WATCH_ABSENCE_GRACE_MS + 1,
  });
  for (const p of again) {
    assert.equal(shouldSubscribeRemote(p, next.watched), false, p.source);
  }
});

test("grace prune: leaving again after a return keeps the ORIGINAL absence stamp", () => {
  // absent -> present (not sharing) -> absent: flapping must not restart
  // the grace, or a participant that keeps rejoining holds the watch open
  // indefinitely.
  const t0 = 10_000;
  const gone = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    goneSince: EMPTY_GONE,
    now: t0,
  });
  const back = pruneWatchedWithGrace({
    watched: gone.watched,
    live: NONE,
    present: new Set([BOB]),
    goneSince: gone.goneSince,
    now: t0 + 4_000,
  });
  const goneAgain = pruneWatchedWithGrace({
    watched: back.watched,
    live: NONE,
    present: NONE,
    goneSince: back.goneSince,
    now: t0 + 6_000,
  });
  assert.deepEqual([...goneAgain.watched], [BOB]);
  assert.deepEqual([...goneAgain.goneSince], [[BOB, t0]]);
  assert.equal(
    nextWatchPruneAt(goneAgain.goneSince),
    t0 + WATCH_ABSENCE_GRACE_MS,
  );
  // Dropped at the original deadline, not 10 s after either later hop.
  const at = pruneWatchedWithGrace({
    watched: goneAgain.watched,
    live: NONE,
    present: NONE,
    goneSince: goneAgain.goneSince,
    now: t0 + WATCH_ABSENCE_GRACE_MS,
  });
  assert.equal(at.watched.size, 0);
  assert.equal(at.goneSince.size, 0);
});

test("grace prune: a stop after a completed return is a deliberate stop again", () => {
  // Once the share is live again the record is gone, so stopping later,
  // still in the room, drops at once like any other stop.
  const back = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: new Set([BOB]),
    present: new Set([BOB]),
    goneSince: new Map([[BOB, 1_000]]),
    now: 3_000,
  });
  assert.equal(back.goneSince.size, 0);
  const stopped = pruneWatchedWithGrace({
    watched: back.watched,
    live: NONE,
    present: new Set([BOB]),
    goneSince: back.goneSince,
    now: 3_001,
  });
  assert.equal(stopped.watched.size, 0);
  assert.equal(stopped.goneSince.size, 0);
});

test("grace prune: the re-prune deadline covers a returning identity not yet sharing", () => {
  // The caller's timer is what enforces the bound while Bob sits in the
  // room without republishing, so his entry must stay in the deadline.
  const t0 = 2_000;
  const back = pruneWatchedWithGrace({
    watched: new Set([BOB, ALICE]),
    live: new Set([ALICE]),
    present: new Set([BOB, ALICE]),
    goneSince: new Map([[BOB, t0]]),
    now: t0 + 1_000,
  });
  assert.deepEqual([...back.watched].sort(), [ALICE, BOB].sort());
  const deadline = nextWatchPruneAt(back.goneSince);
  assert.equal(deadline, t0 + WATCH_ABSENCE_GRACE_MS);
  // The tick at that deadline, room unchanged, drops him and nothing else.
  const ticked = pruneWatchedWithGrace({
    watched: back.watched,
    live: new Set([ALICE]),
    present: new Set([BOB, ALICE]),
    goneSince: back.goneSince,
    now: deadline ?? Number.NaN,
  });
  assert.deepEqual([...ticked.watched], [ALICE]);
  assert.equal(ticked.goneSince.size, 0);
  assert.equal(nextWatchPruneAt(ticked.goneSince), null);
});

test("grace prune: a returning identity with a bad clock or record fails closed", () => {
  const base = {
    watched: new Set([BOB]),
    live: NONE,
    present: new Set([BOB]),
  };
  // Clock behind the recorded absence.
  const backwards = pruneWatchedWithGrace({
    ...base,
    goneSince: new Map([[BOB, 100_000]]),
    now: 99_999,
  });
  assert.equal(backwards.watched.size, 0);
  assert.equal(backwards.goneSince.size, 0);
  // Corrupt record, or a NaN clock.
  for (const [since, now] of [
    [NaN, 1_000],
    [1_000, NaN],
  ]) {
    const res = pruneWatchedWithGrace({
      ...base,
      goneSince: new Map([[BOB, since]]),
      now,
    });
    assert.equal(res.watched.size, 0, `${since} ${now}`);
    assert.equal(res.goneSince.size, 0, `${since} ${now}`);
  }
  // A non-positive grace gives a returning identity none either.
  const noGrace = pruneWatchedWithGrace({
    ...base,
    goneSince: new Map([[BOB, 1_000]]),
    now: 1_000,
    graceMs: 0,
  });
  assert.equal(noGrace.watched.size, 0);
});

test("grace prune: unwatched identities never enter goneSince, stale entries are dropped", () => {
  const res = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    // ALICE is not watched: her stale entry must go.
    goneSince: new Map([[ALICE, 1_000]]),
    now: 2_000,
  });
  assert.deepEqual([...res.watched], [BOB]);
  assert.deepEqual([...res.goneSince], [[BOB, 2_000]]);
  // Absent, unwatched identities are never recorded.
  const none = pruneWatchedWithGrace({
    watched: NONE,
    live: new Set([ALICE]),
    present: new Set([ALICE]),
    goneSince: EMPTY_GONE,
    now: 3_000,
  });
  assert.equal(none.watched.size, 0);
  assert.equal(none.goneSince.size, 0);
});

test("grace prune: a clock that goes backwards drops the absent watch (fail closed)", () => {
  // The elapsed absence cannot be measured, so the bound cannot be proven.
  const res = pruneWatchedWithGrace({
    watched: new Set([BOB, ALICE]),
    live: new Set([ALICE]),
    present: new Set([ALICE]),
    goneSince: new Map([[BOB, 100_000]]),
    now: 99_999,
  });
  assert.deepEqual([...res.watched], [ALICE]);
  assert.equal(res.goneSince.size, 0);
});

test("grace prune: non-finite times and bad grace values fail closed", () => {
  const base = {
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
  };
  // NaN clock, or a corrupt recorded time.
  assert.equal(
    pruneWatchedWithGrace({ ...base, goneSince: EMPTY_GONE, now: NaN }).watched
      .size,
    0,
  );
  assert.equal(
    pruneWatchedWithGrace({
      ...base,
      goneSince: new Map([[BOB, NaN]]),
      now: 1_000,
    }).watched.size,
    0,
  );
  // A zero, negative, NaN or infinite grace gives an absent identity none.
  for (const graceMs of [0, -5, NaN, Infinity]) {
    const res = pruneWatchedWithGrace({
      ...base,
      goneSince: EMPTY_GONE,
      now: 1_000,
      graceMs,
    });
    assert.equal(res.watched.size, 0, String(graceMs));
    assert.equal(res.goneSince.size, 0, String(graceMs));
  }
});

test("grace prune: returns new containers and leaves every input untouched", () => {
  const watched = new Set([ALICE, BOB, "carol:d1"]);
  const live = new Set([ALICE]);
  const present = new Set([ALICE, "carol:d1"]);
  const goneSince = new Map([["dave:d1", 7]]);
  const res = pruneWatchedWithGrace({
    watched,
    live,
    present,
    goneSince,
    now: 1_000,
  });
  assert.deepEqual([...res.watched].sort(), [ALICE, BOB].sort());
  assert.deepEqual([...res.goneSince], [[BOB, 1_000]]);
  assert.notEqual(res.watched, watched);
  assert.notEqual(res.goneSince, goneSince);
  assert.deepEqual([...watched], [ALICE, BOB, "carol:d1"]);
  assert.deepEqual([...live], [ALICE]);
  assert.deepEqual([...present], [ALICE, "carol:d1"]);
  assert.deepEqual([...goneSince], [["dave:d1", 7]]);
  // Even when nothing changes, the result is a fresh container.
  const same = pruneWatchedWithGrace({
    watched: live,
    live,
    present,
    goneSince: EMPTY_GONE,
    now: 1_000,
  });
  assert.notEqual(same.watched, live);
  assert.notEqual(same.goneSince, EMPTY_GONE);
});

test("grace prune: back sharing after the grace drops the watch, even with no re-prune at the deadline", () => {
  // DELIBERATE CONTRACT CHANGE: this used to pin that the watch was KEPT
  // here (the bound held only if the caller re-pruned at the deadline). A
  // share that comes back after the grace is a new share and needs a new
  // Watch, so the expired record now drops it even when the prune runs
  // late. Absent at t0, nothing ticks, back sharing 60 s on.
  const gone = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: NONE,
    present: NONE,
    goneSince: EMPTY_GONE,
    now: 0,
  });
  const late = pruneWatchedWithGrace({
    watched: gone.watched,
    live: new Set([BOB]),
    present: new Set([BOB]),
    goneSince: gone.goneSince,
    now: 60_000,
  });
  assert.equal(late.watched.size, 0);
  assert.equal(late.goneSince.size, 0);
  const again = [pub(BOB, "screen_share"), pub(BOB, "screen_share_audio")];
  for (const p of again) {
    assert.equal(shouldSubscribeRemote(p, late.watched), false, p.source);
  }
  // With the tick at the deadline, the watch is gone before he returns.
  const deadline = nextWatchPruneAt(gone.goneSince);
  assert.equal(deadline, WATCH_ABSENCE_GRACE_MS);
  const ticked = pruneWatchedWithGrace({
    watched: gone.watched,
    live: NONE,
    present: NONE,
    goneSince: gone.goneSince,
    now: deadline ?? Number.NaN,
  });
  assert.equal(ticked.watched.size, 0);
});

test("grace prune: live with an expired absence record drops the watch and forgets it", () => {
  const t0 = 1_000;
  for (const now of [t0 + WATCH_ABSENCE_GRACE_MS, t0 + 60_000]) {
    const res = pruneWatchedWithGrace({
      watched: new Set([BOB, ALICE]),
      live: new Set([BOB, ALICE]),
      present: new Set([BOB, ALICE]),
      // Alice never left: her watch is untouched by Bob's expiry.
      goneSince: new Map([[BOB, t0]]),
      now,
    });
    assert.deepEqual([...res.watched], [ALICE], String(now));
    assert.equal(res.goneSince.size, 0, String(now));
  }
  // The same holds for an overridden grace.
  const custom = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: new Set([BOB]),
    present: new Set([BOB]),
    goneSince: new Map([[BOB, t0]]),
    now: t0 + 500,
    graceMs: 500,
  });
  assert.equal(custom.watched.size, 0);
});

test("grace prune: live with an unexpired absence record keeps the watch and clears the record", () => {
  const t0 = 1_000;
  for (const now of [t0, t0 + WATCH_ABSENCE_GRACE_MS - 1]) {
    const res = pruneWatchedWithGrace({
      watched: new Set([BOB]),
      live: new Set([BOB]),
      present: new Set([BOB]),
      goneSince: new Map([[BOB, t0]]),
      now,
    });
    assert.deepEqual([...res.watched], [BOB], String(now));
    assert.equal(res.goneSince.size, 0, String(now));
    assert.equal(nextWatchPruneAt(res.goneSince), null, String(now));
  }
});

test("grace prune: live with a NaN absence record or a NaN clock drops the watch", () => {
  for (const [since, now] of [
    [NaN, 1_000],
    [1_000, NaN],
  ]) {
    const res = pruneWatchedWithGrace({
      watched: new Set([BOB]),
      live: new Set([BOB]),
      present: new Set([BOB]),
      goneSince: new Map([[BOB, since]]),
      now,
    });
    assert.equal(res.watched.size, 0, `${since} ${now}`);
    assert.equal(res.goneSince.size, 0, `${since} ${now}`);
  }
});

test("grace prune: live with a clock behind its absence record drops the watch", () => {
  // The elapsed absence cannot be measured, so the bound cannot be proven.
  const res = pruneWatchedWithGrace({
    watched: new Set([BOB]),
    live: new Set([BOB]),
    present: new Set([BOB]),
    goneSince: new Map([[BOB, 100_000]]),
    now: 99_999,
  });
  assert.equal(res.watched.size, 0);
  assert.equal(res.goneSince.size, 0);
});

test("next prune deadline: the earliest absence plus the grace, or null", () => {
  assert.equal(nextWatchPruneAt(EMPTY_GONE), null);
  const gone = new Map([
    [BOB, 5_000],
    [ALICE, 2_000],
    ["corrupt:d1", NaN],
  ]);
  assert.equal(nextWatchPruneAt(gone), 2_000 + WATCH_ABSENCE_GRACE_MS);
  assert.equal(nextWatchPruneAt(gone, 500), 2_500);
  // A bad grace means "due now", matching the prune's treatment of it.
  assert.equal(nextWatchPruneAt(gone, NaN), 2_000);
  assert.equal(nextWatchPruneAt(new Map([["corrupt:d1", NaN]])), null);
});
