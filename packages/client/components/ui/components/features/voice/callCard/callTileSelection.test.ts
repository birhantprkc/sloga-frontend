// Unit spec for the call grid's tile selection and the "hide participants
// without video" filter — run with Node's built-in runner, from
// packages/client:
//   node --test --conditions=browser components/ui/components/features/voice/callCard/callTileSelection.test.ts
// Focus: live video is publication-and-unmuted and never reads subscription
// (an unwatched share keeps its Watch tile); a muted share never gets a tile
// in either mode; the filter falls back to everyone when nobody has video;
// the focused tile never appears in the list; hiddenCount counts PEOPLE (by
// the caller's participantOf key), not tiles, and never the focused tile's
// owner.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { Track } from "livekit-client";
import type { TrackReferenceOrPlaceholder } from "solid-livekit-components";

import {
  type TileCandidate,
  hasLiveVideo,
  isMutedScreenShare,
  liveVideoCount,
  selectCallTiles,
} from "./callTileSelection.ts";

// Type-level pins, checked by tsc and erased at runtime. The source strings
// used below are livekit-client's Track.Source values, and the real track
// reference the grid holds fits the structural input.
const CAMERA: `${Track.Source.Camera}` = "camera";
const SCREEN_SHARE: `${Track.Source.ScreenShare}` = "screen_share";
type Fits<T extends TileCandidate> = T;
export type _TrackRefFits = Fits<TrackReferenceOrPlaceholder>;

type Tile = TileCandidate & {
  id: string;
  /** The participantOf key. Defaults to the tile id: one person per tile. */
  owner?: string;
  /** Present on real publications; the rules must never read it. */
  publication?: { isMuted: boolean; isSubscribed?: boolean; track?: unknown };
};

const cameraOn = (id: string): Tile => ({
  id,
  source: CAMERA,
  publication: { isMuted: false, isSubscribed: true, track: {} },
});
const cameraOff = (id: string): Tile => ({
  id,
  source: CAMERA,
  publication: { isMuted: true, isSubscribed: true, track: {} },
});
const cameraPlaceholder = (id: string): Tile => ({ id, source: CAMERA });
const shareWatched = (id: string): Tile => ({
  id,
  source: SCREEN_SHARE,
  publication: { isMuted: false, isSubscribed: true, track: {} },
});
/** Published and unmuted, but this viewer has not subscribed: no track. */
const shareUnwatched = (id: string): Tile => ({
  id,
  source: SCREEN_SHARE,
  publication: { isMuted: false, isSubscribed: false },
});
const shareMuted = (id: string): Tile => ({
  id,
  source: SCREEN_SHARE,
  publication: { isMuted: true, isSubscribed: false },
});

/** The same tile, belonging to `owner`. */
const own = (owner: string, t: Tile): Tile => ({ ...t, owner });

const noFocus = () => false;
const focusOn = (id: string) => (t: Tile) => t.id === id;
const who = (t: Tile) => t.owner ?? t.id;
const ids = (tiles: Tile[]) => tiles.map((t) => t.id);

test("a published camera that is muted is not live video", () => {
  assert.equal(hasLiveVideo(cameraOff("a")), false);
  assert.equal(hasLiveVideo(cameraOn("a")), true);
});

test("a camera placeholder with no publication is not live video", () => {
  assert.equal(hasLiveVideo(cameraPlaceholder("a")), false);
});

test("an unwatched share (published, unmuted, unsubscribed) is live video", () => {
  // Subscription is never consulted: this tile renders the Watch placeholder,
  // the only way into the share, so the filter must keep it.
  const share = shareUnwatched("s");
  assert.equal(hasLiveVideo(share), true);
  assert.equal(isMutedScreenShare(share), false);

  const sel = selectCallTiles([cameraPlaceholder("a"), share], {
    hideNonVideo: true,
    isFocused: noFocus,
    participantOf: who,
  });
  assert.deepEqual(ids(sel.tiles), ["s"]);
  assert.equal(sel.hiddenCount, 1);
  assert.equal(sel.fellBack, false);
  assert.equal(liveVideoCount([share]), 1);
});

test("isMutedScreenShare mirrors today's gridTracks rule", () => {
  assert.equal(isMutedScreenShare(shareMuted("s")), true);
  assert.equal(isMutedScreenShare({ source: SCREEN_SHARE }), true);
  assert.equal(isMutedScreenShare(shareWatched("s")), false);
  // A camera is never dropped by this rule, live or not.
  assert.equal(isMutedScreenShare(cameraOff("a")), false);
  assert.equal(isMutedScreenShare(cameraPlaceholder("a")), false);
});

