// Unit spec for the AFK idle beacon's client rules (AFK plan Wave 5b-2, B2).
//   node --test --conditions=browser components/rtc/idlePolicy.test.ts
//
// Focus: the claim is made AT the server's timeout and not one millisecond
// before (P2-4: no lead, no floor); a tick gap is missing evidence and never
// idle time (and withdraws a standing claim, P2-18); anything not provably
// armed is disarmed; the refresh cadence; `idle_for` is a whole, non-negative
// number of seconds (P2-18); only `IsBot` and `NotAVoiceChannel` latch a
// connection off outright (P2-6).
//
// 🔴 Every assertion calls the production function. Nothing here re-types the
// rule it is checking — a spec that restates the logic passes a revert.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  type IdleAction,
  type IdleWorld,
  afkIdleArmed,
  IDLE_LATCH_ERRORS,
  IDLE_MAX_CONSECUTIVE_FAILURES,
  IDLE_MAX_TICK_GAP_MS,
  IDLE_REFRESH_MS,
  IDLE_TICK_MS,
  idleFailureDisposition,
  idleForSeconds,
  idleStep,
} from "./idlePolicy.ts";

const AFK = "01JAFKCHANNELAAAAAAAAAAAAA";

/** An arbitrary monotonic-clock origin, far from 0 so no case sits on it. */
const T0 = 10_000_000;

/**
 * An ARMED world, one tick after the previous one, with the user active at
 * `now`. Each case overrides only what it is about.
 */
function world(over: Partial<IdleWorld> = {}): IdleWorld {
  return {
    now: T0,
    lastTickAt: T0 - IDLE_TICK_MS,
    lastActivityAt: T0,
    continuousActive: false,
    connected: true,
    isAfkChannel: false,
    afkChannelId: AFK,
    afkTimeoutSeconds: 60,
    posted: false,
    lastPostAt: undefined,
    ...over,
  };
}

/** A world idle for exactly `ms` milliseconds. */
const idleFor = (ms: number, over: Partial<IdleWorld> = {}) =>
  world({ lastActivityAt: T0 - ms, ...over });

// --- Constants --------------------------------------------------------------

test("the idle constants are the pinned values", () => {
  // The server's claim TTL is 180 s (`AFK_SINCE_TTL_SECS`); the refresh has
  // to sit well inside it, and the tick well inside the refresh.
  assert.equal(IDLE_TICK_MS, 5_000);
  assert.equal(IDLE_REFRESH_MS, 60_000);
  assert.equal(IDLE_MAX_TICK_GAP_MS, 150_000);
  assert.equal(IDLE_MAX_CONSECUTIVE_FAILURES, 3);
});

// --- The threshold: at the timeout, never before it (P2-4) ------------------

test("a 60 s timeout claims at 60 000 ms and not at 59 999", () => {
  assert.deepEqual(idleStep(idleFor(60_000)), {
    lastActivityAt: T0 - 60_000,
    action: "post-idle",
  });
  assert.deepEqual(idleStep(idleFor(59_999)), {
    lastActivityAt: T0 - 59_999,
    action: "none",
  });
});

test("a 3600 s timeout claims at 3 600 000 ms and not at 3 599 999 — no lead", () => {
  // 🔴 An early claim turns every lost "active again" DELETE in the lead
  // window into moving an active user; the server's 180 s TTL does not bound
  // that. The claim waits for the whole timeout, however long.
  const at = { afkTimeoutSeconds: 3600 };
  assert.equal(idleStep(idleFor(3_600_000, at)).action, "post-idle");
  assert.equal(idleStep(idleFor(3_599_999, at)).action, "none");
});

test("every timeout choice claims exactly at its own length — no lead, no floor", () => {
  // Discord's set (`AFK_TIMEOUT_CHOICES`) plus two off-list values: the
  // client applies no minimum of its own; the server decides what it honors.
  for (const seconds of [1, 30, 60, 300, 900, 1800, 3600]) {
    const at = { afkTimeoutSeconds: seconds };
    assert.equal(
      idleStep(idleFor(seconds * 1000, at)).action,
      "post-idle",
      `${seconds} s did not claim at ${seconds * 1000} ms`,
    );
    assert.equal(
      idleStep(idleFor(seconds * 1000 - 1, at)).action,
      "none",
      `${seconds} s claimed 1 ms early`,
    );
  }
});

test("a first tick (no previous tick) still claims on time", () => {
  assert.equal(
    idleStep(idleFor(60_000, { lastTickAt: undefined })).action,
    "post-idle",
  );
});

// --- Arming -----------------------------------------------------------------

const DISARMED: [string, Partial<IdleWorld>][] = [
  ["not connected", { connected: false }],
  ["in the AFK channel", { isAfkChannel: true }],
  ["no AFK channel designated", { afkChannelId: undefined }],
  ["empty AFK channel id", { afkChannelId: "" }],
  ["no timeout", { afkTimeoutSeconds: undefined }],
  ["zero timeout", { afkTimeoutSeconds: 0 }],
  ["negative timeout", { afkTimeoutSeconds: -60 }],
  ["NaN timeout", { afkTimeoutSeconds: Number.NaN }],
  ["infinite timeout", { afkTimeoutSeconds: Number.POSITIVE_INFINITY }],
  [
    "negative infinite timeout",
    { afkTimeoutSeconds: Number.NEGATIVE_INFINITY },
  ],
];

test("afkIdleArmed is true for the armed world and false for each missing precondition", () => {
  assert.equal(afkIdleArmed(world()), true);
  for (const [why, over] of DISARMED) {
    assert.equal(afkIdleArmed(world(over)), false, `armed although ${why}`);
  }
});

