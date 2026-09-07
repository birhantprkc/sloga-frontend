// Unit spec for the T0d negotiating fail-safe — run with Node's built-in
// runner:
//   node --test components/rtc/mlsNegotiatingFailsafe.test.ts
// Focus: since 2026-09-06 the fail-safe can only ever HOLD the publish gate.
// It steps aside ("ignore") when the DS has answered or a loud verdict is
// already latched, and goes amber RE-SECURING ("resecure") for every other
// input — whatever the open-group probe says. The availability escape that
// used to release the gate on "no verdict + no open group" is withdrawn, and
// the exhaustive checks at the bottom prove no input can bring it back.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type NegotiatingFailsafeAction,
  type NegotiatingFailsafeInput,
  negotiatingFailsafeAction,
  negotiatingFailsafeReason,
} from "./mlsNegotiatingFailsafe.ts";

const PROBES = ["open", "pending", "none", "ratelimited"] as const;
const BOOLS = [false, true] as const;

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

/** Every input the function can be given. */
function* everyInput(): Generator<NegotiatingFailsafeInput> {
  for (const probe of PROBES) {
    for (const dsVerdictSeen of BOOLS) {
      for (const loudLatched of BOOLS) {
        for (const transportRatelimited of BOOLS) {
          yield { probe, dsVerdictSeen, loudLatched, transportRatelimited };
        }
      }
    }
  }
}

// 🔴 THE 08-16 REGRESSION, unchanged. A 409 conflict is a verdict — the DS
// answered, fast — and the join it routes to is bounded by
// MAX_JOINER_RETRIES * JOINER_RETRY_MS (30 s), six times this fail-safe's 5 s
// window. Before this term existed, every conflicted join latched loud
// RE-SECURING at 5 s on a healthy session: every joiner, every call with an
// existing group.
test("a DS verdict disarms the fail-safe, even with an open group", () => {
  assert.equal(
    negotiatingFailsafeAction(quiet({ dsVerdictSeen: true, probe: "open" })),
    "ignore",
  );
});

test("a DS verdict disarms it for every probe state", () => {
  for (const probe of PROBES) {
    assert.equal(
      negotiatingFailsafeAction(quiet({ dsVerdictSeen: true, probe })),
      "ignore",
      `probe ${probe} should be ignored once the DS has answered`,
    );
  }
});

// The arm that never changed: with no verdict and a known open group, the
// gate holds and the chip goes amber — never an auto-resume on an E2EE-known
// call.
test("no verdict + an open group stays loud — never an auto-resume", () => {
  assert.equal(
    negotiatingFailsafeAction(quiet({ dsVerdictSeen: false, probe: "open" })),
    "resecure",
  );
});

// 🔴 THE 2026-09-06 DECISION. This exact input used to be the availability
// escape: "no verdict AND the probe says no open group ⇒ the DS is
// unreachable ⇒ release the gate, keep negotiating quietly". It released
// plaintext to the SFU under NO chip (a `starting` session renders as
// nothing) whenever the create was merely slow. Withdrawn: the gate is never
// released without a verdict, and the delay is shown as amber RE-SECURING.
test("no verdict + no open group + nothing latched holds the gate amber", () => {
  assert.equal(
    negotiatingFailsafeAction(quiet({ dsVerdictSeen: false, probe: "none" })),
    "resecure",
  );
});

// The probe being unresolved used to defer the decision ("rearm", bounded)
// so a late "none" could still release. With no release to decide, waiting
// only delayed the amber chip — a silent hold under a "none" chip, the user
// parked muted with nothing on screen saying why.
test("no verdict + a pending probe holds the gate amber at once", () => {
  assert.equal(
    negotiatingFailsafeAction(
      quiet({ dsVerdictSeen: false, probe: "pending" }),
    ),
    "resecure",
  );
});

// A 429 on the probe is neither a verdict about the group nor unreachability:
// the DS answered, and the budget it refused from is this session's own MLS
// bucket, which only an E2EE call's bring-up spends.
test("no verdict + a rate-limited probe holds the gate amber", () => {
  assert.equal(
    negotiatingFailsafeAction(
      quiet({ dsVerdictSeen: false, probe: "ratelimited" }),
    ),
    "resecure",
  );
});

// A create that fails inside the 5 s window (a 429 past the transport's
// bounded retries, a 5xx) goes through `#onLoud`: state `failed`, loud
// latched, chip NOT-ENCRYPTED, banner promising that publishing is paused —
// and the mode still `negotiating`. That path holds the gate and owns the
// only escape (the native-confirmed "Stay unencrypted"); the fail-safe has
// nothing left to add, and must not flip the state under a red chip.
test("a latched loud verdict disarms the fail-safe for every input", () => {
  for (const input of everyInput()) {
    if (!input.loudLatched) continue;
    assert.equal(
      negotiatingFailsafeAction(input),
      "ignore",
      JSON.stringify(input),
    );
  }
});