test("a muted share is dropped with the filter off, and not counted", () => {
  const sel = selectCallTiles(
    [cameraPlaceholder("a"), shareMuted("m"), cameraOff("b")],
    { hideNonVideo: false, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["a", "b"]);
  assert.equal(sel.hiddenCount, 0);
  assert.equal(sel.fellBack, false);
});

test("a muted share is dropped with the filter on, and not counted as hidden", () => {
  const withVideo = selectCallTiles(
    [cameraOn("a"), shareMuted("m"), cameraOff("b")],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(withVideo.tiles), ["a"]);
  assert.equal(withVideo.hiddenCount, 1);
  assert.equal(withVideo.fellBack, false);

  // In the fallback too: "everyone" never includes a muted share.
  const fallback = selectCallTiles([cameraOff("a"), shareMuted("m")], {
    hideNonVideo: true,
    isFocused: noFocus,
    participantOf: who,
  });
  assert.deepEqual(ids(fallback.tiles), ["a"]);
  assert.equal(fallback.hiddenCount, 0);
  assert.equal(fallback.fellBack, true);
});

test("the filter falls back to everyone when nobody has live video", () => {
  const sel = selectCallTiles(
    [cameraPlaceholder("a"), cameraOff("b"), cameraPlaceholder("c")],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["a", "b", "c"]);
  assert.equal(sel.hiddenCount, 0);
  assert.equal(sel.fellBack, true);
});

test("the fallback still leaves the focused tile out", () => {
  const sel = selectCallTiles([cameraOff("a"), cameraPlaceholder("b")], {
    hideNonVideo: true,
    isFocused: focusOn("a"),
    participantOf: who,
  });
  assert.deepEqual(ids(sel.tiles), ["b"]);
  assert.equal(sel.hiddenCount, 0);
  assert.equal(sel.fellBack, true);
});

test("the focused tile is excluded in both modes", () => {
  const tracks = [cameraOn("a"), shareWatched("s"), cameraPlaceholder("b")];
  for (const hideNonVideo of [false, true]) {
    const sel = selectCallTiles(tracks, {
      hideNonVideo,
      isFocused: focusOn("s"),
      participantOf: who,
    });
    assert.equal(ids(sel.tiles).includes("s"), false);
  }
});

test("the only live video focused: the list is empty and it is not a fallback", () => {
  // The focused share counts as live video, so the filter applies and every
  // other tile is hidden. The view then renders no side column or strip. The
  // share belongs to a third person, so a and b are the two people hidden.
  const sel = selectCallTiles(
    [
      cameraPlaceholder("a"),
      own("sharer", shareUnwatched("s")),
      cameraOff("b"),
    ],
    { hideNonVideo: true, isFocused: focusOn("s"), participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), []);
  assert.equal(sel.hiddenCount, 2);
  assert.equal(sel.fellBack, false);
});

test("the filter off is today's behavior: everyone but the focus", () => {
  const sel = selectCallTiles(
    [cameraPlaceholder("a"), cameraOn("b"), shareWatched("s"), cameraOff("c")],
    { hideNonVideo: false, isFocused: focusOn("b"), participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["a", "s", "c"]);
  assert.equal(sel.hiddenCount, 0);
  assert.equal(sel.fellBack, false);
});

test("your own tile is treated like anyone else's", () => {
  // The rules have no notion of "local": own camera off is hidden, own share
  // live is kept, exactly as for a remote participant. You are sharing, so you
  // are not a person "without video" and the count excludes you.
  const sharing = selectCallTiles(
    [
      own("me", cameraOff("me-cam")),
      cameraOn("b"),
      own("me", shareWatched("me-share")),
    ],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sharing.tiles), ["b", "me-share"]);
  assert.equal(sharing.hiddenCount, 0);

  // Not sharing: your camera-off tile is hidden and you are counted.
  const notSharing = selectCallTiles(
    [own("me", cameraOff("me-cam")), cameraOn("b")],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(notSharing.tiles), ["b"]);
  assert.equal(notSharing.hiddenCount, 1);
});

test("input order is preserved", () => {
  const tracks = [
    shareWatched("s1"),
    cameraOff("a"),
    cameraOn("b"),
    cameraPlaceholder("c"),
    shareUnwatched("s2"),
    cameraOn("d"),
  ];
  const on = selectCallTiles(tracks, {
    hideNonVideo: true,
    isFocused: noFocus,
    participantOf: who,
  });
  assert.deepEqual(ids(on.tiles), ["s1", "b", "s2", "d"]);
  const off = selectCallTiles(tracks, {
    hideNonVideo: false,
    isFocused: noFocus,
    participantOf: who,
  });
  assert.deepEqual(ids(off.tiles), ["s1", "a", "b", "c", "s2", "d"]);
});

test("hiddenCount counts distinct people with no live video, not tiles", () => {
  const tracks = [
    own("p1", cameraOn("live1")),
    own("p2", cameraOff("off1")),
    own("p3", cameraPlaceholder("ph1")),
    // p3's share is muted: dropped, and it does not make p3 live.
    own("p3", shareMuted("muted1")),
    own("p5", cameraOff("focused-off")),
    // p6 shares with the camera off: the placeholder is hidden, p6 is not.
    own("p6", shareUnwatched("live2")),
    own("p6", cameraPlaceholder("ph2")),
    own("p7", shareMuted("muted2")),
    own("p7", cameraPlaceholder("ph3")),
  ];
  const sel = selectCallTiles(tracks, {
    hideNonVideo: true,
    isFocused: focusOn("focused-off"),
    participantOf: who,
  });
  assert.deepEqual(ids(sel.tiles), ["live1", "live2"]);
  // p2, p3, p7. Four hidden tiles (off1, ph1, ph2, ph3), but ph2 is p6's and
  // p6 is live; the focused p5 is in the focus box, not hidden.
  assert.equal(sel.hiddenCount, 3);
  assert.equal(sel.fellBack, false);
});

test("a person sharing with the camera off is not counted as hidden", () => {
  const sel = selectCallTiles(
    [
      own("alice", cameraPlaceholder("alice-cam")),
      own("alice", shareWatched("alice-share")),
      cameraOn("bob"),
    ],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["alice-share", "bob"]);
  assert.equal(sel.hiddenCount, 0);
});

test("the focused share's owner with the camera off is not counted as hidden", () => {
  const sel = selectCallTiles(
    [
      own("alice", cameraPlaceholder("alice-cam")),
      own("alice", shareUnwatched("alice-share")),
      cameraPlaceholder("carol"),
    ],
    {
      hideNonVideo: true,
      isFocused: focusOn("alice-share"),
      participantOf: who,
    },
  );
  assert.deepEqual(ids(sel.tiles), []);
  // Only carol: alice is live in the focus box.
  assert.equal(sel.hiddenCount, 1);
  assert.equal(sel.fellBack, false);
});

test("the owner of a focused non-live tile is on screen, not hidden", () => {
  // Someone's avatar is focused, and a screen-leg placeholder mapped to the
  // same key sits in the grid. It is hidden, but its owner is in the focus
  // box, so the count is only erin.
  const sel = selectCallTiles(
    [
      own("dana", cameraPlaceholder("dana-cam")),
      own("dana", cameraPlaceholder("dana-leg-cam")),
      cameraOn("bob"),
      cameraOff("erin"),
    ],
    {
      hideNonVideo: true,
      isFocused: focusOn("dana-cam"),
      participantOf: who,
    },
  );
  assert.deepEqual(ids(sel.tiles), ["bob"]);
  assert.equal(sel.hiddenCount, 1);
  assert.equal(sel.fellBack, false);
});

test("a screen leg's share keeps its owner out of the count", () => {
  // The leg is its own LiveKit participant with its own tile identities; the
  // caller maps both to the owner's key.
  const sel = selectCallTiles(
    [
      own("owner", cameraPlaceholder("owner-cam")),
      own("owner", cameraPlaceholder("owner-leg-cam")),
      own("owner", shareWatched("owner-leg-share")),
      cameraPlaceholder("dave"),
    ],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["owner-leg-share"]);
  assert.equal(sel.hiddenCount, 1);
});

test("two different people with no video count as 2", () => {
  const sel = selectCallTiles(
    [cameraPlaceholder("a"), cameraOff("b"), cameraOn("c")],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["c"]);
  assert.equal(sel.hiddenCount, 2);
});

test("the same person with two non-live tiles counts as 1", () => {
  const sel = selectCallTiles(
    [
      own("a", cameraOff("a-cam")),
      own("a", cameraPlaceholder("a-leg-cam")),
      cameraOn("c"),
    ],
    { hideNonVideo: true, isFocused: noFocus, participantOf: who },
  );
  assert.deepEqual(ids(sel.tiles), ["c"]);
  assert.equal(sel.hiddenCount, 1);
});

test("six people, two sharing with the camera off: 4 hidden, not 6", () => {
  // The reported scenario. Every person carries a camera placeholder; the
  // two sharers' placeholders are hidden but the sharers are not.
  const people = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const tracks = [
    ...people.map((p) => own(p, cameraPlaceholder(`${p}-cam`))),
    own("p1", shareWatched("p1-share")),
    own("p2", shareUnwatched("p2-share")),
  ];
  const sel = selectCallTiles(tracks, {
    hideNonVideo: true,
    isFocused: noFocus,
    participantOf: who,
  });
  assert.deepEqual(ids(sel.tiles), ["p1-share", "p2-share"]);
  assert.equal(sel.hiddenCount, 4);
});

test("the input array is not mutated", () => {
  const tracks = [cameraOff("a"), cameraOn("b"), shareMuted("m")];
  const before = ids(tracks);
  selectCallTiles(tracks, {
    hideNonVideo: true,
    isFocused: focusOn("b"),
    participantOf: who,
  });
  assert.deepEqual(ids(tracks), before);
});

test("liveVideoCount counts live feeds, focused included, muted shares not", () => {
  assert.equal(liveVideoCount([]), 0);
  assert.equal(
    liveVideoCount([
      cameraOn("a"),
      cameraOff("b"),
      cameraPlaceholder("c"),
      shareWatched("s1"),
      shareUnwatched("s2"),
      shareMuted("m"),
    ]),
    3,
  );
});
