/**
 * Auto-archive durations for threads and forum posts, in minutes.
 *
 * The backend no longer keeps an allowlist: it accepts `0` (never) or any
 * whole number of minutes up to two years, so the durations below are
 * SHORTCUTS, not the contract. That distinction matters in both directions —
 * a value off this list is legal and must round-trip through the UI intact,
 * and a value that merely looks plausible (2.5, -60, 3_000_000) is still
 * rejected by the server, so it must be rejected here too rather than sent.
 *
 * `0` means "never auto-archive" and is a real, persisted choice — it must
 * never be coerced to a default. The defaults mirror the backend as well:
 * threads fall back to 1440 (1 day) and forums to 10080 (7 days).
 *
 * Pure module with no imports so it can be exercised directly under node's
 * native TypeScript type-stripping.
 */

/** Sentinel meaning "never auto-archive". */
export const AUTO_ARCHIVE_NEVER = 0;

/**
 * Longest duration the backend accepts: two years, taking a year as 365 days.
 * Mirrors `Channel::MAX_AUTO_ARCHIVE_MINUTES`.
 */
export const MAX_AUTO_ARCHIVE_MINUTES = 1_051_200;

/**
 * Durations offered as one-click presets, in display order.
 *
 * 1, 3, 5, 7, 10, 15, 20, 25 and 30 days are the set the operator asked for;
 * 90 days is kept because it is the one they said they would reach for most,
 * and 1 hour is kept because it shipped earlier and forums already set to it
 * should not have their duration quietly become unreachable. Never sorts
 * last, as the "off" end of the list rather than the shortest duration.
 * Anything not on this list is still settable through the custom field.
 */
export const AUTO_ARCHIVE_PRESETS = [
  60, 1440, 4320, 7200, 10080, 14400, 21600, 28800, 36000, 43200, 129600, 0,
] as const;

/**
 * A duration in minutes that the backend will accept.
 *
 * Deliberately `number` and not a union of the presets: the accepted set is a
 * range, and typing it as a union would make every custom duration a type
 * error at exactly the call sites that need to carry one.
 */
export type AutoArchiveMinutes = number;

/** Backend default applied to posts in a forum without its own default. */
export const FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES = 10080;

/** Backend default applied to threads without an explicit duration. */
export const THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES = 1440;

/**
 * Whether a value is a duration the backend will accept: `0` (never), or a
 * whole number of minutes from 1 to {@link MAX_AUTO_ARCHIVE_MINUTES}.
 * Mirrors `Channel::is_valid_auto_archive_minutes`.
 * @param value Arbitrary value, e.g. straight off the wire
 */
export function isAutoArchiveMinutes(
  value: unknown,
): value is AutoArchiveMinutes {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_AUTO_ARCHIVE_MINUTES
  );
}

/** Whether a duration has a preset of its own, i.e. needs no custom field. */
export function isAutoArchivePreset(minutes: number): boolean {
  return (AUTO_ARCHIVE_PRESETS as readonly number[]).includes(minutes);
}

/**
 * Duration a new forum post should start with, given the forum's default.
 * A valid forum default (including `0`) is used as-is; a missing or invalid
 * one falls back to {@link FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES}.
 * @param forumDefault Forum channel's configured default, if any
 */
export function resolvePostDefault(
  forumDefault: number | undefined,
): AutoArchiveMinutes {
  return isAutoArchiveMinutes(forumDefault)
    ? forumDefault
    : FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES;
}

/**
 * Effective duration of an existing thread or post, for display/selection.
 * A valid value (including `0`) is used as-is; a missing or invalid one
 * falls back to {@link THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES}.
 * @param value Channel's stored duration, if any
 */
export function resolveCurrent(value: number | undefined): AutoArchiveMinutes {
  return isAutoArchiveMinutes(value)
    ? value
    : THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES;
}

/** Unit the custom duration field is expressed in. */
export type AutoArchiveUnit = "minutes" | "hours" | "days";

/** Minutes per unit, for converting the custom field to and from minutes. */
export const AUTO_ARCHIVE_UNIT_MINUTES: Record<AutoArchiveUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 1440,
};

/**
 * Split a duration into the largest unit that divides it exactly, so the
 * custom field reads "3 days" rather than "4320 minutes". Never divides `0`
 * (that is the never sentinel, not a duration) — it comes back as 1 minute,
 * the shortest thing the field can legally hold, because the caller only
 * reaches the custom field when it is NOT choosing never.
 * @param minutes Duration in minutes
 */
export function splitAutoArchive(minutes: number): {
  value: number;
  unit: AutoArchiveUnit;
} {
  if (!isAutoArchiveMinutes(minutes) || minutes < 1) {
    return { value: 1, unit: "minutes" };
  }

  if (minutes % AUTO_ARCHIVE_UNIT_MINUTES.days === 0) {
    return { value: minutes / AUTO_ARCHIVE_UNIT_MINUTES.days, unit: "days" };
  }

  if (minutes % AUTO_ARCHIVE_UNIT_MINUTES.hours === 0) {
    return { value: minutes / AUTO_ARCHIVE_UNIT_MINUTES.hours, unit: "hours" };
  }

  return { value: minutes, unit: "minutes" };
}

/**
 * Recombine a custom field into minutes, clamped to what the backend accepts.
 * A blank or unreadable field reads as 1 minute rather than 0, so a half-typed
 * value can never be mistaken for "never".
 * @param value Number shown in the field
 * @param unit Unit selected alongside it
 */
export function joinAutoArchive(
  value: number,
  unit: AutoArchiveUnit,
): AutoArchiveMinutes {
  if (!Number.isFinite(value)) return 1;

  const minutes = Math.round(value) * AUTO_ARCHIVE_UNIT_MINUTES[unit];
  if (!Number.isFinite(minutes) || minutes < 1) return 1;

  return Math.min(minutes, MAX_AUTO_ARCHIVE_MINUTES);
}

/**
 * Largest value the custom field may hold in a given unit, so the input's
 * `max` tracks the unit instead of always reading the minute ceiling.
 * @param unit Unit selected alongside the field
 */
export function maxAutoArchiveIn(unit: AutoArchiveUnit): number {
  return Math.floor(MAX_AUTO_ARCHIVE_MINUTES / AUTO_ARCHIVE_UNIT_MINUTES[unit]);
}
