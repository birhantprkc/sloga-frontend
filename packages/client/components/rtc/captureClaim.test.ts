// Race matrix for the shared capture claim — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/captureClaim.test.ts
//
// `--conditions=browser` for the same reason as every other spec here (Node
// otherwise resolves solid-js to its server build). Nothing below is reactive;
// the claim is deliberately plain so that exactly this file can pin its
// behaviour without a room, a server, or a DOM.
//
// Every test here corresponds to a way the flag can end up lying about what is
// being captured. The dangerous direction is always the same one: the flag
// down while audio is still being read.
import assert from "node:assert/strict";
import { test } from "node:test";

import { CaptureClaim } from "./captureClaim.ts";

interface Call {
  channelId: string;
  claimed: boolean;
}

/** A promise a test can settle by hand, to hold a mutation in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A claim whose server calls are recorded. `onCall` runs AFTER the call is
 * recorded but before it resolves, so `calls.length` means "started", which is
 * what the ordering assertions need.
 */
function makeClaim(
  onCall?: (call: Call, index: number) => Promise<void> | void,
) {
  const calls: Call[] = [];
  const claim = new CaptureClaim(async (channelId, claimed) => {
    const index = calls.length;
    calls.push({ channelId, claimed });
    await onCall?.({ channelId, claimed }, index);
  });
  return { claim, calls };
}

const PUT = (channelId = "c") => ({ channelId, claimed: true });
const DELETE = (channelId = "c") => ({ channelId, claimed: false });

test("the first capture raises the flag", async () => {
  const { claim, calls } = makeClaim();

  assert.equal(await claim.acquire("recording", "c", claim.generation), true);

  assert.deepEqual(calls, [PUT()]);
  assert.equal(claim.claimed, true);
  assert.equal(claim.holds("recording"), true);
  assert.equal(claim.holds("transcription"), false);
});

test("a second capture rides the flag the first one raised", async () => {
  const { claim, calls } = makeClaim();

  await claim.acquire("recording", "c", claim.generation);
  await claim.acquire("transcription", "c", claim.generation);

  // One PUT, not two: the room is already told.
  assert.deepEqual(calls, [PUT()]);
  assert.equal(claim.holds("recording"), true);
  assert.equal(claim.holds("transcription"), true);
});

test("acquiring the same capture twice is a no-op", async () => {
  const { claim, calls } = makeClaim();

  await claim.acquire("recording", "c", claim.generation);
  assert.equal(await claim.acquire("recording", "c", claim.generation), true);

  assert.deepEqual(calls, [PUT()]);
});

test("stopping one of two captures leaves the flag up", async () => {
  const { claim, calls } = makeClaim();
  await claim.acquire("transcription", "c", claim.generation);
  await claim.acquire("recording", "c", claim.generation);

  await claim.release("recording", "c", claim.generation);

  // No DELETE: the transcriber is still reading decrypted audio, and the room
  // must go on being told about it.
  assert.deepEqual(calls, [PUT()]);
  assert.equal(claim.claimed, true);
  assert.equal(claim.holds("transcription"), true);
  assert.equal(claim.holds("recording"), false);
});

test("the last capture to stop lowers the flag", async () => {
  const { claim, calls } = makeClaim();
  await claim.acquire("transcription", "c", claim.generation);
  await claim.acquire("recording", "c", claim.generation);

  await claim.release("recording", "c", claim.generation);
  await claim.release("transcription", "c", claim.generation);

  assert.deepEqual(calls, [PUT(), DELETE()]);
  assert.equal(claim.claimed, false);
});

test("a recorder that fails to start mid-transcription does not clear the banner", async () => {
  // The exact trace this class exists for. Before the refcount, the recorder's
  // failed-start retraction sent an unconditional DELETE, clearing every
  // participant's banner while the transcriber kept capturing.
  const { claim, calls } = makeClaim();
  await claim.acquire("transcription", "c", claim.generation);

  // Recorder starts: rides the existing flag, no network call...
  await claim.acquire("recording", "c", claim.generation);
  // ...then its MediaRecorder throws, so it retracts.
  await claim.release("recording", "c", claim.generation);

  assert.deepEqual(calls, [PUT()]);
  assert.equal(claim.claimed, true);
});

