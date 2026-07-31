// Specs for the bounded model queue — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/transcription/transcriptionQueue.test.ts
//
// Every case here corresponds to something that actually went wrong in a real
// two-party call: the queue grew until the tab died, and stop appeared to do
// nothing because it was waiting on a backlog that never cleared.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { TranscriptionEngine } from "./transcriptionEngine.ts";
import {
  DROPPING_MESSAGE,
  TranscriptionQueue,
  UNFINISHED_MESSAGE,
} from "./transcriptionQueue.ts";

/** A promise a test settles by hand, to hold a job in flight. */
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const JOB = { pcm: new Float32Array(16), spokenMs: 1000 };

/**
 * A queue over an engine whose every job is held open until the test releases
 * it, so backlog states can be built deliberately rather than raced into.
 */
function makeQueue(
  over: { maxPending?: number; drainTimeoutMs?: number } = {},
) {
  const gates: Array<ReturnType<typeof deferred<string | undefined>>> = [];
  const errors: string[] = [];
  const pendingSeen: number[] = [];

  const engine: TranscriptionEngine = {
    load: async () => undefined,
    transcribe: () => {
      const gate = deferred<string | undefined>();
      gates.push(gate);
      return gate.promise;
    },
    dispose: () => undefined,
  };

  const queue = new TranscriptionQueue(engine, {
    maxPending: over.maxPending ?? 3,
    drainTimeoutMs: over.drainTimeoutMs ?? 200,
    pollMs: 5,
    onPending: (n) => pendingSeen.push(n),
    onError: (m) => errors.push(m),
  });

  return { queue, gates, errors, pendingSeen };
}

/** Let the microtask queue settle so `.finally` handlers have run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("accepts work up to the cap", () => {
  const { queue } = makeQueue({ maxPending: 3 });

  assert.equal(
    queue.submit(JOB, () => undefined),
    true,
  );
  assert.equal(
    queue.submit(JOB, () => undefined),
    true,
  );
  assert.equal(
    queue.submit(JOB, () => undefined),
    true,
  );
  assert.equal(queue.pending, 3);
  assert.equal(queue.dropped, 0);
});

test("drops work past the cap instead of buffering it", () => {
  // The whole point: an unbounded backlog is unbounded memory, because every
  // pending utterance holds its own audio.
  const { queue } = makeQueue({ maxPending: 3 });
  for (let i = 0; i < 3; i++) queue.submit(JOB, () => undefined);

  assert.equal(
    queue.submit(JOB, () => undefined),
    false,
  );
  assert.equal(
    queue.submit(JOB, () => undefined),
    false,
  );

  assert.equal(queue.pending, 3, "the backlog must not grow past the cap");
  assert.equal(queue.dropped, 2);
});

test("says it is dropping speech, exactly once", () => {
  // Silence would leave a transcript with holes presenting itself as complete.
  // A notice per dropped utterance is its own kind of silence.
  const { queue, errors } = makeQueue({ maxPending: 1 });
  queue.submit(JOB, () => undefined);

  for (let i = 0; i < 5; i++) queue.submit(JOB, () => undefined);

  assert.deepEqual(errors, [DROPPING_MESSAGE]);
  assert.equal(queue.dropped, 5);
});

test("accepts work again once the backlog clears", async () => {
  const { queue, gates } = makeQueue({ maxPending: 2 });
  queue.submit(JOB, () => undefined);
  queue.submit(JOB, () => undefined);
  assert.equal(
    queue.submit(JOB, () => undefined),
    false,
  );

  gates[0].resolve("done");
  await settle();

  assert.equal(queue.pending, 1);
  assert.equal(
    queue.submit(JOB, () => undefined),
    true,
  );
});

test("reports the backlog as it grows and shrinks", async () => {
  // This is what the panel shows as "finishing N"; without it a draining
  // backlog is indistinguishable from a stop that did nothing.
  const { queue, gates, pendingSeen } = makeQueue({ maxPending: 3 });
  queue.submit(JOB, () => undefined);
  queue.submit(JOB, () => undefined);
  assert.deepEqual(pendingSeen, [1, 2]);

  gates[0].resolve("a");
  gates[1].resolve("b");
  await settle();

  assert.deepEqual(pendingSeen, [1, 2, 1, 0]);
  assert.equal(queue.pending, 0);
});

test("hands each result back to its own caller", async () => {
  const { queue, gates } = makeQueue();
  const got: Array<string | undefined> = [];
  queue.submit(JOB, (text) => got.push(text));
  queue.submit(JOB, (text) => got.push(text));

  gates[0].resolve("first");
  gates[1].resolve(undefined); // discarded as non-speech
  await settle();

  assert.deepEqual(got, ["first", undefined]);
});

test("a discarded result still frees its slot", async () => {
  // `undefined` means the model returned nothing believable. That is a
  // non-result, not a stuck job — it must not leak a slot.
  const { queue, gates } = makeQueue({ maxPending: 1 });
  queue.submit(JOB, () => undefined);
  gates[0].resolve(undefined);
  await settle();

  assert.equal(queue.pending, 0);
  assert.equal(
    queue.submit(JOB, () => undefined),
    true,
  );
});

test("a failed utterance frees its slot and does not stop the rest", async () => {
  // Otherwise one bad job permanently shrinks the queue, and enough of them
  // wedge it shut for the remainder of the call.
  const { queue, gates, errors } = makeQueue({ maxPending: 2 });
  const got: Array<string | undefined> = [];
  queue.submit(JOB, (text) => got.push(text));
  queue.submit(JOB, (text) => got.push(text));

  gates[0].reject(new Error("model exploded"));
  gates[1].resolve("still works");
  await settle();

  assert.equal(queue.pending, 0);
  assert.deepEqual(got, ["still works"]);
  assert.equal(errors.length, 1);
  assert.equal(
    queue.submit(JOB, () => undefined),
    true,
  );
});

test("drain resolves once the backlog clears", async () => {
  const { queue, gates } = makeQueue({ drainTimeoutMs: 5000 });
  queue.submit(JOB, () => undefined);
  queue.submit(JOB, () => undefined);

  const drained = queue.drain();
  gates[0].resolve("a");
  gates[1].resolve("b");
  await drained;

  assert.equal(queue.pending, 0);
});

test("drain gives up at the deadline rather than hanging forever", async () => {
  // The reported symptom: stop waited on a backlog that never cleared, so the
  // button looked dead. Capture has already ended by this point — only text is
  // outstanding — so giving up is the right trade.
  const { queue, errors } = makeQueue({ drainTimeoutMs: 60 });
  queue.submit(JOB, () => undefined); // never resolved

  const startedAt = Date.now();
  await queue.drain(); // must not hang

  assert.ok(
    Date.now() - startedAt < 2000,
    "drain must return promptly on timeout",
  );
  assert.deepEqual(errors, [UNFINISHED_MESSAGE]);
  assert.equal(queue.pending, 1, "the job is still outstanding, and says so");
});

test("drain on an empty queue is immediate and quiet", async () => {
  const { queue, errors } = makeQueue({ drainTimeoutMs: 5000 });
  const startedAt = Date.now();
  await queue.drain();

  assert.ok(Date.now() - startedAt < 100);
  assert.deepEqual(errors, []);
});