test("a disarmed world never claims, however long the user has been idle", () => {
  // Idle for ten hours: were any precondition ignored, this would post.
  for (const [why, over] of DISARMED) {
    assert.deepEqual(
      idleStep(idleFor(36_000_000, over)),
      { lastActivityAt: T0, action: "none" },
      `${why}: expected the clock restarted and no action`,
    );
  }
});

test("disarming while a claim is posted withdraws it", () => {
  // Entering the AFK channel, a designation removed, the timeout cleared,
  // or the connection lost: a standing claim must not outlive its premise.
  for (const [why, over] of DISARMED) {
    assert.deepEqual(
      idleStep(
        idleFor(36_000_000, { posted: true, lastPostAt: T0 - 1, ...over }),
      ),
      { lastActivityAt: T0, action: "clear-idle" },
      `${why}: a posted claim was not withdrawn`,
    );
  }
});

// --- A gap is missing evidence, never idle time -----------------------------

test("a tick gap longer than IDLE_MAX_TICK_GAP_MS restarts the idle clock", () => {
  // Idle long enough to claim, but the previous tick was 150 001 ms ago: the
  // client was suspended or throttled and saw nothing in between.
  const gap = { lastTickAt: T0 - IDLE_MAX_TICK_GAP_MS - 1 };
  assert.deepEqual(idleStep(idleFor(600_000, gap)), {
    lastActivityAt: T0,
    action: "none",
  });
});

test("a gap while a claim is posted withdraws it (P2-18)", () => {
  const gap = { lastTickAt: T0 - IDLE_MAX_TICK_GAP_MS - 1 };
  assert.deepEqual(
    idleStep(idleFor(600_000, { ...gap, posted: true, lastPostAt: T0 - 1 })),
    { lastActivityAt: T0, action: "clear-idle" },
  );
});

test("a gap of exactly IDLE_MAX_TICK_GAP_MS is not a gap", () => {
  const edge = { lastTickAt: T0 - IDLE_MAX_TICK_GAP_MS };
  assert.deepEqual(idleStep(idleFor(600_000, edge)), {
    lastActivityAt: T0 - 600_000,
    action: "post-idle",
  });
});

// --- Continuous activity ----------------------------------------------------

test("continuous activity restarts the idle clock", () => {
  assert.deepEqual(idleStep(idleFor(600_000, { continuousActive: true })), {
    lastActivityAt: T0,
    action: "none",
  });
});

test("continuous activity while a claim is posted withdraws it", () => {
  assert.deepEqual(
    idleStep(
      idleFor(600_000, {
        continuousActive: true,
        posted: true,
        lastPostAt: T0 - 1,
      }),
    ),
    { lastActivityAt: T0, action: "clear-idle" },
  );
});

// --- Refresh cadence --------------------------------------------------------

test("a posted claim is refreshed at exactly IDLE_REFRESH_MS, not before", () => {
  const posted = { posted: true };
  assert.deepEqual(
    idleStep(idleFor(600_000, { ...posted, lastPostAt: T0 - IDLE_REFRESH_MS })),
    { lastActivityAt: T0 - 600_000, action: "refresh-idle" },
  );
  assert.deepEqual(
    idleStep(
      idleFor(600_000, { ...posted, lastPostAt: T0 - IDLE_REFRESH_MS + 1 }),
    ),
    { lastActivityAt: T0 - 600_000, action: "none" },
  );
});

test("a posted claim with no recorded post time is refreshed", () => {
  assert.equal(
    idleStep(idleFor(600_000, { posted: true, lastPostAt: undefined })).action,
    "refresh-idle",
  );
});

// --- Activity after a post --------------------------------------------------

test("activity after a post withdraws the claim and keeps the new activity time", () => {
  // `state.tsx` moved `lastActivityAt` forward on a discrete event; the
  // user is no longer idle for the timeout, so the claim must go.
  assert.deepEqual(
    idleStep(idleFor(10_000, { posted: true, lastPostAt: T0 - 20_000 })),
    { lastActivityAt: T0 - 10_000, action: "clear-idle" },
  );
});

test("an active, unposted world does nothing and keeps its clock", () => {
  assert.deepEqual(idleStep(idleFor(10_000)), {
    lastActivityAt: T0 - 10_000,
    action: "none",
  });
});

// --- A simulated call -------------------------------------------------------

test("driven tick by tick, the first claim lands on the timeout and refreshes on cadence", () => {
  // The caller's half of the contract, played out: posted/lastPostAt follow
  // the action. Ticks every IDLE_TICK_MS from the last activity.
  const start = T0;
  let w = world({ now: start, lastTickAt: undefined, lastActivityAt: start });
  const seen: [number, IdleAction][] = [];
  for (let now = start; now <= start + 200_000; now += IDLE_TICK_MS) {
    w = { ...w, now };
    const step = idleStep(w);
    if (step.action !== "none") seen.push([now - start, step.action]);
    const posting =
      step.action === "post-idle" || step.action === "refresh-idle";
    w = {
      ...w,
      lastTickAt: now,
      lastActivityAt: step.lastActivityAt,
      posted: posting ? true : step.action === "clear-idle" ? false : w.posted,
      lastPostAt: posting ? now : w.lastPostAt,
    };
  }
  assert.deepEqual(seen, [
    [60_000, "post-idle"],
    [120_000, "refresh-idle"],
    [180_000, "refresh-idle"],
  ]);
});

