// Unit spec for the sign-out hook registry — run with Node's built-in runner:
//   node --test components/client/signOutHooks.test.ts   (Node >=23.6 strips types)
// Focus: the semantics the lifecycle relies on when it fires these before a
// logout tears the client down — every hook runs once, a failure is reported
// and never blocks the rest, and unsubscribing mid-run is safe.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createSignOutHooks } from "./signOutHooks.ts";

const noReport = () => {
  assert.fail("report must not be called");
};

test("runs every hook once, in registration order", () => {
  const hooks = createSignOutHooks();
  const order: string[] = [];
  hooks.add(() => order.push("a"));
  hooks.add(() => order.push("b"));
  hooks.add(() => order.push("c"));

  hooks.run(noReport);

  assert.deepEqual(order, ["a", "b", "c"]);
  assert.equal(hooks.size, 3, "a run does not consume the hooks");
});

test("running with nothing registered is a no-op", () => {
  const hooks = createSignOutHooks();
  hooks.run(noReport);
  assert.equal(hooks.size, 0);
});

test("unsubscribe removes the hook; repeating it is harmless", () => {
  const hooks = createSignOutHooks();
  let calls = 0;
  const off = hooks.add(() => calls++);
  off();
  off();

  hooks.run(noReport);

  assert.equal(calls, 0);
  assert.equal(hooks.size, 0);
});

test("registering the same function twice keeps one entry", () => {
  const hooks = createSignOutHooks();
  let calls = 0;
  const hook = () => calls++;
  hooks.add(hook);
  const offAgain = hooks.add(hook);

  hooks.run(noReport);
  assert.equal(calls, 1);

  // Either unsubscribe handle clears the single entry.
  offAgain();
  hooks.run(noReport);
  assert.equal(calls, 1);
});

test("a hook that throws is reported and the rest still run", () => {
  const hooks = createSignOutHooks();
  const seen: string[] = [];
  const boom = new Error("teardown failed");
  const thrower = () => {
    throw boom;
  };
  hooks.add(() => seen.push("first"));
  hooks.add(thrower);
  hooks.add(() => seen.push("last"));

  const reported: [unknown, unknown][] = [];
  hooks.run((hook, error) => reported.push([hook, error]));

  assert.deepEqual(seen, ["first", "last"]);
  assert.deepEqual(reported, [[thrower, boom]]);
});

test("a hook may unsubscribe itself mid-run and is gone next time", () => {
  const hooks = createSignOutHooks();
  let calls = 0;
  const off = hooks.add(() => {
    calls++;
    off();
  });

  hooks.run(noReport);
  hooks.run(noReport);

  assert.equal(calls, 1);
  assert.equal(hooks.size, 0);
});

test("a hook removed by an earlier hook in the same run is skipped", () => {
  const hooks = createSignOutHooks();
  let victimCalls = 0;
  let offVictim = () => {};
  // Registered first, so it runs first and pulls the victim before its turn.
  hooks.add(() => offVictim());
  offVictim = hooks.add(() => victimCalls++);

  hooks.run(noReport);

  assert.equal(victimCalls, 0);
  assert.equal(hooks.size, 1);
});

test("a hook added during a run waits for the next run", () => {
  const hooks = createSignOutHooks();
  let lateCalls = 0;
  hooks.add(() => {
    hooks.add(() => lateCalls++);
  });

  hooks.run(noReport);
  assert.equal(lateCalls, 0, "not part of the batch that registered it");

  hooks.run(noReport);
  assert.equal(lateCalls, 1);
});
