import { ReactiveMap } from "@solid-primitives/map";

/**
 * One relayed stroke: fixed-point polyline over the shared surface's unit
 * square (0..=10000, divide by `ANNOTATION_COORD_SCALE`), with palette and
 * width CLASS indexes. Raw colors never cross the wire — the palette is the
 * abuse boundary (plan §2.4), not a style choice.
 */
export interface AnnotationStrokeData {
  points: number[];
  color: number;
  width: number;
}

/** A batch of strokes from one annotator, stamped with arrival time. */
export interface AnnotationBatch {
  annotatorIdentity: string;
  annotatorId: string;
  strokes: AnnotationStrokeData[];
  seq: number;
  /** Arrival time (ms epoch) — drives the fade and the hard clear. */
  at: number;
}

/** Fixed-point scale for stroke coordinates (matches the server). */
export const ANNOTATION_COORD_SCALE = 10_000;

/**
 * The fixed branded ink palette. LENGTH IS A WIRE CONTRACT: the server
 * refuses color indexes >= its `ANNOTATION_PALETTE_SIZE` (5), so this table
 * must keep exactly that many entries — the spec asserts it. Chosen to be
 * high-chroma ink shades that read as OVERLAY on any real UI, per the
 * honest-overlay rule (§2.4): no grays, no whites, nothing that could pass
 * for native chrome.
 */
export const ANNOTATION_PALETTE = [
  "#ff5d5d",
  "#ffb43d",
  "#3dd68c",
  "#4da6ff",
  "#c77dff",
] as const;

/** Stroke width classes in CSS px at 1080p-equivalent scale (server: 3). */
export const ANNOTATION_WIDTHS = [3, 5, 8] as const;

/**
 * Composited ALPHA CEILING for the whole annotation layer. The §2.4
 * cumulative-opacity rule: translucent strokes must never stack to opaque,
 * and per-stroke alpha cannot guarantee that — so the renderer draws strokes
 * OPAQUE on an offscreen canvas and composites that layer at this fixed
 * alpha. The cap lives here (not in the component) so the spec can assert
 * it stays below the threshold where an overlay could pass for real UI.
 */
export const ANNOTATION_LAYER_ALPHA = 0.5;

/** Strokes start fading after this long... */
export const ANNOTATION_FADE_START_MS = 3_000;
/** ...and are pruned entirely at this age. */
export const ANNOTATION_CLEAR_MS = 8_000;

/** Client-side send cadence ceiling (one batch per tick). */
export const ANNOTATION_SEND_INTERVAL_MS = 100;

/** Wire bounds (mirror the server's refusals — send nothing it would 400). */
export const MAX_STROKES_PER_BATCH = 8;
export const MAX_POINT_VALUES_PER_STROKE = 128;

/**
 * Live screen-share annotations: ingests `CallAnnotation` batches into a
 * reactive per-target map the tiles render, tracks draw-consent state from
 * `CallAnnotationConsent`, and prunes strokes on a TTL.
 *
 * Mirrors `LiveCaptions`' shape: a dependency-light class the app-lifetime
 * client listeners feed (connect-scoped subscriptions go dead after the
 * first call), with all call scoping done by the caller. Runs under
 * `node --test --conditions=browser` with no shell globals.
 *
 * TRUST NOTES (plan §0.2/§2.4): `annotatorIdentity` is server-RESOLVED,
 * which stops a hostile CLIENT drawing in someone else's name, but the
 * transport cannot prove it end-to-end — UI copy presents it as "who the
 * server says is drawing", never as verified. The TTL fade here is comfort,
 * not the abuse backstop: a persistent redrawer refreshes it forever. The
 * backstop is the sharer's one-action revoke, which arrives as an empty
 * consent list and drops everything at once.
 */
export class LiveAnnotations {
  /**
   * targetIdentity -> live batches drawn on that participant's surface.
   * The array is REPLACED on every change (never mutated) so a Solid effect
   * reading it re-runs.
   */
  readonly batches = new ReactiveMap<string, AnnotationBatch[]>();

  /**
   * sharer USER id -> their current draw allowlist (user ids). Empty/absent
   * means nobody may draw. This is a mirror of server state for affordances;
   * the server enforces regardless.
   */
  readonly consent = new ReactiveMap<string, string[]>();

