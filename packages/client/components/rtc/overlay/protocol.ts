/**
 * Wire protocol for the in-game voice overlay.
 *
 * Shared by the publisher (main window, owns the LiveKit `Room`) and the
 * overlay renderer (a passive window with no client, no session and no room).
 * Both live in the same bundle and the same origin, so this is not a network
 * format — but it IS a cross-window boundary that survives a reload of either
 * side independently, so it is versioned and validated all the same.
 *
 * Design notes that are load-bearing:
 *
 * - **Full snapshot every message, never diffs.** Participant lists are tiny;
 *   snapshots make the overlay stateless and self-healing, so a dropped or
 *   out-of-order message costs one frame instead of desynchronising the two
 *   windows permanently.
 * - **Ids that cross are ALWAYS device-suffix-stripped.** LiveKit identities
 *   are `"{user_id}:{device_id}"` (E2EE 6.1/6.4) and a user with two devices
 *   in the call must appear once — see {@link collapseParticipants}.
 * - **Avatar URLs cross as finished strings.** The overlay cannot compute
 *   them: that needs a live `Client` (`configuration.features.autumn.url`)
 *   plus hydrated `User` objects, and the overlay window deliberately has
 *   neither. Autumn URLs and `default_avatar` are unauthenticated GETs, so a
 *   session-less `<img src>` renders them fine.
 */

/** BroadcastChannel name. Same bundled origin on both desktop shells. */
export const OVERLAY_CHANNEL = "sloga:voice-overlay";

/** Only version this build speaks. Anything else is ignored on receipt. */
export const OVERLAY_PROTOCOL_VERSION = 1;

export type OverlayDisplayMode = "avatars" | "avatars-names" | "names";

export const OVERLAY_DISPLAY_MODES: OverlayDisplayMode[] = [
  "avatars",
  "avatars-names",
  "names",
];

/**
 * Where the overlay anchors. Still called `corner` on the wire — the two
 * mid-edge anchors were added after the field was named, and renaming it
 * would break nothing but buy nothing either.
 */
export type OverlayCorner =
  | "top-left"
  | "top-right"
  | "middle-left"
  | "middle-right"
  | "bottom-left"
  | "bottom-right";

export const OVERLAY_CORNERS: OverlayCorner[] = [
  "top-left",
  "top-right",
  "middle-left",
  "middle-right",
  "bottom-left",
  "bottom-right",
];

/** Bounds of the user-facing settings, enforced by the store's `clean()`. */
// 0.1, not 0.2: at 20% a light roster over dark game footage still reads as
// solid, because perceived contrast against a dark background falls off far
// more slowly than alpha does. Asked for after the first live game test.
export const OVERLAY_OPACITY_MIN = 0.1;
export const OVERLAY_OPACITY_MAX = 1;
export const OVERLAY_SCALE_MIN = 0.6;
export const OVERLAY_SCALE_MAX = 2;

export type OverlayConfig = {
  /** 0.1–1 */
  opacity: number;
  /** 0.6–2 */
  scale: number;
  displayMode: OverlayDisplayMode;
  showLatency: boolean;
  corner: OverlayCorner;
};

export type OverlayParticipant = {
  /** User id — ALWAYS device-suffix-stripped. */
  id: string;
  /** Resolved display name (member nick > display name), computed main-side. */
  name: string;
  /** Finished URL string, computed main-side. */
  avatarUrl?: string;
  /** OR across the user's devices. */
  speaking: boolean;
  /** AND across the user's devices — see {@link collapseParticipants}. */
  muted: boolean;
  self: boolean;
};

export type OverlayStateMsg = {
  v: 1;
  type: "state";
  seq: number;
  participants: OverlayParticipant[];
  rttMs?: number;
  config: OverlayConfig;
};

/** Call ended, or the overlay was switched off. */
export type OverlayByeMsg = { v: 1; type: "bye" };

/** Overlay → main: "I just booted, send me a snapshot." */
export type OverlayHelloMsg = { v: 1; type: "hello" };

export type OverlayMsg = OverlayStateMsg | OverlayByeMsg | OverlayHelloMsg;

