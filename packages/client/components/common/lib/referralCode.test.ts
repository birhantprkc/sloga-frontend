// Specs for referral code parsing — run with Node's built-in runner:
//   node --conditions=browser --test components/common/lib/referralCode.test.ts
//
// normalizeReferralCode must agree with the server's parser on every input,
// so the first table is the server's own test table, case for case.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  REFERRAL_CODE_PREFIX,
  displayReferralCode,
  normalizeReferralCode,
} from "./referralCode.ts";

test("matches the server's normalization table", () => {
  const cases: [string, string | undefined][] = [
    ["KX7P", "KX7P"],
    ["kx7p", "KX7P"],
    ["sloga-kx7p", "KX7P"],
    ["SLOGA KX7P", "KX7P"],
    ["  Sloga-KX7P  ", "KX7P"],
    ["KX7O", "KX70"],
    ["kx7o", "KX70"],
    ["kx7i", "KX71"],
    ["KX7L", "KX71"],
    ["ABCU", undefined],
    ["AB", undefined],
    ["", undefined],
    ["SLOGA", undefined],
    ["KX7PQ", undefined],
    ["SLOGA-KX7PQ", undefined],
    ["KX7!", undefined],
    ["KX7é", undefined],
  ];

  for (const [input, expected] of cases) {
    assert.equal(
      normalizeReferralCode(input),
      expected,
      `input: ${JSON.stringify(input)}`,
    );
  }
});

test("rejects input longer than 32 UTF-8 bytes", () => {
  // 32 bytes of separators around a valid code still parses
  const padded = `${"-".repeat(14)}KX7P${"-".repeat(14)}`;
  assert.equal(new TextEncoder().encode(padded).length, 32);
  assert.equal(normalizeReferralCode(padded), "KX7P");

  // One more byte and it is refused before any cleanup
  const over = `${padded}-`;
  assert.equal(new TextEncoder().encode(over).length, 33);
  assert.equal(normalizeReferralCode(over), undefined);

  // Bytes, not characters: 14 characters but 34 bytes
  const wide = `KX7P${"　".repeat(10)}`;
  assert.equal(wide.length, 14);
  assert.equal(new TextEncoder().encode(wide).length, 34);
  assert.equal(normalizeReferralCode(wide), undefined);
});

test("separators and the prefix", () => {
  assert.equal(normalizeReferralCode("SLOGAKX7P"), "KX7P");
  assert.equal(normalizeReferralCode("sloga_kx_7p"), "KX7P");
  assert.equal(normalizeReferralCode("\tSLOGA\n-KX7P\r\n"), "KX7P");
  // Unicode White_Space, as the server defines it
  assert.equal(normalizeReferralCode("KX7P\u0085"), "KX7P");
  assert.equal(normalizeReferralCode(" KX7P "), "KX7P");
  // U+FEFF is not White_Space for the server, so it is kept and rejected
  assert.equal(normalizeReferralCode("KX7P﻿"), undefined);
  // The prefix is only stripped when a full code follows it
  assert.equal(normalizeReferralCode("SLOGAKX7"), undefined);
  // A cut-off prefix is just four characters, read like any other code
  assert.equal(normalizeReferralCode("SLOG"), "S10G");
  assert.equal(normalizeReferralCode("SLOGA-SLOGA"), undefined);
  // Non-ASCII after the prefix never yields a code
  assert.equal(normalizeReferralCode("SLOGAKX7é"), undefined);
  assert.equal(normalizeReferralCode("SLOGAéé"), undefined);
});

test("uppercases ASCII only", () => {
  // Full Unicode uppercasing would turn these into valid codes
  assert.equal(normalizeReferralCode("kxß"), undefined);
  assert.equal(normalizeReferralCode("kx7ſ"), undefined);
  assert.equal(normalizeReferralCode("kx7ı"), undefined);
});

test("reads look-alikes and covers the whole alphabet", () => {
  assert.equal(normalizeReferralCode("oOiI"), "0011");
  assert.equal(normalizeReferralCode("lLoo"), "1100");
  assert.equal(normalizeReferralCode("u000"), undefined);

  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  for (let i = 0; i < alphabet.length; i += 4) {
    const chunk = alphabet.slice(i, i + 4);
    assert.equal(normalizeReferralCode(chunk), chunk);
    assert.equal(normalizeReferralCode(chunk.toLowerCase()), chunk);
  }

  // Only ASCII letters and digits qualify
  assert.equal(normalizeReferralCode("KX7Ｐ"), undefined);
  // Astral characters count as one character and are rejected
  assert.equal(normalizeReferralCode("KX7😀"), undefined);
});

test("display form", () => {
  assert.equal(REFERRAL_CODE_PREFIX, "SLOGA");
  assert.equal(displayReferralCode("KX7P"), "SLOGA-KX7P");
  // The display form parses back to the same code
  assert.equal(normalizeReferralCode(displayReferralCode("KX70")), "KX70");
});
