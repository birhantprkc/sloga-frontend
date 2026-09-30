// Unit spec for the voice move policy — run with Node's built-in runner:
//   node --test --conditions=browser components/rtc/voiceMovePolicy.test.ts
// Focus: a move token is used only when it names exactly this attempt's
// identity and the destination room, the refusal latch is bypassed for
// permission and capacity refusals only, a token M3 drops after such a
// bypass answers from the latch while it still refuses, the menu and drag
// gates mirror the server (a bot is never dragged), and a refused move is
// classified from the shape the SDK actually rejects with, never throwing.
// Whether a connection follows a move at all is `moveDecision`'s job; its
// spec is `movePolicy.test.ts`.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { JoinRefusalReason } from "./joinRefusalPolicy.ts";
import * as policy from "./voiceMovePolicy.ts";
import {
  type MoveAuthDecision,
  type MoveRefusalKind,
  canDragParticipant,
  decodeMoveTokenClaims,
  isTargetCannotViewError,
  moveAuthDecision,
  moveBypassesRefusalLatch,
  moveRefusalKind,
  moveTargets,
  moveTokenUsable,
} from "./voiceMovePolicy.ts";

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

const moveToken = (sub: unknown = QUALIFIED, room: unknown = TO) =>
  jwt({ sub, video: { room, roomJoin: true }, exp: 2_000_000_000 });

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

test("a non-string token at runtime is not usable and never throws", () => {
  // The voice store hands the event's token straight in (D3: the retired
  // `moveTokenForConnection` guarded this before calling here).
  for (const token of [null, 42, {}, [moveToken()], true]) {
    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = moveTokenUsable({
        token: token as unknown as string,
        expectedIdentity: QUALIFIED,
        to: TO,
      });
    });
    assert.equal(result, false, String(token));
  }
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

// --- moveAuthDecision (F4) -------------------------------------------------

test("F4: the full truth table of the decision after M3", () => {
  // [hasAuth, tokenUsable, latchStillRefused] -> decision, all 8 rows.
  const rows: [boolean, boolean, boolean, MoveAuthDecision][] = [
    [false, false, false, "join"],
    [false, false, true, "join"],
    [false, true, false, "join"],
    [false, true, true, "join"],
    [true, false, false, "join"],
    [true, false, true, "answer_latch"],
    [true, true, false, "use"],
    [true, true, true, "use"],
  ];
  assert.equal(rows.length, 8);
  for (const [hasAuth, tokenUsable, latchStillRefused, expected] of rows)
    assert.equal(
      moveAuthDecision({ hasAuth, tokenUsable, latchStillRefused }),
      expected,
      `hasAuth=${hasAuth} tokenUsable=${tokenUsable} latchStillRefused=${latchStillRefused}`,
    );
});

test("F4: a dropped token answers from the latch only while the latch still refuses", () => {
  // The latch may clear during the awaits before M3: then the attempt is
  // one `connect()` would have let through, so it joins normally.
  assert.equal(
    moveAuthDecision({
      hasAuth: true,
      tokenUsable: false,
      latchStillRefused: true,
    }),
    "answer_latch",
  );
  assert.equal(
    moveAuthDecision({
      hasAuth: true,
      tokenUsable: false,
      latchStillRefused: false,
    }),
    "join",
  );
});

test("F4: a usable token is used even past a latch it bypassed", () => {
  // S1: the move token is what lets a moved member past a permission or
  // capacity latch, so a usable one must still be used.
  assert.equal(
    moveAuthDecision({
      hasAuth: true,
      tokenUsable: true,
      latchStillRefused: true,
    }),
    "use",
  );
});

