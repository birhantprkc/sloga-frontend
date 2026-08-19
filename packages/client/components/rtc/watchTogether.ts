/**
 * Watch-together store (plan §2) — a sub-object of the Voice state, beside
 * `remoteControl`, because the player must outlive every component: the
 * call card unmounts the moment the user browses to a text channel, and
 * the player element must never be detached (a detached iframe loses its
 * browsing context and reloads; a detached <video> is paused by spec).
 *
 * Owns:
 * - the session as last received over the WS (`WatchSessionUpdate`, full
 *   state, applied iff `seq` advances for the same session id);
 * - the ONE player host `<div>` that `VoiceCallCard.tsx` mounts as a direct
 *   child of its persistent `<Float>` (never inside a card) and positions
 *   over whatever rect the overlay reserves (`setAnchor`);
 * - the current provider (YouTube in slice 1) and its element;
 * - the clock offset (server − local) from the HTTP round trips;
 * - the sync loop: viewers run the pure `reconcile()` every 500 ms; the
 *   host heartbeats its REAL position every 5 s and PATCHes on every
 *   observed provider state change, keeping ONE request in flight.
 *
 * Sloga relays control state only. The media is fetched by each viewer from
 * the provider on their own machine — nothing here touches a Sloga server
 * except the tiny session JSON.
 */
import { createSignal, type Accessor, type Setter } from "solid-js";

import type { Channel, WatchMediaData, WatchResult, WatchSessionData } from "stoat.js";

import type { Provider, ProviderStatus } from "@revolt/ui/components/features/voice/watch/providers/provider";
import { YouTubeProvider } from "@revolt/ui/components/features/voice/watch/providers/youtubeProvider";
import {
  INITIAL_SYNC_STATE,
  RATE_NORMAL,
  reconcile,
  type SyncAction,
  type SyncState,
} from "@revolt/ui/components/features/voice/watch/syncController";
import { hostUnreachable } from "@revolt/ui/components/features/voice/watch/watchPolicy";

/** Viewer corrector tick. */
const TICK_MS = 500;
/** Host heartbeat: real position + playing, even when nothing changed. */
const HEARTBEAT_MS = 5000;
/** Host scrub coalescing: at most one PATCH per this window while seeking. */
const SCRUB_DEBOUNCE_MS = 250;
/** "Tap to start": no `playing` within this after we asked → autoplay blocked. */
const AUTOPLAY_GRACE_MS = 3000;
/** Host-unreachable re-check cadence. */
const UNREACHABLE_CHECK_MS = 5000;

const LS_VOLUME = "sloga:watch:volume";
const LS_MUTED = "sloga:watch:muted";

export interface WatchStats {
  driftMs: number | null;
  expectedMs: number;
  currentMs: number | null;
  offsetMs: number;
  seq: number;
  heartbeatAgeMs: number | null;
  providerState: string;
  nudgeRate: number;
}

export interface WatchContext {
  /** The connected call's channel (undefined when not in a call). */
  channel: Accessor<Channel | undefined>;
  /** `voice.state() === "CONNECTED"`. */
  connected: Accessor<boolean>;
  /** This user's id (for host detection). */
  localUserId: Accessor<string | undefined>;
}

export class WatchTogether {
  /** Current session for THE CALL WE ARE IN, or undefined. */
  readonly session: Accessor<WatchSessionData | undefined>;
  #setSession: Setter<WatchSessionData | undefined>;
  /** Live provider status (state/title/error/duration…), for the UI. */
  readonly providerStatus: Accessor<ProviderStatus | undefined>;
  #setProviderStatus: Setter<ProviderStatus | undefined>;
  /** Last API error id shown in the overlay (cleared on next success). */
  readonly error: Accessor<string | undefined>;
  #setError: Setter<string | undefined>;
  /** Autoplay was blocked for this viewer → show "Tap to start". */
  readonly needsTap: Accessor<boolean>;
  #setNeedsTap: Setter<boolean>;
  /** No update for >60 s while the session says playing (plan §1). */
  readonly hostUnreachable: Accessor<boolean>;
  #setHostUnreachable: Setter<boolean>;
  /** The paste-URL picker is open (no session yet). */
  readonly pickerOpen: Accessor<boolean>;
  readonly setPickerOpen: Setter<boolean>;
  /** Per-viewer volume / mute (localStorage, never synced). */
  readonly volume: Accessor<number>;
  #setVolume: Setter<number>;
  readonly muted: Accessor<boolean>;
  #setMuted: Setter<boolean>;
  /** Debug line for the live leg (plan §9). */
  readonly stats: Accessor<WatchStats | undefined>;
  #setStats: Setter<WatchStats | undefined>;
  /** A request is in flight (buttons disable). */
  readonly busy: Accessor<boolean>;
  #setBusy: Setter<boolean>;

