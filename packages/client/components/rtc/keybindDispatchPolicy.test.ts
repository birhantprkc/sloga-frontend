/**
 * Run with:
 *
 *     node --conditions=browser --test components/rtc/keybindDispatchPolicy.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests — without it
 * Node resolves solid-js's server build and effect-based specs silently pass
 * against broken code. This file is pure and unaffected, but one invocation
 * should cover it and the reactive suites together.)
 *
 * These are the five guards on `Voice.dispatchKeybind()`. They had ZERO
 * automated coverage while they lived inline in `./state.tsx`, which
 * `node --test` cannot load (a `.tsx` with Vite-only specifiers — see the
 * policy module's header). Each `describe` below names the guard and the
 * production failure it prevents, and the ORDER suite exists because which
 * guard rejects first is observable: the caller stamps its rate-limit clock
 * only on an accept, so a guard moved across guard 2 changes what the NEXT
 * press does.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type GlobalKeybindAction,
  GLOBAL_KEYBIND_ACTIONS,
  KEYBIND_MIN_INTERVAL_MS,
  KEYBIND_REQUIREMENT,
} from "../keybinds/globalKeybinds.ts";

import {
  type KeybindDispatchInput,
  type KeybindDispatchVerdict,
  type KeybindDropReason,
  decideKeybindDispatch,
} from "./keybindDispatchPolicy.ts";

/**
 * A press that every guard lets through: `toggle-window` is `"none"`, nothing
 * is in flight, no press has ever been accepted, no PTT hold. Each spec
 * overrides exactly the fields it is about, so an unexpected reason names the
 * guard that fired.
 */
function press(
  overrides: Partial<KeybindDispatchInput> = {},
): KeybindDispatchInput {
  return {
    action: "toggle-window",
    requirement: "none",
    now: 10_000,
    lastAccepted: undefined,
    minIntervalMs: KEYBIND_MIN_INTERVAL_MS,
    inFlight: false,
    hasRoom: false,
    hasIncomingCall: false,
    pttHeld: false,
    isFullscreen: false,
    ...overrides,
  };
}

/** An accept carries no reason at all — asserted structurally, not by field. */
function assertAccepted(verdict: KeybindDispatchVerdict): void {
  assert.deepEqual(verdict, { accept: true });
}

function assertRejected(
  verdict: KeybindDispatchVerdict,
  reason: KeybindDropReason,
): void {
  assert.deepEqual(verdict, { accept: false, reason });
}

/** The action a spec uses when it needs a real `"room"` action. */
const ROOM_ACTION: GlobalKeybindAction = "toggle-camera";

/* ------------------------------------------------------------------ *
 * Guard 1 — in-flight, per action
 * ------------------------------------------------------------------ */

describe("guard 1 — in-flight", () => {
  it("rejects a press while the same action is still awaiting", () => {
    assertRejected(
      decideKeybindDispatch(press({ inFlight: true })),
      "in-flight",
    );
  });

  it("accepts when nothing is in flight", () => {
    assertAccepted(decideKeybindDispatch(press({ inFlight: false })));
  });
});

/* ------------------------------------------------------------------ *
 * Guard 2 — rate limit against the min-interval floor
 * ------------------------------------------------------------------ */

