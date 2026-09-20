/**
 * Renderer spec for the Windows native screen-share audio module. Run with:
 *
 *     node --test --conditions=browser components/rtc/screenAudioNativeWin.test.ts
 *
 * (`--conditions=browser` is the house rule for this repo's tests. Nothing here
 * reaches solid-js, but one invocation should cover this file and the reactive
 * suites together.)
 *
 * `screenAudioWire.test.ts` covers the pure wire half. This file covers the
 * half that owns MODULE STATE: the capability split, §3.6.3's transition
 * table, the generation filters, the start-window latch, the publish gate and
 * the bounded teardown. Every one of those is a decision that fails SILENTLY
 * when it regresses — a suppressed checkbox that comes back, a death that
 * kills the wrong share, a teardown that never reaches step 4 — which is why
 * they are specced rather than argued about in comments.
 *
 * ---------------------------------------------------------------------------
 * HOW THIS FILE LOADS A MODULE NODE CANNOT OTHERWISE LOAD
 * ---------------------------------------------------------------------------
 *
 * `screenAudioNativeWin.ts` is written for Vite, and three things about that
 * are invisible to Node. Each is bridged by a `registerHooks` hook, the same
 * mechanism `mlsCallSession.harness.ts` already uses for the third of them:
 *
 *  1. `@revolt/common` is a tsconfig path alias with no `node_modules` entry,
 *     so Node cannot resolve it at all. It is resolved here to a `data:` module
 *     that re-exports the two bindings this module imports — `CONFIGURATION`
 *     (through a Proxy, so the build flag is a live knob) and `tauriInvoke`
 *     (a faithful copy of the real five-line body, which reads
 *     `window.__TAURI__.core.invoke`, so "is there a bridge" stays a property
 *     of the window double rather than of the fake).
 *  2. Relative specifiers are extensionless (`./screenAudioWire`).
 *  3. `import.meta.env.BASE_URL` is a Vite `define`, and in Node
 *     `import.meta.env` is undefined — so `workletUrl()` would throw a
 *     TypeError INSIDE `captureScreenAudio`'s try block and every graph build
 *     would report `{ kind: "graph" }` for a reason that does not exist in
 *     production.
 *
 * 🔴 The third hook is the only one that touches the module's own text, so it
 * is written to be incapable of a silent no-op: it APPENDS a shim line and
 * changes not one character of the original source, and it first asserts that
 * `import.meta.env.BASE_URL` occurs EXACTLY ONCE. If that occurrence ever moves
 * or multiplies, this file throws at load rather than quietly specifying a
 * module that no longer matches the one that ships.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT COVERED HERE, AND WHY
 * ---------------------------------------------------------------------------
 *
 *  - Loops 7 and 8 (the watchdogs). They are driven by `performance.now()`
 *    deltas across a `MessageChannel` quiescence barrier; the DECISION is
 *    `evaluateLiveness`, which `screenAudioWire.test.ts` already tables. What
 *    is left here is the stamping, which needs a fake `performance.now` fused
 *    to the fake clock — reachable, but it is not one of the six this lane
 *    owes, so it is named rather than half-covered.
 *  - `deathFailure` is module-private, so it is specced THROUGH the only
 *    surface that can observe it: the `ScreenAudioFailure` handed to
 *    `host.report`.
 */
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { type TestContext } from "node:test";

import {
  FLAG_GATED,
  FLAG_SENTINEL,
  FLAG_SYNTHETIC,
  HEADER_BYTES,
  WIRE_VERSION,
} from "./screenAudioWire.ts";

import type * as ScreenAudioWin from "./screenAudioNativeWin.ts";

type Mod = typeof ScreenAudioWin;
type Failure = ScreenAudioWin.ScreenAudioFailure;

// ---------------------------------------------------------------------------
// The loader bridge
// ---------------------------------------------------------------------------

/** The knobs the `data:` stand-in for `@revolt/common` reads at call time. */
interface SpecEnv {
  CONFIGURATION: { ENABLE_WIN_NATIVE_SCREEN_AUDIO: boolean };
  BASE_URL: string;
}

const specEnv: SpecEnv = {
  CONFIGURATION: { ENABLE_WIN_NATIVE_SCREEN_AUDIO: true },
  BASE_URL: "/",
};

const globals = globalThis as unknown as Record<string, unknown>;
globals.__screenAudioSpecEnv = specEnv;

/**
 * `tauriInvoke` here is the real body, not a stub: the shape of the check is
 * the decision the production helper documents (`__TAURI__.core.invoke` is
 * present only in a Tauri window that is allowed to talk to the shell), and a
 * stand-in that answered from a boolean would make the capability specs below
 * assert nothing about it.
 */
const FAKE_COMMON = [
  "const env = () => globalThis.__screenAudioSpecEnv;",
  "export const CONFIGURATION = new Proxy({}, {",
  "  get: (_target, key) => env().CONFIGURATION[key],",
  "});",
  "export function tauriInvoke() {",
  "  if (typeof window === 'undefined') return undefined;",
  "  return window.__TAURI__?.core?.invoke;",
  "}",
].join("\n");

const COMMON_URL = `data:text/javascript,${encodeURIComponent(FAKE_COMMON)}`;

/** The single Vite `define` this module reads. Asserted to occur exactly once. */
const VITE_DEFINE = "import.meta.env.BASE_URL";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@revolt/common") {
      return { url: COMMON_URL, shortCircuit: true };
    }
    // The module imports its siblings without extensions (Vite resolves them);
    // Node's ESM loader does not.
    if (specifier.startsWith(".") && !/\.[cm]?[jt]sx?(\?|$)/.test(specifier)) {
      try {
        return nextResolve(`${specifier}.ts`, context);
      } catch {
        // Not a `.ts` sibling — let the default resolution report it.
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (!url.includes("screenAudioNativeWin.ts")) return loaded;
    const source = String(loaded.source);
    const occurrences = source.split(VITE_DEFINE).length - 1;
    // 🔴 Fail closed. A shim that stops matching is a shim that stops
    // shimming, and the only symptom would be a `{ kind: "graph" }` report
    // that no production path can produce.
    assert.equal(
      occurrences,
      1,
      `expected exactly one ${VITE_DEFINE} in the module under test, found ${occurrences}`,
    );
    return {
      ...loaded,
      // APPENDED, so every line number in the module is unchanged and not one
      // character of its own text is rewritten.
      source: `${source}\n;import.meta.env ??= { BASE_URL: globalThis.__screenAudioSpecEnv.BASE_URL };\n`,
    };
  },
});

const MODULE_HREF = new URL("./screenAudioNativeWin.ts", import.meta.url).href;

let instanceCount = 0;

/**
 * A FRESH module instance.
 *
 * The module is a singleton — one `state`, one `session`, one probe cache, one
 * `deathListenerRegistered` flag — so a scenario that reuses an instance is
 * asserting against whatever the previous scenario left behind. A distinct
 * query string is a distinct ESM cache key, which is the cheapest honest reset.
 */
async function freshModule(): Promise<Mod> {
  instanceCount += 1;
  return (await import(`${MODULE_HREF}?spec=${instanceCount}`)) as Mod;
}

// ---------------------------------------------------------------------------
// The world: shell, audio graph, host
// ---------------------------------------------------------------------------

interface DiedPayload {
  generation: number;
  reason: string;
  code?: string;
  detail?: string;
}

interface StartResult {
  generation: number;
  format: { rate: number; channels: number; bits: number };
  timings: Record<string, number>;
}

interface PortMessage {
  type: string;
  seq?: number;
  buffer?: ArrayBuffer;
  offset?: number;
}

