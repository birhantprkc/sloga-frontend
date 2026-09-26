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
 * own Watch. A watch lasts for the current share only: the prune
 * (`pruneWatchedWithGrace`) drops it once the identity publishes neither
 * share source, so a re-share needs a new Watch. The one exception is an
 * identity that has left the room ENTIRELY: it keeps its watch for up to
 * `WATCH_ABSENCE_GRACE_MS` from when it left (reconnect churn), including
 * after it rejoins and until its share is republished. A share that comes
 * back after that grace is a new share and needs a new Watch, and one that
 * stops without the identity ever leaving is pruned at once. Clearing on
 * connect/disconnect is the state lane's job, not this module's.
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
   * LiveKit `RemoteTrackPublication.isDesired` (`subscribed !== false`).
   * With our `autoSubscribe: false` connect a publication starts undesired,
   * and it is desired only after something calls `setSubscribed(true)`.
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

/**
 * Every share publication that must be EXPLICITLY unsubscribed
 * (`setSubscribed(false)`) right now, in `pubs` input order: each remote
 * ScreenShare or ScreenShareAudio publication that is still desired and
 * either belongs to our own device's screen leg or to an identity that is
 * not watched. Local publications, non-share sources, watched remote shares
 * and publications already set undesired never appear.
 *
 * WHAT THIS IS FOR: a defence-in-depth backstop, not the primary gate. In
 * `livekit-client` 2.15.13 an untouched remote publication is already
 * undesired under our connect options:
 *
 * - The `RemoteTrackPublication` constructor sets
 *   `this.subscribed = autoSubscribe`
 *   (`src/room/track/RemoteTrackPublication.ts:46`), and `isDesired` (:108)
 *   is `this.subscribed !== false`.
 * - `RemoteParticipant` passes
 *   `this.signalClient.connectOptions?.autoSubscribe` into that constructor
 *   (`src/room/participant/RemoteParticipant.ts:285-288`), and
 *   `SignalClient.connect` stores those options
 *   (`src/api/SignalClient.ts:292`) on both the join and the resume path
 *   (`reconnect` re-sends the join options).
 * - We connect with `autoSubscribe: false` (`state.tsx`, `room.connect`), so
 *   every remote publication starts with `subscribed === false`.
 * - On a signal resume, `RTCEngine.sendSyncState`
 *   (`src/room/RTCEngine.ts:1507`) lists only publications whose
 *   `isDesired !== autoSubscribe` (:1526), i.e. the desired ones. An
 *   untouched unwatched share is not among them.
 *
 * So this selects only a share that some OTHER path made desired while it is
 * unwatched: a mounted `VideoTrack` visibility observer calling
 * `setSubscribed(true)`, a future surface that subscribes on its own, a
 * changed SDK default, or a connect made without `autoSubscribe: false`. Left
 * desired, such a share is forwarded by the SFU (and re-requested by every
 * resume's SyncState): downloaded and decrypted, its audio able to reach the
 * call recorder, on a share the viewer never pressed Watch for. Only an
 * explicit `setSubscribed(false)` makes it undesired again, so the selector
 * keys on `isDesired`, not on whether this module ever requested it. Our own
 * screen leg is included whether or not its identity is watched: the phone
 * must never pull its own screen back down.
 *
 * Generic so a caller can pass `ReconcilePub` objects carrying their LiveKit
 * publication and get the same objects back to call `setSubscribed(false)` on.
 */
export function sharesToUnsubscribe<P extends ReconcilePub>(
  pubs: readonly P[],
  watched: ReadonlySet<string>,
): P[] {
  const out: P[] = [];
  for (const pub of pubs) {
    if (pub.isLocal) continue;
    if (!isShareSource(pub.source)) continue;
    if (pub.isDesired !== true) continue;
    if (pub.isSelfLeg || !watched.has(pub.identity)) out.push(pub);
  }
  return out;
}

/**
 * How long a watch survives after its identity leaves the room entirely
 * (reconnect churn, a republish through a fresh connection), counted from
 * the moment it was first seen absent, whether it is still away or back in
 * the room but not yet sharing again. A share that is live again only after
 * the grace has run out does not revive the watch.
 */
export const WATCH_ABSENCE_GRACE_MS = 10_000;

/** Input to `pruneWatchedWithGrace`. */
export interface PruneWithGraceInput {
  /** The current watch set. */
  watched: ReadonlySet<string>;
  /** Identities publishing either share source (`liveShareIdentities`). */
  live: ReadonlySet<string>;
  /** Identities of every remote participant currently in the room. */
  present: ReadonlySet<string>;
  /**
   * When each watched identity was first seen absent. Pass back the map the
   * previous call returned: an entry outlives the identity's return to the
   * room until its share is live again, and that is how a return from churn
   * is told apart from a deliberate stop.
   */
  goneSince: ReadonlyMap<string, number>;
  /**
   * The current time in ms. Use a monotonic clock (`performance.now()`), and
   * the same clock for every call that shares one `goneSince`.
   */
  now: number;
  /** Defaults to `WATCH_ABSENCE_GRACE_MS`. */
  graceMs?: number;
}

