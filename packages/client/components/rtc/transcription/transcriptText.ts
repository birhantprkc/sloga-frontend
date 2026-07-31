/**
 * Deciding whether the speech model actually heard anything.
 *
 * Whisper does not answer "I heard nothing". Handed silence or faint noise it
 * returns a short, confident, grammatical phrase learned from the subtitle
 * corpora it was trained on — measured in this project against
 * `onnx-community/whisper-tiny`, three seconds of digital silence and two
 * seconds of -54 dB noise BOTH transcribe as `" you"`.
 *
 * **The principled fix is unavailable here.** Whisper computes a
 * `no_speech_prob` per segment, but the transformers.js pipeline surfaces only
 * `{ text }` (and `chunks` with timestamps when asked) — no probabilities, no
 * average log-probability, no scores. Verified against v4.2.0. So there is
 * nothing to threshold on, and the defence has to be two cruder layers:
 *
 * 1. **Energy gating before the model** — `vadSegmenter.ts` is the real guard,
 *    and it is why silence normally never reaches inference at all.
 * 2. **This module, after the model** — a backstop for the narrow case where a
 *    segment clears the energy gates but still contains no speech (a slammed
 *    door, a chair, a burst of line noise).
 *
 * **The trade-off is deliberate and asymmetric.** Rejecting a genuine one-word
 * "You?" costs a line of transcript. Accepting a hallucination puts words in a
 * named person's mouth, in a file that leaves the app and that someone may rely
 * on. The second is far worse, so anything that looks like the known artefacts
 * is dropped.
 */

/**
 * What Whisper says when it has nothing to say.
 *
 * Compared after normalisation (lowercased, surrounding punctuation and
 * whitespace removed), and only ever against the WHOLE output — "you" as one
 * word of a real sentence is untouched.
 */
const SILENCE_ARTEFACTS = new Set([
  "",
  "you",
  "the",
  "so",
  "and",
  "bye",
  "bye bye",
  "thank you",
  "thank you very much",
  "thanks for watching",
  "thanks for watching!",
  "please subscribe",
  "subscribe to my channel",
  "music",
  "applause",
  "silence",
  "blank audio",
  "outro",
  "end of transcript",
]);

/** Bracketed sound events Whisper emits for non-speech: [MUSIC], (applause). */
const SOUND_EVENT = /^[[(*][^\])*]*[\])*]$/;

/**
 * Strip Whisper's leading space and any surrounding punctuation, for comparison
 * only — the text kept in the transcript kept its original punctuation.
 */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether this output should be treated as "nothing was said".
 *
 * `spokenMs` is the voiced duration the segmenter measured. It matters because
 * length disagreement is itself a signal: two seconds of audio that transcribe
 * to a single short word is far more likely to be an artefact than a sentence.
 */
export function isLikelyHallucination(
  text: string,
  spokenMs?: number,
): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  if (SOUND_EVENT.test(trimmed)) return true;

  const normalised = normalise(trimmed);
  if (!normalised) return true;
  if (SILENCE_ARTEFACTS.has(normalised)) return true;

  // A single very short word standing alone is the shape every known artefact
  // takes. Require some real speech behind it before believing it.
  if (
    spokenMs !== undefined &&
    !normalised.includes(" ") &&
    normalised.length <= 3
  ) {
    return spokenMs < 700;
  }

  return false;
}

/**
 * The text to store, or undefined if this output should be discarded.
 *
 * Whisper prefixes a space and can repeat a phrase many times when it loses the
 * thread on a long segment; both are cleaned here so the transcript and its
 * exports never carry them.
 */
export function cleanTranscript(
  text: string,
  spokenMs?: number,
): string | undefined {
  const collapsed = collapseRepeats(text.replace(/\s+/g, " ").trim());
  if (isLikelyHallucination(collapsed, spokenMs)) return undefined;
  return collapsed;
}

/**
 * Collapse a phrase repeated back-to-back down to one.
 *
 * This is Whisper's other well-known failure on degraded audio: it latches onto
 * a phrase and emits it until the segment runs out. One "okay okay okay" is a
 * person; twelve is the model stuck in a loop.
 */
function collapseRepeats(text: string): string {
  const words = text.split(" ");
  if (words.length < 6) return text;

  for (let size = 1; size <= 5; size++) {
    if (words.length < size * 3) break;
    const phrase = words.slice(0, size).join(" ").toLowerCase();
    let repeats = 1;
    while (
      words
        .slice(repeats * size, (repeats + 1) * size)
        .join(" ")
        .toLowerCase() === phrase &&
      phrase
    ) {
      repeats++;
    }
    // Three or more identical runs covering the whole output is a loop.
    if (repeats >= 3 && repeats * size === words.length) {
      return words.slice(0, size).join(" ");
    }
  }

  return text;
}
