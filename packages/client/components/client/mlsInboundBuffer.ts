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
 * `mlsHoldVerdict` decides, per envelope, whether it goes to the sink, into
 * the hold, or nowhere.
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

/** What the bridge does with one inbound MLS envelope (`mlsHoldVerdict`). */
export type MlsHoldVerdict = "sink" | "hold" | "drop";

/**
 * Hand one MLS envelope to the active sink, hold it in `MlsInboundBuffer`
 * until a sink registers, or drop it. Dropping acks nothing: the envelope
 * stays queued in its device's server-side mailbox.
 *
 * - A registered sink gets every copy, whatever the other inputs say. The
 *   session filters by `recipientDeviceId` itself, as it did before the hold
 *   existed.
 * - A disabled bridge (`enabled === false`) holds nothing: it must not hand
 *   a later call envelopes it will never ack. `undefined` is not disabled —
 *   the status may not have loaded yet when the connect-time drain lands.
 * - Only this device's copies are held. A live MLS push goes to the
 *   recipient's user channel (delta `commits_submit.rs` publishes each
 *   device's copy with `.private(user)`), so every session of the account
 *   receives the copies addressed to all of its devices; held, the other
 *   devices' copies would only fill the buffer's cap ahead of ours. While
 *   this device's id is not yet known (`null`, `undefined` or `""`)
 *   everything is held, and the session's own recipient filter drops the
 *   rest at flush.
 */
export function mlsHoldVerdict(i: {
  sinkPresent: boolean;
  enabled: boolean | undefined;
  ownDeviceId: string | null | undefined;
  recipientDeviceId: string;
}): MlsHoldVerdict {
  if (i.sinkPresent) return "sink";
  if (i.enabled === false) return "drop";
  if (i.ownDeviceId && i.ownDeviceId !== i.recipientDeviceId) return "drop";
  return "hold";
}
