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
  isAdmitTargetRefusal,
} from "./mlsAdmitPolicy.ts";

const ALL: AdmitAbort[] = [
  "not_active",
  "other_group",
  "state_unavailable",
  "not_a_member",
  "leaf_unverifiable",
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
    "leaf_unverifiable",
  ] as const) {
    assert.equal(admitAbortIsRetryable(abort), true, abort);
  }
});

test("mls_leaf_rejected is a TARGET refusal, not a session failure", () => {
  // The production wedge: this error reached `#onLoud`, which set the session
  // to `failed`, after which the `#state !== "active"` guard dropped EVERY
  // later join request — one unverifiable device disabling E2EE admission for
  // the whole call.
  assert.equal(
    isAdmitTargetRefusal({
      type: "mls_leaf_rejected",
      reason: "unknown_identity",
      user_id: "01KWFKG47HBFTEEN6XPPS8H3HN",
      device_id: "68410341a7718dfa88e5517924f2d10f",
    }),
    true,
  );
});

test("genuine session failures are NOT treated as target refusals", () => {
  for (const error of [
    { type: "mls_group_not_found" },
    { type: "mls_poisoned_epoch" },
    { type: "storage" },
    new Error("boom"),
    null,
    undefined,
    "mls_leaf_rejected", // a bare string is not the structured native error
  ]) {
    assert.equal(isAdmitTargetRefusal(error), false, String(error));
  }
});

test("a refused target is retryable but never benign", () => {
  // Retryable: a pin can land mid-call (device-list event, DM open, roster
  // reconcile) and the re-drive re-runs the reconcile first.
  assert.equal(admitAbortIsRetryable("leaf_unverifiable"), true);
  // Not benign: that participant genuinely is NOT in the encryption group.
  assert.equal(admitAbortIsBenign("leaf_unverifiable"), false);
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
    "leaf_unverifiable",
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
