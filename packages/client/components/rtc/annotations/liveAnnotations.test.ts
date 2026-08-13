// Behaviour pins for the annotation store — run with Node's built-in runner:
//   node --conditions=browser --test components/rtc/annotations/liveAnnotations.test.ts
//
// `--conditions=browser` for the same reason as every other spec here (Node
// otherwise resolves solid-js to its server build, and `batches`/`consent`
// are ReactiveMaps).
//
// The pins that matter are the §2.4 ones: consent is mirrored (never
// asserted) and a revoke DROPS rendered ink immediately — the one-action
// revoke is the phishing backstop, the TTL fade is not — plus the wire
// contracts the renderer trusts (palette length, the composited alpha cap).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANNOTATION_CLEAR_MS,
  ANNOTATION_LAYER_ALPHA,
  ANNOTATION_PALETTE,
  ANNOTATION_WIDTHS,
  LiveAnnotations,
} from "./liveAnnotations.ts";

const STROKE = { points: [1000, 1000, 5000, 5000], color: 0, width: 1 };

/** A store with a hand-cranked clock. */
function makeStore() {
  let now = 1_000_000;
  const store = new LiveAnnotations(() => now);
  store.attach("me:device", "me");
  return { store, tick: (ms: number) => (now += ms) };
}

function batchFrom(
  annotatorId: string,
  targetId = "sharer",
  targetIdentity = "sharer:device",
) {
  return {
    annotatorIdentity: `${annotatorId}:device`,
    annotatorId,
    targetIdentity,
    targetId,
    strokes: [STROKE],
    seq: 1,
  };
}

test("a stroke from an allowlisted annotator lands on the target surface", () => {
  const { store } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper"] });
  store.handleRemoteAnnotation(batchFrom("helper"));
  assert.equal(store.batches.get("sharer:device")?.length, 1);
});

test("a stroke from an annotator NOT on the allowlist is dropped", () => {
  const { store } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper"] });
  store.handleRemoteAnnotation(batchFrom("intruder"));
  assert.equal(store.batches.get("sharer:device"), undefined);
});

test("with no consent state at all, every stroke is dropped (off by default)", () => {
  const { store } = makeStore();
  store.handleRemoteAnnotation(batchFrom("helper"));
  assert.equal(store.batches.size, 0);
});

test("revoke (empty allowlist) drops rendered ink IMMEDIATELY, not on fade", () => {
  const { store } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper"] });
  store.handleRemoteAnnotation(batchFrom("helper"));
  assert.equal(store.batches.get("sharer:device")?.length, 1);

  store.handleConsent({ sharerId: "sharer", allowed: [] });
  assert.equal(store.batches.get("sharer:device"), undefined);
  assert.equal(store.mayDraw("sharer", "helper"), false);
});

test("a shrunk allowlist drops only the de-listed annotator's ink", () => {
  const { store } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper", "other"] });
  store.handleRemoteAnnotation(batchFrom("helper"));
  store.handleRemoteAnnotation(batchFrom("other"));
  assert.equal(store.batches.get("sharer:device")?.length, 2);

  store.handleConsent({ sharerId: "sharer", allowed: ["other"] });
  const kept = store.batches.get("sharer:device");
  assert.equal(kept?.length, 1);
  assert.equal(kept?.[0].annotatorId, "other");
});

test("a consent change for one sharer leaves another sharer's ink alone", () => {
  const { store } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper"] });
  store.handleConsent({ sharerId: "sharer2", allowed: ["helper"] });
  store.handleRemoteAnnotation(batchFrom("helper"));
  store.handleRemoteAnnotation(
    batchFrom("helper", "sharer2", "sharer2:device"),
  );

  store.handleConsent({ sharerId: "sharer", allowed: [] });
  assert.equal(store.batches.get("sharer:device"), undefined);
  assert.equal(store.batches.get("sharer2:device")?.length, 1);
});

test("expired batches are pruned when new ink arrives", () => {
  const { store, tick } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper"] });
  store.handleRemoteAnnotation(batchFrom("helper"));
  tick(ANNOTATION_CLEAR_MS + 1);
  store.handleRemoteAnnotation({ ...batchFrom("helper"), seq: 2 });
  const batches = store.batches.get("sharer:device");
  assert.equal(batches?.length, 1);
  assert.equal(batches?.[0].seq, 2);
});

test("the local self-mirror lands without a consent round-trip", () => {
  // My own strokes render immediately (the relay skips the sender); the
  // SERVER is what refuses an unconsented send — mirroring it here would
  // just hide the 403 from the capture surface's stop-on-refusal path.
  const { store } = makeStore();
  store.addLocalStrokes("sharer:device", "sharer", [STROKE], 1);
  assert.equal(store.batches.get("sharer:device")?.length, 1);
});

test("detach clears every surface, consent entry and identity binding", () => {
  const { store } = makeStore();
  store.handleConsent({ sharerId: "sharer", allowed: ["helper"] });
  store.handleRemoteAnnotation(batchFrom("helper"));
  store.detach();
  assert.equal(store.batches.size, 0);
  assert.equal(store.consent.size, 0);
  assert.equal(store.localIdentity, "");
});

test("seedConsent backfills a late joiner and skips empty allowlists", () => {
  const { store } = makeStore();
  store.seedConsent([
    { sharer_id: "sharer", allowed: ["helper"] },
    { sharer_id: "quiet", allowed: [] },
  ]);
  assert.equal(store.mayDraw("sharer", "helper"), true);
  assert.equal(store.consent.has("quiet"), false);
});

// ---- wire/render contracts ------------------------------------------------

test("the palette length matches the server's refusal bound", () => {
  // Server: ANNOTATION_PALETTE_SIZE = 5, color indexes must be < 5. If this
  // table drifts, either legal indexes render as undefined or the picker
  // offers colors the server refuses.
  assert.equal(ANNOTATION_PALETTE.length, 5);
  assert.equal(ANNOTATION_WIDTHS.length, 3);
});

test("no palette entry could pass for native chrome (§2.4 honest-overlay)", () => {
  // High-chroma check: a gray/white/black ink could dress up as OS UI. Every
  // entry must have meaningful channel spread (chroma), which grays lack.
  for (const hex of ANNOTATION_PALETTE) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const spread = Math.max(r, g, b) - Math.min(r, g, b);
    assert.ok(spread > 60, `${hex} is too gray to be honest overlay ink`);
  }
});

test("the composited layer alpha cap stays translucent", () => {
  // §2.4: stacked strokes must never composite to (near-)opaque. The
  // renderer enforces this structurally by compositing the whole layer once
  // at this alpha — which is only a guarantee while the cap itself stays
  // meaningfully below 1.
  assert.ok(ANNOTATION_LAYER_ALPHA <= 0.5);
});
