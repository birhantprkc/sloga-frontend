// Text emoticons the composer expands into emoji. Everything that decides
// whether an expansion happens lives here, deliberately clear of the editor
// view and of Solid, so a spec can drive it against a real document: only the
// dispatching and the settings lookup are left to codeMirrorEmoticons.
//
// Every emoji here is a value in emojiMapping.json, which is what the emoji
// picker and the `:shortcode:` autocomplete insert — the spec asserts it. That
// matters beyond tidiness: the renderer draws emoji through a per-pack CDN
// asset named after the codepoint, so "❤" (U+2764) resolves and the
// variation-selector form "❤️" (U+2764 U+FE0F) does not.
//
// Case is deliberate. ":D" and "=D" are the smiley; a lowercase ":d" is not,
// it's the start of a shortcode. ":P"/":p" and ":O"/":o" both read as faces,
// so both are listed.
import type { EditorState } from "@codemirror/state";

export const EMOTICONS: Record<string, string> = {
  ":)": "🙂",
  ":-)": "🙂",
  "=)": "🙂",
  ":(": "🙁",
  ":-(": "🙁",
  "=(": "🙁",
  ":D": "😄",
  ":-D": "😄",
  "=D": "😄",
  ":P": "😛",
  ":p": "😛",
  ":-P": "😛",
  ":-p": "😛",
  "=P": "😛",
  ";)": "😉",
  ";-)": "😉",
  ";P": "😜",
  ";p": "😜",
  ";-P": "😜",
  ";-p": "😜",
  ":O": "😮",
  ":o": "😮",
  ":-O": "😮",
  ":-o": "😮",
  ":/": "😕",
  ":-/": "😕",
  ":\\": "😕",
  ":-\\": "😕",
  ":|": "😐",
  ":-|": "😐",
  ":*": "😗",
  ":-*": "😗",
  ":'(": "😢",
  ":'-(": "😢",
  ">:(": "😠",
  ">:-(": "😠",
  ":3": "😺",
  "<3": "❤",
  "</3": "💔",
};

// Longest first so ">:(" wins over the ":(" inside it, and "</3" over "<3".
const BY_LENGTH = Object.keys(EMOTICONS).sort((a, b) => b.length - a.length);

export interface EmoticonMatch {
  /** The emoticon as typed */
  emoticon: string;
  /** Emoji to put in its place */
  emoji: string;
  /** Offset of the emoticon within the text that was searched */
  from: number;
}

/**
 * Find an emoticon that the given text ends with.
 * @param before Text ending where the cursor sits
 * @returns The match, or null when the text does not end in one
 */
export function emoticonEnding(before: string): EmoticonMatch | null {
  for (const emoticon of BY_LENGTH) {
    if (!before.endsWith(emoticon)) continue;

    const from = before.length - emoticon.length;

    // Only a standalone token expands. This is what keeps "10:30", "C:/src",
    // "http://host" and "*:D*" alone: something other than whitespace sits in
    // front of them, so they were never an emoticon to begin with.
    if (from > 0 && !/\s/.test(before[from - 1])) continue;

    return { emoticon, emoji: EMOTICONS[emoticon], from };
  }

  return null;
}

/**
 * Work out the change that expands an emoticon sitting just before `from`.
 *
 * The code-block test is passed in rather than imported so this stays free of
 * the editor's language layer, and so the spec drives the same one the
 * composer does.
 * @param options Editor state as it stands before the caller's own change,
 * the range the caller is about to replace, the text to keep after the emoji
 * (the space that triggered it, or nothing when a draft is being sent), the
 * marker naming the sender's emoji pack, and the code-block test
 * @returns Change and resulting cursor, or null when nothing should expand
 */
export function emoticonExpansionAt(options: {
  state: EditorState;
  from: number;
  to: number;
  trailing: string;
  packPrefix?: string;
  isInCode: (state: EditorState, from: number, to: number) => boolean;
}) {
  const { state, from, to, trailing, packPrefix = "", isInCode } = options;

  const line = state.doc.lineAt(from);
  const match = emoticonEnding(line.text.slice(0, from - line.from));
  if (!match) return null;

  const start = line.from + match.from;

  // Code is quoted text — ":D" in a snippet is the snippet's, not a smiley.
  if (isInCode(state, start, from)) return null;

  const insert = packPrefix + match.emoji + trailing;

  return {
    changes: { from: start, to, insert },
    selection: { anchor: start + insert.length },
  };
}

/**
 * Expand an emoticon a draft ends on, on its way out.
 *
 * The editor expands as soon as the space after an emoticon is typed, which
 * leaves exactly one case open: the last thing typed before sending, which
 * never gets that space. Every surface that sends — Enter, the send button,
 * a phone tap — goes through the draft, so this works on the text rather than
 * the editor, and reads code by counting delimiters instead of parsing.
 * @param content Draft as typed
 * @param packPrefix Marker naming the sender's emoji pack
 * @returns Content with the trailing emoticon expanded, if there was one
 */
export function expandTrailingEmoticon(content: string, packPrefix = "") {
  const match = emoticonEnding(content);
  if (!match) return content;

  const before = content.slice(0, match.from);

  // An unclosed fence, or an unclosed span on the line: the emoticon is inside
  // code the sender is still writing. A closed one leaves an even count, so
  // "say `x` :D" expands and "say `x :D" does not.
  if ((before.match(/^```/gm)?.length ?? 0) % 2 === 1) return content;
  if (((before.split("\n").pop() ?? "").match(/`/g)?.length ?? 0) % 2 === 1) {
    return content;
  }

  return before + packPrefix + match.emoji;
}
