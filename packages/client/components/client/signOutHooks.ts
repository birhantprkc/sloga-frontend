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

/**
 * The lifecycle transitions that matter to sign-out, reduced to what this
 * module can see without importing the controller.
 */
export type SessionTransition =
  | { kind: "logout" }
  | { kind: "permanent-failure"; error: string }
  | { kind: "dismiss"; fromErrorState: boolean }
  | { kind: "other" };

/**
 * Whether a transition ends the session, so the sign-out hooks must run.
 *
 * - An explicit logout always does.
 * - A permanent failure does only when the server said the session is gone
 *   (`InvalidSession`: revoked from another device, or the account signed out
 *   everywhere). Other permanent errors can be a server hiccup, and hanging
 *   up a healthy call over one would be worse than the bug this closes.
 * - Dismissing the error screen does, whatever the error was: it disposes the
 *   client and lands on the login page, so nothing may outlive it.
 *
 * Before this, only the explicit logout fired the hooks, so a session revoked
 * remotely left its call running under the error screen and after it.
 */
export function transitionEndsSession(transition: SessionTransition): boolean {
  switch (transition.kind) {
    case "logout":
      return true;
    case "permanent-failure":
      return transition.error === "InvalidSession";
    case "dismiss":
      return transition.fromErrorState;
    case "other":
      return false;
  }
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
