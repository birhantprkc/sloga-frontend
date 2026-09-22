/**
 * AFK channel — the PURE preset/payload core shared by the two surfaces that
 * configure a server's AFK channel (AFK plan A8 and A9): the create-channel
 * modal and channel settings. Extracted so `node --test` can load it; this
 * module must stay dependency-free — no Solid, no stoat.js, no lingui.
 *
 * 🔴 The designation is a SERVER field (`Server.afk_channel_id`) even though
 * both surfaces live in channel UI. Every write below is meant for
 * `server.edit(...)`; `channel.edit(...)` does not carry these fields and
 * would drop them without complaint.
 *
 * 🔴 Clearing the designation is NOT `afk_channel_id: null`. The backend
 * derives `PartialServer` through `OptionalStruct`, and the assigner it
 * generates for a field that is already `Option<T>` is `replace()` — so a null
 * arriving in the partial is a SILENT NO-OP that still answers 200. A clear
 * has to travel in the remove array as `FieldsServer::AfkChannel` (the backend
 * appends `AfkTimeout` itself), and the backend refuses any request that both
 * sets and removes the same field. That is the entire reason this mapping is a
 * tested function instead of an object literal at each call site: getting it
 * wrong looks like success.
 */

/**
 * Idle-timeout presets, in SECONDS — 1, 5, 15, 30 and 60 minutes.
 *
 * 🔴 The backend rejects anything outside this exact set; it does not clamp.
 * Both selects render from this list and every payload is checked against it,
 * so a value the UI can offer is always a value the route will accept.
 */
export const AFK_TIMEOUT_PRESETS = [60, 300, 900, 1800, 3600] as const;

/** One of the five accepted idle timeouts, in seconds. */
export type AfkTimeoutSeconds = (typeof AFK_TIMEOUT_PRESETS)[number];

/**
 * What a server with no idle timeout of its own gets offered: 5 minutes.
 * Discord's own default, and the middle of the preset range.
 */
export const AFK_TIMEOUT_FALLBACK: AfkTimeoutSeconds = 300;

/** Whether a number is one of the five timeouts the backend will accept. */
export function isAfkTimeoutPreset(
  value: number | undefined | null,
): value is AfkTimeoutSeconds {
  return (
    typeof value === "number" &&
    (AFK_TIMEOUT_PRESETS as readonly number[]).includes(value)
  );
}

/**
 * The idle timeout that will actually be in force, given whatever the server
 * currently holds.
 *
 * 🔴 This exists to satisfy a review condition, not for tidiness. Designating
 * a channel without naming a timeout makes the server KEEP the timeout it
 * already had — which may have been chosen for a different channel by someone
 * else. That is acceptable only while the UI shows the adopted value before
 * the user commits to it, so both surfaces seed their select from this and
 * then send the seeded value back explicitly. Nothing is adopted invisibly.
 */
export function effectiveAfkTimeout(
  serverAfkTimeout: number | undefined | null,
): AfkTimeoutSeconds {
  return isAfkTimeoutPreset(serverAfkTimeout)
    ? serverAfkTimeout
    : AFK_TIMEOUT_FALLBACK;
}

/**
 * The body of the `server.edit(...)` that designates a voice channel as the
 * AFK channel, or clears the designation.
 *
 * The return type is a union on purpose: the "set" arm cannot carry `remove`
 * and the "clear" arm cannot carry `afk_channel_id`, so the request the
 * backend refuses — setting and removing the same field — is unrepresentable
 * rather than merely avoided.
 */
export type AfkDesignationEdit =
  | { afk_channel_id: string; afk_timeout: AfkTimeoutSeconds }
  | { remove: readonly ["AfkChannel"] };

/**
 * Build that body.
 *
 * `timeoutSeconds` is the value the user can see in the select; it is sent on
 * every designation so the adopted timeout is the shown timeout. A value that
 * is somehow not a preset falls back rather than being sent for the backend to
 * reject, because the select can only ever hold a preset.
 */
export function afkDesignationEdit(input: {
  /** True to make `channelId` the AFK channel, false to clear the server's. */
  designate: boolean;
  channelId: string;
  timeoutSeconds: number;
}): AfkDesignationEdit {
  if (!input.designate) {
    // 🔴 Never `{ afk_channel_id: null }` — see the module header.
    return { remove: ["AfkChannel"] as const };
  }

  return {
    afk_channel_id: input.channelId,
    afk_timeout: effectiveAfkTimeout(input.timeoutSeconds),
  };
}

/**
 * The body of the `server.edit(...)` that changes only the idle timeout, or
 * `undefined` when there is nothing legitimate to send.
 *
 * 🔴 `afk_timeout` is meaningless without a designated channel and the backend
 * refuses it outright, so an undesignated server yields `undefined`. The check
 * is pointer identity against THIS channel as well: a channel's settings page
 * may only speak for its own designation, never edit the timeout belonging to
 * a different channel the server happens to have designated.
 */
export function afkTimeoutEdit(input: {
  /** `server.afkChannelId` — `undefined`, never null, when unset. */
  afkChannelId: string | undefined;
  channelId: string;
  timeoutSeconds: number;
}): { afk_timeout: AfkTimeoutSeconds } | undefined {
  if (!input.afkChannelId || input.afkChannelId !== input.channelId) {
    return undefined;
  }
  if (!isAfkTimeoutPreset(input.timeoutSeconds)) return undefined;
  return { afk_timeout: input.timeoutSeconds };
}

/**
 * The extra fields the create-channel modal folds into its
 * `server.createChannel(...)` body.
 *
 * 🔴 The route rejects `afk: true` on anything that is not a Voice channel, so
 * the flag is dropped rather than sent whenever the selected type is not
 * Voice — the same shape the existing `announcement` field uses for text
 * channels. A user who ticks AFK and then switches the type back to Text does
 * not get a 400; they get a plain text channel.
 */
export function afkCreateChannelFields(input: {
  /** The radio value: "Text", "Voice" or "Forum". */
  channelType: string;
  afk: boolean;
  timeoutSeconds: number;
}): { afk?: true; afk_timeout?: AfkTimeoutSeconds } {
  if (input.channelType !== "Voice" || !input.afk) return {};
  return {
    afk: true,
    afk_timeout: effectiveAfkTimeout(input.timeoutSeconds),
  };
}