const FORMAT = { rate: 48_000, channels: 2, bits: 16 };
const TIMINGS = {
  tickCadenceMs: 250,
  quantaPerTick: 94,
  frameWatchdogMs: 2500,
  relayWatchdogMs: 2500,
  heartbeatQuanta: 940,
  jitterTargetMs: 100,
  frameMs: 10,
};

class SpecChannel {
  onmessage: (message: ArrayBuffer) => void = () => undefined;
  cleanupCallbackCalls = 0;
  cleanupCallback = () => {
    this.cleanupCallbackCalls += 1;
  };
}

class SpecPort {
  messages: PortMessage[] = [];
  onmessage: ((event: { data: PortMessage }) => void) | null = null;
  postMessage(message: PortMessage) {
    this.messages.push(message);
  }
}

class SpecTrack {
  stops = 0;
  stop() {
    this.stops += 1;
  }
}

class SpecDestination {
  track = new SpecTrack();
  disconnects = 0;
  stream = { getAudioTracks: () => [this.track] };
  disconnect() {
    this.disconnects += 1;
  }
}

class SpecWorkletNode {
  port = new SpecPort();
  connects = 0;
  disconnects = 0;
  readonly context: SpecAudioContext;
  readonly name: string;
  readonly options: Record<string, unknown>;
  constructor(
    context: SpecAudioContext,
    name: string,
    options: Record<string, unknown>,
  ) {
    this.context = context;
    this.name = name;
    this.options = options;
    world?.nodes.push(this);
  }
  connect() {
    this.connects += 1;
  }
  disconnect() {
    this.disconnects += 1;
  }
}

class SpecAudioContext {
  readonly sampleRate: number;
  state = "running";
  closes = 0;
  /**
   * Closes that actually CAME BACK.
   *
   * 🔴 Separate from `closes`, which counts calls. An `AudioContext.close()`
   * drives the audio engine, so it is a hang candidate on exactly the machines
   * this module's bounds exist for — and a spec that only counted calls would
   * read a permanently-wedged close as a successful one.
   */
  closesSettled = 0;
  resumes = 0;
  audioWorklet = {
    addModule: async (url: string) => {
      world?.moduleUrls.push(url);
      await world?.onAddModule?.();
    },
  };
  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    // A context born SUSPENDED is the only way to reach `resume()` — the
    // module calls it exactly when `state !== "running"`, which is the case
    // the comment there ("sticky activation is not a design guarantee") is
    // about.
    this.state = world?.contextStartState ?? "running";
    world?.contexts.push(this);
  }
  createMediaStreamDestination() {
    const destination = new SpecDestination();
    world?.destinations.push(destination);
    return destination;
  }
  async resume() {
    // The counter moves on the CALL and the hang comes after it, so a spec can
    // tell "resume was reached" from "resume came back".
    this.resumes += 1;
    if (world?.hangResume) await new Promise<void>(() => undefined);
    this.state = "running";
  }
  async close() {
    this.closes += 1;
    if (world?.hangClose) await new Promise<void>(() => undefined);
    this.state = "closed";
    this.closesSettled += 1;
  }
}

/**
 * The barrier's transport. The module deliberately uses a `MessageChannel`
 * rather than `setTimeout(…, 0)` so a minimized sharer's throttled timers
 * cannot slow it; the property this double must preserve is "a task, not a
 * timer", so it dispatches on a REAL `setImmediate` while the fake clock owns
 * `setTimeout`. It is also unref-free, so a live barrier cannot hold the
 * runner open after a test returns.
 */
class SpecMessageChannel {
  port1: {
    onmessage: ((event: { data: unknown }) => void) | null;
    start: () => void;
  } = { onmessage: null, start: () => undefined };
  port2 = {
    postMessage: (data: unknown) => {
      setImmediate(() => this.port1.onmessage?.({ data }));
    },
  };
}

interface Invocation {
  cmd: string;
  args?: Record<string, unknown>;
}

class World {
  invocations: Invocation[] = [];
  channels: SpecChannel[] = [];
  contexts: SpecAudioContext[] = [];
  destinations: SpecDestination[] = [];
  nodes: SpecWorkletNode[] = [];
  moduleUrls: string[] = [];
  reports: Failure[] = [];
  unpublishCalls = 0;

  /** Commands whose promise never settles. */
  hangs = new Set<string>();
  /** `host.unpublish()` never settles. */
  hangUnpublish = false;
  /** `AudioContext.resume()` never settles — a wedged audio engine. */
  hangResume = false;
  /** What a freshly-constructed `AudioContext` reports as its state. */
  contextStartState = "running";
  /** `AudioContext.close()` never settles — the same engine, on the way out. */
  hangClose = false;
  /** `listen()` never settles until [`releaseListen`] is called. */
  hangListen = false;
  /** How many times the module asked the shell to register a listener. */
  listenCalls = 0;
  /** `screen_audio_start` rejects with this instead of resolving. */
  startRejection: { code: string; detail: string } | undefined;
  startResult: StartResult = {
    generation: 7,
    format: FORMAT,
    timings: TIMINGS,
  };
  probeResult: unknown = { available: true, format: FORMAT, timings: TIMINGS };

  /** Run synchronously inside `screen_audio_start`, BEFORE it resolves. */
  onStart: ((channel: SpecChannel) => void) | undefined;
  /** Awaited inside `audioWorklet.addModule`. */
  onAddModule: (() => void | Promise<void>) | undefined;

  #death: ((event: { payload: DiedPayload }) => void) | undefined;

  get host(): ScreenAudioWin.ScreenAudioHost {
    return {
      unpublish: () => {
        this.unpublishCalls += 1;
        if (this.hangUnpublish) return new Promise<void>(() => undefined);
        return Promise.resolve();
      },
      report: (failure) => {
        this.reports.push(failure);
      },
    };
  }

  invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    this.invocations.push({ cmd, args });
    if (this.hangs.has(cmd)) return new Promise<T>(() => undefined);
    if (cmd === "screen_audio_probe") {
      return Promise.resolve(this.probeResult as T);
    }
    if (cmd === "screen_audio_start") {
      const channel = args?.channel as SpecChannel;
      this.onStart?.(channel);
      if (this.startRejection) return Promise.reject(this.startRejection);
      return Promise.resolve(this.startResult as T);
    }
    return Promise.resolve(undefined as T);
  };

  #listenRelease: (() => void) | undefined;

  listen = (
    name: string,
    handler: (event: { payload: DiedPayload }) => void,
  ): Promise<() => void> => {
    this.listenCalls += 1;
    if (name === "screen-audio-died") this.#death = handler;
    if (!this.hangListen) return Promise.resolve(() => undefined);
    return new Promise<() => void>((resolve) => {
      this.#listenRelease = () => resolve(() => undefined);
    });
  };

  /** Let a hanging `listen()` finally answer, the way a freed shell would. */
  releaseListen() {
    assert.ok(this.#listenRelease, "no listen() was hanging");
    this.#listenRelease();
    this.#listenRelease = undefined;
  }

  /** Emit the shell's `screen-audio-died` event. */
  emitDeath(payload: DiedPayload) {
    assert.ok(this.#death, "no died-event listener was registered");
    this.#death({ payload });
  }

  calls(cmd: string): Invocation[] {
    return this.invocations.filter((call) => call.cmd === cmd);
  }

  /** The channel the current share is forwarding on. */
  get channel(): SpecChannel {
    const channel = this.channels.at(-1);
    assert.ok(channel, "no Tauri Channel was constructed");
    return channel;
  }

  get context(): SpecAudioContext {
    const context = this.contexts.at(-1);
    assert.ok(context, "no AudioContext was constructed");
    return context;
  }

  get node(): SpecWorkletNode {
    const node = this.nodes.at(-1);
    assert.ok(node, "no AudioWorkletNode was constructed");
    return node;
  }

  get portTypes(): string[] {
    return this.node.port.messages.map((message) => message.type);
  }
}

let world: World | undefined;

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

let userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2";

const fakeWindow: Record<string, unknown> = {
  location: { origin: "https://app.example.invalid" },
};

function define(name: string, value: unknown) {
  Object.defineProperty(globalThis, name, {
    value,
    configurable: true,
    writable: true,
  });
}

define("window", fakeWindow);
define("navigator", {
  get userAgent() {
    return userAgent;
  },
});
define("AudioContext", SpecAudioContext);
define("AudioWorkletNode", SpecWorkletNode);
define("MessageChannel", SpecMessageChannel);

interface EnvOptions {
  flag?: boolean;
  windowsUserAgent?: boolean;
  bridge?: boolean;
}

/**
 * Seat the environment for one scenario and hand back its world. The world is
 * module-scope because `AudioContext` and `AudioWorkletNode` are GLOBAL
 * constructors — the module reaches them through the global, exactly as it
 * does in the shell, so the recording has to live where a global can find it.
 */
function seat(t: TestContext, options: EnvOptions = {}): World {
  const next = new World();
  world = next;
  specEnv.CONFIGURATION.ENABLE_WIN_NATIVE_SCREEN_AUDIO = options.flag ?? true;
  userAgent =
    (options.windowsUserAgent ?? true)
      ? "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2"
      : "Mozilla/5.0 (X11; Linux x86_64)";
  if (options.bridge ?? true) {
    fakeWindow.__TAURI__ = {
      core: { invoke: next.invoke, Channel: channelCtor(next) },
      event: { listen: next.listen },
    };
  } else {
    delete fakeWindow.__TAURI__;
  }
  t.after(() => {
    world = undefined;
    delete fakeWindow.__TAURI__;
    specEnv.CONFIGURATION.ENABLE_WIN_NATIVE_SCREEN_AUDIO = true;
    userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) WebView2";
  });
  return next;
}

function channelCtor(owner: World) {
  return class OwnedChannel extends SpecChannel {
    constructor() {
      super();
      owner.channels.push(this);
    }
  };
}

/** Drain every settled promise chain and every barrier task. */
async function flush(): Promise<void> {
  for (let i = 0; i < 25; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function useFakeClock(t: TestContext) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/** A frame laid out the way `frame.rs` writes one: little-endian throughout. */
function frame(
  fields: {
    flags?: number;
    generation?: number;
    seq?: bigint;
    version?: number;
  },
  totalBytes = HEADER_BYTES,
): ArrayBuffer {
  const buffer = new ArrayBuffer(totalBytes);
  const view = new DataView(buffer);
  view.setUint16(0, fields.version ?? WIRE_VERSION, true);
  view.setUint16(2, fields.flags ?? 0, true);
  view.setUint32(4, fields.generation ?? 7, true);
  view.setBigUint64(8, fields.seq ?? 0n, true);
  view.setBigUint64(16, 0n, true);
  return buffer;
}

function sentinel(generation = 7): ArrayBuffer {
  return frame({ flags: FLAG_SENTINEL, generation });
}

// ---------------------------------------------------------------------------
// Scenario drivers
// ---------------------------------------------------------------------------

/** Start a share and assert it reached `STARTING` with a track. */
async function startShare(
  mod: Mod,
  active: World,
): Promise<ScreenAudioWin.ScreenAudioCapture> {
  const capture = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });
  assert.ok(capture, "captureScreenAudio refused to start");
  assert.equal(mod.screenAudioDiagnostics()?.state, "STARTING");
  return capture;
}

/** Start a share and carry it through the publish handshake to `LIVE`. */
async function goLive(mod: Mod, active: World): Promise<void> {
  await startShare(mod, active);
  assert.equal(mod.beginScreenAudioPublish(), true);
  assert.equal(mod.finishScreenAudioPublish(), true);
  assert.equal(mod.screenAudioDiagnostics()?.state, "LIVE");
  await flush();
}

// ===========================================================================
// The pure predicates
// ===========================================================================

test("the frame geometry is the Rust side's, to the byte", async () => {
  const mod = await freshModule();
  assert.equal(mod.PAYLOAD_BYTES, 1920);
  assert.equal(mod.FRAME_BYTES, 1944);
  assert.equal(mod.FRAME_BYTES, HEADER_BYTES + mod.PAYLOAD_BYTES);
});

test("🔴 an audio frame is accepted at EXACTLY 1944 bytes and nowhere else", async () => {
  const mod = await freshModule();
  // The failure this refuses: `readHeader` validates 24 bytes and nothing
  // more, so a short frame would be forwarded to the worklet at offset 24 and
  // rendered as whatever bytes happen to follow it.
  assert.equal(mod.screenAudioFrameAcceptable(1944, 0), true);
  for (const byteLength of [0, 1, 23, 24, 900, 1920, 1943, 1945, 2048, 3888]) {
    assert.equal(
      mod.screenAudioFrameAcceptable(byteLength, 0),
      false,
      `${byteLength} bytes must be refused`,
    );
  }
});

test("a synthetic or gated frame is still held to the exact length", async () => {
  const mod = await freshModule();
  // Neither flag says "no payload" — only the sentinel does.
  assert.equal(mod.screenAudioFrameAcceptable(1944, FLAG_SYNTHETIC), true);
  assert.equal(mod.screenAudioFrameAcceptable(1944, FLAG_GATED), true);
  assert.equal(
    mod.screenAudioFrameAcceptable(1944, FLAG_SYNTHETIC | FLAG_GATED),
    true,
  );
  assert.equal(mod.screenAudioFrameAcceptable(24, FLAG_SYNTHETIC), false);
  assert.equal(mod.screenAudioFrameAcceptable(1943, FLAG_GATED), false);
});

test("a sentinel carries no payload, so it is accepted at header size and above", async () => {
  const mod = await freshModule();
  assert.equal(
    mod.screenAudioFrameAcceptable(HEADER_BYTES, FLAG_SENTINEL),
    true,
  );
  assert.equal(mod.screenAudioFrameAcceptable(1944, FLAG_SENTINEL), true);
  assert.equal(mod.screenAudioFrameAcceptable(5000, FLAG_SENTINEL), true);
  assert.equal(
    mod.screenAudioFrameAcceptable(HEADER_BYTES - 1, FLAG_SENTINEL),
    false,
  );
  assert.equal(mod.screenAudioFrameAcceptable(0, FLAG_SENTINEL), false);
});

test("the sentinel bit decides regardless of the flags beside it", async () => {
  const mod = await freshModule();
  for (const companion of [
    0,
    FLAG_SYNTHETIC,
    FLAG_GATED,
    FLAG_SYNTHETIC | FLAG_GATED,
  ]) {
    assert.equal(
      mod.screenAudioFrameAcceptable(HEADER_BYTES, FLAG_SENTINEL | companion),
      true,
      `sentinel + ${companion} at header size`,
    );
    assert.equal(
      mod.screenAudioFrameAcceptable(1943, FLAG_SENTINEL | companion),
      true,
      `sentinel + ${companion} at 1943 bytes`,
    );
  }
});

test("an unsupported-OS death is recognized by code, and by reason", async () => {
  const mod = await freshModule();
  assert.equal(mod.SCREEN_AUDIO_UNSUPPORTED, "unsupported");
  assert.equal(
    mod.screenAudioDeathIsUnsupported({ code: "unsupported" }),
    true,
  );
  assert.equal(
    mod.screenAudioDeathIsUnsupported({ reason: "unsupported" }),
    true,
  );
  assert.equal(
    mod.screenAudioDeathIsUnsupported({
      reason: "capture-error",
      code: "unsupported",
    }),
    true,
  );
});

