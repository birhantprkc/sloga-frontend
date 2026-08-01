// Unit spec for the admit-abort / self-enrolment policy — run with Node's
// built-in runner:
//   node --test components/rtc/mlsAdmitPolicy.test.ts   (Node >=23.6 strips types)
// Focus: no admit abort is silently unclassified, the transient ones are
// re-driven, and an un-enrolled joiner past the ladder is REPORTED.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type AdmitAbort,
  admitAbortIsBenign,
  admitAbortIsRetryable,
  enrolmentVerdict,
} from "./mlsAdmitPolicy.ts";

const ALL: AdmitAbort[] = [
  "not_active",
  "other_group",
  "state_unavailable",
  "not_a_member",
  "already_member",
  "call_full",
  "claim_failed",
  "feature_disabled",
];

test("every abort reason is classified (no silent fallthrough)", () => {
  for (const abort of ALL) {
    assert.equal(typeof admitAbortIsRetryable(abort), "boolean", abort);
    assert.equal(typeof admitAbortIsBenign(abort), "boolean", abort);
  }
});

test("the transient aborts that stranded the joiner are ALL retryable", () => {
  // These are exactly the bare `return`s the admit path used to take between
  // receiving a verified join request and claiming a KeyPackage. The joiner
  // stops re-broadcasting after ~40 s, so a non-retryable classification here
  // reintroduces the original bug: a group stuck at epoch 0 forever.
  for (const abort of [
    "not_active",
    "other_group",
    "state_unavailable",
    "not_a_member",
    "claim_failed",
  ] as const) {
    assert.equal(admitAbortIsRetryable(abort), true, abort);
  }
});

test("terminal aborts do not retry", () => {
  for (const abort of [
    "already_member",
    "call_full",
    "feature_disabled",
  ] as const) {
    assert.equal(admitAbortIsRetryable(abort), false, abort);
  }
});

test("only self-reporting refusals are benign", () => {
  assert.equal(admitAbortIsBenign("already_member"), true);
  assert.equal(admitAbortIsBenign("call_full"), true);
  assert.equal(admitAbortIsBenign("feature_disabled"), true);
  // A participant we could not admit IS a downgrade — never benign.
  for (const abort of [
    "not_active",
    "other_group",
    "state_unavailable",
    "not_a_member",
    "claim_failed",
  ] as const) {
    assert.equal(admitAbortIsBenign(abort), false, abort);
  }
});

test("enrolment: our own leaf in the verified roster is the only proof", () => {
  assert.equal(
    enrolmentVerdict({
      selfInRoster: true,
      ladderExhausted: false,
      terminal: false,
    }),
    "enrolled",
  );
  // Proof survives an exhausted ladder (a late but successful join).
  assert.equal(
    enrolmentVerdict({
      selfInRoster: true,
      ladderExhausted: true,
      terminal: false,
    }),
    "enrolled",
  );
});

test("enrolment: un-enrolled mid-ladder is PENDING, never a false alarm", () => {
  assert.equal(
    enrolmentVerdict({
      selfInRoster: false,
      ladderExhausted: false,
      terminal: false,
    }),
    "pending",
  );
});

test("enrolment: un-enrolled with the ladder spent is the SILENT-DOWNGRADE case", () => {
  // The regression guard for the reported bug: a joiner whose join never
  // completed must report, not stay quiet.
  assert.equal(
    enrolmentVerdict({
      selfInRoster: false,
      ladderExhausted: true,
      terminal: false,
    }),
    "not_enrolled",
  );
});

test("enrolment: terminal modes never raise a second alarm", () => {
  // Plain voice call (feature off) and a cap-refused joiner both correctly
  // have no group and are already reported by their own path.
  assert.equal(
    enrolmentVerdict({
      selfInRoster: false,
      ladderExhausted: true,
      terminal: true,
    }),
    "enrolled",
  );
});
