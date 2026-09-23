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
 *
 * 🔴 "Never" (no idle timeout, nobody is auto-moved) is a real choice, and it
 * is cleared the same way: `remove: ["AfkTimeout"]`, never an
 * `afk_timeout: null`, for the same `OptionalStruct` reason. It is also why
 * the select value is parsed by `parseAfkTimeoutChoice` rather than `Number`:
 * `Number("never")` is NaN, and `effectiveAfkTimeout` turns NaN into five
 * minutes — the exact falsehood "Never" exists to remove.
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

/** The select value, and the choice, meaning "no idle timeout at all". */
export const AFK_TIMEOUT_NEVER = "never" as const;

/**
 * What the idle-timeout select can hold: one of the five presets, or "never".
 * "Never" is the backend's `afk_timeout: None` — the channel is designated
 * but nobody is ever moved into it.
 */
export type AfkTimeoutChoice = AfkTimeoutSeconds | typeof AFK_TIMEOUT_NEVER;

/**
 * The choice to SHOW for whatever the server currently holds.
 *
 * 🔴 A server with no timeout shows "never", not the five-minute fallback.
 * Showing five minutes for `None` claims idle members will be moved when
 * nothing will ever move them. `effectiveAfkTimeout` is not used for the
 * `None` case for exactly that reason; it still handles a number the route
 * would now reject, which is not a "never" — the server does hold a timeout —
 * and must not be echoed straight back into a PATCH.
 */
export function afkTimeoutChoice(
  serverAfkTimeout: number | undefined | null,
): AfkTimeoutChoice {
  if (serverAfkTimeout === undefined || serverAfkTimeout === null) {
    return AFK_TIMEOUT_NEVER;
  }
  return effectiveAfkTimeout(serverAfkTimeout);
}

/**
 * Read a select value back into a choice, or `undefined` for anything the
 * select cannot hold.
 *
 * 🔴 Never `Number(value)` on this select: `Number("never")` is NaN, and every
 * numeric path below would turn NaN into the five-minute fallback — a "Never"
 * the user picked would be saved as five minutes. There is no fallback here on
 * purpose; a caller that gets `undefined` must refuse, not guess a timeout.
 */
export function parseAfkTimeoutChoice(
  value: string,
): AfkTimeoutChoice | undefined {
  if (value === AFK_TIMEOUT_NEVER) return AFK_TIMEOUT_NEVER;
  const seconds = Number(value);
  return isAfkTimeoutPreset(seconds) ? seconds : undefined;
}

/**
 * The timeout half of an edit's input: either the numeric form (a raw
 * number of seconds, the original shape these builders took) or a parsed
 * `AfkTimeoutChoice`, which is the only form that can say "never". Exactly
 * one of the two. Channel settings pass the parsed form.
 */
export type AfkTimeoutInput =
  | { timeoutSeconds: number; timeout?: never }
  | { timeout: AfkTimeoutChoice; timeoutSeconds?: never };

/**
 * The body of the `server.edit(...)` that designates a voice channel as the
 * AFK channel, or clears the designation.
 *
 * The return type is a union on purpose, so every request the backend refuses
 * — setting and removing the SAME field — is unrepresentable rather than
 * merely avoided:
 * - set with a timeout: `afk_channel_id` + `afk_timeout`, no `remove`;
 * - set with "never": `afk_channel_id` + `remove: ["AfkTimeout"]`, no
 *   `afk_timeout`. Setting one field while removing a different one is
 *   allowed — the backend's collision check is per field;
 * - clear: `remove: ["AfkChannel"]` only, no `afk_channel_id`.
 */
export type AfkDesignationEdit =
  | { afk_channel_id: string; afk_timeout: AfkTimeoutSeconds }
  | { afk_channel_id: string; remove: readonly ["AfkTimeout"] }
  | { remove: readonly ["AfkChannel"] };

/**
 * Build that body.
 *
 * The timeout is the value the user can see in the select; it is sent on
 * every designation so the adopted timeout is the shown timeout. "Never" is
 * sent as an explicit removal, so designating over a server that still held a
 * timeout does not silently keep it. A NUMBER that is somehow not a preset
 * falls back rather than being sent for the backend to reject, because the
 * select can only ever hold a preset or "never".
 */