// The KeyPackage publish (or the create itself) sat in the transport's 429
// wait: `#ensureKeyPackages` is best-effort and had returned, the create had
// not answered (no verdict), nothing was latched, and the probe — its own
// budget spent — read "none". Under the withdrawn escape that was plaintext
// to the SFU under NO chip for the 30-40 s until the create landed.
test("a rate-limited transport holds the gate amber for every probe", () => {
  for (const probe of PROBES) {
    assert.equal(
      negotiatingFailsafeAction({
        dsVerdictSeen: false,
        probe,
        loudLatched: false,
        transportRatelimited: true,
      }),
      "resecure",
      `probe ${probe}`,
    );
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
      loudLatched: false,
      transportRatelimited: true,
    }),
    "ignore",
  );
  assert.equal(
    negotiatingFailsafeAction({
      dsVerdictSeen: true,
      probe: "none",
      loudLatched: false,
      transportRatelimited: true,
    }),
    "ignore",
  );
});

// 🔴 The safety property, asserted over the WHOLE input space rather than
// inferred from the cases above: the function has no release arm. Whatever
// it is told, the publish gate stays held — the only question is whether the
// hold is shown (amber) or left to the path that already owns it.
test("no input can release the gate — every outcome is a hold", () => {
  const HOLDS: readonly NegotiatingFailsafeAction[] = ["ignore", "resecure"];
  for (const input of everyInput()) {
    const action = negotiatingFailsafeAction(input);
    assert.ok(
      HOLDS.includes(action),
      `${JSON.stringify(input)} produced ${action}`,
    );
  }
});

// The complete rule, stated once: "ignore" exactly when the DS has answered
// or a loud verdict is latched; amber RE-SECURING otherwise. The probe and
// the transport wait never change the outcome, only the logged reason.
test("the decision depends on the verdict and the latch alone", () => {
  for (const input of everyInput()) {
    assert.equal(
      negotiatingFailsafeAction(input),
      input.loudLatched || input.dsVerdictSeen ? "ignore" : "resecure",
      JSON.stringify(input),
    );
  }
});

// Monotonicity, kept from the pre-decision spec: relative to the quiet shape,
// an added term may turn an alarm into silence (a latch already owns the
// hold), never a hold into anything that is not a hold — and a transport
// wait alone never silences the alarm.
test("no added term ever converts a hold into anything but a hold", () => {
  for (const probe of PROBES) {
    for (const dsVerdictSeen of BOOLS) {
      const base = negotiatingFailsafeAction(quiet({ dsVerdictSeen, probe }));
      for (const added of ADDED_TERMS) {
        const withTerm = negotiatingFailsafeAction({
          ...quiet({ dsVerdictSeen, probe }),
          ...added,
        });
        assert.ok(
          withTerm === "ignore" || withTerm === "resecure",
          `${probe}/${dsVerdictSeen}/${JSON.stringify(added)}`,
        );
        if (base === "resecure" && !added.loudLatched) {
          assert.equal(
            withTerm,
            "resecure",
            `${probe}/${dsVerdictSeen}/${JSON.stringify(added)}: ` +
              "only a latch may silence the alarm",
          );
        }
      }
    }
  }
});

// The reason is the operator's only tell for WHY a start sits amber. A
// transport wait outranks the probe (it IS the delay); every probe value
// names itself; nothing here is ever empty.
test("the RE-SECURING reason names the wait", () => {
  assert.match(
    negotiatingFailsafeReason({
      dsVerdictSeen: false,
      probe: "none",
      loudLatched: false,
      transportRatelimited: true,
    }),
    /rate limit/,
  );
  assert.match(
    negotiatingFailsafeReason(
      quiet({ dsVerdictSeen: false, probe: "ratelimited" }),
    ),
    /probe was rate limited/,
  );
  assert.match(
    negotiatingFailsafeReason(quiet({ dsVerdictSeen: false, probe: "open" })),
    /open E2EE group/,
  );
  assert.match(
    negotiatingFailsafeReason(
      quiet({ dsVerdictSeen: false, probe: "pending" }),
    ),
    /still pending/,
  );
  for (const input of everyInput()) {
    assert.match(
      negotiatingFailsafeReason(input),
      /no delivery-service verdict/,
      JSON.stringify(input),
    );
  }
});
