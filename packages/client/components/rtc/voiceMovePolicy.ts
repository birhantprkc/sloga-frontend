/**
 * Pure decisions for moving a call participant to another voice channel
 * (plan decision C, as amended by Rev 3: M3 and S1).
 *
 * Runtime-import free so the spec runs under plain Node.
 *
 * Whether THIS connection follows a server-ordered move at all is not
 * decided here: that is `moveDecision` in `movePolicy.ts`, and the voice
 * store computes its "token for this connection" input with
 * `moveTokenUsable` below.
 *
 * The pieces:
 *  - `decodeMoveTokenClaims` / `moveTokenUsable`: M3. A pre-minted move
 *    token is used only when it names exactly the identity this attempt
 *    would request, for exactly the destination room. Anything else falls
 *    back to a normal join.
 *  - `moveBypassesRefusalLatch`: S1. Which latched join refusals a move
 *    token may step past.
 *  - `moveAuthDecision`: F4. After M3, use the token, join normally, or
 *    answer from a refusal latch the dropped token had bypassed.
 *  - `moveTargets` / `canDragParticipant`: what the menu offers and what
 *    the sidebar lets you drag. These mirror the server's checks; the
 *    server stays the authority.
 *  - `isTargetCannotViewError` / `moveRefusalKind`: why the server refused
 *    a move, so the person who asked for it is told something true.
 */

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
 * Desktop only (mobile uses the menu). A bot is never dragged: the server
 * refuses to move one (`IsBot`), so offering the drag would only end in an
 * error. Otherwise you can always drag yourself; dragging someone else
 * needs MoveMembers in the source channel and a higher rank than theirs.
 *
 * The bot check comes before the self check, so it holds on a bot's own
 * client too.
 */
export function canDragParticipant(input: {
  isMobile: boolean;
  isSelf: boolean;
  canMoveMembersInSource: boolean;
  outranksTarget: boolean;
  isBot: boolean;
}): boolean {
  if (input.isMobile) return false;
  if (input.isBot) return false;
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

/**
 * Why the server refused a move, as far as the message shown for it needs
 * to know:
 *  - `"target-cannot-view"`: exactly `isTargetCannotViewError`.
 *  - `"is-bot"`: `IsBot`, the member being moved is a bot.
 *  - `"cannot-join"`: the destination cannot take them. `CannotJoinCall`
 *    (full, or the move could not be completed there), and the 409 call
 *    caps the move path shares with the join front door: `VideoCallFull`
 *    (the video-participant ceiling) and `MlsCallFull` (an E2EE call's
 *    group ceiling).
 *  - `"not-connected"`: `NotConnected`, the member is not in a call the
 *    move can act on (they left, or switched calls).
 *  - `"not-authenticated"`: `NotAuthenticated`, a self-move from a session
 *    other than the one in the call.
 *  - `"server-error"`: the server's own failure, nothing the person asking
 *    could change. `InternalError` (what a typed delta 500 carries, and
 *    what a failed SFU call during the move is raised as),
 *    `DatabaseError` (the other typed 500), `LiveKitUnavailable` (voice is
 *    not enabled on this server) and `UnknownNode` (the call's SFU node is
 *    not configured).
 *  - `"other"`: every other refusal, including `MissingPermission` for any
 *    permission but a target's `ViewChannel` (the mover's own Connect or
 *    MoveMembers), `NotElevated`, `NotFound` (the member is gone),
 *    `UnknownChannel` (the destination is gone), `NotAVoiceChannel`,
 *    `InvalidOperation`, a body that is not JSON (a proxy's HTML error
 *    page), a network error, and anything malformed.
 */
export type MoveRefusalKind =
  | "target-cannot-view"
  | "is-bot"
  | "cannot-join"
  | "not-connected"
  | "not-authenticated"
  | "server-error"
  | "other";

/**
 * The kind of one error body, by its exact, case-sensitive `type`. A
 * `switch` rather than an object lookup, so a `type` such as `"toString"`
 * or `"__proto__"` cannot pick up an inherited property.
 */
function refusalKindOfBody(body: unknown): MoveRefusalKind {
  if (!isPlainObject(body)) return "other";
  switch (body.type) {
    case "IsBot":
      return "is-bot";
    case "CannotJoinCall":
    case "VideoCallFull":
    case "MlsCallFull":
      return "cannot-join";
    case "NotConnected":
      return "not-connected";
    case "NotAuthenticated":
      return "not-authenticated";
    case "InternalError":
    case "DatabaseError":
    case "LiveKitUnavailable":
    case "UnknownNode":
      return "server-error";
    default:
      return "other";
  }
}

/**
 * Classify a refused move (`moveToVoiceChannel()` / `ServerMember.edit()`
 * rejection) into a `MoveRefusalKind`.
 *
 * Accepts the same three shapes as `isTargetCannotViewError`: the JSON body
 * as text (what stoat-api 0.13.5 throws), the parsed body object, and the
 * axios `{ response: { data } }` shape with either of those as `data`.
 * `"target-cannot-view"` is decided by `isTargetCannotViewError` itself, so
 * the two never disagree. Otherwise the body itself is read first, and the
 * `response.data` body only when the body itself says nothing this knows.
 *
 * One consequence of that order (FE2WA-11): a `MissingPermission` /
 * `ViewChannel` refusal inside `response.data` outranks a known type on the
 * body itself, because `isTargetCannotViewError` accepts it in either place
 * and is asked first. Only an object carrying both a top-level `type` and an
 * axios-style `response.data`, a shape only the old axios-style error
 * produces, can show this; stoat-api 0.13.5 throws the body as text.
 *
 * Never throws, whatever it is handed (null, a number, an `Error`, an
 * object whose getters throw): it runs inside a rejection handler, where a
 * throw would swallow the user-facing message. Anything it cannot read is
 * `"other"`.
 */
export function moveRefusalKind(error: unknown): MoveRefusalKind {
  try {
    if (isTargetCannotViewError(error)) return "target-cannot-view";
    const kind = refusalKindOfBody(parseErrorBody(error));
    if (kind !== "other") return kind;
    if (isPlainObject(error) && isPlainObject(error.response))
      return refusalKindOfBody(parseErrorBody(error.response.data));
    return "other";
  } catch {
    return "other";
  }
}