// --- idle_for (P2-18) -------------------------------------------------------

test("idleForSeconds rounds DOWN to whole seconds", () => {
  assert.equal(idleForSeconds(T0, T0), 0);
  assert.equal(idleForSeconds(T0 + 999, T0), 0);
  assert.equal(idleForSeconds(T0 + 1000, T0), 1);
  // 1.999 s: `Math.round` would say 2 — overstating idleness by a second.
  assert.equal(idleForSeconds(T0 + 1999, T0), 1);
  assert.equal(idleForSeconds(T0 + 59_999, T0), 59);
  assert.equal(idleForSeconds(T0 + 60_000, T0), 60);
  assert.equal(idleForSeconds(T0 + 3_600_000, T0), 3600);
});

test("idleForSeconds is an integer and never negative", () => {
  // Activity recorded after `now` (a clock step, or an event stamped late)
  // must not put a negative number on the wire — the server takes a u32.
  assert.equal(idleForSeconds(T0, T0 + 1), 0);
  assert.equal(idleForSeconds(T0, T0 + 5_000), 0);
  assert.ok(Object.is(idleForSeconds(T0, T0 + 500), 0), "returned -0");
  for (const ms of [0, 1, 499, 500, 1500, 2500, 61_234, 3_599_999]) {
    const s = idleForSeconds(T0 + ms, T0);
    assert.ok(Number.isInteger(s) && s >= 0, `${ms} ms gave ${s}`);
  }
});

test("idleForSeconds reads a non-finite result as 0, never NaN", () => {
  assert.equal(idleForSeconds(Number.NaN, T0), 0);
  assert.equal(idleForSeconds(Number.POSITIVE_INFINITY, T0), 0);
});

// --- Failure disposition (P2-6) ---------------------------------------------

test("the latch set is exactly IsBot and NotAVoiceChannel", () => {
  assert.deepEqual([...IDLE_LATCH_ERRORS], ["IsBot", "NotAVoiceChannel"]);
});

test("IsBot and NotAVoiceChannel latch on the first failure", () => {
  assert.equal(idleFailureDisposition("IsBot", 0), "latch");
  assert.equal(idleFailureDisposition("IsBot", 1), "latch");
  assert.equal(idleFailureDisposition("NotAVoiceChannel", 0), "latch");
  assert.equal(idleFailureDisposition("NotAVoiceChannel", 1), "latch");
});

test("every other failure backs off until the consecutive limit, then latches", () => {
  // 🔴 `NotInVoiceChannel` is the ingress-webhook race and `InvalidOperation`
  // a config change mid-tick: latching either would silently exempt a user
  // from auto-move for the rest of the call.
  for (const type of [
    undefined,
    "",
    "NotInVoiceChannel",
    "InvalidOperation",
    "MissingPermission",
    "TooManyRequests",
    "isbot",
  ]) {
    for (let n = 0; n < IDLE_MAX_CONSECUTIVE_FAILURES; n++) {
      assert.equal(
        idleFailureDisposition(type, n),
        "backoff",
        `${String(type)} after ${n} failures`,
      );
    }
    assert.equal(
      idleFailureDisposition(type, IDLE_MAX_CONSECUTIVE_FAILURES),
      "latch",
      `${String(type)} did not latch at the limit`,
    );
    assert.equal(
      idleFailureDisposition(type, IDLE_MAX_CONSECUTIVE_FAILURES + 1),
      "latch",
    );
  }
});

// --- The module itself ------------------------------------------------------

const POLICY = readFileSync(
  new URL("./idlePolicy.ts", import.meta.url),
  "utf8",
);

test("idlePolicy.ts is dependency-free", () => {
  assert.ok(
    !/^\s*import\b/m.test(POLICY),
    "idlePolicy.ts imports something — it must stay runnable under node --test alone",
  );
});

// --- Textual contract against state.tsx -------------------------------------
//
// `state.tsx` cannot be instantiated here (Solid signals, livekit `Room`,
// stoat.js client), so the wiring that feeds `idleStep` is unreachable by
// `node --test`. These scans hold the production file to the Wave 5b-2
// contract: the world is READ from live state (never a constant), the watch
// starts and stops where the plan says, and the beacon's wire shape is the one
// the server parses. They are not a substitute for a live call.
const STATE = readFileSync(new URL("./state.tsx", import.meta.url), "utf8");

/**
 * Crude comment stripper, the same shape the sibling specs use
 * (`afkPolicy.test.ts`, `movePolicy.test.ts`): every scan reads code, not
 * prose, and `state.tsx` is entitled to quote the rules it obeys.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

const STATE_CODE = stripComments(STATE);

/**
 * The balanced `{…}` or `(…)` group that opens at `source[openAt]`, including
 * both delimiters, or `""` if it never closes. Copied from
 * `movePolicy.test.ts`: crude on purpose, it does not know about strings, so
 * it is only pointed at spans with no brace or paren inside a string literal.
 */
function balancedGroup(source: string, openAt: number): string {
  const open = source[openAt];
  const close = open === "{" ? "}" : open === "(" ? ")" : undefined;
  if (close === undefined) return "";
  let depth = 0;
  for (let i = openAt; i < source.length; i++) {
    if (source[i] === open) depth++;
    else if (source[i] === close && --depth === 0)
      return source.slice(openAt, i + 1);
  }
  return "";
}

/**
 * The body of the class member DEFINED as `name(` at class indentation (not a
 * call site), or `""`. Returns the parameter list alongside it.
 */
