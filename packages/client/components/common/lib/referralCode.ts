/**
 * Referral codes: a bare 4-character Crockford base32 code, shown to users
 * with a `SLOGA-` prefix (`SLOGA-KX7P`).
 *
 * normalizeReferralCode mirrors the server's parser exactly, so the signup
 * form accepts and rejects the same inputs the server does. The server stays
 * authoritative; this only saves a round trip on obvious typos.
 */

export const REFERRAL_CODE_PREFIX = "SLOGA";

/** Crockford base32 alphabet (no I, L, O or U) */
const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Length of a bare referral code */
const CODE_LENGTH = 4;

/** Longest input considered, in UTF-8 bytes */
const MAX_INPUT_BYTES = 32;

/** Unicode White_Space, the set the server treats as whitespace. `\s`
 * differs: it adds U+FEFF and misses U+0085. */
const WHITESPACE = /\p{White_Space}/u;

/**
 * Bare 4-character code, or undefined when the input can't be one.
 *
 * Case-insensitive; accepts the `SLOGA` prefix and separators
 * (`sloga-kx7p`, `SLOGA KX7P` -> `KX7P`); reads O as 0 and I/L as 1
 * (`kx7o` -> `KX70`).
 */
export function normalizeReferralCode(input: string): string | undefined {
  if (new TextEncoder().encode(input).length > MAX_INPUT_BYTES) {
    return undefined;
  }

  // ASCII-only uppercasing: toUpperCase() would turn "ß" into "SS" or "ı"
  // into "I" and accept codes the server rejects
  const compact = Array.from(input)
    .filter((c) => !WHITESPACE.test(c) && c !== "-" && c !== "_")
    .map((c) => (c >= "a" && c <= "z" ? c.toUpperCase() : c))
    .join("");

  const rest = compact.startsWith(REFERRAL_CODE_PREFIX)
    ? compact.slice(REFERRAL_CODE_PREFIX.length)
    : undefined;
  const bare = Array.from(
    rest !== undefined && Array.from(rest).length === CODE_LENGTH
      ? rest
      : compact,
  );

  if (bare.length !== CODE_LENGTH) {
    return undefined;
  }

  let code = "";
  for (const c of bare) {
    if (c === "O") {
      code += "0";
    } else if (c === "I" || c === "L") {
      code += "1";
    } else if (c.length === 1 && CODE_ALPHABET.includes(c)) {
      code += c;
    } else {
      return undefined;
    }
  }

  return code;
}

/** Display form, e.g. "SLOGA-KX7P". */
export function displayReferralCode(code: string): string {
  return `${REFERRAL_CODE_PREFIX}-${code}`;
}
