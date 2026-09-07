// Unit spec for the T0d negotiating fail-safe — run with Node's built-in
// runner:
//   node --test components/rtc/mlsNegotiatingFailsafe.test.ts
// Focus: the fail-safe fires ONLY for the condition it is specified for (no
// verdict from the DS), the three pre-existing arms are unchanged, and the
// two terms added since — a latched loud verdict, a rate-limited probe — can
// only ever turn a release into a hold, never the reverse.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type NegotiatingFailsafeInput,
  MAX_FAILSAFE_REARMS,
  negotiatingFailsafeAction,
} from "./mlsNegotiatingFailsafe.ts";

const PROBES = ["open", "pending", "none", "ratelimited"] as const;

/** The pre-latch, pre-rate-limit shape every original case was written in. */
function quiet(
  input: Omit<NegotiatingFailsafeInput, "loudLatched">,
): NegotiatingFailsafeInput {
  return { ...input, loudLatched: false };
}

// 🔴 THE REGRESSION. A 409 conflict is a verdict — the DS answered, fast — and
// the join it routes to is bounded by MAX_JOINER_RETRIES * JOINER_RETRY_MS
// (30 s), six times this fail-safe's 5 s window. Before this term existed,
// every conflicted join latched loud RE-SECURING at 5 s on a healthy session:
// every joiner, every call with an existing group.
test("a DS verdict disarms the fail-safe, even with an open group", () => {
  assert.equal(
    negotiatingFailsafeAction(
      quiet({ dsVerdictSeen: true, probe: "open", rearmsUsed: 0 }),
    ),
    "ignore",
  );
});

test("a DS verdict disarms it for every probe state", () => {
  for (const probe of PROBES) {
    assert.equal(
      negotiatingFailsafeAction(
        quiet({ dsVerdictSeen: true, probe, rearmsUsed: 0 }),
      ),
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
    negotiatingFailsafeAction(
      quiet({ dsVerdictSeen: false, probe: "open", rearmsUsed: 0 }),
    ),
    "resecure",
  );
});

test("no verdict + a pending probe re-arms, bounded", () => {
  assert.equal(
    negotiatingFailsafeAction(
      quiet({
        dsVerdictSeen: false,
        probe: "pending",
        rearmsUsed: MAX_FAILSAFE_REARMS - 1,
      }),
    ),
    "rearm",
  );
  // Past the bound the probe shares the DS's unreachability, so the
  // availability escape applies rather than an unbounded hold.
  assert.equal(
    negotiatingFailsafeAction(
      quiet({
        dsVerdictSeen: false,
        probe: "pending",
        rearmsUsed: MAX_FAILSAFE_REARMS,
      }),
    ),
    "release",
  );
});

test("no verdict + no open group releases the gate (availability escape)", () => {
  assert.equal(
    negotiatingFailsafeAction(
      quiet({ dsVerdictSeen: false, probe: "none", rearmsUsed: 0 }),
    ),
    "release",
  );
});

// 🔴 The safety property, asserted directly rather than inferred from the
// cases above: adding `dsVerdictSeen` may only ever turn an alarm OFF. It must
// never turn a hold into a release, because that would resume plaintext on a
// call known to have an E2EE group.
test("the verdict term never converts a hold into a release", () => {
  for (const probe of PROBES) {
    for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
      const without = negotiatingFailsafeAction(
        quiet({ dsVerdictSeen: false, probe, rearmsUsed }),
      );
      const with_ = negotiatingFailsafeAction(
        quiet({ dsVerdictSeen: true, probe, rearmsUsed }),
      );
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

// 🔴 THE 2026-09-06 SHAPE. A create that fails inside the 5 s window (a 429
// past the transport's bounded retries, a 5xx) goes through `#onLoud`: state
// `failed`, loud latched, chip NOT-ENCRYPTED, banner promising that publishing
// is paused — and the mode still `negotiating`. The fail-safe then saw no
// verdict and a completed no-group probe and RELEASED the gate: plaintext
// under a red chip, five seconds after the user was told it was paused.
test("a latched loud verdict disarms the fail-safe for every input", () => {
  for (const probe of PROBES) {
    for (const dsVerdictSeen of [false, true]) {
      for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
        assert.equal(
          negotiatingFailsafeAction({
            dsVerdictSeen,
            probe,
            rearmsUsed,
            loudLatched: true,
          }),
          "ignore",
          `probe ${probe}/verdict ${dsVerdictSeen}/${rearmsUsed}`,
        );
      }
    }
  }
});

// A 429 on the probe is neither a verdict about the group nor unreachability:
// the DS answered, and the budget it refused from is this session's own MLS
// bucket, which only an E2EE call's bring-up spends. Mapping it to "none" made
// it a completed no-group verdict and released the gate.
test("a rate-limited probe holds the gate loud, exactly like an open group", () => {
  for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
    assert.equal(
      negotiatingFailsafeAction(
        quiet({ dsVerdictSeen: false, probe: "ratelimited", rearmsUsed }),
      ),
      "resecure",
      `rearms ${rearmsUsed}`,
    );
  }
});

// The same monotonicity for the new terms: relative to the quiet shape they
// may turn a release into a hold, never a hold into a release.
test("neither new term ever converts a hold into a release", () => {
  for (const probe of PROBES) {
    for (const dsVerdictSeen of [false, true]) {
      for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
        const base = negotiatingFailsafeAction(
          quiet({ dsVerdictSeen, probe, rearmsUsed }),
        );
        const latched = negotiatingFailsafeAction({
          dsVerdictSeen,
          probe,
          rearmsUsed,
          loudLatched: true,
        });
        if (base !== "release") {
          assert.notEqual(latched, "release", `${probe}/${rearmsUsed}`);
        }
      }
    }
  }
});
