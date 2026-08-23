// node --experimental-strip-types --conditions=browser --test components/rtc/voiceNode.test.ts
//
// The picker's whole job is a fail-safe decision: choose the fastest node,
// and never let a dead or slow node stop a join. These specs pin both halves
// with an injected fetch — no network, deterministic timing.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type VoiceNodeInfo,
  DEFAULT_VOICE_NODE,
  healthUrl,
  pickVoiceNode,
  probeNode,
  resetVoiceNodeCache,
  selectVoiceNode,
  serverVoiceRegion,
  voiceNodeForChannel,
} from "./voiceNode.ts";

const NJ: VoiceNodeInfo = {
  name: "worldwide",
  public_url: "wss://app.sloga.gg/livekit",
};
const BR: VoiceNodeInfo = { name: "brazil", public_url: "wss://br1.sloga.gg" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A fetch whose latency (or failure) is keyed by URL. */
function fakeFetch(table: Record<string, number | "fail" | "hang" | "500">) {
  const calls: string[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const plan = table[url];
    if (plan === undefined) throw new Error(`unexpected probe ${url}`);
    if (plan === "fail") throw new TypeError("Failed to fetch");
    if (plan === "hang") {
      await new Promise<void>((_, reject) =>
        init?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        ),
      );
    }
    if (plan === "500") return new Response("nope", { status: 500 });
    await sleep(plan as number);
    return new Response("OK", { status: 200 });
  }) as typeof fetch;
  return { impl, calls };
}

test("healthUrl maps signaling URLs onto the LiveKit health endpoint", () => {
  assert.equal(healthUrl("wss://br1.sloga.gg"), "https://br1.sloga.gg/");
  assert.equal(
    healthUrl("wss://app.sloga.gg/livekit"),
    "https://app.sloga.gg/livekit/",
  );
  assert.equal(healthUrl("ws://localhost:7880"), "http://localhost:7880/");
  assert.equal(healthUrl("wss://x.example/a/?q=1#f"), "https://x.example/a/");
});

test("pickVoiceNode chooses the lowest-latency node", async () => {
  const { impl, calls } = fakeFetch({
    "https://app.sloga.gg/livekit/": 60,
    "https://br1.sloga.gg/": 5,
  });
  assert.equal(
    await pickVoiceNode([NJ, BR], { fetch: impl, samples: 2 }),
    "brazil",
  );
  // Both nodes probed, twice each, concurrently.
  assert.equal(calls.filter((c) => c.includes("br1")).length, 2);
  assert.equal(calls.filter((c) => c.includes("app.sloga")).length, 2);
});

test("a node that fails, hangs, or errors is never chosen", async () => {
  const failing = fakeFetch({
    "https://app.sloga.gg/livekit/": 40,
    "https://br1.sloga.gg/": "fail",
  });
  assert.equal(
    await pickVoiceNode([NJ, BR], { fetch: failing.impl }),
    "worldwide",
  );

  const hanging = fakeFetch({
    "https://app.sloga.gg/livekit/": 40,
    "https://br1.sloga.gg/": "hang",
  });
  assert.equal(
    await pickVoiceNode([NJ, BR], { fetch: hanging.impl, timeoutMs: 50 }),
    "worldwide",
  );

  const erroring = fakeFetch({
    "https://app.sloga.gg/livekit/": "500",
    "https://br1.sloga.gg/": 5,
  });
  assert.equal(
    await pickVoiceNode([NJ, BR], { fetch: erroring.impl }),
    "brazil",
  );
});

test("nothing reachable falls back to the default node", async () => {
  const { impl } = fakeFetch({
    "https://app.sloga.gg/livekit/": "fail",
    "https://br1.sloga.gg/": "fail",
  });
  assert.equal(
    await pickVoiceNode([NJ, BR], { fetch: impl }),
    DEFAULT_VOICE_NODE,
  );
  assert.equal(await pickVoiceNode([], { fetch: impl }), DEFAULT_VOICE_NODE);
});