/**
 * Drop every watch whose identity no longer shares, with an absence grace.
 * For each watched identity:
 *
 * - Sharing (`live`) with no absence record: it never left, so kept.
 * - Sharing (`live`) WITH an absence record: it is back from churn and has
 *   republished. Kept, and the record forgotten, only while the grace from
 *   that record has not run out. Once `graceMs` or more has passed (or the
 *   elapsed time cannot be measured, see the fail-closed edges) it is
 *   DROPPED, and forgotten: a share that comes back after the grace is a
 *   new share and needs a new Watch, however it got there.
 * - Absent from the room entirely: kept, and the absence is recorded the
 *   first time it is seen; dropped (and forgotten) once `graceMs` or more
 *   has passed since that record.
 * - Present in the room but not sharing, WITH an absence record: it is
 *   back from churn and has not republished yet (after a reconnect a
 *   participant rejoins before its share is republished). Kept under the
 *   same bound as an absent identity, measured from the ORIGINAL record,
 *   which is carried forward unchanged: a return never restarts the grace,
 *   so leaving and rejoining repeatedly cannot stretch it.
 * - Present in the room but not sharing, WITHOUT an absence record: it
 *   never left, so the share was stopped on purpose. Dropped at once, and a
 *   re-share needs a new Watch.
 *
 * A live share within the grace clears the record, so a stop after a
 * completed return is a deliberate stop again. `goneSince` entries for
 * identities no longer watched are discarded. Returns NEW containers; the
 * inputs are untouched.
 *
 * WHAT THE BOUND RESTS ON. Because a live identity's record is checked too,
 * a re-prune that runs late (a timer throttled in a background tab) still
 * drops a share that came back after the grace. What the bound needs is the
 * absence being RECORDED: a leave and a return that both happen between two
 * calls are never seen, so the caller must run this whenever a participant
 * leaves. The caller should also re-run it at the deadline
 * (`nextWatchPruneAt`), so an expired watch is released when it expires
 * rather than at the next unrelated prune.
 *
 * Fail-closed edges, for every identity carrying a record, live or not (each
 * drops the watch, costing the viewer one extra Watch click, never a share
 * they did not re-confirm):
 * - The clock went backwards (`now` earlier than the recorded absence): the
 *   elapsed absence cannot be measured, so the grace bound cannot be proven.
 *   Keeping instead would hold the watch until the clock caught back up,
 *   which after a large jump is unbounded.
 * - A non-finite `now` or recorded time (the elapsed time is NaN).
 * - A non-finite or non-positive `graceMs` is treated as 0: no grace at
 *   all, so an absent identity is dropped at once, and so is a live one
 *   that carries a record.
 */
export function pruneWatchedWithGrace(input: PruneWithGraceInput): {
  watched: Set<string>;
  goneSince: Map<string, number>;
} {
  const { watched, live, present, goneSince, now } = input;
  const requested = input.graceMs ?? WATCH_ABSENCE_GRACE_MS;
  const graceMs = Number.isFinite(requested) && requested > 0 ? requested : 0;
  const nextWatched = new Set<string>();
  const nextGone = new Map<string, number>();
  for (const identity of watched) {
    const recorded = goneSince.get(identity);
    if (live.has(identity)) {
      // Back sharing after an absence: kept only within the grace, and the
      // record is forgotten either way. A NaN elapsed time fails both
      // comparisons and a backwards clock fails the first, so both count as
      // expired.
      if (recorded !== undefined) {
        const elapsed = now - recorded;
        const withinGrace = elapsed >= 0 && elapsed < graceMs;
        if (!withinGrace) continue;
      }
      nextWatched.add(identity);
      continue;
    }
    // Present, not sharing, never seen absent: a deliberate stop.
    if (present.has(identity) && recorded === undefined) continue;
    // Absent, or back but not yet sharing: bounded from the original
    // record, never refreshed here.
    const since = recorded ?? now;
    const elapsed = now - since;
    if (!Number.isFinite(elapsed) || elapsed < 0) continue;
    if (elapsed >= graceMs) continue;
    nextWatched.add(identity);
    nextGone.set(identity, since);
  }
  return { watched: nextWatched, goneSince: nextGone };
}

/**
 * The earliest time at which `pruneWatchedWithGrace` would drop a watch
 * held by the grace — one still absent, or back in the room but not yet
 * sharing (both keep their `goneSince` entry) — so schedule a re-prune for
 * then; or `null` when nothing is pending. Pass the `goneSince` that
 * `pruneWatchedWithGrace` returned. Non-finite entries are skipped: the
 * prune itself already drops those.
 */
export function nextWatchPruneAt(
  goneSince: ReadonlyMap<string, number>,
  graceMs: number = WATCH_ABSENCE_GRACE_MS,
): number | null {
  const grace = Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 0;
  let earliest: number | null = null;
  for (const since of goneSince.values()) {
    if (!Number.isFinite(since)) continue;
    const at = since + grace;
    if (earliest === null || at < earliest) earliest = at;
  }
  return earliest;
}
