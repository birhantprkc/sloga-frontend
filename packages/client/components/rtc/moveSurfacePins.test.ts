// Source pins for the member surfaces a voice move starts from — run with
// Node's built-in runner, from packages/client:
//   node --test --conditions=browser components/rtc/moveSurfacePins.test.ts
// `node --test` cannot load these Solid components, so the rules live in
// `voiceMovePolicy.ts` and `src/interface/channels/memberGate.ts`, where
// their own specs hold them, and this file holds the components to CALLING
// them, and to the frozen refusal copy (FE2A-9) that the member menus and the
// sidebar's drag-to-move share. Matched as TEXT after `codeOf`
// (`sourcePins.harness.ts`), with the same known limits as
// `stateWiring.test.ts`: dead code satisfies a pin, and an equivalent rewrite
// of a pinned statement breaks one.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  assertLexesInSync,
  assertLogsOnly,
  bodiesAfter,
  codeOf,
  countWired,
} from "./sourcePins.harness.ts";

const USER_MENU_SOURCE = readFileSync(
  new URL("../app/menus/UserContextMenu.tsx", import.meta.url),
  "utf8",
);
const USER_MENU = codeOf(USER_MENU_SOURCE);

const SIDEBAR_SOURCE = readFileSync(
  new URL(
    "../../src/interface/navigation/channels/ServerSidebar.tsx",
    import.meta.url,
  ),
  "utf8",
);
const SIDEBAR = codeOf(SIDEBAR_SOURCE);

const PREVIEW_SOURCE = readFileSync(
  new URL(
    "../ui/components/features/voice/VoiceChannelPreview.tsx",
    import.meta.url,
  ),
  "utf8",
);
const PREVIEW = codeOf(PREVIEW_SOURCE);

/** The inside of the ONE block or argument list `head` opens in `code`. */
function bodyIn(file: string, code: string, head: string): string {
  const bodies = bodiesAfter(code, head);
  assert.equal(
    bodies.length,
    1,
    `${file} must contain this exactly once, found ${bodies.length}:\n` +
      codeOf(head),
  );
  return bodies[0];
}

/** A surface's refusal copy: moving someone else, and moving ourselves. */
type RefusalCopy = {
  others: Record<string, string>;
  self: Record<string, string>;
};

/**
 * FE2A-9, FROZEN: what a refused move says, by `MoveRefusalKind`, for moving
 * someone else and for moving ourselves. Both surfaces use these words, so
 * each string is one msgid.
 */
const REFUSAL_COPY: RefusalCopy = {
  others: {
    "target-cannot-view":
      "They can't see that channel, so they can't be moved there.",
    "is-bot": "Bots can't be moved between voice channels.",
    "cannot-join":
      "They can't join that call right now. It may be full, or they may not be able to connect to it.",
    "not-connected": "They're not in a voice call you can move them from.",
    "server-error": "Something went wrong on our end. Try again in a moment.",
    "not-authenticated":
      "Couldn't move them. They may have left the call, or you may not have permission.",
    other:
      "Couldn't move them. They may have left the call, or you may not have permission.",
  },
  self: {
    "target-cannot-view": "Couldn't move you to that channel.",
    "is-bot": "Couldn't move you to that channel.",
    "cannot-join":
      "You can't join that call right now. It may be full, or you may not be able to connect to it.",
    "not-connected": "You're not in a voice call you can move from.",
    "server-error": "Something went wrong on our end. Try again in a moment.",
    "not-authenticated":
      "You can only move yourself from the device that's in the call.",
    other: "Couldn't move you to that channel.",
  },
};

/**
 * The kind-to-copy map a `switch (kind) { ... }` body spells out: each run of
 * `case "kind":` labels maps to the `t` template the run returns. A `default`
 * may only guard (`never`); it may not share an arm.
 */
