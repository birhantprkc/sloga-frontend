// Unit spec for the local-user identity wiring — run with Node's built-in
// runner:
//   node --conditions=browser --test components/rtc/localUserIdentity.test.ts
//
// `--conditions=browser` IS REQUIRED and is not a style choice. Node
// otherwise resolves solid-js to its SERVER build, where `createEffect` is
// a deliberate no-op — so every test here goes red for a reason that has
// nothing to do with the code under test. If these fail, check the flag
// before you touch the product.
//
// This exists because of a slice-5 finding: `rc_set_local_user` was never
// called on a cold start, so every give-control attempt for the life of the
// process failed closed with "control session identity does not match this
// device's account", and no surface said so. The cause was a reactivity
// miss — the effect read `client.user?.id`, which is a PLAIN FIELD and
// therefore tracks nothing, so the one run that happened saw `undefined`
// and nothing ever re-ran it.
//
// Nothing in the tree could see it. `tsc` is happy either way, and the
// two-instance harness calls `e2ee_rc_set_local_user` itself as its first
// step — a scripted end-to-end run sets by hand precisely the thing the
// product forgot to set, so it cannot fail this way by construction. The
// first test below is the regression, and it fails against the old code.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createRoot, createSignal } from "solid-js";

import { watchLocalUserId } from "./localUserIdentity.ts";

/** Effects are queued, not synchronous — let Solid flush before asserting. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A stand-in for the client, shaped like the real one in the way that
 * matters: `ready` is reactive, `user` is a plain field that is absent
 * until the Ready packet lands.
 */
function fakeClient(userId?: string) {
  const [ready, setReady] = createSignal(false);
  const client: {
    ready: () => boolean;
    user?: { id: string };
  } = { ready };
  return {
    client,
    setReady,
    hydrate(id: string) {
      // Assignment order matches `events/v1.ts`: `user` first, inside the
      // Ready batch, and only then does `ready` flip.
      client.user = { id };
      setReady(true);
    },
    ...(userId ? { userId } : {}),
  };
}

test("a cold start still sets the id once the client hydrates", async () => {
  await createRoot(async (dispose) => {
    const seen: string[] = [];
    const fake = fakeClient();

    // The cold-start shape: the client OBJECT exists from the first run,
    // so a `if (!client) return` guard passes, but `user` is not there yet.
    watchLocalUserId(
      () => fake.client,
      (id) => seen.push(id),
    );
    await flush();
    assert.deepEqual(seen, [], "nothing to send before the Ready packet");

    fake.hydrate("01ABCDEF");
    await flush();
    assert.deepEqual(
      seen,
      ["01ABCDEF"],
      "the id must be sent once the session hydrates — this is the bug",
    );

    dispose();
  });
});

test("a reconnect re-asserts the identity rather than assuming native kept it", async () => {
  await createRoot(async (dispose) => {
    const seen: string[] = [];
    const fake = fakeClient();
    watchLocalUserId(
      () => fake.client,
      (id) => seen.push(id),
    );
    fake.hydrate("01ABCDEF");
    await flush();

    // `Client.connect()` sets ready false, then the next Ready sets it true.
    fake.setReady(false);
    await flush();
    fake.setReady(true);
    await flush();

    assert.deepEqual(seen, ["01ABCDEF", "01ABCDEF"]);
    dispose();
  });
});

test("nothing is sent while the client is absent or unready", async () => {
  await createRoot(async (dispose) => {
    const seen: string[] = [];
    const [client, setClient] = createSignal<
      { ready: () => boolean; user?: { id: string } } | undefined
    >(undefined);

    watchLocalUserId(client, (id) => seen.push(id));
    await flush();
    assert.deepEqual(seen, [], "no client at all");

    // Ready, but no user — must not send an empty id. Fails closed at
    // native either way, but a wrong value is worse than no value.
    setClient({ ready: () => true });
    await flush();
    assert.deepEqual(seen, [], "ready but not hydrated");

    dispose();
  });
});