function member(name: string): { params: string; body: string } {
  const def = new RegExp(`\\n {2}(?:async )?${name}\\(`).exec(STATE_CODE);
  if (!def) return { params: "", body: "" };
  const parenAt = def.index + def[0].length - 1;
  const params = balancedGroup(STATE_CODE, parenAt);
  if (!params) return { params: "", body: "" };
  const braceAt = STATE_CODE.indexOf("{", parenAt + params.length);
  return {
    params,
    body: braceAt < 0 ? "" : balancedGroup(STATE_CODE, braceAt),
  };
}

const START_IDLE_WATCH = member("#startIdleWatch").body;
const IDLE_TICK = member("#idleTick").body;
const POST_AFK_IDLE = member("#postAfkIdle");
const DISCONNECT = member("disconnect").body;

/**
 * The object literal handed to `idleStep`: `idleStep(world)` over
 * `const world: IdleWorld = { … }` declared in `#idleTick`.
 */
const IDLE_WORLD_LITERAL = (() => {
  const decl = /\bconst world: IdleWorld = \{/.exec(IDLE_TICK);
  return decl ? balancedGroup(IDLE_TICK, decl.index + decl[0].length - 1) : "";
})();

/**
 * An object literal's top-level `key: value` entries, values
 * whitespace-collapsed. Shorthand entries are left out on purpose: every
 * field pinned below must be written out as `key: value`, so its expression
 * is in the literal where the scans can read it.
 */
function topLevelEntries(literal: string): Map<string, string> {
  const inner = literal.slice(1, -1);
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(inner.slice(start));
  const entries = new Map<string, string>();
  for (const part of parts) {
    const keyed = /^\s*(\w+)\s*:\s*([\s\S]+?)\s*$/.exec(part);
    if (keyed) entries.set(keyed[1], keyed[2].replace(/\s+/g, " "));
  }
  return entries;
}

const WORLD_ENTRIES = topLevelEntries(IDLE_WORLD_LITERAL);
const worldValue = (key: string): string => WORLD_ENTRIES.get(key) ?? "";

test("state.tsx has an idle watch and an idle world the scans below can read", () => {
  // Without these every scan that follows passes, or fails, on an empty
  // string for the wrong reason.
  assert.ok(
    START_IDLE_WATCH.length > 0,
    "no #startIdleWatch body in state.tsx",
  );
  assert.ok(IDLE_TICK.length > 0, "no #idleTick body in state.tsx");
  assert.ok(POST_AFK_IDLE.body.length > 0, "no #postAfkIdle body in state.tsx");
  assert.ok(
    DISCONNECT.includes("this.#stopVAD();"),
    "the disconnect() body the scans read is not the real one",
  );
  assert.ok(
    IDLE_WORLD_LITERAL.length > 0,
    "no `const world: IdleWorld = { … }` in #idleTick",
  );
  // The tick the scans read is the one the watch actually runs.
  assert.ok(
    START_IDLE_WATCH.includes("this.#idleTick(room, channel, gen)"),
    "#startIdleWatch does not drive #idleTick",
  );
  assert.ok(
    START_IDLE_WATCH.includes("setInterval(tick, IDLE_TICK_MS)"),
    "#startIdleWatch does not run the tick every IDLE_TICK_MS",
  );
});

test("state.tsx calls the extracted idle rules instead of restating them", () => {
  const steps = STATE_CODE.match(/\bidleStep\(/g) ?? [];
  assert.equal(
    steps.length,
    1,
    `expected 1 idleStep call, saw ${steps.length}`,
  );
  assert.ok(
    IDLE_TICK.includes("const step = idleStep(world);"),
    "#idleTick does not hand its world to idleStep",
  );
});

test("🔴 the idle world passes the AFK accessor, not a constant (the 9th isAfkChannel site)", () => {
  assert.equal(worldValue("isAfkChannel"), "this.isAfkChannel");
});

test("🔴 the timeout is read fresh as server.afkTimeout, in SECONDS", () => {
  // The one seconds→ms conversion lives in idlePolicy.ts. A `* 1000` here
  // too makes a 60 s timeout claim after 16 hours — and every test above
  // stays green, because it is the caller that is wrong.
  assert.equal(
    worldValue("afkTimeoutSeconds"),
    "this.channel()?.server?.afkTimeout",
  );
  // Scoped, not file-wide: state.tsx legitimately converts bitrates with
  // `* 1000` (kbps → bps). No line that reads `afkTimeout` scales it, and
  // the idle code converts nothing.
  for (const line of STATE_CODE.split("\n")) {
    if (line.includes("afkTimeout"))
      assert.ok(!/\b1_?000\b/.test(line), `afkTimeout scaled: ${line.trim()}`);
  }
  for (const [where, code] of [
    ["#idleTick", IDLE_TICK],
    ["#postAfkIdle", POST_AFK_IDLE.body],
  ]) {
    assert.ok(
      !/[*/]\s*1_?000\b|\b1_?000\s*\*/.test(code),
      `${where} converts ms/s itself — only idlePolicy.ts may`,
    );
  }
});

test("the idle world's `connected` is the session, the Room and the SFU transport", () => {
  // I-6: an SFU drop goes RECONNECTING without `disconnect()`, and an SDK
  // reconnect never changes `state()` — each check alone misses one. Pinned
  // as the exact conjunction: a term dropped, or `&&` loosened to `||`, is
  // red.
  assert.deepEqual(
    worldValue("connected").split(" && ").sort(),
    [
      'this.state() === "CONNECTED"',
      "this.room() === room",
      "room.state === ConnectionState.Connected",
    ].sort(),
  );
});

/** `continuousActive` split into its `||` disjuncts. */
const ACTIVE_TERMS = worldValue("continuousActive").split(" || ");

test("the idle world's `continuousActive` covers speaking, PTT, screen share and camera", () => {
  // D-5b2-7. `isSpeaking` is written only by the SFU (I-7), so it is read
  // per tick rather than trusted from an edge. Five disjuncts exactly — this
  // one and the watch-together test below cover all five; adding a sixth is
  // meant to fail here until it is pinned on purpose.
  assert.equal(
    ACTIVE_TERMS.length,
    5,
    `continuousActive is not the five-way ||: ${ACTIVE_TERMS.join(" || ")}`,
  );
  for (const term of [
    "room.localParticipant.isSpeaking",
    "this.#pttHeld",
    "this.screenshare()",
    "this.video()",
  ]) {
    assert.ok(
      ACTIVE_TERMS.includes(term),
      `continuousActive lacks ${term}: ${ACTIVE_TERMS.join(" || ")}`,
    );
  }
});

/** FE-W's watch-together accessor (`state.tsx` `#idleTick`, D-5b2-7). */
const WATCH_TOGETHER_TOKEN = "this.watch.session()";

test("the idle world's `continuousActive` covers watch-together (P2-18)", () => {
  // Watching a film together is idle input with a person at the screen.
  assert.ok(
    ACTIVE_TERMS.includes(`${WATCH_TOGETHER_TOKEN} !== undefined`),
    `continuousActive lacks ${WATCH_TOGETHER_TOKEN} !== undefined: ${ACTIVE_TERMS.join(" || ")}`,
  );
});

test("the idle tick re-checks the connect generation before anything else", () => {
  // I-6: a superseded connection's timer must not post for the new one.
  assert.ok(
    /^\{\s*if \(gen !== this\.#connectGen\) return;/.test(IDLE_TICK),
    "#idleTick does not open with `if (gen !== this.#connectGen) return;`",
  );
});

test("the idle watch starts once, in the `connected` handler, after CONNECTED", () => {
  const calls = STATE_CODE.match(/this\.#startIdleWatch\(/g) ?? [];
  assert.equal(
    calls.length,
    1,
    `expected 1 #startIdleWatch call, saw ${calls.length}`,
  );
  const listeners = [
    ...STATE_CODE.matchAll(/room\.addListener\("connected", \(\) => \{/g),
  ];
  assert.equal(listeners.length, 1, "expected 1 room `connected` listener");
  const listener = listeners[0];
  const handler = balancedGroup(
    STATE_CODE,
    listener.index + listener[0].length - 1,
  );
  const setAt = handler.indexOf('this.#setState("CONNECTED");');
  const startAt = handler.indexOf("this.#startIdleWatch(room, channel, gen);");
  assert.ok(setAt >= 0, 'the `connected` handler no longer sets "CONNECTED"');
  assert.ok(
    startAt > setAt,
    'this.#startIdleWatch(room, channel, gen) is not inside the `connected` handler after #setState("CONNECTED")',
  );
});

test("disconnect() stops the idle watch", () => {
  assert.ok(
    DISCONNECT.includes("this.#stopIdleWatch();"),
    "disconnect() does not call this.#stopIdleWatch()",
  );
});

test("the beacon is posted from exactly one idle site and one clear site", () => {
  const idle = STATE_CODE.match(/#postAfkIdle\(channel, true\b/g) ?? [];
  const clear = STATE_CODE.match(/#postAfkIdle\(channel, false\b/g) ?? [];
  assert.equal(idle.length, 1, `expected 1 idle post site, saw ${idle.length}`);
  assert.equal(
    clear.length,
    1,
    `expected 1 clear post site, saw ${clear.length}`,
  );
});

test("🔴 #postAfkIdle's wire shape: PUT for idle, DELETE for clear, `idle_for`, `.ok`", () => {
  // P2-18: a renamed body key is a 422 the client swallows (the feature is
  // dead, silently); swapped verbs claim idle on every activity edge.
  const { params, body } = POST_AFK_IDLE;
  const flag = /^\(\s*channel: Channel,\s*(\w+): boolean,/.exec(params)?.[1];
  assert.ok(flag, `#postAfkIdle's 2nd parameter is not a boolean: ${params}`);
  assert.ok(
    body.includes(`method: ${flag} ? "PUT" : "DELETE",`),
    `#postAfkIdle does not map method: ${flag} ? "PUT" : "DELETE"`,
  );
  assert.ok(
    /\bidle_for: idleForSeconds\(/.test(body),
    "#postAfkIdle's body does not send `idle_for: idleForSeconds(…)`",
  );
  assert.ok(
    body.includes("if (response?.ok) {"),
    "#postAfkIdle never checks response.ok",
  );
});

test("🔴 a failed claim counts itself, then asks idleFailureDisposition — the 3rd consecutive failure latches", () => {
  // P2-6. `#postAfkIdle` increments BEFORE it asks, so the count it passes
  // includes the failure just seen: failures 1 and 2 back off, the 3rd
  // latches (two backoffs, then stop). Bypassing the policy, or asking with
  // the pre-increment count (one more attempt), is red here.
  const { body } = POST_AFK_IDLE;
  const bumps = body.match(/this\.#idleFailures\+\+;/g) ?? [];
  const asks = body.match(/idleFailureDisposition\(/g) ?? [];
  assert.equal(
    bumps.length,
    1,
    `expected 1 failure increment, saw ${bumps.length}`,
  );
  assert.equal(
    asks.length,
    1,
    `expected 1 idleFailureDisposition call, saw ${asks.length}`,
  );
  const bumpAt = body.indexOf("this.#idleFailures++;");
  const askAt = body.indexOf(
    'idleFailureDisposition(errorType, this.#idleFailures) === "latch"',
  );
  assert.ok(
    askAt > bumpAt,
    '#postAfkIdle does not ask `idleFailureDisposition(errorType, this.#idleFailures) === "latch"` after the increment',
  );
  // The same discipline played against the real policy, a transient refusal
  // every time.
  let failures = 0;
  const seen: string[] = [];
  while (seen.at(-1) !== "latch" && seen.length < 10) {
    failures++;
    seen.push(idleFailureDisposition("NotInVoiceChannel", failures));
  }
  assert.deepEqual(seen, ["backoff", "backoff", "latch"]);
});

// --- Remediation R1: one-token reverts the wave audit found shipping green ---
//
// Each pin below reads an exact token sequence. The comparison drops ALL
// whitespace on both sides (`squash`), so a prettier reflow is not a failure
// but any changed token is. Findings B1–B4, B6, B12 and A1 of the 5b-2.1
// audit ledger; each was a single-token revert that passed every gate.

/** `source` with all whitespace removed. */
const squash = (source: string): string => source.replace(/\s+/g, "");

/** Whether `code` contains `snippet`, ignoring whitespace on both sides. */
const hasTokens = (code: string, snippet: string): boolean =>
  squash(code).includes(squash(snippet));

const NOTE_IDLE_ACTIVITY = member("#noteIdleActivity").body;
const DISPATCH_KEYBIND = member("dispatchKeybind").body;

/** The body of the native `ptt:down` listener's callback, or `""`. */
const PTT_DOWN = (() => {
  const open = /tauri\.event\.listen<void>\("ptt:down", \(\) => \{/.exec(
    STATE_CODE,
  );
  return open ? balancedGroup(STATE_CODE, open.index + open[0].length - 1) : "";
})();

test("🔴 B1: input in the VISIBLE window is activity — four events, capture, passive", () => {
  // `=== "visible"` flipped, an event dropped, or `capture: false` (a handler
  // that stops propagation then hides the input): each one moves a member who
  // is typing in the text chat.
  const listeners = STATE_CODE.match(/const noteInput = /g) ?? [];
  assert.equal(listeners.length, 1, "expected exactly one noteInput");
  assert.ok(
    hasTokens(
      STATE_CODE,
      `const noteInput = () => {
        if (document.visibilityState === "visible") this.#noteIdleActivity();
      };
      for (const type of ["keydown", "pointerdown", "wheel", "touchstart"])
        window.addEventListener(type, noteInput, {
          capture: true,
          passive: true,
        });`,
    ),
    "the window input listeners are not the pinned four, visible-only, capture + passive",
  );
});

test("🔴 B1: a keybind and a native PTT press are activity, and activity stamps the clock", () => {
  // `#noteIdleActivity` is the only thing that moves `lastActivityAt`
  // between ticks; every source below is dead without its stamp.
  assert.ok(
    /^\{\s*this\.#idleLastActivityAt = performance\.now\(\);\s*if \(this\.#idlePosted\) untrack\(\(\) => this\.#idleKick\?\.\(\)\);\s*\}$/.test(
      NOTE_IDLE_ACTIVITY,
    ),
    "#noteIdleActivity no longer stamps the clock and kicks a standing claim",
  );
  // First statement: even a press the guards drop proves someone is there.
  assert.ok(
    /^\{\s*this\.#noteIdleActivity\(\);/.test(DISPATCH_KEYBIND),
    "dispatchKeybind does not open with this.#noteIdleActivity();",
  );
  // The global hook is how an unfocused window hears the talk key.
  assert.ok(PTT_DOWN.length > 0, 'no native "ptt:down" listener body');
  assert.ok(
    hasTokens(PTT_DOWN, "this.#pttHeld = true; this.#noteIdleActivity();"),
    'the "ptt:down" listener does not note activity right after this.#pttHeld = true;',
  );
});

test("🔴 B1: the local speaking edge is heard, and the listener is removed", () => {
  assert.ok(
    hasTokens(
      START_IDLE_WATCH,
      `const onSpeakers = (speakers: { identity: string }[]) => {
        if (speakers.some((p) => p.identity === room.localParticipant.identity))
          this.#noteIdleActivity();
      };
      room.on(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      this.#idleUnlistenSpeakers = () => {
        room.off(RoomEvent.ActiveSpeakersChanged, onSpeakers);
      };`,
    ),
    "#startIdleWatch does not register (and unregister) the ActiveSpeakersChanged listener",
  );
});

test("🔴 B2: a claim that landed — or may have — is recorded as posted; the clear path drops it", () => {
  // Without `#idlePosted = true` the user's return never sends the DELETE,
  // and the sweep moves an active user.
  const body = POST_AFK_IDLE.body;
  const trues = squash(body).split("this.#idlePosted=true;").length - 1;
  assert.equal(
    trues,
    2,
    `expected 2 #idlePosted = true in #postAfkIdle, saw ${trues}`,
  );
  assert.ok(
    hasTokens(
      body,
      `if (response?.ok) {
        if (idle) {
          this.#idlePosted = true;
          this.#idleLastPostAt = performance.now();`,
    ),
    "the success arm does not record the claim as posted",
  );
  assert.ok(
    hasTokens(
      body,
      `const outcomeUnknown =
        response === undefined || response.status >= 500;
      if (outcomeUnknown) {
        this.#idlePosted = true;
        this.#idleLastPostAt = performance.now();
      }`,
    ),
    "the unknown-outcome arm does not record the claim as posted (A1)",
  );
  // The clear path drops the flag BEFORE its DELETE, so the next tick does
  // not stack a second DELETE on this one's retries.
  assert.ok(
    hasTokens(
      IDLE_TICK,
      `} else if (step.action === "clear-idle") {
        this.#idlePosted = false;
        this.#idleLastPostAt = undefined;
        void this.#postAfkIdle(channel, false, gen);
      }`,
    ),
    "#idleTick's clear path does not drop #idlePosted before its DELETE",
  );
});

test("🔴 B3: the tick carries idleStep's clock forward", () => {
  // Drop either write and the idle clock never advances (lastActivityAt) or
  // every tick looks like the first (lastTickAt — the gap rule goes dead).
  assert.ok(
    hasTokens(
      IDLE_TICK,
      `const step = idleStep(world);
      this.#idleLastTickAt = now;
      this.#idleLastActivityAt = step.lastActivityAt;`,
    ),
    "#idleTick does not write back lastTickAt and lastActivityAt right after idleStep",
  );
});

test("🔴 B4: the beacon's path is exactly /channels/{id}/afk_idle", () => {
  // A wrong path is a 404 the PUT arm treats as a back-off: the feature is
  // silently dead. The route itself is pinned on the delta side.
  assert.ok(
    POST_AFK_IDLE.body.includes(
      "`${client.options.baseURL}/channels/${channel.id}/afk_idle`",
    ),
    "#postAfkIdle does not fetch `${baseURL}/channels/${channel.id}/afk_idle`",
  );
});

test("🔴 B6: the DELETE is retried on the pinned schedule; the PUT is sent once", () => {
  const delays = STATE_CODE.match(/const AFK_IDLE_CLEAR_RETRY_DELAYS_MS = /g);
  assert.equal(
    delays?.length,
    1,
    "expected one AFK_IDLE_CLEAR_RETRY_DELAYS_MS",
  );
  assert.ok(
    STATE_CODE.includes(
      "const AFK_IDLE_CLEAR_RETRY_DELAYS_MS = [1_000, 4_000, 10_000];",
    ),
    "AFK_IDLE_CLEAR_RETRY_DELAYS_MS is not [1_000, 4_000, 10_000]",
  );
  const body = POST_AFK_IDLE.body;
  assert.ok(
    hasTokens(
      body,
      "const attempts = idle ? 1 : AFK_IDLE_CLEAR_RETRY_DELAYS_MS.length + 1;",
    ),
    "attempts is not `idle ? 1 : AFK_IDLE_CLEAR_RETRY_DELAYS_MS.length + 1`",
  );
  assert.ok(
    hasTokens(
      body,
      `for (let attempt = 0; attempt < attempts; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) =>
            setTimeout(resolve, AFK_IDLE_CLEAR_RETRY_DELAYS_MS[attempt - 1]),
          );`,
    ),
    "#postAfkIdle's retry loop does not wait AFK_IDLE_CLEAR_RETRY_DELAYS_MS[attempt - 1]",
  );
});

test("🔴 B12: the latch stops the idle PUT, and a config change resets it", () => {
  assert.ok(
    hasTokens(
      IDLE_TICK,
      `if (step.action === "post-idle" || step.action === "refresh-idle") {
        if (!world.connected) return;
        if (this.#idleLatched || this.#idlePutInFlight) return;
        if (this.#idleNextPutAt !== undefined && now < this.#idleNextPutAt)
          return;
        void this.#postAfkIdle(channel, true, gen);
      }`,
    ),
    "the idle PUT is no longer guarded by connected, the latch, in-flight and the back-off",
  );
  assert.ok(
    hasTokens(
      IDLE_TICK,
      'const configKey = `${world.afkChannelId ?? ""}|${world.afkTimeoutSeconds ?? ""}`;' +
        `if (configKey !== this.#idleConfigKey) {
          this.#idleConfigKey = configKey;
          this.#idleLatched = false;
          this.#idleFailures = 0;
          this.#idleNextPutAt = undefined;
        }`,
    ),
    "the latch no longer resets exactly when the AFK channel or timeout changes",
  );
});

test("🔴 A1: every idle request is bounded, and a PUT with no answer counts as landed", () => {
  // A PUT whose response is lost may have been applied by delta. Recording
  // it as NOT posted leaves a due claim nothing will ever withdraw.
  assert.ok(
    STATE_CODE.includes("const AFK_IDLE_REQUEST_TIMEOUT_MS = 10_000;"),
    "AFK_IDLE_REQUEST_TIMEOUT_MS is not 10_000",
  );
  const body = POST_AFK_IDLE.body;
  for (const [what, snippet] of [
    ["the abort controller", "const abort = new AbortController();"],
    [
      "the timeout wiring",
      "const timeout = setTimeout(() => abort.abort(), AFK_IDLE_REQUEST_TIMEOUT_MS,);",
    ],
    ["the signal", "signal: abort.signal,"],
    [
      "catch → unknown, then the gen test",
      "} catch { response = undefined; } if (gen !== this.#connectGen) return;",
    ],
    [
      "the outer finally → clearTimeout",
      "} finally { clearTimeout(timeout); }",
    ],
    [
      "the stale-claim kick",
      "if (outcomeUnknown && this.#idleLastActivityAt !== activityAtSend) untrack(() => this.#idleKick?.());",
    ],
  ]) {
    assert.ok(hasTokens(body, snippet), `#postAfkIdle lost ${what}`);
  }
  // Recorded before ANY await in the failure arm: no tick may run between
  // the loss and the record.
  const flat = squash(body);
  const okAt = flat.indexOf("if(response?.ok){");
  assert.ok(okAt >= 0, "no `if (response?.ok) {` arm");
  const okArm = balancedGroup(flat, okAt + "if(response?.ok)".length);
  assert.ok(okArm.length > 0, "the `if (response?.ok)` arm never closes");
  const failure = flat.slice(okAt + "if(response?.ok)".length + okArm.length);
  const unknownAt = failure.indexOf(
    squash(`if (outcomeUnknown) {
      this.#idlePosted = true;
      this.#idleLastPostAt = performance.now();
    }`),
  );
  assert.ok(unknownAt >= 0, "no unknown-outcome record after the success arm");
  assert.ok(
    !failure.slice(0, unknownAt).includes("await"),
    "the unknown-outcome record comes after an await — a tick can run in between",
  );
});

// --- Remediation R2 ---------------------------------------------------------

test("🔴 R-2: a 5xx answer is an UNKNOWN outcome, like no answer at all", () => {
  // A proxy's 502/504, or a delta 500 raised after the SET landed, says
  // nothing about the claim. Dropping the term — or `>=` → `>`, which lets a
  // plain 500 through as "did not land" — leaves a claim nothing withdraws.
  const flat = squash(POST_AFK_IDLE.body);
  const assignments = flat.split("constoutcomeUnknown=").length - 1;
  assert.equal(assignments, 1, `expected 1 outcomeUnknown, saw ${assignments}`);
  assert.ok(
    flat.includes(
      squash(
        "const outcomeUnknown = response === undefined || response.status >= 500;",
      ),
    ),
    "outcomeUnknown is not exactly `response === undefined || response.status >= 500`",
  );
});

test("🔴 R-3: the request timer stays armed until the request is fully settled", () => {
  // The abort bounds the error body's read too; clearing the timer as soon
  // as the fetch settles lets a stalled body hold #idlePutInFlight for good.
  const flat = squash(POST_AFK_IDLE.body);
  const clears = flat.split("clearTimeout(timeout)").length - 1;
  assert.equal(clears, 1, `expected 1 clearTimeout(timeout), saw ${clears}`);
  assert.ok(
    flat.indexOf("clearTimeout(timeout)") > flat.indexOf(".json()"),
    "clearTimeout(timeout) comes before the error body's .json() read",
  );
  // The inner catch has no finally of its own: it goes straight to the gen
  // test.
  assert.ok(
    flat.includes(
      squash(
        "} catch { response = undefined; } if (gen !== this.#connectGen) return;",
      ),
    ),
    "the fetch's catch is not followed directly by the gen test",
  );
  // The clear is the `finally` of the try that opens right after the timer
  // is armed and wraps the fetch, the `.ok` arm and the failure arm.
  const armed = squash(
    "const timeout = setTimeout(() => abort.abort(), AFK_IDLE_REQUEST_TIMEOUT_MS,); try {",
  );
  const armedAt = flat.indexOf(armed);
  assert.ok(armedAt >= 0, "no `try {` directly after the timer is armed");
  const outer = balancedGroup(flat, armedAt + armed.length - 1);
  assert.ok(outer.length > 0, "the try after the timer never closes");
  for (const inside of ["fetch(", "if(response?.ok){", ".json()"]) {
    assert.ok(outer.includes(inside), `the outer try does not wrap ${inside}`);
  }
  assert.ok(
    flat
      .slice(armedAt + armed.length - 1 + outer.length)
      .startsWith("finally{clearTimeout(timeout);}"),
    "the outer try's finally is not `{ clearTimeout(timeout); }`",
  );
});

test("🔴 R-6: the success kick, the in-flight reset and the DELETE's supersession", () => {
  const body = POST_AFK_IDLE.body;
  // (a) Activity while the claim was in flight withdraws it at once. `===`
  // would kick only when nothing changed, and leave the stale claim for a
  // full tick.
  assert.ok(
    hasTokens(
      body,
      `if (response?.ok) {
        if (idle) {
          this.#idlePosted = true;
          this.#idleLastPostAt = performance.now();
          this.#idleFailures = 0;
          this.#idleNextPutAt = undefined;
          if (this.#idleLastActivityAt !== activityAtSend)
            untrack(() => this.#idleKick?.());
        }
        return;
      }`,
    ),
    "the success arm is not the pinned record + `!==` stale-claim kick",
  );
  // (b) The in-flight flag is set before the try and released in its
  // finally; without the release the first PUT blocks every later one.
  const flat = squash(body);
  assert.ok(
    flat.includes(squash("if (idle) this.#idlePutInFlight = true; try {")),
    "#idlePutInFlight is not set right before the outer try",
  );
  assert.ok(
    flat.endsWith(
      squash(
        "} finally { if (idle && gen === this.#connectGen) this.#idlePutInFlight = false; } }",
      ),
    ),
    "#postAfkIdle does not release #idlePutInFlight in its closing finally",
  );
  // (c) A claim posted during the DELETE's retry wait is newer than the
  // withdrawal; retrying anyway would delete a live claim.
  assert.ok(
    hasTokens(
      body,
      `setTimeout(resolve, AFK_IDLE_CLEAR_RETRY_DELAYS_MS[attempt - 1]),
      );
      if (gen !== this.#connectGen || this.#idlePosted) return;`,
    ),
    "the DELETE retry does not stop when a newer claim was posted",
  );
});
