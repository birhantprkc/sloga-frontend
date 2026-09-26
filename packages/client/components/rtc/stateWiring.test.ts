// Source pins for `state.tsx`'s voice-move and chip wiring — run with Node's
// built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/stateWiring.test.ts
// `node --test` cannot load `state.tsx` (Solid JSX, livekit), so the decisions
// live in `voiceMovePolicy.ts` and `chipInputs.ts`, where their own specs hold
// them, and this file holds `state.tsx` to CALLING them with the right inputs.
// Each pin is one load-bearing statement, matched as TEXT after `codeOf`
// (`sourcePins.harness.ts`): comments and whitespace are ignored, so a
// commented-out copy never satisfies a pin and a prettier reflow never breaks
// one. `rtc-mutations.py` proves each pin kills its wiring mutation (the
// `state-*` entries).
//
// Known limits, the same as `screenShareWatchPolicy.test.ts`'s pins:
//  - the same text put in dead code (`if (false) { ... }`) still satisfies a
//    pin;
//  - parentheses prettier adds or removes, and a statement rewritten into an
//    equivalent form (braces around a one-line `if`, a renamed local), break
//    a pin without changing behavior. Changing one of these sites on purpose
//    means changing its pin here too;
//  - the lexer does not read regex literals or JSX text (see the harness); the
//    first test fails on the usual sign that one made it lose its place (a
//    quoted string running across a line, or a comment kept).
// Removing logs and editing comments never breaks a pin; adding a statement
// inside a pinned span does.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  assertLexesInSync,
  codeOf,
  countWired,
  wiredAsserter,
  wiredAt,
} from "./sourcePins.harness.ts";

const STATE_SOURCE = readFileSync(
  new URL("./state.tsx", import.meta.url),
  "utf8",
);
const STATE_CODE = codeOf(STATE_SOURCE);

/** `snippet` must appear exactly once in state.tsx's code. */
const assertWired = wiredAsserter("state.tsx", STATE_CODE);

/**
 * The index of the `}` or `)` that closes the opener at `openAt` in `code`
 * (already put through `codeOf`), skipping strings the way `codeOf` reads
 * them.
 */
function closerOf(code: string, openAt: number): number {
  const open = code[openAt];
  assert.ok(open === "{" || open === "(", `no opener at ${openAt}`);
  const close = open === "{" ? "}" : ")";
  let depth = 0;
  for (let i = openAt; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      i = j;
    } else if (c === open) depth++;
    else if (c === close && --depth === 0) return i;
  }
  assert.fail(`the ${open} at ${openAt} is never closed`);
}

/**
 * The inside of the block or argument list that each occurrence of `head`
 * opens. `head` ends with the `{` or `(` it opens.
 */
function bodiesAfter(code: string, head: string): string[] {
  const want = codeOf(head);
  const out: string[] = [];
  for (
    let at = code.indexOf(want);
    at !== -1;
    at = code.indexOf(want, at + 1)
  ) {
    const openAt = at + want.length - 1;
    out.push(code.slice(openAt + 1, closerOf(code, openAt)));
  }
  return out;
}

/** The inside of the ONE block or argument list `head` opens. */
function bodyAfter(code: string, head: string): string {
  const bodies = bodiesAfter(code, head);
  assert.equal(
    bodies.length,
    1,
    `state.tsx must contain this exactly once, found ${bodies.length}:\n` +
      codeOf(head),
  );
  return bodies[0];
}

/**
 * The ONE body `head` opens, give or take the parentheses prettier wraps a
 * long `return` in.
 */
function bodyOf(head: string): string {
  return bodyAfter(STATE_CODE, head).replace(/^return\((.*)\)$/s, "return$1");
}

test("source pin: state.tsx lexes in sync, and its comments are stripped", () => {
  assertLexesInSync("state.tsx", STATE_SOURCE, STATE_CODE, 100);
});