test("🔴 detail text is NEVER matched — the old 19041 literal means nothing", async () => {
  const mod = await freshModule();
  // The literal below was the pre-build-gate diagnostic. It no longer means
  // "old OS" (a missing export now indicates a damaged system DLL), so any
  // string match on it is both dead and, if revived, wrong.
  const legacy = {
    reason: "capture-error",
    detail:
      "ActivateAudioInterfaceAsync is not exported (Windows build < 19041)",
  };
  assert.equal(mod.screenAudioDeathIsUnsupported(legacy), false);
  // Even the word itself, in the diagnostic slot, is not contract.
  const decoy = { reason: "capture-error", detail: "unsupported" };
  assert.equal(mod.screenAudioDeathIsUnsupported(decoy), false);
});

test("ordinary deaths are not unsupported-OS refusals", async () => {
  const mod = await freshModule();
  for (const reason of [
    "device-lost",
    "stopped",
    "sentinel",
    "capture-error",
    "unsupported-os",
    "Unsupported",
  ]) {
    assert.equal(
      mod.screenAudioDeathIsUnsupported({ reason }),
      false,
      `reason ${reason}`,
    );
  }
  assert.equal(mod.screenAudioDeathIsUnsupported({}), false);
  assert.equal(
    mod.screenAudioDeathIsUnsupported({ code: "Unsupported" }),
    false,
  );
});

test("the livekit E2EE flag is read by PRESENCE, not by truthiness", async () => {
  const mod = await freshModule();
  assert.equal(mod.screenAudioSenderEncrypted(undefined), false);
  const bare = {} as RTCRtpSender;
  assert.equal(mod.screenAudioSenderEncrypted(bare), false);
  const stamped = { lk_e2ee: true } as unknown as RTCRtpSender;
  assert.equal(mod.screenAudioSenderEncrypted(stamped), true);
  // livekit sets the flag with `sender[E2EE_FLAG] = true`, but the assertion
  // is `in`: a present-but-falsy flag still counts as stamped, and pinning
  // that here is what makes a future switch to truthiness visible.
  const falsy = { lk_e2ee: undefined } as unknown as RTCRtpSender;
  assert.equal(mod.screenAudioSenderEncrypted(falsy), true);
});

// ===========================================================================
// Case 1 — the suppressed/supported split
// ===========================================================================

test("🔴 the checkbox question is the 2x2x2 of flag, platform and bridge", async (t) => {
  // Evaluated with the probe UNSETTLED throughout: `screen_audio_probe` never
  // resolves, so nothing here can be answered by a probe verdict.
  const mod = await freshModule();
  for (const flag of [true, false]) {
    for (const windowsUserAgent of [true, false]) {
      for (const bridge of [true, false]) {
        const active = seat(t, { flag, windowsUserAgent, bridge });
        active.hangs.add("screen_audio_probe");
        const expected = flag && windowsUserAgent && bridge;
        assert.equal(
          mod.screenAudioPickerAudioSuppressed(),
          expected,
          `flag=${flag} windows=${windowsUserAgent} bridge=${bridge}`,
        );
        if (!expected) {
          // The short circuit: `screenAudioSupported` never reaches the probe,
          // so it answers without a timer.
          assert.equal(await mod.screenAudioSupported(), false);
        }
        assert.equal(active.calls("screen_audio_probe").length, 0);
      }
    }
  }
});

test("🔴 an UNSETTLED probe suppresses the checkbox while support answers no", async (t) => {
  // THE regression this spec exists for. Fusing the two questions means that
  // at room join — the busiest moment for both shell and renderer, and exactly
  // when the probe has not answered — the user is handed back the browser's
  // "Also share system audio" tick, and the measured-no-op `restrictOwnAudio`
  // loopback re-broadcasts every other participant's voice into the call.
  const mod = await freshModule();
  const active = seat(t);
  active.hangs.add("screen_audio_probe");
  useFakeClock(t);

  assert.equal(mod.screenAudioPickerAudioSuppressed(), true);

  let answer: boolean | undefined;
  void mod.screenAudioSupported().then((value) => {
    answer = value;
  });
  await flush();
  // Bounded, because this sits on the user-gesture path immediately before
  // `getDisplayMedia`: it has not answered yet, and it has not hung either.
  assert.equal(answer, undefined);
  t.mock.timers.tick(200);
  await flush();
  assert.equal(answer, false);

  // 🔴 The load-bearing pair: suppressed, and NOT supported.
  assert.equal(mod.screenAudioPickerAudioSuppressed(), true);
  assert.equal(active.calls("screen_audio_probe").length, 1);
});

test("a probe that answers 'not available' still suppresses the checkbox", async (t) => {
  // §9's named degrade is a SILENT share, never a loopback one.
  const mod = await freshModule();
  const active = seat(t);
  active.probeResult = { available: false, format: FORMAT, timings: TIMINGS };
  mod.primeScreenAudioProbe();
  await flush();
  assert.equal(await mod.screenAudioSupported(), false);
  assert.equal(mod.screenAudioPickerAudioSuppressed(), true);
});

test("a probe that answers 'available' makes both answers yes", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  active.probeResult = {
    available: true,
    format: FORMAT,
    timings: TIMINGS,
    exclusion: { check: "pid-tree", conclusivelyPassed: true },
  };
  mod.primeScreenAudioProbe();
  await flush();
  assert.equal(await mod.screenAudioSupported(), true);
  assert.equal(mod.screenAudioPickerAudioSuppressed(), true);
  // §11.9's verdict rides the same probe and gates lighting, never the share.
  assert.deepEqual(mod.screenAudioExclusionStatus(), {
    check: "pid-tree",
    conclusivelyPassed: true,
  });
});

test("priming is a no-op off Windows and behind a dark flag", async (t) => {
  const mod = await freshModule();
  const off = seat(t, { flag: false });
  mod.primeScreenAudioProbe();
  assert.equal(off.calls("screen_audio_probe").length, 0);
  const linux = seat(t, { windowsUserAgent: false });
  mod.primeScreenAudioProbe();
  assert.equal(linux.calls("screen_audio_probe").length, 0);
});

// ===========================================================================
// Case 2 — §3.6.3's transition table
// ===========================================================================

test("the normal path: STARTING, publish handshake, LIVE", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  const capture = await startShare(mod, active);

  assert.equal(capture.generation, 7);
  assert.equal(mod.screenAudioGeneration(), 7);
  assert.equal(mod.screenAudioActive(), true);
  // The rate is PINNED from the shell's format, never the default endpoint's.
  assert.equal(active.context.sampleRate, 48_000);
  assert.equal(active.node.name, "ScreenAudioWorklet");
  assert.deepEqual(active.node.options.outputChannelCount, [2]);
  assert.deepEqual(active.node.options.processorOptions, {
    channels: 2,
    sampleRate: 48_000,
    jitterTargetMs: TIMINGS.jitterTargetMs,
    quantaPerTick: TIMINGS.quantaPerTick,
    heartbeatQuanta: TIMINGS.heartbeatQuanta,
  });
  // Self-hosted under public/: the shell CSP is `script-src 'self'`.
  assert.equal(
    active.moduleUrls[0],
    "https://app.example.invalid/screen-audio/ScreenAudioWorklet.js",
  );

  assert.equal(mod.beginScreenAudioPublish(), true);
  assert.equal(mod.finishScreenAudioPublish(), true);
  assert.equal(mod.screenAudioDiagnostics()?.state, "LIVE");
  assert.equal(mod.screenAudioActive(), true);
  await flush();
  assert.deepEqual(active.reports, []);
});