test("a refused claim is not counted as held", async () => {
  const { claim, calls } = makeClaim((_call, index) => {
    if (index === 0) throw new Error("You don't have permission.");
  });

  await assert.rejects(
    claim.acquire("recording", "c", claim.generation),
    /permission/,
  );
  assert.equal(claim.claimed, false);
  assert.equal(claim.holds("recording"), false);

  // Releasing what was never claimed must not send a DELETE for a flag that
  // was never raised.
  await claim.release("recording", "c", claim.generation);
  assert.equal(calls.length, 1);
});

test("a refused claim does not poison later mutations", async () => {
  const { claim, calls } = makeClaim((_call, index) => {
    if (index === 0) throw new Error("network");
  });

  await assert.rejects(claim.acquire("recording", "c", claim.generation));

  // The chain must still work — and this is a fresh PUT, proving the failed
  // attempt left the refcount empty.
  assert.equal(
    await claim.acquire("transcription", "c", claim.generation),
    true,
  );
  assert.deepEqual(calls, [PUT(), PUT()]);
});

test("releasing twice sends one DELETE", async () => {
  // Real path: the user presses Stop, the capture's own error handler fires,
  // and call teardown runs — all for one recording.
  const { claim, calls } = makeClaim();
  await claim.acquire("recording", "c", claim.generation);

  await claim.release("recording", "c", claim.generation);
  await claim.release("recording", "c", claim.generation);

  assert.deepEqual(calls, [PUT(), DELETE()]);
});

test("releasing something never acquired does nothing", async () => {
  const { claim, calls } = makeClaim();

  await claim.release("transcription", "c", claim.generation);

  assert.deepEqual(calls, []);
});

test("mutations run in call order, not completion order", async () => {
  // Stop one capture and immediately start the other: without serialisation a
  // DELETE and a PUT are in flight together and the server keeps whichever it
  // happens to handle last.
  const gate = deferred();
  const { claim, calls } = makeClaim((call) =>
    call.claimed ? undefined : gate.promise,
  );
  await claim.acquire("recording", "c", claim.generation);

  const releasing = claim.release("recording", "c", claim.generation);
  const acquiring = claim.acquire("transcription", "c", claim.generation);

  // The DELETE is in flight; the PUT must not have started behind its back.
  await Promise.resolve();
  assert.deepEqual(calls, [PUT(), DELETE()]);

  gate.resolve();
  await releasing;
  assert.equal(await acquiring, true);

  assert.deepEqual(calls, [PUT(), DELETE(), PUT()]);
  assert.equal(claim.claimed, true);
});

test("a claim that lands after the call ended is dropped", async () => {
  // The transcription case: Start is pressed, a model download runs for half a
  // minute, and the user leaves before it finishes.
  const gate = deferred();
  const { claim } = makeClaim(() => gate.promise);
  const generation = claim.generation;

  const acquiring = claim.acquire("transcription", "c", generation);
  claim.reset(); // disconnect()
  gate.resolve();

  assert.equal(await acquiring, false);
  assert.equal(claim.holds("transcription"), false);
  assert.equal(claim.claimed, false);
});

test("a claim for an ended call never reaches the server", async () => {
  const { claim, calls } = makeClaim();
  const generation = claim.generation;

  claim.reset();

  assert.equal(await claim.acquire("recording", "c", generation), false);
  assert.deepEqual(calls, []);
});

test("teardown skips the retraction the server does for us", async () => {
  const { claim, calls } = makeClaim();
  await claim.acquire("recording", "c", claim.generation);
  const stale = claim.generation;

  claim.reset();
  await claim.release("recording", "c", stale);

  // Leaving the call clears the flag with the rest of the voice state, and the
  // channel may already be gone.
  assert.deepEqual(calls, [PUT()]);
});

test("the next call starts clean", async () => {
  const { claim, calls } = makeClaim();
  await claim.acquire("recording", "c", claim.generation);
  await claim.acquire("transcription", "c", claim.generation);

  claim.reset();

  assert.equal(claim.claimed, false);
  assert.equal(claim.holds("recording"), false);
  assert.equal(claim.holds("transcription"), false);

  // A phantom refcount carried over would suppress the next call's PUT and
  // capture there with no disclosure at all.
  assert.equal(await claim.acquire("recording", "c2", claim.generation), true);
  assert.deepEqual(calls, [PUT(), PUT("c2")]);
});

test("the generation only moves on teardown", async () => {
  const { claim } = makeClaim();
  const generation = claim.generation;

  await claim.acquire("recording", "c", generation);
  await claim.release("recording", "c", generation);

  assert.equal(claim.generation, generation);
  claim.reset();
  assert.notEqual(claim.generation, generation);
});
