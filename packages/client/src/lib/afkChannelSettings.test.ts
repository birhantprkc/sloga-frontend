// Unit spec for the AFK-channel configuration surfaces (AFK plan A8/A9,
// 2026-09-21).
//   node --test --conditions=browser src/lib/afkChannelSettings.test.ts
//
// Focus: the preset list is exactly what the backend accepts, the effective
// timeout is never invented from nothing, and — the reason this file exists —
// the CLEAR payload travels in the remove array. A clear written as
// `afk_channel_id: null` is a silent no-op against the backend: it answers 200
// and changes nothing, so no amount of clicking reveals it.
//
// 🔴 Every assertion calls the production function. Nothing here re-types the
// rule it is checking — a spec that restates the logic passes a revert. The
// source scans at the bottom pin the same property for the JSX, which cannot
// be imported here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AFK_TIMEOUT_FALLBACK,
  AFK_TIMEOUT_PRESETS,
  afkCreateChannelFields,
  afkDesignationEdit,
  afkTimeoutEdit,
  effectiveAfkTimeout,
  isAfkTimeoutPreset,
} from "./afkChannelSettings.ts";

const CHANNEL = "01JAFKCHANNELAAAAAAAAAAAAA";
const OTHER = "01JOTHERCHANNELAAAAAAAAAAA";

test("the presets are exactly the five the backend accepts, in seconds", () => {
  // 🔴 Pinned literally against the route allow-list. The backend rejects
  // anything outside this set rather than clamping, so an extra entry here is
  // a 400 the user cannot explain and a missing one is a feature they cannot
  // reach. Seconds, not minutes: 1/5/15/30/60 minutes.
  assert.deepEqual([...AFK_TIMEOUT_PRESETS], [60, 300, 900, 1800, 3600]);
});

test("preset membership accepts every preset and nothing else", () => {
  for (const preset of AFK_TIMEOUT_PRESETS) {
    assert.equal(isAfkTimeoutPreset(preset), true);
  }
  for (const bad of [0, 30, 120, 7200, -60, 3599, Number.NaN]) {
    assert.equal(isAfkTimeoutPreset(bad), false);
  }
  assert.equal(isAfkTimeoutPreset(undefined), false);
  assert.equal(isAfkTimeoutPreset(null), false);
});

test("the fallback is itself a preset", () => {
  // A fallback outside the allow-list would 400 on the very first designation
  // made on a server that had never set a timeout — that is every server.
  assert.equal(isAfkTimeoutPreset(AFK_TIMEOUT_FALLBACK), true);
});

test("the effective timeout adopts what the server already holds", () => {
  // This is the review condition: designating without a timeout makes the
  // server keep the one it had, possibly chosen for another channel. The UI
  // has to show that value, so it has to be able to compute it.
  assert.equal(effectiveAfkTimeout(1800), 1800);
  assert.equal(effectiveAfkTimeout(60), 60);
});

test("the effective timeout falls back when the server holds nothing usable", () => {
  assert.equal(effectiveAfkTimeout(undefined), AFK_TIMEOUT_FALLBACK);
  assert.equal(effectiveAfkTimeout(null), AFK_TIMEOUT_FALLBACK);
  // A value the server somehow holds but the route would now reject must not
  // be echoed straight back into a PATCH.
  assert.equal(effectiveAfkTimeout(45), AFK_TIMEOUT_FALLBACK);
});

test("designating sends the channel id and the shown timeout together", () => {
  const payload = afkDesignationEdit({
    designate: true,
    channelId: CHANNEL,
    timeoutSeconds: 900,
  });
  assert.deepEqual(payload, { afk_channel_id: CHANNEL, afk_timeout: 900 });
});

test("designating never also removes — the backend refuses both at once", () => {
  const payload = afkDesignationEdit({
    designate: true,
    channelId: CHANNEL,
    timeoutSeconds: 900,
  });
  assert.equal("remove" in payload, false);
});

test("designating with an unusable timeout sends the fallback, not the junk", () => {
  const payload = afkDesignationEdit({
    designate: true,
    channelId: CHANNEL,
    timeoutSeconds: 45,
  });
  assert.deepEqual(payload, {
    afk_channel_id: CHANNEL,
    afk_timeout: AFK_TIMEOUT_FALLBACK,
  });
});

