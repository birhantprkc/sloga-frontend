/**
 * Transport seam between the publisher (main window) and the overlay window.
 *
 * The transport is `BroadcastChannel`, which the slice-0 spike measured
 * end-to-end across two WebView2 windows on the app origin: 952/955 snapshots
 * delivered, both directions including the `hello` reverse leg, 0–1 ms
 * one-way. Chromium (the Electron shell) was never in doubt.
 *
 * The `publish` / `subscribe` indirection survives that result deliberately.
 * It is nearly free, and it is the difference between "swap the transport"
 * and "rewrite both ends" if a future WebView2 ever regresses — the shells
 * can relay the same messages over `emit`/`listen` instead (also measured
 * working in the spike) without any caller changing.
 *
 * Both windows are same-origin (`https://tauri.localhost` / `app://bundle`)
 * and navigation is origin-locked per window on both shells, so the channel
 * reaches the overlay and nothing else. A second app instance under a
 * different profile gets a different storage partition and cannot hear it.
 */
import { OVERLAY_CHANNEL, OverlayMsg, parseOverlayMsg } from "./protocol";

export type OverlayBridge = {
  publish(msg: OverlayMsg): void;
  /** Returns an unsubscribe function. */
  subscribe(handler: (msg: OverlayMsg) => void): () => void;
  close(): void;
};

/**
 * Open the channel. Returns undefined where `BroadcastChannel` does not exist
 * — no shell we ship on is in that position, but the renderer must degrade to
 * "blank overlay" rather than throwing in a window that has no error boundary
 * and no way to report a failure to anyone.
 */
export function openOverlayBridge(): OverlayBridge | undefined {
  if (typeof BroadcastChannel !== "function") return undefined;

  let channel: BroadcastChannel;
  try {
    channel = new BroadcastChannel(OVERLAY_CHANNEL);
  } catch {
    return undefined;
  }

  const handlers = new Set<(msg: OverlayMsg) => void>();

  channel.onmessage = (event) => {
    // Unknown version or type is ignored, not thrown on: a newer publisher
    // talking to an older overlay is a real state for as long as it takes the
    // user to reload the main window after an update.
    const msg = parseOverlayMsg(event.data);
    if (!msg) return;
    for (const handler of handlers) handler(msg);
  };

  return {
    publish(msg) {
      try {
        channel.postMessage(msg);
      } catch {
        /* a closed channel must not take the caller down */
      }
    },
    subscribe(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    close() {
      handlers.clear();
      try {
        channel.close();
      } catch {
        /* already closed */
      }
    },
  };
}
