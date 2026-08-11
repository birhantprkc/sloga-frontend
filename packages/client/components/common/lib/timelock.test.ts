// Specs for timelocked message sealing — run with Node's built-in runner:
//   node --test components/common/lib/timelock.test.ts
//
// The parse specs are pure. The crypto specs go through the REAL tlock-js
// module and the live drand quicknet beacon (same live-verification stance as
// the translation transport specs): a past round proves the full
// encrypt → wire format → parse → re-armor → decrypt chain, and a future
// round proves the "cannot be opened early" property actually holds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  TimelockNotReadyError,
  decryptTimelockMessage,
  encryptTimelockMessage,
  isTimelockMessage,
  parseTimelockContent,
} from "./timelock.ts";

test("ordinary and malformed content does not parse as timelock", () => {
  assert.equal(parseTimelockContent(undefined), undefined);
  assert.equal(parseTimelockContent("hello world"), undefined);
  // Machine line alone, without the human marker line.
  assert.equal(
    parseTimelockContent(`tlock:v1:1700000000000:${"A".repeat(80)}`),
    undefined,
  );
  // Marker but a third line smuggled in.
  assert.equal(
    parseTimelockContent(
      `⏳ Timelocked message — unlocks 2026-01-01 00:00 UTC\n` +
        `tlock:v1:1700000000000:${"A".repeat(80)}\nextra`,
    ),
    undefined,
  );
  // Base64 body too short to be a real age payload.
  assert.equal(
    parseTimelockContent(
      `⏳ Timelocked message — unlocks 2026-01-01 00:00 UTC\ntlock:v1:1700000000000:AAAA`,
    ),
    undefined,
  );
  // Characters outside the armor alphabet.
  assert.equal(
    parseTimelockContent(
      `⏳ Timelocked message — unlocks 2026-01-01 00:00 UTC\n` +
        `tlock:v1:1700000000000:${"A".repeat(79)}!`,
    ),
    undefined,
  );
});

test("encrypt → parse → decrypt roundtrips through a past round", async () => {
  const plaintext = "the vault opens — bring snacks 🎂";
  const unlockAt = new Date(Date.now() - 60_000);

  const content = await encryptTimelockMessage(plaintext, unlockAt);

  // Wire shape: exactly two lines, legible fallback first.
  const lines = content.split("\n");
  assert.equal(lines.length, 2);
  assert.ok(lines[0].startsWith("⏳ Timelocked message — unlocks "));
  assert.ok(isTimelockMessage(content));

  const payload = parseTimelockContent(content);
  assert.ok(payload);
  assert.equal(payload.unlockAt.getTime(), unlockAt.getTime());

  assert.equal(await decryptTimelockMessage(payload), plaintext);
});

test("a future round cannot be opened early", async () => {
  const content = await encryptTimelockMessage(
    "sealed",
    new Date(Date.now() + 60 * 60 * 1000),
  );
  const payload = parseTimelockContent(content);
  assert.ok(payload);
  await assert.rejects(
    () => decryptTimelockMessage(payload),
    TimelockNotReadyError,
  );
});
