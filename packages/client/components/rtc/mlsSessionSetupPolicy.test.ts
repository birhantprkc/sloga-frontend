// Unit spec for the connect-time session-setup decision — run with Node's
// built-in runner:
//   node --conditions=browser --test components/rtc/mlsSessionSetupPolicy.test.ts
// Focus: since 2026-09-06 an E2EE-capable shell that cannot build its MLS
// call session HOLDS the negotiating publish gate and goes loud; it never
// releases to plaintext on its own (R2-4, withdrawn under the same rule as
// the T0d availability escape). A non-capable shell is not an E2EE call and
// gets no gate. The exhaustive checks at the bottom prove that no input can
// bring a silent release back, and that no non-capable input ever holds.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type NoSessionConfirmInput,
  type SessionSetupInput,
  canConfirmNoSessionPlaintext,
  sessionSetupDecision,
} from "./mlsSessionSetupPolicy.ts";

const BOOLS = [false, true] as const;

/** The healthy capable shell: every precondition met. */
const READY: SessionSetupInput = {
  e2eeCapable: true,
  bridge: true,
  keyProvider: true,
  userId: true,
  deviceId: true,
  identityOk: true,
  keysListenerBound: true,
};

/** Every input the function can be given (2^7 = 128 shapes). */
function* everyInput(): Generator<SessionSetupInput> {
  for (const e2eeCapable of BOOLS)
    for (const bridge of BOOLS)
      for (const keyProvider of BOOLS)
        for (const userId of BOOLS)
          for (const deviceId of BOOLS)
            for (const identityOk of BOOLS)
              for (const keysListenerBound of BOOLS)
                yield {
                  e2eeCapable,
                  bridge,
                  keyProvider,
                  userId,
                  deviceId,
                  identityOk,
                  keysListenerBound,
                };
}

test("a capable shell with every precondition met builds the session", () => {
  assert.deepEqual(sessionSetupDecision(READY), { action: "session" });
});

test("capable + setup failed (no key provider) → hold the gate, go loud", () => {
  const decision = sessionSetupDecision({ ...READY, keyProvider: false });
  assert.equal(decision.action, "hold_loud");
});

test("capable + the SFU minted the wrong identity → hold the gate, go loud (the gate used to be released under the red chip)", () => {
  const decision = sessionSetupDecision({ ...READY, identityOk: false });
  assert.equal(decision.action, "hold_loud");
  assert.match(
    decision.action === "hold_loud" ? decision.reason : "",
    /identity that does not name this device/,
  );
});

test("capable + the native key-change listener never registered (bounded by the 45 s deadline) → hold the gate, go loud", () => {
  const decision = sessionSetupDecision({ ...READY, keysListenerBound: false });
  assert.equal(decision.action, "hold_loud");
  assert.match(
    decision.action === "hold_loud" ? decision.reason : "",
    /key-change listener/,
  );
});

test("capable + no E2EE device identity on the bridge yet → hold the gate, go loud (a transient the client cannot tell from a real fault)", () => {
  const decision = sessionSetupDecision({
    ...READY,
    deviceId: false,
    identityOk: false,
  });
  assert.equal(decision.action, "hold_loud");
});

test("non-capable shell → plain call, no gate — whatever else is missing", () => {
  assert.deepEqual(sessionSetupDecision({ ...READY, e2eeCapable: false }), {
    action: "plain",
  });
  assert.deepEqual(
    sessionSetupDecision({
      e2eeCapable: false,
      bridge: false,
      keyProvider: false,
      userId: false,
      deviceId: false,
      identityOk: false,
      keysListenerBound: false,
    }),
    { action: "plain" },
  );
});

// The fail-closed proof: a capable shell can only ever get "session" (every
// precondition met) or "hold_loud" — there is no capable input that reads
// "plain", so nothing here can release the gate without a session to own it.
test("PROOF: no capable input yields plain; only the fully-met input yields session", () => {
  for (const input of everyInput()) {
    const decision = sessionSetupDecision(input);
    if (!input.e2eeCapable) {
      assert.equal(decision.action, "plain", JSON.stringify(input));
      continue;
    }
    assert.notEqual(decision.action, "plain", JSON.stringify(input));
    const allMet =
      input.bridge &&
      input.keyProvider &&
      input.userId &&
      input.deviceId &&
      input.identityOk &&
      input.keysListenerBound;
    assert.equal(
      decision.action,
      allMet ? "session" : "hold_loud",
      JSON.stringify(input),
    );
  }
});

test("PROOF: every hold reason is a call-level statement that never suggests resetting or wiping this device's encryption", () => {
  for (const input of everyInput()) {
    const decision = sessionSetupDecision(input);
    if (decision.action !== "hold_loud") continue;
    assert.doesNotMatch(decision.reason, /wipe|reset|clear|remove/i);
    assert.match(decision.reason, /^This call could not be encrypted: /);
  }
});

// ---- the escape: "Stay unencrypted" with no session ------------------------

const CONFIRMABLE: NoSessionConfirmInput = {
  hasSession: false,
  e2eeCapable: true,
  latchedError: true,
  gateHeld: true,
};

test("Stay unencrypted may release the no-session hold: capable, error latched, gate held, no session", () => {
  assert.equal(canConfirmNoSessionPlaintext(CONFIRMABLE), true);
});

test("a session present routes Stay through the session's native-confirmed path, never this one", () => {
  assert.equal(
    canConfirmNoSessionPlaintext({ ...CONFIRMABLE, hasSession: true }),
    false,
  );
});

test("a non-capable call never had a gate: nothing to release", () => {
  assert.equal(
    canConfirmNoSessionPlaintext({ ...CONFIRMABLE, e2eeCapable: false }),
    false,
  );
});

test("PROOF: the escape needs all four terms — any single missing term refuses", () => {
  for (const hasSession of BOOLS)
    for (const e2eeCapable of BOOLS)
      for (const latchedError of BOOLS)
        for (const gateHeld of BOOLS) {
          const input = { hasSession, e2eeCapable, latchedError, gateHeld };
          assert.equal(
            canConfirmNoSessionPlaintext(input),
            !hasSession && e2eeCapable && latchedError && gateHeld,
            JSON.stringify(input),
          );
        }
});
