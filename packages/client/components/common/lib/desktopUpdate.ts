import { createSignal } from "solid-js";

import { tauriInvoke } from "./tauriInvoke";

/**
 * The in-app update arrow for the Windows desktop shell.
 *
 * The shell checks for updates on launch, on a timer, and whenever the window
 * takes focus, and caches what it finds; this reads that cache and listens for
 * changes to it, so neither path costs a network request of its own.
 * `undefined` means there is nothing to offer — the web build, the Electron
 * shell, Android, and any up-to-date desktop client all sit here.
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
 * How often to ask the shell again anyway. This is the fallback, not the
 * mechanism — the event below is what normally moves the arrow — so it only
 * has to be short enough to cover an event that never bound.
 */
const POLL_INTERVAL_MS = 5 * 60 * 1000;

type TauriEventApi = {
  event: {
    listen(
      name: string,
      cb: (event: { payload: string | null }) => void,
    ): Promise<() => void>;
  };
};

let polling = false;

/**
 * Start watching for a pending desktop update. Safe to call more than once
 * and on every platform — it returns immediately unless we are inside the
 * Tauri shell, so callers need no guard of their own.
 *
 * Both halves earn their place. The event carries a change the moment the
 * shell's check finds it, which is what puts the arrow up while someone is
 * sitting in front of the app rather than on their next launch. The poll is
 * there because the launch check races the frontend booting: an event fired
 * before anything was listening is simply lost, and the arrow would then wait
 * for the shell to change its mind about something.
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

  const tauri = (window as { __TAURI__?: TauriEventApi }).__TAURI__;
  tauri?.event
    .listen("desktop-update-pending", (event) =>
      setPendingVersion(event.payload ?? undefined),
    )
    .catch((err) =>
      console.error("[desktop-update] event subscribe failed:", err),
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
