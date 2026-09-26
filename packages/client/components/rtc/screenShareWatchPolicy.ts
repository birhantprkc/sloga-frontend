/**
 * Click-to-watch screen shares: which remote publications the client may
 * subscribe, and which subscriptions must change when the watch set changes
 * (PURE, so the rules are unit-testable away from LiveKit — no
 * `livekit-client` import, structural types only).
 *
 * WHY THIS EXISTS. A viewer used to receive every remote screen share the
 * moment it was published: `RoomAudioManager` blanket-subscribed every
 * ScreenShare and ScreenShareAudio publication. That made a share something
 * that happened TO you — loud video audio, or content you never chose to see.
 * Now nothing from a remote share reaches the viewer until they press Watch.
 *
 * THE WATCH SET. A watch is keyed by the remote participant's IDENTITY — the
 * device-qualified LiveKit identity string (`"{user}:{device}"`, or the leg
 * form `"{user}:{device}:screen"`), never the user id. So a share from
 * another of your own devices, or a second device of the same user, needs its
 * own Watch. A watch lasts for the current share only: it is pruned
 * (`pruneWatched`) once the identity publishes neither share source, so a
 * re-share needs a new Watch. Clearing on connect/disconnect is the state
 * lane's job, not this module's.
 *
 * WHAT IS EXEMPT. Every non-share source (microphone, camera, whisper tracks,
 * which publish as `"unknown"`) keeps today's behavior: this module never
 * blocks them, and the existing filters in `RoomAudioManager` still decide.
 * The local participant and the user's own Android screen leg (`isSelfLeg`)
 * are never subscribed at all — our own media is never pulled back down.
 *
 * WHO OWNS WHICH SUBSCRIPTION. For a watched share, ScreenShare VIDEO is
 * subscribed by the `VideoTrack` visibility observer and the video subscribe
 * effect, never by `reconcileShareSubscriptions`; if both drove it they would
 * fight (the observer unsubscribes a tile hidden for 3 s). Reconcile only
 * subscribes ScreenShareAudio on a new watch, and unsubscribes BOTH sources
 * when a watch ends — a `VideoTrack` that unmounts does not unsubscribe on its
 * own, so without that the stream keeps flowing after Stop watching.
 */

/**
 * The share sources, as LiveKit's `Track.Source` string values
 * (`livekit-client` 2.15.13, `src/room/track/Track.ts`:
 * `ScreenShare = 'screen_share'`, `ScreenShareAudio = 'screen_share_audio'`).
 */
export const SHARE_SOURCES = ["screen_share", "screen_share_audio"] as const;

/** One of the two screen-share sources. */
export type ShareSource = (typeof SHARE_SOURCES)[number];

/** Whether `source` is a screen-share source (video or its audio). */
export function isShareSource(source: string): source is ShareSource {
  return source === "screen_share" || source === "screen_share_audio";
}

/** A publication as this module sees it. */
export interface WatchPub {
  /** The publishing participant's device-qualified LiveKit identity. */
  identity: string;
  /** The LiveKit `Track.Source` string value. */
  source: string;
  /** Published by the local participant. */
  isLocal: boolean;
  /**
   * Published by OUR OWN device's Android screen leg — compared by device,
   * not user (`isScreenLeg(id) && stripLeg(id) === local identity`). Another
   * of our devices' legs is a genuine remote share and is NOT a self leg.
   */
  isSelfLeg: boolean;
}

/** Local media, or our own device's screen leg: never subscribed. */
function isOwnMedia(pub: WatchPub): boolean {
  return pub.isLocal || pub.isSelfLeg;
}

/**
 * Whether the audio/video subscribe effects may request this remote
 * publication. It is an extra gate on top of the effects' existing filters,
 * never a replacement for them.
 *
 * - Local participant or our own screen leg: false, for every source. Both
 *   effects already drop local tracks, and the video effect drops the self
 *   leg. The audio effect does not drop the self leg, but the leg publishes
 *   only ScreenShare video today (`ScreenSharePlugin.kt`), so this changes
 *   nothing observable now, and it keeps a future leg audio track from
 *   playing the phone's own screen audio back to it.
 * - Any non-share source: true — today's behavior, unchanged.
 * - A share source: only when the identity is watched.
 */
