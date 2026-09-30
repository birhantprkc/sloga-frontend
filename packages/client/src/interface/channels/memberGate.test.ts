// Unit spec for the shared member-gate checks — run with Node's built-in runner:
//   node --test --conditions=browser src/interface/channels/memberGate.test.ts
// Focus: `channelHasClientGate` must answer exactly as the backend's
// `Channel::has_client_gate` (the server refuses a gated AFK channel, and the
// channel settings must not offer what the server will refuse), and
// `isChannelGatedForMember` must answer exactly as the server sidebar always
// has (a thread answers to its parent; each gate needs its own unlock).
//
// The backend's marker literals are hard-coded below and pinned against the
// client's parser unconditionally. The cross-check against a backend tree is
// OPT-IN: it runs only with `SLOGA_BACKEND_DIR` set to a backend checkout
// (e.g. `SLOGA_BACKEND_DIR=/path/to/stoatchat node --test …`), and otherwise
// reports itself as SKIPPED. A gate that must prove the cross-check ran has
// to set the variable and read the skip count, not just the exit status.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import type { Channel } from "stoat.js";

import { buildDescriptionWithHash } from "../../lib/channelPassword.ts";
import { passwordGateKey, spoilerGateKey } from "./channelGates.ts";
import {
  type GateCheckChannel,
  channelHasClientGate,
  isChannelGatedForMember,
} from "./memberGate.ts";

/**
 * The backend's password markers: `CHANNEL_PASSWORD_PREFIX` /
 * `CHANNEL_PASSWORD_SUFFIX` in
 * `crates/core/database/src/models/channels/model.rs` (wave BG).
 */
const BACKEND_PREFIX = "[acupass:";
const BACKEND_SUFFIX = "]";

const MATURE = "MATURE";
const plain: GateCheckChannel = { id: "c1", isThread: false };
const flags =
  (...set: string[]) =>
  (key: string) =>
    set.includes(key);

// Compile-time pin (tsc, not node): a stoat.js `Channel` is passed straight
// into both checks, so its getters must keep these names and types.
type ChannelIsGateCheck = Channel extends GateCheckChannel ? true : false;
const channelIsGateCheck: ChannelIsGateCheck = true;

test("a stoat.js Channel is a GateCheckChannel (checked by tsc)", () => {
  assert.equal(channelIsGateCheck, true);
});

test("the client writes the password line with the backend's markers", () => {
  assert.equal(
    buildDescriptionWithHash("", "ab"),
    `${BACKEND_PREFIX}ab${BACKEND_SUFFIX}`,
  );
  assert.equal(
    buildDescriptionWithHash("notes", "ab"),
    `notes\n${BACKEND_PREFIX}ab${BACKEND_SUFFIX}`,
  );
});

// The backend's own case list (`password_gate_matches_the_client_parser` in
// channels/model.rs), verbatim.
const GATED_DESCRIPTIONS = [
  "[acupass:ab]",
  "notes\n[acupass:ab]",
  "first\nsecond\n[acupass:0123abcd]",
  `[acupass:${String.fromCodePoint(0xe9)}]`,
  "notes\r\n[acupass:ab]",
];
const UNGATED_DESCRIPTIONS = [
  "",
  // The empty hash.
  "[acupass:]",
  // Not the last line.
  "[acupass:ab]\nnotes",
  // A trailing newline makes the last line empty.
  "notes\n[acupass:ab]\n",
  "[acupass:ab]\r\n",
  // A line ending in CR does not end with the suffix.
  "[acupass:ab]\r",
  // No trimming, and the prefix is case-sensitive.
  " [acupass:ab]",
  "[acupass:ab] ",
  "[ACUPASS:ab]",
  // Half a marker.
  "[acupass:ab",
  "acupass:ab]",
];

test("a password line gates exactly as the backend parses it", () => {
  for (const description of GATED_DESCRIPTIONS) {
    const channel = { ...plain, description };
    assert.equal(
      channelHasClientGate(channel),
      true,
      `${JSON.stringify(description)} is gated`,
    );
    assert.equal(
      isChannelGatedForMember(channel, flags(), MATURE),
      true,
      `${JSON.stringify(description)} is gated for a member`,
    );
  }
  for (const description of [...UNGATED_DESCRIPTIONS, undefined]) {
    const channel = { ...plain, description };
    assert.equal(
      channelHasClientGate(channel),
      false,
      `${JSON.stringify(description)} is not gated`,
    );
    assert.equal(
      isChannelGatedForMember(channel, flags(), MATURE),
      false,
      `${JSON.stringify(description)} is not gated for a member`,
    );
  }
});

test("the empty hash is not a password", () => {
  const channel = { ...plain, description: "[acupass:]" };
  assert.equal(channelHasClientGate(channel), false);
  assert.equal(isChannelGatedForMember(channel, flags(), MATURE), false);
});

