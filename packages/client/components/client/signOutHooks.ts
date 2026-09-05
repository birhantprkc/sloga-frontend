/**
 * Sign-out hook registry for the client lifecycle.
 *
 * Kept free of solid-js and stoat.js so the ordering and failure semantics
 * can be pinned under `node --test`: every hook runs exactly once per
 * sign-out in registration order, a hook that throws does not stop the
 * others (and is reported, never swallowed), a hook may unsubscribe — itself
 * or a peer — while the batch is running, and a hook added mid-run belongs
 * to the NEXT sign-out.
 */
export type SignOutHook = () => void;

export interface SignOutHooks {
  /**
   * Register a hook. Returns its unsubscribe; registering the same function
   * twice keeps a single entry.
   */
  add(hook: SignOutHook): () => void;
  /**
   * Run every registered hook once, in registration order. A throw is
   * handed to `report` and the run continues.
   */
  run(report: (hook: SignOutHook, error: unknown) => void): void;
  /** Number of registered hooks. */
  readonly size: number;
}

export function createSignOutHooks(): SignOutHooks {
  const hooks = new Set<SignOutHook>();
  return {
    add(hook) {
      hooks.add(hook);
      return () => {
        hooks.delete(hook);
      };
    },
    run(report) {
      // Snapshot first: unsubscribing during iteration must not perturb it,
      // and an addition mid-run is deferred to the next batch. A hook that a
      // peer removed earlier in this run is skipped, not called.
      for (const hook of [...hooks]) {
        if (!hooks.has(hook)) continue;
        try {
          hook();
        } catch (error) {
          report(hook, error);
        }
      }
    },
    get size() {
      return hooks.size;
    },
  };
}
