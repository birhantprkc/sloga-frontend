/**
 * Pure decisions for moving a call participant to another voice channel
 * (plan decision C, as amended by Rev 3: M3, S1 and the obey rules).
 *
 * Runtime-import free so the spec runs under plain Node. The one LiveKit
 * import is `import type`, erased at compile time; the single enum value
 * the obey rule needs is carried as its protocol wire value and pinned
 * against the real enum by the spec.
 *
 * The pieces:
 *  - `shouldObeyMove`: whether THIS connection follows a
 *    `UserMoveVoiceChannel` it received. The event reaches every device of
 *    the target when no bound session exists, and every window on the bound
 *    session when one does, so most receivers must ignore it.
 *  - `decodeMoveTokenClaims` / `moveTokenUsable`: M3. A pre-minted move
 *    token is used only when it names exactly the identity this attempt
 *    would request, for exactly the destination room. Anything else falls
 *    back to a normal join.
 *  - `moveBypassesRefusalLatch`: S1. Which latched join refusals a move
 *    token may step past.
 *  - `moveTargets` / `canDragParticipant`: what the menu offers and what
 *    the sidebar lets you drag. These mirror the server's checks; the
 *    server stays the authority.
 */
import type { DisconnectReason } from "livekit-client";

/**
 * How long after being removed from `from` a DISCONNECTED connection still
 * follows a move out of it. The server removes the participant from the
 * source room and publishes the move event close together, and either can
 * land first. Past this window the user is looking at the Rejoin card, and
 * a move arriving then must not pull them into a call on its own.
 */
export const MOVE_OBEY_WINDOW_MS = 15_000;

/**
 * `DisconnectReason.PARTICIPANT_REMOVED`, as a protocol wire value (livekit
 * protocol `DisconnectReason`, `PARTICIPANT_REMOVED = 4`). Protobuf enum
 * numbers are part of the wire format and do not change; the spec still
 * asserts equality with the SDK's enum so a mismatch fails loudly.
 */
export const PARTICIPANT_REMOVED_REASON: DisconnectReason = 4;

/**
 * The voice store's connection state, matching the private `State` union in
 * `state.tsx` (`type State`, lines 423-428). Kept structurally identical so
 * `this.state()` passes straight in.
 */
export type VoiceConnectionState =
  | "READY"
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING";

export interface ObeyMoveInput {
  /** `event.from`: the channel the server moved the user out of. */
  from: string;
  /**
   * The channel of the Room THIS connection holds live right now, or
   * `undefined` when it holds none. A sibling window on the same session
   * receives the same event but holds no Room, so it must not act.
   */
  liveRoomChannelId: string | undefined;
  /** This connection's voice state. */
  state: VoiceConnectionState;
  /**
   * The last `disconnected` this connection saw: the channel it was in, the
   * reason LiveKit gave (the same `DisconnectReason | undefined` that
   * `voiceRejoinPolicy.shouldAutoRejoin` takes) and when it arrived. Record
   * `at` and pass `now` from the same clock.
   */
  lastDisconnect?: {
    channelId: string;
    reason: DisconnectReason | undefined;
    at: number;
  };
  now: number;
}

/**
 * Whether this connection should follow the move.
 *
 * True only when:
 *  - it holds a live Room in `from` and is CONNECTED or RECONNECTING, or
 *  - it is DISCONNECTED because the server removed it from `from`
 *    (`PARTICIPANT_REMOVED`) no more than `MOVE_OBEY_WINDOW_MS` ago.
 *
 * Everything else is ignored: an idle second device, a sibling window with
 * no live Room, and a device that gave up and shows the Rejoin card. A
 * negative elapsed time (a clock that stepped backwards) is also ignored.
 * Ignoring is the safe side: the user can still join by hand.
 */
export function shouldObeyMove(input: ObeyMoveInput): boolean {
  if (!input.from) return false;

  if (
    input.liveRoomChannelId === input.from &&
    (input.state === "CONNECTED" || input.state === "RECONNECTING")
  )
    return true;

  const last = input.lastDisconnect;
  if (input.state !== "DISCONNECTED" || !last) return false;
  if (last.channelId !== input.from) return false;
  if (last.reason !== PARTICIPANT_REMOVED_REASON) return false;
  const elapsed = input.now - last.at;
  return elapsed >= 0 && elapsed <= MOVE_OBEY_WINDOW_MS;
}

