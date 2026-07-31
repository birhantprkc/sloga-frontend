/**
 * Turning a finished transcript into a file someone can keep.
 *
 * Two formats, both plain text, both openable everywhere:
 *
 * - **WebVTT** — timestamped and speaker-tagged, so it loads as subtitles
 *   alongside the call recording (the two are captured from the same audio and
 *   share a filename stem, so they line up).
 * - **Plain text** — what people actually paste into notes and tickets.
 *
 * `.docx` is deliberately absent: it would pull in a document library to
 * produce formatting nobody asked for, and a `.txt` opens on every machine
 * that will ever receive one of these.
 *
 * Everything here is a pure function of the segments, so the exporter can be
 * tested without a call, a model, or a file handle.
 */

// Explicit `.ts` — this module is loaded directly by `node --test`, whose ESM
// resolver does not guess extensions. See the same note in `callRecorder.ts`.
import { captureFilename } from "../captureFilename.ts";

export interface TranscriptSegment {
  /** Stable id, so the panel can key rows without reindexing. */
  id: string;
  /** Who said it — a LiveKit identity, resolved to a name at export time. */
  identity: string;
  /** Milliseconds from the start of transcription. */
  startMs: number;
  endMs: number;
  text: string;
}

/** identity → display name. A missing entry falls back to the identity. */
export type SpeakerNames = ReadonlyMap<string, string> | Record<string, string>;

function nameFor(names: SpeakerNames | undefined, identity: string): string {
  if (!names) return identity;
  const found =
    names instanceof Map
      ? names.get(identity)
      : (names as Record<string, string>)[identity];
  return found?.trim() || identity;
}

/** `HH:MM:SS.mmm`, VTT's only accepted cue timing. */
function vttTime(ms: number): string {
  const clamped = Math.max(0, Math.round(ms));
  const hours = Math.floor(clamped / 3_600_000);
  const minutes = Math.floor((clamped % 3_600_000) / 60_000);
  const seconds = Math.floor((clamped % 60_000) / 1000);
  const millis = clamped % 1000;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(millis, 3)}`;
}

/** `M:SS` (or `H:MM:SS`), for humans reading prose. */
function clockTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

/**
 * A speaker name safe to put in a `<v …>` tag.
 *
 * VTT parses cue payloads as markup, so a display name containing `<` or `>`
 * would silently swallow the line that follows it. Newlines are worse: they end
 * the cue outright and the rest of the utterance becomes a malformed cue of its
 * own.
 */
function vttName(name: string): string {
  return name.replace(/[<>\r\n]+/g, " ").trim() || "Speaker";
}

/** Cue text may not contain a blank line — that terminates the cue. */
function vttText(text: string): string {
  return text
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/**
 * WebVTT, one cue per utterance.
 *
 * Cues are emitted in the order given; a caller holding segments in arrival
 * order should sort by `startMs` first, because a slow inference queue can
 * finish a later utterance before an earlier one.
 */
export function toVtt(
  segments: readonly TranscriptSegment[],
  names?: SpeakerNames,
): string {
  const lines = ["WEBVTT", ""];

  segments.forEach((segment, index) => {
    const text = vttText(segment.text);
    if (!text) return;
    // A zero-length cue is skipped by some players; give it a readable floor.
    const end = Math.max(segment.endMs, segment.startMs + 200);
    lines.push(String(index + 1));
    lines.push(`${vttTime(segment.startMs)} --> ${vttTime(end)}`);
    lines.push(`<v ${vttName(nameFor(names, segment.identity))}>${text}`);
    lines.push("");
  });

  return lines.join("\n");
}

/**
 * Plain text, with a header naming the call and when it happened — a transcript
 * that has left the app has no other way to say what it is.
 */
export function toTxt(
  segments: readonly TranscriptSegment[],
  names: SpeakerNames | undefined,
  meta: { channelName?: string; startedAt: number },
): string {
  const started = new Date(meta.startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())}` +
    ` ${pad(started.getHours())}:${pad(started.getMinutes())}`;

  const lines = [`Transcript — ${meta.channelName ?? "call"}`, stamp, ""];

  for (const segment of segments) {
    const text = segment.text.trim();
    if (!text) continue;
    lines.push(
      `[${clockTime(segment.startMs)}] ${nameFor(names, segment.identity)}: ${text}`,
    );
  }

  if (lines.length === 3) lines.push("(no speech was transcribed)");

  return lines.join("\n") + "\n";
}

export type TranscriptFormat = "vtt" | "txt";

/** Shares the recording's naming, so the pair lands together in a folder. */
export function transcriptFilename(
  channelName: string | undefined,
  startedAt: number,
  format: TranscriptFormat,
): string {
  return captureFilename(channelName, startedAt, format);
}
