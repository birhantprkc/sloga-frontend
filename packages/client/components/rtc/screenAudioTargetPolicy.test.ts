// Specs for the Linux screen-audio target policy (screenshare-audio design
// §9) — run with Node's built-in runner:
//   node --test components/rtc/screenAudioTargetPolicy.test.ts
//
// These functions ARE the renderer's half of §9's privacy rule, and every
// case below is one way that rule could fail OPEN. The rule: a share may
// capture system-wide audio only when it is genuinely a full-screen share;
// anything the shell cannot attribute — and anything that goes wrong on
// the way to finding out — must ask the user instead. A silent wrong
// answer broadcasts an application the user never chose, which the design
// classifies as a privacy failure rather than a UX nit.
//
// The shell half lives in a different repository, so every one of these is
// also a check that a cross-repo contract failing in an unexpected way
// still lands on `ask` rather than on system-wide capture.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  groupAppRoster,
  planFromAnswer,
  planWithoutTargeting,
} from "./screenAudioTargetPolicy.ts";

test("a monitor share the shell calls system stays system", () => {
  assert.deepEqual(planFromAnswer({ mode: "system" }, "monitor"), {
    mode: "system",
  });
});

test("an UNKNOWN surface does not get system, even when the shell says so", () => {
  // The shell cannot be taken at its word here, because on Wayland it
  // cannot tell either: the portal reports a window share as a screen
  // source, so "system" is a guess. Abstaining costs a question;
  // assenting broadcasts the whole machine on a one-window share.
  assert.deepEqual(planFromAnswer({ mode: "system" }, undefined), {
    mode: "ask",
    reason: "surface_unknown",
  });
});

test("a monitor share is system whatever the shell managed to work out", () => {
  // The renderer's own evidence outranks the shell's for this question,
  // and it is what keeps slice 1's headline alive on Wayland, where the
  // shell can never answer better than "ask".
  assert.deepEqual(
    planFromAnswer({ mode: "ask", reason: "wayland" }, "monitor"),
    {
      mode: "system",
    },
  );
  assert.deepEqual(planFromAnswer(undefined, "monitor", "resolve_timeout"), {
    mode: "system",
  });
});

test("a WINDOW share the shell calls system asks instead", () => {
  // The shell answers from ambient "last granted source" state, so it can
  // answer for the wrong share. Believing it here would turn a one-window
  // share into a whole-desktop audio broadcast.
  assert.deepEqual(planFromAnswer({ mode: "system" }, "window"), {
    mode: "ask",
    reason: "surface_mismatch",
  });
});

test("a browser-tab share the shell calls system also asks", () => {
  assert.equal(planFromAnswer({ mode: "system" }, "browser").mode, "ask");
});

test("a matched application is carried through as its identity", () => {
  assert.deepEqual(
    planFromAnswer({ mode: "targets", include: ["bin:firefox"] }, "window"),
    { mode: "targets", include: ["bin:firefox"] },
  );
});

test("targets with an EMPTY include asks rather than capturing", () => {
  // "Narrow to nothing" and "narrow to everything" are one bug apart in a
  // shell; only one of them is safe to guess at, and it is not this one.
  assert.equal(
    planFromAnswer({ mode: "targets", include: [] }, "window").mode,
    "ask",
  );
});

test("targets with no include at all asks", () => {
  assert.equal(planFromAnswer({ mode: "targets" }, "window").mode, "ask");
});

test("an unrecognized mode asks, never system", () => {
  // Checked on a share we cannot vouch for, which is where the property
  // bites: a confirmed monitor share is system-wide by definition and is
  // resolved before the mode is ever read.
  assert.equal(planFromAnswer({ mode: "everything" }, "window").mode, "ask");
  assert.equal(planFromAnswer({ mode: "everything" }, undefined).mode, "ask");
});

test("an answer with no mode at all asks, never system", () => {
  assert.equal(planFromAnswer({}, "window").mode, "ask");
  assert.equal(planFromAnswer({}, undefined).mode, "ask");
});

test("the shell's ask reason is carried through for the logs", () => {
  // Leg evidence: an opaque Wayland portal, a lying pid and a two-app
  // process tree are indistinguishable from the UI.
  assert.deepEqual(
    planFromAnswer({ mode: "ask", reason: "wayland" }, "window"),
    {
      mode: "ask",
      reason: "wayland",
    },
  );
});

