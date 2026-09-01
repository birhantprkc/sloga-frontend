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

/** Last probe outcome, for synchronous UI (the settings-modal copy gate).
 * `undefined` until the first probe resolves. */
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
 * Start the native session and capture its device. Returns the track with
 * its session token, or null on any failure — the caller degrades to a
 * no-audio share (audio is an enhancement; the video share already
 * succeeded, §4). The internal error path stops exactly the session it
 * started (by token), never a successor's.
 */
export async function captureScreenAudio(): Promise<ScreenAudioCapture | null> {
  const shell = shellSurface();
  if (!shell) return null;
  let sessionId: number | undefined;
  let track: MediaStreamTrack | undefined;
  try {
    const started = await shell.start();
    sessionId = started.sessionId;
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
