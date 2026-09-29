/**
 * Which server limits tier applies to an account, mirrored from the backend's
 * `User::limits()` so the client can size its upload checks the same way.
 * The server still enforces every limit; this only decides what the client
 * shows and rejects up front.
 */
import {
  type ClientConfiguration,
  type ConfigUserLimits,
  UserPerks,
} from "stoat.js";

/**
 * The parts of a user the tier choice needs (a `User` fits)
 */
export type UploadLimitUser = {
  createdAt: Date;
  hasPerk(perk: UserPerks): boolean;
};

/**
 * The limits tier the server applies to this user: the upload perk tier
 * (when the server advertises one and the user holds the perk), then the
 * new-account tier (account age up to and including `new_user_hours`), then
 * the default. Undefined until the configuration has loaded.
 */
export function pickUserLimits(
  config: ClientConfiguration | undefined,
  user: UploadLimitUser | undefined,
  now: number = Date.now(),
): ConfigUserLimits | undefined {
  // The controller seeds `limits` with an empty object before the
  // configuration arrives, so none of these keys can be relied on.
  const limits = config?.features?.limits;
  if (!limits) return undefined;
  if (!user) return limits.default;

  // The server already lays the perk's upload sizes over the default tier
  // before advertising it, so this tier is complete as sent.
  if (limits.perk && user.hasPerk(UserPerks.UploadPerk)) {
    return limits.perk;
  }

  const hours = limits.global?.new_user_hours;
  if (
    limits.new_user &&
    typeof hours === "number" &&
    now - user.createdAt.getTime() <= hours * 3_600_000
  ) {
    return limits.new_user;
  }

  return limits.default;
}

/**
 * Upload size cap in bytes for an upload tag, or undefined when it is not
 * known yet
 */
export function pickUploadLimit(
  config: ClientConfiguration | undefined,
  user: UploadLimitUser | undefined,
  tag: string = "attachments",
  now?: number,
): number | undefined {
  const limits = pickUserLimits(config, user, now);
  const size = limits?.file_upload_size_limits?.[tag];
  return typeof size === "number" ? size : undefined;
}
