// Unit spec for the pause-clause hysteresis hold (banner-honesty wave 3).
//   node --test --conditions=browser components/rtc/pauseClauseHold.test.ts
// Focus: `"disproved"` is the one banner clause with teeth ("may still be
// sending — leave the call"), and the verdict beneath it can bounce
// disproved → quiet → disproved across confirm cycles. The hold keeps the
// clause up for `PAUSE_DISPROOF_HOLD_MS` after the LAST disproof so the
// bounce reads as one warning — but it must NEVER outlive the banner it
// softens: the moment the banner goes `none` or its own clause goes `none`
// the hold drops and `heldUntil` resets to 0. The module is dependency-free
// (a type-only import of `CallBanner`) precisely so every arm is reachable
// by `node --test` and by `scripts/rtc-mutations.py`; the timer that
// re-evaluates on expiry lives in the banner component and is live-only.
import assert from "node:assert/strict";
import { test } from "node:test";

import type { CallBanner } from "./mlsCallModePolicy.ts";
import {
  type HoldState,
  NO_HOLD,
  PAUSE_DISPROOF_HOLD_MS,
  holdExpiresIn,
  holdPauseClause,
} from "./pauseClauseHold.ts";

// The production caller (`VoiceCallDowngradeBanner.tsx`) always passes the
// `{ banner, now }` bag; every call below does the same so the spec exercises
// the real signature and not a convenience overload it does not have.
const fold = (prev: HoldState, banner: CallBanner, now: number) =>
  holdPauseClause(prev, { banner, now });

const DISPROVED: CallBanner = { kind: "terminal_loud", pause: "disproved" };
const HELD: CallBanner = { kind: "terminal_loud", pause: "held" };

// ---- Arming ----------------------------------------------------------------

/**
 * Kills `hold-never-expires` (HOLD → `Number.MAX_SAFE_INTEGER`) and
 * `hold-is-zero` (HOLD → 0): a disproof at `now` arms a window that ends
 * exactly `PAUSE_DISPROOF_HOLD_MS` (15 s) later — not never, not already.
 * The literal 15_000 is pinned on purpose: it is the session's
 * `REUPGRADE_HYSTERESIS_MS`, and the two bound the same bounce.
 */
test("B1: a disproof arms a 15 s hold from `now` and reads disproved", () => {
  const now = 1_000;
  const result = fold(NO_HOLD, DISPROVED, now);
  assert.equal(result.pause, "disproved");
  assert.equal(result.state.heldUntil, now + 15_000);
  assert.equal(holdExpiresIn(result.state, now), 15_000);
  // Pinned LAST so the behavioural assertions above are what fail under a
  // HOLD mutant, not this constant.
  assert.equal(PAUSE_DISPROOF_HOLD_MS, 15_000);
});

/**
 * Kills `hold-is-zero`: with the hold live, a gated kind whose own clause is
 * only `"held"` keeps reading `"disproved"`, and the state object comes back
 * by IDENTITY (a memo keyed on it must not churn every tick). Under HOLD → 0
 * the window is already closed at `now + 1` and the clause collapses to
 * `"held"`.
 */
test("B2: inside the window a held gated kind stays disproved, state by identity", () => {
  const armed = fold(NO_HOLD, DISPROVED, 5_000);
  const result = fold(armed.state, HELD, 5_001);
  assert.equal(result.pause, "disproved");
  assert.strictEqual(result.state, armed.state);
  assert.equal(result.state.heldUntil, 20_000);
});

// ---- Expiry ----------------------------------------------------------------

/**
 * Kills `hold-never-expires`: at `now === heldUntil` EXACTLY the hold has
 * lapsed (the window is half-open, `now < heldUntil`), the clause passes
 * `"held"` through, `heldUntil` resets to 0 and the caller's timer sizing
 * reads 0 ("do not arm").
 */
test("B3: at `now === heldUntil` the hold has lapsed", () => {
  const armed = fold(NO_HOLD, DISPROVED, 5_000);
  assert.equal(armed.state.heldUntil, 20_000);
  // The tick is the LITERAL 20_000, not `armed.state.heldUntil`: under a
  // never-expiring HOLD the derived value would still "lapse" and the pin
  // would go vacuous.
  const result = fold(armed.state, HELD, 20_000);
  assert.equal(result.pause, "held");
  assert.equal(result.state.heldUntil, 0);
  assert.equal(holdExpiresIn(result.state, 20_000), 0);
});

/**
 * Kills both HOLD mutants: a second disproof re-arms from the LATER tick,
 * so the hold measures time since the last disproof, not the first. Armed
 * at 5000 then again at 20000 the window ends at 35000 — a value neither
 * `MAX_SAFE_INTEGER` nor 0 can produce.
 */
test("B4: a second disproof re-arms the hold from the later tick", () => {
  const first = fold(NO_HOLD, DISPROVED, 5_000);
  assert.equal(first.state.heldUntil, 20_000);
  const second = fold(first.state, DISPROVED, 20_000);
  assert.equal(second.pause, "disproved");
  assert.equal(second.state.heldUntil, 35_000);
  assert.equal(holdExpiresIn(second.state, 20_000), 15_000);
});

// ---- Dropping --------------------------------------------------------------

/**
 * Kills `hold-survives-green` (the `banner.kind === "none"` clear dropped):
 * a `none` banner inside the window drops the hold at once even when its
 * pause field is not `"none"`. The real `callBanner` never emits
 * `{ kind: "none", pause: "held" }` — this literal is built BY HAND so that
 * the `kind === "none"` disjunct is the only thing standing between a green
 * call and a "may still be sending" line held over it. That is the false red
 * this slice exists to remove, so the rule needs its own pin.
 */
test("B5: a hand-built `{ kind: none, pause: held }` inside the window drops the hold", () => {
  const armed = fold(NO_HOLD, DISPROVED, 5_000);
  const green: CallBanner = { kind: "none", pause: "held" };
  const result = fold(armed.state, green, 5_001);
  assert.equal(result.pause, "held");
  assert.equal(result.state.heldUntil, 0);
  assert.equal(holdExpiresIn(result.state, 5_001), 0);
});

/**
 * A raised kind whose own clause is `"none"` (the user confirmed plaintext
 * on an interlude) drops the hold inside the window: nothing is held, so
 * nothing about a pause may be said, and `heldUntil` resets to 0.
 */
test("B6: a raised kind with `pause: none` inside the window drops the hold", () => {
  const armed = fold(NO_HOLD, DISPROVED, 5_000);
  const confirmed: CallBanner = { kind: "interlude", pause: "none" };
  const result = fold(armed.state, confirmed, 5_001);
  assert.equal(result.pause, "none");
  assert.equal(result.state.heldUntil, 0);
  assert.equal(holdExpiresIn(result.state, 5_001), 0);
});

/**
 * Once dropped, the hold stays dropped: a later `"held"` tick that would
 * still have fallen inside the OLD window does not revive `"disproved"`.
 * Only a fresh disproof can re-arm.
 */
test("B9: after a drop a later held tick inside the old window does not revive the hold", () => {
  const armed = fold(NO_HOLD, DISPROVED, 5_000);
  const dropped = fold(
    armed.state,
    { kind: "interlude", pause: "none" },
    5_001,
  );
  assert.equal(dropped.state.heldUntil, 0);
  const later = fold(dropped.state, HELD, 6_000);
  assert.equal(later.pause, "held");
  assert.equal(later.state.heldUntil, 0);
  assert.equal(holdExpiresIn(later.state, 6_000), 0);
});
