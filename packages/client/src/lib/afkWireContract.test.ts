// Wire-literal and UI-gate pins for the AFK channel (AFK plan Stage 6,
// remediation round S6-R1: findings F-B5 and F-B7, 2026-09-23).
//   node --test --conditions=browser src/lib/afkWireContract.test.ts
//
// F-B5. stoat.js carries four hand-typed copies of backend wire names for the
// AFK pair, and the compiler checks none of the ways they can drift:
//
// - the `ServerUpdate` clear switch in `stoat.js/src/events/v1.ts` compares
//   against `"AfkChannel" as string` / `"AfkTimeout" as string`. The `as
//   string` exists because stoat-api predates the variants, and it also
//   switches type checking off: a typo compiles, the case never matches, and
//   a cleared designation never reaches the client (the client keeps refusing
//   the old channel, or keeps auto-moving into it);
// - the `afk_channel_id` / `afk_timeout` keys in
//   `stoat.js/src/hydration/server.ts`. A consistent typo across the input
//   type, `keyMapping` and `functions` also compiles, and every designation
//   is then dropped with nothing but a `console.debug`.
//
// F-B7. The two AFK controls are offered only to holders of ManageServer,
// because the routes behind them demand it. A gate relaxed to ManageChannel
// renders a control that answers 403, and nothing but these scans notices.
//
// The literal pins run unconditionally. The one backend cross-check is
// OPT-IN: it runs only with `SLOGA_BACKEND_DIR` set to a backend checkout
// (e.g. `SLOGA_BACKEND_DIR=/path/to/stoatchat node --test …`), and otherwise
// reports itself as SKIPPED. A gate that must prove the cross-check ran has
// to set the variable and read the skip count, not just the exit status.
//
// 🔴 These are textual scans of source that cannot be imported here (Solid,
// lingui macros, the stoat.js package). They are blunt by nature; each one is
// anchored to the AFK code itself so that an unrelated occurrence of the same
// literal elsewhere in the file cannot satisfy it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const EVENTS_V1 = read("../../../stoat.js/src/events/v1.ts");
const SERVER_HYDRATION = read("../../../stoat.js/src/hydration/server.ts");
const CHANNEL_OVERVIEW = read(
  "../../components/app/interface/settings/channel/Overview.tsx",
);
const CREATE_CHANNEL = read("../../components/modal/modals/CreateChannel.tsx");

/**
 * The backend's wire names, hard-coded from the backend tree. Nothing
 * generated ties the two repositories together, so these ARE the contract on
 * this side; the OPT-IN cross-check at the bottom re-reads them from a
 * backend checkout, only when `SLOGA_BACKEND_DIR` names one.
 *
 * - `FieldsServer::AfkChannel` / `FieldsServer::AfkTimeout`:
 *   `crates/core/models/src/v0/servers.rs:160-161` (backend `06a1409f`).
 *   `auto_derived!` adds a plain serde derive with no `rename_all`, so the
 *   wire value is the variant name. The `ServerUpdate` event carries them as
 *   `clear: Vec<FieldsServer>` (`crates/core/database/src/events/client.rs:172`).
 * - `Server.afk_channel_id` / `Server.afk_timeout`:
 *   `crates/core/models/src/v0/servers.rs:111, :115`, no serde rename.
 */
const BACKEND = {
  clearAfkChannel: "AfkChannel",
  clearAfkTimeout: "AfkTimeout",
  fieldAfkChannel: "afk_channel_id",
  fieldAfkTimeout: "afk_timeout",
} as const;

// --- Source helpers ---------------------------------------------------------

/**
 * Blank out comments, keeping every offset and newline where it was, so an
 * index found in the result is valid in the original and prose cannot satisfy
 * or break a scan. Deliberately crude — it does not track string literals,
 * because JSX text is full of apostrophes that a quote tracker would pair up
 * across real code. Instead a comment must open at the start of a line, after
 * whitespace, or (block comments) right after the `{` of a JSX comment. That
 * leaves `"https://…"` and `accept="image/*"` in strings alone.
 */
