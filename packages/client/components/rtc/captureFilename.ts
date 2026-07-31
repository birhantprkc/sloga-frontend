/**
 * Names for the files a local capture produces.
 *
 * Recordings and transcripts are the two things this app writes to a user's
 * disk, and they are written from the same call, often in the same breath. They
 * share this so that a recording and its transcript land side by side with
 * matching names and sort together — and so the rules about what a filesystem
 * will actually accept live in exactly one place.
 */

/**
 * `<channel>-<local date>-<hhmm>.<ext>`.
 *
 * The timestamp is LOCAL, not UTC: it exists so that several captures of the
 * same channel sort chronologically and never collide, and the person reading
 * the folder is in their own timezone.
 */
export function captureFilename(
  channelName: string | undefined,
  startedAt: number,
  extension: string,
): string {
  const stamp = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const date =
    `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}` +
    `-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;

  // Keep the channel name recognisable but filesystem-safe on every platform:
  // Windows rejects \ / : * ? " < > | outright. Trimming the separators off the
  // ends matters too — a name beginning `-` reads as a flag to CLI tools.
  const safeName = (channelName ?? "call")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, "-")
    .slice(0, 48)
    .replace(/^-+|-+$/g, "");

  return `${safeName || "call"}-${date}.${extension}`;
}
