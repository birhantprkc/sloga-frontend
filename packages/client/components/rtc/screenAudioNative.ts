/**
 * Linux screen-share audio — the renderer half of the native PipeWire
 * capture path (discord-features-plans/linux-pipewire-screenshare-audio.md
 * §6). The Electron main process creates a virtual source that carries all
 * system audio EXCEPT Sloga's own playback; this module starts/stops that
 * session, finds the resulting input device, and hands `state.tsx` a plain
 * MediaStreamTrack to publish as ScreenShareAudio.
 *
 * Lifecycle ordering (generation tokens, publish-gate/consent interaction,
 * E2EE transform assertion) stays in `rtc/state.tsx`, which owns the call —
 * this module owns only capture and its own cleanup: every error exit stops
 * the native session it started and the gUM track it acquired (review F1; a
 * half-built capture leaves nothing behind).
 */
import { CONFIGURATION } from "@revolt/common";

import {
  type ScreenAudioApp,
  type ScreenAudioPlan,
  type ScreenAudioTargets,
  groupAppRoster,
  planFromAnswer,
  planWithoutTargeting,
} from "./screenAudioTargetPolicy";

export type {
  ScreenAudioApp,
  ScreenAudioPlan,
  ScreenAudioTargets,
} from "./screenAudioTargetPolicy";

/** Last probe outcome, for synchronous UI (the settings-modal copy gate).
 * `undefined` until the first probe resolves.
 *
 * 🔴 A plain `let`, not a signal: a UI branch reading it is NOT tracked and
 * will not re-render when a probe lands. That is safe today only because of
 * an invariant that lives in another file — `toggleScreenshare()` awaits
 * `screenAudioSupported(true)` before it can open the settings modal, since
 * `wantsAudio` is forced true whenever consent is pending and Linux never
 * has a getDisplayMedia audio track. Make `wantsAudio` honor the stored
 * setting with the ask-dialog on and that ordering is gone: the probe is
 * skipped, this stays `undefined`, and a CAPABLE shell renders "System
 * audio capture isn't supported on Linux yet." Move the modal onto a Solid
 * signal before changing that. */
let lastProbe: boolean | undefined;

function shellSurface() {
  return window.slogaShell?.screenAudio;
}

/**
 * Synchronous view of availability for UI branches that cannot await —
 * false until a probe has run. The capture path itself always awaits
 * `screenAudioSupported()`.
 */
export function screenAudioAvailableSync(): boolean {
  return lastProbe === true;
}

/**
 * Whether this build + shell + host can capture screen audio. Flag-gated
 * (dark by default), then the shell surface, then a real PipeWire probe in
 * the main process (cached there; `refresh` re-probes so PipeWire coming
 * up after app launch is picked up — the capture path passes true on each
 * share start, §5).
 */
export async function screenAudioSupported(refresh = false): Promise<boolean> {
  if (!CONFIGURATION.ENABLE_LINUX_SCREEN_AUDIO) return false;
  const shell = shellSurface();
  if (!shell) return false;
  if (!refresh && lastProbe !== undefined) return lastProbe;
  try {
    const result = await shell.probe(refresh);
    lastProbe = result?.available === true;
  } catch {
    lastProbe = false;
  }
  return lastProbe;
}

/**
 * Find the audioinput whose label matches the virtual source's
 * description. pipewire-pulse derives the enumerated label from
 * `node.description`, possibly with a Chromium suffix (review F5), so an
 * exact match is tried first and a substring match second. One retried
 * tick covers the device racing enumerateDevices right after the node
 * came up. A blank description never matches anything: the substring pass
 * would otherwise bind the FIRST audioinput — the user's microphone —
 * and publish it as screen audio (diff-review finding 6).
 */
