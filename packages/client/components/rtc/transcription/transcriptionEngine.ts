/**
 * On-device speech-to-text for call transcription.
 *
 * **Why this cannot be a server, and cannot be the caption engines.** Media
 * E2EE for calls is mandatory, so the server holds no media keys and never has
 * the audio — a participant's own machine is the only thing that *can*
 * transcribe (the same reasoning that forces local-only call recording, see
 * `callRecorder.ts`). And the existing caption engines are no help: Web Speech
 * hears only the local microphone and ships that audio to Google, which is
 * exactly what must not happen to a call whose whole promise is that nobody
 * else can hear it. So: a model, running here, over audio that never leaves the
 * machine.
 *
 * ## The model lives in a worker, and that is not an optimisation
 *
 * Inference is single-threaded wasm whose decode steps block whatever thread
 * they run on. The first shipped version ran it in the page, and on any
 * machine slower than realtime that froze the whole app and eventually took
 * the webview down with it — reported from the field 2026-08-10, and invisible
 * to every dev-box test because dev boxes run whisper-tiny faster than
 * realtime. `transcriptionWorker.ts` hosts the model; this file only defines
 * the seam and hands out the shared proxy.
 *
 * ## One model, one queue, shared across the whole call
 *
 * Every participant's audio funnels through a single instance. Running one
 * model per speaker would multiply memory by the size of the call for no
 * benefit: people mostly take turns, and the segmenter only emits actual
 * speech. Overlapping talkers queue up and land a few seconds late, which a
 * transcript can absorb and live captions could not.
 *
 * The engine is a module-level singleton rather than per-session because
 * loading it means fetching and parsing tens of megabytes. `CallRecorder` is
 * built per recording because a `MediaRecorder` is free to construct; this is
 * not, and re-paying that on every toggle would put a long delay in front of
 * every start.
 */

import { CONFIGURATION } from "@revolt/common";

import TranscriptionWorker from "./transcriptionWorker.ts?worker";
import { WorkerTranscriptionEngine } from "./transcriptionWorkerClient.ts";
import {
  type WhisperModel,
  DEFAULT_MODEL,
} from "./transcriptionWorkerProtocol.ts";

export { DEFAULT_MODEL };
export type { WhisperModel };

export interface TranscriptionJob {
  /** 16 kHz mono, as produced by the segmenter. */
  pcm: Float32Array;
  /** Voiced milliseconds, used to sanity-check the result's length. */
  spokenMs?: number;
  /** ISO-639-1, or undefined to let the model decide. */
  language?: string;
}

export interface TranscriptionEngine {
  /** Fetch and warm the model. Safe to call repeatedly; work happens once. */
  load(onProgress?: (fraction: number) => void): Promise<void>;
  /** Transcribe one utterance, or resolve undefined if it held no speech. */
  transcribe(job: TranscriptionJob): Promise<string | undefined>;
  /** Release the model. The next `load()` starts over. */
  dispose(): void;
}

/**
 * Whether this shell can run inference at all.
 *
 * Deliberately a capability probe rather than a user-agent check, and
 * deliberately conservative — the lesson from `webSpeechSupported()`, which
 * only tested for a constructor that exists in shells where the API cannot
 * actually work, and so hid the "not supported" warning from precisely the
 * users who needed it. Being wrong in this direction produces a feature that
 * silently does nothing.
 */
export function transcriptionSupported(): boolean {
  // The build-time gate comes FIRST, and this is the single choke point the
  // button, the panel and the engine all pass through — see
  // `CONFIGURATION.ENABLE_CALL_TRANSCRIPTION` for why it defaults off. In
  // particular the desktop and Android shells serve a bundled dist with
  // nothing behind `/models/` unless their installers staged it, so without
  // the flag the button would appear there and fail on press.
  if (!CONFIGURATION.ENABLE_CALL_TRANSCRIPTION) return false;

  // Worker is load-bearing: it is where inference runs.
  return (
    typeof WebAssembly === "object" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

let shared: WorkerTranscriptionEngine | undefined;

/** The process-wide engine. See the header for why it outlives a session. */
export function getTranscriptionEngine(
  model: WhisperModel = DEFAULT_MODEL,
): TranscriptionEngine {
  shared ??= new WorkerTranscriptionEngine(
    model,
    () => new TranscriptionWorker({ name: "call-transcription" }),
  );
  return shared;
}

/** Drop the shared engine, freeing the model. */
export function releaseTranscriptionEngine(): void {
  shared?.dispose();
  shared = undefined;
}
