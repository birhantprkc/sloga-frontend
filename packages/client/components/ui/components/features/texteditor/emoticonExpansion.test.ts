// Unit spec for emoticon expansion — run with Node's built-in runner:
//   node --test components/ui/components/features/texteditor/emoticonExpansion.test.ts
// Focus: the table only ever holds emoji this app can actually draw, and the
// standalone-token rule keeps expansion out of times, paths and URLs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";

import { isInCodeBlock } from "./codeMirrorCommon.ts";
import {
  EMOTICONS,
  emoticonEnding,
  emoticonExpansionAt,
  expandTrailingEmoticon,
} from "./emoticonExpansion.ts";

// Read rather than import: the app resolves JSON through vite, and node's
// runner would need an import attribute the bundler doesn't want.
const emojiMapping: Record<string, string> = JSON.parse(
  readFileSync(new URL("../../../emojiMapping.json", import.meta.url), "utf8"),
);

test("every emoji in the table is one the app can draw", () => {
  // The renderer builds a per-pack CDN URL from the codepoint, so an emoji
  // outside the mapping (notably the U+FE0F forms) would 404 as a broken
  // image instead of failing loudly here.
  const drawable = new Set(Object.values(emojiMapping));
  for (const [emoticon, emoji] of Object.entries(EMOTICONS)) {
    assert.ok(drawable.has(emoji), `${emoticon} -> ${emoji} not in mapping`);
  }
});

test("the classics expand", () => {
  const cases: [string, string][] = [
    [":D", "😄"],
    [":)", "🙂"],
    [":(", "🙁"],
    [";)", "😉"],
    [":P", "😛"],
    [":p", "😛"],
    [":/", "😕"],
    [":'(", "😢"],
    ["<3", "❤"],
    ["</3", "💔"],
  ];

  for (const [emoticon, emoji] of cases) {
    assert.equal(emoticonEnding(emoticon)?.emoji, emoji, emoticon);
    assert.equal(emoticonEnding(`hey ${emoticon}`)?.emoji, emoji, emoticon);
    assert.equal(emoticonEnding(`hey\n${emoticon}`)?.emoji, emoji, emoticon);
  }
});

test("longest match wins over the emoticon nested inside it", () => {
  assert.equal(emoticonEnding(">:(")?.emoji, "😠");
  assert.equal(emoticonEnding("</3")?.emoji, "💔");
  assert.equal(emoticonEnding(":-D")?.emoji, "😄");
});

test("the match reports where to cut, not just what to insert", () => {
  const match = emoticonEnding("hey :D");
  assert.deepEqual(match, { emoticon: ":D", emoji: "😄", from: 4 });
});

test("only a standalone token expands", () => {
  // Each of these ends in something that looks like an emoticon but is glued
  // to the character in front of it.
  for (const text of [
    "10:30",
    "C:/src",
    "https://host",
    "*:D*",
    "x=D",
    "ratio 1:3",
    "a<3",
  ]) {
    assert.equal(emoticonEnding(text), null, text);
  }
});

test("half-typed and unlisted emoticons are left alone", () => {
  // A lowercase ":d" is the start of a shortcode, not a smiley; ":8" and ":]"
  // are not in the table; "8)" would eat an ordered-list marker.
  for (const text of ["", ":", ":d", ":8", ":]", "8)", "B)", "hey"]) {
    assert.equal(emoticonEnding(text), null, JSON.stringify(text));
  }
});

test("an emoticon mid-text is not matched — only one ending the text is", () => {
  // The caller passes the text up to the cursor, so a trailing word means the
  // user has moved past the emoticon and it stays as typed.
  assert.equal(emoticonEnding(":D hey"), null);
  assert.equal(emoticonEnding(":Dog"), null);
});

/**
 * Editor state over the real markdown syntax the composer uses, so the
 * code-block checks below run against a genuine parse tree.
 * @param doc Document text
 */
const stateFor = (doc: string) =>
  EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });

/**
 * Apply what the editor would apply, and read the document back
 * @param doc Document text
 * @param from Cursor position to expand at
 * @param trailing Text kept after the emoji
 * @param packPrefix Emoji pack marker
 */
