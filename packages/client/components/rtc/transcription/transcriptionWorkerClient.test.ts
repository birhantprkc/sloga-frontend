import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { WorkerTranscriptionEngine } from "./transcriptionWorkerClient.ts";
import type {
  TranscriptionWorkerRequest,
  TranscriptionWorkerResponse,
} from "./transcriptionWorkerProtocol.ts";

/**
 * A worker the specs control by hand. Casting to Worker is honest here: the
 * proxy only ever touches onmessage/onerror/onmessageerror/postMessage/
 * terminate, all of which this implements.
 */
class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;

  posted: TranscriptionWorkerRequest[] = [];
  transfers: (Transferable[] | undefined)[] = [];
  terminated = false;

  postMessage(message: unknown, options?: StructuredSerializeOptions): void {
    this.posted.push(message as TranscriptionWorkerRequest);
    this.transfers.push(options?.transfer);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(message: TranscriptionWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent);
  }

  crash(): void {
    this.onerror?.({} as ErrorEvent);
  }

  asWorker(): Worker {
    return this as unknown as Worker;
  }
}

function makeEngine(): {
  engine: WorkerTranscriptionEngine;
  spawned: FakeWorker[];
} {
  const spawned: FakeWorker[] = [];
  const engine = new WorkerTranscriptionEngine("whisper-tiny", () => {
    const worker = new FakeWorker();
    spawned.push(worker);
    return worker.asWorker();
  });
  return { engine, spawned };
}

/** Let promise reactions queued by the code under test run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("WorkerTranscriptionEngine", () => {
  it("loads: spawns one worker, posts the model, resolves on load-done", async () => {
    const { engine, spawned } = makeEngine();

    const loaded = engine.load();
    assert.equal(spawned.length, 1);
    assert.deepEqual(spawned[0].posted, [
      { type: "load", model: "whisper-tiny" },
    ]);

    spawned[0].emit({ type: "load-done" });
    await loaded;
  });

  it("shares one load across concurrent callers", async () => {
    const { engine, spawned } = makeEngine();

    const first = engine.load();
    const second = engine.load();
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].posted.length, 1);

    spawned[0].emit({ type: "load-done" });
    await Promise.all([first, second]);
  });

  it("forwards load progress", async () => {
    const { engine, spawned } = makeEngine();

    const fractions: number[] = [];
    const loaded = engine.load((fraction) => fractions.push(fraction));
    spawned[0].emit({ type: "load-progress", fraction: 0.25 });
    spawned[0].emit({ type: "load-progress", fraction: 0.75 });
    spawned[0].emit({ type: "load-done" });
    await loaded;

    assert.deepEqual(fractions, [0.25, 0.75]);
  });

  it("does not cache a failed load: retry gets a fresh worker", async () => {
    const { engine, spawned } = makeEngine();

    const first = engine.load();
    spawned[0].emit({ type: "load-error", message: "no model" });
    await assert.rejects(first, /no model/);
    await settle();
    assert.equal(spawned[0].terminated, true);

    const second = engine.load();
    assert.equal(spawned.length, 2);
    spawned[1].emit({ type: "load-done" });
    await second;
  });

  it("transcribes: transfers the PCM buffer and matches replies by id", async () => {
    const { engine, spawned } = makeEngine();
    const loaded = engine.load();
    spawned[0].emit({ type: "load-done" });
    await loaded;

    const first = engine.transcribe({ pcm: new Float32Array(16) });
    const second = engine.transcribe({ pcm: new Float32Array(16) });

    const [, firstReq, secondReq] = spawned[0].posted;
    assert.equal(firstReq.type, "transcribe");
    assert.equal(secondReq.type, "transcribe");
    if (firstReq.type !== "transcribe" || secondReq.type !== "transcribe") {
      return; // narrowing for the type-checker; the asserts above already ran
    }
    assert.notEqual(firstReq.id, secondReq.id);
    // The buffer must ride the transfer list — a structured-clone copy would
    // silently double the audio memory.
    assert.deepEqual(spawned[0].transfers[1], [firstReq.pcm.buffer]);

    // Answers arrive out of order; each must land on its own promise.
    spawned[0].emit({
      type: "transcribe-done",
      id: secondReq.id,
      text: "second",
    });
    spawned[0].emit({
      type: "transcribe-done",
      id: firstReq.id,
      text: "first",
    });

    assert.equal(await first, "first");
    assert.equal(await second, "second");
  });

  it("rejects only the failing job", async () => {
    const { engine, spawned } = makeEngine();
    const loaded = engine.load();
    spawned[0].emit({ type: "load-done" });
    await loaded;

    const bad = engine.transcribe({ pcm: new Float32Array(16) });
    const good = engine.transcribe({ pcm: new Float32Array(16) });
    const requests = spawned[0].posted.filter(
      (message) => message.type === "transcribe",
    );

    spawned[0].emit({
      type: "transcribe-error",
      id: (requests[0] as { id: number }).id,
      message: "utterance exploded",
    });
    spawned[0].emit({
      type: "transcribe-done",
      id: (requests[1] as { id: number }).id,
      text: "survived",
    });

    await assert.rejects(bad, /utterance exploded/);
    assert.equal(await good, "survived");
  });

  it("rejects transcribe before load", async () => {
    const { engine } = makeEngine();
    await assert.rejects(
      engine.transcribe({ pcm: new Float32Array(16) }),
      /not loaded/,
    );
  });

  it("a worker crash fails everything outstanding and allows a fresh start", async () => {
    const { engine, spawned } = makeEngine();
    const loaded = engine.load();
    spawned[0].emit({ type: "load-done" });
    await loaded;

    const inFlight = engine.transcribe({ pcm: new Float32Array(16) });
    spawned[0].crash();

    await assert.rejects(inFlight, /crashed/);
    assert.equal(spawned[0].terminated, true);
    // The crash must also invalidate the memoised load, or every later
    // transcribe hits a dead worker forever.
    await assert.rejects(
      engine.transcribe({ pcm: new Float32Array(16) }),
      /not loaded/,
    );

    const reloaded = engine.load();
    assert.equal(spawned.length, 2);
    spawned[1].emit({ type: "load-done" });
    await reloaded;
  });

  it("dispose terminates the worker and rejects outstanding jobs", async () => {
    const { engine, spawned } = makeEngine();
    const loaded = engine.load();
    spawned[0].emit({ type: "load-done" });
    await loaded;

    const inFlight = engine.transcribe({ pcm: new Float32Array(16) });
    engine.dispose();

    await assert.rejects(inFlight, /shut down/);
    assert.equal(spawned[0].terminated, true);
  });
});