test("a single advertised node is used without probing", async () => {
  const { impl, calls } = fakeFetch({});
  assert.equal(await pickVoiceNode([BR], { fetch: impl }), "brazil");
  assert.equal(calls.length, 0);
});

test("probeNode keeps the fastest of its samples", async () => {
  let n = 0;
  const impl = (async () => {
    n++;
    await sleep(n === 1 ? 80 : 5); // first sample pays the handshake
    return new Response("OK");
  }) as typeof fetch;
  const rtt = await probeNode(BR, { fetch: impl, samples: 2 });
  assert.ok(rtt < 60, `expected the fast sample, got ${rtt}`);
});

test("selectVoiceNode reads the API node list and caches the pick", async () => {
  resetVoiceNodeCache();
  const { impl, calls } = fakeFetch({
    "https://app.sloga.gg/livekit/": 60,
    "https://br1.sloga.gg/": 5,
  });
  const client = {
    configuration: {
      features: { livekit: { enabled: true, nodes: [NJ, BR] } },
    },
  } as never;
  let clock = 1_000;
  const now = () => clock;

  assert.equal(await selectVoiceNode(client, { fetch: impl, now }), "brazil");
  const probes = calls.length;
  clock += 60_000;
  assert.equal(await selectVoiceNode(client, { fetch: impl, now }), "brazil");
  assert.equal(calls.length, probes, "a fresh pick must not re-probe");

  clock += 11 * 60_000;
  await selectVoiceNode(client, { fetch: impl, now });
  assert.ok(calls.length > probes, "an expired pick re-probes");
});

test("selectVoiceNode without a configuration uses the default", async () => {
  resetVoiceNodeCache();
  const { impl } = fakeFetch({});
  assert.equal(
    await selectVoiceNode({ configuration: undefined } as never, {
      fetch: impl,
    }),
    DEFAULT_VOICE_NODE,
  );
});

test("serverVoiceRegion only honours a region the API still advertises", () => {
  const withServer = (voiceRegion?: string) =>
    ({ server: { voiceRegion } }) as never;
  assert.equal(serverVoiceRegion(withServer("brazil"), [NJ, BR]), "brazil");
  assert.equal(
    serverVoiceRegion(withServer("worldwide"), [NJ, BR]),
    "worldwide",
  );
  // Auto
  assert.equal(serverVoiceRegion(withServer(undefined), [NJ, BR]), undefined);
  // a retired node name must not be sent — the latency pick takes over
  assert.equal(serverVoiceRegion(withServer("moon"), [NJ, BR]), undefined);
  // DM / group: no server at all
  assert.equal(
    serverVoiceRegion({ server: undefined } as never, [NJ, BR]),
    undefined,
  );
});

test("voiceNodeForChannel prefers the server region and never probes for it", async () => {
  resetVoiceNodeCache();
  const { impl, calls } = fakeFetch({
    "https://app.sloga.gg/livekit/": 5,
    "https://br1.sloga.gg/": 60,
  });
  const client = {
    configuration: {
      features: { livekit: { enabled: true, nodes: [NJ, BR] } },
    },
  } as never;

  // region set: the (slower) Brazilian node is named without a single probe
  const pinned = { server: { voiceRegion: "brazil" } } as never;
  assert.equal(
    await voiceNodeForChannel(client, pinned, { fetch: impl }),
    "brazil",
  );
  assert.equal(calls.length, 0);

  // Auto: falls through to the latency pick
  const auto = { server: { voiceRegion: undefined } } as never;
  assert.equal(
    await voiceNodeForChannel(client, auto, { fetch: impl }),
    "worldwide",
  );
  assert.ok(calls.length > 0, "the auto path must probe");

  // a region the API no longer advertises also falls through (cached pick)
  const stale = { server: { voiceRegion: "moon" } } as never;
  assert.equal(
    await voiceNodeForChannel(client, stale, { fetch: impl }),
    "worldwide",
  );
});
