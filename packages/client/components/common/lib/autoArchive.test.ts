// Specs for the thread / forum-post auto-archive duration helpers — run with
// Node's built-in runner:
//   node --test components/common/lib/autoArchive.test.ts
//
// All specs are pure. The backend accepts a RANGE, not an allowlist, so these
// specs pin the range ends and the never sentinel rather than a fixed set of
// values; 0 means "never auto-archive" and must survive every resolver (a
// falsy-coalescing bug would silently turn "never" into a default).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_ARCHIVE_NEVER,
  AUTO_ARCHIVE_PRESETS,
  AUTO_ARCHIVE_UNIT_MINUTES,
  FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES,
  MAX_AUTO_ARCHIVE_MINUTES,
  THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES,
  isAutoArchiveMinutes,
  isAutoArchivePreset,
  joinAutoArchive,
  maxAutoArchiveIn,
  resolveCurrent,
  resolvePostDefault,
  splitAutoArchive,
} from "./autoArchive.ts";

// Mirrors `Channel::MAX_AUTO_ARCHIVE_MINUTES`: two years of 365 days.
const BACKEND_MAX = 2 * 365 * 24 * 60;

// The durations the operator asked for, in days.
const REQUESTED_DAY_PRESETS = [1, 3, 5, 7, 10, 15, 20, 25, 30];

test("max mirrors the backend ceiling of two years", () => {
  assert.equal(MAX_AUTO_ARCHIVE_MINUTES, BACKEND_MAX);
  assert.equal(MAX_AUTO_ARCHIVE_MINUTES, 1_051_200);
});

test("presets are ascending with never last", () => {
  const durations = AUTO_ARCHIVE_PRESETS.slice(0, -1);
  assert.deepEqual(
    [...durations].sort((a, b) => a - b),
    [...durations],
  );
  assert.equal(
    AUTO_ARCHIVE_PRESETS[AUTO_ARCHIVE_PRESETS.length - 1],
    AUTO_ARCHIVE_NEVER,
  );
  assert.equal(AUTO_ARCHIVE_NEVER, 0);
  assert.equal(new Set(AUTO_ARCHIVE_PRESETS).size, AUTO_ARCHIVE_PRESETS.length);
});

test("presets include every requested day duration, plus 90 days", () => {
  for (const days of REQUESTED_DAY_PRESETS) {
    const minutes = days * 1440;
    assert.ok(
      isAutoArchivePreset(minutes),
      `expected a ${days}-day preset (${minutes} minutes)`,
    );
  }
  assert.ok(isAutoArchivePreset(129600), "expected the 90-day preset");
});

test("every preset is itself an acceptable duration", () => {
  for (const value of AUTO_ARCHIVE_PRESETS) {
    assert.equal(isAutoArchiveMinutes(value), true, `expected ${value} valid`);
  }
});

test("defaults are one week for forum posts and one day for threads", () => {
  assert.equal(FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES, 10080);
  assert.equal(THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES, 1440);
  assert.ok(isAutoArchiveMinutes(FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES));
  assert.ok(isAutoArchiveMinutes(THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES));
});

test("isAutoArchiveMinutes accepts the whole range, both ends and never", () => {
  assert.equal(isAutoArchiveMinutes(0), true);
  assert.equal(isAutoArchiveMinutes(1), true);
  assert.equal(isAutoArchiveMinutes(MAX_AUTO_ARCHIVE_MINUTES), true);
  // Off-preset values are legal now; this is the whole point of the change.
  assert.equal(isAutoArchiveMinutes(30), true);
  assert.equal(isAutoArchiveMinutes(5), true);
  assert.equal(isAutoArchiveMinutes(99_999), true);
});

test("isAutoArchiveMinutes rejects out-of-range, fractional and non-number values", () => {
  assert.equal(isAutoArchiveMinutes(MAX_AUTO_ARCHIVE_MINUTES + 1), false);
  assert.equal(isAutoArchiveMinutes(-60), false);
  assert.equal(isAutoArchiveMinutes(60.5), false);
  assert.equal(isAutoArchiveMinutes("60"), false);
  assert.equal(isAutoArchiveMinutes("0"), false);
  assert.equal(isAutoArchiveMinutes(Number.NaN), false);
  assert.equal(isAutoArchiveMinutes(Number.POSITIVE_INFINITY), false);
  assert.equal(isAutoArchiveMinutes(undefined), false);
  assert.equal(isAutoArchiveMinutes(null), false);
});

