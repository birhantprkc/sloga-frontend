/**
 * Camera virtual-background catalogue.
 *
 * Two kinds of background:
 *  - **presets** (`preset:<name>`) — generated at runtime as gradient/solid
 *    (or pattern-painted) images and returned as stable `data:` URLs (no
 *    object-URL lifecycle).
 *  - **uploads** (`upload:<uuid>`) — user-provided images stored as Blobs in a
 *    dedicated localforage instance, surfaced as `blob:` object URLs that the
 *    caller MUST revoke (see {@link resolveBackgroundUrl}).
 *
 * Consumed by the settings preview, the in-call camera modal, and the RTC
 * `Voice` state when applying `@livekit/track-processors` virtual backgrounds.
 */
import localforage from "localforage";

export type CameraBackgroundKind = "preset" | "upload";

export interface CameraBackgroundItem {
  /** Stable id: `preset:<name>` or `upload:<uuid>`. Persisted in the Voice store. */
  id: string;
  /** Human label for the gallery (already localized-neutral). */
  name: string;
  kind: CameraBackgroundKind;
}

/** A resolved background source plus a revoke handle for its URL. */
export interface ResolvedBackground {
  url: string;
  /** Releases the URL. No-op for presets (data URLs); revokes object URLs for uploads. */
  revoke: () => void;
}

const UPLOAD_PREFIX = "upload:";
const PRESET_PREFIX = "preset:";
const INDEX_KEY = "__index__";

/** Dedicated store so blobs never collide with the session/auth keys. */
const store = localforage.createInstance({
  name: "sloga",
  storeName: "camera_backgrounds",
});

/** Preset definitions — rendered to gradient/solid data URLs on demand. */
interface PresetDef {
  name: string;
  /** CSS-ish gradient stops; single entry ⇒ solid colour. */
  stops: string[];
  angleDeg?: number;
  /** Optional painter run after the base fill, for patterned presets. */
  draw?: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
}

/**
 * Deterministic PRNG (mulberry32) so patterned presets render pixel-identical
 * on every machine — the data URL for a given preset never varies.
 */
