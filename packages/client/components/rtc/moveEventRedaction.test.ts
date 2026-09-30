// Debug-log redaction for server events, run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/moveEventRedaction.test.ts
//
// UserMoveVoiceChannel carries a LiveKit access token for this device. The
// SDK's `[S->C]` debug log must never print it, while the event that gets
// dispatched keeps it. The helper lives in its own enum-free module in the SDK
// so that this spec can load it with type stripping (EventClient.ts cannot be
// loaded that way). The spec sits here rather than under stoat.js/src because
// the SDK's tsconfig has no include/exclude and would emit it into lib/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { redactEventForLog } from "../../../stoat.js/src/events/redactEvent.ts";
import { assertLexesInSync, codeOf, countWired } from "./sourcePins.harness.ts";

const SDK_SOURCE_ROOT = new URL("../../../stoat.js/src/", import.meta.url);

const TOKEN = "eyJhbGciOiJIUzI1NiJ9.livekit-secret-token.c2lnbmF0dXJl";

function moveEvent(extra: Record<string, unknown> = {}) {
  return {
    type: "UserMoveVoiceChannel",
    node: "worldwide",
    from: "01FROMCHANNEL",
    to: "01TOCHANNEL",
    token: TOKEN,
    ...extra,
  };
}

test("a top-level move token is redacted and every other field is kept", () => {
  const event = moveEvent();
  const before = structuredClone(event);

  const out = redactEventForLog(event) as Record<string, unknown>;

  assert.notEqual(out, event);
  assert.deepEqual(out, { ...before, token: "[redacted]" });
  assert.deepEqual(event, before);
  assert.equal(event.token, TOKEN);
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test("a move token inside a Bulk is redacted in a copy of the Bulk", () => {
  const message = { type: "Message", _id: "01MSG", content: "hello" };
  const move = moveEvent();
  const event = { type: "Bulk", v: [message, move] };
  const before = structuredClone(event);

  const out = redactEventForLog(event) as {
    type: string;
    v: Record<string, unknown>[];
  };

  assert.notEqual(out, event);
  assert.notEqual(out.v, event.v);
  assert.equal(out.type, "Bulk");
  assert.equal(out.v.length, 2);
  assert.equal(out.v[0], message);
  assert.deepEqual(out.v[1], { ...before.v[1], token: "[redacted]" });
  assert.deepEqual(event, before);
  assert.equal(move.token, TOKEN);
  assert.ok(!JSON.stringify(out).includes(TOKEN));
});

test("a Bulk with nothing to redact is returned as the same reference", () => {
  const event = {
    type: "Bulk",
    v: [
      { type: "Message", _id: "01MSG" },
      { type: "UserMoveVoiceChannel", from: "01A", to: "01B" },
    ],
  };
  const before = structuredClone(event);

  assert.equal(redactEventForLog(event), event);
  assert.deepEqual(event, before);
});

test("a move event without a token is returned as the same reference", () => {
  const event = {
    type: "UserMoveVoiceChannel",
    node: "worldwide",
    from: "01A",
    to: "01B",
  };
  const before = structuredClone(event);

  assert.equal(redactEventForLog(event), event);
  assert.deepEqual(event, before);
});

test("other event types are returned as the same reference", () => {
  for (const event of [
    { type: "Ready", users: [] },
    { type: "Message", _id: "01MSG", token: "not-a-livekit-token" },
    { type: "VoiceChannelJoin", id: "01CH", state: {} },
    { token: TOKEN },
  ]) {
    const before = structuredClone(event);
    assert.equal(redactEventForLog(event), event);
    assert.deepEqual(event, before);
  }
});

test("non-object inputs are returned as-is", () => {
  assert.equal(redactEventForLog(null), null);
  assert.equal(redactEventForLog(undefined), undefined);
  assert.equal(
    redactEventForLog("UserMoveVoiceChannel"),
    "UserMoveVoiceChannel",
  );
  assert.equal(redactEventForLog(42), 42);
  assert.equal(redactEventForLog(true), true);
});

// FE1-2. The helper is only as good as its callers: the SDK logs every server
// event at two sites (the socket layer and the dispatcher), and each has to
// print the redacted copy. Matched as TEXT (`sourcePins.harness.ts`), since
// neither file can be loaded here.
test("source pin (FE1-2): both [S->C] debug logs print the redacted event, and there are no others", () => {
  const sites: string[] = [];
  for (const file of readdirSync(SDK_SOURCE_ROOT, {
    encoding: "utf8",
    recursive: true,
  })) {
    if (!file.endsWith(".ts")) continue;
    const source = readFileSync(new URL(file, SDK_SOURCE_ROOT), "utf8");
    const found = source.split(`"[S->C]"`).length - 1;
    sites.push(...Array<string>(found).fill(file.replaceAll("\\", "/")));
  }
  assert.deepEqual(sites.sort(), ["events/EventClient.ts", "events/v1.ts"]);
  for (const file of ["events/EventClient.ts", "events/v1.ts"]) {
    const source = readFileSync(new URL(file, SDK_SOURCE_ROOT), "utf8");
    const code = codeOf(source);
    assertLexesInSync(file, source, code, 10);
    assert.equal(
      countWired(code, `console.debug("[S->C]", redactEventForLog(event));`),
      1,
      `${file}: the [S->C] log prints redactEventForLog(event)`,
    );
    // The redactor is the one this spec loads, not a local stand-in.
    for (const local of [
      `functionredactEventForLog`,
      `redactEventForLog=`,
      `asredactEventForLog`,
    ])
      assert.equal(countWired(code, local), 0, `${file}: ${local}`);
  }
});
