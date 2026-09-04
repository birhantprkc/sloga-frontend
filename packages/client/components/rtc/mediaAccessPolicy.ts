/**
 * Microphone/camera access verdicts (a sibling of `outgoingRingPolicy` —
 * PURE so it is unit-testable in isolation).
 *
 * WHY THIS EXISTS. A denied microphone was invisible everywhere it mattered
 * (support report 2026-09-03: "it doesn't even appear to select in the voice
 * tab"). Pre-permission and post-denial, `enumerateDevices()` yields
 * placeholder entries with an empty `deviceId` and `label`; both device
 * pickers hide those rows on purpose (nothing selectable in them), so the
 * user saw an empty list with no explanation. And the join path swallowed
 * the capture failure: `Voice.onErr` drops every `NotAllowedError` because a
 * cancelled screen-share picker rejects with the same name, so the mic
 * rejection at join reached nobody — the call connected, silently muted.
 *
 * This module turns the two signals the browser does give us — the device
 * list shape and the Permissions API state — into one verdict the pickers
 * can render honestly, and names the capture errors the join path must
 * report instead of drop.
 */

/** The Permissions API names behind the three device kinds. */
export type MediaPermissionName = "microphone" | "camera";

/**
 * `PermissionStatus.state`, plus `unknown` for engines that cannot answer
 * (Firefox and Safari throw on `{ name: "microphone" }`).
 */
export type MediaPermissionState = "granted" | "denied" | "prompt" | "unknown";

/**
 * Which permission gates a device kind's labels. Output devices have no
 * permission of their own: Chromium reveals speaker labels only once the
 * MICROPHONE is granted, so the mic permission speaks for them too.
 */
export function permissionNameFor(kind: MediaDeviceKind): MediaPermissionName {
  return kind === "videoinput" ? "camera" : "microphone";
}

/**
 * A `getUserMedia` rejection that means "access is blocked" (by the user, the
 * browser, or the OS) rather than "no such device" or a bad constraint.
 * `PermissionDeniedError` is the legacy alias some engines still raise.
 */
export function isPermissionDeniedError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "NotAllowedError" || name === "PermissionDeniedError";
}

export type DeviceListVerdict =
  /** At least one selectable device: render the list as usual. */
  | "ok"
  /** Access is blocked: the list is empty because it CANNOT be filled. */
  | "denied"
  /** Access not granted yet (or unknowable): the list fills once it is. */
  | "needs-permission"
  /** Access granted and still nothing: no hardware of this kind. */
  | "none";

/**
 * What an empty-looking picker should say. A device with a non-empty id is
 * selectable whatever the permission signal says (a stale `denied` cannot
 * survive a successful enumeration), so a populated list always wins.
 */
export function deviceListVerdict(args: {
  devices: readonly { deviceId: string }[];
  permission: MediaPermissionState;
}): DeviceListVerdict {
  if (args.devices.some((device) => device.deviceId !== "")) return "ok";
  if (args.permission === "denied") return "denied";
  if (args.permission === "granted") return "none";
  return "needs-permission";
}