function mulberry32(seed: number): () => number {
  let t = seed;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rounded-rect path — hand-rolled since ctx.roundRect is missing on older Safari. */
function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/**
 * Sloga "O" mark, static geometry from the brand loader (LoadingProgress.tsx):
 * green core with eight coloured satellites, clockwise from the top, in the
 * logo's 512-unit space (ring 148, satellites 44, core 52).
 */
const SLOGA_CORE = "#27A163";
const SLOGA_SATELLITES = [
  "#3BB8ED",
  "#F5870D",
  "#CF2A27",
  "#E3CF1B",
  "#3BB8ED",
  "#F5870D",
  "#2B2BD8",
  "#C05FC8",
];

function drawSlogaMark(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
) {
  const s = size / 512;
  SLOGA_SATELLITES.forEach((color, i) => {
    const a = ((i * 45 - 90) * Math.PI) / 180;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(
      cx + Math.cos(a) * 148 * s,
      cy + Math.sin(a) * 148 * s,
      44 * s,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  });
  ctx.fillStyle = SLOGA_CORE;
  ctx.beginPath();
  ctx.arc(cx, cy, 52 * s, 0, Math.PI * 2);
  ctx.fill();
}

/** Staggered wallpaper of Sloga "O" marks on black. */
function drawSlogaPattern(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const size = 132;
  const stepX = 256;
  const stepY = 200;
  ctx.globalAlpha = 0.9;
  for (let row = 0, y = 90; y < h + size; row++, y += stepY) {
    const offset = row % 2 ? stepX / 2 : 0;
    for (let x = offset + 96; x < w + size; x += stepX) {
      drawSlogaMark(ctx, x, y, size);
    }
  }
  ctx.globalAlpha = 1;
}

/** Synthwave horizon: starfield, striped sun, glowing perspective grid. */
function drawArcadeGrid(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const horizon = h * 0.62;
  const centreX = w / 2;

  const sky = ctx.createLinearGradient(0, 0, 0, horizon);
  sky.addColorStop(0, "#12022e");
  sky.addColorStop(1, "#43125f");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, horizon);

  const rand = mulberry32(0x510ca);
  ctx.fillStyle = "#ffffff";
  for (let i = 0; i < 90; i++) {
    const x = rand() * w;
    const y = rand() * horizon * 0.85;
    ctx.globalAlpha = 0.25 + rand() * 0.55;
    ctx.fillRect(x, y, 2, 2);
  }
  ctx.globalAlpha = 1;

  // Sun sits on the horizon; slices get thicker toward its base.
  const sunR = 150;
  const sunY = horizon - 20;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, horizon);
  ctx.clip();
  const sun = ctx.createLinearGradient(0, sunY - sunR, 0, sunY + sunR);
  sun.addColorStop(0, "#ffd319");
  sun.addColorStop(1, "#ff2975");
  ctx.fillStyle = sun;
  ctx.beginPath();
  ctx.arc(centreX, sunY, sunR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = sky;
  for (let i = 0; i < 6; i++) {
    ctx.fillRect(centreX - sunR, sunY - 12 + i * 26, sunR * 2, 4 + i * 3);
  }
  ctx.restore();

  const floor = ctx.createLinearGradient(0, horizon, 0, h);
  floor.addColorStop(0, "#2b0a3d");
  floor.addColorStop(1, "#0d0221");
  ctx.fillStyle = floor;
  ctx.fillRect(0, horizon, w, h - horizon);

  ctx.strokeStyle = "#ff2975";
  ctx.lineWidth = 2;
  ctx.shadowColor = "#ff2975";
  ctx.shadowBlur = 6;
  ctx.beginPath();
  // Verticals converge on a vanishing point at the horizon's centre …
  for (let i = -8; i <= 8; i++) {
    ctx.moveTo(centreX, horizon);
    ctx.lineTo(centreX + i * 170, h);
  }
  // … horizontals bunch up toward the horizon.
  for (let i = 1; i <= 7; i++) {
    const t = i / 7;
    const y = horizon + (h - horizon) * t * t;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();
  ctx.strokeStyle = "#00e5ff";
  ctx.shadowColor = "#00e5ff";
  ctx.shadowBlur = 10;
  ctx.beginPath();
  ctx.moveTo(0, horizon);
  ctx.lineTo(w, horizon);
  ctx.stroke();
  ctx.shadowBlur = 0;
}

/** Tiny sprite bitmaps for the pixel preset ("." = empty, "X" = filled). */
const PIXEL_SPRITES: { rows: string[]; color: string }[] = [
  {
    // heart
    color: "#ff4d6d",
    rows: [".XX.XX.", "XXXXXXX", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
  },
  {
    // star
    color: "#ffd93d",
    rows: ["...X...", "..XXX..", "XXXXXXX", ".XXXXX.", "..XXX..", ".X...X."],
  },
  {
    // gem
    color: "#3bd6ff",
    rows: [".XXXXX.", "XXXXXXX", ".XXXXX.", "..XXX..", "...X..."],
  },
];

function drawPixelSprite(
  ctx: CanvasRenderingContext2D,
  sprite: (typeof PIXEL_SPRITES)[number],
  x: number,
  y: number,
  px: number,
) {
  ctx.fillStyle = sprite.color;
  sprite.rows.forEach((row, ry) => {
    for (let rx = 0; rx < row.length; rx++) {
      if (row[rx] === "X") ctx.fillRect(x + rx * px, y + ry * px, px, px);
    }
  });
}

/** Jittered scatter of retro hearts / stars / gems on dark indigo. */
function drawPixelScatter(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const rand = mulberry32(0xace5);
  let i = 0;
  for (let row = 0, y = 40; y < h; row++, y += 168) {
    for (let x = 60 + (row % 2 ? 104 : 0); x < w; x += 208) {
      const sprite = PIXEL_SPRITES[i++ % PIXEL_SPRITES.length];
      const jx = x + (rand() - 0.5) * 70;
      const jy = y + (rand() - 0.5) * 50;
      const px = 9 * (0.75 + rand() * 0.5);
      ctx.globalAlpha = 0.55 + rand() * 0.4;
      drawPixelSprite(ctx, sprite, jx, jy, px);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * One controller silhouette centred on the origin: a pill body with drooping
 * grips, then the D-pad and face buttons punched back in with the base colour.
 */
function drawGamepad(
  ctx: CanvasRenderingContext2D,
  width: number,
  body: string,
  detail: string,
) {
  const bodyH = width * 0.43;
  const gripR = bodyH * 0.47;
  ctx.fillStyle = body;
  roundedRectPath(ctx, -width / 2, -bodyH / 2, width, bodyH, bodyH / 2);
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(side * (width / 2 - gripR), bodyH * 0.28, gripR, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = detail;
  // D-pad cross
  const dx = -width * 0.28;
  ctx.fillRect(dx - 13, -4, 26, 8);
  ctx.fillRect(dx - 4, -13, 8, 26);
  // Face buttons in a diamond
  const bx = width * 0.28;
  for (const [ox, oy] of [
    [0, -9],
    [9, 0],
    [0, 9],
    [-9, 0],
  ]) {
    ctx.beginPath();
    ctx.arc(bx + ox, oy, 4.5, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Tone-on-tone wallpaper of controller silhouettes, slightly rotated. */
function drawGamepadPattern(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
) {
  const rand = mulberry32(0x6a3e);
  for (let row = 0, y = 70; y < h + 60; row++, y += 190) {
    const offset = row % 2 ? 140 : 0;
    for (let x = offset + 40; x < w + 100; x += 280) {
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate((rand() - 0.5) * 0.5);
      drawGamepad(ctx, 150, "#232936", "#141821");
      ctx.restore();
    }
  }
}

const PRESET_DEFS: Record<string, PresetDef> = {
  slate: { name: "Slate", stops: ["#1b2733", "#0d141c"], angleDeg: 135 },
  ocean: { name: "Ocean", stops: ["#1f6feb", "#0a2540"], angleDeg: 160 },
  sunset: { name: "Sunset", stops: ["#ff8a3d", "#d7385e"], angleDeg: 120 },
  forest: { name: "Forest", stops: ["#2f9e5f", "#0f3d2e"], angleDeg: 145 },
  studio: { name: "Studio", stops: ["#5a5f66", "#2a2d31"], angleDeg: 180 },
  sloga: { name: "Sloga", stops: ["#000000"], draw: drawSlogaPattern },
  arcade: { name: "Arcade", stops: ["#0d0221"], draw: drawArcadeGrid },
  pixel: { name: "Pixel", stops: ["#101426"], draw: drawPixelScatter },
  gamepad: { name: "Gamepad", stops: ["#141821"], draw: drawGamepadPattern },
};

const presetDataUrlCache = new Map<string, string>();

/**
 * Render a preset to a 1280x720 data URL (cached). Returns null if a 2D
 * context is unavailable (never expected in a browser/webview).
 */
function renderPreset(name: string): string | null {
  const cached = presetDataUrlCache.get(name);
  if (cached) return cached;

  const def = PRESET_DEFS[name];
  if (!def) return null;

  const canvas = document.createElement("canvas");
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  if (def.stops.length === 1) {
    ctx.fillStyle = def.stops[0];
  } else {
    const angle = ((def.angleDeg ?? 135) * Math.PI) / 180;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const grad = ctx.createLinearGradient(
      canvas.width / 2 - (x * canvas.width) / 2,
      canvas.height / 2 - (y * canvas.height) / 2,
      canvas.width / 2 + (x * canvas.width) / 2,
      canvas.height / 2 + (y * canvas.height) / 2,
    );
    const step = 1 / (def.stops.length - 1);
    def.stops.forEach((c, i) => grad.addColorStop(i * step, c));
    ctx.fillStyle = grad;
  }
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  if (def.draw) {
    ctx.save();
    def.draw(ctx, canvas.width, canvas.height);
    ctx.restore();
  }

  const url = canvas.toDataURL("image/jpeg", 0.9);
  presetDataUrlCache.set(name, url);
  return url;
}

/** All built-in preset items. */
export function listPresets(): CameraBackgroundItem[] {
  return Object.entries(PRESET_DEFS).map(([key, def]) => ({
    id: `${PRESET_PREFIX}${key}`,
    name: def.name,
    kind: "preset" as const,
  }));
}

async function readIndex(): Promise<CameraBackgroundItem[]> {
  const idx = await store.getItem<CameraBackgroundItem[]>(INDEX_KEY);
  return Array.isArray(idx) ? idx : [];
}

async function writeIndex(items: CameraBackgroundItem[]): Promise<void> {
  await store.setItem(INDEX_KEY, items);
}

/** Uploaded (user) background items. */
export async function listUploads(): Promise<CameraBackgroundItem[]> {
  return readIndex();
}

/** Presets + uploads, presets first. */
export async function listBackgrounds(): Promise<CameraBackgroundItem[]> {
  const uploads = await listUploads();
  return [...listPresets(), ...uploads];
}

/**
 * Store a user image as a new upload background.
 * @param blob image data (any browser-decodable image type)
 * @param name optional label
 */
export async function addUpload(
  blob: Blob,
  name?: string,
): Promise<CameraBackgroundItem> {
  const id = `${UPLOAD_PREFIX}${crypto.randomUUID()}`;
  const item: CameraBackgroundItem = {
    id,
    name: name?.trim() || "Custom",
    kind: "upload",
  };
  await store.setItem(id, blob);
  const idx = await readIndex();
  await writeIndex([...idx, item]);
  return item;
}

/** Delete an uploaded background (no-op for presets / unknown ids). */
export async function removeUpload(id: string): Promise<void> {
  if (!id.startsWith(UPLOAD_PREFIX)) return;
  await store.removeItem(id);
  const idx = await readIndex();
  await writeIndex(idx.filter((i) => i.id !== id));
}

/** Whether an id currently resolves to a real background. */
export async function backgroundExists(id: string): Promise<boolean> {
  if (id.startsWith(PRESET_PREFIX)) {
    return PRESET_DEFS[id.slice(PRESET_PREFIX.length)] !== undefined;
  }
  if (id.startsWith(UPLOAD_PREFIX)) {
    return (await store.getItem(id)) != null;
  }
  return false;
}

/**
 * Resolve an id to a usable image URL for `imagePath`, plus a `revoke` handle.
 * Returns null when the id no longer resolves (deleted upload / bad preset) so
 * callers can fall back to "none". ALWAYS call `revoke()` when done / on change.
 */
export async function resolveBackgroundUrl(
  id: string,
): Promise<ResolvedBackground | null> {
  if (id.startsWith(PRESET_PREFIX)) {
    const url = renderPreset(id.slice(PRESET_PREFIX.length));
    return url ? { url, revoke: () => {} } : null;
  }
  if (id.startsWith(UPLOAD_PREFIX)) {
    const blob = await store.getItem<Blob>(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  return null;
}