test("🔴 a death latched during STARTING refuses the publish (=> DEAD)", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await startShare(mod, active);

  // The shell dies inside the publish window — an SDP negotiation, hundreds of
  // milliseconds and unbounded on a congested link.
  active.emitDeath({ generation: 7, reason: "device-lost" });

  assert.equal(mod.screenAudioDiagnostics()?.state, "DEAD");
  assert.equal(mod.screenAudioActive(), false);
  // Both halves of the handshake refuse, synchronously and without a suspension
  // point between them.
  assert.equal(mod.beginScreenAudioPublish(), false);
  assert.equal(mod.finishScreenAudioPublish(), false);
  assert.deepEqual(active.reports, [{ kind: "died", reason: "device-lost" }]);
  // Nothing was ever published, so nothing is unpublished.
  assert.equal(active.unpublishCalls, 0);
  // The death branch discards the worklet queue UNCONDITIONALLY.
  assert.deepEqual(active.portTypes, ["discard", "stop-ticks"]);

  await flush();
  assert.equal(active.destinations.at(-1)?.track.stops, 1);
  assert.equal(active.context.closes, 1);
  assert.deepEqual(active.calls("screen_audio_stop")[0]?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioDiagnostics(), undefined);
  assert.equal(mod.screenAudioActive(), false);
});

test("🔴 a LIVE share stops through EXPECTED_STOP, not through DEAD", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangUnpublish = true;
  let done = false;
  void mod.teardownScreenAudio().then(() => {
    done = true;
  });
  await flush();

  // Step 0 is synchronous and has no IPC: disarm, stop the ticks, release the
  // channel.
  assert.equal(mod.screenAudioDiagnostics()?.state, "EXPECTED_STOP");
  assert.equal(mod.screenAudioActive(), false);
  assert.equal(mod.beginScreenAudioPublish(), false);
  assert.equal(mod.finishScreenAudioPublish(), false);
  // An ordinary stop DRAINS its tail rather than clipping it, so no discard.
  assert.deepEqual(active.portTypes, ["stop-ticks"]);
  assert.equal(active.channel.cleanupCallbackCalls, 1);
  assert.equal(active.unpublishCalls, 1);
  assert.equal(done, false);

  t.mock.timers.tick(2000);
  await flush();
  assert.equal(done, true);
  assert.equal(mod.screenAudioDiagnostics(), undefined);
  // A clean stop is SILENT: no toast for a failure the user did not have.
  assert.deepEqual(active.reports, []);
});

test("a death arriving in EXPECTED_STOP is suppressed, not toasted", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangUnpublish = true;
  void mod.teardownScreenAudio();
  await flush();
  assert.equal(mod.screenAudioDiagnostics()?.state, "EXPECTED_STOP");

  // The shell's terminal response for the stop we ourselves asked for.
  active.emitDeath({ generation: 7, reason: "stopped" });
  assert.deepEqual(active.reports, []);
  assert.equal(mod.screenAudioDiagnostics()?.state, "EXPECTED_STOP");

  t.mock.timers.tick(2000);
  await flush();
  // And still nothing after the machine is back in IDLE.
  active.emitDeath({ generation: 7, reason: "stopped" });
  assert.deepEqual(active.reports, []);
});

test("a rejected screen_audio_start returns the machine to IDLE", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  active.startRejection = { code: "no-exclusion-root", detail: "…" };

  const capture = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });
  assert.equal(capture, undefined);
  assert.deepEqual(active.reports, [
    { kind: "start", code: "no-exclusion-root" },
  ]);
  assert.equal(mod.screenAudioActive(), false);
  assert.equal(mod.beginScreenAudioPublish(), false);
  // Leaving the machine in STARTING here is what an earlier revision did, and
  // it never recovered: a second share must still be possible.
  active.startRejection = undefined;
  await startShare(mod, active);
});

test("a death during the graph build is latched and the publish never happens", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  // `session` is not assigned until the worklet module has been fetched — a
  // whole IPC and a network-or-disk read after `start` resolved.
  active.onAddModule = () => {
    active.emitDeath({ generation: 7, reason: "device-lost" });
  };

  const capture = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });
  assert.equal(capture, undefined);
  assert.deepEqual(active.reports, [{ kind: "died", reason: "device-lost" }]);
  assert.equal(mod.screenAudioActive(), false);
  assert.equal(mod.beginScreenAudioPublish(), false);
  // The context the re-check found is closed rather than leaked; Chromium's
  // per-page context cap is the thing that kills ALL call audio.
  assert.equal(active.context.closes, 1);
  assert.equal(active.nodes.length, 0);
  assert.deepEqual(active.calls("screen_audio_stop")[0]?.args, {
    generation: 7,
  });
});

test("a stop path landing in the graph-build window cancels the start", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  active.onAddModule = async () => {
    // `RoomEvent.Disconnected` while the worklet module is being fetched.
    await mod.teardownScreenAudio();
  };

  const capture = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });
  assert.equal(capture, undefined);
  // Not a failure — the user or the room ended it — so no report, but the
  // shell must still be told.
  assert.deepEqual(active.reports, []);
  assert.deepEqual(active.calls("screen_audio_stop")[0]?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioActive(), false);
});

// -- deathFailure's mapping, through the only surface that observes it -------

test("🔴 the async unsupported-OS refusal is reported as a START failure", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await startShare(mod, active);
  // The OS gate is reached on the CAPTURE THREAD, after `screen_audio_start`
  // has already resolved Ok, so the refusal arrives on the died channel.
  active.emitDeath({
    generation: 7,
    reason: "capture-error",
    code: "unsupported",
  });
  assert.deepEqual(active.reports, [{ kind: "start", code: "unsupported" }]);
});

test("an unsupported-OS refusal carried in `reason` maps the same way", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await startShare(mod, active);
  active.emitDeath({ generation: 7, reason: "unsupported" });
  assert.deepEqual(active.reports, [{ kind: "start", code: "unsupported" }]);
});

test("🔴 a 19041 detail string does NOT turn a death into a start refusal", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await startShare(mod, active);
  active.emitDeath({
    generation: 7,
    reason: "capture-error",
    detail:
      "ActivateAudioInterfaceAsync is not exported (Windows build < 19041)",
  });
  // Ordinary death copy, not "your shell is too old".
  assert.deepEqual(active.reports, [{ kind: "died", reason: "capture-error" }]);
});

// ===========================================================================
// Case 3 — generation and supersede
// ===========================================================================

test("🔴 an OLD generation's died-event must not kill a newer share", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await goLive(mod, active);

  // The shell's drop-guard fires on ANY capture-thread exit, a SUPERSEDE
  // included, so an old session's guard emits into a renderer already LIVE on
  // the new one.
  active.emitDeath({ generation: 6, reason: "device-lost" });
  active.emitDeath({ generation: 0, reason: "device-lost" });

  assert.deepEqual(active.reports, []);
  assert.equal(mod.screenAudioDiagnostics()?.state, "LIVE");
  assert.equal(mod.screenAudioActive(), true);
  assert.equal(active.unpublishCalls, 0);
});

test("🔴 an OLD generation's sentinel must not kill a newer share", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await goLive(mod, active);
  const before = active.node.port.messages.length;

  active.channel.onmessage(sentinel(6));
  await flush();

  assert.deepEqual(active.reports, []);
  assert.equal(mod.screenAudioDiagnostics()?.state, "LIVE");
  // Refused outright: not forwarded, and not treated as a death.
  assert.equal(active.node.port.messages.length, before);
});

