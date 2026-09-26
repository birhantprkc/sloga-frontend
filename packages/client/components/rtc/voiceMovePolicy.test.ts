// Unit spec for the voice move policy — run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/voiceMovePolicy.test.ts
// Focus: only the connection that is actually in the source call follows a
// move (the event reaches idle devices and sibling windows too), a move
// token is used only when it names exactly this attempt's identity and the
// destination room, the refusal latch is bypassed for permission and
// capacity refusals only, the menu and drag gates mirror the server, and a
// move refused because the target cannot see the destination is recognized
// in the shape the SDK actually rejects with.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import { DisconnectReason } from "livekit-client";

import type { JoinRefusalReason } from "./joinRefusalPolicy.ts";
import {
  type ObeyMoveInput,
  canDragParticipant,
  decodeMoveTokenClaims,
  isTargetCannotViewError,
  MOVE_OBEY_WINDOW_MS,
  moveBypassesRefusalLatch,
  moveTargets,
  moveTokenUsable,
  PARTICIPANT_REMOVED_REASON,
  shouldObeyMove,
} from "./voiceMovePolicy.ts";
import { NO_REJOIN_DISCONNECT_REASONS } from "./voiceRejoinPolicy.ts";

// --- helpers ---------------------------------------------------------------

/** base64url (no padding) of a string's UTF-8 bytes. */
function b64url(text: string): string {
  return bytesB64url(new TextEncoder().encode(text));
}

function bytesB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** An unsigned-looking JWT: header.payload.signature. Nothing verifies it. */
function jwt(payload: unknown): string {
  return [
    b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })),
    b64url(JSON.stringify(payload)),
    "c2lnbmF0dXJl",
  ].join(".");
}

const SELF = "01USERAAAAAAAAAAAAAAAAAAAA";
const DEVICE = "dev-1";
const QUALIFIED = `${SELF}:${DEVICE}`;
const FROM = "01CHANFROMAAAAAAAAAAAAAAAA";
const TO = "01CHANTOAAAAAAAAAAAAAAAAAA";
const T0 = 1_000_000;

const moveToken = (sub: unknown = QUALIFIED, room: unknown = TO) =>
  jwt({ sub, video: { room, roomJoin: true }, exp: 2_000_000_000 });

/** The live-call case that obeys; each test varies it. */
const live: ObeyMoveInput = {
  from: FROM,
  liveRoomChannelId: FROM,
  state: "CONNECTED",
  now: T0,
};

/** The just-removed case that obeys; each test varies it. */
const removed = (
  over: Partial<NonNullable<ObeyMoveInput["lastDisconnect"]>> = {},
  now = T0,
): ObeyMoveInput => ({
  from: FROM,
  liveRoomChannelId: undefined,
  state: "DISCONNECTED",
  lastDisconnect: {
    channelId: FROM,
    reason: DisconnectReason.PARTICIPANT_REMOVED,
    at: T0,
    ...over,
  },
  now,
});

// --- shouldObeyMove: live Room in `from` -----------------------------------

test("the obey window is 15 s and the removed reason is the SDK's", () => {
  assert.equal(MOVE_OBEY_WINDOW_MS, 15_000);
  // The module carries the wire value so it needs no runtime LiveKit
  // import; this is what keeps that value honest.
  assert.equal(
    PARTICIPANT_REMOVED_REASON,
    DisconnectReason.PARTICIPANT_REMOVED,
  );
  // The DISCONNECTED branch exists because auto-rejoin never runs on this
  // reason; if that changed, the two paths would race.
  assert.equal(
    NO_REJOIN_DISCONNECT_REASONS.has(DisconnectReason.PARTICIPANT_REMOVED),
    true,
  );
});

test("a connection CONNECTED in the source call obeys", () => {
  assert.equal(shouldObeyMove(live), true);
});

test("a connection RECONNECTING in the source call obeys", () => {
  assert.equal(shouldObeyMove({ ...live, state: "RECONNECTING" }), true);
});