test("isAutoArchivePreset separates shortcuts from merely-legal values", () => {
  assert.equal(isAutoArchivePreset(1440), true);
  assert.equal(isAutoArchivePreset(0), true);
  assert.equal(isAutoArchivePreset(4321), false);
  assert.equal(isAutoArchivePreset(2), false);
});

test("resolvePostDefault keeps valid values (including never) and falls back to one week", () => {
  assert.equal(resolvePostDefault(undefined), 10080);
  assert.equal(resolvePostDefault(0), 0);
  assert.equal(resolvePostDefault(129600), 129600);
  assert.equal(resolvePostDefault(60), 60);
  // A custom duration must survive rather than snap back to the default.
  assert.equal(resolvePostDefault(30), 30);
  assert.equal(resolvePostDefault(4321), 4321);
  assert.equal(resolvePostDefault(Number.NaN), 10080);
  assert.equal(resolvePostDefault(MAX_AUTO_ARCHIVE_MINUTES + 1), 10080);
});

test("resolveCurrent keeps valid values (including never) and falls back to one day", () => {
  assert.equal(resolveCurrent(undefined), 1440);
  assert.equal(resolveCurrent(0), 0);
  assert.equal(resolveCurrent(43200), 43200);
  assert.equal(resolveCurrent(5), 5);
  assert.equal(resolveCurrent(Number.NaN), 1440);
  assert.equal(resolveCurrent(-1), 1440);
});

test("splitAutoArchive picks the largest unit that divides exactly", () => {
  assert.deepEqual(splitAutoArchive(4320), { value: 3, unit: "days" });
  assert.deepEqual(splitAutoArchive(1440), { value: 1, unit: "days" });
  assert.deepEqual(splitAutoArchive(120), { value: 2, unit: "hours" });
  assert.deepEqual(splitAutoArchive(90), { value: 90, unit: "minutes" });
  assert.deepEqual(splitAutoArchive(1), { value: 1, unit: "minutes" });
});

test("splitAutoArchive never hands back 0, which would read as never", () => {
  assert.deepEqual(splitAutoArchive(0), { value: 1, unit: "minutes" });
  assert.deepEqual(splitAutoArchive(-5), { value: 1, unit: "minutes" });
  assert.deepEqual(splitAutoArchive(Number.NaN), { value: 1, unit: "minutes" });
});

test("joinAutoArchive converts, clamps and never yields never", () => {
  assert.equal(joinAutoArchive(3, "days"), 4320);
  assert.equal(joinAutoArchive(2, "hours"), 120);
  assert.equal(joinAutoArchive(90, "minutes"), 90);
  // A half-typed or cleared field must not become "never" (0).
  assert.equal(joinAutoArchive(0, "days"), 1);
  assert.equal(joinAutoArchive(-4, "days"), 1);
  assert.equal(joinAutoArchive(Number.NaN, "days"), 1);
  // Past the ceiling clamps rather than sending a value the server refuses.
  assert.equal(joinAutoArchive(5000, "days"), MAX_AUTO_ARCHIVE_MINUTES);
});

test("split and join round-trip every preset duration", () => {
  for (const minutes of AUTO_ARCHIVE_PRESETS) {
    if (minutes === AUTO_ARCHIVE_NEVER) continue;
    const { value, unit } = splitAutoArchive(minutes);
    assert.equal(
      joinAutoArchive(value, unit),
      minutes,
      `expected ${minutes} to round-trip`,
    );
  }
});

test("maxAutoArchiveIn tracks the unit", () => {
  assert.equal(maxAutoArchiveIn("minutes"), MAX_AUTO_ARCHIVE_MINUTES);
  assert.equal(maxAutoArchiveIn("hours"), MAX_AUTO_ARCHIVE_MINUTES / 60);
  assert.equal(maxAutoArchiveIn("days"), 730);
  for (const unit of ["minutes", "hours", "days"] as const) {
    assert.equal(
      isAutoArchiveMinutes(
        maxAutoArchiveIn(unit) * AUTO_ARCHIVE_UNIT_MINUTES[unit],
      ),
      true,
      `expected the ${unit} ceiling to be a legal duration`,
    );
  }
});
