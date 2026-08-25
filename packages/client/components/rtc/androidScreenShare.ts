/**
 * Android screen-leg publisher bridge (screen-leg plan §7) — the JS half of
 * the two-phase `ScreenSharePlugin` (§4.2).
 *
 * The WebView cannot screen-share on Android (no runtime exposes
 * `getDisplayMedia`), so a share from the phone is a SECOND, native LiveKit
 * participant — `{user_id}:{device_id}:screen` — publishing only the
 * MediaProjection capture. This module owns the plugin surface, the phone
 * quality table (§7.4 — deliberately NOT the desktop ladder: single layer,
 * VP8, no simulcast, no backup codec), and the availability gate. Lifecycle
 * ordering (preconditions, stop hooks, key pushes) stays in `rtc/state.tsx`,
 * which owns the call.
 */
import { type Accessor, createSignal } from "solid-js";

import { Capacitor, registerPlugin } from "@capacitor/core";

import { CONFIGURATION } from "@revolt/common";
import type { AndroidScreenShareTierName } from "@revolt/state/stores/Voice";

import {
  type AndroidScreenShareTier,
  ANDROID_SCREEN_SHARE_TIERS,
} from "./androidScreenShareTiers";

export { ANDROID_SCREEN_SHARE_TIERS };
export type { AndroidScreenShareTier, AndroidScreenShareTierName };

/** The key handed to the native sender — §5.2's `LocalScreenKey`, minus the
 * epoch (the fence lives in the provider; native only needs key + index). */
export interface NativeFrameKey {
  keyB64: string;
  keyIndex: number;
}

export type NativeStopReason = "user" | "system" | "disconnected" | "error";

interface NativeScreenSharePlugin {
  isAvailable(): Promise<{ available: boolean; audioCapture: boolean }>;
  prepare(): Promise<{ ok: boolean }>;
  connect(options: {
    url: string;
    token: string;
    quality: {
      longSide: number;
      fps: number;
      maxBitrateKbps: number;
      degradation: string;
    };
    /** Inert until slice 4 (§0.6) — v1 publishes video only. */
    audio: boolean;
    e2ee?: NativeFrameKey;
  }): Promise<{ ok: boolean }>;
  setFrameKey(key: NativeFrameKey): Promise<void>;
  stop(): Promise<void>;
  addListener(
    event: "started" | "stopped" | "muted" | "error",
    callback: (data: {
      reason?: NativeStopReason;
      muted?: boolean;
      code?: string;
    }) => void,
  ): Promise<{ remove: () => Promise<void> }>;
}

const isAndroidShell = () =>
  Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";

const plugin: NativeScreenSharePlugin | undefined = isAndroidShell()
  ? registerPlugin<NativeScreenSharePlugin>("ScreenShare")
  : undefined;

const [available, setAvailable] = createSignal(false);

/**
 * Whether the NATIVE share path exists on this device — Android shell + the
 * build-time flag + the plugin answering (§7.1). A SIGNAL rather than a
 * const: `isAvailable()` is async, so the buttons it gates must react when
 * the probe lands rather than reading a stale `false` forever.
 */
export const nativeScreenShareAvailable: Accessor<boolean> = available;

if (plugin && CONFIGURATION.ENABLE_ANDROID_SCREEN_SHARE) {
  plugin
    .isAvailable()
    .then((result) => setAvailable(result.available))
    .catch(() => setAvailable(false));
}

/**
 * The live leg, at most one per call. Owned by `Voice` (rtc/state.tsx), which
 * drives every stop hook (§7.4) through [stop]; this class only tracks the
 * native side and fans plugin events out to the callbacks the owner set.
 *
 * `active` is true from a resolved [connect] until the terminal `stopped`
 * event — INCLUDING the whole native teardown, so a stop hook firing twice
 * (pause gate + disconnect, say) collapses into one native `stop()`.
 */
