/**
 * Voice node selection.
 *
 * The API advertises every public LiveKit node in `features.livekit.nodes`
 * (name + signaling URL + coordinates). Until now the client hard-coded
 * `"worldwide"` — the NJ node — so a caller in São Paulo paid ~130 ms each
 * way to the SFU even once a Brazilian node existed.
 *
 * Selection is by measured latency, not by geography: the coordinates the
 * server publishes would need the user's location, and a bad transit route
 * can make the "nearer" node the slower one. Each node's LiveKit health
 * endpoint (`GET /` → `OK`, CORS-open, no auth) is fetched twice and the
 * faster sample kept, so the first request's TLS handshake does not decide
 * the result. The lowest wins.
 *
 * The server pins a channel's room to whichever node the FIRST joiner named
 * (`join_call` ignores the node once a room exists), so this only matters
 * for the opener; later joiners are routed to the pinned node regardless.
 *
 * Fail-safe: any probe error, an empty list, or all probes timing out falls
 * back to {@link DEFAULT_VOICE_NODE} — the behaviour before this existed —
 * so a broken or unreachable node can never block joining a call.
 */
import type { Channel, Client } from "stoat.js";

/** The node the client used before selection existed. */
export const DEFAULT_VOICE_NODE = "worldwide";

/** Per-probe ceiling; a node slower than this is not worth choosing anyway. */
export const PROBE_TIMEOUT_MS = 2500;

/** A pick is reused for this long so every join does not re-probe. */
export const PICK_TTL_MS = 10 * 60_000;

export interface VoiceNodeInfo {
  name: string;
  public_url: string;
  lat?: number;
  lon?: number;
}

export interface ProbeOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Samples per node; the fastest is kept. */
  samples?: number;
}

/**
 * LiveKit signaling URL → its HTTP health URL.
 * `wss://br1.sloga.gg` → `https://br1.sloga.gg/`,
 * `wss://app.sloga.gg/livekit` → `https://app.sloga.gg/livekit/`.
 */
export function healthUrl(publicUrl: string): string {
  const url = new URL(publicUrl);
  url.protocol = url.protocol === "ws:" ? "http:" : "https:";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/**
 * Round-trip time to a node's health endpoint in ms, or `Infinity` when it
 * did not answer 2xx within the timeout.
 */
export async function probeNode(
  node: VoiceNodeInfo,
  opts: ProbeOptions = {},
): Promise<number> {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const samples = Math.max(1, opts.samples ?? 2);
  let url: string;
  try {
    url = healthUrl(node.public_url);
  } catch {
    return Infinity;
  }

  let best = Infinity;
  for (let i = 0; i < samples; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = performance.now();
    try {
      const res = await fetchImpl(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!res.ok) return Infinity;
      best = Math.min(best, performance.now() - started);
    } catch {
      // aborted, blocked by CSP, DNS failure — this node is not usable from
      // here, whatever the reason.
      return Infinity;
    } finally {
      clearTimeout(timer);
    }
  }
  return best;
}

/**
 * Name of the lowest-latency node, probing all of them concurrently.
 * Falls back to {@link DEFAULT_VOICE_NODE} when nothing answers.
 */
export async function pickVoiceNode(
  nodes: readonly VoiceNodeInfo[],
  opts: ProbeOptions = {},
): Promise<string> {
  if (nodes.length === 0) return DEFAULT_VOICE_NODE;
  if (nodes.length === 1) return nodes[0].name;

  const latencies = await Promise.all(
    nodes.map((node) => probeNode(node, opts)),
  );
  let bestIndex = -1;
  for (let i = 0; i < latencies.length; i++) {
    if (latencies[i] < (bestIndex === -1 ? Infinity : latencies[bestIndex])) {
      bestIndex = i;
    }
  }
  return bestIndex === -1 ? DEFAULT_VOICE_NODE : nodes[bestIndex].name;
}

let cached: { node: string; at: number } | undefined;

/** Drop the cached pick (tests; a network change could call this too). */
export function resetVoiceNodeCache(): void {
  cached = undefined;
}

/** The advertised node list, as the API root published it. */
export function advertisedVoiceNodes(client: Client): VoiceNodeInfo[] {
  return (client.configuration?.features?.livekit?.nodes ??
    []) as VoiceNodeInfo[];
}

/**
 * A server's configured voice region, if it names a node the API currently
 * advertises. A region naming a node that has since been retired (or a
 * DM/group channel, which has no server) yields `undefined` so the caller
 * falls back to the latency pick instead of naming a node that no longer
 * exists — the backend applies the same rule on its side.
 */
export function serverVoiceRegion(
  channel: Pick<Channel, "server">,
  nodes: readonly VoiceNodeInfo[],
): string | undefined {
  const region = channel.server?.voiceRegion;
  if (!region) return undefined;
  return nodes.some((node) => node.name === region) ? region : undefined;
}

/**
 * The node to name in `join_call` for THIS channel: the owning server's
 * voice region when one is set (Server Settings → Overview → Voice region),
 * otherwise the cached lowest-latency pick. Only decisive for a room's first
 * joiner — the server pins a channel to the node that opened it.
 */
export async function voiceNodeForChannel(
  client: Client,
  channel: Pick<Channel, "server">,
  opts: ProbeOptions & { now?: () => number } = {},
): Promise<string> {
  return (
    serverVoiceRegion(channel, advertisedVoiceNodes(client)) ??
    (await selectVoiceNode(client, opts))
  );
}

/**
 * The node to name in `join_call` for this client, cached for
 * {@link PICK_TTL_MS}. Reads the node list the API root advertised.
 */
export async function selectVoiceNode(
  client: Client,
  opts: ProbeOptions & { now?: () => number } = {},
): Promise<string> {
  const now = opts.now ?? Date.now;
  if (cached && now() - cached.at < PICK_TTL_MS) return cached.node;

  const nodes = advertisedVoiceNodes(client);
  let node = DEFAULT_VOICE_NODE;
  try {
    node = await pickVoiceNode(nodes, opts);
  } catch {
    node = DEFAULT_VOICE_NODE;
  }
  cached = { node, at: now() };
  return node;
}