/** The claims of a LiveKit token that M3 compares. */
export interface MoveTokenClaims {
  /** The participant identity the token admits. */
  sub?: string;
  /** `video.room`: the room the token admits to. */
  room?: string;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Decode one base64url segment to a UTF-8 string. Throws on bad input. */
function decodeBase64Url(segment: string): string {
  if (!BASE64URL.test(segment) || segment.length % 4 === 1)
    throw new Error("not base64url");
  const base64 =
    segment.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (segment.length % 4)) % 4);
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `sub` and `video.room` from a JWT's payload WITHOUT verifying it.
 *
 * This is a client-side consistency check, not authentication: the SFU
 * verifies the signature. Its job is to keep the client from presenting a
 * token for an identity or room other than the one it is about to join.
 *
 * Returns `undefined` for anything that is not three dot-separated segments
 * whose middle one is base64url-encoded UTF-8 JSON of an object. A claim of
 * the wrong type is left out. Never throws.
 */
export function decodeMoveTokenClaims(
  token: string,
): MoveTokenClaims | undefined {
  try {
    if (typeof token !== "string") return undefined;
    const segments = token.split(".");
    if (segments.length !== 3) return undefined;
    const payload: unknown = JSON.parse(decodeBase64Url(segments[1]));
    if (!isPlainObject(payload)) return undefined;

    const claims: MoveTokenClaims = {};
    if (typeof payload.sub === "string") claims.sub = payload.sub;
    const video = payload.video;
    if (isPlainObject(video) && typeof video.room === "string")
      claims.room = video.room;
    return claims;
  } catch {
    return undefined;
  }
}

/**
 * M3: whether a move token may be used for this attempt.
 *
 * `expectedIdentity` is the identity the attempt would request on its own:
 * `${userId}:${e2eeDeviceId}` for an enrolled device, the bare user id
 * otherwise. A token for a different identity (another device, or bare
 * versus qualified) would join as someone this client is not, and a token
 * for a room other than `to` would join the wrong call. Either way, and
 * with no token or one that does not decode, the caller drops the token
 * and joins normally.
 */
export function moveTokenUsable(input: {
  token?: string;
  expectedIdentity: string;
  to: string;
}): boolean {
  if (!input.token || !input.expectedIdentity || !input.to) return false;
  const claims = decodeMoveTokenClaims(input.token);
  if (!claims) return false;
  return claims.sub === input.expectedIdentity && claims.room === input.to;
}

/**
 * S1: the latched refusals a move token may bypass. A moderator can move a
 * member into a channel they could not join themselves, so a refusal about
 * permission or capacity does not apply to the move. Device and encryption
 * refusals (`DeviceNotRegistered`, `FeatureDisabled` / `MediaE2EEDisabled`,
 * `FailedValidation`) and everything else still hold.
 */
const MOVE_LATCH_BYPASS: ReadonlySet<string> = new Set([
  "MissingPermission",
  "CannotJoinCall",
]);

/**
 * Whether a join refusal latched for the destination may be bypassed by a
 * move token. An exact allowlist, so an unknown or missing type holds.
 */
export function moveBypassesRefusalLatch(
  errorType: string | undefined,
): boolean {
  return errorType !== undefined && MOVE_LATCH_BYPASS.has(errorType);
}

/**
 * The channels a "Move to…" menu offers, in input order: voice channels
 * other than the current one that the mover can Connect to, and, unless
 * the mover is moving themselves, where they hold MoveMembers.
 *
 * Only the DESTINATION is checked here. MoveMembers in the SOURCE channel
 * and outranking the target are the CALLER's gate (`callModerationActions`
 * for the menu, `canDragParticipant` for drag), not this function's: call it
 * only once those have passed, or it offers targets for a move the server
 * will refuse.
 */
export function moveTargets<C extends { id: string }>(
  channels: readonly C[],
  opts: {
    currentChannelId: string;
    isSelf: boolean;
    isVoice: (c: C) => boolean;
    canConnect: (c: C) => boolean;
    canMoveMembers: (c: C) => boolean;
  },
): C[] {
  return channels.filter(
    (c) =>
      c.id !== opts.currentChannelId &&
      opts.isVoice(c) &&
      opts.canConnect(c) &&
      (opts.isSelf || opts.canMoveMembers(c)),
  );
}

/**
 * Whether a participant row may be dragged to another voice channel.
 * Desktop only (mobile uses the menu). You can always drag yourself;
 * dragging someone else needs MoveMembers in the source channel and a
 * higher rank than theirs.
 */
export function canDragParticipant(input: {
  isMobile: boolean;
  isSelf: boolean;
  canMoveMembersInSource: boolean;
  outranksTarget: boolean;
}): boolean {
  if (input.isMobile) return false;
  if (input.isSelf) return true;
  return input.canMoveMembersInSource && input.outranksTarget;
}