test("a live Room in another channel does not obey", () => {
  // A stale or replayed move out of a call this connection already left.
  assert.equal(shouldObeyMove({ ...live, liveRoomChannelId: TO }), false);
  assert.equal(
    shouldObeyMove({ ...live, liveRoomChannelId: "01OTHER" }),
    false,
  );
});

test("a sibling window with no live Room does not obey, whatever it shows", () => {
  // Same session, same event, but the call lives in another window.
  for (const state of [
    "CONNECTED",
    "RECONNECTING",
    "CONNECTING",
    "READY",
    "DISCONNECTED",
  ] as const)
    assert.equal(
      shouldObeyMove({ ...live, liveRoomChannelId: undefined, state }),
      false,
      state,
    );
});

test("a Room in the source that is still CONNECTING, READY or DISCONNECTED does not obey", () => {
  for (const state of ["CONNECTING", "READY", "DISCONNECTED"] as const)
    assert.equal(shouldObeyMove({ ...live, state }), false, state);
});

test("an idle second device does not obey", () => {
  assert.equal(
    shouldObeyMove({
      from: FROM,
      liveRoomChannelId: undefined,
      state: "READY",
      now: T0,
    }),
    false,
  );
});

test("an empty `from` never obeys, even against an empty live channel", () => {
  assert.equal(
    shouldObeyMove({ ...live, from: "", liveRoomChannelId: "" }),
    false,
  );
  assert.equal(
    shouldObeyMove({
      ...removed({ channelId: "" }),
      from: "",
    }),
    false,
  );
});

// --- shouldObeyMove: just removed from `from` ------------------------------

test("DISCONNECTED by removal from the source obeys inside the window", () => {
  assert.equal(shouldObeyMove(removed()), true);
  assert.equal(shouldObeyMove(removed({}, T0 + 1)), true);
});

test("the window boundary: exactly 15000 ms obeys, 15001 ms does not", () => {
  assert.equal(shouldObeyMove(removed({}, T0 + MOVE_OBEY_WINDOW_MS)), true);
  assert.equal(
    shouldObeyMove(removed({}, T0 + MOVE_OBEY_WINDOW_MS + 1)),
    false,
  );
});

test("a removal stamped in the future (clock stepped back) does not obey", () => {
  assert.equal(shouldObeyMove(removed({}, T0 - 1)), false);
});

test("any other disconnect reason inside the window does not obey", () => {
  // A hang-up, a kick by another device, or a transport death (the device
  // may be showing the Rejoin card) is not the server moving this user.
  for (const reason of [
    DisconnectReason.CLIENT_INITIATED,
    DisconnectReason.DUPLICATE_IDENTITY,
    DisconnectReason.STATE_MISMATCH,
    DisconnectReason.ROOM_DELETED,
    DisconnectReason.SIGNAL_CLOSE,
    DisconnectReason.UNKNOWN_REASON,
    undefined,
  ])
    assert.equal(shouldObeyMove(removed({ reason })), false, String(reason));
});

test("a removal from a different channel does not obey", () => {
  assert.equal(shouldObeyMove(removed({ channelId: TO })), false);
});

test("DISCONNECTED with no recorded disconnect does not obey", () => {
  assert.equal(
    shouldObeyMove({ ...removed(), lastDisconnect: undefined }),
    false,
  );
});

test("a recent removal only counts while the state is DISCONNECTED", () => {
  // READY after the user dismissed the card; CONNECTING into another call;
  // RECONNECTING/CONNECTED with no live Room in the source.
  for (const state of [
    "READY",
    "CONNECTING",
    "RECONNECTING",
    "CONNECTED",
  ] as const)
    assert.equal(shouldObeyMove({ ...removed(), state }), false, state);
});

// --- decodeMoveTokenClaims -------------------------------------------------

test("decodes sub and video.room from a LiveKit-shaped token", () => {
  assert.deepEqual(decodeMoveTokenClaims(moveToken()), {
    sub: QUALIFIED,
    room: TO,
  });
});

test("decodes non-ASCII claims as UTF-8", () => {
  assert.deepEqual(decodeMoveTokenClaims(moveToken("üser:dév", "Ωroom")), {
    sub: "üser:dév",
    room: "Ωroom",
  });
});

