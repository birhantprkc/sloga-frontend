/**
 * Auto-archive durations for threads and forum posts, in minutes.
 *
 * The allowed values mirror the backend `Channel::ALLOWED_AUTO_ARCHIVE_MINUTES`
 * exactly; anything else is rejected by the server. `0` means "never
 * auto-archive" and is a real, persisted choice — it must never be coerced to
 * a default. The defaults mirror the backend as well: threads fall back to
 * 1440 (1 day) and forums to 10080 (7 days).
 *
 * Pure module with no imports so it can be exercised directly under node's
 * native TypeScript type-stripping.
 */

/** Sentinel meaning "never auto-archive". */
export const AUTO_ARCHIVE_NEVER = 0;

/**
 * Every accepted auto-archive duration in display order:
 * 1 hour, 1 day, 3 days, 7 days, 30 days, 90 days, Never.
 */
export const AUTO_ARCHIVE_OPTIONS = [
  60, 1440, 4320, 10080, 43200, 129600, 0,
] as const;

/** One of the accepted auto-archive durations (minutes, `0` = never). */
export type AutoArchiveMinutes = (typeof AUTO_ARCHIVE_OPTIONS)[number];

/** Backend default applied to posts in a forum without its own default. */
export const FORUM_DEFAULT_AUTO_ARCHIVE_MINUTES = 10080;

/** Backend default applied to threads without an explicit duration. */
export const THREAD_DEFAULT_AUTO_ARCHIVE_MINUTES = 1440;

/**
 * Whether a value is one of the accepted auto-archive durations.
 * `0` (never) is accepted; non-numbers and unlisted numbers are not.
 * @param value Arbitrary value, e.g. straight off the wire
 */
export function isAutoArchiveMinutes(
  value: unknown,
): value is AutoArchiveMinutes {
  return (
    typeof value === "number" &&
    (AUTO_ARCHIVE_OPTIONS as readonly number[]).includes(value)
  );
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
