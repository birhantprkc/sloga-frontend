/**
 * Tiny typed Jellyfin client for watch-together (plan §2/§5): auth, browse,
 * PlaybackInfo, playstate reporting. Every request goes through
 * `transport.ts` (never builds a URL itself) and carries the `MediaBrowser`
 * Authorization header. Sloga is never on the path — this talks straight to
 * the viewer's own Jellyfin from the viewer's own machine.
 */
import {
  authorizationHeader,
  buildDeviceProfile,
  imagePath,
  parseTranscodeState,
  probeCodecs,
  qualityBps,
  ticksToMs,
  type CodecSupport,
  type TranscodeState,
} from "./jellyfinWire";
import { deviceId, type SavedServer } from "./servers";
import { fetchJellyfin, mediaUrl } from "./transport";

// Shown only in the user's own Jellyfin dashboard; the client has no
// version constant, so a stable label is enough (the DeviceId, not this,
// is what Jellyfin keys sessions on).
const CLIENT_VERSION = "1.0";
const DEVICE_NAME = "Sloga";

/** Public server info from `System/Info/Public` (unauthenticated). */
export interface PublicInfo {
  ServerName: string;
  Id: string;
  Version: string;
}

export interface AuthResult {
  AccessToken: string;
  User: { Id: string; Name: string };
}

export interface JfItem {
  Id: string;
  Name: string;
  Type: string;
  IsFolder?: boolean;
  CollectionType?: string;
  SeriesName?: string;
  ParentIndexNumber?: number;
  IndexNumber?: number;
  ProductionYear?: number;
  RunTimeTicks?: number;
  UserData?: { PlaybackPositionTicks?: number; Played?: boolean };
  ImageTags?: { Primary?: string };
}

export interface PlaybackChoice {
  playSessionId: string;
  mediaSourceId: string;
  /** Relative TranscodingUrl (carries ApiKey= in its query). */
  transcodingUrl: string;
  runtimeMs: number;
}

class JfError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A per-server client. Constructed with a saved server (auth done) OR with a
 * bare base for the connect flow (token added after auth).
 */
export class JellyfinApi {
  #server: SavedServer;

  constructor(server: SavedServer) {
    this.#server = server;
  }

  get server(): SavedServer {
    return this.#server;
  }

