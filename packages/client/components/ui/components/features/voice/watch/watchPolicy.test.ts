// Unit spec for the watch-together visibility policy — Node's built-in runner:
//   node --test components/ui/components/features/voice/watch/watchPolicy.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOST_UNREACHABLE_AFTER_MS,
  hostUnreachable,
  watchButtonVisible,
  watchCanStart,
  watchOverlayVisible,
} from "./watchPolicy.ts";

const LIVE = { enabled: true, connected: true, hasSession: true, immersive: false };

test("overlay: every veto input vetoes on its own", () => {
  assert.equal(watchOverlayVisible(LIVE), true);
  assert.equal(watchOverlayVisible({ ...LIVE, enabled: false }), false);
  assert.equal(watchOverlayVisible({ ...LIVE, connected: false }), false);
  assert.equal(watchOverlayVisible({ ...LIVE, hasSession: false }), false);
  assert.equal(watchOverlayVisible({ ...LIVE, immersive: true }), false);
});

test("button: flag darkens everything; permission OR an existing session shows it", () => {
  const base = { enabled: true, connected: true, hasPermission: true, hasSession: false };
  assert.equal(watchButtonVisible(base), true);
  assert.equal(watchButtonVisible({ ...base, enabled: false }), false);
  assert.equal(watchButtonVisible({ ...base, connected: false }), false);
  // No permission but a session is running → still shown (opens the overlay).
  assert.equal(watchButtonVisible({ ...base, hasPermission: false, hasSession: true }), true);
  assert.equal(watchButtonVisible({ ...base, hasPermission: false }), false);
});

test("canStart: needs permission and no existing session", () => {
  const base = { enabled: true, connected: true, hasPermission: true, hasSession: false };
  assert.equal(watchCanStart(base), true);
  assert.equal(watchCanStart({ ...base, hasSession: true }), false);
  assert.equal(watchCanStart({ ...base, hasPermission: false }), false);
  assert.equal(watchCanStart({ ...base, enabled: false }), false);
});

test("hostUnreachable: only while playing, only past the window", () => {
  assert.equal(hostUnreachable({ playing: true, lastUpdateLocalMs: 0, nowLocalMs: HOST_UNREACHABLE_AFTER_MS }), false);
  assert.equal(hostUnreachable({ playing: true, lastUpdateLocalMs: 0, nowLocalMs: HOST_UNREACHABLE_AFTER_MS + 1 }), true);
  assert.equal(hostUnreachable({ playing: false, lastUpdateLocalMs: 0, nowLocalMs: 10 * HOST_UNREACHABLE_AFTER_MS }), false);
  assert.equal(hostUnreachable({ playing: true, lastUpdateLocalMs: null, nowLocalMs: 1e9 }), false);
});