function blankComments(source: string): string {
  const blank = (text: string) => text.replace(/[^\n]/g, " ");
  return source
    .replace(
      /(^|[\s{])(\/\*[\s\S]*?\*\/)/g,
      (_, lead: string, comment: string) => `${lead}${blank(comment)}`,
    )
    .replace(
      /(^|\s)(\/\/[^\n]*)/g,
      (_, lead: string, comment: string) => `${lead}${blank(comment)}`,
    );
}

/**
 * Advance past the string literal that opens at `i`, if one does, returning
 * the index of its closing quote; otherwise `i`. Double quotes and backticks
 * only: single quotes appear in Rust lifetimes and would pair up across code,
 * and none of the scanned blocks use single-quoted strings.
 */
function skipString(code: string, i: number): number {
  const ch = code[i];
  if (ch !== '"' && ch !== "`") return i;
  let j = i + 1;
  while (j < code.length && code[j] !== ch) {
    if (code[j] === "\\") j++;
    j++;
  }
  return j;
}

/**
 * The text between the first `{` at or after `from` and its matching `}`,
 * exclusive. Braces inside string literals are ignored. Run it on
 * comment-blanked code: prose is not balanced.
 */
function balanced(source: string, from: number): { body: string; end: number } {
  const start = source.indexOf("{", from);
  assert.notEqual(start, -1, `no "{" after offset ${from}`);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    const skipped = skipString(source, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = source[i];
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) {
      return { body: source.slice(start + 1, i), end: i };
    }
  }
  assert.fail(`unbalanced "{" starting at offset ${start}`);
}

/**
 * The braced block opened by the first `{` at or after the single occurrence
 * of `needle` in code (a `{` ending the needle itself counts).
 */
function blockAfter(source: string, needle: string, what: string): string {
  const code = blankComments(source);
  const at = code.indexOf(needle);
  assert.notEqual(at, -1, `${what}: "${needle}" not found`);
  assert.equal(
    code.indexOf(needle, at + 1),
    -1,
    `${what}: "${needle}" occurs more than once — the scan cannot tell which`,
  );
  return balanced(code, at).body;
}

/**
 * The expression body of `const name = () => <expr>;`, up to the first `;`
 * outside any bracket. Comments are blanked first.
 */
function arrowBody(source: string, name: string, file: string): string {
  const code = blankComments(source);
  const matches = [
    ...code.matchAll(new RegExp(`\\bconst ${name}\\s*=\\s*\\(\\)\\s*=>`, "g")),
  ];
  assert.equal(
    matches.length,
    1,
    `${file}: expected exactly one \`const ${name} = () =>\`, found ${matches.length}`,
  );
  const from = matches[0].index! + matches[0][0].length;
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const skipped = skipString(code, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = code[i];
    if (ch === "(" || ch === "{" || ch === "[") depth++;
    else if (ch === ")" || ch === "}" || ch === "]") depth--;
    else if (ch === ";" && depth === 0) return code.slice(from, i).trim();
  }
  assert.fail(`${file}: \`const ${name}\` has no terminating ";"`);
}

/** Every permission named by a `havePermission("…")` call in `code`. */
function permissionsNamed(code: string): string[] {
  return [...code.matchAll(/havePermission\(\s*"([^"]+)"\s*\)/g)].map(
    (match) => match[1],
  );
}

/**
 * The `when={…}` expressions of every `<Show>` that is open at the single
 * occurrence of `anchor`, innermost last. Comments are blanked first, so a
 * `<Show` written in prose is not a tag.
 */
function enclosingShowGates(
  source: string,
  anchor: string,
  file: string,
): string[] {
  const code = blankComments(source);
  const at = code.indexOf(anchor);
  assert.notEqual(at, -1, `${file}: anchor ${anchor} not found in code`);
  assert.equal(
    code.indexOf(anchor, at + 1),
    -1,
    `${file}: anchor ${anchor} occurs more than once — the scan cannot tell which control it is`,
  );
  const open: string[] = [];
  const tag = /<Show\b|<\/Show\s*>/g;
  for (let match = tag.exec(code); match; match = tag.exec(code)) {
    if (match.index >= at) break;
    if (match[0].startsWith("</")) {
      open.pop();
      continue;
    }
    // Read the opening tag up to its closing `>`, skipping `{…}` attribute
    // values (which may themselves contain `>`).
    let i = match.index + match[0].length;
    let when = "";
    let selfClosing = false;
    while (i < code.length) {
      if (code[i] === "{") {
        const { body, end } = balanced(code, i);
        const attr = code.slice(match.index, i);
        if (/\bwhen\s*=\s*$/.test(attr)) when = body.trim();
        i = end + 1;
        continue;
      }
      if (code[i] === ">") {
        selfClosing = code[i - 1] === "/";
        break;
      }
      i++;
    }
    if (!selfClosing) open.push(when);
  }
  return open;
}

/** `case "X"(as string)?: changes["y"] = undefined;` pairs in a clear switch. */
function clearCases(switchBody: string): Map<string, string> {
  const cases = new Map<string, string>();
  const pattern =
    /case\s+"([^"]+)"(?:\s+as\s+string)?\s*:\s*changes\[\s*"([^"]+)"\s*\]\s*=\s*undefined\s*;/g;
  for (const match of blankComments(switchBody).matchAll(pattern)) {
    cases.set(match[1], match[2]);
  }
  return cases;
}

// --- F-B5: stoat.js wire literals -------------------------------------------