test("absent or wrongly typed claims are left out, not coerced", () => {
  assert.deepEqual(decodeMoveTokenClaims(jwt({})), {});
  assert.deepEqual(decodeMoveTokenClaims(jwt({ sub: 42, video: [TO] })), {});
  assert.deepEqual(
    decodeMoveTokenClaims(jwt({ sub: QUALIFIED, video: { room: 7 } })),
    { sub: QUALIFIED },
  );
  assert.deepEqual(decodeMoveTokenClaims(jwt({ video: null })), {});
  // A top-level `room` is not LiveKit's claim.
  assert.deepEqual(decodeMoveTokenClaims(jwt({ room: TO })), {});
});

test("wrong segment counts are malformed", () => {
  const [h, p, s] = moveToken().split(".");
  for (const token of ["", p, `${h}.${p}`, `${h}.${p}.${s}.${s}`, `${h}..${s}`])
    assert.equal(decodeMoveTokenClaims(token), undefined, token);
});

test("a payload that is not base64url is malformed", () => {
  const [h, p, s] = moveToken().split(".");
  // Standard base64 alphabet and padding are not base64url.
  for (const payload of [
    "*not*base64*",
    `${p}=`,
    "ab+/",
    "a", // length % 4 === 1 can never be valid
    "abcde",
  ])
    assert.equal(
      decodeMoveTokenClaims(`${h}.${payload}.${s}`),
      undefined,
      payload,
    );
});

test("a payload that is not UTF-8 JSON is malformed", () => {
  const [h, , s] = moveToken().split(".");
  for (const payload of [
    b64url("not json"),
    b64url('{"sub":'),
    bytesB64url(new Uint8Array([0xff, 0xfe, 0x7b, 0x7d])), // invalid UTF-8
  ])
    assert.equal(
      decodeMoveTokenClaims(`${h}.${payload}.${s}`),
      undefined,
      payload,
    );
});

test("a JSON payload that is not an object is malformed", () => {
  for (const payload of [null, 42, "sub", true, [QUALIFIED, TO]])
    assert.equal(
      decodeMoveTokenClaims(jwt(payload)),
      undefined,
      JSON.stringify(payload),
    );
});

test("never throws, even on a non-string at runtime", () => {
  for (const junk of [undefined, null, 42, {}, [1, 2, 3]])
    assert.doesNotThrow(() => {
      assert.equal(decodeMoveTokenClaims(junk as unknown as string), undefined);
    });
});

// --- moveTokenUsable (M3) --------------------------------------------------