export class AndroidScreenLeg {
  #active = false;
  #stopping = false;
  #listeners: { remove: () => Promise<void> }[] = [];
  /** Resolves once the plugin listeners are attached — awaited by [prepare]
   * so no share can start with its event stream unwired. */
  #ready: Promise<void>;

  onStarted?: () => void;
  onStopped?: (reason: NativeStopReason) => void;
  onMuted?: (muted: boolean) => void;

  constructor() {
    if (!plugin) throw new Error("native screen share unavailable");
    this.#ready = this.#listen();
  }

  async #listen() {
    const p = plugin!;
    this.#listeners.push(
      await p.addListener("started", () => {
        this.#active = true;
        this.onStarted?.();
      }),
      await p.addListener("stopped", (data) => {
        const wasActive = this.#active;
        this.#active = false;
        this.#stopping = false;
        // A stopped for a leg that never reported started (connect() threw
        // after partial setup) has nothing to announce.
        if (wasActive) this.onStopped?.(data.reason ?? "error");
      }),
      await p.addListener("muted", (data) => {
        this.onMuted?.(data.muted ?? true);
      }),
    );
  }

  active(): boolean {
    return this.#active;
  }

  /** Phase 1: OS consent + FGS. User-paced — mint the token AFTER this. */
  async prepare(): Promise<void> {
    await this.#ready;
    await plugin!.prepare();
  }

  /**
   * Phase 2: connect + publish. The 10 s token must be minted between
   * [prepare] and this call (§4.2). Under E2EE `e2ee` is REQUIRED — the
   * caller's publish gate guarantees it (§7.2); a failed connect keeps the
   * consent, so a retry needs a fresh token but no new dialog (probe (e)).
   */
  async connect(options: {
    url: string;
    token: string;
    tier: AndroidScreenShareTier;
    e2ee?: NativeFrameKey;
  }): Promise<void> {
    await plugin!.connect({
      url: options.url,
      token: options.token,
      quality: {
        longSide: options.tier.longSide,
        fps: options.tier.fps,
        maxBitrateKbps: options.tier.maxBitrateKbps,
        degradation: options.tier.degradation,
      },
      audio: false,
      e2ee: options.e2ee,
    });
    this.#active = true;
  }

  /**
   * Rotation push (§5.2). Resolves only once the native sender encrypts under
   * the new (key, index) — the provider AWAITS this before reporting the
   * local key installed, which is what locks a removed member out. A
   * rejection here means the leg cannot be trusted on the new epoch: the
   * caller stops the leg (fail closed) and resolves the provider's push.
   */
  async setFrameKey(key: NativeFrameKey): Promise<void> {
    if (!this.#active) return;
    await plugin!.setFrameKey(key);
  }

  /**
   * Idempotent stop — every §7.4 hook lands here. The native side unpublishes,
   * disconnects, releases the Room (dropping the native keyring) and stops the
   * FGS; the `stopped` event closes the loop.
   */
  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    try {
      await plugin!.stop();
    } catch {
      // Native teardown is best-effort from JS: the SFU timeout and
      // voice-ingress's leg-left branch clear the server state either way.
    } finally {
      this.#stopping = false;
      // The native `stopped` event and this resolution race; whichever runs
      // first flips `#active` and announces — the other finds it already
      // false and stays quiet, so the end-of-share sound plays exactly once
      // even if the bridge drops the event.
      if (this.#active) {
        this.#active = false;
        this.onStopped?.("user");
      }
    }
  }

  /** Drop plugin listeners (app-lifetime hygiene; used by tests). */
  dispose(): void {
    for (const listener of this.#listeners.splice(0)) void listener.remove();
  }
}

/** Construct the leg controller, or undefined off the Android shell. */
export function createAndroidScreenLeg(): AndroidScreenLeg | undefined {
  if (!plugin || !CONFIGURATION.ENABLE_ANDROID_SCREEN_SHARE) return undefined;
  return new AndroidScreenLeg();
}
