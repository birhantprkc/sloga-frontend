// Unit spec for the remote-control capture surface's coordinate mapping —
// run with Node's built-in runner:
//   node --test components/rtc/remoteControlMapping.test.ts   (Node >=23.6 strips types)
//
// Focus: the ONE piece of slice 4 whose being wrong makes remote control feel
// BROKEN rather than laggy. The tile letterboxes with `object-fit: contain`,
// so the element rect and the picture are different boxes; a naive
// `(clientX - rect.left) / rect.width` is offset and mis-scaled, and every
// single click lands the same distance off — which reads as "remote control
// doesn't work" rather than "there is a bug in the mapping".
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyKey,
  isEditableTarget,
  isPanicCombo,
  normalizeToContentBox,
  releaseCause,
  wheelNotches,
} from "./remoteControlMapping.ts";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
});
const at = (clientX: number, clientY: number) => ({ clientX, clientY });
const HD = { width: 1920, height: 1080 };

const close = (actual: number | undefined, expected: number, what: string) => {
  assert.ok(actual !== undefined, `${what}: expected a value, got undefined`);
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: ${actual} !== ${expected}`,
  );
};

test("maps an exactly-fitting element with no letterbox", () => {
  const r = rect(0, 0, 1600, 900);
  assert.deepEqual(normalizeToContentBox(r, HD, at(0, 0)), { x: 0, y: 0 });
  assert.deepEqual(normalizeToContentBox(r, HD, at(1600, 900)), { x: 1, y: 1 });
  assert.deepEqual(normalizeToContentBox(r, HD, at(800, 450)), {
    x: 0.5,
    y: 0.5,
  });
});

test("accounts for horizontal bars when the tile is TALLER than the stream", () => {
  // 16:9 stream in a 1000x1000 tile ⇒ the picture is 1000x562.5, centred,
  // leaving 218.75px bars top and bottom. An element-box mapping happens to
  // get the centre right and is ~220 physical pixels out at the edges.
  const r = rect(0, 0, 1000, 1000);
  const bar = (1000 - 562.5) / 2;

  const topLeft = normalizeToContentBox(r, HD, at(0, bar));
  close(topLeft?.x, 0, "top-left x");
  close(topLeft?.y, 0, "top-left y");

  const middle = normalizeToContentBox(r, HD, at(500, 500));
  close(middle?.x, 0.5, "middle x");
  close(middle?.y, 0.5, "middle y");

  const bottomRight = normalizeToContentBox(r, HD, at(1000, 1000 - bar));
  close(bottomRight?.x, 1, "bottom-right x");
  close(bottomRight?.y, 1, "bottom-right y");
});

test("accounts for vertical bars when the tile is WIDER than the stream", () => {
  // A 4:3 desktop shared into a 16:9 tile — the common older-monitor case.
  const r = rect(0, 0, 1600, 900);
  const dims = { width: 1024, height: 768 };
  const bar = (1600 - (1024 / 768) * 900) / 2;

  close(normalizeToContentBox(r, dims, at(bar, 0))?.x, 0, "left edge");
  close(
    normalizeToContentBox(r, dims, at(1600 - bar, 900))?.x,
    1,
    "right edge",
  );
});

test("REJECTS points in the letterbox bars rather than extrapolating", () => {
  // Extrapolating would send the sharer's pointer somewhere nobody pointed —
  // off the top of their screen, or onto a monitor they are not sharing.
  const r = rect(0, 0, 1000, 1000);
  assert.equal(normalizeToContentBox(r, HD, at(500, 10)), undefined);
  assert.equal(normalizeToContentBox(r, HD, at(500, 990)), undefined);
});

test("honours the element's viewport offset", () => {
  // The rect is in viewport coordinates, so a docked card at an offset must
  // not shift every click by that offset.
  const r = rect(320, 64, 1600, 900);
  assert.deepEqual(normalizeToContentBox(r, HD, at(320, 64)), { x: 0, y: 0 });
  assert.deepEqual(normalizeToContentBox(r, HD, at(1120, 514)), {
    x: 0.5,
    y: 0.5,
  });
});

test("returns undefined rather than NaN before the first resize event", () => {
  // `videoDims` is per-tile state and resets to {0,0} on the remount a focus
  // toggle causes, until the next `resize` repopulates it. Dividing by zero
  // there yields NaN, which native clamps into the monitor rect — i.e. the
  // sharer's pointer would jump to a corner on every focus toggle.
  assert.equal(
    normalizeToContentBox(
      rect(0, 0, 1600, 900),
      { width: 0, height: 0 },
      at(800, 450),
    ),
    undefined,
  );
  assert.equal(
    normalizeToContentBox(rect(0, 0, 0, 0), HD, at(0, 0)),
    undefined,
  );
});

// -- classifyKey: §3's "two paths" decision ---------------------------------

const key = (
  k: string,
  mods: Partial<{
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    altGraph: boolean;
  }> = {},
) => ({
  key: k,
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
});

test("plain and shifted printables travel as text", () => {
  // A scan code resolves through the SHARER'S layout: QWERTY KeyZ types `w`
  // on an AZERTY sharer. Anything that produces a character must go by text.
  assert.equal(classifyKey(key("a")), "text");
  assert.equal(classifyKey(key("A")), "text"); // shift is not an accelerator
  assert.equal(classifyKey(key(" ")), "text");
  assert.equal(classifyKey(key("é")), "text");
  assert.equal(classifyKey(key("€")), "text");
});

test("accelerator chords travel as scan codes, never as their character", () => {
  // The sharer must receive Ctrl+C, not a `c`.
  assert.equal(classifyKey(key("c", { ctrlKey: true })), "scan");
  assert.equal(classifyKey(key("e", { altKey: true })), "scan"); // menu accelerator
  assert.equal(classifyKey(key("l", { metaKey: true })), "scan");
});

test("AltGr is text, not an accelerator", () => {
  // Windows browsers report AltGr as Ctrl+Alt, and it exists precisely to
  // produce characters (AZERTY AltGr+E is €) — both signal shapes count.
  assert.equal(classifyKey(key("€", { ctrlKey: true, altKey: true })), "text");
  assert.equal(classifyKey(key("€", { altGraph: true })), "text");
});

// -- wheelNotches: DOM deltas → WHEEL_DELTA multiples -----------------------

test("one Chromium wheel notch is exactly one WHEEL_DELTA", () => {
  // Raw forwarding sent 100 where Windows wanted 120 — every scroll ran ~17%
  // short.
  assert.deepEqual(wheelNotches(100, 0, 0), { whole: 120, carry: 0 });
  assert.deepEqual(wheelNotches(-100, 0, 0), { whole: -120, carry: 0 });
});

test("trackpad sub-notch deltas accumulate instead of truncating to zero", () => {
  // Ten 10px increments are one notch. Truncating each on its own sends
  // nothing at all in applications that do not accumulate.
  let carry = 0;
  let total = 0;
  for (let i = 0; i < 10; i++) {
    const step = wheelNotches(10, 0, carry);
    carry = step.carry;
    total += step.whole;
  }
  assert.equal(total, 120, "ten 10px steps should add up to one notch");
});

test("carry never changes sign on a direction reversal", () => {
  // Truncation toward zero, not rounding: scrolling back up must not cancel
  // a notch that already went out.
  const down = wheelNotches(90, 0, 0);
  assert.equal(down.whole, 0);
  const up = wheelNotches(-90, 0, down.carry);
  assert.equal(up.whole, 0);
  assert.equal(up.carry, 0);
});

test("line and page deltaModes convert, not just pixels", () => {
  // Firefox reports lines; three lines is the conventional notch.
  assert.deepEqual(wheelNotches(3, 1, 0), { whole: 120, carry: 0 });
  assert.equal(wheelNotches(1, 2, 0).whole, 120 * 16);
});

test("named keys travel as scan codes", () => {
  for (const named of [
    "Enter",
    "Backspace",
    "Tab",
    "Escape",
    "ArrowLeft",
    "Home",
    "F5",
    "Shift",
    "Control",
    "Alt",
    "Delete",
    "Unidentified",
  ]) {
    assert.equal(classifyKey(key(named)), "scan", named);
  }
});

// -- isPanicCombo ----------------------------------------------------------

const combo = (over: Partial<Parameters<typeof isPanicCombo>[0]> = {}) => ({
  code: "KeyQ",
  key: "q",
  ctrlKey: true,
  shiftKey: true,
  altKey: true,
  ...over,
});

test("the panic combo matches on code OR key, Q since the 08-02 rebind", () => {
  assert.ok(isPanicCombo(combo()));
  // A layout that remaps the physical Q position: `key` disagrees, `code`
  // still matches.
  assert.ok(isPanicCombo(combo({ key: "a" })));
  // A layout where Q lives on a different physical key: `code` disagrees,
  // `key` matches — including uppercase from held Shift.
  assert.ok(isPanicCombo(combo({ code: "KeyA", key: "Q" })));
});

test("the old End combo and partial chords are NOT the panic combo", () => {
  // The pre-rebind combo must no longer suppress forwarding — the capture
  // surface matching End while the overlays matched Q is the drift this
  // predicate exists to end.
  assert.ok(!isPanicCombo(combo({ code: "End", key: "End" })));
  assert.ok(!isPanicCombo(combo({ ctrlKey: false })));
  assert.ok(!isPanicCombo(combo({ shiftKey: false })));
  assert.ok(!isPanicCombo(combo({ altKey: false })));
  // Bare q — the B-leg the matrix ran live: it must forward as ordinary text.
  assert.ok(
    !isPanicCombo({
      code: "KeyQ",
      key: "q",
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
    }),
  );
});

// -- isEditableTarget ------------------------------------------------------

test("text-taking fields are local editables", () => {
  assert.ok(isEditableTarget({ tagName: "TEXTAREA" }));
  assert.ok(isEditableTarget({ tagName: "INPUT" })); // type defaults to text
  for (const type of ["text", "search", "password", "email", "number"]) {
    assert.ok(isEditableTarget({ tagName: "INPUT", type }), type);
  }
  assert.ok(isEditableTarget({ tagName: "DIV", isContentEditable: true }));
});

test("non-typing targets keep forwarding", () => {
  assert.ok(!isEditableTarget(null));
  assert.ok(!isEditableTarget(undefined));
  assert.ok(!isEditableTarget({ tagName: "BODY" }));
  assert.ok(!isEditableTarget({ tagName: "BUTTON" }));
  assert.ok(!isEditableTarget({ tagName: "DIV", isContentEditable: false }));
  // Click-only input types take no text worth keeping local.
  for (const type of ["checkbox", "radio", "button", "submit", "range"]) {
    assert.ok(!isEditableTarget({ tagName: "INPUT", type }), type);
  }
  // A field that cannot accept text is a control, not an editable.
  assert.ok(!isEditableTarget({ tagName: "INPUT", disabled: true }));
  assert.ok(!isEditableTarget({ tagName: "TEXTAREA", readOnly: true }));
});

// -- releaseCause ----------------------------------------------------------

test("release causes map onto the server's audit vocabulary", () => {
  assert.equal(releaseCause("panic_key"), "panic");
  assert.equal(releaseCause("panic"), "panic");
  assert.equal(releaseCause("reliable_stream_gap"), "connection_lost");
  assert.equal(releaseCause("disconnected"), "connection_lost");
  // Native watchdog verdicts ride through verbatim.
  for (const verbatim of [
    "anti_cheat",
    "indicator_hidden",
    "max_lifetime",
    "display_topology_changed",
    "calibration_rejected",
  ]) {
    assert.equal(releaseCause(verbatim), verbatim);
  }
  // Slice 1: a rotation handoff must NOT fall through to the role default,
  // which for a sharer is `revoked_by_sharer` — i.e. "the machine's owner
  // yanked control back". A passed controller and a revoked one are
  // materially different events and the audit has to tell them apart.
  assert.equal(releaseCause("turn_ended"), "turn_ended");
});

test("unmapped reasons defer to the server's role default", () => {
  // The plain revoke button, server-initiated teardowns and anything unknown
  // send NO cause — the server labels those by the caller's role, so a
  // client cannot smuggle prose into the audit trail.
  for (const reason of [
    "sharer_stopped",
    "server:expired",
    "native_revoked",
    "session_ended",
    "arm_failed",
    "calibration_no_session",
    "anything_else",
  ]) {
    assert.equal(releaseCause(reason), undefined, reason);
  }
});