export function afkDesignationEdit(
  input: {
    /** True to make `channelId` the AFK channel, false to clear the server's. */
    designate: boolean;
    channelId: string;
  } & AfkTimeoutInput,
): AfkDesignationEdit {
  if (!input.designate) {
    // 🔴 Never `{ afk_channel_id: null }` — see the module header.
    return { remove: ["AfkChannel"] as const };
  }

  if (input.timeout === AFK_TIMEOUT_NEVER) {
    // 🔴 Never `afk_timeout: null` — the same silent no-op as the channel.
    return {
      afk_channel_id: input.channelId,
      remove: ["AfkTimeout"] as const,
    };
  }

  return {
    afk_channel_id: input.channelId,
    afk_timeout: effectiveAfkTimeout(
      input.timeout !== undefined ? input.timeout : input.timeoutSeconds,
    ),
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
 *
 * "Never" on the designated channel is `remove: ["AfkTimeout"]` alone; the
 * designation stays.
 */
export function afkTimeoutEdit(
  input: {
    /** `server.afkChannelId` — `undefined`, never null, when unset. */
    afkChannelId: string | undefined;
    channelId: string;
  } & AfkTimeoutInput,
):
  | { afk_timeout: AfkTimeoutSeconds }
  | { remove: readonly ["AfkTimeout"] }
  | undefined {
  if (!input.afkChannelId || input.afkChannelId !== input.channelId) {
    return undefined;
  }
  const choice =
    input.timeout !== undefined ? input.timeout : input.timeoutSeconds;
  if (choice === AFK_TIMEOUT_NEVER) {
    // 🔴 Never `afk_timeout: null` — see the module header.
    return { remove: ["AfkTimeout"] as const };
  }
  if (!isAfkTimeoutPreset(choice)) return undefined;
  return { afk_timeout: choice };
}

/**
 * The three shapes `afkCreateChannelFields` can return: nothing, a designation
 * with a preset timeout, or a designation with no timeout ("never").
 *
 * `afk`, `afk_timeout` and `afk_timeout_never` are additive fields the
 * generated `stoat-api` create body predates. This module stays
 * dependency-free, so the type is declared here and the call site passes the
 * whole body through with `as never` (`CreateChannel.tsx`, the existing
 * `server.createChannel({ … } as never)` escape hatch).
 */
export type AfkCreateChannelFields =
  | Record<string, never>
  | { afk: true; afk_timeout: AfkTimeoutSeconds }
  | { afk: true; afk_timeout_never: true };

/**
 * The extra fields the create-channel modal folds into its
 * `server.createChannel(...)` body.
 *
 * 🔴 The route rejects `afk: true` on anything that is not a Voice channel, so
 * the flag is dropped rather than sent whenever the selected type is not
 * Voice — the same shape the existing `announcement` field uses for text
 * channels. A user who ticks AFK and then switches the type back to Text does
 * not get a 400; they get a plain text channel.
 *
 * 🔴 "Never" is `afk_timeout_never: true`, and it is the ONLY way to say it.
 * The create route keeps whatever timeout the server already holds when
 * `afk_timeout` is simply absent (a `None` in its partial is a no-op), and
 * the create body has no remove array — so leaving the field out would let a
 * new AFK channel silently inherit another channel's timeout. The backend
 * refuses `afk_timeout_never` without `afk: true` or alongside `afk_timeout`,
 * so the three shapes in `AfkCreateChannelFields` are the only three there
 * are.
 */
export function afkCreateChannelFields(
  input: {
    /** The radio value: "Text", "Voice" or "Forum". */
    channelType: string;
    afk: boolean;
  } & AfkTimeoutInput,
): AfkCreateChannelFields {
  if (input.channelType !== "Voice" || !input.afk) return {};
  if (input.timeout === AFK_TIMEOUT_NEVER) {
    return { afk: true, afk_timeout_never: true };
  }
  return {
    afk: true,
    afk_timeout: effectiveAfkTimeout(
      input.timeout !== undefined ? input.timeout : input.timeoutSeconds,
    ),
  };
}