const SERVER_UPDATE_CLEAR = clearCases(
  blockAfter(
    blockAfter(EVENTS_V1, 'case "ServerUpdate": {', "v1.ts ServerUpdate"),
    "switch (remove)",
    "v1.ts ServerUpdate clear switch",
  ),
);

const HYDRATION_KEYS = new Map(
  [
    ...blankComments(
      blockAfter(SERVER_HYDRATION, "keyMapping:", "server.ts keyMapping"),
    ).matchAll(/\b(\w+)\s*:\s*"(\w+)"/g),
  ].map((match) => [match[1], match[2]] as const),
);

const HYDRATION_FUNCTIONS = blankComments(
  blockAfter(SERVER_HYDRATION, "functions:", "server.ts functions"),
);

const HYDRATION_INPUT = blankComments(
  blockAfter(SERVER_HYDRATION, "APIServer &", "server.ts hydration input"),
);

/** The wire field a `functions` entry reads, e.g. `server.afk_channel_id`. */
function functionReads(hydratedKey: string): string | undefined {
  const match = HYDRATION_FUNCTIONS.match(
    new RegExp(
      `\\b${hydratedKey}\\s*:\\s*\\(\\s*(\\w+)\\s*\\)\\s*=>\\s*\\1\\.(\\w+)`,
    ),
  );
  return match?.[2];
}

for (const [clearVariant, wireField] of [
  [BACKEND.clearAfkChannel, BACKEND.fieldAfkChannel],
  [BACKEND.clearAfkTimeout, BACKEND.fieldAfkTimeout],
] as const) {
  test(`🔴 hydration maps the backend's \`${wireField}\` field`, () => {
    // The input type must declare the field, keyMapping must map it, and the
    // hydrated key it maps to must have a `functions` entry that reads the
    // SAME wire field. `hydrateInternal` looks the function up by the mapped
    // key and silently skips a key it cannot resolve.
    assert.match(
      HYDRATION_INPUT,
      new RegExp(`\\b${wireField}\\?\\s*:`),
      `server.ts: the hydration input type no longer declares \`${wireField}\``,
    );
    const hydratedKey = HYDRATION_KEYS.get(wireField);
    assert.ok(
      hydratedKey,
      `server.ts: keyMapping has no \`${wireField}\` entry — the backend's field is dropped on hydration`,
    );
    assert.equal(
      functionReads(hydratedKey),
      wireField,
      `server.ts: functions.${hydratedKey} does not read \`${wireField}\``,
    );
  });

  test(`🔴 a ServerUpdate clear of \`${clearVariant}\` resets the same hydrated key`, () => {
    // The backend clears these ONLY through `clear`, never through the
    // partial, so this case is the sole path by which a removal reaches the
    // client. It must match the backend variant exactly, and it must reset
    // the key that hydration writes — a clear of a different key would leave
    // the old value standing.
    const clearedKey = SERVER_UPDATE_CLEAR.get(clearVariant);
    assert.ok(
      clearedKey,
      `v1.ts: the ServerUpdate clear switch has no case "${clearVariant}" — a cleared value never reaches the client`,
    );
    assert.equal(
      clearedKey,
      HYDRATION_KEYS.get(wireField),
      `v1.ts: clearing "${clearVariant}" resets "${clearedKey}", but hydration stores \`${wireField}\` as "${HYDRATION_KEYS.get(wireField)}"`,
    );
  });
}

test("the ServerUpdate clear-switch parser sees the pre-existing cases", () => {
  // Guards the scan itself: if the parser stopped matching, every AFK case
  // above would fail as "missing" for the wrong reason. `Banner` and
  // `VoiceRegion` predate the AFK slice.
  assert.equal(SERVER_UPDATE_CLEAR.get("Banner"), "banner");
  assert.equal(SERVER_UPDATE_CLEAR.get("VoiceRegion"), "voiceRegion");
});

// OPT-IN cross-check against a backend checkout. The hard-coded BACKEND
// literals above are the pin and run unconditionally; this only re-derives
// them from a backend tree the caller names in `SLOGA_BACKEND_DIR`. There is
// deliberately no default path: a default pointing at a personal worktree
// would skip forever once that worktree is gone, and a skip reads as a pass.
// Unset, it SKIPS and says which variable to set. Set to a path that is not a
// backend tree, it FAILS: an explicit request is never quietly ignored.
const BACKEND_DIR = process.env.SLOGA_BACKEND_DIR;