test("a trailing newline or a CR-terminated line is not a password", () => {
  for (const description of [
    "notes\n[acupass:ab]\n",
    "[acupass:ab]\r\n",
    "[acupass:ab]\r",
  ]) {
    assert.equal(
      channelHasClientGate({ ...plain, description }),
      false,
      JSON.stringify(description),
    );
  }
});

test("the password marker is case-sensitive", () => {
  assert.equal(
    channelHasClientGate({ ...plain, description: "[ACUPASS:ab]" }),
    false,
  );
  assert.equal(
    channelHasClientGate({ ...plain, description: "[Acupass:ab]" }),
    false,
  );
  assert.equal(
    channelHasClientGate({ ...plain, description: "[acupass:AB]" }),
    true,
    "the hash itself may be any case",
  );
});

test("each gate alone makes a channel gated; none leaves it open", () => {
  assert.equal(channelHasClientGate(plain), false);
  assert.equal(
    channelHasClientGate({ ...plain, mature: false, isSpoiler: false }),
    false,
  );
  assert.equal(channelHasClientGate({ ...plain, mature: true }), true);
  assert.equal(channelHasClientGate({ ...plain, isSpoiler: true }), true);
  assert.equal(
    channelHasClientGate({ ...plain, description: "[acupass:ab]" }),
    true,
  );
  assert.equal(
    channelHasClientGate({ ...plain, description: "just notes" }),
    false,
  );
});

test("a thread is gated, whatever its parent (fails closed)", () => {
  const openParent: GateCheckChannel = { id: "forum", isThread: false };
  assert.equal(
    channelHasClientGate({ id: "post", isThread: true, parent: openParent }),
    true,
    "a thread under an ungated parent",
  );
  assert.equal(
    channelHasClientGate({ id: "orphan", isThread: true }),
    true,
    "a thread whose parent is not loaded",
  );
  assert.equal(
    channelHasClientGate({
      id: "post",
      isThread: true,
      mature: false,
      isSpoiler: false,
      description: "",
    }),
    true,
    "a thread's own (empty) flags do not open it",
  );
});

test("a member's gate check reads each gate's own unlock", () => {
  const all = {
    ...plain,
    mature: true,
    isSpoiler: true,
    description: "[acupass:ab]",
  };
  assert.equal(isChannelGatedForMember(all, flags(), MATURE), true);
  assert.equal(
    isChannelGatedForMember(
      all,
      flags(MATURE, passwordGateKey("c1"), spoilerGateKey("c1")),
      MATURE,
    ),
    false,
  );
  assert.equal(
    isChannelGatedForMember(
      all,
      flags(MATURE, passwordGateKey("other"), spoilerGateKey("c1")),
      MATURE,
    ),
    true,
    "another channel's password unlock does not count",
  );
  assert.equal(
    isChannelGatedForMember(
      all,
      flags("OTHER_MATURE", passwordGateKey("c1"), spoilerGateKey("c1")),
      MATURE,
    ),
    true,
    "the age gate reads the key it is given",
  );
  assert.equal(
    isChannelGatedForMember(
      { ...plain, mature: true },
      flags("OTHER_MATURE"),
      "OTHER_MATURE",
    ),
    false,
  );
});

test("a thread answers to its parent's gates and unlocks", () => {
  const forum: GateCheckChannel = {
    id: "forum",
    isThread: false,
    description: "rules\n[acupass:ab]",
  };
  const post: GateCheckChannel = { id: "post", isThread: true, parent: forum };
  assert.equal(
    isChannelGatedForMember(post, flags(), MATURE),
    true,
    "the parent's password gates its thread",
  );
  assert.equal(
    isChannelGatedForMember(post, flags(passwordGateKey("post")), MATURE),
    true,
    "the thread's own key does not unlock it",
  );
  assert.equal(
    isChannelGatedForMember(post, flags(passwordGateKey("forum")), MATURE),
    false,
    "unlocking the parent unlocks its thread",
  );

  const matureForum: GateCheckChannel = {
    id: "forum",
    isThread: false,
    mature: true,
  };
  assert.equal(
    isChannelGatedForMember(
      { id: "post", isThread: true, parent: matureForum },
      flags(),
      MATURE,
    ),
    true,
  );
  assert.equal(
    isChannelGatedForMember(
      { id: "post", isThread: true, parent: matureForum },
      flags(MATURE),
      MATURE,
    ),
    false,
  );

  const spoilerForum: GateCheckChannel = {
    id: "forum",
    isThread: false,
    isSpoiler: true,
  };
  const spoilerPost = { id: "post", isThread: true, parent: spoilerForum };
  assert.equal(isChannelGatedForMember(spoilerPost, flags(), MATURE), true);
  assert.equal(
    isChannelGatedForMember(spoilerPost, flags(spoilerGateKey("post")), MATURE),
    true,
    "the thread's own spoiler key does not reveal it",
  );
  assert.equal(
    isChannelGatedForMember(
      spoilerPost,
      flags(spoilerGateKey("forum")),
      MATURE,
    ),
    false,
  );

  const openForum: GateCheckChannel = { id: "forum", isThread: false };
  assert.equal(
    isChannelGatedForMember(
      { id: "post", isThread: true, parent: openForum, mature: true },
      flags(),
      MATURE,
    ),
    false,
    "a thread's own flags are not read while its parent is loaded",
  );
});

