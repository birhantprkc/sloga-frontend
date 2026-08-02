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
 * ## Everything is same-origin, deliberately
 *
 * transformers.js fetches models from huggingface.co by default, and
 * onnxruntime-web separately fetches its own `.wasm` runtime from a jsDelivr
 * CDN. Both are third-party requests made while a private call is in progress,
 * and the second one is also blocked outright by the desktop shell's CSP (see
 * `voiceAudioPipeline.ts`). Both are pointed at our own origin below, and a
 * transcription session should make no cross-origin request at all — that is a
 * verifiable property, and it is meant to be verified.
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

import { cleanTranscript } from "./transcriptText.ts";

/**
 * ## The version pin is load-bearing — do not casually bump it
 *
 * Verified working end to end in Chrome 2026-07-31: model fetched from our own
 * origin, session created, live speech transcribed and attributed, on
 * `@huggingface/transformers` 3.8.1 with onnxruntime-web 1.22.
 *
 * **4.x does not work here.** With 4.2.0 (onnxruntime-web 1.26.0-dev) session
 * creation dies in an ORT graph-optimisation pass — `qdq_actions.cc:137
 * TransposeDQWeightsForMatMulNBits Missing required scale`. That was
 * reproduced across q8, int8, uint8 AND unquantised fp32 weights, and with the
 * optimiser disabled, basic, and on the WebGPU provider: nine combinations,
 * one identical error. The same files load fine under onnxruntime-node, so it
 * is the web runtime rather than the model.
 *
 * **Two traps cost hours here, and will again.**
 *
 * 1. Vite pre-bundles dependencies. After changing the transformers version,
 *    the page keeps being served the OLD pre-bundle until vite re-optimises on
 *    the next server start — so 3.8.1 appeared to fail with a spurious `both
 *    async and sync fetching of the wasm failed` while the page was in fact
 *    still running 4.2.0. **Restart the dev server after touching this
 *    dependency, and confirm "Re-optimizing dependencies" in its output.**
 * 2. The vendored ORT runtime under {@link ORT_WASM_BASE} must come from the
 *    EXACT version resolved here. The pnpm store keeps old copies, so a bare
 *    `find` for an onnxruntime-web dist happily returns the wrong one.
 */

/** Where the vendored model and the ONNX runtime are served from, same-origin. */
const MODEL_BASE = "/models/";
const ORT_WASM_BASE = "/models/ort/";

/**
 * `tiny` is the shipped default.
 *
 * `base` is roughly twice the download and noticeably slower per utterance for
 * an accuracy gain that does not change whether a transcript is usable. Kept
 * here as a named option so switching is a one-line change once there is real
 * feedback, rather than a rewrite.
 */
export type WhisperModel = "whisper-tiny" | "whisper-base";
export const DEFAULT_MODEL: WhisperModel = "whisper-tiny";

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
  // nothing behind `/models/`, so without the flag the button would appear
  // there and fail on press.
  if (!CONFIGURATION.ENABLE_CALL_TRANSCRIPTION) return false;

  return (
    typeof WebAssembly === "object" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    typeof Worker !== "undefined"
  );
}

type Pipeline = (
  audio: Float32Array,
  options: Record<string, unknown>,
) => Promise<{ text: string }>;

class WhisperEngine implements TranscriptionEngine {
  #model: WhisperModel;
  #pipeline: Pipeline | undefined;
  #loading: Promise<void> | undefined;
  /** Serialises inference: one model instance cannot run two jobs at once. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(model: WhisperModel = DEFAULT_MODEL) {
    this.#model = model;
  }

  load(onProgress?: (fraction: number) => void): Promise<void> {
    // Concurrent callers share one load rather than racing two downloads.
    this.#loading ??= this.#load(onProgress).catch((error) => {
      // A failed load must not be cached, or the feature is dead until reload.
      this.#loading = undefined;
      throw error;
    });
    return this.#loading;
  }

  async #load(onProgress?: (fraction: number) => void): Promise<void> {
    // Dynamic import: this pulls in the runtime and must never land in the
    // initial bundle, which every user pays for and almost none will use.
    const { env, pipeline } = await import("@huggingface/transformers");

    // Same-origin, both of them. See the header.
    env.allowRemoteModels = false;
    env.allowLocalModels = true;
    env.localModelPath = MODEL_BASE;
    if (env.backends?.onnx?.wasm) {
      env.backends.onnx.wasm.wasmPaths = ORT_WASM_BASE;
      // No cross-origin isolation here (COOP/COEP would break cross-origin
      // media), so SharedArrayBuffer is unavailable and threads cannot be
      // used. Say so explicitly rather than relying on a silent fallback.
      env.backends.onnx.wasm.numThreads = 1;
    }

    const total = { bytes: 0, loaded: 0 };
    this.#pipeline = (await pipeline(
      "automatic-speech-recognition",
      this.#model,
      {
        dtype: { encoder_model: "q8", decoder_model_merged: "q8" },
        progress_callback: onProgress
          ? (report: { status: string; loaded?: number; total?: number }) => {
              if (report.status !== "progress") return;
              total.loaded = report.loaded ?? 0;
              total.bytes = report.total ?? 0;
              if (total.bytes > 0) onProgress(total.loaded / total.bytes);
            }
          : undefined,
      },
    )) as unknown as Pipeline;
  }

  transcribe(job: TranscriptionJob): Promise<string | undefined> {
    const run = this.#queue.then(() => this.#transcribe(job));
    // Keep the chain alive through failures: one bad utterance must not stop
    // the rest of the call from being transcribed.
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #transcribe(job: TranscriptionJob): Promise<string | undefined> {
    const asr = this.#pipeline;
    if (!asr) throw new Error("The transcription model is not loaded.");

    const result = await asr(job.pcm, {
      task: "transcribe",
      // Undefined lets the model detect; a hint is faster and more accurate.
      language: job.language || undefined,
    });

    // The model never says "I heard nothing" — it invents a plausible short
    // phrase instead. `transcriptText.ts` explains why this check exists here
    // rather than as a confidence threshold.
    return cleanTranscript(result.text ?? "", job.spokenMs);
  }

  dispose(): void {
    this.#pipeline = undefined;
    this.#loading = undefined;
  }
}

let shared: WhisperEngine | undefined;

/** The process-wide engine. See the header for why it outlives a session. */
export function getTranscriptionEngine(
  model: WhisperModel = DEFAULT_MODEL,
): TranscriptionEngine {
  shared ??= new WhisperEngine(model);
  return shared;
}

/** Drop the shared engine, freeing the model. */
export function releaseTranscriptionEngine(): void {
  shared?.dispose();
  shared = undefined;
}
