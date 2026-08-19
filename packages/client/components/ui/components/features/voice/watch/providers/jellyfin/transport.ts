/**
 * Jellyfin transport (plan §5.3): the ONE place a Jellyfin URL is built and
 * the ONE place a request is issued, so providers/api never hard-code an
 * origin. The carrier differs per shell:
 *
 * - **Web** — direct to the (HTTPS-or-loopback) server; relies on
 *   Jellyfin's `Access-Control-Allow-Origin: *` (verified 10.11, §7.1).
 * - **Tauri (Windows)** — `https://jf.localhost/{server_id}/…`, forwarded
 *   natively to the SAVED server (src-tauri/src/jellyfin.rs). Handles
 *   `http://`, LAN, self-signed.
 * - **Electron (Linux)** — `jf://{server_id}/…`, same forwarding
 *   (electron-shell/src/jellyfin.js).
 * - **Android** — no transport yet (slice 3); `available()` is false there.
 *
 * The desktop shells forward ONLY to servers the viewer saved. This module
 * pushes the saved-server list down to the shell (`registerServers`)
 * whenever it changes; an id the shell doesn't know is a 404, so a watch
 * session naming a server the viewer never added cannot make their client
 * contact an arbitrary URL (plan §5.1).
 *
 * Sloga is never on the media path: this is the viewer's own machine
 * fetching from the viewer's own Jellyfin.
 */
import { Capacitor } from "@capacitor/core";

import { tauriInvoke } from "@revolt/common";

import { type ShellKind, transportUrl, webTransportProblem } from "./jellyfinWire";
import type { SavedServer } from "./servers";

interface TauriGlobal {
  core?: { invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> };
}
interface ElectronJellyfin {
  setServers(servers: unknown): Promise<number>;
}
interface SlogaShell {
  jellyfin?: ElectronJellyfin;
}

/** Which shell we run in (plan §5.3). Frozen per document. */
export function shellKind(): ShellKind {
  if (typeof window === "undefined") return "web";
  if ((window as { __TAURI__?: TauriGlobal }).__TAURI__?.core?.invoke) return "tauri";
  if ((window as { slogaShell?: SlogaShell }).slogaShell?.jellyfin) return "electron";
  try {
    if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android") return "android";
  } catch {
    /* not in a Capacitor build */
  }
  return "web";
}

/**
 * Can this shell reach `baseUrl` at all? Web can't do mixed content or a
 * LAN address from the public origin; Android has no transport in v1. The
 * desktop shells can reach anything the user saved.
 */
export function transportProblem(
  baseUrl: string,
): "mixed-content" | "android-unsupported" | null {
  const kind = shellKind();
  if (kind === "android") return "android-unsupported";
  if (kind === "web") {
    const proto = typeof location !== "undefined" ? location.protocol : "https:";
    return webTransportProblem(proto, baseUrl);
  }
  return null;
}

/** Push the saved-server list to the native shell's forwarder. No-op on web. */
export async function registerServers(servers: SavedServer[]): Promise<void> {
  const kind = shellKind();
  const list = servers.map((s) => ({
    id: s.id,
    baseUrl: s.baseUrl,
    trustSelfSigned: s.trustSelfSigned === true,
  }));
  if (kind === "tauri") {
    const invoke = tauriInvoke();
    if (invoke) {
      try {
        await invoke("jf_set_servers", { servers: list });
      } catch {
        /* ACL/absent — provider will surface fetch failures */
      }
    }
    return;
  }
  if (kind === "electron") {
    const jf = (window as { slogaShell?: SlogaShell }).slogaShell?.jellyfin;
    if (jf) {
      try {
        await jf.setServers(list);
      } catch {
        /* swallowed like the shell's other fire-and-forget verbs */
      }
    }
  }
}

/** Build a fetchable URL for a Jellyfin path against a saved server. */
export function mediaUrl(server: SavedServer, path: string): string {
  const kind = shellKind();
  if (kind === "android") {
    // No transport yet — return the direct URL so an <img> at least tries;
    // hls.js/api go through fetchJellyfin(), which throws on android.
    return `${server.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  }
  return transportUrl(kind, { id: server.id, baseUrl: server.baseUrl }, path);
}

/**
 * Issue a request to a Jellyfin path. `credentials: "omit"` always — the
 * token rides in the Authorization header or the query, never in a cookie
 * (Jellyfin's ACAO is `*`, which forbids credentialed CORS anyway).
 */
export async function fetchJellyfin(
  server: SavedServer,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (shellKind() === "android") {
    throw new Error("Jellyfin isn't available on Android yet");
  }
  return fetch(mediaUrl(server, path), { ...init, credentials: "omit" });
}