test("a thread whose parent is not loaded answers to itself", () => {
  const orphan: GateCheckChannel = {
    id: "orphan",
    isThread: true,
    isSpoiler: true,
  };
  assert.equal(isChannelGatedForMember(orphan, flags(), MATURE), true);
  assert.equal(
    isChannelGatedForMember(orphan, flags(spoilerGateKey("orphan")), MATURE),
    false,
  );
  assert.equal(
    isChannelGatedForMember({ id: "orphan", isThread: true }, flags(), MATURE),
    false,
  );
});

test("every combination of gates and unlocks, plain and threaded", () => {
  let cases = 0;
  for (let gates = 0; gates < 8; gates++) {
    const mature = (gates & 1) !== 0;
    const isSpoiler = (gates & 2) !== 0;
    const password = (gates & 4) !== 0;
    const source: GateCheckChannel = {
      id: "src",
      isThread: false,
      mature,
      isSpoiler,
      description: password ? "notes\n[acupass:ab]" : "notes",
    };
    const thread: GateCheckChannel = {
      id: "thread",
      isThread: true,
      parent: source,
    };
    assert.equal(
      channelHasClientGate(source),
      gates !== 0,
      `any gate at all (gates=${gates})`,
    );
    assert.equal(
      channelHasClientGate(source),
      isChannelGatedForMember(source, flags(), MATURE),
      `with nothing unlocked the two checks agree (gates=${gates})`,
    );
    for (let unlocks = 0; unlocks < 8; unlocks++) {
      const keys: string[] = [];
      if (unlocks & 1) keys.push(MATURE);
      if (unlocks & 2) keys.push(spoilerGateKey("src"));
      if (unlocks & 4) keys.push(passwordGateKey("src"));
      const expected =
        (mature && !(unlocks & 1)) ||
        (isSpoiler && !(unlocks & 2)) ||
        (password && !(unlocks & 4));
      for (const channel of [source, thread]) {
        assert.equal(
          isChannelGatedForMember(channel, flags(...keys), MATURE),
          expected,
          `${channel.id} gates=${gates} unlocks=${unlocks}`,
        );
        cases++;
      }
    }
  }
  assert.equal(cases, 128);
});

// OPT-IN cross-check against a backend checkout. The hard-coded BACKEND_*
// literals above are the pin and run unconditionally; this only re-reads them
// from a backend tree the caller names in `SLOGA_BACKEND_DIR`. There is no
// default path: a default pointing at a personal worktree would skip forever
// once that worktree is gone, and a skip reads as a pass. Unset, it SKIPS and
// says which variable to set. Set to a path that is not a backend tree, it
// FAILS: an explicit request is never quietly ignored.
const BACKEND_DIR = process.env.SLOGA_BACKEND_DIR;

test("the password markers match the backend tree", (t) => {
  if (BACKEND_DIR === undefined || BACKEND_DIR === "") {
    t.skip(
      "backend cross-check not run: set SLOGA_BACKEND_DIR to a backend checkout to run it (the literal pins above ran regardless)",
    );
    return;
  }
  const file = `${BACKEND_DIR}/crates/core/database/src/models/channels/model.rs`;
  assert.ok(
    existsSync(file),
    `SLOGA_BACKEND_DIR=${BACKEND_DIR} is not a backend tree: ${file} is missing`,
  );
  const source = readFileSync(file, "utf8");
  for (const [name, expected] of [
    ["CHANNEL_PASSWORD_PREFIX", BACKEND_PREFIX],
    ["CHANNEL_PASSWORD_SUFFIX", BACKEND_SUFFIX],
  ]) {
    const declarations = [
      ...source.matchAll(
        new RegExp(`^pub const ${name}: &str = "([^"\\\\]*)";$`, "gm"),
      ),
    ];
    assert.equal(
      declarations.length,
      1,
      `backend declares \`pub const ${name}: &str = "…";\` ${declarations.length} times, expected once`,
    );
    assert.equal(declarations[0][1], expected, `backend ${name}`);
  }
});