describe("guard 2 — rate limit", () => {
  it("accepts the first ever press, where lastAccepted is undefined", () => {
    assertAccepted(decideKeybindDispatch(press({ lastAccepted: undefined })));
  });

  it("rejects a press one millisecond inside the interval", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          now: 10_000,
          lastAccepted: 10_000 - (KEYBIND_MIN_INTERVAL_MS - 1),
        }),
      ),
      "rate-limited",
    );
  });

  it("accepts a press exactly at the interval boundary", () => {
    assertAccepted(
      decideKeybindDispatch(
        press({ now: 10_000, lastAccepted: 10_000 - KEYBIND_MIN_INTERVAL_MS }),
      ),
    );
  });

  it("accepts a press one millisecond past the interval", () => {
    assertAccepted(
      decideKeybindDispatch(
        press({
          now: 10_000,
          lastAccepted: 10_000 - (KEYBIND_MIN_INTERVAL_MS + 1),
        }),
      ),
    );
  });

  it("rejects a press immediately after an accepted one, delta zero", () => {
    assertRejected(
      decideKeybindDispatch(press({ now: 10_000, lastAccepted: 10_000 })),
      "rate-limited",
    );
  });

  it("honors the interval it is given, not the module constant", () => {
    // 5000 ms is far outside KEYBIND_MIN_INTERVAL_MS, so a policy that read
    // the constant instead of the input would accept this.
    assertRejected(
      decideKeybindDispatch(
        press({ now: 10_000, lastAccepted: 6_000, minIntervalMs: 5_000 }),
      ),
      "rate-limited",
    );
  });

  it("treats a clock that moved backwards as still inside the window, never as a fresh interval", () => {
    // The whole point of performance.now(): a wall-clock step (NTP,
    // sleep/resume) must not be able to open the floor. A negative delta is
    // inside the window and rejects.
    assertRejected(
      decideKeybindDispatch(press({ now: 10_000, lastAccepted: 10_001 })),
      "rate-limited",
    );
  });

  it("rejects a large backwards jump too, so no wall-clock step can open the window", () => {
    assertRejected(
      decideKeybindDispatch(press({ now: 10_000, lastAccepted: 4_000_000 })),
      "rate-limited",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Guard 3 — the KEYBIND_REQUIREMENT precondition
 * ------------------------------------------------------------------ */

describe('guard 3 — requirement "none"', () => {
  it("accepts with no room", () => {
    assertAccepted(
      decideKeybindDispatch(press({ requirement: "none", hasRoom: false })),
    );
  });

  it("accepts with a room", () => {
    assertAccepted(
      decideKeybindDispatch(press({ requirement: "none", hasRoom: true })),
    );
  });

  it("accepts with a room and a ring both up", () => {
    assertAccepted(
      decideKeybindDispatch(
        press({ requirement: "none", hasRoom: true, hasIncomingCall: true }),
      ),
    );
  });
});

describe('guard 3 — requirement "room"', () => {
  it("accepts with a room", () => {
    assertAccepted(
      decideKeybindDispatch(
        press({ action: ROOM_ACTION, requirement: "room", hasRoom: true }),
      ),
    );
  });

  it("rejects with no room, which is the press that would throw a modal", () => {
    assertRejected(
      decideKeybindDispatch(
        press({ action: ROOM_ACTION, requirement: "room", hasRoom: false }),
      ),
      "needs-room",
    );
  });
});

describe('guard 3 — requirement "incoming-call"', () => {
  it("accepts a ring with no room", () => {
    assertAccepted(
      decideKeybindDispatch(
        press({
          action: "accept-call",
          requirement: "incoming-call",
          hasIncomingCall: true,
          hasRoom: false,
        }),
      ),
    );
  });

  it("rejects a ring while a room is already live, because connect() leads with disconnect()", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          action: "accept-call",
          requirement: "incoming-call",
          hasIncomingCall: true,
          hasRoom: true,
        }),
      ),
      "has-room",
    );
  });

  it("rejects with no ring", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          action: "accept-call",
          requirement: "incoming-call",
          hasIncomingCall: false,
          hasRoom: false,
        }),
      ),
      "needs-incoming-call",
    );
  });

  it("reports the missing ring, not the room, when both halves fail", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          action: "accept-call",
          requirement: "incoming-call",
          hasIncomingCall: false,
          hasRoom: true,
        }),
      ),
      "needs-incoming-call",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Guard 4 — mute is inert during a push-to-talk hold
 * ------------------------------------------------------------------ */

