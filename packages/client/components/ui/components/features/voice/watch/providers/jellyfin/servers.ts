/**
 * Saved Jellyfin servers + tokens — PER DEVICE (plan §5.2).
 *
 * These live in localStorage under `sloga:watch:jellyfin:servers`, NOT the
 * synced settings KV: that store is plaintext server-side, and Sloga's DB
 * must never hold credentials to users' own media servers. A token here is
 * a bearer credential to the viewer's Jellyfin — it never leaves this
 * device and never crosses a Sloga server.
 *
 * The store is deliberately tiny and dependency-free (no IndexedDB): a
 * handful of servers, read on connect, written on sign-in. The `DeviceId`
 * is stable per device (Jellyfin keys transcode sessions and "continue
 * watching" on it) and is minted once here.
 */
const LS_SERVERS = "sloga:watch:jellyfin:servers";
const LS_DEVICE_ID = "sloga:watch:jellyfin:deviceId";
const LS_QUALITY = "sloga:watch:jellyfin:quality";

export interface SavedServer {
  /** Jellyfin `System/Info/Public` server id — the forwarding key. */
  id: string;
  /** Human name from `System/Info/Public.ServerName`. */
  name: string;
  /** Normalized base URL (no trailing slash). */
  baseUrl: string;
  /** Bearer token from AuthenticateBy{Name,QuickConnect}. */
  token: string;
  /** Jellyfin user id the token belongs to. */
  userId: string;
  /** Only relaxation: trust this server's self-signed cert (desktop only). */
  trustSelfSigned?: boolean;
  /** Local ms of last successful use, for ordering the picker. */
  lastUsed?: number;
}

function read(): SavedServer[] {
  try {
    const raw = localStorage.getItem(LS_SERVERS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (s): s is SavedServer =>
        !!s &&
        typeof s.id === "string" &&
        typeof s.baseUrl === "string" &&
        typeof s.token === "string" &&
        typeof s.userId === "string",
    );
  } catch {
    return [];
  }
}

function write(servers: SavedServer[]): void {
  try {
    localStorage.setItem(LS_SERVERS, JSON.stringify(servers));
  } catch {
    /* private mode / quota — the store is best-effort */
  }
}

export function listServers(): SavedServer[] {
  return read().sort((a, b) => (b.lastUsed ?? 0) - (a.lastUsed ?? 0));
}

export function getServer(id: string): SavedServer | undefined {
  return read().find((s) => s.id === id);
}

/** Insert or replace (by server id); returns the full updated list. */
export function saveServer(server: SavedServer): SavedServer[] {
  const rest = read().filter((s) => s.id !== server.id);
  const next = [{ ...server, lastUsed: server.lastUsed ?? nowMs() }, ...rest];
  write(next);
  return next;
}

export function removeServer(id: string): SavedServer[] {
  const next = read().filter((s) => s.id !== id);
  write(next);
  return next;
}

export function touchServer(id: string): void {
  const servers = read();
  const s = servers.find((x) => x.id === id);
  if (!s) return;
  s.lastUsed = nowMs();
  write(servers);
}

/**
 * A device id the shells' forwarders accept (alphanumeric + `-`/`_`, 8-64
 * chars — see jellyfin.rs `valid_id` / jellyfin.js `validId`) and Jellyfin
 * keys transcode sessions on. A hyphenless UUID keeps it well inside those
 * bounds.
 */
function mintDeviceId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `sloga${uuid.replace(/-/g, "")}`;
  } catch {
    /* fall through */
  }
  let s = "sloga";
  for (let i = 0; i < 24; i++) s += Math.floor(Math.random() * 36).toString(36);
  return s;
}

/** Stable per-device id, minted once (Jellyfin ties sessions to it). */
export function deviceId(): string {
  try {
    const existing = localStorage.getItem(LS_DEVICE_ID);
    if (existing) return existing;
    const id = mintDeviceId();
    localStorage.setItem(LS_DEVICE_ID, id);
    return id;
  } catch {
    // No storage → a per-session id. Continue-watching won't persist, but
    // playback works.
    return mintDeviceId();
  }
}

export function getQuality(): string {
  try {
    return localStorage.getItem(LS_QUALITY) ?? "20";
  } catch {
    return "20";
  }
}

export function setQuality(id: string): void {
  try {
    localStorage.setItem(LS_QUALITY, id);
  } catch {
    /* best-effort */
  }
}

function nowMs(): number {
  return Date.now();
}
