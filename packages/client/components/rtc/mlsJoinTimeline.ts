/**
 * Join-timeline recorder for the media-E2EE join path (join-latency plan,
 * slice 0). PURE: no session imports, no logging, and the only ambient it
 * touches is `performance`, which is injectable so specs drive a fake clock.
 *
 * WHY THIS EXISTS. A member joining an encrypted call sits in dead air for
 * about a second on a clean join and 11–13 s on a rejoin, and the lines that
 * exist today are scattered across the joiner's console, the admitter's
 * console and the gate trace, each on its own clock. Nobody can say which
 * STAGE of the join ladder the time went to, so every lever in the plan is
 * argued from inferred round-trip counts rather than a measurement. This
 * recorder gives both seats one ordered readout: the session stamps each
 * stage as it passes (`start` through `modeE2ee` on the joiner,
 * `joinRequestSeen` through `commitWon` on the admitter), and the summary,
 * printed once at gate release and folded into `metrics()`, attributes the
 * hole by stage.
 *
 * Semantics the wiring and the spec both rely on:
 *  - the first stamp defines t0, and every ms is relative to it;
 *  - the FIRST occurrence of a name wins. A retried stage keeps the time it
 *    was first reached, because the retry is the thing being measured, not a
 *    reason to hide it;
 *  - `restart()` forgets everything, so a re-establish reads as a fresh
 *    joiner timeline and never inherits the previous generation's t0.
 *
 * Reading a summary. There is no `creator` role: the role is fixed when the
 * session constructs the recorder, and whether this seat minted the group or
 * joined one is only known once the DS answers, so a creator seat reports
 * `role: "joiner"` like any other. Tell them apart by the stamps instead. A
 * summary with `createRouted` present and `welcomeAdopted` absent is a
 * creator: it minted the group and enabled on its own first key, and no
 * welcome was ever adopted. A joiner, including the 409 → join route, carries
 * both. The `[mls] join timeline` and `[mls] admit timeline` log objects carry
 * `p: performance.now()` taken at print time, the same clock the
 * `[gate-trace]` records stamp as `p`, so the timeline's t0 on that clock is
 * `p − totalMs` and the two readouts line up without a second clock.
 */

export type JoinRole = "joiner" | "admitter";

export type JoinStamp =
  | "start"
  | "keyPackagesPut"
  | "createRouted"
  | "wipeDone"
  | "reconcileDone"
  | "intentAccepted"
  | "welcomeAdopted"
  | "keysInstalled"
  | "enableBegin"
  | "e2eeEnabled"
  | "modeE2ee"
  | "joinRequestSeen"
  | "staggerFired"
  | "claimDone"
  | "commitWon"
  | "removeWon"
  | "addWon";

export interface JoinStampEntry {
  name: JoinStamp;
  /** Milliseconds since the first stamp (which is therefore always 0). */
  ms: number;
}

export interface JoinTimelineSummary {
  role: JoinRole;
  /** In stamp order, ms rounded to 0.1. */
  stamps: JoinStampEntry[];
  /** Last stamp minus first; 0 with one stamp or none. */
  totalMs: number;
}

/** Round to a tenth of a millisecond: enough for a readout, no float noise. */
function roundTenth(ms: number): number {
  return Math.round(ms * 10) / 10;
}

export class JoinTimeline {
  readonly #role: JoinRole;
  readonly #now: () => number;
  #t0: number | null = null;
  #stamps: JoinStampEntry[] = [];

  constructor(role: JoinRole, now: () => number = () => performance.now()) {
    this.#role = role;
    this.#now = now;
  }

  /**
   * Record that `name` was reached now. The first stamp fixes t0; a name
   * already on the timeline is left untouched.
   */
  stamp(name: JoinStamp): void {
    if (this.#stamps.some((entry) => entry.name === name)) return;
    const at = this.#now();
    if (this.#t0 === null) this.#t0 = at;
    this.#stamps.push({ name, ms: at - this.#t0 });
  }

  /** Unrounded ms of `name` relative to t0, or null if it was never taken. */
  elapsedTo(name: JoinStamp): number | null {
    const entry = this.#stamps.find((candidate) => candidate.name === name);
    return entry ? entry.ms : null;
  }

  /** Forget every stamp; the next `stamp()` starts a new t0. */
  restart(): void {
    this.#t0 = null;
    this.#stamps = [];
  }

  /**
   * A snapshot for the log line and `metrics()`. Fresh object each call: the
   * array and its entries are copies, so a caller keeping one across a
   * `restart()` (or mutating it) cannot disturb the recorder.
   */
  summary(): JoinTimelineSummary {
    const stamps = this.#stamps.map((entry) => ({
      name: entry.name,
      ms: roundTenth(entry.ms),
    }));
    const totalMs =
      stamps.length > 1
        ? roundTenth(stamps[stamps.length - 1].ms - stamps[0].ms)
        : 0;
    return { role: this.#role, stamps, totalMs };
  }
}
