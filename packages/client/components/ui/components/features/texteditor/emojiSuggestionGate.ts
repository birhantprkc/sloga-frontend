// When the emoji autocomplete is allowed to open, kept apart from
// codeMirrorAutoCompleteSource so it can be unit-tested: the source itself is
// built inside Solid context (client + settings) and can't be imported alone.

/**
 * Emoji suggestions hold back until two characters follow the colon.
 *
 * ":D", ":P", ":O", ":3" are finished text smileys, not half-typed
 * shortcodes, and a single letter fuzzy-matches so many names that the first
 * hit is accepted by Enter — ":D" used to send 🎲 off :die:. A bare ":" is
 * held back for the same reason; Ctrl-Space still opens the whole list.
 */
export function emojiSuggestionsOpenFor(token: string) {
  return /^:\w\w/.test(token);
}

/**
 * Typing or deleting within this keeps the open list filtering instead of
 * asking the source again — so it has to agree with the gate above, or
 * deleting back down to ":d" would leave the one-letter list on screen.
 */
export const RE_emojiValidFor = /(?<!\w):\w\w+/;