describe("guard 4 — push-to-talk hold", () => {
  it("rejects a mute toggle landing inside a hold", () => {
    assertRejected(
      decideKeybindDispatch(press({ action: "toggle-mute", pttHeld: true })),
      "ptt-held",
    );
  });

  it("accepts a mute toggle with no hold", () => {
    assertAccepted(
      decideKeybindDispatch(press({ action: "toggle-mute", pttHeld: false })),
    );
  });

  it("leaves deafen live during a hold, deliberately", () => {
    // toggleDeafen reads the persisted flag, not the wire, so it does not
    // invert the way mute does — and deafen is a receive-side control the
    // user may genuinely want mid-sentence.
    assertAccepted(
      decideKeybindDispatch(press({ action: "toggle-deafen", pttHeld: true })),
    );
  });

  it("gates toggle-mute and no other action during a hold", () => {
    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      const verdict = decideKeybindDispatch(
        press({
          action,
          requirement: KEYBIND_REQUIREMENT[action],
          pttHeld: true,
          // Satisfy every other guard so `ptt-held` is the only one that can
          // fire, for every action in the table.
          hasRoom: KEYBIND_REQUIREMENT[action] !== "incoming-call",
          hasIncomingCall: true,
          isFullscreen: true,
        }),
      );
      if (action === "toggle-mute") {
        assertRejected(verdict, "ptt-held");
      } else {
        assertAccepted(verdict);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Guard 5 — theater needs fullscreen
 * ------------------------------------------------------------------ */

describe("guard 5 — theater outside fullscreen", () => {
  it("rejects theater when not fullscreen, where the call bar would hide with no way back", () => {
    assertRejected(
      decideKeybindDispatch(
        press({ action: "toggle-theater", isFullscreen: false }),
      ),
      "needs-fullscreen",
    );
  });

  it("accepts theater in fullscreen", () => {
    assertAccepted(
      decideKeybindDispatch(
        press({ action: "toggle-theater", isFullscreen: true }),
      ),
    );
  });

  it("gates toggle-theater and no other action on fullscreen", () => {
    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      const verdict = decideKeybindDispatch(
        press({
          action,
          requirement: KEYBIND_REQUIREMENT[action],
          isFullscreen: false,
          hasRoom: KEYBIND_REQUIREMENT[action] !== "incoming-call",
          hasIncomingCall: true,
        }),
      );
      if (action === "toggle-theater") {
        assertRejected(verdict, "needs-fullscreen");
      } else {
        assertAccepted(verdict);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * Guard ORDER — which guard reports, when several would reject
 * ------------------------------------------------------------------ */

describe("guard order", () => {
  it("in-flight beats the rate limit", () => {
    // They overlap for every action whose dispatch settles inside the
    // interval, i.e. most of them.
    assertRejected(
      decideKeybindDispatch(
        press({ inFlight: true, now: 10_000, lastAccepted: 9_999 }),
      ),
      "in-flight",
    );
  });

  it("in-flight beats the requirement", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          inFlight: true,
          action: ROOM_ACTION,
          requirement: "room",
          hasRoom: false,
        }),
      ),
      "in-flight",
    );
  });

  it("in-flight beats the ptt hold", () => {
    assertRejected(
      decideKeybindDispatch(
        press({ inFlight: true, action: "toggle-mute", pttHeld: true }),
      ),
      "in-flight",
    );
  });

  it("in-flight beats the fullscreen gate", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          inFlight: true,
          action: "toggle-theater",
          isFullscreen: false,
        }),
      ),
      "in-flight",
    );
  });

  it("the rate limit beats the requirement", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          now: 10_000,
          lastAccepted: 9_999,
          action: ROOM_ACTION,
          requirement: "room",
          hasRoom: false,
        }),
      ),
      "rate-limited",
    );
  });

  it("the rate limit beats the ptt hold", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          now: 10_000,
          lastAccepted: 9_999,
          action: "toggle-mute",
          pttHeld: true,
        }),
      ),
      "rate-limited",
    );
  });

  it("the rate limit beats the fullscreen gate", () => {
    assertRejected(
      decideKeybindDispatch(
        press({
          now: 10_000,
          lastAccepted: 9_999,
          action: "toggle-theater",
          isFullscreen: false,
        }),
      ),
      "rate-limited",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Tripwires
 * ------------------------------------------------------------------ */

describe("tripwires", () => {
  it("returns a defined verdict for every GlobalKeybindAction under its real requirement", () => {
    // The exhaustiveness tripwire. A 13th action added to
    // GLOBAL_KEYBIND_ACTIONS must not fall out of a switch as `undefined`,
    // which the caller can only survive because it reads `verdict?.accept`
    // optionally (see the out-of-union spec below).
    for (const action of GLOBAL_KEYBIND_ACTIONS) {
      for (const hasRoom of [false, true]) {
        for (const hasIncomingCall of [false, true]) {
          for (const pttHeld of [false, true]) {
            for (const isFullscreen of [false, true]) {
              const verdict = decideKeybindDispatch(
                press({
                  action,
                  requirement: KEYBIND_REQUIREMENT[action],
                  hasRoom,
                  hasIncomingCall,
                  pttHeld,
                  isFullscreen,
                }),
              );
              assert.equal(
                typeof verdict?.accept,
                "boolean",
                `no verdict for ${action} (room=${hasRoom} ring=${hasIncomingCall} ptt=${pttHeld} fs=${isFullscreen})`,
              );
              if (!verdict.accept) {
                assert.equal(
                  typeof verdict.reason,
                  "string",
                  `rejection with no reason for ${action}`,
                );
              }
            }
          }
        }
      }
    }
  });

  it("never accepts a requirement outside the union, so the caller's optional read fails closed", () => {
    // 🔴 The 2304-case tripwire above is BLIND to this: it always passes
    // `KEYBIND_REQUIREMENT[action]`, so `requirement` never varies
    // independently of `action`. Here it does — cast at the boundary, the way
    // a value from outside the type system actually arrives (an id that is
    // not a `GlobalKeybindAction` indexes `KEYBIND_REQUIREMENT` to
    // `undefined`; a wire/IPC string arrives unvalidated).
    //
    // What is pinned is the CALLER's contract, not a return value: the
    // policy's `never` arm is compile-time only — `return unreachable` is
    // `return undefined` at runtime — so the only thing that can fail closed
    // is `dispatchKeybind`'s `!verdict?.accept`. An unguarded
    // `verdict.accept` throws a `TypeError` there, outside the `try` that
    // wraps only `#runKeybind`, i.e. an unhandled rejection from a keypress
    // possibly made in another application. The one thing this MUST never
    // do is accept.
    const outOfUnion: unknown[] = [undefined, null, "", "voice", "room ", 0];
    for (const requirement of outOfUnion) {
      const verdict = decideKeybindDispatch({
        ...press(),
        requirement,
      } as unknown as KeybindDispatchInput) as
        | KeybindDispatchVerdict
        | undefined;

      assert.notDeepEqual(
        verdict,
        { accept: true },
        `accepted an out-of-union requirement ${String(requirement)}`,
      );
      assert.equal(
        !verdict?.accept,
        true,
        `a caller reading !verdict?.accept would not drop ${String(requirement)}`,
      );
    }
  });

  it("can produce every KeybindDropReason, so no arm is dead", () => {
    const cases: Record<KeybindDropReason, KeybindDispatchInput> = {
      "in-flight": press({ inFlight: true }),
      "rate-limited": press({ now: 10_000, lastAccepted: 9_999 }),
      "needs-room": press({
        action: ROOM_ACTION,
        requirement: "room",
        hasRoom: false,
      }),
      "needs-incoming-call": press({
        action: "accept-call",
        requirement: "incoming-call",
        hasIncomingCall: false,
      }),
      "has-room": press({
        action: "accept-call",
        requirement: "incoming-call",
        hasIncomingCall: true,
        hasRoom: true,
      }),
      "ptt-held": press({ action: "toggle-mute", pttHeld: true }),
      "needs-fullscreen": press({
        action: "toggle-theater",
        isFullscreen: false,
      }),
    };
    for (const [reason, input] of Object.entries(cases)) {
      assertRejected(decideKeybindDispatch(input), reason as KeybindDropReason);
    }
  });
});
