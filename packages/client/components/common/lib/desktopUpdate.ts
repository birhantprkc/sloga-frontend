import { createSignal } from "solid-js";

import { tauriInvoke } from "./tauriInvoke";

/**
 * The in-app update arrow for the Windows desktop shell.
 *
 * The shell checks for updates on launch and hourly after that and caches
 * what it finds; this only reads that cache, so polling costs an IPC round
 * trip and no network. `undefined` means there is nothing to offer — the web
 * build, the Electron shell, Android, and any up-to-date desktop client all
 * sit here.
 *
 * Deliberately NOT the service worker's `pendingUpdate` from
 * `serviceWorkerInterface`: that path is disabled under Tauri, where the
 * signed installer is the sole version authority.
 */
const [pendingVersion, setPendingVersion] = createSignal<string>();
const [installing, setInstalling] = createSignal(false);

export {
  installing as desktopUpdateInstalling,
  pendingVersion as desktopUpdatePending,
};

/**
 * The shell only re-checks hourly, so this is about how fast the arrow
 * appears after it does, not about how fresh the answer is.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

let polling = false;

/**
 * Start watching for a pending desktop update. Safe to call more than once
 * and on every platform — it returns immediately unless we are inside the
 * Tauri shell, so callers need no guard of their own.
 *
 * Polled rather than driven by an event from the shell because the launch
 * check races the frontend booting: an event fired before anything was
 * listening would be lost, and the arrow would not appear until the next
 * hourly pass.
 */
export function watchDesktopUpdate() {
  const invoke = tauriInvoke();
  if (!invoke || polling) return;
  polling = true;

  const poll = () =>
    invoke<string | null>("desktop_update_pending")
      .then((version) => setPendingVersion(version ?? undefined))
      .catch((err) =>
        console.error("[desktop-update] pending check failed:", err),
      );

  poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

/**
 * Take the update: the shell downloads it, runs the installer silently and
 * relaunches us. On success this never resolves — the process is gone before
 * the promise can settle — so the only case worth handling is the failure,
 * where we are still running and the arrow should stay clickable.
 */
export async function installDesktopUpdate() {
  const invoke = tauriInvoke();
  if (!invoke || installing()) return;
  setInstalling(true);

  try {
    await invoke("desktop_update_install");
  } catch (err) {
    console.error("[desktop-update] install failed:", err);
    setInstalling(false);
  }
}