  #localIdentity = "";
  #localUserId = "";
  #pruneTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * targetIdentity -> target USER id, learned on append (batches are keyed
   * by identity for tile rendering, consent by user id — this is the join).
   */
  #targetUsers = new Map<string, string>();
  #now: () => number;

  /** @param now Injected clock so specs can drive the TTL deterministically. */
  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  get localIdentity(): string {
    return this.#localIdentity;
  }

  get localUserId(): string {
    return this.#localUserId;
  }

  /** May `annotatorId` draw on `sharerId`'s surface, per mirrored consent? */
  mayDraw(sharerId: string, annotatorId: string): boolean {
    return this.consent.get(sharerId)?.includes(annotatorId) ?? false;
  }

  /** Bind to a connected call. */
  attach(localIdentity: string, localUserId: string) {
    this.detach();
    this.#localIdentity = localIdentity;
    this.#localUserId = localUserId;
  }

  /** Unbind and clear all annotation state. Safe to call repeatedly. */
  detach() {
    for (const timer of this.#pruneTimers.values()) clearTimeout(timer);
    this.#pruneTimers.clear();
    this.batches.clear();
    this.consent.clear();
    this.#targetUsers.clear();
    this.#localIdentity = "";
    this.#localUserId = "";
  }

  /**
   * Seed consent state from the GET route (a late joiner has missed the
   * consent events; plan §2.2's backfill rule).
   */
  seedConsent(entries: { sharer_id: string; allowed: string[] }[]) {
    for (const entry of entries) {
      if (entry.allowed.length > 0) {
        this.consent.set(entry.sharer_id, [...entry.allowed]);
      }
    }
  }

  /**
   * Ingest a relayed stroke batch. The caller has already scoped to the
   * active call; this additionally drops batches from annotators the
   * mirrored consent state does not list (the server enforces this too —
   * the local check just closes the window where a revoke event beat a
   * stroke event).
   */
  handleRemoteAnnotation(detail: {
    annotatorIdentity: string;
    annotatorId: string;
    targetIdentity: string;
    targetId: string;
    strokes: AnnotationStrokeData[];
    seq: number;
  }): void {
    if (!detail.targetIdentity || !Array.isArray(detail.strokes)) return;
    if (!this.mayDraw(detail.targetId, detail.annotatorId)) return;
    this.#targetUsers.set(detail.targetIdentity, detail.targetId);
    this.#append(detail.targetIdentity, {
      annotatorIdentity: detail.annotatorIdentity,
      annotatorId: detail.annotatorId,
      strokes: detail.strokes,
      seq: detail.seq,
      at: this.#now(),
    });
  }

  /**
   * Mirror my OWN strokes locally as I draw them (the relay skips the
   * sender, exactly like captions' self-mirror).
   */
  addLocalStrokes(
    targetIdentity: string,
    targetId: string,
    strokes: AnnotationStrokeData[],
    seq: number,
  ): void {
    this.#targetUsers.set(targetIdentity, targetId);
    this.#append(targetIdentity, {
      annotatorIdentity: this.#localIdentity,
      annotatorId: this.#localUserId,
      strokes,
      seq,
      at: this.#now(),
    });
  }

  /**
   * Ingest a consent change. Empty `allowed` is the one-action revoke: every
   * rendered stroke on that sharer's surfaces drops IMMEDIATELY (not on
   * fade) — a revoked phishing overlay must not get its 8s of grace.
   * A shrunk (but non-empty) list likewise drops the de-listed annotators'
   * strokes.
   */
  handleConsent(detail: { sharerId: string; allowed: string[] }): void {
    if (detail.allowed.length === 0) {
      this.consent.delete(detail.sharerId);
    } else {
      this.consent.set(detail.sharerId, [...detail.allowed]);
    }

    for (const [identity, batches] of this.batches) {
      // Only this sharer's surfaces are touched — the identity→user join is
      // learned on append, so any key with batches has an entry.
      if (this.#targetUsers.get(identity) !== detail.sharerId) continue;
      const kept = batches.filter((batch) =>
        detail.allowed.includes(batch.annotatorId),
      );
      if (kept.length !== batches.length) {
        this.#swap(identity, kept);
      }
    }
  }

  #append(targetIdentity: string, batch: AnnotationBatch) {
    if (batch.strokes.length === 0) return;
    const now = this.#now();
    const existing = this.batches.get(targetIdentity) ?? [];
    const kept = existing.filter((b) => now - b.at < ANNOTATION_CLEAR_MS);
    kept.push(batch);
    this.#swap(targetIdentity, kept);
    this.#armPrune(targetIdentity);
  }

  #swap(targetIdentity: string, batches: AnnotationBatch[]) {
    if (batches.length === 0) {
      this.batches.delete(targetIdentity);
      const timer = this.#pruneTimers.get(targetIdentity);
      if (timer) {
        clearTimeout(timer);
        this.#pruneTimers.delete(targetIdentity);
      }
    } else {
      this.batches.set(targetIdentity, batches);
    }
  }

  /** Re-arm the TTL prune for one surface. */
  #armPrune(targetIdentity: string) {
    const prev = this.#pruneTimers.get(targetIdentity);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      const now = this.#now();
      const kept = (this.batches.get(targetIdentity) ?? []).filter(
        (b) => now - b.at < ANNOTATION_CLEAR_MS,
      );
      this.#swap(targetIdentity, kept);
      if (kept.length > 0) this.#armPrune(targetIdentity);
    }, ANNOTATION_CLEAR_MS + 50);
    // Under Node (the specs) a pending prune must not hold the process
    // open — with an injected frozen clock nothing ever ages out, so the
    // re-arm would otherwise keep `node --test` alive forever. No-op in
    // browsers, where timers have no unref.
    (timer as unknown as { unref?: () => void }).unref?.();
    this.#pruneTimers.set(targetIdentity, timer);
  }
}