test("the hard-coded literals still match the backend tree", (t) => {
  if (BACKEND_DIR === undefined || BACKEND_DIR === "") {
    t.skip(
      "backend cross-check not run: set SLOGA_BACKEND_DIR to a backend checkout to run it (the literal pins above ran regardless)",
    );
    return;
  }
  const BACKEND_SERVERS = `${BACKEND_DIR}/crates/core/models/src/v0/servers.rs`;
  const BACKEND_EVENTS = `${BACKEND_DIR}/crates/core/database/src/events/client.rs`;
  for (const file of [BACKEND_SERVERS, BACKEND_EVENTS]) {
    assert.ok(
      existsSync(file),
      `SLOGA_BACKEND_DIR=${BACKEND_DIR} is not a backend tree: ${file} is missing`,
    );
  }
  const servers = blankComments(readFileSync(BACKEND_SERVERS, "utf8"));
  const events = blankComments(readFileSync(BACKEND_EVENTS, "utf8"));

  const variants = blockAfter(
    servers,
    "pub enum FieldsServer",
    "backend FieldsServer",
  )
    .split(",")
    .map((variant) => variant.trim())
    .filter(Boolean);
  for (const variant of [BACKEND.clearAfkChannel, BACKEND.clearAfkTimeout]) {
    assert.ok(
      variants.includes(variant),
      `backend FieldsServer has no \`${variant}\` (variants: ${variants.join(", ")})`,
    );
  }
  // Whatever sits between the previous item (or the macro's opening paren)
  // and the enum is the enum's own attribute list.
  const enumAt = servers.indexOf("pub enum FieldsServer");
  const enumAttributes = servers.slice(
    Math.max(
      servers.lastIndexOf("}", enumAt),
      servers.lastIndexOf("(", enumAt),
    ),
    enumAt,
  );
  assert.doesNotMatch(
    enumAttributes,
    /rename/,
    "backend FieldsServer is serde-renamed — the wire names are no longer the variant names",
  );

  const server = blockAfter(servers, "pub struct Server ", "backend Server");
  for (const field of [BACKEND.fieldAfkChannel, BACKEND.fieldAfkTimeout]) {
    const declaration = new RegExp(
      `(#\\[[^\\]]*\\]\\s*)*pub ${field}\\s*:`,
    ).exec(server);
    assert.ok(declaration, `backend Server has no \`${field}\` field`);
    assert.doesNotMatch(
      declaration[0],
      /rename/,
      `backend Server.${field} is serde-renamed on the wire`,
    );
  }

  assert.match(
    blockAfter(events, "ServerUpdate {", "backend ServerUpdate"),
    /\bclear\s*:\s*Vec<FieldsServer>/,
    "backend ServerUpdate no longer carries `clear: Vec<FieldsServer>`",
  );
});

// --- F-B7: the AFK controls are gated on ManageServer -----------------------

test("🔴 channel settings offer the AFK section only to ManageServer holders", () => {
  // The chain, each link anchored to the AFK code rather than to any
  // `ManageServer` in the file: the <Show> wrapping the AFK controls is gated
  // on `canConfigureAfk()`, which requires `canManageServer()`, which asks for
  // ManageServer and nothing else.
  for (const anchor of [
    "onPress={toggleAfkChannel}",
    "control={afkTimeoutControl}",
  ]) {
    const gates = enclosingShowGates(CHANNEL_OVERVIEW, anchor, "Overview.tsx");
    assert.ok(
      gates.some((gate) => /\bcanConfigureAfk\(\)/.test(gate)),
      `Overview.tsx: ${anchor} is not inside a <Show> gated on canConfigureAfk() (gates: ${JSON.stringify(gates)})`,
    );
  }
  assert.match(
    arrowBody(CHANNEL_OVERVIEW, "canConfigureAfk", "Overview.tsx"),
    /\bcanManageServer\(\)/,
    "Overview.tsx: canConfigureAfk() no longer requires canManageServer()",
  );
  assert.deepEqual(
    permissionsNamed(
      arrowBody(CHANNEL_OVERVIEW, "canManageServer", "Overview.tsx"),
    ),
    ["ManageServer"],
    "Overview.tsx: canManageServer() must ask for ManageServer, and only that",
  );
});

test("🔴 the create-channel modal offers the AFK tickbox only to ManageServer holders", () => {
  // Same chain: the <Show> around the AFK checkbox is gated on
  // `canDesignateAfk()`, which asks for ManageServer and nothing else. The
  // timeout select sits inside the same <Show>.
  for (const anchor of ['name="afk"', "control={group.controls.afkTimeout}"]) {
    const gates = enclosingShowGates(
      CREATE_CHANNEL,
      anchor,
      "CreateChannel.tsx",
    );
    assert.ok(
      gates.some((gate) => /\bcanDesignateAfk\(\)/.test(gate)),
      `CreateChannel.tsx: ${anchor} is not inside a <Show> gated on canDesignateAfk() (gates: ${JSON.stringify(gates)})`,
    );
  }
  assert.deepEqual(
    permissionsNamed(
      arrowBody(CREATE_CHANNEL, "canDesignateAfk", "CreateChannel.tsx"),
    ),
    ["ManageServer"],
    "CreateChannel.tsx: canDesignateAfk() must ask for ManageServer, and only that",
  );
});
