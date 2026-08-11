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
 * nothing to threshold on, and the defence has to be three cruder layers:
 *
 * 1. **Energy gating before the model** — `vadSegmenter.ts` is the real guard,
 *    and it is why silence normally never reaches inference at all.
 * 2. **This module's denylist, after the model** — a backstop for the narrow
 *    case where a segment clears the energy gates but still contains no speech
 *    (a slammed door, a chair, a burst of line noise).
 * 3. **A speaking-rate ceiling, also here** — the denylist can only name
 *    artefacts already seen, and a 2026-08-10 field report showed novel ones
 *    ("I'm very fine.", "Oh, no.") attributed to a user in a SOLO call. Text
 *    that packs more syllables than a human can produce in the measured voiced
 *    duration cannot be a transcription of that audio, whatever the words are.
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
 * The fastest a voice is allowed to have spoken, in syllables per voiced
 * second, before the output is judged impossible for its audio.
 *
 * Sustained fast conversation runs ~6-7 syllables/s and short bursts ~8-9;
 * `spokenMs` counts only VOICED frames, which shaves the gaps between words
 * and inflates the apparent rate by maybe another fifth. Ten is above all of
 * that — a real speaker should never trip it — while the field cases this
 * exists for sit far beyond it ("I'm very fine.", 4 syllables, from a segment
 * as short as 340 ms, is ~12/s).
 */
const MAX_SYLLABLES_PER_SECOND = 10;

/**
 * Syllables any output may carry regardless of duration. A quick real
 * interjection — "oh no", "okay" — fits in under half a second, and a
 * hallucinated one of the same shape is acoustically indistinguishable from
 * it, so length gives this layer nothing to work with down there. Catching
 * those stays the denylist's job.
 */
const FREE_SYLLABLES = 2;

/**
 * Rough syllable count for Latin-script text: vowel groups per word, minus
 * the classic silent trailing "e" ("make", "fine" — but not "-le", "little").
 *
 * Deliberately crude, and errs toward UNDER-counting on accented Latin text
 * (é, ü and friends are not in the class), which only ever makes the gate
 * more permissive. Non-Latin scripts (CJK, Cyrillic, Arabic…) contain no
 * ASCII vowels at all and estimate to ZERO — the gate abstains entirely
 * rather than guess at languages it cannot measure.
 */
function estimateSyllables(normalised: string): number {
  let count = 0;
  for (const word of normalised.split(" ")) {
    const groups = word.match(/[aeiouy]+/g)?.length ?? 0;
    count +=
      groups > 1 && word.endsWith("e") && !word.endsWith("le")
        ? groups - 1
        : groups;
  }
  return count;
}

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

  // Text that outruns the audio. A sentence needs time to be said, and the
  // segmenter measured exactly how much voiced time there was — output whose
  // syllable count could not fit into that window is invention, not
  // transcription, no matter how fluent it reads. This is what catches the
  // novel phrases the denylist has never seen; what it deliberately cannot
  // catch is a hallucination short enough to be sayable in the time
  // available, because from here that is indistinguishable from someone
  // actually saying it.
  if (spokenMs !== undefined) {
    const syllables = estimateSyllables(normalised);
    if (
      syllables > FREE_SYLLABLES &&
      syllables > (spokenMs / 1000) * MAX_SYLLABLES_PER_SECOND
    ) {
      return true;
    }
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
