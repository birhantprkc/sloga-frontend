// Unit spec for the emoji autocomplete gate — run with Node's built-in runner:
//   node --test components/ui/components/features/texteditor/emojiSuggestionGate.test.ts
// Regression under test: typing the smiley ":D" opened the shortcode list on
// one letter, so Enter (bound to acceptCompletion) sent 🎲 from :die: instead
// of the message. No Solid or CodeMirror imports here on purpose — the gate is
// dependency-free precisely so this spec can run without a browser.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RE_emojiValidFor,
  emojiSuggestionsOpenFor,
} from "./emojiSuggestionGate.ts";

// CodeMirror tests validFor against the text between `from` and the cursor,
// anchored at both ends (checkValid -> ensureAnchor(validFor, true)). Mirror
// that here rather than testing the bare regex, which matches substrings.
const validFor = (text: string) =>
  new RegExp(`^(?:${RE_emojiValidFor.source})$`).test(text);

test("finished text smileys never open the list", () => {
  // Enter has to reach the send handler for every one of these.
  for (const smiley of [":D", ":P", ":p", ":O", ":o", ":3", ":s", ":x"]) {
    assert.equal(emojiSuggestionsOpenFor(smiley), false, smiley);
  }
});

test("a bare colon does not open the whole catalogue", () => {
  // It used to: ":" plus Enter accepted whichever shortcode sorted first.
  assert.equal(emojiSuggestionsOpenFor(":"), false);
});

test("two characters open it, as does a full shortcode", () => {
  assert.equal(emojiSuggestionsOpenFor(":do"), true);
  assert.equal(emojiSuggestionsOpenFor(":dog"), true);
  assert.equal(emojiSuggestionsOpenFor(":smile"), true);
  // Digits and underscores are shortcode characters too.
  assert.equal(emojiSuggestionsOpenFor(":10"), true);
  assert.equal(emojiSuggestionsOpenFor(":e2"), true);
  assert.equal(emojiSuggestionsOpenFor(":_a"), true);
});

test("validFor agrees with the gate, so deleting back down closes it", () => {
  // Disagreement is the subtle failure: the list would keep filtering on one
  // letter after a backspace, never re-asking the source that closes it.
  for (const text of [":", ":D", ":d", ":3"]) {
    assert.equal(validFor(text), false, text);
    assert.equal(emojiSuggestionsOpenFor(text), false, text);
  }
  for (const text of [":do", ":dog", ":smile"]) {
    assert.equal(validFor(text), true, text);
    assert.equal(emojiSuggestionsOpenFor(text), true, text);
  }
});