  #headers(token: string | null, extra?: Record<string, string>): Headers {
    const h = new Headers(extra);
    h.set(
      "Authorization",
      authorizationHeader({
        deviceId: deviceId(),
        deviceName: DEVICE_NAME,
        version: CLIENT_VERSION,
        token,
      }),
    );
    return h;
  }

  async #json<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
    const { token, headers, ...rest } = init;
    const merged = this.#headers(token ?? this.#server.token ?? null, {
      ...(rest.body ? { "Content-Type": "application/json" } : {}),
      ...(headers as Record<string, string> | undefined),
    });
    let res: Response;
    try {
      res = await fetchJellyfin(this.#server, path, { ...rest, headers: merged });
    } catch (e) {
      throw new JfError(0, e instanceof Error ? e.message : "network");
    }
    if (!res.ok) throw new JfError(res.status, `HTTP ${res.status}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  // ---- unauthenticated ----------------------------------------------------

  /** `GET /System/Info/Public` — confirms the box and gets its id/name. */
  static async probe(baseUrl: string): Promise<PublicInfo> {
    const tmp = new JellyfinApi({
      id: "probe",
      name: "",
      baseUrl,
      token: "",
      userId: "",
    });
    return tmp.#json<PublicInfo>("/System/Info/Public");
  }

  quickConnectEnabled(): Promise<boolean> {
    return this.#json<boolean>("/QuickConnect/Enabled", { token: null });
  }

  /** `POST /QuickConnect/Initiate` — needs the token-LESS header (§7.1). */
  quickConnectInitiate(): Promise<{ Code: string; Secret: string }> {
    return this.#json("/QuickConnect/Initiate", { method: "POST", token: null });
  }

  quickConnectState(secret: string): Promise<{ Authenticated: boolean }> {
    return this.#json(`/QuickConnect/Connect?secret=${encodeURIComponent(secret)}`, { token: null });
  }

  authenticateWithQuickConnect(secret: string): Promise<AuthResult> {
    return this.#json<AuthResult>("/Users/AuthenticateWithQuickConnect", {
      method: "POST",
      token: null,
      body: JSON.stringify({ Secret: secret }),
    });
  }

  authenticateByName(username: string, password: string): Promise<AuthResult> {
    return this.#json<AuthResult>("/Users/AuthenticateByName", {
      method: "POST",
      token: null,
      body: JSON.stringify({ Username: username, Pw: password }),
    });
  }

  // ---- authenticated browse ----------------------------------------------

  views(): Promise<{ Items: JfItem[] }> {
    return this.#json(`/Users/${this.#server.userId}/Views`);
  }

  /** Items under a parent (or search), watchable + browsable kinds. */
  items(opts: { parentId?: string; searchTerm?: string; limit?: number }): Promise<{ Items: JfItem[]; TotalRecordCount: number }> {
    const q = new URLSearchParams({
      Recursive: opts.searchTerm ? "true" : String(!opts.parentId),
      IncludeItemTypes: "Movie,Series,Season,Episode,Video,MusicVideo,BoxSet",
      SortBy: "SortName",
      Fields: "Overview,RunTimeTicks,ProductionYear",
      Limit: String(opts.limit ?? 100),
    });
    if (opts.parentId) q.set("ParentId", opts.parentId);
    if (opts.searchTerm) q.set("SearchTerm", opts.searchTerm);
    return this.#json(`/Users/${this.#server.userId}/Items?${q}`);
  }

  resume(limit = 12): Promise<{ Items: JfItem[] }> {
    return this.#json(`/Users/${this.#server.userId}/Items/Resume?Limit=${limit}&MediaTypes=Video`);
  }

  item(itemId: string): Promise<JfItem> {
    return this.#json(`/Users/${this.#server.userId}/Items/${itemId}`);
  }

  /** Primary image URL for a list thumbnail (no auth needed — §7.1). */
  imageUrl(itemId: string, maxWidth: number, tag?: string | null): string {
    return mediaUrl(this.#server, imagePath(itemId, { maxWidth, tag }));
  }

  // ---- playback -----------------------------------------------------------

  /**
   * `POST /Items/{id}/PlaybackInfo` with a DeviceProfile. v1 always plays
   * the returned HLS `TranscodingUrl`. Codec support probed from the real
   * `MediaSource.isTypeSupported`.
   */
  async playbackInfo(itemId: string, qualityId: string, codecs?: CodecSupport): Promise<PlaybackChoice> {
    const support =
      codecs ??
      probeCodecs((m) =>
        typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function"
          ? MediaSource.isTypeSupported(m)
          : false,
      );
    const profile = { DeviceProfile: buildDeviceProfile(qualityBps(qualityId), support) };
    const body = {
      ...profile,
      AllowVideoStreamCopy: true,
      AllowAudioStreamCopy: true,
      AutoOpenLiveStream: true,
      EnableDirectPlay: false,
      EnableDirectStream: false,
      EnableTranscoding: true,
      StartTimeTicks: 0,
    };
    const r = await this.#json<{
      PlaySessionId: string;
      MediaSources: Array<{ Id: string; TranscodingUrl?: string; RunTimeTicks?: number }>;
    }>(`/Items/${itemId}/PlaybackInfo?userId=${this.#server.userId}`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const src = r.MediaSources?.[0];
    if (!src?.TranscodingUrl) {
      // Direct play is off, so Jellyfin should always return a transcode
      // URL; if it didn't, the item can't be played through our one path.
      throw new JfError(415, "no transcoding stream for this item");
    }
    return {
      playSessionId: r.PlaySessionId,
      mediaSourceId: src.Id,
      transcodingUrl: src.TranscodingUrl,
      runtimeMs: ticksToMs(src.RunTimeTicks),
    };
  }

  /** The fetchable master.m3u8 URL for hls.js (relative URL → transport). */
  hlsUrl(transcodingUrl: string): string {
    return mediaUrl(this.#server, transcodingUrl);
  }

  // ---- playstate (MANDATORY — §5.5, or the server keeps transcoding) ------

  reportPlaying(p: { itemId: string; playSessionId: string; mediaSourceId: string; positionMs: number; paused: boolean }): Promise<void> {
    return this.#playstate("/Sessions/Playing", p);
  }
  reportProgress(p: { itemId: string; playSessionId: string; mediaSourceId: string; positionMs: number; paused: boolean }): Promise<void> {
    return this.#playstate("/Sessions/Playing/Progress", p);
  }
  /** `keepalive` so it still fires from a `pagehide` handler as the tab
   * closes — without it the server keeps transcoding for a gone viewer. */
  reportStopped(p: { itemId: string; playSessionId: string; mediaSourceId: string; positionMs: number }): Promise<void> {
    return this.#playstate("/Sessions/Playing/Stopped", { ...p, paused: false }, true);
  }

  #playstate(
    path: string,
    p: { itemId: string; playSessionId: string; mediaSourceId: string; positionMs: number; paused: boolean },
    keepalive = false,
  ): Promise<void> {
    return this.#json<void>(path, {
      method: "POST",
      keepalive,
      body: JSON.stringify({
        ItemId: p.itemId,
        PlaySessionId: p.playSessionId,
        MediaSourceId: p.mediaSourceId,
        PositionTicks: Math.max(0, Math.round(p.positionMs * 10_000)),
        IsPaused: p.paused,
        CanSeek: true,
        PlayMethod: "Transcode",
      }),
    }).catch(() => undefined); // best-effort; playback continues if these fail
  }

  /** Free the server's ffmpeg for a departed viewer (§5.5). `keepalive` so
   * it survives the page unload it is most often fired from. */
  async stopTranscode(playSessionId: string): Promise<void> {
    await this.#json<void>(
      `/Videos/ActiveEncodings?deviceId=${encodeURIComponent(deviceId())}&playSessionId=${encodeURIComponent(playSessionId)}`,
      { method: "DELETE", keepalive: true },
    ).catch(() => undefined);
  }

  /** Our device's transcode state for the stats overlay (§7.1). */
  async transcodeState(): Promise<TranscodeState | null> {
    try {
      const sessions = await this.#json<unknown>(`/Sessions?deviceId=${encodeURIComponent(deviceId())}`);
      return parseTranscodeState(sessions, deviceId());
    } catch {
      return null;
    }
  }
}

export { JfError };