test("after a supersede the old channel is inert and the new share survives", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  await goLive(mod, active);
  const firstChannel = active.channel;
  await mod.teardownScreenAudio();
  await flush();

  // Share two, at the shell's next generation.
  active.startResult = { generation: 8, format: FORMAT, timings: TIMINGS };
  await goLive(mod, active);
  const secondChannel = active.channel;
  assert.notEqual(firstChannel, secondChannel);
  assert.equal(mod.screenAudioGeneration(), 8);

  // The old channel's `window._<id>` closure is still installed on the shell
  // side, so the old capture thread's terminal sentinel still arrives.
  firstChannel.onmessage(sentinel(7));
  // And its died-event does too.
  active.emitDeath({ generation: 7, reason: "superseded" });
  await flush();

  assert.deepEqual(active.reports, []);
  assert.equal(mod.screenAudioDiagnostics()?.state, "LIVE");
  assert.equal(mod.screenAudioGeneration(), 8);
});

test("a sentinel for the LIVE generation ends the share", async (t) => {
  // The positive control for the two negatives above: the same transport, the
  // same code path, the CURRENT generation.
  const mod = await freshModule();
  const active = seat(t);
  await goLive(mod, active);

  active.channel.onmessage(sentinel(7));

  assert.deepEqual(active.reports, [{ kind: "died", reason: "sentinel" }]);
  assert.equal(mod.screenAudioDiagnostics()?.state, "DEAD");
  await flush();
  // It WAS published, so the death path unpublishes.
  assert.equal(active.unpublishCalls, 1);
});

test("a malformed frame is refused without being forwarded to the worklet", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  const errors = t.mock.method(console, "error", () => undefined);
  await goLive(mod, active);
  const before = active.node.port.messages.length;

  active.channel.onmessage(frame({ generation: 7 }, 1943));
  active.channel.onmessage(frame({ generation: 7 }, 1945));
  active.channel.onmessage(frame({ version: 2, generation: 7 }, 1944));
  await flush();

  assert.equal(active.node.port.messages.length, before);
  assert.equal(mod.screenAudioDiagnostics()?.state, "LIVE");
  assert.equal(errors.mock.callCount(), 2);

  // A well-formed one is forwarded, at the header offset, by transfer.
  active.channel.onmessage(frame({ generation: 7, seq: 42n }, 1944));
  const forwarded = active.node.port.messages.at(-1);
  assert.equal(forwarded?.type, "pcm");
  assert.equal(forwarded?.offset, HEADER_BYTES);
  assert.equal(forwarded?.seq, 42);
  assert.equal(mod.screenAudioDiagnostics()?.lastReceivedSeq, 42);
});

// ===========================================================================
// Case 4 — a sentinel before `onmessage` would have been swallowed
// ===========================================================================

test("🔴 a sentinel delivered BEFORE `start` resolves is latched, not swallowed", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  // The Tauri JS `Channel` initializes `onmessage` to a no-op and dispatches
  // in-order messages immediately, so the handler must already be installed
  // when the invoke goes out. This drives exactly that window: the sentinel is
  // delivered synchronously inside `screen_audio_start`, before it resolves.
  active.onStart = (channel) => {
    channel.onmessage(sentinel(7));
  };

  const capture = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });

  assert.equal(capture, undefined);
  assert.deepEqual(active.reports, [{ kind: "died", reason: "sentinel" }]);
  // The graph was never built — no context to leak, no track to publish.
  assert.equal(active.contexts.length, 0);
  assert.equal(active.nodes.length, 0);
  assert.equal(mod.screenAudioActive(), false);
  assert.equal(mod.beginScreenAudioPublish(), false);
  // ONE verb, and it carries the generation.
  assert.deepEqual(active.calls("screen_audio_stop")[0]?.args, {
    generation: 7,
  });
  assert.equal(active.calls("screen_audio_disown").length, 0);
  assert.equal(active.channel.cleanupCallbackCalls, 1);
});

test("a sentinel in the graph-build window is latched by the post-await re-check", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  active.onAddModule = () => {
    active.channel.onmessage(sentinel(7));
  };

  const capture = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });

  assert.equal(capture, undefined);
  assert.deepEqual(active.reports, [{ kind: "died", reason: "sentinel" }]);
  assert.equal(active.context.closes, 1);
  assert.equal(active.nodes.length, 0);
});

test("an early sentinel for a DIFFERENT generation does not cancel the start", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  // Once `start` has resolved the generation is known, so the early-frame
  // buffer can filter — and a superseded capture's sentinel is not ours.
  active.onAddModule = () => {
    active.channel.onmessage(sentinel(6));
  };

  const capture = await startShare(mod, active);
  assert.equal(capture.generation, 7);
  assert.deepEqual(active.reports, []);
});

test("a non-sentinel early frame is dropped, not latched", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  active.onStart = (channel) => {
    // Audio has nowhere to go yet; dropping it costs a few milliseconds.
    channel.onmessage(frame({ generation: 7, flags: FLAG_SYNTHETIC }, 1944));
  };

  const capture = await startShare(mod, active);
  assert.equal(capture.generation, 7);
  assert.deepEqual(active.reports, []);
});

// ===========================================================================
// Case 5 — the publish gate refuses, tears down and reports
// ===========================================================================

test("🔴 an unencrypted sender in STARTING refuses the publish and reports", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await startShare(mod, active);

  // `LocalSenderCreated` fires INSIDE `negotiate()`, before the publish has
  // been issued. Routing this through the ordinary stop path would enter
  // EXPECTED_STOP, where the death branch is suppressed, and the publish would
  // go ahead: the whole capture on the wire while signaling stamps GCM.
  mod.screenAudioEncryptionFailed();

  assert.equal(mod.beginScreenAudioPublish(), false);
  assert.equal(mod.finishScreenAudioPublish(), false);
  assert.deepEqual(active.reports, [{ kind: "not-encrypted" }]);
  assert.deepEqual(active.portTypes, ["discard", "stop-ticks"]);
  await flush();
  // Nothing was published, so there is nothing to unpublish.
  assert.equal(active.unpublishCalls, 0);
  assert.equal(active.context.closes, 1);
  assert.equal(active.destinations.at(-1)?.track.stops, 1);
  assert.equal(mod.screenAudioActive(), false);
});

test("a failure inside the publish window still unpublishes", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await startShare(mod, active);

  // `publishTrack` has been issued and `negotiate()` has not returned.
  assert.equal(mod.beginScreenAudioPublish(), true);
  mod.screenAudioEncryptionFailed();

  assert.equal(mod.finishScreenAudioPublish(), false);
  assert.deepEqual(active.reports, [{ kind: "not-encrypted" }]);
  await flush();
  // The host resolves the publication BY TRACK, so a publish still inside
  // `negotiate()` is reachable — which is why the death path calls it at all.
  assert.equal(active.unpublishCalls, 1);
});

test("🔴 an unencrypted LIVE sender discards, unpublishes, THEN reports", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangUnpublish = true;
  mod.screenAudioEncryptionFailed();

  // Discard FIRST, synchronously, before teardown's first await — matching
  // `die()`, so the two edges stop the source identically.
  assert.deepEqual(active.portTypes, ["discard", "stop-ticks"]);
  await flush();
  assert.equal(active.unpublishCalls, 1);
  // 🔴 Reporting first would open a modal over a publication still on the SFU.
  assert.deepEqual(active.reports, []);

  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(active.reports, [{ kind: "not-encrypted" }]);
  assert.equal(mod.screenAudioActive(), false);
  assert.equal(mod.screenAudioDiagnostics(), undefined);
});

test("an encryption failure outside STARTING and LIVE is a no-op", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  // IDLE.
  mod.screenAudioEncryptionFailed();
  assert.deepEqual(active.reports, []);
  assert.equal(mod.screenAudioActive(), false);
  // And a second call in DEAD does not double-report.
  await startShare(mod, active);
  mod.screenAudioEncryptionFailed();
  mod.screenAudioEncryptionFailed();
  assert.deepEqual(active.reports, [{ kind: "not-encrypted" }]);
});

