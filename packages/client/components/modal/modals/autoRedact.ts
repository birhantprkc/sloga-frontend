/**
 * Sensitive-text detection over OCR output for the image editor's
 * Auto-redact. Pure functions — no DOM, no tesseract import — so this is
 * unit-testable under plain node and the heavy OCR stack stays in the
 * editor chunk.
 *
 * Design rules:
 *  - Detection is advisory. Everything found becomes a *proposal* the user
 *    reviews; nothing is applied silently.
 *  - Prefer over-redaction on the ambiguous patterns (labelled values,
 *    secret-shaped strings): a false positive costs one click to untoggle,
 *    a false negative leaks.
 */

export type OcrWord = {
  text: string;
  /** Bounding box in image pixels */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Line grouping key — words on the same OCR line share it */
  line: number;
};

export type RedactionKind =
  | "email"
  | "phone"
  | "card"
  | "ssn"
  | "secret"
  | "labelled"
  | "identity"
  | "ip";

export type RedactionProposal = {
  kind: RedactionKind;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The matched text, for the review chip */
  text: string;
};

export type IdentityHints = {
  username?: string;
  email?: string;
  displayName?: string;
};

const EMAIL = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/i;
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}(:\d{1,5})?$/;
const SSN = /^\d{3}-\d{2}-\d{4}$/;
const JWT = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/;
const KEY_PREFIX =
  /^(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{12,}|^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|^AKIA[0-9A-Z]{12,}|^xox[baprs]-[A-Za-z0-9-]{10,}|^AIza[0-9A-Za-z_-]{30,}/;
const LONG_TOKEN = /^[A-Za-z0-9+/_=-]{32,}$/;

/**
 * Words that introduce a value that should be hidden. Matched case-
 * insensitively against a word with trailing punctuation stripped.
 */
const VALUE_LABELS = new Set([
  "password",
  "passwd",
  "pass",
  "pwd",
  "pin",
  "passcode",
  "token",
  "secret",
  "apikey",
  "api_key",
  "api-key",
  "key",
  "bearer",
  "authorization",
  "auth",
  "otp",
  "code",
  "ssn",
  "cvv",
  "cvc",
  "iban",
  "routing",
  "account",
  "acct",
]);

/**
 * Luhn checksum — separates card numbers from other long digit runs
 */
export function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (n < 0 || n > 9) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function strip(text: string): string {
  return text.replace(/^[^\w+@]+|[^\w+@=/-]+$/g, "");
}

function digitsOnly(text: string): string {
  return text.replace(/\D/g, "");
}

function boxOf(words: OcrWord[]): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const x0 = Math.min(...words.map((w) => w.x0));
  const y0 = Math.min(...words.map((w) => w.y0));
  const x1 = Math.max(...words.map((w) => w.x1));
  const y1 = Math.max(...words.map((w) => w.y1));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Detect sensitive text and return redaction proposals in image space.
 * @param words OCR words with boxes and line keys
 * @param identity The current account's own identifiers, if any
 */
export function detectSensitive(
  words: OcrWord[],
  identity: IdentityHints = {},
): RedactionProposal[] {
  const proposals: RedactionProposal[] = [];
  const claimed = new Set<number>();

  const claim = (kind: RedactionKind, indices: number[], text: string) => {
    const fresh = indices.filter((i) => !claimed.has(i));
    if (!fresh.length) return;
    fresh.forEach((i) => claimed.add(i));
    proposals.push({ kind, text, ...boxOf(indices.map((i) => words[i])) });
  };

  const identityNeedles = [
    identity.username,
    identity.email,
    identity.displayName,
  ]
    .filter((s): s is string => !!s && s.length >= 3)
    .map((s) => s.toLowerCase());

  // group indices by line for the multi-word passes
  const lines = new Map<number, number[]>();
  words.forEach((w, i) => {
    const arr = lines.get(w.line) ?? [];
    arr.push(i);
    lines.set(w.line, arr);
  });

  // ---- single-word passes ------------------------------------------------
  words.forEach((w, i) => {
    const t = strip(w.text);
    if (!t) return;
    const lower = t.toLowerCase();

    if (EMAIL.test(t)) return claim("email", [i], t);
    if (SSN.test(t)) return claim("ssn", [i], t);
    if (IPV4.test(t)) {
      const octets = t.split(":")[0].split(".").map(Number);
      if (octets.every((o) => o <= 255)) return claim("ip", [i], t);
    }
    if (JWT.test(t) || KEY_PREFIX.test(t)) return claim("secret", [i], t);
    if (LONG_TOKEN.test(t) && /\d/.test(t) && /[A-Za-z]/.test(t)) {
      return claim("secret", [i], t);
    }

    const d = digitsOnly(t);
    if (d.length >= 13 && d.length <= 19 && d.length >= t.length - 4) {
      if (luhn(d)) return claim("card", [i], t);
    }

    for (const needle of identityNeedles) {
      if (lower === needle || lower === "@" + needle) {
        return claim("identity", [i], t);
      }
    }
  });

  // ---- multi-word passes (per line) --------------------------------------
  for (const idx of lines.values()) {
    // card numbers / phone numbers split into groups: "4242 4242 4242 4242",
    // "(555) 123-4567", "+1 555 123 4567"
    for (let start = 0; start < idx.length; start++) {
      if (claimed.has(idx[start])) continue;
      let digits = "";
      let end = start;
      const run: number[] = [];
      while (end < idx.length && end - start < 6) {
        const piece = strip(words[idx[end]].text);
        const pd = digitsOnly(piece);
        // every piece in a number run must be mostly digits
        if (!pd.length || pd.length < piece.replace(/[()+\-.]/g, "").length) {
          break;
        }
        digits += pd;
        run.push(idx[end]);
        end++;

        if (run.length >= 2 && digits.length >= 13 && digits.length <= 19) {
          if (luhn(digits)) {
            claim("card", run, run.map((i) => words[i].text).join(" "));
            break;
          }
        }
      }
    }

    // phone: 10-15 digits across 1-5 pieces, not already claimed as card
    for (let start = 0; start < idx.length; start++) {
      if (claimed.has(idx[start])) continue;
      let digits = "";
      const run: number[] = [];
      for (let end = start; end < idx.length && end - start < 5; end++) {
        const piece = strip(words[idx[end]].text);
        const pd = digitsOnly(piece);
        if (!pd.length || pd.length < piece.replace(/[()+\-.]/g, "").length) {
          break;
        }
        digits += pd;
        run.push(idx[end]);
        if (digits.length >= 10 && digits.length <= 15) {
          // a bare 10+ digit run inside a single word is ambiguous (order
          // numbers, ids); require separators or multiple pieces
          const single = run.length === 1;
          const hasSep = /[()+\-. ]/.test(words[idx[start]].text);
          if (!single || hasSep) {
            claim("phone", run, run.map((i) => words[i].text).join(" "));
          }
          break;
        }
      }
    }

    // labelled values: "Password: hunter2", "token = abc", "PIN 1234"
    for (let k = 0; k < idx.length - 1; k++) {
      const label = strip(words[idx[k]].text)
        .toLowerCase()
        .replace(/[:=]+$/, "");
      if (!VALUE_LABELS.has(label)) continue;

      // skip separator-only words between label and value
      let v = k + 1;
      while (v < idx.length && /^[:=\-–—]+$/.test(words[idx[v]].text)) v++;
      if (v >= idx.length) continue;

      const valueText = strip(words[idx[v]].text);
      if (!valueText || VALUE_LABELS.has(valueText.toLowerCase())) continue;
      // "code" and "key" are common English; only redact when the value
      // looks like a value, not prose
      if (
        (label === "code" ||
          label === "key" ||
          label === "auth" ||
          label === "account" ||
          label === "pass") &&
        !/[\d_\-@#$%^&*!]/.test(valueText) &&
        valueText.length < 6
      ) {
        continue;
      }
      claim("labelled", [idx[v]], valueText);
    }
  }

  return proposals;
}
