// Unit spec for the T0d negotiating fail-safe — run with Node's built-in
// runner:
//   node --test components/rtc/mlsNegotiatingFailsafe.test.ts
// Focus: the fail-safe fires ONLY for the condition it is specified for (no
// verdict from the DS), the three pre-existing arms are unchanged, and the
// terms added since — a latched loud verdict, a rate-limited probe, a
// rate-limited transport — can only ever turn a release into a hold, never
// the reverse.
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
  input: Omit<NegotiatingFailsafeInput, "loudLatched" | "transportRatelimited">,
): NegotiatingFailsafeInput {
  return { ...input, loudLatched: false, transportRatelimited: false };
}

/** The terms added on top of the quiet shape, alone and together. */
const ADDED_TERMS: Partial<NegotiatingFailsafeInput>[] = [
  { loudLatched: true },
  { transportRatelimited: true },
  { loudLatched: true, transportRatelimited: true },
];

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
      for (const transportRatelimited of [false, true]) {
        const without = negotiatingFailsafeAction({
          ...quiet({ dsVerdictSeen: false, probe, rearmsUsed }),
          transportRatelimited,
        });
        const with_ = negotiatingFailsafeAction({
          ...quiet({ dsVerdictSeen: true, probe, rearmsUsed }),
          transportRatelimited,
        });
        if (without === "resecure" || without === "rearm") {
          assert.notEqual(
            with_,
            "release",
            `probe ${probe}/${rearmsUsed}/transport ${transportRatelimited}: ` +
              "a held gate must not become a release",
          );
        }
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
        for (const transportRatelimited of [false, true]) {
          assert.equal(
            negotiatingFailsafeAction({
              dsVerdictSeen,
              probe,
              rearmsUsed,
              loudLatched: true,
              transportRatelimited,
            }),
            "ignore",
            `probe ${probe}/verdict ${dsVerdictSeen}/${rearmsUsed}/` +
              `transport ${transportRatelimited}`,
          );
        }
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

// 🔴 THE 2026-09-06 RELEASE. The KeyPackage publish (or the create itself)
// sat in the transport's 429 wait: `#ensureKeyPackages` is best-effort and
// had returned, the create had not answered (no verdict), nothing was
// latched, and the probe — its own budget spent — read "none". At 5 s that
// is the release arm: plaintext to the SFU under NO chip (a `starting`
// session renders as nothing) for the 30-40 s until the create landed.
test("a rate-limited transport holds the gate loud with no verdict and no group", () => {
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: false,
      probe: "none",
      rearmsUsed: 0,
      loudLatched: false,
      transportRatelimited: true,
    }),
    "resecure",
  );
  // Whatever the probe happened to say, and however many re-arms are spent:
  // the DS answered, so the availability escape's premise is false.
  for (const probe of PROBES) {
    for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
      assert.equal(
        negotiatingFailsafeAction({
          dsVerdictSeen: false,
          probe,
          rearmsUsed,
          loudLatched: false,
          transportRatelimited: true,
        }),
        "resecure",
        `probe ${probe}/${rearmsUsed}`,
      );
    }
  }
});

// The transport term is a HOLD, not a verdict: folding it into
// `dsVerdictSeen` would read "ignore" — a silent hold under a "none" chip.
// And once the DS does answer, the wait is over and the term steps aside.
test("a rate-limited transport is never ignored until the DS answers", () => {
  assert.notEqual(
    negotiatingFailsafeAction({
      dsVerdictSeen: false,
      probe: "none",
      rearmsUsed: 0,
      loudLatched: false,
      transportRatelimited: true,
    }),
    "ignore",
  );
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: true,
      probe: "none",
      rearmsUsed: 0,
      loudLatched: false,
      transportRatelimited: true,
    }),
    "ignore",
  );
});

// The same monotonicity for every added term, alone and together: relative
// to the quiet shape they may turn a release into a hold, never a hold into
// a release.
test("no added term ever converts a hold into a release", () => {
  for (const probe of PROBES) {
    for (const dsVerdictSeen of [false, true]) {
      for (const rearmsUsed of [0, MAX_FAILSAFE_REARMS]) {
        const base = negotiatingFailsafeAction(
          quiet({ dsVerdictSeen, probe, rearmsUsed }),
        );
        for (const added of ADDED_TERMS) {
          const withTerm = negotiatingFailsafeAction({
            ...quiet({ dsVerdictSeen, probe, rearmsUsed }),
            ...added,
          });
          if (base !== "release") {
            assert.notEqual(
              withTerm,
              "release",
              `${probe}/${dsVerdictSeen}/${rearmsUsed}/${JSON.stringify(added)}`,
            );
          }
        }
      }
    }
  }
});