function applyAt(doc: string, from: number, trailing = " ", packPrefix = "") {
  const state = stateFor(doc);
  const spec = emoticonExpansionAt({
    state,
    from,
    to: from,
    trailing,
    packPrefix,
    isInCode: isInCodeBlock,
  });
  if (!spec) return null;
  const next = state.update(spec);
  return {
    doc: next.state.doc.toString(),
    cursor: next.state.selection.main.head,
  };
}

/**
 * Apply at the very end of the document, where typing leaves the cursor
 * @param doc Document text
 * @param trailing Text kept after the emoji
 * @param packPrefix Emoji pack marker
 */
const applyAtEnd = (doc: string, trailing = " ", packPrefix = "") =>
  applyAt(doc, doc.length, trailing, packPrefix);

test("typing the space that ends an emoticon replaces it in place", () => {
  const result = applyAtEnd("hey :D");
  assert.equal(result?.doc, "hey 😄 ");
  // Cursor lands after the space, where the next character goes.
  assert.equal(result?.cursor, result?.doc.length);
});

test("sending keeps no trailing space", () => {
  assert.equal(applyAtEnd("hey :D", "")?.doc, "hey 😄");
});

test("the pack marker is carried into the document", () => {
  // Readers render the sender's pack off this prefix; the shortcode
  // autocomplete inserts the same thing.
  assert.equal(applyAtEnd("hey :D", "", "\uE0E6")?.doc, "hey \uE0E6😄");
});

test("only the emoticon is replaced, not the text around it", () => {
  assert.equal(applyAtEnd("well :/", "")?.doc, "well 😕");
  assert.equal(applyAtEnd("one :D two :(", "")?.doc, "one :D two 🙁");
  assert.equal(applyAtEnd("line one\n:D", "")?.doc, "line one\n😄");
});

test("code is left alone", () => {
  // An emoticon in a snippet belongs to the snippet. The cursor sits inside a
  // closed code span here, so the token rule would happily expand it and only
  // the code check stands in the way — which is the point of the test.
  const span = "say `x :D` now";
  assert.equal(applyAt(span, span.indexOf(":D") + 2, ""), null);

  // Fences count while still unclosed, which is how they are while typing.
  assert.equal(applyAtEnd("```\n:D", ""), null);
  assert.equal(applyAtEnd("    :D", ""), null); // indented code block
});

test("the same emoticon outside a code span still expands", () => {
  // Guards against the code check being too eager and taking the line with it.
  assert.equal(applyAtEnd("say `x` :D", "")?.doc, "say `x` 😄");
});

test("a document that does not end in an emoticon is untouched", () => {
  assert.equal(applyAtEnd("hello", ""), null);
  assert.equal(applyAtEnd("", ""), null);
});

// The send path — every surface that sends reads the draft, so this one works
// on text and has to reach the same verdicts without a parse tree.

test("a draft ending on an emoticon goes out expanded", () => {
  assert.equal(expandTrailingEmoticon("hey :D"), "hey 😄");
  assert.equal(expandTrailingEmoticon(":D"), "😄");
  assert.equal(expandTrailingEmoticon("one\ntwo :("), "one\ntwo 🙁");
  assert.equal(expandTrailingEmoticon("hey :D", "\uE0E6"), "hey \uE0E6😄");
});

test("a draft not ending on one goes out as typed", () => {
  for (const content of [
    "",
    "hello",
    "hey :D there", // already expanded when the space was typed
    "hey :D ", // trailing space, same
    "at 10:30",
    "see C:/src",
  ]) {
    assert.equal(expandTrailingEmoticon(content), content, content);
  }
});

test("the send path leaves code alone too, by counting delimiters", () => {
  // Unclosed: the sender is still inside code.
  assert.equal(expandTrailingEmoticon("try ` :D"), "try ` :D");
  assert.equal(expandTrailingEmoticon("```\n:D"), "```\n:D");
  assert.equal(
    expandTrailingEmoticon("```js\nlet a = 1\n:D"),
    "```js\nlet a = 1\n:D",
  );

  // Closed: back outside, so it expands.
  assert.equal(expandTrailingEmoticon("say `x` :D"), "say `x` 😄");
  assert.equal(expandTrailingEmoticon("```\nx\n```\n:D"), "```\nx\n```\n😄");

  // A backtick on an earlier line does not leak into this one.
  assert.equal(expandTrailingEmoticon("`x`\n:D"), "`x`\n😄");
});
