// Specs for the upload limits tier — run with Node's built-in runner:
//   node --conditions=browser --test components/common/lib/uploadLimit.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { type ClientConfiguration, UserPerks } from "stoat.js";

import { pickUploadLimit, pickUserLimits } from "./uploadLimit.ts";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 8, 25, 12, 0, 0);
const MB = 1_000_000;

function tier(attachments: number, extra: Record<string, number> = {}) {
  return {
    outgoing_friend_requests: 10,
    bots: 5,
    message_length: 2000,
    message_attachments: 5,
    servers: 100,
    voice_quality: 16000,
    video: true,
    video_resolution: [1080, 720],
    video_aspect_ratio: [0.3, 2.5],
    file_upload_size_limits: { attachments, avatars: 4 * MB, ...extra },
  };
}

const DEFAULT = tier(20 * MB);
const NEW_USER = tier(5 * MB);
const PERK = tier(100 * MB, { backgrounds: 12 * MB });

function config(limits: Record<string, unknown>): ClientConfiguration {
  return { features: { limits } } as unknown as ClientConfiguration;
}

function fullLimits(withPerk: boolean) {
  return {
    global: { new_user_hours: 72 },
    new_user: NEW_USER,
    default: DEFAULT,
    ...(withPerk ? { perk: PERK } : {}),
  };
}

function user(ageHours: number, perks = 0) {
  return {
    createdAt: new Date(NOW - ageHours * HOUR),
    hasPerk: (perk: UserPerks) => (perks & perk) === perk,
  };
}

test("perk holder gets the perk tier when the server advertises one", () => {
  const cfg = config(fullLimits(true));
  // Even a brand new account: the perk beats the new-account tier.
  assert.equal(pickUserLimits(cfg, user(1, UserPerks.UploadPerk), NOW), PERK);
  assert.equal(
    pickUserLimits(cfg, user(1000, UserPerks.UploadPerk), NOW),
    PERK,
  );
  assert.equal(
    pickUploadLimit(cfg, user(1, UserPerks.UploadPerk), "attachments", NOW),
    100 * MB,
  );
});

test("perk holder falls back by age when there is no perk tier", () => {
  const cfg = config(fullLimits(false));
  assert.equal(
    pickUserLimits(cfg, user(1, UserPerks.UploadPerk), NOW),
    NEW_USER,
  );
  assert.equal(
    pickUserLimits(cfg, user(1000, UserPerks.UploadPerk), NOW),
    DEFAULT,
  );
});

test("other perks do not unlock the perk tier", () => {
  const cfg = config(fullLimits(true));
  const perks =
    UserPerks.NameColour | UserPerks.NameFont | UserPerks.NameEffect;
  assert.equal(pickUserLimits(cfg, user(1000, perks), NOW), DEFAULT);
  assert.equal(pickUserLimits(cfg, user(1, perks), NOW), NEW_USER);
});

test("young accounts get the new-account tier, old ones the default", () => {
  const cfg = config(fullLimits(true));
  assert.equal(pickUserLimits(cfg, user(0), NOW), NEW_USER);
  assert.equal(pickUserLimits(cfg, user(24), NOW), NEW_USER);
  assert.equal(pickUserLimits(cfg, user(1000), NOW), DEFAULT);
  assert.equal(pickUploadLimit(cfg, user(24), "attachments", NOW), 5 * MB);
  assert.equal(pickUploadLimit(cfg, user(1000), "attachments", NOW), 20 * MB);
});

test("the new-account window includes its last millisecond", () => {
  const cfg = config(fullLimits(false));
  assert.equal(pickUserLimits(cfg, user(72), NOW), NEW_USER);
  const justOver = {
    createdAt: new Date(NOW - 72 * HOUR - 1),
    hasPerk: () => false,
  };
  assert.equal(pickUserLimits(cfg, justOver, NOW), DEFAULT);
});

test("no user means the default tier", () => {
  assert.equal(
    pickUserLimits(config(fullLimits(true)), undefined, NOW),
    DEFAULT,
  );
  assert.equal(
    pickUploadLimit(config(fullLimits(true)), undefined, "attachments", NOW),
    20 * MB,
  );
});

test("an unloaded configuration gives undefined without throwing", () => {
  // What the controller seeds before the configuration arrives.
  const seeded = config({});
  assert.equal(pickUserLimits(seeded, user(1), NOW), undefined);
  assert.equal(
    pickUserLimits(seeded, user(1000, UserPerks.UploadPerk), NOW),
    undefined,
  );
  assert.equal(pickUserLimits(seeded, undefined, NOW), undefined);
  assert.equal(pickUploadLimit(seeded, user(1), "attachments", NOW), undefined);

  assert.equal(pickUserLimits(undefined, user(1), NOW), undefined);
  assert.equal(pickUploadLimit(undefined, undefined), undefined);
  assert.equal(
    pickUploadLimit({} as ClientConfiguration, user(1), "attachments", NOW),
    undefined,
  );
});

test("a missing new-account tier or window falls through to the default", () => {
  const noWindow = config({ new_user: NEW_USER, default: DEFAULT });
  assert.equal(pickUserLimits(noWindow, user(1), NOW), DEFAULT);

  const noTier = config({ global: { new_user_hours: 72 }, default: DEFAULT });
  assert.equal(pickUserLimits(noTier, user(1), NOW), DEFAULT);

  const onlyGlobal = config({ global: { new_user_hours: 72 } });
  assert.equal(pickUserLimits(onlyGlobal, user(1), NOW), undefined);
  assert.equal(
    pickUploadLimit(onlyGlobal, user(1), "attachments", NOW),
    undefined,
  );
});

test("upload limits are looked up by tag", () => {
  const cfg = config(fullLimits(true));
  const holder = user(1000, UserPerks.UploadPerk);
  assert.equal(pickUploadLimit(cfg, holder, "avatars", NOW), 4 * MB);
  assert.equal(pickUploadLimit(cfg, holder, "backgrounds", NOW), 12 * MB);
  assert.equal(pickUploadLimit(cfg, holder, "icons", NOW), undefined);
  // Keys inherited from Object.prototype are not tags.
  assert.equal(pickUploadLimit(cfg, holder, "constructor", NOW), undefined);
  // The tag defaults to attachments and the clock to the current time.
  const old = {
    createdAt: new Date(Date.now() - 1000 * HOUR),
    hasPerk: () => false,
  };
  assert.equal(pickUploadLimit(cfg, old), 20 * MB);
});