  /**
   * The ONE player host. Mounted by `VoiceCallCard.tsx` inside `<Float>`
   * (pointer-events re-enabled — Float itself is `pointer-events: none`),
   * hidden until an overlay anchors it somewhere.
   */
  readonly host: HTMLDivElement;

  #ctx: WatchContext | undefined;
  #provider: Provider | undefined;
  #providerUnsub: (() => void) | undefined;
  #providerKey: string | undefined;
  #syncState: SyncState = INITIAL_SYNC_STATE;
  #offsetMs = 0;
  #offsetRtt = Number.POSITIVE_INFINITY;
  #lastUpdateLocalMs: number | null = null;
  #lastSeqBySession = new Map<string, number>();
  #tick: ReturnType<typeof setInterval> | undefined;
  #heartbeat: ReturnType<typeof setInterval> | undefined;
  #unreachableTimer: ReturnType<typeof setInterval> | undefined;
  #playAskedAt: number | null = null;
  #anchor: HTMLElement | undefined;
  #anchorObserver: ResizeObserver | undefined;
  #anchorPoll: ReturnType<typeof setInterval> | undefined;
  /** Host write coalescing: one in flight, latest intent queued. */
  #inFlight: Promise<void> | undefined;
  #queued: { playing?: boolean; positionMs?: number; ratePermille?: number; media?: WatchMediaData } | undefined;
  #scrubTimer: ReturnType<typeof setTimeout> | undefined;
  #nudgeRate = RATE_NORMAL;

