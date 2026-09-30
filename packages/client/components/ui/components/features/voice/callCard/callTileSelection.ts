/**
 * Which tracks get a tile in the call grid, including the optional "hide
 * participants without video" filter (PURE, so the rules are unit-testable
 * away from the card and LiveKit).
 *
 * The inputs are structural on purpose: a `TrackReferenceOrPlaceholder` from
 * solid-livekit-components fits `TileCandidate` as-is, and the spec can build
 * plain objects without a Room.
 *
 * WHAT COUNTS AS LIVE VIDEO. A track reference with a publication that is not
 * muted. A camera the user switched off is published-but-muted; a camera
 * placeholder (everyone in the call carries one) has no publication at all;
 * neither is video. Subscription is NEVER consulted: a screen share you have
 * not chosen to watch is published, unmuted and unsubscribed, and it still
 * counts as video, because its tile renders a Watch placeholder that is the
 * only way into it. Reading subscription here would hide that tile and leave
 * no way to start watching.
 *
 * MUTED SCREEN SHARES never get a tile, in either mode. That is today's
 * `gridTracks` rule in `VoiceCallCardActiveRoom.tsx`
 * (`t.source !== Track.Source.ScreenShare || isLiveVideo(t)`), which exists
 * because ParticipantTile renders nothing for a muted share and counting it
 * would size the grid around an empty slot.
 *
 * WHO IS HIDDEN. The call bar says "N participants without video hidden", so
 * `hiddenCount` counts people, not tiles. Every participant carries a camera
 * placeholder, so someone sharing their screen with the camera off has a
 * hidden placeholder AND a shown share; they are not hidden. Likewise whoever
 * owns the focused tile is on screen in the focus box, live video or not, so
 * they are never hidden. The caller's `participantOf` key decides who a tile
 * belongs to (an Android screen leg maps to its owner); it is an opaque
 * string here.
 *
 * Source strings are livekit-client's `Track.Source` values
 * (`Camera = 'camera'`, `ScreenShare = 'screen_share'`, livekit-client
 * 2.15.13 `src/room/track/Track.ts`). The spec pins them against the enum at
 * type level, so a rename fails `tsc`.
 */

/** livekit-client `Track.Source.ScreenShare`. */
const SCREEN_SHARE = "screen_share";

/** The part of a track reference the tile rules read. */
export interface TileCandidate {
  source: string;
  publication?: { isMuted: boolean };
}

/** The grid's tiles for the non-focused area, plus what the filter did. */
export interface TileSelection<T> {
  /** Tracks to render as tiles, in input order. Never the focused one. */
  tiles: T[];
  /**
   * The number of PARTICIPANTS with no live video anywhere who are hidden:
   * distinct `participantOf` keys among the tiles the filter removed, minus
   * every key that has a live video (focused included) and minus the focused
   * tile's key (that person is on screen in the focus box, even with no
   * video). Muted screen shares and the focused tile are never a reason to
   * count someone: neither would have had a tile with the filter off.
   */
  hiddenCount: number;
  /**
   * The filter is on but nobody in the call has live video, so every tile is
   * shown rather than an empty grid.
   */
  fellBack: boolean;
}

/** A real, unmuted feed rather than a camera-off placeholder. */
export function hasLiveVideo(t: TileCandidate): boolean {
  return !!t.publication && !t.publication.isMuted;
}

/** A screen share that is not live. Always dropped from the grid. */
export function isMutedScreenShare(t: TileCandidate): boolean {
  return t.source === SCREEN_SHARE && !hasLiveVideo(t);
}

/**
 * Pick the tiles for the grid (everything except the focused window).
 *
 * 1. Muted screen shares are dropped, always.
 * 2. The focused tile is removed; it renders in the focus box instead.
 * 3. Filter on and at least one live video anywhere (focused included): keep
 *    only live-video tiles and count, in `hiddenCount`, the participants whose
 *    removed tiles leave them with no live video anywhere and who do not own
 *    the focused tile. The result may be empty when the focused window is the
 *    only live video.
 * 4. Filter on and no live video anywhere: show everyone, `fellBack: true`.
 * 5. Filter off: today's behavior.
 *
 * Input order is preserved.
 */
export function selectCallTiles<T extends TileCandidate>(
  tracks: readonly T[],
  opts: {
    hideNonVideo: boolean;
    isFocused: (t: T) => boolean;
    participantOf: (t: T) => string;
  },
): TileSelection<T> {
  const candidates = tracks.filter((t) => !isMutedScreenShare(t));
  const others = candidates.filter((t) => !opts.isFocused(t));

  if (!opts.hideNonVideo) {
    return { tiles: others, hiddenCount: 0, fellBack: false };
  }

  if (!candidates.some(hasLiveVideo)) {
    return { tiles: others, hiddenCount: 0, fellBack: true };
  }

  const tiles = others.filter(hasLiveVideo);
  const live = new Set(candidates.filter(hasLiveVideo).map(opts.participantOf));
  const focused = new Set(
    candidates.filter(opts.isFocused).map(opts.participantOf),
  );
  const hidden = new Set<string>();
  for (const t of others) {
    if (hasLiveVideo(t)) continue;
    const key = opts.participantOf(t);
    if (!live.has(key) && !focused.has(key)) hidden.add(key);
  }
  return {
    tiles,
    hiddenCount: hidden.size,
    fellBack: false,
  };
}

/**
 * How many live videos there are, focused included. The auto-focus skip reads
 * this (skip when the filter is on and the count is 2 or more).
 */
export function liveVideoCount(tracks: readonly TileCandidate[]): number {
  return tracks.filter(hasLiveVideo).length;
}
