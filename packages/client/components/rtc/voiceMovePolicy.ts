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
 *    session when one does, so most receivers must ignore it. A connection
 *    that is no longer live in the call follows only with a move token
 *    minted for its own identity.
 *  - `decodeMoveTokenClaims` / `moveTokenUsable`: M3. A pre-minted move
 *    token is used only when it names exactly the identity this attempt
 *    would request, for exactly the destination room. Anything else falls
 *    back to a normal join.
 *  - `moveTokenForConnection`: F1, client half. Whether a received move's
 *    token names the identity this connection last held.
 *  - `moveBypassesRefusalLatch`: S1. Which latched join refusals a move
 *    token may step past.
 *  - `moveAuthDecision`: F4. After M3, use the token, join normally, or
 *    answer from a refusal latch the dropped token had bypassed.
 *  - `moveTargets` / `canDragParticipant`: what the menu offers and what
 *    the sidebar lets you drag. These mirror the server's checks; the
 *    server stays the authority.
 *  - `isTargetCannotViewError`: whether a refused move failed because the
 *    member being moved cannot see the destination.
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
  /**
   * Whether the event carries a move token that `moveTokenUsable` accepts
   * for the participant identity THIS connection last held in the call
   * (`${userId}:${e2eeDeviceId}`, or the bare user id), with `to` set to the
   * event's `to`. False with no token, or one minted for another identity.
   * Only the RECONNECTING and DISCONNECTED rules read it.
   */
  tokenForThisConnection: boolean;
}

/**
 * Whether this connection should follow the move.
 *
 * True only when:
 *  - it holds a live Room in `from` and is CONNECTED, or
 *  - it is RECONNECTING into `from` and `tokenForThisConnection` is true, or
 *  - it is DISCONNECTED because the server removed it from `from`
 *    (`PARTICIPANT_REMOVED`) no more than `MOVE_OBEY_WINDOW_MS` ago, and
 *    `tokenForThisConnection` is true.
 *
 * Everything else is ignored: an idle second device, a sibling window with
 * no live Room, and a device that gave up and shows the Rejoin card. A
 * negative elapsed time (a clock that stepped backwards) is also ignored.
 * Ignoring is the safe side: the user can still join by hand.
 *
 * Why the token gates RECONNECTING and DISCONNECTED: `PARTICIPANT_REMOVED`
 * does not say who removed us. Joining from the user's OWN other session
 * (`join_call` with `force_disconnect`) removes this device with the same
 * reason. If a move for that other session then arrived inside the window,
 * this device would rejoin the destination with its mic live and kick the
 * session the user is actually in. The token closes that: the server mints
 * it for the participant being moved, so it names this connection's
 * identity only when this connection is the one being moved. CONNECTED
 * with a live Room in `from` needs no token: that connection is
 * demonstrably the in-call participant, and a target with no token (an
 * unbound session) must still follow.
 *
 * Accepted degradation: a tokenless or unbound target whose kick lands
 * before the event (so it is DISCONNECTED or RECONNECTING when the event
 * arrives) is simply disconnected, not moved, as on a client that predates
 * moves.
 *
 * Two BARE sessions (media E2EE off) share the bare identity, so a bare
 * token passes for both, and the token alone cannot tell the kicked one from
 * the moved one. The server fix (wave 6a) closes that case: it delivers the
 * move event only to the session that owns the in-call participant
 * (`private_session`), so the other session never sees it.
 *
 * RESIDUAL, accepted: sibling windows or tabs on the SAME session. They
 * share one session, so the server's delivery reaches all of them, and bare
 * they share one identity (a qualified one too, wherever they share an E2EE
 * device), so the token passes for all of them. A sibling kicked by the
 * other one's `force_disconnect` inside the window still follows. Neither
 * this rule nor the server fix closes that; live-leg C5 and item 12 (a
 * sibling window on the same session) cover it.
 */
