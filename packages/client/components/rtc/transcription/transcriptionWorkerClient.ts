/**
 * The main-thread half of the transcription engine: a thin proxy that hands
 * jobs to `transcriptionWorker.ts` and matches replies back to promises.
 *
 * Extracted from `transcriptionEngine.ts` so this logic can be tested without
 * a real Worker or a model — the same reason `TranscriptionQueue` is its own
 * file. The worker constructor is injected because `?worker` imports only
 * exist under vite, and the specs run under `node --test`.
 *
 * Failure model, deliberately blunt: any worker failure — a load that dies, a
 * crash mid-call — tears the whole worker down, rejects everything
 * outstanding, and leaves the proxy ready to build a fresh worker on the next
 * `load()`. Inference state is not worth repairing; the model reloads in
 * seconds and a half-alive worker is impossible to reason about. This is also
 * the payoff of the design: a wasm OOM now kills a worker we can replace, not
 * the webview the whole app lives in.
 */

import type {
  TranscriptionEngine,
  TranscriptionJob,
} from "./transcriptionEngine.ts";
import type {
  TranscriptionWorkerRequest,
  TranscriptionWorkerResponse,
  WhisperModel,
} from "./transcriptionWorkerProtocol.ts";

interface PendingJob {
  resolve(text: string | undefined): void;
  reject(error: Error): void;
}

export class WorkerTranscriptionEngine implements TranscriptionEngine {
  #model: WhisperModel;
  #createWorker: () => Worker;

  #worker: Worker | undefined;
  #loading: Promise<void> | undefined;
  #loadSettle: { resolve(): void; reject(error: Error): void } | undefined;
  #onProgress: ((fraction: number) => void) | undefined;

  #nextJob = 0;
  #jobs = new Map<number, PendingJob>();

  constructor(model: WhisperModel, createWorker: () => Worker) {
    this.#model = model;
    this.#createWorker = createWorker;
  }

  load(onProgress?: (fraction: number) => void): Promise<void> {
    // Concurrent callers share one load rather than racing two workers. A
    // failed load must not be cached, or the feature is dead until reload —
    // #fail clears the memo, so the next load() starts a fresh worker.
    this.#loading ??= this.#load(onProgress).catch((error) => {
      // By the time a load rejection reaches here its settle handle has
      // already been consumed, so this is cleanup, not a double-settle.
      this.#fail(error instanceof Error ? error : new Error(String(error)));
      throw error;
    });
    return this.#loading;
  }

  async #load(onProgress?: (fraction: number) => void): Promise<void> {
    const worker = this.#createWorker();
    this.#worker = worker;
    this.#onProgress = onProgress;

    worker.onmessage = (event: MessageEvent) =>
      this.#handleMessage(event.data as TranscriptionWorkerResponse);
    // A dead worker cannot answer anything, so everything outstanding fails
    // now rather than hanging until the drain deadline.
    worker.onerror = () =>
      this.#fail(new Error("The transcription worker crashed."));
    worker.onmessageerror = () =>
      this.#fail(new Error("The transcription worker sent a broken message."));

    await new Promise<void>((resolve, reject) => {
      this.#loadSettle = { resolve, reject };
      this.#post(worker, { type: "load", model: this.#model });
    });
  }

  transcribe(job: TranscriptionJob): Promise<string | undefined> {
    const worker = this.#worker;
    if (!worker) {
      return Promise.reject(
        new Error("The transcription model is not loaded."),
      );
    }

    const id = this.#nextJob++;
    return new Promise((resolve, reject) => {
      this.#jobs.set(id, { resolve, reject });
      // The PCM buffer is TRANSFERRED, not copied — the segmenter allocates a
      // fresh array per segment and nothing on this side reads it after
      // submit, so the copy would be pure cost.
      this.#post(
        worker,
        {
          type: "transcribe",
          id,
          pcm: job.pcm,
          spokenMs: job.spokenMs,
          language: job.language,
        },
        [job.pcm.buffer as ArrayBuffer],
      );
    });
  }

  dispose(): void {
    // terminate() is what actually frees the model: wasm memory can never
    // shrink, so the in-page engine this replaced held its peak forever.
    this.#fail(new Error("Transcription was shut down."));
  }

  #post(
    worker: Worker,
    message: TranscriptionWorkerRequest,
    transfer?: Transferable[],
  ): void {
    worker.postMessage(message, { transfer });
  }

  #handleMessage(message: TranscriptionWorkerResponse): void {
    switch (message.type) {
      case "load-progress":
        this.#onProgress?.(message.fraction);
        break;

      case "load-done": {
        const settle = this.#loadSettle;
        this.#loadSettle = undefined;
        settle?.resolve();
        break;
      }

      case "load-error": {
        const settle = this.#loadSettle;
        this.#loadSettle = undefined;
        settle?.reject(new Error(message.message));
        break;
      }

      case "transcribe-done": {
        const job = this.#jobs.get(message.id);
        this.#jobs.delete(message.id);
        job?.resolve(message.text);
        break;
      }

      case "transcribe-error": {
        const job = this.#jobs.get(message.id);
        this.#jobs.delete(message.id);
        job?.reject(new Error(message.message));
        break;
      }
    }
  }

  /**
   * Tear everything down and reject everything outstanding. Idempotent, and
   * leaves the proxy ready for a fresh `load()`.
   */
  #fail(error: Error): void {
    const settle = this.#loadSettle;
    const jobs = [...this.#jobs.values()];
    this.#loadSettle = undefined;
    this.#jobs.clear();
    this.#worker?.terminate();
    this.#worker = undefined;
    this.#loading = undefined;
    this.#onProgress = undefined;

    settle?.reject(error);
    for (const job of jobs) job.reject(error);
  }
}
