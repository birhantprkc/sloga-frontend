/**
 * The renderer's own line of defense for a native screen-audio session that
 * dies under a live share (design §4's "PipeWire daemon restart mid-share"
 * failure mode, whose assumption turned out to be wrong in the field).
 *
 * The assumption was: the virtual source dies → the gUM track fires `ended`
 * → livekit unpublishes. Under pipewire-pulse none of that happens. The
 * record stream is MIGRATED to the default source — the user's microphone —
 * the track never ends, and the ScreenShareAudio publication keeps sending,
 * now carrying the mic and immune to the mic mute (velvetfly, 2026-09-04,
 * PipeWire 1.0.5 / WirePlumber 0.4.17).
 *
 * The shell reports a dead session over IPC (its liveness poll), and this
 * module backs that with something the renderer can verify on its own: the
 * capture device it matched at start is still enumerated. Pure so the rule
 * is pinned under `node --test`.
 */

/** How often the renderer re-checks that its capture device still exists.
 * Two seconds bounds how long a migrated stream can leak the microphone if
 * the shell's notice never arrives; enumerateDevices is cheap at this rate. */
export const SCREEN_AUDIO_WATCH_MS = 2000;

/**
 * True when the audio input the capture was started on is no longer
 * enumerated. A blank label never trips it — the same rule findDeviceId
 * applies at start: a blank label must not match anything, and here it must
 * not mismatch everything either, or a track whose label the engine blanked
 * would be torn down every two seconds.
 */
export function screenAudioDeviceGone(
  devices: ReadonlyArray<{ kind: string; label: string }>,
  label: string,
): boolean {
  if (!label) return false;
  return !devices.some((d) => d.kind === "audioinput" && d.label === label);
}