test("a share cannot be started over a live one", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  const warn = t.mock.method(console, "warn", () => undefined);
  await goLive(mod, active);
  const second = await mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });
  assert.equal(second, undefined);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(mod.screenAudioGeneration(), 7);
});

test("slice 2's window-share mode is a capability answer, not an interface change", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  const capture = await mod.captureScreenAudio({
    mode: { includePid: 1234 },
    host: active.host,
  });
  assert.equal(capture, undefined);
  assert.equal(active.calls("screen_audio_start").length, 0);
  assert.deepEqual(active.reports, []);
});

// ===========================================================================
// Case 6 — bounded teardown
// ===========================================================================

test("🔴 a HANGING unpublish still lets teardown reach steps 3-5", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangUnpublish = true;
  let done = false;
  void mod.teardownScreenAudio().then(() => {
    done = true;
  });
  await flush();
  assert.equal(active.unpublishCalls, 1);

  // livekit's `unpublishTrack` awaits `pendingPublishPromises` and then
  // `engine.negotiate()`, both of which sit on a dead PeerConnection after a
  // socket drop. A guard that only handles REJECTION does nothing here.
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(done, false);
  assert.equal(active.context.closes, 0);

  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true);
  // Step 3, step 4 and step 5 all ran: the AudioContext is closed rather than
  // leaked toward Chromium's per-page cap, and the shell is stopped.
  assert.equal(active.destinations.at(-1)?.track.stops, 1);
  assert.equal(active.node.disconnects, 1);
  assert.equal(active.destinations.at(-1)?.disconnects, 1);
  assert.equal(active.context.closes, 1);
  assert.deepEqual(active.calls("screen_audio_stop").at(-1)?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioDiagnostics(), undefined);
});

test("🔴 a HANGING screen_audio_stop still returns teardown to IDLE", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangs.add("screen_audio_stop");
  let done = false;
  void mod.teardownScreenAudio().then(() => {
    done = true;
  });
  await flush();
  // Steps 2-4 are already done; only step 5 is outstanding.
  assert.equal(active.unpublishCalls, 1);
  assert.equal(active.context.closes, 1);
  assert.equal(active.calls("screen_audio_stop").length, 1);

  t.mock.timers.tick(1999);
  await flush();
  assert.equal(done, false);
  // Pinned in EXPECTED_STOP for the life of the page is the failure this
  // bound exists to prevent: every later share silent, with no visible cause.
  assert.equal(mod.screenAudioDiagnostics()?.state, "EXPECTED_STOP");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true);
  assert.equal(mod.screenAudioDiagnostics(), undefined);
  assert.equal(mod.screenAudioActive(), false);
  // And the machine is usable again.
  active.hangs.delete("screen_audio_stop");
  active.startResult = { generation: 9, format: FORMAT, timings: TIMINGS };
  await startShare(mod, active);
});

test("the bound is PER STEP, so two hangs cost two windows, never forever", async (t) => {
  // Stated rather than implied: `runTeardownSteps` awaits step 2 and step 5
  // under separate 2 s races, so the worst case for a teardown with both
  // hanging is ~4 s — bounded, but not 2 s. A future change that fused the two
  // guards into one would move this number.
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangUnpublish = true;
  active.hangs.add("screen_audio_stop");
  let done = false;
  void mod.teardownScreenAudio().then(() => {
    done = true;
  });
  await flush();

  t.mock.timers.tick(2000);
  await flush();
  assert.equal(done, false);
  t.mock.timers.tick(1999);
  await flush();
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true);
  assert.equal(mod.screenAudioDiagnostics(), undefined);
});

test("a hanging unpublish on the DEATH path is bounded the same way", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangUnpublish = true;
  active.emitDeath({ generation: 7, reason: "device-lost" });
  // The report is LOUD and immediate on this edge — it does not wait for the
  // teardown the way the not-encrypted edge does.
  assert.deepEqual(active.reports, [{ kind: "died", reason: "device-lost" }]);
  await flush();
  assert.equal(mod.screenAudioDiagnostics()?.state, "DEAD");

  t.mock.timers.tick(2000);
  await flush();
  assert.equal(mod.screenAudioDiagnostics(), undefined);
  assert.equal(mod.screenAudioActive(), false);
  assert.equal(active.context.closes, 1);
});

test("teardown with no session is a silent no-op", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  await mod.teardownScreenAudio();
  await mod.teardownScreenAudio();
  assert.deepEqual(active.reports, []);
  // 🔴 Deliberately NO IPC: a dark build must not talk to a shell that has no
  // such command, and there is no session to stop.
  assert.deepEqual(active.invocations, []);
});

// ===========================================================================
// The STARTING window is bounded at EVERY await
// ===========================================================================
//
// 🔴 What these specs protect is not a leak — it is what the VIEWERS see.
//
// By the time `captureScreenAudio` runs, `state.tsx` has already published the
// screen-share video and, when the quality-ask is pending, already called
// `localTrack.pauseUpstream()`. The upstream is resumed by the ask-modal's
// callback, and that modal does not open until this function returns. So an
// await in here that never settles does not degrade the share — it strands
// every viewer on a FROZEN TILE, with no modal, no error and no failure
// report, until the sharer notices and stops sharing by hand. The Linux arm
// states the same rule at its own call site.
//
// There are five awaits in that window and each has its own bound, so each
// gets its own spec: the listener registration, the start invoke, the worklet
// module load, `resume()`, and the `close()` on the abandonment arms. A
// regression in any one of them is invisible to every other test in this file,
// because every one of those paths still ends in a correct silent share — it
// just takes forever to get there.

test("🔴 a HANGING listener registration degrades to a silent share", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  // `listen()` is an IPC into the same shell the capture lives in, so the
  // wedge that hangs `screen_audio_start` hangs this FIRST — before the
  // machine has even left IDLE.
  active.hangListen = true;
  let settled: ScreenAudioWin.ScreenAudioCapture | undefined | "pending" =
    "pending";
  void mod
    .captureScreenAudio({ mode: "system", host: active.host })
    .then((capture) => {
      settled = capture;
    });
  await flush();
  assert.equal(settled, "pending");
  assert.equal(active.listenCalls, 1);

  t.mock.timers.tick(2499);
  await flush();
  assert.equal(settled, "pending");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, undefined);
  // The existing `no-death-listener` row, reached through the hang door
  // rather than the reject door. `state.tsx` keys on `kind`, so this needs no
  // new copy.
  assert.deepEqual(active.reports, [
    { kind: "start", code: "no-death-listener" },
  ]);
  // 🔴 Nothing was started, so there is nothing to stop: the bound elapsed
  // BEFORE the machine left IDLE, which is the cheapest place in the window
  // for it to happen.
  assert.equal(mod.screenAudioDiagnostics(), undefined);
  assert.deepEqual(active.calls("screen_audio_start"), []);
});

