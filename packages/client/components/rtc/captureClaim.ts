/**
 * The one place the `recording` voice-state claim is ever mutated.
 *
 * Two features capture a call locally — the audio recorder and (next) the
 * on-device transcriber — and both are disclosed to the room through the SAME
 * server flag. That flag is the entire disclosure mechanism: it rides on voice
 * state, so anyone who joins mid-call learns about the capture from the roster
 * read they already do. Getting it wrong is not a cosmetic bug; a cleared flag
 * with capture still running is precisely the undisclosed recording the whole
 * feature exists to prevent.
 *
 * Sharing one flag between two independently-started, independently-stopped
 * captures creates four races that a raw `PUT`/`DELETE` per call site cannot
 * survive. Each rule below closes one:
 *
 * 1. **Refcounted by kind.** The flag goes up on the first capture and comes
 *    down only when the last one ends. Without this, starting the recorder
 *    while transcribing and having the recorder *fail to start* would retract
 *    the claim — clearing everyone's banner while the transcriber keeps
 *    reading decrypted audio.
 * 2. **A failed claim never counts.** If the `PUT` is rejected (no permission,
 *    network), the kind is not marked held, so a later release cannot send a
 *    `DELETE` for a flag that was never raised.
 * 3. **Serialised.** Every mutation runs on one promise chain. Stopping one
 *    capture and starting the other in the same breath otherwise puts a
 *    `DELETE` and a `PUT` in flight together, and whichever the server handles
 *    last wins — a coin flip that can leave the flag down mid-capture.
 * 4. **Generation-checked.** Callers capture {@link generation} before their
 *    first `await` and pass it back. A capture that takes seconds to become
 *    ready (a transcription model download) can outlive the call it was
 *    started in; without the token it would raise a flag on a channel the user
 *    has already left, or on the next call entirely.
 *
 * The claim deliberately holds no opinion about *what* is capturing — it takes
 * a `mutate` callback and a kind. It owns no reactivity and no network code,
 * which is what makes its race matrix testable in isolation.
 */

/** A local capture that must be disclosed. Both raise the same server flag. */
export type CaptureKind = "recording" | "transcription";

/**
 * Sends the claim to the server. Resolves when it is accepted; rejects with a
 * user-facing message otherwise.
 */
export type ClaimMutator = (
  channelId: string,
  claimed: boolean,
) => Promise<void>;

export class CaptureClaim {
  #mutate: ClaimMutator;

  /**
   * Which captures are running, as far as the server has been told. A set
   * rather than a counter: acquiring twice for one kind is then naturally a
   * no-op, and — more importantly — so is releasing twice, which happens for
   * real because a capture can be stopped by the user, by its own error
   * handler, and by call teardown, in any order.
   */
  #held = new Set<CaptureKind>();

  /** Serialises mutations; see rule 3. Never rejects (see {@link #enqueue}). */
  #chain: Promise<unknown> = Promise.resolve();

  #generation = 0;

  constructor(mutate: ClaimMutator) {
    this.#mutate = mutate;
  }

  /**
   * The current call's token. Read it before the first `await` of a start or
   * stop sequence and pass it to {@link acquire}/{@link release}; those calls
   * become silent no-ops once the call it belongs to has ended.
   */
  get generation(): number {
    return this.#generation;
  }

  /** Whether this kind is currently disclosed. */
  holds(kind: CaptureKind): boolean {
    return this.#held.has(kind);
  }

  /** Whether the flag is raised for anything at all. */
  get claimed(): boolean {
    return this.#held.size > 0;
  }

  /**
   * Disclose a capture, raising the flag if it is not already up.
   *
   * Resolves `true` when the capture is disclosed and may begin. Resolves
   * `false` when the call ended while this was in flight — the caller must
   * abort silently and start nothing. Rejects if the server refused, in which
   * case nothing was claimed and nothing may be captured.
   *
   * **Callers must not start capturing before this resolves true.** Disclosure
   * precedes capture, always.
   */
  acquire(
    kind: CaptureKind,
    channelId: string,
    generation: number,
  ): Promise<boolean> {
    return this.#enqueue(async () => {
      if (generation !== this.#generation) return false;
      if (this.#held.has(kind)) return true;

      // Only the first capture talks to the server; the second rides the flag
      // the first one raised.
      if (this.#held.size === 0) {
        await this.#mutate(channelId, true);

        // The call can end while the claim is in flight. Do not record the
        // kind as held: leaving the call clears the flag server-side with the
        // rest of the voice state, so there is nothing to retract, and marking
        // it held would strand a phantom refcount into the next call.
        if (generation !== this.#generation) return false;
      }

      this.#held.add(kind);
      return true;
    });
  }

  /**
   * End a capture's disclosure, lowering the flag only when it was the last
   * one. Rejects if the server refused to clear it — callers generally log and
   * carry on, because leaving the call clears it anyway and a failed retraction
   * only ever over-warns.
   */
  release(
    kind: CaptureKind,
    channelId: string,
    generation: number,
  ): Promise<void> {
    return this.#enqueue(async () => {
      if (!this.#held.has(kind)) return;
      this.#held.delete(kind);

      // Someone else is still capturing: the flag stays up, and this is the
      // whole point of the refcount.
      if (this.#held.size > 0) return;

      // The call is gone (or going). Voice-state teardown clears the flag
      // server-side and the channel may already be unreachable, so a DELETE
      // here is at best redundant and at worst an error in the console.
      if (generation !== this.#generation) return;

      await this.#mutate(channelId, false);
    });
  }

  /**
   * Forget everything, because the call ended.
   *
   * **Synchronous on purpose.** `disconnect()` may not await — it is called
   * un-awaited by `connect()`, which then bumps its own supersession token, so
   * anything asynchronous here would let the next call begin mid-teardown.
   * Bumping the generation is what makes every in-flight mutation stand down
   * when it wakes up.
   */
  reset(): void {
    this.#held.clear();
    this.#generation++;
  }

  #enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(op);
    // The stored chain swallows failures so one rejected claim cannot poison
    // every later mutation; the caller still sees the real rejection via `run`.
    this.#chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
