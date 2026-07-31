/**
 * The overlay's window-management seam.
 *
 * Both desktop shells expose the SAME three methods, so the frontend has one
 * code path and neither shell leaks into the publisher:
 *
 * | | Tauri (Windows) | Electron (Linux) |
 * |---|---|---|
 * | open | `open_voice_overlay` | `slogaShell.voiceOverlay.open()` |
 * | close | `close_voice_overlay` | `…close()` |
 * | setBounds | `voice_overlay_set_bounds` | `…setBounds()` |
 *
 * **`setBounds` carries the corner.** The corner lives in the frontend
 * settings store and neither shell holds a copy, so without it in the payload
 * no shell can compute x/y. The renderer measures its own content and sends
 * `{ width, height, corner }`; the shell owns the arithmetic against the work
 * area of whichever monitor it decides is right.
 */
import { tauriInvoke } from "@revolt/common";

import { OverlayCorner } from "./protocol";

export type OverlayBounds = {
  width: number;
  height: number;
  corner: OverlayCorner;
};

export type OverlayShell = {
  open(): void;
  close(): void;
  setBounds(bounds: OverlayBounds): void;
};

/** Electron preload surface, exposed only on the shells that have it. */
type ElectronOverlayShell = {
  open(): void;
  close(): void;
  setBounds(bounds: OverlayBounds): void;
};

function electronOverlay(): ElectronOverlayShell | undefined {
  if (typeof window === "undefined") return undefined;
  return (
    window as {
      slogaShell?: { voiceOverlay?: ElectronOverlayShell };
    }
  ).slogaShell?.voiceOverlay;
}

/**
 * Whether this build can open an overlay window at all.
 *
 * Gates BOTH the settings section and the publisher worker, so on release web
 * the feature is dark by construction — no shell, no entry point, no settings
 * UI — with no `VITE_CFG_*` flag needed.
 *
 * The `import.meta.env.DEV` arm is load-bearing rather than convenient:
 * without it the whole dev loop is unreachable, because the settings toggle
 * would be hidden and the publisher would never arm, so there would be
 * nothing to test the renderer against until a shell slice landed. It
 * compiles out of production web builds.
 */
export function overlayShellAvailable(): boolean {
  return !!tauriInvoke() || !!electronOverlay() || import.meta.env.DEV;
}

/**
 * Plain-browser dev loop: a normal popup window on the same origin, which is
 * all BroadcastChannel needs. `setBounds` is a no-op — self-sizing is the
 * shell's job and a browser popup does not have one. Never ships.
 */
const DEV_WINDOW_SHIM: OverlayShell = {
  open() {
    // Reusing the window NAME makes this idempotent, which the ensure-open
    // heartbeat depends on: a second open() must not spawn a second popup.
    window.open(
      "/voice-overlay",
      "sloga-voice-overlay",
      "width=320,height=220,resizable=yes,popup=yes",
    );
  },
  close() {
    // A window opened with a name can be re-fetched and closed by opening it
    // again with `about:blank`-free args; simplest reliable form is to reopen
    // by name and close the handle we get back.
    const handle = window.open("", "sloga-voice-overlay");
    handle?.close();
  },
  setBounds() {
    /* no-op in the browser dev loop */
  },
};

/**
 * The active shell, or undefined when there is no way to open a window.
 */
export function overlayShell(): OverlayShell | undefined {
  const invoke = tauriInvoke();
  if (invoke) {
    return {
      open: () => void invoke("open_voice_overlay").catch(console.error),
      close: () => void invoke("close_voice_overlay").catch(console.error),
      setBounds: (bounds) =>
        void invoke("voice_overlay_set_bounds", { ...bounds }).catch(
          console.error,
        ),
    };
  }

  const electron = electronOverlay();
  if (electron) return electron;

  if (import.meta.env.DEV) return DEV_WINDOW_SHIM;
  return undefined;
}

/**
 * Linux session type, for the settings notice. Wayland cannot be asked to
 * keep a client above a game, so the UI says so rather than promising it.
 * Every other shell answers "x11" (i.e. "no notice"), which is right: on
 * Windows the question does not arise.
 */
export function overlaySessionType(): "x11" | "wayland" {
  if (typeof window === "undefined") return "x11";
  const query = (
    window as {
      slogaShell?: {
        voiceOverlay?: { capability?(): { sessionType?: string } };
      };
    }
  ).slogaShell?.voiceOverlay?.capability;
  if (!query) return "x11";
  try {
    return query()?.sessionType === "wayland" ? "wayland" : "x11";
  } catch {
    return "x11";
  }
}