/**
 * Narrow an untrusted `MessageEvent.data` to a message this build understands.
 *
 * Unknown `v` or `type` returns undefined and the caller ignores it — that is
 * the forward-compatibility rule: a newer publisher talking to an older
 * overlay (possible for exactly as long as it takes the user to reload the
 * main window after an update) must degrade to "no update", never to a crash
 * in a window that has no error boundary and no way to report.
 */
export function parseOverlayMsg(data: unknown): OverlayMsg | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const msg = data as Partial<OverlayMsg>;
  if (msg.v !== OVERLAY_PROTOCOL_VERSION) return undefined;
  if (msg.type === "bye" || msg.type === "hello") return msg as OverlayMsg;
  if (msg.type !== "state") return undefined;

  const state = msg as Partial<OverlayStateMsg>;
  if (typeof state.seq !== "number") return undefined;
  if (!Array.isArray(state.participants)) return undefined;
  if (typeof state.config !== "object" || state.config === null) {
    return undefined;
  }
  return state as OverlayStateMsg;
}

/**
 * Per-device facts the publisher reads off the LiveKit room, before collapse.
 * `identity` is the RAW device-qualified identity.
 */
export type OverlayDeviceState = {
  identity: string;
  speaking: boolean;
  muted: boolean;
};

/** What the roster (channel-side, already per-user) contributes. */
export type OverlayRosterEntry = {
  userId: string;
  name: string;
  avatarUrl?: string;
  self: boolean;
};

/**
 * Collapse the roster + per-device LiveKit state into one entry per user.
 *
 * The two aggregations are deliberately NOT the same operator:
 *
 * - `speaking` is **OR** — any device of theirs transmitting means the user is
 *   talking, and the ring should be on.
 * - `muted` is **AND** — a user sitting in the call on a muted idle laptop
 *   while actively talking on their phone must NOT show a `mic_off` badge
 *   pulsing next to their speaking ring. Only "every device of theirs is
 *   muted" is honestly "muted".
 *
 * Roster order is preserved. A roster user with no matching LiveKit device
 * (joined the channel, media not up yet, or a non-E2EE identity spelling we
 * failed to match) reports `speaking: false, muted: false` rather than being
 * dropped: showing them silent is right, and hiding someone who is in the
 * channel is not.
 */
export function collapseParticipants(
  roster: OverlayRosterEntry[],
  devices: OverlayDeviceState[],
  stripDeviceSuffix: (identity: string) => string,
): OverlayParticipant[] {
  const byUser = new Map<string, { speaking: boolean; muted: boolean }>();

  for (const device of devices) {
    const userId = stripDeviceSuffix(device.identity);
    const existing = byUser.get(userId);
    if (existing) {
      existing.speaking = existing.speaking || device.speaking;
      existing.muted = existing.muted && device.muted;
    } else {
      byUser.set(userId, { speaking: device.speaking, muted: device.muted });
    }
  }

  return roster.map((entry) => {
    const live = byUser.get(entry.userId);
    return {
      id: entry.userId,
      name: entry.name,
      avatarUrl: entry.avatarUrl,
      speaking: live?.speaking ?? false,
      muted: live?.muted ?? false,
      self: entry.self,
    };
  });
}

/**
 * Is there a call to draw an overlay for?
 *
 * BOTH halves are required and neither is redundant:
 *
 * - `room()` alone is wrong. LiveKit's drop path
 *   (`room.addListener("disconnected", …)`, state.tsx) only sets
 *   `state("DISCONNECTED")` and LEAVES `room()` set — only `disconnect()`
 *   clears it, and that runs on user actions and MLS auto-leave. So watching
 *   the room alone means a mid-game Wi-Fi drop leaves the publisher
 *   heartbeating a frozen snapshot forever: the overlay floats over the game
 *   and the staleness timers never engage, because the publisher is alive and
 *   still talking.
 * - `state()` alone is wrong too. A manual hangup returns to `"READY"`, which
 *   is indistinguishable from "idle, never joined" — `room()` is the cleaner
 *   edge for that direction.
 *
 * There is deliberately no `"RECONNECTING"` handling: no `#setState(
 * "RECONNECTING")` exists in state.tsx, so the state is unreachable today.
 * If reconnect handling ever lands, revisit this — a reconnecting call should
 * probably keep the overlay up.
 */
export function overlayInCall(
  room: unknown | undefined,
  state: string,
): boolean {
  return room !== undefined && state !== "DISCONNECTED";
}
