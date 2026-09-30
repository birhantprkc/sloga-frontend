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
  argumentsOf,
  assertLexesInSync,
  assertLogsOnly,
  bodiesAfter,
  closerOf,
  codeOf,
  consoleCallsIn,
  countWired,
  isStringLiteral,
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

/** Where `snippet` first occurs in `code`, which must hold it. */
function firstAt(what: string, code: string, snippet: string): number {
  const [at] = wiredAt(code, snippet);
  assert.ok(at !== undefined, `${what}: ${codeOf(snippet)}`);
  return at;
}

/**
 * How many `{` are open at `at` in `code` (the inside of a block, put through
 * `codeOf`), skipping strings the way `codeOf` reads them. 0 is the block's
 * own top level.
 */
function braceDepthAt(code: string, at: number): number {
  let depth = 0;
  for (let i = 0; i < at; i++) {
    const c = code[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < code.length && code[j] !== c) {
        if (code[j] === "\\") j++;
        j++;
      }
      i = j;
    } else if (c === "{") depth++;
    else if (c === "}") depth--;
  }
  return depth;
}

/** `#handleVoiceMove`'s body: the one handler for a server-ordered move. */
function handleMove(): string {
  return bodyAfter(
    STATE_CODE,
    `async #handleVoiceMove(move: VoiceMoveRequest): Promise<void> {`,
  );
}

/** `connect()`'s body. */
function connectBody(): string {
  return bodyAfter(
    STATE_CODE,
    `async connect(
      channel: Channel,
      auth?: { url: string; token: string },
      opts?: {
        movePreConnectBudgetMs?: number;
        rejoinAttempt?: boolean;
        moveLatchBypass?: boolean;
      },
    ): Promise<boolean> {`,
  );
}

/** `#connectAttempt`'s body, where M3 and the Room dial live. */
function connectAttempt(): string {
  return bodyAfter(
    STATE_CODE,
    `async #connectAttempt(
      channel: Channel,
      auth?: { url: string; token: string },
      opts?: {
        movePreConnectBudgetMs?: number;
        rejoinAttempt?: boolean;
        moveLatchBypass?: boolean;
      },
      bypassedRefusal?: JoinRefusalReason,
    ): Promise<boolean> {`,
  );
}

/**
 * Every write to a variable named `auth` in `code` (put through `codeOf`), a
 * declaration of a new one included, as the text of the write up to its
 * first `;` or `(`.
 */
