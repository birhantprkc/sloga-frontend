/**
 * The message protocol between the transcription engine proxy and its worker.
 *
 * Lives in its own file so both sides — `transcriptionWorkerClient.ts` on the
 * main thread and `transcriptionWorker.ts` inside the worker — agree on one
 * definition, and so neither has to import the other to get it.
 */

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

/** Main thread → worker. */
export type TranscriptionWorkerRequest =
  | { type: "load"; model: WhisperModel }
  | {
      type: "transcribe";
      /** Correlates the eventual result: replies can arrive for any job. */
      id: number;
      /** 16 kHz mono. The backing buffer is TRANSFERRED, not copied. */
      pcm: Float32Array;
      /** Voiced milliseconds, used to sanity-check the result's length. */
      spokenMs?: number;
      /** ISO-639-1, or undefined to let the model decide. */
      language?: string;
    };

/** Worker → main thread. */
export type TranscriptionWorkerResponse =
  | { type: "load-progress"; fraction: number }
  | { type: "load-done" }
  | { type: "load-error"; message: string }
  | { type: "transcribe-done"; id: number; text: string | undefined }
  | { type: "transcribe-error"; id: number; message: string };