test("🔴 a listener that answers LATE is adopted, never registered twice", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  active.hangListen = true;
  const refused = mod.captureScreenAudio({ mode: "system", host: active.host });
  await flush();
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(await refused, undefined);
  assert.equal(active.listenCalls, 1);

  // 🔴 THE ORDERING THAT MATTERS. The second share starts while the FIRST
  // registration is still in flight — which is the whole scenario, because
  // the shell that hung the first one is still hung. Asserting the count only
  // after the registration has landed proves nothing: by then
  // `deathListenerRegistered` is true and no implementation would re-register.
  const alsoRefused = mod.captureScreenAudio({
    mode: "system",
    host: active.host,
  });
  await flush();
  t.mock.timers.tick(2500);
  await flush();
  assert.equal(await alsoRefused, undefined);
  // Still ONE subscription. Dropping the timed-out handle and starting over
  // would leave two live subscriptions to `screen-audio-died` for the rest of
  // the page's life, and `onShellDeath` would then run twice per death —
  // pushing two entries into `pendingDeaths` for one event.
  assert.equal(active.listenCalls, 1);

  // The shell frees up and the registration lands after its bound.
  active.releaseListen();
  await flush();

  // ONE registration across all three shares — the accumulation
  // `ensureDeathListener`'s name exists to prevent, reached through the
  // timeout door rather than the per-share door.
  active.startResult = { generation: 9, format: FORMAT, timings: TIMINGS };
  await startShare(mod, active);
  assert.equal(active.listenCalls, 1);
  // And the adopted registration is LIVE rather than merely single: a death
  // for this share still reaches the machine and is reported.
  active.emitDeath({ generation: 9, reason: "device-lost" });
  assert.deepEqual(active.reports.at(-1), {
    kind: "died",
    reason: "device-lost",
  });
});

test("🔴 a HANGING screen_audio_start degrades to a silent share", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  active.hangs.add("screen_audio_start");
  let settled: ScreenAudioWin.ScreenAudioCapture | undefined | "pending" =
    "pending";
  void mod
    .captureScreenAudio({ mode: "system", host: active.host })
    .then((capture) => {
      settled = capture;
    });
  await flush();
  assert.equal(settled, "pending");
  // The machine HAS left IDLE — `screenAudioDiagnostics()` cannot say so,
  // because it reads a session that does not exist until the graph is built,
  // so the observable is that the shell was actually asked to capture.
  assert.equal(active.calls("screen_audio_start").length, 1);

  t.mock.timers.tick(2499);
  await flush();
  assert.equal(settled, "pending");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, undefined);
  assert.deepEqual(active.reports, [{ kind: "start", code: "timeout" }]);
  // 🔴 No `stop` yet, and that is correct rather than a gap: the generation
  // is the shell's answer and the shell has not answered. The orphan-stop
  // arm hangs off the invocation's LATE resolution, which a permanently
  // hanging invoke never reaches.
  assert.deepEqual(active.calls("screen_audio_stop"), []);
  // 🔴 Back to IDLE, proven by USE rather than by a getter: leaving the
  // machine in STARTING is what an earlier revision did, and it never
  // recovered — every later share in the session was refused by the "already
  // running" guard with nothing visible anywhere.
  active.hangs.delete("screen_audio_start");
  active.startResult = { generation: 9, format: FORMAT, timings: TIMINGS };
  await startShare(mod, active);
});

test("🔴 a HANGING worklet module load stops the capture it already started", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  // A wedged service worker or a stalled disk. Unlike the start invoke, the
  // shell IS capturing by now.
  active.onAddModule = () => new Promise<void>(() => undefined);
  let settled: ScreenAudioWin.ScreenAudioCapture | undefined | "pending" =
    "pending";
  void mod
    .captureScreenAudio({ mode: "system", host: active.host })
    .then((capture) => {
      settled = capture;
    });
  await flush();
  assert.equal(settled, "pending");

  t.mock.timers.tick(2499);
  await flush();
  assert.equal(settled, "pending");
  assert.equal(active.context.closes, 0);

  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, undefined);
  assert.deepEqual(active.reports, [{ kind: "start", code: "timeout" }]);
  // 🔴 Both halves of the leak are closed: the renderer's AudioContext, and
  // the shell-side capture — which is live at this point and would otherwise
  // run until its credit expired.
  assert.equal(active.context.closes, 1);
  assert.deepEqual(active.calls("screen_audio_stop").at(-1)?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioDiagnostics(), undefined);
});

test("🔴 a HANGING AudioContext.resume() degrades to a silent share", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  // `resume()` settles when the audio engine gives the context an output
  // device, so it is the step in this window that waits on the very subsystem
  // a WASAPI wedge takes down — and a `suspended` context is itself a symptom
  // of a machine already in trouble.
  active.contextStartState = "suspended";
  active.hangResume = true;
  let settled: ScreenAudioWin.ScreenAudioCapture | undefined | "pending" =
    "pending";
  void mod
    .captureScreenAudio({ mode: "system", host: active.host })
    .then((capture) => {
      settled = capture;
    });
  await flush();
  assert.equal(active.context.resumes, 1);
  assert.equal(settled, "pending");

  t.mock.timers.tick(2499);
  await flush();
  assert.equal(settled, "pending");
  // No graph was built on top of a context that never came back.
  assert.deepEqual(active.nodes, []);

  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, undefined);
  assert.deepEqual(active.reports, [{ kind: "start", code: "timeout" }]);
  assert.equal(active.context.closes, 1);
  assert.deepEqual(active.calls("screen_audio_stop").at(-1)?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioDiagnostics(), undefined);
});

test("🔴 a HANGING close does not swallow the failure report", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);

  // Two hangs, one after the other: the module load gives up at 2500 ms and
  // reaches for `close()` — which is the same wedged audio engine.
  active.onAddModule = () => new Promise<void>(() => undefined);
  active.hangClose = true;
  let settled: ScreenAudioWin.ScreenAudioCapture | undefined | "pending" =
    "pending";
  void mod
    .captureScreenAudio({ mode: "system", host: active.host })
    .then((capture) => {
      settled = capture;
    });
  await flush();

  t.mock.timers.tick(2500);
  await flush();
  // The close is reached, and does not come back.
  assert.equal(active.context.closes, 1);
  assert.equal(active.context.closesSettled, 0);
  // 🔴 THE REGRESSION THIS SPEC EXISTS FOR. Every `close()` here sits between
  // detecting a failure and reporting it, so an unbounded one reproduces the
  // frozen tile through a door the module-load race does not cover: the
  // failure is known, and nobody is ever told.
  assert.equal(settled, "pending");
  assert.deepEqual(active.reports, []);

  t.mock.timers.tick(1999);
  await flush();
  assert.equal(settled, "pending");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(settled, undefined);
  assert.deepEqual(active.reports, [{ kind: "start", code: "timeout" }]);
  // And the shell-side capture is still stopped: giving up on the close does
  // not cost the abandonment that follows it.
  assert.deepEqual(active.calls("screen_audio_stop").at(-1)?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioDiagnostics(), undefined);
});

test("🔴 a HANGING close in TEARDOWN still reaches step 5", async (t) => {
  const mod = await freshModule();
  const active = seat(t);
  useFakeClock(t);
  await goLive(mod, active);

  active.hangClose = true;
  let done = false;
  void mod.teardownScreenAudio().then(() => {
    done = true;
  });
  await flush();
  assert.equal(active.unpublishCalls, 1);
  assert.equal(active.context.closes, 1);
  // Step 5 has not run yet, which is the whole exposure.
  assert.deepEqual(active.calls("screen_audio_stop"), []);

  t.mock.timers.tick(1999);
  await flush();
  assert.equal(done, false);
  // 🔴 Pinned in EXPECTED_STOP for the life of the page, with the shell still
  // capturing the desktop until its credit expires — reached through the
  // close, which a `try/catch` around it does nothing about.
  assert.equal(mod.screenAudioDiagnostics()?.state, "EXPECTED_STOP");

  t.mock.timers.tick(1);
  await flush();
  assert.equal(done, true);
  assert.deepEqual(active.calls("screen_audio_stop").at(-1)?.args, {
    generation: 7,
  });
  assert.equal(mod.screenAudioDiagnostics(), undefined);
  assert.equal(mod.screenAudioActive(), false);
});