test("no answer at all asks, with the caller's reason", () => {
  // A rejected or timed-out IPC call on a share we cannot vouch for.
  assert.deepEqual(planFromAnswer(undefined, "window", "resolve_timeout"), {
    mode: "ask",
    reason: "resolve_timeout",
  });
  assert.deepEqual(planFromAnswer(undefined, undefined, "unknown_window"), {
    mode: "ask",
    reason: "unknown_window",
  });
});

test("include entries that are not strings are dropped, and an empty result asks", () => {
  // The include contract changed shape (node ids to identities) with no
  // version marker, so a dist/shell skew must fail loudly here rather
  // than send the shell something it reads differently.
  assert.equal(
    planFromAnswer(
      { mode: "targets", include: [61, ""] as unknown as string[] },
      "window",
    ).mode,
    "ask",
  );
  assert.deepEqual(
    planFromAnswer(
      { mode: "targets", include: ["", "bin:mpv"] as string[] },
      "window",
    ),
    { mode: "targets", include: ["bin:mpv"] },
  );
});

test("a shell that cannot target skips audio on a window share", () => {
  // Slice-1 shell + slice-2 dist. The chooser cannot help either (it
  // needs setTargets), so there is no safe capture and no useful
  // question — but system-wide is NOT the answer.
  assert.deepEqual(planWithoutTargeting("window"), {
    mode: "skip",
    reason: "shell_cannot_target",
  });
});

test("a shell that cannot target still does system for a monitor", () => {
  // Slice 1's headline must not regress on an older shell.
  assert.deepEqual(planWithoutTargeting("monitor"), { mode: "system" });
});

test("a shell that cannot target skips an unknown surface", () => {
  // Cannot prove it is a monitor, so it is not treated as one.
  assert.equal(planWithoutTargeting(undefined).mode, "skip");
});

test("several streams of one application collapse to one row", () => {
  assert.deepEqual(
    groupAppRoster([
      { id: 41, identity: "bin:firefox", appName: "Firefox" },
      { id: 42, identity: "bin:firefox", appName: "Firefox" },
    ]),
    [{ key: "bin:firefox", name: "Firefox" }],
  );
});

test("two apps both calling themselves Chromium stay separate rows", () => {
  // The whole reason the roster groups on identity and not on the display
  // name: application.name reads "Chromium" for every Chromium-derived
  // app, so grouping on it would merge unrelated applications into one
  // row and therefore into one target set.
  const apps = groupAppRoster([
    { id: 41, identity: "bin:chromium", appName: "Chromium" },
    { id: 42, identity: "bin:brave", appName: "Chromium" },
  ]);
  assert.deepEqual(
    apps.map((app) => app.key),
    ["bin:chromium", "bin:brave"],
  );
});

test("streams with no identity are dropped, not given a fabricated key", () => {
  // The row key is also the target sent back on the wire. Inventing one
  // from the node id would put a recycled per-stream value back into a
  // field that is supposed to be stable — reopening the very boundary
  // this design closed — and it would do so for the streams that are
  // least attributable to begin with.
  assert.deepEqual(
    groupAppRoster([
      { id: 41, appName: "One" },
      { id: 42, identity: "bin:mpv", appName: "Two" },
    ]).map((app) => app.key),
    ["bin:mpv"],
  );
});

test("a row falls back through binary and node name for its label", () => {
  assert.deepEqual(
    groupAppRoster([
      { id: 41, identity: "bin:mpv", binary: "mpv" },
      { id: 42, identity: "pid:9", nodeName: "Music" },
      { id: 43, identity: "id:43" },
    ]).map((app) => app.name),
    ["mpv", "Music", "id:43"],
  );
});

test("a browser-tab share never reaches system", () => {
  // "browser" is a tab, not the screen — the monitor short-circuit must
  // not be a loose "anything truthy" check.
  assert.equal(planFromAnswer({ mode: "system" }, "browser").mode, "ask");
  assert.equal(planWithoutTargeting("browser").mode, "skip");
});

test("an empty or absent roster is an empty list", () => {
  assert.deepEqual(groupAppRoster([]), []);
  assert.deepEqual(groupAppRoster(undefined), []);
});
