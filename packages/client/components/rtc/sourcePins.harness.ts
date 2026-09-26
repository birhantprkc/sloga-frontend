// Test-only support for SOURCE PINS: specs that hold a file `node --test`
// cannot load (Solid JSX, livekit) to calling the decisions a loadable module
// makes, by matching its TEXT (`screenShareWatchPolicy.test.ts` over
// `RoomAudioManager.tsx`, `stateWiring.test.ts` over `state.tsx`). Nothing in
// the app imports this file.
//
// The file and every pin both go through `codeOf` first: comments are
// stripped, whitespace outside strings is removed, a comma right before `)`,
// `]` or `}` is dropped, and so is a semicolon right before `}`. So a
// commented-out copy never satisfies a pin, and a prettier reflow (rewrapping
// lines, adding or removing a trailing comma, or the `;` a wrapped type
// literal gains) never breaks one. Other rewrites still do, such as
// parentheses prettier adds or removes. What a pin cannot see: the same text
// put in dead code (`if (false) { ... }`). What the lexer does not read:
// regex literals and JSX text. A quote or `//` in a regex literal, or an
// apostrophe in JSX text, makes it lose its place; `assertLexesInSync` fails
// when that runs a quoted string across a line or keeps a comment.
import assert from "node:assert/strict";

/**
 * `source` reduced to its tokens: every comment and every whitespace
 * character outside a string removed, a `,` directly before `)`, `]` or `}`
 * dropped, and a `;` directly before `}` dropped. Quoted and template strings
 * are copied exactly, whitespace and punctuation included (a template with a
 * nested backtick inside `${}` is not handled; the file has none). Regex
 * literals and JSX text are read as code, not as their own tokens, so a quote
 * or `//` in one is misread (see `assertLexesInSync`).
 */
export function codeOf(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) {
        if (source[j] === "\\") j++;
        j++;
      }
      out += source.slice(i, j + 1);
      i = j + 1;
    } else {
      // A string always ends in its quote, so a trailing `,` or `;` in `out`
      // is code.
      const closes = c === ")" || c === "]" || c === "}";
      if (closes && out.endsWith(",")) out = out.slice(0, -1);
      if (c === "}" && out.endsWith(";")) out = out.slice(0, -1);
      if (!/\s/.test(c)) out += c;
      i++;
    }
  }
  return out;
}

/**
 * Where `snippet` occurs in `code` (a file, or a slice of one, already put
 * through `codeOf`), without overlaps.
 *
 * A `,` or `;` the snippet ENDS with is dropped, because in the file `codeOf`
 * drops it whenever a closer follows: a pin ending `setSubscribed(true);`
 * would miss the file's `setSubscribed(true)}` once the statement after it in
 * the loop is deleted. What was dropped is still an END: such a match counts
 * only where the next character of `code` is `;`, `}`, `)`, `]` or `,`, or
 * there is none. Otherwise `f(x) || true;` and `id.split(":")[0];` would
 * satisfy the pins `f(x);` and `id;`.
 */
export function wiredAt(code: string, snippet: string): number[] {
  const whole = codeOf(snippet);
  const want = whole.replace(/[,;]+$/, "");
  assert.ok(want.length > 0, `an empty pin: ${JSON.stringify(snippet)}`);
  const ended = want.length < whole.length;
  const out: number[] = [];
  let at = code.indexOf(want);
  while (at !== -1) {
    const after = code[at + want.length];
    const counts = !ended || after === undefined || ";})],".includes(after);
    if (counts) out.push(at);
    at = code.indexOf(want, counts ? at + want.length : at + 1);
  }
  return out;
}

/** How often `snippet` occurs in `code`, read the way `wiredAt` reads it. */
export function countWired(code: string, snippet: string): number {
  return wiredAt(code, snippet).length;
}

/**
 * An `assertWired(what, snippet)` over `code` (a file already put through
 * `codeOf`), which `file` names in the failure message. `snippet` must occur
 * exactly once, read the way `wiredAt` reads it.
 */
export function wiredAsserter(
  file: string,
  code: string,
): (what: string, snippet: string) => void {
  return function assertWired(what: string, snippet: string): void {
    const found = countWired(code, snippet);
    assert.equal(
      found,
      1,
      `${what}: ${file} must contain this exactly once ` +
        `(comments and whitespace ignored), found ${found}:\n` +
        codeOf(snippet),
    );
  };
}

/** Every quoted or template string in `code`, with the quote that opened it. */
export function stringsOf(code: string): { quote: string; text: string }[] {
  const out: { quote: string; text: string }[] = [];
  for (let i = 0; i < code.length; i++) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    let j = i + 1;
    while (j < code.length && code[j] !== quote) {
      if (code[j] === "\\") j++;
      j++;
    }
    assert.ok(j < code.length, `unterminated ${quote} string at ${i}`);
    out.push({ quote, text: code.slice(i + 1, j) });
    i = j;
  }
  return out;
}

/**
 * The text of every line of `source` that is only a `//` comment of 30 or
 * more characters holding no quote and none of `;`, `{`, `}` or `=` (so
 * neither a string nor commented-out code), in file order.
 */
export function commentPhrasesOf(source: string): string[] {
  return [...source.matchAll(/^[ \t]*\/\/[ \t]*([^\n'"`;{}=]{30,})$/gm)].map(
    (m) => m[1],
  );
}

/**
 * `code` is `codeOf(source)` read in sync with `source`. A quote the lexer
 * misreads (an apostrophe in JSX text, a quote in a regex literal) would run
 * a "string" across lines and keep whatever it swallowed, comments included.
 * A quoted string can never hold a newline, so one that does means the lexer
 * lost its place; and the first and last prose comment lines of the file
 * (`commentPhrasesOf`, picked from the raw text, so this is not vacuous) must
 * both be gone.
 */
export function assertLexesInSync(
  file: string,
  source: string,
  code: string,
  minStrings: number,
): void {
  const strings = stringsOf(code);
  assert.ok(
    strings.length >= minStrings,
    `${file}: ${strings.length} strings, expected at least ${minStrings}`,
  );
  for (const { quote, text } of strings)
    if (quote !== "`")
      assert.ok(!text.includes("\n"), `${file}: ${quote}${text}${quote}`);
  const phrases = commentPhrasesOf(source);
  assert.ok(phrases.length > 0, `${file}: no prose comment line to check`);
  for (const phrase of [phrases[0], phrases[phrases.length - 1]]) {
    assert.ok(source.includes(phrase), `${file}: ${phrase}`);
    assert.ok(
      !code.includes(codeOf(phrase)),
      `${file}: this comment survived codeOf: ${phrase}`,
    );
  }
}
