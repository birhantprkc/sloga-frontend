// Unit spec for the T0d negotiating fail-safe — run with Node's built-in
// runner:
//   node --test components/rtc/mlsNegotiatingFailsafe.test.ts
// Focus: the fail-safe fires ONLY for the condition it is specified for (no
// verdict from the DS), and the three pre-existing arms are unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAX_FAILSAFE_REARMS,
  negotiatingFailsafeAction,
} from "./mlsNegotiatingFailsafe.ts";

// 🔴 THE REGRESSION. A 409 conflict is a verdict — the DS answered, fast — and
// the join it routes to is bounded by MAX_JOINER_RETRIES * JOINER_RETRY_MS
// (30 s), six times this fail-safe's 5 s window. Before this term existed,
// every conflicted join latched loud RE-SECURING at 5 s on a healthy session:
// every joiner, every call with an existing group.
test("a DS verdict disarms the fail-safe, even with an open group", () => {
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: true,
      probe: "open",
      rearmsUsed: 0,
    }),
    "ignore",
  );
});

test("a DS verdict disarms it for every probe state", () => {
  for (const probe of ["open", "pending", "none"] as const) {
    assert.equal(
      negotiatingFailsafeAction({ dsVerdictSeen: true, probe, rearmsUsed: 0 }),
      "ignore",
      `probe ${probe} should be ignored once the DS has answered`,
    );
  }
});

// The three arms that must NOT change: with no verdict, this is the only thing
// standing between the user and a call stuck muted (or a silent plaintext
// resume on an E2EE-known call).
test("no verdict + an open group stays loud — never an auto-resume", () => {
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: false,
      probe: "open",
      rearmsUsed: 0,
    }),
    "resecure",
  );
});

test("no verdict + a pending probe re-arms, bounded", () => {
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: false,
      probe: "pending",
      rearmsUsed: MAX_FAILSAFE_REARMS - 1,
    }),
    "rearm",
  );
  // Past the bound the probe shares the DS's unreachability, so the
  // availability escape applies rather than an unbounded hold.
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: false,
      probe: "pending",
      rearmsUsed: MAX_FAILSAFE_REARMS,
    }),
    "release",
  );
});

test("no verdict + no open group releases the gate (availability escape)", () => {
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: false,
      probe: "none",
      rearmsUsed: 0,
    }),
    "release",
  );
});

// 🔴 The safety property, asserted directly rather than inferred from the
// cases above: adding `dsVerdictSeen` may only ever turn an alarm OFF. It must
// never turn a hold into a release, because that would resume plaintext on a
// call known to have an E2EE group.
test("the new term never converts a hold into a release", () => {
  for (const probe of ["open", "pending", "none"] as const) {
    for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
      const without = negotiatingFailsafeAction({
        dsVerdictSeen: false,
        probe,
        rearmsUsed,
      });
      const with_ = negotiatingFailsafeAction({
        dsVerdictSeen: true,
        probe,
        rearmsUsed,
      });
      if (without === "resecure" || without === "rearm") {
        assert.notEqual(
          with_,
          "release",
          `probe ${probe}/${rearmsUsed}: a held gate must not become a release`,
        );
      }
    }
  }
});