async function findDeviceId(description: string): Promise<string | undefined> {
  if (!description) return undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const inputs = devices.filter((d) => d.kind === "audioinput");
      const exact = inputs.find((d) => d.label === description);
      const match = exact ?? inputs.find((d) => d.label.includes(description));
      if (match) {
        // Leg L5 evidence: record which rule bound so the real label
        // shape observed on hosts is in the logs.
        console.info(
          `screen audio device matched (${exact ? "exact" : "substring"}): "${match.label}"`,
        );
        return match.deviceId;
      }
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A live native capture: the track to publish plus the session token
 * that scopes every later stop to THIS session. */
export interface ScreenAudioCapture {
  track: MediaStreamTrack;
  sessionId: number;
}

/**
 * A shell round-trip must never be able to wedge a share. The video
 * upstream is already paused by the time this runs, so an IPC call that
 * never settles would leave viewers on a frozen tile with no way out but
 * toggling the share off — the exact failure §5 gave `probe` a hard
 * timeout to avoid.
 */
const RESOLVE_TIMEOUT_MS = 4000;

function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T | undefined> {
  return Promise.race([
    promise,
    new Promise<undefined>((resolve) =>
      setTimeout(() => resolve(undefined), ms),
    ),
  ]);
}

/**
 * Ask the shell what this share's audio should cover, and hand the answer
 * to the policy (`screenAudioTargetPolicy.ts`) to decide what it means.
 * Every decision lives there; this owns only the IPC and its deadline.
 *
 * `displaySurface` is the share's own `getSettings().displaySurface` — the
 * one fact about this share the renderer knows without asking, and what
 * the policy cross-checks the shell's answer against.
 */
export async function resolveScreenAudioTarget(
  displaySurface?: string,
): Promise<ScreenAudioPlan> {
  const shell = shellSurface();
  if (!shell?.resolveTarget || !shell.setTargets) {
    return planWithoutTargeting(displaySurface);
  }
  try {
    const answer = await withDeadline(
      shell.resolveTarget(),
      RESOLVE_TIMEOUT_MS,
    );
    return planFromAnswer(answer, displaySurface, "resolve_timeout");
  } catch {
    return planFromAnswer(undefined, displaySurface, "unknown_window");
  }
}

/**
 * The chooser's roster: one row per application. The shell has already
 * dropped Sloga's own streams — offering them would build the echo loop
 * the whole feature exists to prevent — and stamped each with a stable
 * `identity`, which is what a pick sends back.
 */
export async function listScreenAudioApps(): Promise<ScreenAudioApp[]> {
  const shell = shellSurface();
  if (!shell) return [];
  try {
    return groupAppRoster(await shell.listApps());
  } catch {
    return [];
  }
}

/**
 * Start the native session and capture its device. Returns the track with
 * its session token, or null on any failure — the caller degrades to a
 * no-audio share (audio is an enhancement; the video share already
 * succeeded, §4). The internal error path stops exactly the session it
 * started (by token), never a successor's.
 *
 * `targets` narrows the capture to one application (slice 2). The native
 * session starts in its system-wide default and is narrowed immediately
 * after — between those two awaits other apps are linked into the virtual
 * source, but NOTHING reads it: the device is only captured further down,
 * after the narrowing has been applied and acknowledged. A shell that
 * cannot apply it fails the whole capture rather than quietly publishing a
 * system-wide one the user did not ask for.
 */
export async function captureScreenAudio(
  targets: ScreenAudioTargets = { mode: "system" },
): Promise<ScreenAudioCapture | null> {
  const shell = shellSurface();
  if (!shell) return null;
  let sessionId: number | undefined;
  let track: MediaStreamTrack | undefined;
  try {
    const started = await shell.start();
    sessionId = started.sessionId;
    if (targets.mode === "targets") {
      if (!shell.setTargets) {
        throw new Error("shell cannot restrict screen audio to one app");
      }
      // ASSERT, do not assume — the same rule the E2EE transform check
      // follows, for the same reason: the failure is invisible from here.
      // A rejection is not the only way this goes wrong; the shell also
      // reports HOW MANY applications it actually linked, and zero means
      // the capture would be silent while a resolved promise says it
      // worked. Anything but a positive count fails the whole capture,
      // because the alternative is publishing a still-system-wide source
      // as if it were one app's audio.
      const linked = await shell.setTargets({
        sessionId,
        mode: "targets",
        include: targets.include,
      });
      if (typeof linked !== "number" || linked < 1) {
        throw new Error(
          `screen-audio targets did not apply (linked ${String(linked)})`,
        );
      }
    }
    const deviceId = await findDeviceId(started.deviceDescription);
    if (!deviceId) {
      throw new Error(
        `screen-audio device not found for "${started.deviceDescription}"`,
      );
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        // Program audio, not speech: AEC/NS/AGC would mangle music (§3.4).
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
      },
    });
    track = stream.getAudioTracks()[0];
    if (!track) throw new Error("no audio track from capture");
    return { track, sessionId };
  } catch (error) {
    console.error("screen audio capture failed", error);
    track?.stop();
    if (sessionId !== undefined) await stopScreenAudio(sessionId);
    return null;
  }
}

/**
 * Tear the native session down. Idempotent, safe on any surface (no-op off
 * the capable shell) — callers fire it from every stop path without
 * checking whether a session exists. Pass the capture's session token
 * whenever one exists: the shell no-ops a mismatched token, so a STALE
 * stop resolving late can never destroy a successor share's session
 * (diff-review MAJOR: stop-after-fresh-start — the mirror image of the §4
 * supersede rule). An untokened call stops whatever is live.
 */
export async function stopScreenAudio(sessionId?: number): Promise<void> {
  try {
    await shellSurface()?.stop(sessionId);
  } catch {
    // best-effort: a dead session is the goal state anyway
  }
}

/** Main's notice that the native session behind a capture died under it
 * (its loop thread exited: a core error, or the daemon removed the virtual
 * source). The renderer matches `sessionId` against its own capture before
 * acting; a notice for a stopped or superseded session is ignored. */
export interface ScreenAudioEnded {
  sessionId: number;
  reason?: string;
}

/**
 * Subscribe to that notice. Returns the unsubscribe; a no-op on shells
 * without the surface (older preloads), where the renderer's own device
 * watchdog (screenAudioLiveness.ts) is the only guard.
 */
export function onScreenAudioEnded(
  callback: (event: ScreenAudioEnded) => void,
): () => void {
  const shell = shellSurface();
  if (!shell?.onEnded) return () => undefined;
  try {
    return shell.onEnded(callback);
  } catch {
    return () => undefined;
  }
}