test("a token for this device's identity and the destination room is usable", () => {
  assert.equal(
    moveTokenUsable({
      token: moveToken(),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    true,
  );
  assert.equal(
    moveTokenUsable({
      token: moveToken(SELF),
      expectedIdentity: SELF,
      to: TO,
    }),
    true,
  );
});

test("no token, or an empty one, is not usable", () => {
  assert.equal(moveTokenUsable({ expectedIdentity: QUALIFIED, to: TO }), false);
  assert.equal(
    moveTokenUsable({ token: "", expectedIdentity: QUALIFIED, to: TO }),
    false,
  );
});

test("a token for another device of the same user is not usable", () => {
  assert.equal(
    moveTokenUsable({
      token: moveToken(`${SELF}:dev-2`),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
});

test("a token for another user is not usable", () => {
  assert.equal(
    moveTokenUsable({
      token: moveToken(`01SOMEONEELSEAAAAAAAAAAAAA:${DEVICE}`),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
});

test("bare versus device-qualified identities never match", () => {
  // Bare expected, qualified token: this attempt would not present a device.
  assert.equal(
    moveTokenUsable({ token: moveToken(), expectedIdentity: SELF, to: TO }),
    false,
  );
  // Qualified expected, bare token: the E2EE identity would not match.
  assert.equal(
    moveTokenUsable({
      token: moveToken(SELF),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
});

test("a token for this device's screen leg is not usable", () => {
  // A native screen leg is a second SFU participant, `{user}:{device}:screen`
  // (bare grammar `{user}::screen`). It starts with the primary identity but
  // is not it; joining as it would put the primary call on the leg's grant.
  assert.equal(
    moveTokenUsable({
      token: moveToken(`${QUALIFIED}:screen`),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
  assert.equal(
    moveTokenUsable({
      token: moveToken(`${SELF}::screen`),
      expectedIdentity: SELF,
      to: TO,
    }),
    false,
  );
});

test("a token for another room is not usable", () => {
  assert.equal(
    moveTokenUsable({
      token: moveToken(QUALIFIED, FROM),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
});

test("a token missing sub or room is not usable", () => {
  assert.equal(
    moveTokenUsable({
      token: jwt({ video: { room: TO } }),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
  assert.equal(
    moveTokenUsable({
      token: jwt({ sub: QUALIFIED }),
      expectedIdentity: QUALIFIED,
      to: TO,
    }),
    false,
  );
});

test("empty expectations never match empty claims", () => {
  assert.equal(
    moveTokenUsable({ token: moveToken("", TO), expectedIdentity: "", to: TO }),
    false,
  );
  assert.equal(
    moveTokenUsable({
      token: moveToken(QUALIFIED, ""),
      expectedIdentity: QUALIFIED,
      to: "",
    }),
    false,
  );
});

test("a malformed token is not usable", () => {
  for (const token of [
    "one-segment",
    "a.b",
    "a.*bad*.c",
    `x.${b64url("nope")}.y`,
    `x.${b64url("42")}.y`,
  ])
    assert.equal(
      moveTokenUsable({ token, expectedIdentity: QUALIFIED, to: TO }),
      false,
      token,
    );
});

// --- moveBypassesRefusalLatch (S1) -----------------------------------------

test("only MissingPermission and CannotJoinCall bypass the refusal latch", () => {
  assert.equal(moveBypassesRefusalLatch("MissingPermission"), true);
  assert.equal(moveBypassesRefusalLatch("CannotJoinCall"), true);
});

test("device, encryption, validation and every other refusal hold", () => {
  for (const type of [
    "DeviceNotRegistered",
    "FeatureDisabled",
    "MediaE2EEDisabled",
    "FailedValidation",
    "NotAuthenticated",
    "UnknownNode",
    "LiveKitUnavailable",
    "NotAVoiceChannel",
    "IsBot",
    "",
    "missingpermission",
    "MissingPermission ",
    undefined,
  ])
    assert.equal(moveBypassesRefusalLatch(type), false, String(type));
});

test("of every latched refusal reason, exactly two are bypassed", () => {
  // A Record over the union, so a new JoinRefusalReason without a row here
  // is a tsc error: whether a move may step past it must be decided.
  const expected: Record<JoinRefusalReason, boolean> = {
    NotAVoiceChannel: false,
    MissingPermission: true,
    CannotJoinCall: true,
    IsBot: false,
    FailedValidation: false,
    UnknownNode: false,
    MediaE2EEDisabled: false,
    DeviceNotRegistered: false,
  };
  for (const [reason, bypass] of Object.entries(expected))
    assert.equal(moveBypassesRefusalLatch(reason), bypass, reason);
  assert.deepEqual(Object.keys(expected).filter(moveBypassesRefusalLatch), [
    "MissingPermission",
    "CannotJoinCall",
  ]);
});

// --- moveTargets -----------------------------------------------------------

type Ch = {
  id: string;
  voice: boolean;
  connect: boolean;
  move: boolean;
};

const channels: Ch[] = [
  { id: "text", voice: false, connect: true, move: true },
  { id: "v1", voice: true, connect: true, move: true },
  { id: "current", voice: true, connect: true, move: true },
  { id: "noconnect", voice: true, connect: false, move: true },
  { id: "nomove", voice: true, connect: true, move: false },
  { id: "v2", voice: true, connect: true, move: true },
];

const targetIds = (isSelf: boolean, list: readonly Ch[] = channels) =>
  moveTargets(list, {
    currentChannelId: "current",
    isSelf,
    isVoice: (c) => c.voice,
    canConnect: (c) => c.connect,
    canMoveMembers: (c) => c.move,
  }).map((c) => c.id);

test("moving someone else: voice, not current, Connect and MoveMembers on the destination", () => {
  assert.deepEqual(targetIds(false), ["v1", "v2"]);
});

test("moving yourself needs Connect but not MoveMembers", () => {
  assert.deepEqual(targetIds(true), ["v1", "nomove", "v2"]);
});

test("input order is preserved and the input is not mutated", () => {
  const reversed = [...channels].reverse();
  const before = reversed.map((c) => c.id);
  assert.deepEqual(targetIds(true, reversed), ["v2", "nomove", "v1"]);
  assert.deepEqual(
    reversed.map((c) => c.id),
    before,
  );
});

test("no channels, or none eligible, gives an empty list", () => {
  assert.deepEqual(targetIds(false, []), []);
  assert.deepEqual(targetIds(true, [channels[0], channels[2]]), []);
});

// --- canDragParticipant ----------------------------------------------------

test("drag truth table: desktop only; self always; others need MoveMembers and rank", () => {
  for (const isMobile of [false, true])
    for (const isSelf of [false, true])
      for (const canMoveMembersInSource of [false, true])
        for (const outranksTarget of [false, true]) {
          const expected =
            !isMobile && (isSelf || (canMoveMembersInSource && outranksTarget));
          assert.equal(
            canDragParticipant({
              isMobile,
              isSelf,
              canMoveMembersInSource,
              outranksTarget,
            }),
            expected,
            JSON.stringify({
              isMobile,
              isSelf,
              canMoveMembersInSource,
              outranksTarget,
            }),
          );
        }
});

test("mobile never drags, not even yourself", () => {
  assert.equal(
    canDragParticipant({
      isMobile: true,
      isSelf: true,
      canMoveMembersInSource: true,
      outranksTarget: true,
    }),
    false,
  );
});

test("MoveMembers without rank, or rank without MoveMembers, cannot drag others", () => {
  const base = { isMobile: false, isSelf: false };
  assert.equal(
    canDragParticipant({
      ...base,
      canMoveMembersInSource: true,
      outranksTarget: false,
    }),
    false,
  );
  assert.equal(
    canDragParticipant({
      ...base,
      canMoveMembersInSource: false,
      outranksTarget: true,
    }),
    false,
  );
  assert.equal(
    canDragParticipant({
      ...base,
      canMoveMembersInSource: true,
      outranksTarget: true,
    }),
    true,
  );
});

// --- isTargetCannotViewError --------------------------------------------------

/** The body member_edit sends when the target cannot see the destination. */
const TARGET_CANNOT_VIEW = {
  type: "MissingPermission",
  permission: "ViewChannel",
  location: "crates/core/permissions/src/models/mod.rs:79:28",
};

/** Every shape a refusal body is accepted in, keyed for the failure message. */
function shapesOf(body: unknown): Record<string, unknown> {
  return {
    "JSON text (what stoat-api throws)": JSON.stringify(body),
    "parsed body": body,
    "axios response.data object": { response: { data: body } },
    "axios response.data text": { response: { data: JSON.stringify(body) } },
  };
}

interface PatchClient {
  patch(path: string, params: unknown): Promise<unknown>;
}

/**
 * What `ServerMember.edit()` rejects with when the server answers 403 with
 * `body`: the REAL stoat-api `API.patch` (the call `edit` makes) against a
 * stubbed `fetch`. stoat-api is resolved from stoat.js, the package that
 * depends on it, so a stoat-api bump there is what this exercises.
 */
async function sdkRejection(body: unknown): Promise<unknown> {
  const require = createRequire(
    new URL("../../../stoat.js/package.json", import.meta.url),
  );
  const { API } = (await import(
    pathToFileURL(require.resolve("stoat-api")).href
  )) as {
    API: new (options: { baseURL: string }) => PatchClient;
  };

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await new API({ baseURL: "http://api.invalid" }).patch(
      `/servers/01SERVER/members/${SELF}`,
      { voice_channel: TO },
    );
  } catch (error) {
    return error;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.fail("the stubbed 403 resolved");
}

test("the SDK rejects a refused member edit with the body as JSON text, and it is recognized", async () => {
  const refusal = await sdkRejection(TARGET_CANNOT_VIEW);
  // The shape the doc comment names. If a stoat-api bump changes it, the
  // doc is stale: update it (the object shape is already accepted).
  assert.equal(typeof refusal, "string");
  assert.equal(isTargetCannotViewError(refusal), true);

  const moverRefusal = await sdkRejection({
    type: "MissingPermission",
    permission: "Connect",
  });
  assert.equal(isTargetCannotViewError(moverRefusal), false);
});

test("a target that cannot see the destination is recognized in every shape", () => {
  for (const [shape, error] of Object.entries(shapesOf(TARGET_CANNOT_VIEW))) {
    assert.equal(isTargetCannotViewError(error), true, shape);
  }
  // `location` is not required.
  for (const [shape, error] of Object.entries(
    shapesOf({ type: "MissingPermission", permission: "ViewChannel" }),
  )) {
    assert.equal(isTargetCannotViewError(error), true, shape);
  }
});

test("MissingPermission for Connect is the mover's refusal, not the target's", () => {
  for (const [shape, error] of Object.entries(
    shapesOf({ type: "MissingPermission", permission: "Connect" }),
  )) {
    assert.equal(isTargetCannotViewError(error), false, shape);
  }
  for (const [shape, error] of Object.entries(
    shapesOf({ type: "MissingPermission", permission: "MoveMembers" }),
  )) {
    assert.equal(isTargetCannotViewError(error), false, shape);
  }
});

test("MissingPermission without a string ViewChannel permission is not recognized", () => {
  for (const body of [
    { type: "MissingPermission" },
    { type: "MissingPermission", permission: null },
    { type: "MissingPermission", permission: ["ViewChannel"] },
    {
      type: "MissingPermission",
      permission: { toString: () => "ViewChannel" },
    },
    { type: "MissingPermission", permission: "viewchannel" },
  ]) {
    for (const [shape, error] of Object.entries(shapesOf(body))) {
      assert.equal(
        isTargetCannotViewError(error),
        false,
        `${shape}: ${JSON.stringify(body)}`,
      );
    }
  }
});

test("other refusals are not recognized", () => {
  for (const body of [
    { type: "NotAVoiceChannel" },
    { type: "InvalidOperation" },
    { type: "NotConnected" },
    { type: "CannotJoinCall" },
    { type: "NotElevated" },
    { type: "MissingUserPermission", permission: "ViewChannel" },
    { permission: "ViewChannel" },
  ]) {
    for (const [shape, error] of Object.entries(shapesOf(body))) {
      assert.equal(
        isTargetCannotViewError(error),
        false,
        `${shape}: ${JSON.stringify(body)}`,
      );
    }
  }
});

test("odd input is not recognized and never throws", () => {
  const throwingGetter = Object.defineProperty({}, "type", {
    get() {
      throw new Error("boom");
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      get() {
        throw new Error("boom");
      },
    },
  );
  const odd: unknown[] = [
    null,
    undefined,
    "string",
    "",
    "<html><body>502 Bad Gateway</body></html>",
    "null",
    "42",
    '"MissingPermission"',
    JSON.stringify([TARGET_CANNOT_VIEW]),
    42,
    Number.NaN,
    true,
    [],
    [TARGET_CANNOT_VIEW],
    new Error(),
    new TypeError("Failed to fetch"),
    { response: null },
    { response: { data: null } },
    { response: { data: 42 } },
    { response: [TARGET_CANNOT_VIEW] },
    throwingGetter,
    throwingProxy,
    { response: throwingProxy },
  ];
  // Labelled by index: `String()` of the throwing proxy would itself throw.
  odd.forEach((error, index) => {
    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = isTargetCannotViewError(error);
    }, `odd input #${index}`);
    assert.equal(result, false, `odd input #${index}`);
  });
});