function authWritesIn(code: string): string[] {
  return [
    ...code.matchAll(
      /(?<![\w$.#])((?:const|let|var)?auth)(\?\?=|\|\|=|&&=|=(?![=>]))/g,
    ),
  ].map((m) => {
    const rest = code.slice(m.index + m[0].length).match(/^[^;(]*\(?/);
    return m[0] + (rest?.[0] ?? "");
  });
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

test("source pin: the log reader sees every argument, and only a fixed string passes", () => {
  const code = codeOf(
    `console.warn("a, b", err); f(console.error); console.info(\`x\${y}\`);
    console.debug('ok', \`fine\`, g(1, [2, 3]));`,
  );
  assert.deepEqual(
    consoleCallsIn(code).map(({ args }) => args),
    [[`"a, b"`, `err`], ["`x${y}`"], [`'ok'`, "`fine`", `g(1,[2,3])`]],
  );
  assert.deepEqual(argumentsOf(``), []);
  assert.deepEqual(
    [`"a"`, `'b'`, "`c`", "`$d`", "`${e}`", `err`, `"a"+err`, `""`].map(
      isStringLiteral,
    ),
    [true, true, true, true, false, false, false, true],
  );
  assertLogsOnly("fixed", codeOf(`console.warn("[rtc] a", 'b');`));
  assertLogsOnly("allowed", codeOf(`console.warn("k:", kind);`), ["kind"]);
  for (const bad of [
    `console.warn("a", err);`,
    `console.warn(\`a \${err}\`);`,
    `p.catch(console.error);`,
    `console.warn("k:", kind, err);`,
  ])
    assert.throws(
      () => assertLogsOnly("bad", codeOf(bad), ["kind"]),
      assert.AssertionError,
      bad,
    );
});

test("source pin: the auth-write reader sees writes and declarations, not reads", () => {
  assert.deepEqual(
    authWritesIn(
      codeOf(`if (!auth) { auth = await channel.joinCall(node); }
      const x = auth !== undefined; y = !!auth && auth.token;
      case "join": auth = undefined; break;
      const auth = other; auth ??= z(); preMintedAuth = 1; o.auth = 2;
      const f = (auth) => auth;`),
    ),
    [
      `auth=awaitchannel.joinCall(`,
      `auth=undefined`,
      `constauth=other`,
      `auth??=z(`,
    ],
  );
});

test("source pin (F1): #handleVoiceMove obeys a token only through moveTokenUsable, for THIS connection's last identity", () => {
  const handler = handleMove();
  const verdict = `const forThisConnection = moveTokenUsable({
    token: move.token,
    expectedIdentity: this.#lastLocalIdentity ?? "",
    to: move.to,
  });`;
  assertWired("the token verdict", verdict);
  assert.equal(countWired(handler, verdict), 1, "the verdict, in the handler");
  assert.equal(countWired(handler, `moveTokenUsable(`), 1, "its only call");
  // Handed to the decision, and read nowhere else: declared once, read once.
  const decide = `const decision = moveDecision(`;
  const world = bodyAfter(handler, decide);
  assert.equal(
    countWired(world, `tokenForThisConnection: forThisConnection,`),
    1,
    "the verdict, in moveDecision's world",
  );
  assert.equal(countWired(STATE_CODE, `forThisConnection`), 2);
  // In that order: the verdict is computed from the event's own token, and
  // the decision reads it before anything is torn down or joined.
  const at = (snippet: string) => firstAt("#handleVoiceMove", handler, snippet);
  assert.ok(at(verdict) < at(decide));
  assert.ok(at(decide) < at(`this.#rejoinSeq++;`));
  assert.ok(at(decide) < at(`this.disconnect();`));
  assert.ok(at(decide) < at(`this.connect(`));
  // voice-move's own addressing rules are retired (D3): nothing else decides
  // a move with its own inputs, or on its own clock.
  for (const retired of [
    `shouldObeyMove(`,
    `moveTokenForConnection(`,
    `#lastDisconnect`,
    `#followMove`,
  ])
    assert.equal(countWired(STATE_CODE, retired), 0, retired);
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
    preConnectDeadlineAt = undefined;
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
  const latchCheck = `const refusal = this.#joinRefusals().get(channel.id);
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
    }`;
  assertWired("the latch check", latchCheck);
  // Answered before anything is torn down: the check comes ahead of
  // connect()'s leave, with no leave in front of it. (The drop-marker and
  // nonce clears sit between the two on purpose; see connect().)
  const connect = connectBody();
  const checkAt = firstAt("connect()", connect, latchCheck);
  assert.ok(checkAt < firstAt("connect()", connect, `this.disconnect();`));
  assert.equal(countWired(connect.slice(0, checkAt), `disconnect(`), 0);
  // The bypassed reason reaches #connectAttempt, which is what F4 reads.
  assertWired(
    "the attempt",
    `return await this.#connectAttempt(channel, auth, opts, latchedReason);`,
  );
  // The one caller that asks for the bypass: the move handler's token arm,
  // with the event's own URL and token, under the move budget.
  const tokenArm = `attempt = this.connect(
    destination,
    { url: decision.url, token: decision.token },
    {
      movePreConnectBudgetMs: MOVE_PRECONNECT_BUDGET_MS,
      moveLatchBypass: true,
    },
  );`;
  assertWired("the move's token arm", tokenArm);
  assert.equal(countWired(handleMove(), tokenArm), 1, "in #handleVoiceMove");
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

test("source pin: the move event's name is checked against the SDK's events, and its one listener calls the one handler", () => {
  assertWired(
    "the event name",
    `const VOICE_MOVE_REQUESTED = "voiceMoveRequested" satisfies keyof Events;`,
  );
  assertWired(
    "the listener",
    `const handler = (move: VoiceMoveRequest) =>
      void this.#handleVoiceMove(move);
    client.addListener(VOICE_MOVE_REQUESTED, handler);
    onCleanup(() => client.removeListener(VOICE_MOVE_REQUESTED, handler));`,
  );
  // No second, unchecked spelling of the name, and not the name AFK's dead
  // listener subscribed to (FE1-1): the SDK never emits that one.
  assert.equal(countWired(STATE_CODE, `"voiceMoveRequested"`), 1);
  assert.equal(countWired(STATE_CODE, `"userMoveVoiceChannel"`), 0);
  assert.equal(countWired(STATE_CODE, `.addListener(VOICE_MOVE_REQUESTED`), 1);
  assert.equal(countWired(STATE_CODE, `this.#handleVoiceMove(`), 1);
});

// FE2A-1 (FE0-3). A destination behind an age, password or spoiler check this
// member has not passed on this device is never joined by a move, and never
// put on the call card either: the card's Rejoin is an ordinary join that
// would walk past the check.
test("source pin (FE2A-1): a move into a gated channel leaves, says so once, and is never joined or carded", () => {
  const handler = handleMove();
  const failLoud = bodyAfter(handler, `if (decision.action === "fail-loud") {`);
  assert.ok(
    failLoud.startsWith(codeOf(`this.disconnect();`)),
    "fail-loud leaves the old call before anything else",
  );
  const head = `if (decision.reason === "gated-destination") {`;
  assert.equal(countWired(STATE_CODE, head), 1, "the gated block");
  const gatedBlock = bodyAfter(failLoud, head);
  assert.equal(countWired(gatedBlock, `this.onErr(`), 1, "its one notice");
  // The drop marker and the S-a record are retired, as `moved-elsewhere`
  // does, so a repeat of the event cannot re-run the arm.
  for (const clear of [
    `this.#lastInvoluntaryChannelId = undefined;`,
    `this.#lastInvoluntaryLeftAt = undefined;`,
    `this.#lastInvoluntaryConnNonce = undefined;`,
    `this.#replacedConnNonce = undefined;`,
    `this.#replacedLeftAt = undefined;`,
  ])
    assert.equal(countWired(gatedBlock, clear), 1, clear);
  assert.equal(countWired(gatedBlock, `#setChannel(`), 0, "a card");
  assert.equal(countWired(gatedBlock, `.connect(`), 0, "a join");
  assert.match(gatedBlock, /[;}]return$/, "the block ends in `return;`");
  // Ahead of every card the handler asserts, the fail-loud card first.
  assert.ok(
    firstAt("#handleVoiceMove", handler, head) <
      firstAt("#handleVoiceMove", handler, `this.#setChannel(destination);`),
    "the gated block comes before the first this.#setChannel(destination)",
  );
});

test("source pin (FE2A-1): the member gate refuses until VoiceContext wires the real one, synchronously", () => {
  // Fail closed: a `Voice` whose gate was never wired refuses every move.
  assertWired(
    "the default gate",
    `#memberGate: (channel: Channel) => boolean = () => true;`,
  );
  assert.equal(
    bodyOf(`setMemberGate(gate: (channel: Channel) => boolean): void {`),
    codeOf(`this.#memberGate = gate`),
    "the setter",
  );
  const writes = STATE_CODE.match(/#memberGate(\?\?|\|\||&&)?=(?!=)/g);
  assert.equal(writes?.length, 1, "writes of #memberGate past its default");
  // Right after the Voice is built, not in an effect: nothing can deliver a
  // move before it. The layout is read inside the closure, per move.
  assertWired(
    "the gate wiring",
    `const voice = new Voice(state.voice, modals, sound, (serverId) =>
      entranceSoundFor(state.settings, serverId),
    );
    voice.setMemberGate((channel) =>
      isChannelGatedForMember(
        channel,
        (key) => state.layout.getSectionState(key, false),
        LAYOUT_SECTIONS.MATURE,
      ),
    );`,
  );
  assert.equal(countWired(STATE_CODE, `setMemberGate(`), 2, "defined, called");
  // The handler asks it once, about the destination, and hands the answer to
  // the decision.
  const handler = handleMove();
  assert.equal(
    countWired(
      handler,
      `const gated = destination !== undefined && this.#memberGate(destination);`,
    ),
    1,
    "the gate question",
  );
  assert.equal(countWired(STATE_CODE, `this.#memberGate(`), 1);
  assert.equal(
    countWired(
      bodyAfter(handler, `const decision = moveDecision(`),
      `destinationGated: gated,`,
    ),
    1,
    "the answer, in moveDecision's world",
  );
});

// SEC5-1 (FE2A-4). A pre-minted token is dialled only if M3 kept it: M3 is
// the one keep/drop point, and every other path is tokenless.
test("source pin (SEC5-1): the one Room dial uses an auth that has been through M3", () => {
  const attempt = connectAttempt();
  const dial = `room.connect(auth.url, auth.token`;
  assert.equal(countWired(STATE_CODE, dial), 1, "the dial");
  assert.equal(countWired(STATE_CODE, `.connect(auth.url`), 1, "any dial");
  const switchHead = `switch (authDecision) {`;
  assert.equal(countWired(attempt, switchHead), 1, "M3's switch");
  const switchAt = firstAt("#connectAttempt", attempt, switchHead);
  const switchEnd = closerOf(attempt, switchAt + codeOf(switchHead).length - 1);
  assert.ok(
    firstAt("#connectAttempt", attempt, dial) > switchEnd,
    "the dial comes after M3's switch",
  );
  // `auth` is written twice: dropped inside M3's switch, or minted by the
  // join route. Nothing else hands the dial a token, a new local included.
  assert.deepEqual(authWritesIn(attempt), [
    `auth=undefined`,
    `auth=awaitchannel.joinCall(`,
  ]);
  assert.equal(
    countWired(attempt.slice(switchAt, switchEnd), `auth = undefined;`),
    1,
    "the drop, inside the switch",
  );
  // M3 decides once, unconditionally: a `const` at the method's top level
  // cannot sit under an `if`.
  assert.equal(countWired(STATE_CODE, `moveAuthDecision(`), 1);
  const decideAt = firstAt(
    "#connectAttempt",
    attempt,
    `const authDecision = moveAuthDecision(`,
  );
  assert.equal(braceDepthAt(attempt, decideAt), 0, "moveAuthDecision's depth");
});

test("source pin (SEC5-1): M3's join arm drops the token with its clock, and preMintedAuth is read after M3", () => {
  const attempt = connectAttempt();
  const switchHead = `switch (authDecision) {`;
  const switchAt = firstAt("#connectAttempt", attempt, switchHead);
  const switchEnd = closerOf(attempt, switchAt + codeOf(switchHead).length - 1);
  // A dropped token takes its budget with it: the attempt then mints its own
  // token after setup, like any other join.
  assert.equal(
    countWired(
      attempt.slice(switchAt, switchEnd),
      `case "join":
        auth = undefined;
        preConnectDeadlineAt = undefined;
        break;`,
    ),
    1,
    "M3's join arm",
  );
  const preMinted = `const preMintedAuth = auth !== undefined;`;
  assertWired("preMintedAuth", preMinted);
  const declaredAt = firstAt("#connectAttempt", attempt, preMinted);
  assert.ok(declaredAt > switchEnd, "preMintedAuth is taken after M3");
  assert.equal(
    attempt.indexOf("preMintedAuth"),
    declaredAt + "const".length,
    "nothing reads preMintedAuth above its declaration",
  );
});

test("source pin: the tokenless arm and the D5 retry are plain joins", () => {
  // No budget, no latch bypass and no rejoin flag: without a token nothing is
  // ticking and there is nothing to bypass a latch with.
  const handler = handleMove();
  const plain = `this.connect(destination);`;
  assert.equal(countWired(STATE_CODE, plain), 2, "plain joins in the file");
  assert.equal(countWired(handler, plain), 2, "plain joins in the handler");
  assert.equal(
    countWired(
      handler,
      `} else {
        attempt = this.connect(destination);
      }`,
    ),
    1,
    "the tokenless arm",
  );
  const retry = `try {
    joined = await this.connect(destination);
  } catch {`;
  assert.equal(countWired(handler, retry), 1, "the D5 retry");
  // The retry follows the token arm only.
  assert.equal(
    bodiesAfter(handler, `if (decision.action === "move") {`).filter(
      (body) => countWired(body, retry) === 1,
    ).length,
    1,
    "the retry, under the token arm's test",
  );
  // Three joins in all: the token arm, the tokenless arm, the retry.
  assert.equal(countWired(handler, `this.connect(`), 3);
});

test("source pin (FE2A-12): #handleVoiceMove logs fixed strings only", () => {
  // The event carries a live SFU credential, and a LiveKit error can quote
  // the signal URL, which carries it as `access_token=`.
  assertLogsOnly("#handleVoiceMove", handleMove());
});
