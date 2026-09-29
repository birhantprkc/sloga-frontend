// Unit spec for the web-push VAPID key helpers — run with Node's built-in
// runner:
//   node --conditions=browser --test components/client/webPushKey.test.ts
// Declared test count: 20 (the gate compares this against the runner's pass
// count, since the runner also exits 0 when it finds no tests at all).
// Focus: the server advertises its key unpadded while older configs carried
// it padded, and either base64 alphabet may turn up, so every spelling of one
// key must decode to the same 65 bytes; anything that is not an uncompressed
// P-256 point (65 bytes, 0x04 first) must be rejected rather than handed to
// `subscribe()`. The two planners are pinned by full truth tables.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compareSubscriptionKey,
  decodeVapidKey,
  keyMarker,
  planWebPushSubscription,
  shouldResyncWebPush,
} from "./webPushKey.ts";

/**
 * Upstream Revolt's committed default public key, unpadded base64url (the
 * `UPSTREAM_DEFAULT_VAPID_PUBLIC` constant in pushd's `vapid.rs`). It is a
 * public key, used here only as a known-good fixture.
 */
const UPSTREAM_UNPADDED =
  "BGcvgR-i2z4IQ5Mw841vJvkLjt8wY-FjmWrw83jOLCY52qcGZS0OF7nfLzuYbjsQISwVO2HXrmf18gLWVX3Kwfw";

/** The same key padded to 88 characters, as older configs spelled it. */
const UPSTREAM_PADDED = UPSTREAM_UNPADDED + "=";

/** Maps base64url to the standard alphabet. */
function toStandard(s: string): string {
  return s.replace(/-/g, "+").replace(/_/g, "/");
}

/** Encodes bytes as unpadded base64url, independently of the code under test. */
function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Decodes a key the test expects to be valid, failing the test otherwise. */
function mustDecode(s: string): Uint8Array {
  const bytes = decodeVapidKey(s);
  assert.ok(bytes, `expected ${JSON.stringify(s.slice(0, 8))}… to decode`);
  return bytes;
}

