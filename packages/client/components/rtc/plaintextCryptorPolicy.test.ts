// Unit spec for the plaintext cryptor disarm (silent-peer fix, 2026-08-30).
//   node --test components/rtc/plaintextCryptorPolicy.test.ts   (Node >=23.6 strips types)
// Focus: an explicit NONE disarms, an explicitly encrypted publication vetoes
// the whole participant, `undefined` alone never disarms (E2EE info can lag),
// and the runtime probe of the @internal manager surface distinguishes "no
// manager" (benign) from "surface removed" (must warn).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ENCRYPTION_TYPE_NONE,
  type RemotePublicationEncryption,
  cryptorDisarmIdentities,
  resolveCryptorControl,
} from "./plaintextCryptorPolicy.ts";

const pub = (
  participantIdentity: string,
  encryption: number | undefined,
): RemotePublicationEncryption => ({ participantIdentity, encryption });

// `Encryption_Type.GCM` (@livekit/protocol), mirrored like the module mirrors
// NONE — pnpm's isolated layout keeps the transitive package out of reach of
// bare `node --test`, so the enum cannot be imported here.
const ENCRYPTION_TYPE_GCM = 1;

// ---- Enum pin --------------------------------------------------------------

test("ENCRYPTION_TYPE_NONE mirrors @livekit/protocol's Encryption_Type.NONE (0)", () => {
  // Proto3 pins NONE = 0 on the wire forever; a change would be a breaking
  // protocol rewrite, so the literal pin is safe.
  assert.equal(ENCRYPTION_TYPE_NONE, 0);
});

// ---- cryptorDisarmIdentities -----------------------------------------------

test("a publication explicitly declaring NONE disarms its participant", () => {
  assert.deepEqual(cryptorDisarmIdentities([pub("linux-peer", 0)]), [
    "linux-peer",
  ]);
});

test("several NONE publications disarm the participant once", () => {
  assert.deepEqual(
    cryptorDisarmIdentities([
      pub("peer", 0),
      pub("peer", 0),
      pub("peer", 0),
    ]),
    ["peer"],
  );
});

test("an explicitly encrypted publication never disarms", () => {
  assert.deepEqual(
    cryptorDisarmIdentities([pub("peer", ENCRYPTION_TYPE_GCM)]),
    [],
  );
});

test("an encrypted publication vetoes a sibling NONE (never break a real cryptor)", () => {
  assert.deepEqual(
    cryptorDisarmIdentities([
      pub("peer", 0),
      pub("peer", ENCRYPTION_TYPE_GCM),
    ]),
    [],
  );
  // Veto is order-independent — evidence accumulates, it doesn't race.
  assert.deepEqual(
    cryptorDisarmIdentities([
      pub("peer", ENCRYPTION_TYPE_GCM),
      pub("peer", 0),
    ]),
    [],
  );
});

test("undefined alone is no evidence — never disarms", () => {
  // On a genuine E2EE call the trackInfo can lag the publication; a disarm
  // there would feed ciphertext straight to the decoder.
  assert.deepEqual(cryptorDisarmIdentities([pub("peer", undefined)]), []);
});

test("undefined does not veto a sibling's explicit NONE", () => {
  assert.deepEqual(
    cryptorDisarmIdentities([pub("peer", undefined), pub("peer", 0)]),
    ["peer"],
  );
});

test("participants are judged independently, first-seen order preserved", () => {
  assert.deepEqual(
    cryptorDisarmIdentities([
      pub("plain-b", 0),
      pub("armed", ENCRYPTION_TYPE_GCM),
      pub("plain-a", 0),
      pub("lagging", undefined),
    ]),
    ["plain-b", "plain-a"],
  );
});

test("no publications, no disarms", () => {
  assert.deepEqual(cryptorDisarmIdentities([]), []);
});

// ---- resolveCryptorControl -------------------------------------------------

test("no room / no manager → no-manager (benign: no transform installed)", () => {
  assert.deepEqual(resolveCryptorControl(undefined), { kind: "no-manager" });
  assert.deepEqual(resolveCryptorControl(null), { kind: "no-manager" });
  assert.deepEqual(resolveCryptorControl({}), { kind: "no-manager" });
  assert.deepEqual(resolveCryptorControl({ e2eeManager: undefined }), {
    kind: "no-manager",
  });
});

test("manager present but setter gone → unsupported (caller must warn)", () => {
  assert.deepEqual(resolveCryptorControl({ e2eeManager: {} }), {
    kind: "unsupported",
  });
  assert.deepEqual(
    resolveCryptorControl({
      e2eeManager: { setParticipantCryptorEnabled: "not-a-function" },
    }),
    { kind: "unsupported" },
  );
});

test("control forwards (enabled, identity) with the manager as `this`", () => {
  const calls: Array<{
    self: unknown;
    enabled: boolean;
    identity: string;
  }> = [];
  const manager = {
    setParticipantCryptorEnabled(enabled: boolean, identity: string) {
      calls.push({ self: this, enabled, identity });
    },
  };
  const probe = resolveCryptorControl({ e2eeManager: manager });
  assert.equal(probe.kind, "control");
  if (probe.kind !== "control") return;
  probe.control(false, "linux-peer");
  assert.deepEqual(calls, [
    { self: manager, enabled: false, identity: "linux-peer" },
  ]);
});
