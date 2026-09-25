/**
 * Inbound MLS routing + the pre-sink hold for MLS envelopes.
 *
 * Why this exists: bonfire replays the whole mailbox once per websocket
 * connection as `E2EEMessage`, whatever the envelope's type — including the
 * MLS commits, Welcomes and ctl messages queued for this device. That drain
 * lands at connect time, before any call session has registered its sink.
 * The bridge used to hand every `E2EEMessage` to the Olm decrypt path, where
 * an MLS envelope fails to decrypt, is written as undecryptable and is then
 * ACKED — deleting it server-side before the call that needed it existed.
 *
 * `inboundRoute` decides which plane an inbound envelope belongs to from its
 * `content_type` alone; `MlsInboundBuffer` holds MLS envelopes that arrive
 * with no session registered, until a session registers and takes them in
 * order. Nothing here acks: a held envelope is still queued server-side, and
 * the session acks it after durable processing, exactly as for a live push.
 *
 * Kept free of every app import so `node --test` can load it.
 */

export type InboundRoute = "olm" | "mls";

/**
 * Which plane an inbound envelope belongs to. Only the three MLS content
 * types route to MLS; a missing, `"olm"` or unrecognized type stays on the
 * Olm path, which is what every envelope did before MLS existed.
 */
export function inboundRoute(
  contentType: string | null | undefined,
): InboundRoute {
  switch (contentType) {
    case "mls_commit":
    case "mls_welcome":
    case "mls_ctl":
      return "mls";
    default:
      return "olm";
  }
}

/**
 * The event the bridge hands the call session's sink for an MLS envelope
 * (`MlsSinkEvent` with `kind: "envelope"`), stated structurally so this
 * module stays import-free. A held entry is flushed to the sink as is, so
 * `recipientDeviceId` — which the session checks against its own device —
 * survives the wait.
 */
export type MlsBufferedEnvelope = {
  kind: "envelope";
  recipientDeviceId: string;
  envelope: {
    id: string;
    content_type: string;
    group_id: string;
    epoch: number;
    ciphertext: string;
  };
};

/**
 * FIFO hold for MLS envelopes that arrive before a call session's sink is
 * registered.
 *
 * - Deduplicated by envelope id against what is currently held: a mailbox
 *   drain can repeat an id a live push already delivered.
 * - Bounded by `max`, and overflow never evicts. An envelope that does not
 *   fit is simply not held; it stays unacked server-side, so the next
 *   connection's drain delivers it again. Evicting an older one instead
 *   would hand the session a gap it cannot see.
 * - One `console.warn` per overflow episode; the episode ends when the
 *   buffer is drained or cleared.
 */
export class MlsInboundBuffer {
  readonly #max: number;
  #held: MlsBufferedEnvelope[] = [];
  #ids = new Set<string>();
  #overflowWarned = false;

  constructor(max = 512) {
    this.#max = max;
  }

  push(e: MlsBufferedEnvelope): "buffered" | "duplicate" | "overflow" {
    const id = e.envelope.id;
    if (this.#ids.has(id)) return "duplicate";
    if (this.#held.length >= this.#max) {
      if (!this.#overflowWarned) {
        this.#overflowWarned = true;
        console.warn(
          "[mls] inbound buffer full, envelope left queued server-side",
          { max: this.#max, id, group_id: e.envelope.group_id },
        );
      }
      return "overflow";
    }
    this.#held.push(e);
    this.#ids.add(id);
    return "buffered";
  }

  /** Everything held, oldest first; the buffer is left empty. */
  drain(): MlsBufferedEnvelope[] {
    const held = this.#held;
    this.clear();
    return held;
  }

  /** Drop everything held (still queued server-side) without delivering it. */
  clear(): void {
    this.#held = [];
    this.#ids.clear();
    this.#overflowWarned = false;
  }

  get size(): number {
    return this.#held.length;
  }
}