test("source pin: a pin's trimmed , or ; still ends it", () => {
  const needle = `track.setSubscribed(true);`;
  // The file's `;` is gone when a `}` follows, and kept before a statement.
  for (const code of [
    `for (const track of ts) { track.setSubscribed(true); }`,
    `track.setSubscribed(true); next();`,
    `track.setSubscribed(true)`,
    `f(track.setSubscribed(true))`,
  ])
    assert.equal(countWired(codeOf(code), needle), 1, code);
  // Anything appended to the expression is not the pinned statement.
  for (const code of [
    `track.setSubscribed(true) || true;`,
    `track.setSubscribed(true).then(next);`,
    `track.setSubscribed(true)[0];`,
  ])
    assert.equal(countWired(codeOf(code), needle), 0, code);
  assert.equal(
    countWired(codeOf(`id = p.identity.split(":")[0];`), `id = p.identity;`),
    0,
  );
  // The same for a trimmed `,` in an object literal.
  assert.equal(countWired(codeOf(`f({ a, b })`), `a,`), 1);
  assert.equal(countWired(codeOf(`f({ a: g(), b })`), `a,`), 0);
  // A needle ending in anything else is not anchored, and counts do not
  // overlap.
  assert.equal(countWired(codeOf(`g(1) || f(2)`), `g(`), 1);
  assert.equal(countWired(`aaaa`, `aa`), 2);
  assert.deepEqual(wiredAt(codeOf(`x; a; a,b`), `a;`), [2, 4]);
});

test("source pin: the block reader skips strings and stops at its own closer", () => {
  const code = codeOf(`run(() => { a("}"); if (x) { b(")"); } c(); }); g();`);
  assert.deepEqual(bodiesAfter(code, `run(() => {`), [
    codeOf(`a("}"); if (x) { b(")"); } c()`),
  ]);
  assert.deepEqual(bodiesAfter(code, `run(`), [
    codeOf(`() => { a("}"); if (x) { b(")"); } c(); }`),
  ]);
  assert.deepEqual(bodiesAfter(code, `h(`), []);
  // A head is matched as text, so it also matches inside a longer name.
  assert.equal(bodiesAfter(code, `n(`).length, 1);
});

test("source pin (F1): #followMove obeys only a token minted for THIS connection's last identity", () => {
  const followMove = bodyAfter(
    STATE_CODE,
    `async #followMove(request: VoiceMoveRequest): Promise<void> {`,
  );
  const locals = `const { from, to, url, token } = request;`;
  const verdict = `const tokenForThisConnection = moveTokenForConnection({
    token,
    lastLocalIdentity: this.#lastLocalIdentity,
    to,
  });`;
  const obey = `if (
    to === from ||
    !shouldObeyMove({
      from,
      liveRoomChannelId,
      state,
      lastDisconnect: this.#lastDisconnect,
      now: performance.now(),
      tokenForThisConnection,
    })
  )
    return;`;
  const pins: [string, string][] = [
    ["the move's locals", locals],
    ["the token verdict", verdict],
    ["the obey rule", obey],
  ];
  for (const [what, snippet] of pins) {
    assertWired(what, snippet);
    assert.equal(countWired(followMove, snippet), 1, `${what}, in #followMove`);
  }
  // In that order: the verdict is computed from the event's own token, and
  // the rule reads it before anything is torn down or joined.
  const at = (snippet: string) => {
    const [first] = wiredAt(followMove, snippet);
    assert.ok(first !== undefined, `in #followMove: ${codeOf(snippet)}`);
    return first;
  };
  assert.ok(at(locals) < at(verdict) && at(verdict) < at(obey));
  assert.ok(at(obey) < at(`this.#lastDisconnect = undefined;`));
  // The only calls: nothing else decides a move with its own inputs.
  assert.equal(countWired(STATE_CODE, `shouldObeyMove(`), 1);
  assert.equal(countWired(STATE_CODE, `moveTokenForConnection(`), 1);
});

