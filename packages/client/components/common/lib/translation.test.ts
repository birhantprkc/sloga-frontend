// Specs for the translation transport policy — run with Node's built-in runner:
//   node --test components/common/lib/translation.test.ts
//
// Each spec builds its own translator around a scripted fetch, so the policy
// (timeout, concurrency, circuit breaker, retry) is exercised without a
// network. Timers and the clock are Node's mocks; specs that advance time
// enable them BEFORE constructing anything.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createTranslator } from "./translation.ts";

/** A resolved gtx-shaped response. */
function gtxResponse(trans: string, src: string): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({ sentences: [{ trans }], src }),
  } as unknown as Response;
}

function statusResponse(status: number): Response {
  return { ok: false, status } as unknown as Response;
}

interface ScriptedCall {
  body: string;
  resolve: (response: Response) => void;
  reject: (error: unknown) => void;
}

/**
 * A fetch the spec answers by hand. Honors the abort signal the way the real
 * one does: rejecting with an AbortError DOMException.
 */
function scriptedFetch() {
  const calls: ScriptedCall[] = [];
  const fn: typeof fetch = (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("The operation was aborted.", "AbortError")),
      );
      calls.push({ body: String(init?.body), resolve, reject });
    });
  return { fn, calls };
}

/** Let promise reactions queued by the code under test run. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("translates: posts the text and returns the translation", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("good morning", "es");
  await settle();
  assert.equal(calls.length, 1);
  assert.match(calls[0].body, /q=good\+morning/);

  calls[0].resolve(gtxResponse("buenos días", "en"));
  assert.deepEqual(await pending, {
    text: "buenos días",
    detectedSource: "en",
  });
});

test("resolves null when the text is already in the target language", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "en");
  await settle();
  calls[0].resolve(gtxResponse("hello", "en"));
  assert.equal(await pending, null);
});

test("empty and oversized text never reach the network", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  assert.equal(await translator.translateText("   ", "es"), null);
  assert.equal(await translator.translateText("x".repeat(4001), "es"), null);
  assert.equal(calls.length, 0);
});

test("concurrent identical requests share one fetch", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const first = translator.translateText("hello", "fr");
  const second = translator.translateText("hello", "fr");
  await settle();
  assert.equal(calls.length, 1);

  calls[0].resolve(gtxResponse("bonjour", "en"));
  assert.deepEqual(await first, await second);
});

test("at most two requests fly at once; the rest queue in order", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const results = ["one", "two", "three", "four"].map((text) =>
    translator.translateText(text, "de"),
  );
  await settle();
  // Two in flight, two waiting.
  assert.equal(calls.length, 2);

  calls[0].resolve(gtxResponse("eins", "en"));
  await settle();
  // Finishing one admits exactly the next in line.
  assert.equal(calls.length, 3);
  assert.match(calls[2].body, /q=three/);

  calls[1].resolve(gtxResponse("zwei", "en"));
  calls[2].resolve(gtxResponse("drei", "en"));
  await settle();
  assert.equal(calls.length, 4);
  calls[3].resolve(gtxResponse("vier", "en"));

  assert.deepEqual(
    (await Promise.all(results)).map((r) => r?.text),
    ["eins", "zwei", "drei", "vier"],
  );
});

test("a 429 opens the circuit: instant nulls, no requests, then recovery", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const refused = translator.translateText("first", "es");
  await settle();
  calls[0].resolve(statusResponse(429));
  assert.equal(await refused, null);

  // During the cooldown nothing goes out — the fallback shows immediately.
  // Asserted on the call count BEFORE awaiting: if a request incorrectly went
  // out, awaiting it against a scripted fetch would hang instead of failing.
  const duringCooldown = translator.translateText("second", "es");
  await settle();
  assert.equal(calls.length, 1);
  assert.equal(await duringCooldown, null);

  // After the cooldown the next render tries again, and succeeds.
  t.mock.timers.tick(30_001);
  const recovered = translator.translateText("second", "es");
  await settle();
  assert.equal(calls.length, 2);
  calls[1].resolve(gtxResponse("segundo", "en"));
  assert.deepEqual(await recovered, { text: "segundo", detectedSource: "en" });
});

test("a rate limit is never retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  calls[0].resolve(statusResponse(429));
  assert.equal(await pending, null);
  assert.equal(calls.length, 1);
});

test("a hung request is aborted at the deadline and resolves null", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  assert.equal(calls.length, 1);

  t.mock.timers.tick(7_001);
  assert.equal(await pending, null);
  // The spent time budget is not doubled by a retry.
  assert.equal(calls.length, 1);
});

test("a 5xx is retried once, after a pause", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  calls[0].resolve(statusResponse(500));
  await settle();
  // Still waiting out the retry delay.
  assert.equal(calls.length, 1);

  t.mock.timers.tick(400);
  await settle();
  assert.equal(calls.length, 2);
  calls[1].resolve(gtxResponse("hola", "en"));
  assert.deepEqual(await pending, { text: "hola", detectedSource: "en" });
});

test("a network drop is retried once; a second drop resolves null", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const pending = translator.translateText("hello", "es");
  await settle();
  calls[0].reject(new TypeError("network dropped"));
  await settle();
  t.mock.timers.tick(400);
  await settle();
  assert.equal(calls.length, 2);

  calls[1].reject(new TypeError("network dropped again"));
  assert.equal(await pending, null);
  assert.equal(calls.length, 2);
});

test("a failure is not cached: the next call asks the network again", async () => {
  const { fn, calls } = scriptedFetch();
  const translator = createTranslator(fn);

  const failed = translator.translateText("hello", "es");
  await settle();
  // A 404 is retryable, so exhaust the retry synchronously-ish: real timers
  // here, and the 400 ms delay is real but short.
  calls[0].resolve(statusResponse(404));
  await new Promise((resolve) => setTimeout(resolve, 450));
  calls[1]?.resolve(statusResponse(404));
  assert.equal(await failed, null);

  const again = translator.translateText("hello", "es");
  await settle();
  assert.ok(calls.length > 2, "the failure must not be served from cache");
  calls[calls.length - 1].resolve(gtxResponse("hola", "en"));
  assert.deepEqual(await again, { text: "hola", detectedSource: "en" });
});
