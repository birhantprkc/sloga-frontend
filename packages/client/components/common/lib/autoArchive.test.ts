// Specs for the thread / forum-post auto-archive duration helpers — run with
// Node's built-in runner:
//   node --test components/common/lib/autoArchive.test.ts
//
// All specs are pure. The option list must stay in lockstep with the backend
// allowlist; 0 means "never auto-archive" and must survive every resolver
// (a falsy-coalescing bug would silently turn "never" into a default).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AUTO_ARCHIVE_NEVER,
  AUTO_ARCHIVE_OPTIONS,
  FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES,
  THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES,
  isAutoArchiveMinutes,
  resolveCurrent,
  resolvePostDefault,
} from "./autoArchive.ts";

// Mirrors the backend allowlist (minutes): 1h, 1d, 3d, 1w, 30d, 90d, never.
const BACKEND_ALLOWLIST = [0, 60, 1440, 4320, 10080, 43200, 129600];

test("option list is exact and ordered, with never last", () => {
  assert.deepEqual(
    [...AUTO_ARCHIVE_OPTIONS],
    [60, 1440, 4320, 10080, 43200, 129600, 0],
  );
});

test("never is 0 and present in the option list", () => {
  assert.equal(AUTO_ARCHIVE_NEVER, 0);
  assert.ok((AUTO_ARCHIVE_OPTIONS as readonly number[]).includes(0));
  assert.equal(
    AUTO_ARCHIVE_OPTIONS[AUTO_ARCHIVE_OPTIONS.length - 1],
    AUTO_ARCHIVE_NEVER,
  );
});

test("option list matches the backend allowlist set exactly", () => {
  assert.equal(new Set(AUTO_ARCHIVE_OPTIONS).size, AUTO_ARCHIVE_OPTIONS.length);
  assert.deepEqual(
    [...AUTO_ARCHIVE_OPTIONS].sort((a, b) => a - b),
    [...BACKEND_ALLOWLIST].sort((a, b) => a - b),
  );
});

test("defaults are one week for forum posts and one day for threads", () => {
  assert.equal(FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES, 10080);
  assert.equal(THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES, 1440);
  assert.ok(isAutoArchiveMinutes(FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES));
  assert.ok(isAutoArchiveMinutes(THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES));
});

test("isAutoArchiveMinutes accepts every allowlisted value including 0", () => {
  for (const value of BACKEND_ALLOWLIST) {
    assert.equal(isAutoArchiveMinutes(value), true, `expected ${value} valid`);
  }
  assert.equal(isAutoArchiveMinutes(0), true);
});

test("isAutoArchiveMinutes rejects off-list, non-number and nullish values", () => {
  assert.equal(isAutoArchiveMinutes(30), false);
  assert.equal(isAutoArchiveMinutes(5), false);
  assert.equal(isAutoArchiveMinutes(-60), false);
  assert.equal(isAutoArchiveMinutes(60.5), false);
  assert.equal(isAutoArchiveMinutes("60"), false);
  assert.equal(isAutoArchiveMinutes("0"), false);
  assert.equal(isAutoArchiveMinutes(Number.NaN), false);
  assert.equal(isAutoArchiveMinutes(undefined), false);
  assert.equal(isAutoArchiveMinutes(null), false);
});

test("resolvePostDefault keeps valid values (including never) and falls back to one week", () => {
  assert.equal(resolvePostDefault(undefined), 10080);
  assert.equal(resolvePostDefault(0), 0);
  assert.equal(resolvePostDefault(129600), 129600);
  assert.equal(resolvePostDefault(60), 60);
  assert.equal(resolvePostDefault(30), 10080);
  assert.equal(resolvePostDefault(Number.NaN), 10080);
});

test("resolveCurrent keeps valid values (including never) and falls back to one day", () => {
  assert.equal(resolveCurrent(undefined), 1440);
  assert.equal(resolveCurrent(0), 0);
  assert.equal(resolveCurrent(43200), 43200);
  assert.equal(resolveCurrent(10080), 10080);
  assert.equal(resolveCurrent(5), 1440);
  assert.equal(resolveCurrent(Number.NaN), 1440);
});
