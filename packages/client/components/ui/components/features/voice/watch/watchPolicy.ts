/**
 * Visibility / eligibility policy for watch-together (plan §2). Pure — no
 * Solid, no DOM — so it runs under `node --test` without the
 * `--conditions=browser` dance the reactive files need:
 *   node --test components/ui/components/features/voice/watch/watchPolicy.test.ts
 *
 * The actions-bar button, the overlay and the player host all sit behind
 * these two functions, so the ENABLE_WATCH_TOGETHER flag passed in here is
 * the single point that darkens the lot (the minigamePolicy shape).
 */

/** Everything the overlay-visibility rule reads, already unwrapped from signals. */
export interface WatchOverlayInputs {
  /** `CONFIGURATION.ENABLE_WATCH_TOGETHER` — build-time gate, default off. */
  enabled: boolean;
  /** `voice.state() === "CONNECTED"`. */
  connected: boolean;
  /** A session exists for THE CALL WE ARE IN (not some other device's call). */
  hasSession: boolean;
  /** Theater mode hides all chrome; the overlay is chrome. The player host
   * (audio) is NOT hidden by this — only our overlay is. */
  immersive: boolean;
}

/** The overlay (our chrome over the participant area) exists iff all hold. */
export function watchOverlayVisible(i: WatchOverlayInputs): boolean {
  return i.enabled && i.connected && i.hasSession && !i.immersive;
}

/** Everything the "Watch together" button rule reads. */
export interface WatchStartInputs {
  enabled: boolean;
  connected: boolean;
  /**
   * `channel.havePermission("UseWatchTogether")` for server channels; DMs
   * and group DMs pass `true` (the server does not consult the bit there —
   * remote-control table rule).
   */
  hasPermission: boolean;
  /** A session already exists → the button becomes "open the overlay", not start. */
  hasSession: boolean;
}

/** Whether the actions-bar button is shown at all. */
export function watchButtonVisible(i: WatchStartInputs): boolean {
  return i.enabled && i.connected && (i.hasPermission || i.hasSession);
}

/** Whether pressing it may START a session (vs. just revealing one). */
export function watchCanStart(i: WatchStartInputs): boolean {
  return i.enabled && i.connected && i.hasPermission && !i.hasSession;
}

/**
 * Host-unreachable rule (plan §1): the session TTL expiring fans no event,
 * so a viewer that has seen no update for this long while the session says
 * `playing` shows a banner and re-fetches; a 404 then clears it.
 */
export const HOST_UNREACHABLE_AFTER_MS = 60_000;

export function hostUnreachable(i: {
  playing: boolean;
  lastUpdateLocalMs: number | null;
  nowLocalMs: number;
}): boolean {
  if (!i.playing || i.lastUpdateLocalMs == null) return false;
  return i.nowLocalMs - i.lastUpdateLocalMs > HOST_UNREACHABLE_AFTER_MS;
}