function copyMapOf(what: string, body: string): Record<string, string> {
  const map: Record<string, string> = {};
  let pending: string[] = [];
  for (const m of body.matchAll(
    /case"([\w-]+)":|default:|return(t`[^`]*`)?/g,
  )) {
    if (m[1] !== undefined) {
      pending.push(m[1]);
    } else if (m[0] === "default:") {
      assert.deepEqual(pending, [], `${what}: a case falls into default`);
    } else if (m[2] === undefined) {
      assert.deepEqual(pending, [], `${what}: a case returns no t template`);
    } else {
      assert.notDeepEqual(pending, [], `${what}: a return no case leads to`);
      for (const kind of pending) {
        assert.ok(!(kind in map), `${what}: "${kind}" twice`);
        map[kind] = m[2].slice(2, -1);
      }
      pending = [];
    }
  }
  assert.deepEqual(pending, [], `${what}: a case with no return`);
  return map;
}

/** UserContextMenu's copy, from its two exhaustive switches. */
function userMenuCopy(): RefusalCopy {
  const switchOf = (head: string) =>
    bodyIn(
      "UserContextMenu.tsx",
      bodyIn("UserContextMenu.tsx", USER_MENU, head),
      `switch (kind) {`,
    );
  return {
    others: copyMapOf(
      "otherMoveRefusal",
      switchOf(`function otherMoveRefusal(kind: MoveRefusalKind): string {`),
    ),
    self: copyMapOf(
      "selfMoveRefusal",
      switchOf(`function selfMoveRefusal(kind: MoveRefusalKind): string {`),
    ),
  };
}

/** ServerSidebar's copy, from `moveRefusedMessage`'s two switches. */
function sidebarCopy(): RefusalCopy {
  const message = bodyIn(
    "ServerSidebar.tsx",
    SIDEBAR,
    `function moveRefusedMessage(kind: MoveRefusalKind, isSelf: boolean) {`,
  );
  const selfBranch = bodyIn("ServerSidebar.tsx", message, `if (isSelf) {`);
  const switches = bodiesAfter(message, `switch (kind) {`);
  assert.equal(switches.length, 2, "moveRefusedMessage's two switches");
  assert.equal(
    selfBranch,
    codeOf(`switch (kind) {`) + switches[0] + "}",
    "the self branch is its switch",
  );
  return {
    others: copyMapOf("moveRefusedMessage (others)", switches[1]),
    self: copyMapOf("moveRefusedMessage (self)", switches[0]),
  };
}

test("source pin: the three surfaces lex in sync, and their comments are stripped", () => {
  assertLexesInSync("UserContextMenu.tsx", USER_MENU_SOURCE, USER_MENU, 40);
  assertLexesInSync("ServerSidebar.tsx", SIDEBAR_SOURCE, SIDEBAR, 100);
  assertLexesInSync("VoiceChannelPreview.tsx", PREVIEW_SOURCE, PREVIEW, 10);
});

test("source pin: the copy reader maps every case of a run, and refuses a stray", () => {
  assert.deepEqual(
    copyMapOf(
      "ok",
      codeOf(`case "a": return t\`A\`; case "b": case "c": return t\`B C\`;
      default: { const u: never = kind; return u; }`),
    ),
    { a: "A", b: "B C", c: "B C" },
  );
  for (const bad of [
    `case "a": return x;`,
    `case "a": default: return t\`A\`;`,
    `case "a": return t\`A\`; case "a": return t\`B\`;`,
    `case "a":`,
  ])
    assert.throws(
      () => copyMapOf("bad", codeOf(bad)),
      assert.AssertionError,
      bad,
    );
});

// --- UserContextMenu (lane B2) ----------------------------------------------

test("source pin (B2): the call-moderation subject says whether the member is a bot", () => {
  const input = bodyIn(
    "UserContextMenu.tsx",
    USER_MENU,
    `function callModerationInput() {`,
  );
  assert.equal(countWired(input, `isBot: !!props.user.bot,`), 1);
  assert.equal(countWired(USER_MENU, `isBot:`), 1, "one subject literal");
});

test("source pin (B2, D7): a self-move leaves out channels this member is gated from; a move of someone else does not", () => {
  // The voice client refuses to follow a move into a gated channel and
  // leaves the call, so offering one to ourselves only drops us. Someone
  // else's unlocks live on their own device, not in our layout.
  const targets = bodyIn(
    "UserContextMenu.tsx",
    USER_MENU,
    `function moveTargetChannels() {`,
  );
  assert.equal(
    countWired(
      targets,
      `return moveTargets(
        props.user.self
          ? channels.filter(
              (c) =>
                !isChannelGatedForMember(
                  c,
                  (k) => state.layout.getSectionState(k, false),
                  LAYOUT_SECTIONS.MATURE,
                ),
            )
          : channels,
        {`,
    ),
    1,
    "the self-only gate filter",
  );
  assert.equal(
    countWired(
      targets,
      `const channels = server.orderedChannels.flatMap(
        (category) => category.channels,
      );`,
    ),
    1,
    "the unfiltered list",
  );
  assert.equal(countWired(USER_MENU, `isChannelGatedForMember(`), 1);
  assert.equal(countWired(USER_MENU, `moveTargets(`), 1);
});

test("source pin (B2, FE2A-9): the member menu's refusal copy is the frozen map", () => {
  const copy = userMenuCopy();
  assert.deepEqual(copy.others, REFUSAL_COPY.others, "moving someone else");
  assert.deepEqual(copy.self, REFUSAL_COPY.self, "moving ourselves");
});

test("source pin (B2): a refused move logs its kind only, shows the copy for who was moved, and signs nobody out", () => {
  const failed = bodyIn(
    "UserContextMenu.tsx",
    USER_MENU,
    `function moveFailed(err: unknown, self: boolean) {`,
  );
  assert.equal(countWired(failed, `const kind = moveRefusalKind(err);`), 1);
  assert.equal(
    countWired(
      failed,
      `message: self ? selfMoveRefusal(kind) : otherMoveRefusal(kind),`,
    ),
    1,
    "the copy for who was moved",
  );
  assertLogsOnly("moveFailed", failed, ["kind"]);
  assert.equal(
    countWired(USER_MENU, `.catch((err: unknown) => moveFailed(err, self));`),
    1,
    "the move's only refusal handler",
  );
  assert.equal(countWired(USER_MENU, `moveFailed(`), 2, "defined, called");
  // A 401 here only means the self-move came from the wrong session.
  assert.equal(countWired(USER_MENU, `logout(`), 0);
});

// --- ServerSidebar (lane B3) ------------------------------------------------

test("source pin (B3): the sidebar's gate is the shared member gate, and nothing else", () => {
  assert.equal(
    bodyIn(
      "ServerSidebar.tsx",
      SIDEBAR,
      `function isGatedFor(
        state: ReturnType<typeof useState>,
        channel: Channel,
      ): boolean {`,
    ),
    codeOf(`return isChannelGatedForMember(
      channel,
      (key) => state.layout.getSectionState(key, false),
      LAYOUT_SECTIONS.MATURE,
    )`),
    "isGatedFor's whole body",
  );
  assert.equal(countWired(SIDEBAR, `isChannelGatedForMember(`), 1);
  // The helpers memberGate.ts composes are not called here beside it.
  assert.equal(countWired(SIDEBAR, `gateSource(`), 0);
  assert.equal(countWired(SIDEBAR, `isChannelGated(`), 0);
});

test("source pin (B3): a refused drag-to-move logs its kind only and shows the shared copy", () => {
  const drop = bodyIn(
    "ServerSidebar.tsx",
    SIDEBAR,
    `function onVoiceMoveDrop(e: DragEvent) {`,
  );
  const refused = bodyIn(
    "ServerSidebar.tsx",
    drop,
    `.catch((err: unknown) => {`,
  );
  assert.equal(countWired(refused, `const kind = moveRefusalKind(err);`), 1);
  assert.equal(
    countWired(
      refused,
      `snackbar.show({ message: moveRefusedMessage(kind, isSelf) });`,
    ),
    1,
    "the shared copy",
  );
  assertLogsOnly("the drop's .catch", refused, ["kind"]);
  assert.equal(countWired(SIDEBAR, `moveRefusalKind(`), 1);
});

test("source pin (B3, FE2A-9): the sidebar's refusal copy is the frozen map, word for word the member menu's", () => {
  const copy = sidebarCopy();
  assert.deepEqual(copy.others, REFUSAL_COPY.others, "moving someone else");
  assert.deepEqual(copy.self, REFUSAL_COPY.self, "moving ourselves");
  assert.deepEqual(copy, userMenuCopy(), "the two surfaces");
});

// --- VoiceChannelPreview (lane B4) ------------------------------------------

test("source pin (B4): a bot's row is never offered for dragging", () => {
  // A user not loaded yet is not known to be a bot, so the row is offered
  // and the drop reports the server's refusal.
  const line = `      isBot: !!user().user?.bot,`;
  assert.equal(
    PREVIEW_SOURCE.split("\n").filter((l) => l === line).length,
    1,
    line,
  );
  const drag = bodyIn(
    "VoiceChannelPreview.tsx",
    PREVIEW,
    `canDragParticipant(`,
  );
  assert.equal(countWired(drag, `isBot: !!user().user?.bot,`), 1);
  assert.equal(countWired(PREVIEW, `isBot:`), 1, "one isBot");
});