export function shouldSubscribeRemote(
  pub: WatchPub,
  watched: ReadonlySet<string>,
): boolean {
  if (isOwnMedia(pub)) return false;
  if (!isShareSource(pub.source)) return true;
  return watched.has(pub.identity);
}

/**
 * Identities currently publishing ScreenShare OR ScreenShareAudio — so an
 * audio-only share counts as live. Local publications and our own screen
 * leg are skipped: they are never watchable.
 */
export function liveShareIdentities(pubs: readonly WatchPub[]): Set<string> {
  const live = new Set<string>();
  for (const pub of pubs) {
    if (isOwnMedia(pub)) continue;
    if (isShareSource(pub.source)) live.add(pub.identity);
  }
  return live;
}

/**
 * Drop every watch whose identity no longer shares anything. Returns a NEW
 * set (the intersection of `watched` and `live`); the inputs are untouched.
 */
export function pruneWatched(
  watched: ReadonlySet<string>,
  live: ReadonlySet<string>,
): Set<string> {
  const next = new Set<string>();
  for (const identity of watched) {
    if (live.has(identity)) next.add(identity);
  }
  return next;
}

/** A new watch set with `identity` added. The input is untouched. */
export function watchedAfterWatch(
  watched: ReadonlySet<string>,
  identity: string,
): Set<string> {
  const next = new Set(watched);
  next.add(identity);
  return next;
}

/** A new watch set with `identity` removed. The input is untouched. */
export function watchedAfterStop(
  watched: ReadonlySet<string>,
  identity: string,
): Set<string> {
  const next = new Set(watched);
  next.delete(identity);
  return next;
}

/** A publication plus its current subscription intent. */
export interface ReconcilePub extends WatchPub {
  /**
   * LiveKit `RemoteTrackPublication.isDesired` — true unless the client has
   * explicitly set the publication unsubscribed.
   */
  isDesired: boolean;
}

/** One `setSubscribed(subscribe)` call the caller must make. */
export interface ShareSubscriptionChange {
  identity: string;
  source: ShareSource;
  subscribe: boolean;
}

/**
 * The subscription changes a watch-set transition requires, in `pubs` input
 * order. Only identities whose watch state CHANGED produce anything:
 *
 * - Watch removed: `{subscribe: false}` for each of its share publications
 *   (video and audio) that is still desired.
 * - Watch added: `{subscribe: true}` for each of its ScreenShareAudio
 *   publications that is not yet desired. Never for ScreenShare video — the
 *   `VideoTrack` visibility observer and the video effect own that.
 *
 * Local publications, our own screen leg and non-share sources never produce
 * a change. An identity watched both before and after produces nothing even
 * if it newly publishes audio: the audio subscribe effect, gated by
 * `shouldSubscribeRemote`, picks that up.
 */
export function reconcileShareSubscriptions(
  prevWatched: ReadonlySet<string>,
  nextWatched: ReadonlySet<string>,
  pubs: readonly ReconcilePub[],
): ShareSubscriptionChange[] {
  const changes: ShareSubscriptionChange[] = [];
  for (const pub of pubs) {
    if (isOwnMedia(pub)) continue;
    const source = pub.source;
    if (!isShareSource(source)) continue;
    const was = prevWatched.has(pub.identity);
    const now = nextWatched.has(pub.identity);
    if (was && !now) {
      if (pub.isDesired) {
        changes.push({ identity: pub.identity, source, subscribe: false });
      }
    } else if (!was && now) {
      if (source === "screen_share_audio" && !pub.isDesired) {
        changes.push({ identity: pub.identity, source, subscribe: true });
      }
    }
  }
  return changes;
}
