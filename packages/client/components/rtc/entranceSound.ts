import type { Client } from "stoat.js";

import { CONFIGURATION } from "@revolt/common";
import type { Settings } from "@revolt/state/stores/Settings";

/**
 * Entrance sounds: a soundboard sound that plays for everyone when you join
 * a server voice channel. Discord parity (Voice & Video › Soundboard ›
 * Entrance Sounds): one choice for all servers plus per-server overrides.
 *
 * Storage is the SYNCED settings store, so the choice follows the account
 * across devices: `soundboard:entrance` (all servers, "" = none) and
 * `soundboard:entrance_servers` (server id → sound id, where "" means "none
 * here even though a global one is set").
 *
 * Playing it is just the ordinary trigger route (`channel.triggerSound`),
 * so it needs the same UseSoundboard permission as pressing the button and
 * plays through everyone's normal soundboard path — nothing new crosses the
 * wire.
 */

/** Marker value in the per-server map for "no entrance sound here". */
export const ENTRANCE_NONE = "";

/** The sound to trigger when joining a voice channel in `serverId`, if any. */
export function entranceSoundFor(
  settings: Settings,
  serverId: string,
): string | undefined {
  const overrides = settings.getValue("soundboard:entrance_servers") ?? {};
  if (Object.prototype.hasOwnProperty.call(overrides, serverId)) {
    return overrides[serverId] || undefined;
  }
  return settings.getValue("soundboard:entrance") || undefined;
}

/** A soundboard sound as the settings page lists it. */
export interface SoundboardSoundInfo {
  id: string;
  name: string;
  emoji?: string;
}

interface ServerSoundWire {
  _id: string;
  name: string;
  emoji?: string;
}

interface DefaultSoundWire {
  id: string;
  name: string;
  emoji?: string;
}

function authHeader(client: Client): Record<string, string> {
  const [key, value] = client.authenticationHeader;
  return { [key]: value };
}

/** Global "Sloga Sounds" — available in every server. */
export async function fetchDefaultSounds(
  client: Client,
): Promise<SoundboardSoundInfo[]> {
  const res = await fetch(
    `${CONFIGURATION.DEFAULT_API_URL}/custom/sounds/default`,
    { headers: authHeader(client) },
  );
  if (!res.ok) return [];
  const list = (await res.json()) as DefaultSoundWire[];
  return list.map((s) => ({ id: s.id, name: s.name, emoji: s.emoji }));
}

/** A server's own uploaded sounds. */
export async function fetchServerSounds(
  client: Client,
  serverId: string,
): Promise<SoundboardSoundInfo[]> {
  const res = await fetch(
    `${CONFIGURATION.DEFAULT_API_URL}/custom/server/${serverId}/sounds`,
    { headers: authHeader(client) },
  );
  if (!res.ok) return [];
  const list = (await res.json()) as ServerSoundWire[];
  return list.map((s) => ({ id: s._id, name: s.name, emoji: s.emoji }));
}

/** Public clip URL, for the settings-page preview button. */
export function soundboardClipUrl(soundId: string): string {
  return `${CONFIGURATION.DEFAULT_MEDIA_URL}/soundboard/${soundId}`;
}
