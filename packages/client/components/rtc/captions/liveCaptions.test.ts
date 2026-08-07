// Behaviour pins for the caption controller — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/captions/liveCaptions.test.ts
//
// `--conditions=browser` for the same reason as every other spec here (Node
// otherwise resolves solid-js to its server build, and `entries` is a
// ReactiveMap).
//
// These exist because the ORIGINAL caption transport failed silently for
// months: it published to a LiveKit data channel the voice token forbade, so
// `publishData()` resolved without error and the SFU dropped every packet.
// Nothing on the sender could tell. The relay path is now injected, so a spec
// can assert what actually went out — the observation that was missing.
import assert from "node:assert/strict";
import { test } from "node:test";

import { LiveCaptions } from "./liveCaptions.ts";
import type { CaptionEngine, CaptionResult } from "./speechCaptionEngine.ts";

/** A recognizer the test drives by hand. */
class FakeEngine implements CaptionEngine {
  readonly supported = true;
  emit: ((result: CaptionResult) => void) | undefined;
  stopped = 0;

  start(_lang: string, onResult: (result: CaptionResult) => void) {
    this.emit = onResult;
  }

  stop() {
    this.stopped += 1;
    this.emit = undefined;
  }
}

/** A controller wired to a fake engine, recording everything it relays. */
function makeCaptions(localIdentity = "me") {
  const engine = new FakeEngine();
  const sent: { text: string; lang: string }[] = [];
  const captions = new LiveCaptions(() => engine);
  captions.attach(localIdentity, (text, lang) => sent.push({ text, lang }));
  captions.setLocalPublishing(true, "en-US");
  return { captions, engine, sent };
}

test("a finalized utterance is relayed", () => {
  const { engine, sent } = makeCaptions();
  engine.emit!({ text: "hello there", isFinal: true });
  assert.deepEqual(sent, [{ text: "hello there", lang: "en-US" }]);
});

test("interim results are NEVER relayed, only mirrored locally", () => {
  const { captions, engine, sent } = makeCaptions();

  engine.emit!({ text: "hel", isFinal: false });
  engine.emit!({ text: "hello th", isFinal: false });

  // Nothing crossed the wire — this is what bounds the request rate to
  // utterance boundaries instead of one request per recognizer update.
  assert.deepEqual(sent, []);
  // …but the speaker still sees their own interim text.
  assert.equal(captions.entries.get("me")?.text, "hello th");
  assert.equal(captions.entries.get("me")?.isFinal, false);
});

test("a repeated final is not relayed twice", () => {
  const { engine, sent } = makeCaptions();
  engine.emit!({ text: "same line", isFinal: true });
  engine.emit!({ text: "same line", isFinal: true });
  assert.equal(sent.length, 1);
});

test("a blank final is not relayed", () => {
  const { engine, sent } = makeCaptions();
  engine.emit!({ text: "   ", isFinal: true });
  assert.deepEqual(sent, []);
});

test("outgoing text is clamped to the display cap", () => {
  const { engine, sent } = makeCaptions();
  engine.emit!({ text: "x".repeat(500), isFinal: true });
  assert.equal(sent[0].text.length, 240);
});

test("a relayed caption lands on the speaker's identity", () => {
  const { captions } = makeCaptions();
  captions.handleRemoteCaption({
    identity: "them",
    text: "good morning",
    lang: "fr-FR",
  });
  const entry = captions.entries.get("them");
  assert.equal(entry?.text, "good morning");
  assert.equal(entry?.sourceLang, "fr-FR");
  // The server relays finals only, so a received line is always final —
  // which is what gives it the 6s linger rather than the 8s interim timeout.
  assert.equal(entry?.isFinal, true);
});

test("a relayed caption cannot overwrite my own tile", () => {
  const { captions, engine } = makeCaptions();
  engine.emit!({ text: "what I said", isFinal: true });

  // The server sets `identity` itself, but a compromised/buggy relay claiming
  // to be me must not be able to put words in my mouth on my own screen.
  captions.handleRemoteCaption({
    identity: "me",
    text: "words I never said",
    lang: "en-US",
  });

  assert.equal(captions.entries.get("me")?.text, "what I said");
});

test("detach stops the recognizer and severs the relay", () => {
  const { captions, engine, sent } = makeCaptions();
  // Hold the callback: a real recognizer keeps its own reference and can fire
  // after stop(), so asserting through the fake's nulled `emit` would pass
  // without ever reaching the controller.
  const late = engine.emit!;
  captions.detach();

  assert.equal(engine.stopped, 1);
  assert.equal(captions.entries.size, 0);

  late({ text: "too late", isFinal: true });
  assert.deepEqual(sent, []);
});

test("a late final after mute is neither relayed nor shown", () => {
  const { captions, engine, sent } = makeCaptions();
  const late = engine.emit!;

  // What `CaptionPublisher` does when the mic is muted or the call turns out
  // to be E2EE. Web Speech flushes its in-flight utterance after stop(), so
  // this is the ordinary case, not a contrived one.
  captions.setLocalPublishing(false, "en-US");
  late({ text: "said while muting", isFinal: true });

  assert.deepEqual(sent, []);
  assert.equal(captions.entries.get("me"), undefined);
});