/** A fresh, exactly-sized buffer holding a copy of the bytes. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.length);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

test("the upstream key decodes to a 65-byte uncompressed point", () => {
  const bytes = mustDecode(UPSTREAM_UNPADDED);
  assert.equal(bytes.length, 65);
  assert.equal(bytes[0], 0x04);
});

test("the padded and unpadded spellings decode to the same bytes", () => {
  assert.equal(UPSTREAM_UNPADDED.length, 87);
  assert.equal(UPSTREAM_PADDED.length, 88);
  assert.deepEqual(mustDecode(UPSTREAM_PADDED), mustDecode(UPSTREAM_UNPADDED));
});

test("the standard and url-safe alphabets decode to the same bytes", () => {
  const standard = toStandard(UPSTREAM_PADDED);
  // The fixture has to exercise the alphabet difference to prove anything.
  assert.notEqual(standard, UPSTREAM_PADDED);
  const expected = mustDecode(UPSTREAM_UNPADDED);
  assert.deepEqual(mustDecode(standard), expected);
  assert.deepEqual(mustDecode(toStandard(UPSTREAM_UNPADDED)), expected);
});

test("surrounding whitespace is ignored", () => {
  const expected = mustDecode(UPSTREAM_UNPADDED);
  assert.deepEqual(mustDecode(`  ${UPSTREAM_UNPADDED}\n`), expected);
  assert.deepEqual(mustDecode(`\t${UPSTREAM_PADDED} `), expected);
});

test("an empty key is rejected", () => {
  assert.equal(decodeVapidKey(""), null);
  assert.equal(decodeVapidKey("   "), null);
});

test("garbage is rejected", () => {
  const withBadChar =
    UPSTREAM_UNPADDED.slice(0, 40) + "*" + UPSTREAM_UNPADDED.slice(41);
  for (const s of ["garbage", "!!!!", "%%%%%%%%", withBadChar]) {
    assert.equal(decodeVapidKey(s), null, JSON.stringify(s));
  }
});

test("a key of the wrong length is rejected", () => {
  const bytes = mustDecode(UPSTREAM_UNPADDED);
  const short = encode(bytes.slice(0, 64));
  const long = encode(Uint8Array.of(...bytes, 0x00));
  assert.equal(decodeVapidKey(short), null, "64 bytes");
  assert.equal(decodeVapidKey(long), null, "66 bytes");
});

test("a 65-byte key without the 0x04 prefix is rejected", () => {
  const bytes = mustDecode(UPSTREAM_UNPADDED);
  for (const prefix of [0x00, 0x02, 0x03, 0x05]) {
    const wrong = Uint8Array.from(bytes);
    wrong[0] = prefix;
    assert.equal(decodeVapidKey(encode(wrong)), null, `prefix ${prefix}`);
  }
});

test("keyMarker round-trips every accepted spelling to unpadded base64url", () => {
  for (const s of [
    UPSTREAM_UNPADDED,
    UPSTREAM_PADDED,
    toStandard(UPSTREAM_UNPADDED),
    toStandard(UPSTREAM_PADDED),
  ]) {
    assert.equal(keyMarker(mustDecode(s)), UPSTREAM_UNPADDED);
  }
});

test("keyMarker uses the url-safe alphabet without padding", () => {
  // Standard base64 of these bytes is "+/8=".
  assert.equal(keyMarker(Uint8Array.of(0xfb, 0xff)), "-_8");
});

test("an existing subscription without a readable key is unknown", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  assert.equal(compareSubscriptionKey(null, advertised), "unknown");
  assert.equal(compareSubscriptionKey(undefined, advertised), "unknown");
});

test("a byte-equal existing key matches", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  assert.equal(
    compareSubscriptionKey(bufferOf(advertised), advertised),
    "match",
  );
});

test("a differing existing key is a mismatch", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  const flipped = Uint8Array.from(advertised);
  flipped[64] ^= 0x01;
  assert.equal(
    compareSubscriptionKey(bufferOf(flipped), advertised),
    "mismatch",
    "one byte differs",
  );
  assert.equal(
    compareSubscriptionKey(bufferOf(advertised.slice(0, 64)), advertised),
    "mismatch",
    "shorter",
  );
  assert.equal(
    compareSubscriptionKey(new ArrayBuffer(0), advertised),
    "mismatch",
    "empty",
  );
});

test("shouldResyncWebPush only for a granted permission and an allowed state", () => {
  const permissions = ["granted", "denied", "default", "unsupported"] as const;
  const states = ["allowed", "default", "denied"];
  for (const permission of permissions) {
    for (const pushState of states) {
      assert.equal(
        shouldResyncWebPush({ permission, pushState }),
        permission === "granted" && pushState === "allowed",
        `${permission} × ${pushState}`,
      );
    }
  }
});

const EXISTING = ["none", "match", "mismatch", "unknown"] as const;
const MARKER = [true, false, null] as const;

test("plan: no valid advertised key is invalid, whatever else holds", () => {
  for (const existing of EXISTING) {
    for (const markerMatches of MARKER) {
      assert.equal(
        planWebPushSubscription({ advertised: null, existing, markerMatches }),
        "invalid",
        `${existing} × ${markerMatches}`,
      );
    }
  }
});

test("plan: no existing subscription subscribes", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  for (const markerMatches of MARKER) {
    assert.equal(
      planWebPushSubscription({ advertised, existing: "none", markerMatches }),
      "subscribe",
      String(markerMatches),
    );
  }
});

test("plan: a matching subscription is reused", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  for (const markerMatches of MARKER) {
    assert.equal(
      planWebPushSubscription({ advertised, existing: "match", markerMatches }),
      "reuse",
      String(markerMatches),
    );
  }
});

test("plan: a mismatched subscription is replaced", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  for (const markerMatches of MARKER) {
    assert.equal(
      planWebPushSubscription({
        advertised,
        existing: "mismatch",
        markerMatches,
      }),
      "resubscribe",
      String(markerMatches),
    );
  }
});

test("plan: an unknown key with a stale marker is replaced", () => {
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  assert.equal(
    planWebPushSubscription({
      advertised,
      existing: "unknown",
      markerMatches: false,
    }),
    "resubscribe",
  );
});

test("plan: an unknown key with a matching or unreadable marker is reused", () => {
  // `null` is storage being unavailable: churning the subscription on every
  // launch would be worse than trusting it.
  const advertised = mustDecode(UPSTREAM_UNPADDED);
  for (const markerMatches of [true, null]) {
    assert.equal(
      planWebPushSubscription({
        advertised,
        existing: "unknown",
        markerMatches,
      }),
      "reuse",
      String(markerMatches),
    );
  }
});
