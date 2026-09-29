// Unit spec for inbound MLS routing and the pre-sink hold — run with Node's
// built-in runner:
//   node --test --conditions=browser components/client/mlsInboundBuffer.test.ts
// Focus: the reconnect drain replays MLS envelopes as `E2EEMessage` before any
// call session exists. `inboundRoute` must keep them off the Olm path, and
// `MlsInboundBuffer` must hand them to the session later in delivery order,
// once each, without ever evicting one (an evicted envelope is a gap the
// session cannot see; an unheld one simply stays unacked server-side).
import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import {
  type MlsBufferedEnvelope,
  MlsInboundBuffer,
  inboundRoute,
} from "./mlsInboundBuffer.ts";

const env = (id: string, epoch = 1): MlsBufferedEnvelope => ({
  kind: "envelope",
  recipientDeviceId: "dev1",
  envelope: {
    id,
    content_type: "mls_commit",
    group_id: "g",
    epoch,
    ciphertext: `ct-${id}`,
  },
});

const ids = (held: MlsBufferedEnvelope[]) => held.map((e) => e.envelope.id);

/** Silence and record `console.warn` for the rest of the test. */
const spyWarn = (t: TestContext) =>
  t.mock.method(console, "warn", () => undefined);

test("each MLS content type → mls", () => {
  for (const contentType of ["mls_commit", "mls_welcome", "mls_ctl"]) {
    assert.equal(inboundRoute(contentType), "mls", contentType);
  }
});

test("missing, olm or unrecognized content type → olm (the pre-MLS path)", () => {
  assert.equal(inboundRoute(undefined), "olm");
  assert.equal(inboundRoute(null), "olm");
  assert.equal(inboundRoute("olm"), "olm");
  for (const contentType of ["some_future_type", "mls", "MLS_COMMIT", ""]) {
    assert.equal(inboundRoute(contentType), "olm", contentType);
  }
});

test("FIFO: drain returns envelopes in push order, across separate pushes", () => {
  const buffer = new MlsInboundBuffer();
  const a = env("a", 3);
  const b = env("b", 1);
  const c = env("c", 2);
  assert.equal(buffer.push(a), "buffered");
  assert.equal(buffer.push(b), "buffered");
  assert.equal(buffer.push(c), "buffered");
  assert.equal(buffer.size, 3);
  const held = buffer.drain();
  assert.deepEqual(ids(held), ["a", "b", "c"]);
  // Handed on as is: the same objects, `recipientDeviceId` included.
  assert.equal(held[0], a);
  assert.equal(held[1], b);
  assert.equal(held[2], c);
});

test("duplicate id → duplicate, held once, the first copy kept", () => {
  const buffer = new MlsInboundBuffer();
  const first = env("a", 1);
  assert.equal(buffer.push(first), "buffered");
  assert.equal(buffer.push(env("b")), "buffered");
  // A drain replaying an id a live push already delivered.
  assert.equal(buffer.push(env("a", 9)), "duplicate");
  assert.equal(buffer.size, 2);
  const held = buffer.drain();
  assert.deepEqual(ids(held), ["a", "b"]);
  assert.equal(held[0], first);
});

test("dedup is against what is CURRENTLY held: after drain or clear the id is accepted again", () => {
  const buffer = new MlsInboundBuffer();
  assert.equal(buffer.push(env("a")), "buffered");
  assert.deepEqual(ids(buffer.drain()), ["a"]);
  assert.equal(buffer.push(env("a")), "buffered");
  buffer.clear();
  assert.equal(buffer.push(env("a")), "buffered");
  assert.equal(buffer.size, 1);
});

test("bound: max held, the next → overflow, nothing evicted, the overflowing envelope not held", (t) => {
  spyWarn(t);
  const buffer = new MlsInboundBuffer(3);
  assert.equal(buffer.push(env("a")), "buffered");
  assert.equal(buffer.push(env("b")), "buffered");
  assert.equal(buffer.push(env("c")), "buffered");
  assert.equal(buffer.push(env("d")), "overflow");
  assert.equal(buffer.push(env("e")), "overflow");
  assert.equal(buffer.size, 3);
  assert.deepEqual(ids(buffer.drain()), ["a", "b", "c"]);
  // `d` was never held, so a redelivery after the drain is not a duplicate.
  assert.equal(buffer.push(env("d")), "buffered");
});

test("exactly one warning per overflow episode; a new episode after drain() warns again", (t) => {
  const warn = spyWarn(t);
  const buffer = new MlsInboundBuffer(2);
  buffer.push(env("a"));
  buffer.push(env("b"));
  assert.equal(warn.mock.callCount(), 0, "no warning below the bound");
  assert.equal(buffer.push(env("c")), "overflow");
  assert.equal(buffer.push(env("d")), "overflow");
  assert.equal(buffer.push(env("e")), "overflow");
  assert.equal(warn.mock.callCount(), 1, "one warning for the episode");

  buffer.drain();
  buffer.push(env("f"));
  buffer.push(env("g"));
  assert.equal(warn.mock.callCount(), 1, "refilling to the bound is silent");
  assert.equal(buffer.push(env("h")), "overflow");
  assert.equal(buffer.push(env("i")), "overflow");
  assert.equal(warn.mock.callCount(), 2, "one more for the new episode");
});

test("a new overflow episode after clear() warns again", (t) => {
  const warn = spyWarn(t);
  const buffer = new MlsInboundBuffer(1);
  buffer.push(env("a"));
  assert.equal(buffer.push(env("b")), "overflow");
  assert.equal(warn.mock.callCount(), 1);
  buffer.clear();
  buffer.push(env("c"));
  assert.equal(buffer.push(env("d")), "overflow");
  assert.equal(buffer.push(env("e")), "overflow");
  assert.equal(warn.mock.callCount(), 2);
});

test("drain() returns everything in order and leaves the buffer empty", () => {
  const buffer = new MlsInboundBuffer();
  buffer.push(env("a"));
  buffer.push(env("b"));
  const held = buffer.drain();
  assert.deepEqual(ids(held), ["a", "b"]);
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.drain(), []);
  // A push after the drain is held anew, not appended to what was returned.
  buffer.push(env("c"));
  assert.deepEqual(ids(held), ["a", "b"]);
  assert.deepEqual(ids(buffer.drain()), ["c"]);
});

test("clear() drops everything held", () => {
  const buffer = new MlsInboundBuffer();
  buffer.push(env("a"));
  buffer.push(env("b"));
  buffer.clear();
  assert.equal(buffer.size, 0);
  assert.deepEqual(buffer.drain(), []);
});

test("default bound is 512", (t) => {
  const warn = spyWarn(t);
  const buffer = new MlsInboundBuffer();
  for (let i = 0; i < 512; i++) {
    assert.equal(buffer.push(env(`e${i}`)), "buffered");
  }
  assert.equal(buffer.push(env("e512")), "overflow");
  assert.equal(buffer.size, 512);
  assert.equal(warn.mock.callCount(), 1);
});