test("source pin (F1): #lastLocalIdentity is written only by the connected listener, under its generation", () => {
  const connected = bodyAfter(
    STATE_CODE,
    `room.addListener("connected", () => {`,
  );
  assert.equal(
    countWired(
      connected,
      `if (gen === this.#connectGen)
        this.#lastLocalIdentity = room.localParticipant.identity;`,
    ),
    1,
    "the generation-guarded write in the connected listener",
  );
  // Every write in the file, compound assignments included; `===` and `!==`
  // are reads.
  const writes = STATE_CODE.match(/#lastLocalIdentity(\?\?|\|\||&&)?=(?!=)/g);
  assert.equal(writes?.length, 1, "writes of #lastLocalIdentity");
});

// F4 (M3 dropped a move token that a refusal latch was bypassed for). The
// latch is read through `#refusalLatchHolds`, never `joinBlocked`: here
// `connect()` has already set `joinPending` to this channel, so
// `joinBlocked(channel)` answers "in-flight" and `answer_latch` would be
// unreachable.
const AUTH_DECISION = `const authDecision = moveAuthDecision({
  hasAuth: !!auth,
  tokenUsable:
    !!auth &&
    moveTokenUsable({
      token: auth.token,
      expectedIdentity: !selfUserId
        ? ""
        : e2eeDeviceId
          ? \`\${selfUserId}:\${e2eeDeviceId}\`
          : selfUserId,
      to: channel.id,
    }),
  latchStillRefused:
    bypassedRefusal !== undefined && this.#refusalLatchHolds(channel),
});`;
const AUTH_SWITCH = `switch (authDecision) {
  case "use":
    break;
  case "join":
    auth = undefined;
    break;
  case "answer_latch":
    if (gen !== this.#connectGen) return false;
    this.disconnect();
    this.onErr(new Error(this.#joinRefusalText(channel, bypassedRefusal!)));
    return false;
  default:`;

test("source pin (F4): the decision after M3 reads the latch through #refusalLatchHolds", () => {
  assertWired("the decision after M3", AUTH_DECISION);
  const args = bodyAfter(STATE_CODE, `const authDecision = moveAuthDecision(`);
  assert.equal(
    countWired(args, `joinBlocked(`),
    0,
    "joinBlocked in the decision",
  );
  assert.equal(countWired(args, `#joinRefusals`), 0, "the raw latch map");
  // And the helper asks with NO in-flight channel: its whole body.
  assert.equal(
    bodyOf(`#refusalLatchHolds(channel: Channel): boolean {`),
    codeOf(`return this.#joinBlockedWith(channel, undefined) === "refused"`),
    "the latch read",
  );
  assert.equal(countWired(STATE_CODE, `moveAuthDecision(`), 1);
});

test("source pin (D1): joinBlocked passes the attempt in flight, and #joinBlockedWith passes on what it is given", () => {
  // The other two ends of the latch read above. A `#joinBlockedWith` that
  // looked the attempt up itself would answer "in-flight" to F4 again, making
  // `answer_latch` unreachable; a public `joinBlocked` passing `undefined`
  // would leave every join affordance live while its attempt is in flight.
  // Whole bodies, so nothing can be appended to either.
  assert.equal(
    bodyOf(`joinBlocked(channel: Channel): JoinBlockedReason | undefined {`),
    codeOf(`return this.#joinBlockedWith(channel, this.joinPending())`),
    "joinBlocked",
  );
  assert.equal(
    bodyOf(`#joinBlockedWith(
      channel: Channel,
      inFlightChannelId: string | undefined,
    ): JoinBlockedReason | undefined {`),
    codeOf(`const latch = this.#joinRefusals().get(channel.id);
    return joinBlockedReason({
      channelId: channel.id,
      now: Date.now(),
      channelVersion: this.#channelVersions.get(channel.id) ?? 0,
      inFlightChannelId,
      latch,
      superseded: refusalSuperseded(latch, this.#deviceRefusedAt()),
    })`),
    "#joinBlockedWith",
  );
  assert.equal(countWired(STATE_CODE, `joinBlockedReason(`), 1);
});

test("source pin (F4): answer_latch leaves, answers from the latch and never joins", () => {
  // Contiguous with the decision, so nothing runs between them, and the arm
  // ends in `return false` right before `default`, so it cannot fall through
  // to the join below.
  assertWired("the decision, then its switch", AUTH_DECISION + AUTH_SWITCH);
});

test("source pin (S1): connect() steps past a latch only for a move token and an allowed reason", () => {
  assertWired(
    "the latch check",
    `const refusal = this.#joinRefusals().get(channel.id);
    const latchedReason =
      refusal && this.joinBlocked(channel) === "refused"
        ? refusal.reason
        : undefined;
    if (
      latchedReason !== undefined &&
      !(
        auth &&
        opts?.moveLatchBypass &&
        moveBypassesRefusalLatch(latchedReason)
      )
    ) {
      this.onErr(new Error(this.#joinRefusalText(channel, latchedReason)));
      return false;
    }
    this.disconnect();`,
  );
  // The bypassed reason reaches #connectAttempt, which is what F4 reads.
  assertWired(
    "the attempt",
    `return await this.#connectAttempt(channel, auth, latchedReason);`,
  );
  // The one caller that asks for the bypass, and only with a token.
  assertWired(
    "the move's join",
    `joined = await this.connect(dest, auth, { moveLatchBypass: !!auth });`,
  );
  assert.equal(countWired(STATE_CODE, `moveLatchBypass:`), 1);
});

test("source pin (F2): the chip's remote publications go through chipPublicationsOf", () => {
  assertWired(
    "the remote participants",
    `...[...room.remoteParticipants.values()].map((p) => ({
      identity: p.identity,
      publicationCount: p.trackPublications.size,
      publications: chipPublicationsOf(p.trackPublications.values()),
    })),`,
  );
  assert.equal(countWired(STATE_CODE, `chipPublicationsOf(`), 1);
});

test("source pin (F2): a subscription change and a reconnect both bump the chip's publication version", () => {
  assertWired(
    "the subscription listener",
    `room.addListener("trackSubscriptionStatusChanged", () => {
      if (this.room() !== room) return;
      this.#setChipPublicationsVersion((v) => v + 1);
    });`,
  );
  const bump = `this.#setChipPublicationsVersion((v) => v + 1);`;
  const reconnected = bodiesAfter(
    STATE_CODE,
    `room.addListener("reconnected", () => {`,
  ).filter(
    (body) => countWired(body, `if (this.room() !== room) return;`) === 1,
  );
  assert.equal(reconnected.length, 1, "the room-guarded reconnected listener");
  assert.equal(countWired(reconnected[0], bump), 1, "its bump");
});

test("source pin (F2): callEncryptionChip() reads the publication version before deriving", () => {
  const chip = bodyAfter(STATE_CODE, `callEncryptionChip(): ChipState {`);
  const [at] = wiredAt(chip, `this.#chipPublicationsVersion();`);
  assert.ok(at !== undefined, "the version read");
  assert.ok(at < chip.indexOf(codeOf(`return chipStateFrom({`)), "its order");
});

test("source pin: the move event's name is checked against the SDK's events", () => {
  assertWired(
    "the event name",
    `const VOICE_MOVE_REQUESTED = "voiceMoveRequested" satisfies keyof Events;`,
  );
  assertWired(
    "the listener",
    `const handler = (request: VoiceMoveRequest) =>
      void this.#followMove(request);
    client.addListener(VOICE_MOVE_REQUESTED, handler);
    onCleanup(() => client.removeListener(VOICE_MOVE_REQUESTED, handler));`,
  );
  // No second, unchecked spelling of the name.
  assert.equal(countWired(STATE_CODE, `"voiceMoveRequested"`), 1);
});