test("🔴 clearing travels in the remove array, never as a null field", () => {
  // THE test in this file. `afk_channel_id: null` in a PartialServer is
  // assigned with `replace()`, so the backend accepts it, answers 200 and
  // changes nothing — the designation stays, the AFK mute stays, and the UI
  // reports success. Only the remove array actually clears it.
  const payload = afkDesignationEdit({
    designate: false,
    channelId: CHANNEL,
    timeoutSeconds: 900,
  });
  assert.deepEqual(payload, { remove: ["AfkChannel"] });
});

test("clearing carries no afk_channel_id key at all, not even undefined", () => {
  // A key present with `undefined` survives a spread and can be serialised as
  // null by some paths; the clear arm must be structurally free of it.
  const payload = afkDesignationEdit({
    designate: false,
    channelId: CHANNEL,
    timeoutSeconds: 900,
  });
  assert.equal("afk_channel_id" in payload, false);
  assert.equal("afk_timeout" in payload, false);
  assert.equal(
    Object.keys(payload).length,
    1,
    "the clear payload grew a field — a set alongside a remove is refused",
  );
});

test("clearing names only AfkChannel — the backend appends AfkTimeout", () => {
  const payload = afkDesignationEdit({
    designate: false,
    channelId: CHANNEL,
    timeoutSeconds: 900,
  });
  assert.deepEqual((payload as { remove: readonly string[] }).remove, [
    "AfkChannel",
  ]);
});

test("a timeout-only edit is refused when no channel is designated", () => {
  // 🔴 `afk_timeout` is meaningless with no AFK channel and the backend says
  // so with a 400. Sending it anyway turns a harmless select into an error.
  assert.equal(
    afkTimeoutEdit({
      afkChannelId: undefined,
      channelId: CHANNEL,
      timeoutSeconds: 900,
    }),
    undefined,
  );
});

test("a timeout-only edit is refused from a channel that is not the AFK one", () => {
  // Channel settings speak for their own channel. Editing the timeout from a
  // page that is not the designated channel would silently retune a channel
  // the user is not looking at.
  assert.equal(
    afkTimeoutEdit({
      afkChannelId: OTHER,
      channelId: CHANNEL,
      timeoutSeconds: 900,
    }),
    undefined,
  );
});

test("a timeout-only edit sends just the timeout for the designated channel", () => {
  assert.deepEqual(
    afkTimeoutEdit({
      afkChannelId: CHANNEL,
      channelId: CHANNEL,
      timeoutSeconds: 1800,
    }),
    { afk_timeout: 1800 },
  );
});

test("a timeout-only edit refuses a value outside the presets", () => {
  assert.equal(
    afkTimeoutEdit({
      afkChannelId: CHANNEL,
      channelId: CHANNEL,
      timeoutSeconds: 7200,
    }),
    undefined,
  );
});

test("create-channel sends the AFK fields only for a Voice channel", () => {
  assert.deepEqual(
    afkCreateChannelFields({
      channelType: "Voice",
      afk: true,
      timeoutSeconds: 3600,
    }),
    { afk: true, afk_timeout: 3600 },
  );
});

test("create-channel drops the AFK fields on a non-Voice type", () => {
  // 🔴 The route rejects `afk: true` on anything but Voice. A user who ticks
  // the box and then switches the radio back must not get a 400.
  for (const channelType of ["Text", "Forum", "", "voice"]) {
    assert.deepEqual(
      afkCreateChannelFields({ channelType, afk: true, timeoutSeconds: 3600 }),
      {},
      `${channelType} channels must not carry the AFK flag`,
    );
  }
});

test("create-channel sends nothing when the box is not ticked", () => {
  assert.deepEqual(
    afkCreateChannelFields({
      channelType: "Voice",
      afk: false,
      timeoutSeconds: 3600,
    }),
    {},
  );
});

// --- Source scans -----------------------------------------------------------
//
// The JSX cannot be imported here (Solid, lingui macros, stoat.js). These scans
// pin that the surfaces CALL the functions above rather than re-implementing
// them, and that the select options are exactly the presets. They are textual
// and therefore blunt; they are not a substitute for a logged-in click-through,
// which is the only thing that can prove the section renders at all.

