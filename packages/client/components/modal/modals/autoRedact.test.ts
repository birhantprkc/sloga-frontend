/**
 * Run: node --test components/modal/modals/autoRedact.test.ts
 * (pure functions — no --conditions=browser needed here)
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { type OcrWord, detectSensitive, luhn } from "./autoRedact.ts";

/**
 * Lay a line of words out left-to-right with unit boxes
 */
function line(lineNo: number, texts: string[], y = lineNo * 20): OcrWord[] {
  let x = 0;
  return texts.map((text) => {
    const w: OcrWord = {
      text,
      x0: x,
      y0: y,
      x1: x + text.length * 8,
      y1: y + 16,
      line: lineNo,
    };
    x += text.length * 8 + 6;
    return w;
  });
}

const kinds = (words: OcrWord[], identity = {}) =>
  detectSensitive(words, identity).map((p) => p.kind);

test("luhn accepts real card shapes and rejects noise", () => {
  assert.equal(luhn("4242424242424242"), true);
  assert.equal(luhn("4111111111111111"), true);
  assert.equal(luhn("4242424242424241"), false);
  assert.equal(luhn("1234567890123"), false);
});

/**
 * Secret-shaped fixtures are assembled at runtime so the literal strings
 * never appear in the source — the repo's pre-commit secret scanner (rightly)
 * flags anything that looks like a JWT or an AKIA key, and these must look
 * exactly like one to be worth testing.
 */
const b64url = (s: string) =>
  Buffer.from(s)
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
const FAKE_JWT = [
  b64url('{"alg":"none"}'),
  b64url('{"sub":"nobody","iat":0}'),
  "x".repeat(24) + "1",
].join(".");
const FAKE_AWS_KEY = "AKIA" + "IOSFODNN7" + "EXAMPLE";

test("email, ssn, ip, jwt are single-word hits", () => {
  const words = [
    ...line(0, ["Contact:", "jeff.s+work@example.co.uk", "today"]),
    ...line(1, ["SSN", "123-45-6789"]),
    ...line(2, ["host", "10.0.0.12:8443"]),
    ...line(3, [FAKE_JWT]),
  ];
  const got = detectSensitive(words);
  assert.deepEqual(
    got.map((p) => [p.kind, p.text]),
    [
      ["email", "jeff.s+work@example.co.uk"],
      ["ssn", "123-45-6789"],
      ["ip", "10.0.0.12:8443"],
      ["secret", FAKE_JWT],
    ],
  );
  // ssn box wraps only its own word, not the label
  const ssn = got.find((p) => p.kind === "ssn")!;
  assert.equal(ssn.x, words[4].x0);
});

test("card numbers: contiguous and space-separated, luhn-gated", () => {
  const good = line(0, [
    "Card",
    "4242",
    "4242",
    "4242",
    "4242",
    "exp",
    "12/28",
  ]);
  const found = detectSensitive(good);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "card");
  // box spans the four groups only
  assert.equal(found[0].x, good[1].x0);
  assert.equal(found[0].x + found[0].w, good[4].x1);

  assert.deepEqual(kinds(line(0, ["4111111111111111"])), ["card"]);
  // fails luhn -> not a card; a bare 16-digit word without separators is
  // also not a phone
  assert.deepEqual(kinds(line(0, ["4242424242424241"])), []);
});

test("phone numbers need separators or multiple pieces", () => {
  assert.deepEqual(kinds(line(0, ["call", "(555)", "123-4567"])), ["phone"]);
  assert.deepEqual(kinds(line(0, ["+1", "555", "123", "4567"])), ["phone"]);
  assert.deepEqual(kinds(line(0, ["555-123-4567"])), ["phone"]);
  // an order id is not a phone number
  assert.deepEqual(kinds(line(0, ["order", "1234567890"])), []);
});

test("labelled values after password/token/pin", () => {
  assert.deepEqual(
    detectSensitive(line(0, ["Password:", "hunter2"])).map((p) => [
      p.kind,
      p.text,
    ]),
    [["labelled", "hunter2"]],
  );
  assert.deepEqual(kinds(line(0, ["token", "=", "abcDEF123"])), ["labelled"]);
  assert.deepEqual(kinds(line(0, ["PIN", "4821"])), ["labelled"]);
  // prose after an ambiguous label is left alone
  assert.deepEqual(kinds(line(0, ["the", "code", "works"])), []);
  assert.deepEqual(kinds(line(0, ["key", "point"])), []);
  // but a value-looking thing after it is caught
  assert.deepEqual(kinds(line(0, ["code", "X9-44Q"])), ["labelled"]);
});

test("secret-shaped strings and provider key prefixes", () => {
  assert.deepEqual(kinds(line(0, ["sk-live-abcdefghijklmnop1234"])), [
    "secret",
  ]);
  assert.deepEqual(kinds(line(0, ["ghp_abcdefghijklmnopqrstuvwxyz1234"])), [
    "secret",
  ]);
  assert.deepEqual(kinds(line(0, [FAKE_AWS_KEY])), ["secret"]);
  // long mixed token
  assert.deepEqual(kinds(line(0, ["a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6"])), [
    "secret",
  ]);
  // long but letters-only (a word) is not a secret
  assert.deepEqual(
    kinds(line(0, ["supercalifragilisticexpialidociousness"])),
    [],
  );
});

test("own identity is redacted, case-insensitively, with or without @", () => {
  const words = line(0, ["hi", "@JeffS", "your", "email", "jeff@sloga.gg"]);
  const got = detectSensitive(words, {
    username: "jeffs",
    email: "jeff@sloga.gg",
  });
  // email regex claims the address first, identity claims the handle
  assert.deepEqual(got.map((p) => [p.kind, p.text]).sort(), [
    ["email", "jeff@sloga.gg"],
    ["identity", "@JeffS"],
  ]);
});

test("a word is claimed once — no overlapping proposals", () => {
  const words = line(0, ["Password:", "jeff@sloga.gg"]);
  const got = detectSensitive(words, { email: "jeff@sloga.gg" });
  assert.equal(got.length, 1);
  assert.equal(got[0].kind, "email");
});

test("plain prose yields nothing", () => {
  const words = [
    ...line(0, ["Meeting", "moved", "to", "3pm,", "room", "204."]),
    ...line(1, ["Bring", "the", "Q3", "deck", "and", "coffee."]),
  ];
  assert.deepEqual(detectSensitive(words), []);
});