export function shouldObeyMove(input: ObeyMoveInput): boolean {
  if (!input.from) return false;

  if (input.liveRoomChannelId === input.from) {
    if (input.state === "CONNECTED") return true;
    if (input.state === "RECONNECTING")
      return input.tokenForThisConnection === true;
  }

  const last = input.lastDisconnect;
  if (input.state !== "DISCONNECTED" || !last) return false;
  if (input.tokenForThisConnection !== true) return false;
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
 * F1, client half: whether a received move's token was minted for the
 * identity THIS connection last held in the call, for exactly `to`. This is
 * `shouldObeyMove`'s `tokenForThisConnection`.
 *
 * `lastLocalIdentity` is the local participant identity recorded when this
 * connection last connected (`${userId}:${e2eeDeviceId}`, or the bare user
 * id). With none recorded, no token is for this connection. A bare token
 * still passes for a bare identity (see the residual on `shouldObeyMove`).
 * Only the verdict leaves here; the caller must not log the token.
 */
export function moveTokenForConnection(input: {
  token?: string;
  lastLocalIdentity?: string;
  to: string;
}): boolean {
  const { token, lastLocalIdentity, to } = input;
  return (
    typeof token === "string" &&
    token !== "" &&
    !!lastLocalIdentity &&
    moveTokenUsable({ token, expectedIdentity: lastLocalIdentity, to })
  );
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
 * What a connect attempt does with the auth it was handed, once M3 has
 * judged it:
 *  - `"use"`: join with the pre-minted auth.
 *  - `"join"`: drop any auth and join the normal way (`joinCall`).
 *  - `"answer_latch"`: drop the auth, answer from the refusal latch and
 *    never call `joinCall`.
 */
export type MoveAuthDecision = "use" | "join" | "answer_latch";

/**
 * F4: the decision after M3.
 *
 * `hasAuth`: the attempt was handed pre-minted auth (a move token).
 * `tokenUsable`: M3 (`moveTokenUsable`) accepted it for this attempt.
 * `latchStillRefused`: the attempt got past a refusal latch only through the
 * move bypass (S1), AND that latch still refuses the channel when M3 runs.
 * Read the latch again at that point: it may have cleared during the awaits
 * before M3.
 *
 * A usable token is used. A dropped token whose bypass is all that let the
 * attempt past a latch that still refuses answers from that latch, exactly
 * as `connect()` would have without the bypass. Everything else joins
 * normally: with no auth there was no bypass, and a latch that cleared no
 * longer refuses.
 */
export function moveAuthDecision(input: {
  hasAuth: boolean;
  tokenUsable: boolean;
  latchStillRefused: boolean;
}): MoveAuthDecision {
  if (!input.hasAuth) return "join";
  if (input.tokenUsable) return "use";
  return input.latchStillRefused ? "answer_latch" : "join";
}

/**
 * The channels a "Move to…" menu offers, in input order: voice channels
 * other than the current one that the mover can Connect to, and, unless
 * the mover is moving themselves, where they hold MoveMembers.
 *
 * Only the DESTINATION is checked here. MoveMembers on the SOURCE channel,
 * resolved at CHANNEL level (never the server-level value), and outranking
 * the target are the CALLER's gate: `canOfferMove` in
 * `callModerationPolicy.ts` for the menu, `canDragParticipant` for drag.
 * Call this only once that gate has passed, or it offers targets for a move
 * the server will refuse.
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

/** Parse a string error body as JSON; anything else passes through as is. */
function parseErrorBody(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

/** Whether an error body is exactly `MissingPermission` / `ViewChannel`. */
function isViewChannelRefusal(body: unknown): boolean {
  return (
    isPlainObject(body) &&
    body.type === "MissingPermission" &&
    body.permission === "ViewChannel"
  );
}

/**
 * Whether a refused move failed because the TARGET cannot see the
 * destination: the API error `MissingPermission` with
 * `permission: "ViewChannel"`, and nothing else.
 *
 * The server raises that pair on a move only for the target. The mover's
 * own ViewChannel on the destination is implied by the Connect check that
 * runs first (`member_edit.rs`), so a mover who cannot see the channel is
 * refused with `permission: "Connect"` instead. A self-move never runs the
 * target check.
 *
 * The shapes accepted, each checked structurally:
 *  - A string holding the JSON body. This is what `ServerMember.edit()`,
 *    and so `moveToVoiceChannel()`, rejects with today: stoat-api 0.13.5's
 *    `API.req` reads a JSON response as text and, on a non-2xx, throws that
 *    text unparsed (`throw data`). A body that is not JSON, such as a
 *    proxy's HTML error page, is not this refusal.
 *  - The parsed body object, `{ type, permission }`. stoat.js's raw `fetch`
 *    helpers (`Client.#apiReq`, `uploadFile`) throw this shape, and
 *    `useError` turns the string into it. Accepted so a caller that parsed
 *    first, or a stoat-api that starts parsing, still matches.
 *  - `{ response: { data } }`, the axios shape of older revolt-api clients
 *    that `isProfilePrivateError` (ProfileBio.tsx) still reads. stoat-api
 *    0.13.5 never produces it; it is checked for parity with that reader.
 *
 * Returns false for anything else (null, a number, an `Error` with no
 * response, a non-string `permission`). Never throws: it runs inside a
 * rejection handler, where a throw would swallow the user-facing message.
 */
export function isTargetCannotViewError(error: unknown): boolean {
  try {
    if (isViewChannelRefusal(parseErrorBody(error))) return true;
    return (
      isPlainObject(error) &&
      isPlainObject(error.response) &&
      isViewChannelRefusal(parseErrorBody(error.response.data))
    );
  } catch {
    return false;
  }
}