const CREATE_CHANNEL = readFileSync(
  new URL("../../components/modal/modals/CreateChannel.tsx", import.meta.url),
  "utf8",
);

const CHANNEL_OVERVIEW = readFileSync(
  new URL(
    "../../components/app/interface/settings/channel/Overview.tsx",
    import.meta.url,
  ),
  "utf8",
);

const SERVER_SIDEBAR = readFileSync(
  new URL(
    "../interface/navigation/channels/ServerSidebar.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("the create-channel modal calls the shared mapper, not a literal", () => {
  assert.ok(
    CREATE_CHANNEL.includes("afkCreateChannelFields("),
    "CreateChannel.tsx no longer calls afkCreateChannelFields — the mapping was inlined or dropped",
  );
});

test("channel settings call the shared designation and timeout mappers", () => {
  for (const fn of ["afkDesignationEdit(", "afkTimeoutEdit("]) {
    assert.ok(
      CHANNEL_OVERVIEW.includes(fn),
      `Overview.tsx no longer calls ${fn} — the mapping was inlined or dropped`,
    );
  }
});

/**
 * Crude comment stripper. The null-pointer scan below has to read code, not
 * prose: both surfaces carry a comment explaining why `afk_channel_id: null`
 * is forbidden, and a scan that cannot tell the warning from the offence fires
 * on its own documentation. The JSX marker scan deliberately does NOT use this
 * — its marker lives inside a `{/* … *\/}` comment.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

test("🔴 no surface writes a null AFK pointer", () => {
  // The silent-no-op shape, banned by construction above and banned textually
  // here so it cannot creep back in beside the mapper.
  for (const [name, source] of [
    ["CreateChannel.tsx", CREATE_CHANNEL],
    ["Overview.tsx", CHANNEL_OVERVIEW],
  ] as const) {
    assert.equal(
      /afk_channel_id\s*:\s*(null|undefined)/.test(stripComments(source)),
      false,
      `${name} clears the AFK channel with a null field — that is a 200 that changes nothing`,
    );
  }
});

test("both selects offer exactly the preset timeouts and nothing else", () => {
  // Written as literal MenuItems to match the slowmode select this copies, so
  // the list can drift from AFK_TIMEOUT_PRESETS without any type error. This
  // is the scan that notices. Each surface marks its block with the comment
  // "AFK_TIMEOUT_PRESETS contract" so the scan cannot pick up the slowmode
  // options that sit a few lines away in the same file.
  for (const [name, source] of [
    ["CreateChannel.tsx", CREATE_CHANNEL],
    ["Overview.tsx", CHANNEL_OVERVIEW],
  ] as const) {
    const block = source.split("AFK_TIMEOUT_PRESETS contract")[1];
    assert.ok(
      block,
      `${name} lost the marked AFK timeout option block — the scan cannot see it`,
    );
    // No truncation: the marked block is the last numeric-valued select in
    // each file, so an EXTRA option would be caught too, not just a missing
    // one. If a later numeric select is ever added below it, this breaks
    // loudly rather than going quiet.
    const offered = [...block.matchAll(/<MenuItem value="(\d+)">/g)].map(
      (match) => Number(match[1]),
    );
    assert.deepEqual(
      offered,
      [...AFK_TIMEOUT_PRESETS],
      `the AFK timeout select in ${name} drifted from AFK_TIMEOUT_PRESETS`,
    );
  }
});

test("the sidebar icon reads the designation, not the channel name", () => {
  // The shipped bug: `name?.toLowerCase() === "afk"`. Renaming any channel to
  // "afk" granted the icon; renaming the real one took it away.
  // Comments stripped: the replacement carries a doc comment quoting the old
  // expression, and a scan that cannot tell the warning from the offence fires
  // on its own documentation.
  assert.equal(
    /name\?\.toLowerCase\(\)\s*===\s*"afk"/.test(stripComments(SERVER_SIDEBAR)),
    false,
    "ServerSidebar.tsx still keys the AFK mic icon off the channel name",
  );
  assert.ok(
    SERVER_SIDEBAR.includes("isAfkChannel("),
    "ServerSidebar.tsx no longer calls isAfkChannel — the designation check was inlined or dropped",
  );
});
