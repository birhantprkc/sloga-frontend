// Specs for the in-call transcript — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/transcription/transcriptStore.test.ts
//
// `--conditions=browser` is load-bearing here rather than incidental: without
// it Node resolves solid-js to its server build, where reactivity is inert.
import assert from "node:assert/strict";
import { test } from "node:test";

import { TranscriptStore } from "./transcriptStore.ts";

function started(): TranscriptStore {
  const store = new TranscriptStore();
  store.begin(Date.now());
  return store;
}

const said = (identity: string, startMs: number, text: string) => ({
  identity,
  startMs,
  endMs: startMs + 1000,
  text,
});

test("keeps utterances in spoken order when the queue finishes out of order", () => {
  // One model serves every speaker, so a short reply can finish before the
  // long sentence it answered. Arrival order would print the reply first.
  const store = started();
  store.add(said("u2", 9000, "sounds good"));
  store.add(said("u1", 2000, "shall we ship it on friday"));

  assert.deepEqual(
    store.segments().map((s) => s.text),
    ["shall we ship it on friday", "sounds good"],
  );
});

test("places a late arrival in the middle, not just at the ends", () => {
  const store = started();
  store.add(said("u1", 1000, "first"));
  store.add(said("u1", 9000, "third"));
  store.add(said("u2", 5000, "second"));

  assert.deepEqual(
    store.segments().map((s) => s.text),
    ["first", "second", "third"],
  );
});

test("simultaneous starts keep the order they arrived in", () => {
  // Two people talking over each other get identical timestamps; the only
  // stable answer is arrival order, and it must not shuffle on later inserts.
  const store = started();
  store.add(said("u1", 4000, "a"));
  store.add(said("u2", 4000, "b"));
  store.add(said("u3", 4000, "c"));
  store.add(said("u1", 1000, "earlier"));

  assert.deepEqual(
    store.segments().map((s) => s.text),
    ["earlier", "a", "b", "c"],
  );
});

test("a run of utterances in order is not disturbed", () => {
  const store = started();
  for (let i = 0; i < 20; i++) store.add(said("u1", i * 1000, `line ${i}`));

  const starts = store.segments().map((s) => s.startMs);
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
  );
  assert.equal(store.segments().length, 20);
});

test("ids are unique and stable", () => {
  const store = started();
  store.add(said("u1", 3000, "late"));
  store.add(said("u1", 1000, "early"));

  const ids = store.segments().map((s) => s.id);
  assert.equal(new Set(ids).size, 2);
  // The early line was inserted second, so a positional id would have to
  // change when it moved — it must not.
  assert.equal(store.segments()[0].text, "early");
  assert.equal(store.segments()[0].id, "t1");
});

test("empty results are not recorded", () => {
  // The model returns nothing for audio it could not resolve; that is a
  // non-result, not a silent moment worth a row.
  const store = started();
  assert.equal(store.add(said("u1", 1000, "   ")), undefined);
  assert.equal(store.add(said("u1", 2000, "")), undefined);
  assert.equal(store.isEmpty, true);
});

test("surrounding whitespace is trimmed", () => {
  const store = started();
  const segment = store.add(said("u1", 1000, "  hello there\n"));
  assert.equal(segment?.text, "hello there");
});

test("speaking flags track who is mid-utterance", () => {
  const store = started();
  assert.equal(store.isSpeaking("u1"), false);

  store.setSpeaking("u1", true);
  assert.equal(store.isSpeaking("u1"), true);
  assert.equal(store.isSpeaking("u2"), false);

  store.setSpeaking("u1", false);
  assert.equal(store.isSpeaking("u1"), false);

  store.setSpeaking("u1", true);
  store.setSpeaking("u2", true);
  store.clearSpeaking();
  assert.equal(store.isSpeaking("u1"), false);
  assert.equal(store.isSpeaking("u2"), false);
});

test("the transcript survives everything except an explicit discard", () => {
  // A call can end without warning, and the transcript exists only here. The
  // ONLY methods that empty it are begin() and discard(); teardown must have
  // no way to reach either.
  const store = started();
  store.add(said("u1", 1000, "worth keeping"));

  // Whatever else happens to the call, the words stay.
  store.clearSpeaking();
  assert.equal(store.segments().length, 1);

  store.discard();
  assert.equal(store.isEmpty, true);
  assert.equal(store.startedAt, undefined);
});

test("starting a new transcript replaces the previous one", () => {
  const store = started();
  store.add(said("u1", 1000, "old call"));

  store.begin(Date.now() + 60_000);
  assert.equal(store.isEmpty, true);
  // Ids restart, so the next panel render cannot collide with stale keys.
  store.add(said("u1", 1000, "new call"));
  assert.equal(store.segments()[0].id, "t0");
});

test("records when the transcript started, for the exported header", () => {
  const store = new TranscriptStore();
  assert.equal(store.startedAt, undefined);

  const at = Date.UTC(2026, 6, 30, 18, 5);
  store.begin(at);
  assert.equal(store.startedAt, at);
});