test("F4: without auth there is no pre-minted token to use or bypass with", () => {
  for (const tokenUsable of [false, true])
    for (const latchStillRefused of [false, true])
      assert.equal(
        moveAuthDecision({ hasAuth: false, tokenUsable, latchStillRefused }),
        "join",
      );
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

test("drag truth table: desktop only; never a bot; self always; others need MoveMembers and rank", () => {
  let rows = 0;
  for (const isMobile of [false, true])
    for (const isBot of [false, true])
      for (const isSelf of [false, true])
        for (const canMoveMembersInSource of [false, true])
          for (const outranksTarget of [false, true]) {
            const expected =
              !isMobile &&
              !isBot &&
              (isSelf || (canMoveMembersInSource && outranksTarget));
            const input = {
              isMobile,
              isSelf,
              canMoveMembersInSource,
              outranksTarget,
              isBot,
            };
            assert.equal(
              canDragParticipant(input),
              expected,
              JSON.stringify(input),
            );
            rows++;
          }
  assert.equal(rows, 32);
});

test("mobile never drags, not even yourself", () => {
  assert.equal(
    canDragParticipant({
      isMobile: true,
      isSelf: true,
      canMoveMembersInSource: true,
      outranksTarget: true,
      isBot: false,
    }),
    false,
  );
});

test("a bot is never dragged, whatever the mover holds", () => {
  // The server refuses to move a bot (`IsBot`), so the drag would only end
  // in an error.
  assert.equal(
    canDragParticipant({
      isMobile: false,
      isSelf: false,
      canMoveMembersInSource: true,
      outranksTarget: true,
      isBot: true,
    }),
    false,
  );
});

test("the bot check comes before the self check: a bot's own row is not draggable", () => {
  assert.equal(
    canDragParticipant({
      isMobile: false,
      isSelf: true,
      canMoveMembersInSource: false,
      outranksTarget: false,
      isBot: true,
    }),
    false,
  );
  // The same row for a human is draggable, so the bot flag is what refused.
  assert.equal(
    canDragParticipant({
      isMobile: false,
      isSelf: true,
      canMoveMembersInSource: false,
      outranksTarget: false,
      isBot: false,
    }),
    true,
  );
});

test("MoveMembers without rank, or rank without MoveMembers, cannot drag others", () => {
  const base = { isMobile: false, isSelf: false, isBot: false };
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
 * What `ServerMember.edit()` rejects with when the server answers `status`
 * (403 unless given) with `body` as JSON, or with `raw` verbatim as HTML
 * when given (a proxy's error page): the REAL stoat-api `API.patch` (the
 * call `edit` makes) against a stubbed `fetch`. stoat-api is resolved from
 * stoat.js, the package that depends on it, so a stoat-api bump there is
 * what this exercises.
 */
async function sdkRejection(
  body: unknown,
  opts: { status?: number; raw?: string } = {},
): Promise<unknown> {
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
    new Response(opts.raw ?? JSON.stringify(body), {
      status: opts.status ?? 403,
      headers: {
        "Content-Type":
          opts.raw === undefined ? "application/json" : "text/html",
      },
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
  assert.fail("the stubbed refusal resolved");
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

/**
 * Input no refusal reader may recognize or throw on. Shared by
 * `isTargetCannotViewError` and `moveRefusalKind`. Label failures by index:
 * `String()` of the throwing proxy would itself throw.
 */
function oddInputs(): unknown[] {
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
  return [
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
}

test("odd input is not recognized and never throws", () => {
  oddInputs().forEach((error, index) => {
    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = isTargetCannotViewError(error);
    }, `odd input #${index}`);
    assert.equal(result, false, `odd input #${index}`);
  });
});

// --- moveRefusalKind ---------------------------------------------------------

/**
 * One body per kind. A Record over the union, so a new `MoveRefusalKind`
 * without a row here is a tsc error, and the test below proves every kind
 * is produced by exactly the body listed for it.
 */
const BODY_OF_KIND: Record<MoveRefusalKind, unknown> = {
  "target-cannot-view": TARGET_CANNOT_VIEW,
  "is-bot": { type: "IsBot", location: "member_edit.rs:513:24" },
  "cannot-join": { type: "CannotJoinCall" },
  "not-connected": { type: "NotConnected" },
  "not-authenticated": { type: "NotAuthenticated" },
  // What a typed delta 500 carries: `serde(tag = "type")` on the error.
  "server-error": { type: "InternalError", location: "somewhere.rs:1:1" },
  other: { type: "NotAVoiceChannel" },
};

/**
 * Every error type the move path (`member_edit.rs` `edit` and the move it
 * calls, backend `db744bc1`) can answer, with its kind. Bodies are what the
 * server serializes (`serde(tag = "type")`, struct variants' fields
 * inline).
 */
const MOVE_PATH_ROWS: [unknown, MoveRefusalKind][] = [
  // The 409 call caps the move shares with the join front door
  // (`assert_call_caps_admit`).
  [{ type: "VideoCallFull", max: 25 }, "cannot-join"],
  [{ type: "MlsCallFull", max: 50 }, "cannot-join"],
  [{ type: "CannotJoinCall" }, "cannot-join"],
  // The server's own failures.
  [{ type: "InternalError" }, "server-error"],
  [
    {
      type: "DatabaseError",
      operation: "update_one",
      collection: "server_members",
    },
    "server-error",
  ],
  [{ type: "LiveKitUnavailable" }, "server-error"],
  [{ type: "UnknownNode" }, "server-error"],
  [{ type: "NotConnected" }, "not-connected"],
  [{ type: "NotAuthenticated" }, "not-authenticated"],
  [{ type: "IsBot" }, "is-bot"],
  [TARGET_CANNOT_VIEW, "target-cannot-view"],
  // Deliberately `other`: the mover's own permission or rank, a member or
  // destination that is gone, and malformed requests.
  [{ type: "MissingPermission", permission: "MoveMembers" }, "other"],
  [{ type: "MissingPermission", permission: "Connect" }, "other"],
  [{ type: "NotElevated" }, "other"],
  [{ type: "NotFound" }, "other"],
  [{ type: "UnknownChannel" }, "other"],
  [{ type: "NotAVoiceChannel" }, "other"],
  [{ type: "InvalidOperation" }, "other"],
  [{ type: "FailedValidation", error: "voice_channel" }, "other"],
];

test("each refusal type maps to its kind, in every shape", () => {
  const rows: [unknown, string][] = [...MOVE_PATH_ROWS];
  for (const [kind, body] of Object.entries(BODY_OF_KIND))
    rows.push([body, kind]);
  for (const [body, kind] of rows)
    for (const [shape, error] of Object.entries(shapesOf(body)))
      assert.equal(
        moveRefusalKind(error),
        kind,
        `${shape}: ${JSON.stringify(body)}`,
      );
});

test("a full call is cannot-join, whichever cap refused it", () => {
  // FE2WA-1: the move path answers the join front door's 409s, not only
  // `CannotJoinCall`.
  for (const type of ["VideoCallFull", "MlsCallFull", "CannotJoinCall"])
    for (const [shape, error] of Object.entries(shapesOf({ type, max: 1 })))
      assert.equal(moveRefusalKind(error), "cannot-join", `${type} ${shape}`);
});

test("every kind is reachable, and distinct bodies give distinct kinds", () => {
  const kinds = Object.values(BODY_OF_KIND).map(moveRefusalKind);
  assert.deepEqual(kinds, Object.keys(BODY_OF_KIND));
  assert.equal(new Set(kinds).size, 7);
});

test("InternalError is a server error, never folded into other", () => {
  // Its own copy tells the user to retry; `other` would blame permissions.
  for (const [shape, error] of Object.entries(
    shapesOf({ type: "InternalError" }),
  ))
    assert.equal(moveRefusalKind(error), "server-error", shape);
});

test("the mover's own MissingPermission is other, not target-cannot-view", () => {
  for (const permission of ["Connect", "MoveMembers", undefined, "viewchannel"])
    for (const [shape, error] of Object.entries(
      shapesOf({ type: "MissingPermission", permission }),
    ))
      assert.equal(
        moveRefusalKind(error),
        "other",
        `${shape}: ${String(permission)}`,
      );
});

test("unknown, near-miss and non-string types are other", () => {
  for (const body of [
    { type: "NotElevated" },
    { type: "InvalidOperation" },
    { type: "MissingUserPermission", permission: "ViewChannel" },
    { permission: "ViewChannel" },
    {},
    // Exact and case-sensitive.
    { type: "isbot" },
    { type: "IsBot " },
    { type: "internalerror" },
    { type: "Internal Error" },
    { type: " NotConnected" },
    // Not a string.
    { type: ["IsBot"] },
    { type: 500 },
    { type: null },
    // Names on Object.prototype must not match anything.
    { type: "toString" },
    { type: "constructor" },
    { type: "__proto__" },
    { type: "hasOwnProperty" },
  ]) {
    for (const [shape, error] of Object.entries(shapesOf(body)))
      assert.equal(
        moveRefusalKind(error),
        "other",
        `${shape}: ${JSON.stringify(body)}`,
      );
  }
  // `{ toString }` is not the string, even though it prints as one.
  assert.equal(
    moveRefusalKind({ type: { toString: () => "InternalError" } }),
    "other",
  );
});

test("agrees with isTargetCannotViewError on every input it is handed", () => {
  const bodies = [
    ...Object.values(BODY_OF_KIND),
    { type: "MissingPermission", permission: "ViewChannel" },
    { type: "MissingPermission", permission: "Connect" },
    { type: "MissingPermission", permission: ["ViewChannel"] },
  ];
  const inputs = [
    ...bodies.flatMap((body) => Object.values(shapesOf(body))),
    ...oddInputs(),
  ];
  inputs.forEach((error, index) =>
    assert.equal(
      moveRefusalKind(error) === "target-cannot-view",
      isTargetCannotViewError(error),
      `input #${index}`,
    ),
  );
});

test("the body itself outranks the axios response.data body", () => {
  // A body with a known type is read as is; `response.data` is consulted
  // only when the body itself says nothing this knows.
  assert.equal(
    moveRefusalKind({
      type: "NotConnected",
      response: { data: { type: "IsBot" } },
    }),
    "not-connected",
  );
  assert.equal(
    moveRefusalKind({
      type: "SomethingElse",
      response: { data: JSON.stringify({ type: "IsBot" }) },
    }),
    "is-bot",
  );
});

test("FE2WA-11: a ViewChannel refusal in response.data outranks a known type on the body", () => {
  // `isTargetCannotViewError` accepts either place and is asked first. Only
  // the old axios-style error could carry both.
  for (const data of [TARGET_CANNOT_VIEW, JSON.stringify(TARGET_CANNOT_VIEW)])
    assert.equal(
      moveRefusalKind({ type: "IsBot", response: { data } }),
      "target-cannot-view",
    );
});

test("odd input is other and never throws", () => {
  const odd = oddInputs();
  // The ones a rejection handler most plausibly sees, named.
  assert.ok(odd.includes(null));
  assert.ok(odd.includes("string"));
  assert.ok(odd.includes(42));
  odd.forEach((error, index) => {
    let result: MoveRefusalKind | undefined;
    assert.doesNotThrow(() => {
      result = moveRefusalKind(error);
    }, `odd input #${index}`);
    assert.equal(result, "other", `odd input #${index}`);
  });
});

test("what the SDK rejects with for a typed 500, a 409 cap, a bot, a gone target and a proxy page", async () => {
  // stoat-api throws the JSON body as text for any non-2xx status.
  const internal = await sdkRejection(
    { type: "InternalError", location: "crates/x.rs:1:1" },
    { status: 500 },
  );
  assert.equal(typeof internal, "string");
  assert.equal(moveRefusalKind(internal), "server-error");

  assert.equal(
    moveRefusalKind(
      await sdkRejection({ type: "VideoCallFull", max: 25 }, { status: 409 }),
    ),
    "cannot-join",
  );
  assert.equal(
    moveRefusalKind(
      await sdkRejection({ type: "MlsCallFull", max: 50 }, { status: 409 }),
    ),
    "cannot-join",
  );
  assert.equal(
    moveRefusalKind(await sdkRejection({ type: "IsBot" }, { status: 400 })),
    "is-bot",
  );
  assert.equal(
    moveRefusalKind(
      await sdkRejection({ type: "NotConnected" }, { status: 400 }),
    ),
    "not-connected",
  );
  assert.equal(
    moveRefusalKind(await sdkRejection(TARGET_CANNOT_VIEW)),
    "target-cannot-view",
  );

  // A proxy in front of delta answers with HTML: not a typed error.
  const page = await sdkRejection(undefined, {
    status: 502,
    raw: "<html><body>502 Bad Gateway</body></html>",
  });
  assert.equal(typeof page, "string");
  assert.equal(moveRefusalKind(page), "other");
});

// --- the module's surface ----------------------------------------------------

test("the module exports exactly these values (D3: the obey rule lives in movePolicy)", () => {
  // `shouldObeyMove`, `moveTokenForConnection`, `MOVE_OBEY_WINDOW_MS` and
  // `PARTICIPANT_REMOVED_REASON` were retired: a second "does this
  // connection follow" rule beside `moveDecision` is the bug this pins
  // against.
  assert.deepEqual(Object.keys(policy).sort(), [
    "canDragParticipant",
    "decodeMoveTokenClaims",
    "isTargetCannotViewError",
    "moveAuthDecision",
    "moveBypassesRefusalLatch",
    "moveRefusalKind",
    "moveTargets",
    "moveTokenUsable",
  ]);
});
