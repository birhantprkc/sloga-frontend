/**
 * Which VAPID key a browser push subscription was made with, and what to do
 * when it is not the one the server now advertises.
 *
 * Pure on purpose, and deliberately free of imports, so `node --test` can load
 * it (`webPushKey.test.ts`). The glue that acts on these answers lives in
 * `NotificationsController.ts`.
 *
 * Why this exists: a push subscription is bound to the key it was created
 * with, and the browser keeps handing back the old subscription from
 * `getSubscription()` after the server rotates its key. Pushes signed with the
 * new key are then rejected by the push service (403 from FCM and Apple, 401
 * from Mozilla), and nothing on the client ever notices. So setup compares the
 * subscription's key with the advertised one and re-subscribes on a mismatch.
 *
 * Keys travel as base64 in either alphabet and with or without padding (the
 * server publishes 87-char unpadded base64url; older dev configs are padded).
 * A P-256 public key is always 65 bytes, uncompressed, starting with `0x04`.
 */

/** Length of an uncompressed P-256 public key. */
const VAPID_KEY_LENGTH = 65;

/** First byte of an uncompressed elliptic-curve point. */
const UNCOMPRESSED_POINT = 0x04;

/**
 * Decode an advertised VAPID public key into the bytes `subscribe()` wants.
 *
 * Accepts `+/` or `-_`, padded or not, with surrounding whitespace trimmed.
 * Anything that is not exactly an uncompressed P-256 point comes back as
 * `null` rather than throwing, so a broken configuration is caught here
 * instead of by the browser.
 */
export function decodeVapidKey(s: string): Uint8Array | null {
  const normalized = s.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) return null;

  const body = normalized.replace(/=+$/, "");
  // Padding, when present, must complete a whole 4-char group.
  if (body.length !== normalized.length && normalized.length % 4 !== 0) {
    return null;
  }
  // One leftover char encodes six bits, which is never a whole byte.
  if (body.length % 4 === 1) return null;

  let binary: string;
  try {
    binary = atob(body + "=".repeat((4 - (body.length % 4)) % 4));
  } catch {
    return null;
  }

  if (binary.length !== VAPID_KEY_LENGTH) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes[0] === UNCOMPRESSED_POINT ? bytes : null;
}

/**
 * Compare an existing subscription's key
 * (`subscription.options.applicationServerKey`) with the advertised one.
 *
 * Browsers that do not expose the key report `null` (or leave `options` out
 * altogether), which is `"unknown"`, not a mismatch: the caller falls back to
 * the marker it stored when it last subscribed.
 */
export function compareSubscriptionKey(
  existing: ArrayBuffer | null | undefined,
  advertised: Uint8Array,
): "match" | "mismatch" | "unknown" {
  if (existing === null || existing === undefined) return "unknown";

  const bytes = new Uint8Array(existing);
  if (bytes.length !== advertised.length) return "mismatch";
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== advertised[i]) return "mismatch";
  }
  return "match";
}

/**
 * The marker stored beside a subscription to remember which key made it:
 * unpadded base64url of the key's bytes, the same form the server publishes.
 */
export function keyMarker(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Whether the launch resync should touch the web push subscription at all.
 *
 * Only for users who turned push on and still allow it. This gates ONLY the
 * launch resync: the enable flow sets `"allowed"` after setup returns, so
 * setup itself must never be gated on it.
 */
export function shouldResyncWebPush(i: {
  permission: NotificationPermission | "unsupported";
  pushState: string;
}): boolean {
  return i.permission === "granted" && i.pushState === "allowed";
}

/**
 * What setup should do with the subscription it found.
 *
 * - `invalid`: the server advertised no usable key; setup throws.
 * - `subscribe`: there is no subscription yet.
 * - `reuse`: the subscription was made with the advertised key, or the browser
 *   does not say and nothing suggests otherwise (the marker matches, or
 *   `markerMatches` is `null` because storage is unavailable).
 * - `resubscribe`: it was made with a different key, either as reported by
 *   the browser or, when the browser does not say, by the stored marker.
 */
export function planWebPushSubscription(i: {
  advertised: Uint8Array | null;
  existing: "none" | "match" | "mismatch" | "unknown";
  markerMatches: boolean | null;
}): "invalid" | "subscribe" | "reuse" | "resubscribe" {
  if (i.advertised === null) return "invalid";

  switch (i.existing) {
    case "none":
      return "subscribe";
    case "match":
      return "reuse";
    case "mismatch":
      return "resubscribe";
    case "unknown":
      return i.markerMatches === false ? "resubscribe" : "reuse";
  }
}
