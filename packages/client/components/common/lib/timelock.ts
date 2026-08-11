/**
 * Timelocked messages: content encrypted so it CANNOT be read before a chosen
 * time, enforced by cryptography rather than the server. We encrypt with
 * tlock (age + pairing-based IBE) against the drand "quicknet" beacon: the
 * key material needed to decrypt simply does not exist anywhere until the
 * network emits the target round's randomness, at which point anyone can
 * fetch it and open the message. No Sloga infrastructure is trusted or even
 * involved in the sealing.
 *
 * Wire format (rides in ordinary message content, no server support needed):
 *
 *   ⏳ Timelocked message — unlocks 2026-08-15 18:00 UTC
 *   tlock:v1:<unlockEpochMs>:<age armor body, unwrapped>
 *
 * Line 1 is a human-readable fallback so clients that predate the feature
 * degrade to something legible. Line 2 is authoritative for machines: clients
 * that know the format render the sealed-envelope UI instead (same pattern as
 * sticker messages — a malformed payload falls through to plain markdown).
 *
 * The displayed unlock time is sender-asserted; the CRYPTOGRAPHIC gate is the
 * round number sealed inside the age header. A dishonest timestamp can only
 * make the countdown lie, at which point decryption keeps failing (or
 * succeeds early) and the UI follows what the beacon actually allows.
 *
 * tlock-js is loaded lazily: the BLS12-381 pairing code is a heavy dependency
 * that must not ride in the entry chunk for users who never touch the
 * feature.
 */

const MARKER_PREFIX = "⏳ Timelocked message — unlocks ";
const MACHINE_RE = /^tlock:v1:(\d{1,15}):([A-Za-z0-9+/=]{64,8192})$/;

/** Longest plaintext the compose dialog accepts. Armor overhead is ~1.37x
 * plus a ~420-char age/tlock header, so this stays well inside the default
 * 2000-char message cap. */
export const MAX_TIMELOCK_PLAINTEXT = 600;

/** Furthest allowed unlock: 5 years. drand has no expiry, but a typo'd year
 * would otherwise seal a message effectively forever. */
export const MAX_TIMELOCK_HORIZON_MS = 5 * 365 * 24 * 60 * 60 * 1000;

export interface TimelockPayload {
  /** Sender-asserted unlock time (drives countdown + first decrypt attempt) */
  unlockAt: Date;
  /** age armor body with header/footer/newlines stripped */
  armorBody: string;
}

const ARMOR_HEADER = "-----BEGIN AGE ENCRYPTED FILE-----";
const ARMOR_FOOTER = "-----END AGE ENCRYPTED FILE-----";

/** Re-wrap a bare armor body into strict age armor (64-column lines). */
function rewrapArmor(body: string): string {
  const lines = body.match(/.{1,64}/g) ?? [];
  return `${ARMOR_HEADER}\n${lines.join("\n")}\n${ARMOR_FOOTER}\n`;
}

/** Strip age armor down to its base64 body (single line). */
function unwrapArmor(armor: string): string {
  return armor
    .split("\n")
    .filter((line) => line && !line.startsWith("-----"))
    .join("");
}

/**
 * Parse message content as a timelocked message. Returns undefined for
 * anything that does not match EXACTLY (two lines, marker + machine line),
 * so ordinary messages — and malformed or tampered payloads — fall through
 * to the regular markdown renderer.
 */
export function parseTimelockContent(
  content?: string,
): TimelockPayload | undefined {
  if (!content) return undefined;
  const lines = content.split("\n");
  if (lines.length !== 2 || !lines[0].startsWith(MARKER_PREFIX))
    return undefined;
  const match = MACHINE_RE.exec(lines[1]);
  if (!match) return undefined;
  const unlockMs = Number(match[1]);
  if (!Number.isSafeInteger(unlockMs)) return undefined;
  return { unlockAt: new Date(unlockMs), armorBody: match[2] };
}

export function isTimelockMessage(content?: string): boolean {
  return parseTimelockContent(content) !== undefined;
}

/**
 * Encrypt plaintext so it unlocks at the given time, returning the full
 * message content string to send. Requires network access to read the drand
 * chain info the first time.
 */
export async function encryptTimelockMessage(
  plaintext: string,
  unlockAt: Date,
): Promise<string> {
  const { timelockEncrypt, mainnetClient, roundAt, defaultChainInfo, Buffer } =
    await import("tlock-js");

  const round = roundAt(unlockAt.getTime(), defaultChainInfo);
  const armor = await timelockEncrypt(
    round,
    Buffer.from(plaintext, "utf8"),
    mainnetClient(),
  );

  const human = `${unlockAt.toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return `${MARKER_PREFIX}${human}\ntlock:v1:${unlockAt.getTime()}:${unwrapArmor(armor)}`;
}

/** Thrown when the beacon has not yet reached the payload's round. */
export class TimelockNotReadyError extends Error {}

/**
 * Attempt to decrypt a timelocked payload. Throws TimelockNotReadyError while
 * the round is still in the future; other failures (network down, corrupted
 * payload) throw as-is.
 */
export async function decryptTimelockMessage(
  payload: TimelockPayload,
): Promise<string> {
  const { timelockDecrypt, mainnetClient } = await import("tlock-js");

  try {
    const plain = await timelockDecrypt(
      rewrapArmor(payload.armorBody),
      mainnetClient(),
    );
    return plain.toString("utf8");
  } catch (error) {
    // tlock-js signals a future round with a "too early" message; there is no
    // typed error to catch, so match on it and keep everything else loud.
    if (error instanceof Error && /too early|not yet/i.test(error.message))
      throw new TimelockNotReadyError(error.message);
    throw error;
  }
}