  constructor() {
    [this.session, this.#setSession] = createSignal<WatchSessionData | undefined>();
    [this.providerStatus, this.#setProviderStatus] = createSignal<ProviderStatus | undefined>();
    [this.error, this.#setError] = createSignal<string | undefined>();
    [this.needsTap, this.#setNeedsTap] = createSignal(false);
    [this.hostUnreachable, this.#setHostUnreachable] = createSignal(false);
    [this.pickerOpen, this.setPickerOpen] = createSignal(false);
    [this.stats, this.#setStats] = createSignal<WatchStats | undefined>();
    [this.busy, this.#setBusy] = createSignal(false);
    [this.volume, this.#setVolume] = createSignal(readVolume());
    [this.muted, this.#setMuted] = createSignal(readMuted());

    const host = document.createElement("div");
    host.className = "sloga-watch-host";
    host.style.cssText =
      "position:absolute;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:auto;overflow:hidden;border-radius:8px;background:#000;z-index:1";
    this.host = host;
  }

  /** Wire the Voice state's accessors (once, from the Voice constructor). */
  setContext(ctx: WatchContext) {
    this.#ctx = ctx;
  }

  /** Are WE the host of the current session? */
  isHost(): boolean {
    const s = this.session();
    const me = this.#ctx?.localUserId();
    return !!s && !!me && s.host_id === me;
  }

  /** Where the overlay wants the player: the host follows this element's rect. */
  setAnchor(el: HTMLElement | undefined) {
    this.#anchor = el;
    this.#anchorObserver?.disconnect();
    this.#anchorObserver = undefined;
    if (this.#anchorPoll) clearInterval(this.#anchorPoll);
    this.#anchorPoll = undefined;
    if (!el) {
      // Parked: keep playing (audio continues), just invisible and zero-size.
      this.host.style.visibility = "hidden";
      this.host.style.width = "0px";
      this.host.style.height = "0px";
      return;
    }
    const follow = () => this.#followAnchor();
    this.#anchorObserver = new ResizeObserver(follow);
    this.#anchorObserver.observe(el);
    // Docking/PiP transitions move the Float without resizing the slot —
    // a cheap poll covers transforms the observer cannot see.
    this.#anchorPoll = setInterval(follow, 300);
    follow();
  }

  #followAnchor() {
    const el = this.#anchor;
    const parent = this.host.parentElement;
    if (!el || !parent) return;
    const a = el.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    if (a.width < 2 || a.height < 2) {
      this.host.style.visibility = "hidden";
      return;
    }
    this.host.style.left = `${a.left - p.left}px`;
    this.host.style.top = `${a.top - p.top}px`;
    this.host.style.width = `${a.width}px`;
    this.host.style.height = `${a.height}px`;
    this.host.style.visibility = "visible";
  }

  // ---- WS events (called from state.tsx, already scoped to our call) -----

  onUpdate(detail: { channelId: string; session: WatchSessionData }) {
    const s = detail.session;
    const last = this.#lastSeqBySession.get(s.id) ?? -1;
    if (s.seq <= last) return; // stale / reordered
    this.#lastSeqBySession.set(s.id, s.seq);
    this.#lastUpdateLocalMs = Date.now();
    this.#setHostUnreachable(false);
    this.#setError(undefined);
    this.#setSession(s);
    this.setPickerOpen(false);
    this.#ensureProvider(s);
    this.#ensureLoops();
  }

  onEnd(detail: { channelId: string; id: string }) {
    void detail;
    this.#clearSession();
  }

  // ---- call lifecycle (from state.tsx) ----------------------------------

  /** On CONNECTED (and on bonfire `ready` / reconnect): learn the session. */
  async attach() {
    if (!this.#ctx?.channel()) return;
    await this.refetch(true);
  }

  /** On leaving CONNECTED: host ends its session; player disposed. */
  detach() {
    const wasHost = this.isHost();
    const ch = this.#ctx?.channel();
    if (wasHost && ch) void ch.endWatch();
    this.#clearSession();
    this.setPickerOpen(false);
  }

  /**
   * GET the session. A 404 clears a session we thought existed. On
   * `NotInVoiceChannel` retry once (LiveKit `connected` can race ingress
   * writing `vc_members`).
   */
  async refetch(retry = false) {
    const ch = this.#ctx?.channel();
    if (!ch) return;
    const r = await ch.fetchWatch();
    if (r.ok) {
      this.#noteClock(r);
      this.onUpdate({ channelId: ch.id, session: r.body.session });
      return;
    }
    if (r.status === 404) {
      this.#clearSession();
      return;
    }
    if (retry && r.error === "NotInVoiceChannel") {
      setTimeout(() => void this.refetch(false), 1000);
    }
  }

  // ---- host / starter actions -------------------------------------------

  async start(media: WatchMediaData): Promise<boolean> {
    const ch = this.#ctx?.channel();
    if (!ch) return false;
    this.#setBusy(true);
    this.#setError(undefined);
    try {
      const r = await ch.startWatch(media);
      if (!r.ok) {
        this.#setError(r.error);
        return false;
      }
      this.#noteClock(r);
      this.onUpdate({ channelId: ch.id, session: r.body.session });
      return true;
    } finally {
      this.#setBusy(false);
    }
  }

  async end(): Promise<void> {
    const ch = this.#ctx?.channel();
    if (!ch) return;
    this.#setBusy(true);
    try {
      const r = await ch.endWatch();
      if (!r.ok) this.#setError(r.error);
      else this.#clearSession();
    } finally {
      this.#setBusy(false);
    }
  }

  /** Host: play/pause/seek/rate — local player first, then the write. */
  hostPlay() {
    this.#provider?.play();
    this.#queueWrite({ playing: true });
  }
  hostPause() {
    this.#provider?.pause();
    this.#queueWrite({ playing: false });
  }
  hostSeek(ms: number) {
    this.#provider?.seek(ms);
    this.#queueWrite({ positionMs: ms }, /* scrub */ true);
  }
  hostSetRate(permille: number) {
    this.#provider?.setRate(permille);
    this.#queueWrite({ ratePermille: permille });
  }
  /** Host: swap the video without ending the session. */
  hostSwap(media: WatchMediaData) {
    this.#queueWrite({ media, positionMs: 0, playing: false });
  }

  // ---- viewer-local --------------------------------------------------------

  setVolume(v: number) {
    const vol = Math.max(0, Math.min(100, Math.round(v)));
    this.#setVolume(vol);
    try {
      localStorage.setItem(LS_VOLUME, String(vol));
    } catch {
      /* private mode */
    }
    this.#provider?.setVolume(vol);
  }
  setMuted(m: boolean) {
    this.#setMuted(m);
    try {
      localStorage.setItem(LS_MUTED, m ? "1" : "0");
    } catch {
      /* private mode */
    }
    this.#provider?.setMuted(m);
  }
  /** "Tap to start" — issue play from the user's gesture. */
  tapToStart() {
    this.#setNeedsTap(false);
    this.#playAskedAt = Date.now();
    this.#provider?.play();
  }

  /** The provider's element, for tests / debugging. */
  providerElement(): HTMLElement | undefined {
    return this.#provider?.element;
  }

  // ---- internals -------------------------------------------------------------

  #noteClock(r: Extract<WatchResult, { ok: true }>) {
    if (!r.body) return;
    const rtt = r.receivedAt - r.sentAt;
    // Min-RTT sample wins: the tightest round trip has the least asymmetry.
    if (rtt <= this.#offsetRtt || !Number.isFinite(this.#offsetRtt)) {
      this.#offsetRtt = rtt;
      this.#offsetMs = r.body.server_now - (r.sentAt + rtt / 2);
    }
  }

  #serverNow(): number {
    return Date.now() + this.#offsetMs;
  }

  #clearSession() {
    this.#setSession(undefined);
    this.#setNeedsTap(false);
    this.#setHostUnreachable(false);
    this.#setStats(undefined);
    this.#lastUpdateLocalMs = null;
    this.#disposeProvider();
    this.#stopLoops();
    this.#queued = undefined;
    if (this.#scrubTimer) clearTimeout(this.#scrubTimer);
    this.#scrubTimer = undefined;
  }

  #ensureProvider(s: WatchSessionData) {
    const key = providerKey(s.media);
    if (this.#provider && this.#providerKey === key) return;
    this.#disposeProvider();
    this.#providerKey = key;
    this.#syncState = INITIAL_SYNC_STATE;
    this.#nudgeRate = RATE_NORMAL;
    if (s.media.provider === "youtube") {
      const p = new YouTubeProvider({
        videoId: s.media.video_id,
        // The host gets YouTube's own bar as a control surface; viewers
        // don't, so scrubbing it can't desync them (plan §4.1).
        controls: this.isHost(),
        volume: this.volume(),
        muted: this.muted(),
      });
      this.#provider = p;
      this.host.appendChild(p.element);
      this.#providerUnsub = p.onChange((st) => this.#onProviderChange(st));
      this.#setProviderStatus(p.status());
      this.#playAskedAt = s.playing ? Date.now() : null;
    } else {
      // Jellyfin lands in slice 2. Show the session; no player yet.
      this.#provider = undefined;
      this.#setProviderStatus(undefined);
    }
  }

  #disposeProvider() {
    this.#providerUnsub?.();
    this.#providerUnsub = undefined;
    this.#provider?.dispose();
    this.#provider = undefined;
    this.#providerKey = undefined;
    this.#setProviderStatus(undefined);
  }

  #onProviderChange(st: ProviderStatus) {
    this.#setProviderStatus(st);
    if (st.state === "playing") {
      this.#playAskedAt = null;
      this.#setNeedsTap(false);
    }
    if (this.isHost()) {
      // Any state change the host's player reports (clicked the video,
      // ended, stalled) is host truth — write it (plan §1, rev 3).
      if (st.state === "playing" || st.state === "paused" || st.state === "ended") {
        this.#queueWrite({ playing: st.state === "playing" });
      }
      // Title learned from the embed: write it once so late joiners see it.
      const s = this.session();
      if (st.title && s?.media.provider === "youtube" && !s.media.title) {
        this.#queueWrite({ media: { ...s.media, title: st.title } });
      }
    }
  }

  #ensureLoops() {
    if (!this.#tick) this.#tick = setInterval(() => this.#onTick(), TICK_MS);
    if (!this.#heartbeat) this.#heartbeat = setInterval(() => this.#onHeartbeat(), HEARTBEAT_MS);
    if (!this.#unreachableTimer) {
      this.#unreachableTimer = setInterval(() => {
        const s = this.session();
        if (!s) return;
        if (this.isHost()) return;
        const unreachable = hostUnreachable({
          playing: s.playing,
          lastUpdateLocalMs: this.#lastUpdateLocalMs,
          nowLocalMs: Date.now(),
        });
        if (unreachable !== this.hostUnreachable()) {
          this.#setHostUnreachable(unreachable);
          if (unreachable) void this.refetch(false);
        }
      }, UNREACHABLE_CHECK_MS);
    }
  }

  #stopLoops() {
    if (this.#tick) clearInterval(this.#tick);
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#unreachableTimer) clearInterval(this.#unreachableTimer);
    this.#tick = this.#heartbeat = this.#unreachableTimer = undefined;
  }

  #onTick() {
    const s = this.session();
    const p = this.#provider;
    if (!s || !p) return;
    const st = p.status();
    const nowLocal = Date.now();
    const nowServer = this.#serverNow();

    if (this.isHost()) {
      // Host is ground truth: no correction, only the debug line.
      this.#setStats({
        driftMs: null,
        expectedMs: st.currentTimeMs ?? 0,
        currentMs: st.currentTimeMs,
        offsetMs: Math.round(this.#offsetMs),
        seq: s.seq,
        heartbeatAgeMs: this.#lastUpdateLocalMs == null ? null : nowLocal - this.#lastUpdateLocalMs,
        providerState: st.state,
        nudgeRate: RATE_NORMAL,
      });
      return;
    }

    const result = reconcile(
      {
        session: {
          playing: s.playing,
          positionMs: s.position_ms,
          positionAt: s.position_at,
          ratePermille: s.rate_permille,
        },
        provider: {
          state: st.state,
          currentTimeMs: st.currentTimeMs,
          ratePermille: st.ratePermille,
          capabilities: p.capabilities,
        },
        nowLocalMs: nowLocal,
        nowServerMs: nowServer,
      },
      this.#syncState,
    );
    this.#syncState = result.state;
    for (const a of result.actions) this.#apply(p, a);

    // Autoplay-blocked detection: we asked for play and nothing happened.
    if (
      s.playing &&
      this.#playAskedAt != null &&
      st.state !== "playing" &&
      nowLocal - this.#playAskedAt > AUTOPLAY_GRACE_MS &&
      (st.state === "cued" || st.state === "unstarted" || st.state === "paused")
    ) {
      this.#setNeedsTap(true);
    }

    this.#setStats({
      driftMs: result.driftMs == null ? null : Math.round(result.driftMs),
      expectedMs: Math.round(result.expectedMs),
      currentMs: st.currentTimeMs == null ? null : Math.round(st.currentTimeMs),
      offsetMs: Math.round(this.#offsetMs),
      seq: s.seq,
      heartbeatAgeMs: this.#lastUpdateLocalMs == null ? null : nowLocal - this.#lastUpdateLocalMs,
      providerState: st.state,
      nudgeRate: this.#nudgeRate,
    });
  }

  #apply(p: Provider, a: SyncAction) {
    switch (a.type) {
      case "seek":
        p.seek(a.ms);
        break;
      case "play":
        if (this.#playAskedAt == null) this.#playAskedAt = Date.now();
        p.play();
        break;
      case "pause":
        p.pause();
        break;
      case "setRate":
        this.#nudgeRate = a.permille;
        p.setRate(a.permille);
        break;
    }
  }

  #onHeartbeat() {
    if (!this.isHost()) return;
    this.#queueWrite({});
  }

  /**
   * Host write: always the FULL host-owned state (the provider's REAL
   * position + playing, plus whatever the caller overrides), one request in
   * flight, latest intent coalesced. Scrubs are additionally debounced.
   */
  #queueWrite(
    over: { playing?: boolean; positionMs?: number; ratePermille?: number; media?: WatchMediaData },
    scrub = false,
  ) {
    this.#queued = { ...(this.#queued ?? {}), ...over };
    if (scrub) {
      if (this.#scrubTimer) return;
      this.#scrubTimer = setTimeout(() => {
        this.#scrubTimer = undefined;
        void this.#flush();
      }, SCRUB_DEBOUNCE_MS);
      return;
    }
    void this.#flush();
  }

  async #flush(): Promise<void> {
    if (this.#inFlight) {
      // Another write is running; it re-checks the queue when it lands.
      return;
    }
    const ch = this.#ctx?.channel();
    const s = this.session();
    const p = this.#provider;
    if (!ch || !s || !this.isHost()) {
      this.#queued = undefined;
      return;
    }
    const over = this.#queued ?? {};
    this.#queued = undefined;
    const st = p?.status();
    const playing = over.playing ?? (st ? st.state === "playing" : s.playing);
    const positionMs = Math.max(0, Math.round(over.positionMs ?? st?.currentTimeMs ?? s.position_ms));
    const ratePermille = over.ratePermille ?? s.rate_permille;
    this.#inFlight = (async () => {
      const r = await ch.updateWatch({
        playing,
        position_ms: positionMs,
        rate_permille: ratePermille,
        ...(over.media ? { media: over.media } : {}),
      });
      if (r.ok) {
        this.#noteClock(r);
        // Adopt the stamped seq/position_at without waiting for our own event.
        this.onUpdate({ channelId: ch.id, session: r.body.session });
      } else if (r.status === 404) {
        this.#clearSession();
      } else if (r.status === 403) {
        // We are no longer host (handoff / moderator) — stop writing.
        this.#setError(r.error);
      }
    })().finally(() => {
      this.#inFlight = undefined;
      if (this.#queued) void this.#flush();
    });
    await this.#inFlight;
  }
}

function providerKey(m: WatchMediaData): string {
  return m.provider === "youtube" ? `yt:${m.video_id}` : `jf:${m.server_url}:${m.item_id}`;
}

function readVolume(): number {
  try {
    const raw = localStorage.getItem(LS_VOLUME);
    if (raw == null) return 100;
    const v = Number(raw);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 100;
  } catch {
    return 100;
  }
}

function readMuted(): boolean {
  try {
    return localStorage.getItem(LS_MUTED) === "1";
  } catch {
    return false;
  }
}
