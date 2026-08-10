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
  /**
   * For animated presets: every pre-rendered frame URL (`url` === `frames[0]`).
   * Consumers that can cycle frames (CameraEffectsController) animate with
   * these; everything else (gallery thumbnails) just uses `url`.
   */
  frames?: string[];
  /** How long to hold each frame, for animated presets. */
  frameIntervalMs?: number;
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
  /**
   * Optional painter run after the base fill, for patterned presets. `t` is
   * the animation loop phase in [0, 1) — always 0 for static presets.
   */
  draw?: (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
  ) => void;
  /** Present ⇒ the preset animates: `frames` renders at t = i/frames. */
  animation?: { frames: number; intervalMs: number };
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

/** Muted, homely book-spine colours shared by every shelf. */
const BOOK_COLORS = [
  "#7d8c69",
  "#b3583e",
  "#41597a",
  "#c9a227",
  "#6b4f8e",
  "#8d8d85",
];

/** A floating wooden shelf board with a soft drop shadow. */
function drawShelf(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
) {
  ctx.save();
  ctx.shadowColor = "rgba(70,50,30,0.35)";
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 6;
  const wood = ctx.createLinearGradient(0, y, 0, y + 14);
  wood.addColorStop(0, "#b98a5c");
  wood.addColorStop(1, "#93683f");
  ctx.fillStyle = wood;
  roundedRectPath(ctx, x, y, width, 14, 4);
  ctx.fill();
  ctx.restore();
}

/** A tidy row of book spines standing on `baseY`, one leaning at the end. */
function drawBooks(
  ctx: CanvasRenderingContext2D,
  x: number,
  baseY: number,
  heights: number[],
) {
  let cur = x;
  heights.forEach((bh, i) => {
    const bw = 10 + (i % 3) * 2;
    ctx.fillStyle = BOOK_COLORS[i % BOOK_COLORS.length];
    roundedRectPath(ctx, cur, baseY - bh, bw, bh, 2);
    ctx.fill();
    cur += bw + 3;
  });
  ctx.save();
  ctx.translate(cur + 2, baseY);
  ctx.rotate(-0.18);
  ctx.fillStyle = BOOK_COLORS[(heights.length + 1) % BOOK_COLORS.length];
  roundedRectPath(ctx, 0, -40, 11, 40, 2);
  ctx.fill();
  ctx.restore();
}

/** A potted plant standing on `baseY`: fanned leaves over a tapered pot. */
function drawPottedPlant(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
  potW: number,
  leafColor: string,
  potColor: string,
) {
  const potH = potW * 0.78;
  const tip = baseY - potH - potW * 0.1;
  ctx.fillStyle = leafColor;
  for (let i = -2; i <= 2; i++) {
    ctx.save();
    ctx.translate(cx, tip);
    ctx.rotate(i * 0.45);
    ctx.beginPath();
    ctx.ellipse(0, -potW * 0.55, potW * 0.16, potW * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
  ctx.fillStyle = potColor;
  ctx.beginPath();
  ctx.moveTo(cx - potW / 2, baseY - potH);
  ctx.lineTo(cx + potW / 2, baseY - potH);
  ctx.lineTo(cx + potW * 0.38, baseY);
  ctx.lineTo(cx - potW * 0.38, baseY);
  ctx.closePath();
  ctx.fill();
  roundedRectPath(ctx, cx - potW / 2 - 2, baseY - potH - 6, potW + 4, 9, 3);
  ctx.fill();
}

/** A ceramic pot on the shelf edge with vines trailing down the wall. */
function drawTrailingPlant(
  ctx: CanvasRenderingContext2D,
  cx: number,
  shelfY: number,
) {
  ctx.fillStyle = "#e0d6c4";
  roundedRectPath(ctx, cx - 15, shelfY - 24, 30, 24, 4);
  ctx.fill();
  ctx.strokeStyle = "#5d8a55";
  ctx.fillStyle = "#6d9a63";
  ctx.lineWidth = 2;
  for (const [dx, len, sway] of [
    [-10, 90, 14],
    [2, 130, -12],
    [12, 70, 10],
  ]) {
    const sx = cx + dx;
    const midX = sx + sway;
    const midY = shelfY + len * 0.5;
    const endX = sx + sway * 0.4;
    const endY = shelfY + len;
    ctx.beginPath();
    ctx.moveTo(sx, shelfY - 20);
    ctx.quadraticCurveTo(midX, midY, endX, endY);
    ctx.stroke();
    for (let i = 1; i <= 4; i++) {
      const tt = i / 4;
      const a = 1 - tt;
      const qx = a * a * sx + 2 * a * tt * midX + tt * tt * endX;
      const qy = a * a * (shelfY - 20) + 2 * a * tt * midY + tt * tt * endY;
      ctx.beginPath();
      ctx.ellipse(qx, qy, 5, 3.5, tt * 1.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** A framed abstract print (soft hills + sun) in a wooden frame. */
function drawWallArt(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
) {
  ctx.save();
  ctx.shadowColor = "rgba(70,50,30,0.3)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetY = 4;
  ctx.fillStyle = "#8a6f52";
  roundedRectPath(ctx, x, y, w, h, 3);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(x + 5, y + 5, w - 10, h - 10);
  ctx.clip();
  ctx.fillStyle = "#f2ecdf";
  ctx.fillRect(x + 5, y + 5, w - 10, h - 10);
  ctx.fillStyle = "#a8b79b";
  ctx.beginPath();
  ctx.arc(x + w * 0.35, y + h, w * 0.34, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#c98d63";
  ctx.beginPath();
  ctx.arc(x + w * 0.72, y + h, w * 0.26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#e3c25c";
  ctx.beginPath();
  ctx.arc(x + w * 0.7, y + h * 0.32, w * 0.07, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** A tall floor plant: arching stems with big leaves out of a planter. */
function drawTallPlant(
  ctx: CanvasRenderingContext2D,
  cx: number,
  baseY: number,
) {
  ctx.fillStyle = "rgba(60,45,25,0.18)";
  ctx.beginPath();
  ctx.ellipse(cx, baseY + 4, 64, 12, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#3f6b3c";
  const leaves = ["#4e7d49", "#5d8f54", "#40663d", "#6b9c60", "#48764a"];
  (
    [
      [-0.5, 150],
      [-0.25, 195],
      [0, 220],
      [0.22, 185],
      [0.45, 145],
    ] as const
  ).forEach(([lean, len], i) => {
    const tipX = cx + lean * 160;
    const tipY = baseY - 70 - len;
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(cx, baseY - 40);
    ctx.quadraticCurveTo(cx + lean * 50, baseY - 60 - len * 0.5, tipX, tipY);
    ctx.stroke();
    ctx.save();
    ctx.translate(tipX, tipY);
    ctx.rotate(lean * 1.1);
    ctx.fillStyle = leaves[i];
    ctx.beginPath();
    ctx.ellipse(0, -34, 22, 44, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  });
  const potW = 96;
  ctx.fillStyle = "#c4703f";
  ctx.beginPath();
  ctx.moveTo(cx - potW / 2, baseY - 78);
  ctx.lineTo(cx + potW / 2, baseY - 78);
  ctx.lineTo(cx + potW * 0.4, baseY);
  ctx.lineTo(cx - potW * 0.4, baseY);
  ctx.closePath();
  ctx.fill();
  roundedRectPath(ctx, cx - potW / 2 - 3, baseY - 88, potW + 6, 14, 4);
  ctx.fill();
}

/**
 * Tidy home wall: warm paint, wooden shelves with books and plants, soft
 * daylight from the left. Shelves and plants hug the edges so the person in
 * the centre stays clear of the detail.
 */
function drawHomeRoom(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const wall = ctx.createLinearGradient(0, 0, 0, h);
  wall.addColorStop(0, "#ede5d8");
  wall.addColorStop(1, "#dbd1c0");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, w, h);

  const light = ctx.createLinearGradient(0, 0, w * 0.6, h * 0.35);
  light.addColorStop(0, "rgba(255,250,238,0.55)");
  light.addColorStop(1, "rgba(255,250,238,0)");
  ctx.fillStyle = light;
  ctx.fillRect(0, 0, w, h);

  // Baseboard
  ctx.fillStyle = "#cfc2ab";
  ctx.fillRect(0, h - 30, w, 30);
  ctx.fillStyle = "#bbac92";
  ctx.fillRect(0, h - 30, w, 4);

  drawShelf(ctx, 70, 168, 330);
  drawBooks(ctx, 92, 168, [38, 46, 34, 42, 30, 44]);
  drawPottedPlant(ctx, 320, 168, 34, "#5d8f54", "#c4703f");

  drawShelf(ctx, 880, 132, 330);
  drawTrailingPlant(ctx, 925, 132);
  drawBooks(ctx, 985, 132, [40, 32, 44, 36, 42]);
  drawWallArt(ctx, 1135, 88, 52, 42);

  drawShelf(ctx, 990, 330, 230);
  drawPottedPlant(ctx, 1030, 330, 28, "#6b9c60", "#e0d6c4");
  drawBooks(ctx, 1080, 330, [30, 38, 28, 34]);

  drawWallArt(ctx, 585, 64, 110, 84);

  drawTallPlant(ctx, 1180, h - 34);
  drawPottedPlant(ctx, 95, h - 34, 64, "#4e7d49", "#b2593b");

  // Soft vignette keeps the focus on the person
  const vig = ctx.createRadialGradient(
    w / 2,
    h / 2,
    h * 0.4,
    w / 2,
    h / 2,
    h * 0.95,
  );
  vig.addColorStop(0, "rgba(0,0,0,0)");
  vig.addColorStop(1, "rgba(60,45,25,0.14)");
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);
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
 * Deep space with twinkling stars, faint nebulae and a ringed planet.
 *
 * `t` is the loop phase in [0, 1). Every star's brightness follows
 * sin(2π·(phase + k·t)) with an INTEGER k, so frame `frames-1` tiles
 * seamlessly back into frame 0.
 */
function drawSpaceScene(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  t: number,
) {
  const TWO_PI = Math.PI * 2;

  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, "#04060f");
  sky.addColorStop(1, "#0c1128");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, w, h);

  // Static nebulae
  const nebula = (cx: number, cy: number, r: number, color: string) => {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color);
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  };
  nebula(w * 0.22, h * 0.3, 340, "rgba(110,70,160,0.16)");
  nebula(w * 0.75, h * 0.2, 300, "rgba(50,120,160,0.14)");
  nebula(w * 0.55, h * 0.75, 380, "rgba(150,70,120,0.10)");

  // Small twinkling stars (fixed positions/phases — only `t` varies per frame)
  const rand = mulberry32(0x5ace);
  for (let i = 0; i < 150; i++) {
    const x = rand() * w;
    const y = rand() * h;
    const size = 0.8 + rand() * 1.6;
    const phase = rand();
    const speed = 1 + Math.floor(rand() * 3);
    const tint = rand();
    const twinkle = 0.5 + 0.5 * Math.sin(TWO_PI * (phase + speed * t));
    ctx.globalAlpha = 0.15 + 0.75 * twinkle;
    ctx.fillStyle = tint > 0.8 ? "#cfe4ff" : "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, size, 0, TWO_PI);
    ctx.fill();
  }

  // A few big stars with cross glints that grow as they brighten
  for (let i = 0; i < 7; i++) {
    const x = rand() * w;
    const y = rand() * h * 0.8;
    const phase = rand();
    const speed = 1 + Math.floor(rand() * 2);
    const twinkle = 0.5 + 0.5 * Math.sin(TWO_PI * (phase + speed * t));
    ctx.globalAlpha = 0.5 + 0.5 * twinkle;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(x, y, 2 + twinkle * 1.5, 0, TWO_PI);
    ctx.fill();
    const glint = 8 + twinkle * 8;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - glint, y);
    ctx.lineTo(x + glint, y);
    ctx.moveTo(x, y - glint);
    ctx.lineTo(x, y + glint);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // Ringed planet, bottom-right: back half of the ring, planet, front half
  const px = w * 0.86;
  const py = h * 0.8;
  const pr = 78;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-0.35);
  ctx.strokeStyle = "rgba(196,208,232,0.65)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.ellipse(0, 0, pr * 1.6, pr * 0.42, 0, Math.PI, TWO_PI);
  ctx.stroke();
  ctx.restore();
  const pg = ctx.createRadialGradient(
    px - pr * 0.4,
    py - pr * 0.45,
    pr * 0.2,
    px,
    py,
    pr,
  );
  pg.addColorStop(0, "#8fb3d9");
  pg.addColorStop(0.7, "#4a6899");
  pg.addColorStop(1, "#26355c");
  ctx.fillStyle = pg;
  ctx.beginPath();
  ctx.arc(px, py, pr, 0, TWO_PI);
  ctx.fill();
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-0.35);
  ctx.strokeStyle = "rgba(196,208,232,0.65)";
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.ellipse(0, 0, pr * 1.6, pr * 0.42, 0, 0, Math.PI);
  ctx.stroke();
  ctx.restore();
}

const PRESET_DEFS: Record<string, PresetDef> = {
  slate: { name: "Slate", stops: ["#1b2733", "#0d141c"], angleDeg: 135 },
  ocean: { name: "Ocean", stops: ["#1f6feb", "#0a2540"], angleDeg: 160 },
  sunset: { name: "Sunset", stops: ["#ff8a3d", "#d7385e"], angleDeg: 120 },
  forest: { name: "Forest", stops: ["#2f9e5f", "#0f3d2e"], angleDeg: 145 },
  studio: { name: "Studio", stops: ["#5a5f66", "#2a2d31"], angleDeg: 180 },
  sloga: { name: "Sloga", stops: ["#000000"], draw: drawSlogaPattern },
  home: { name: "Home", stops: ["#ede5d8"], draw: drawHomeRoom },
  pixel: { name: "Pixel", stops: ["#101426"], draw: drawPixelScatter },
  space: {
    name: "Space",
    stops: ["#04060f"],
    draw: drawSpaceScene,
    animation: { frames: 12, intervalMs: 200 },
  },
};

const presetDataUrlCache = new Map<string, string>();

/**
 * Render a preset to a 1280x720 data URL (cached per frame). `frame` only
 * matters for animated presets — static presets always render frame 0.
 * Returns null if a 2D context is unavailable (never expected in a
 * browser/webview).
 */
function renderPreset(name: string, frame = 0): string | null {
  const key = `${name}#${frame}`;
  const cached = presetDataUrlCache.get(key);
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
    const t = def.animation ? frame / def.animation.frames : 0;
    ctx.save();
    def.draw(ctx, canvas.width, canvas.height, t);
    ctx.restore();
  }

  const url = canvas.toDataURL("image/jpeg", 0.9);
  presetDataUrlCache.set(key, url);
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
    const name = id.slice(PRESET_PREFIX.length);
    const def = PRESET_DEFS[name];
    const url = renderPreset(name);
    if (!def || !url) return null;
    if (def.animation) {
      const frames: string[] = [];
      for (let i = 0; i < def.animation.frames; i++) {
        const f = renderPreset(name, i);
        if (f) frames.push(f);
      }
      if (frames.length > 1) {
        return {
          url,
          frames,
          frameIntervalMs: def.animation.intervalMs,
          revoke: () => {},
        };
      }
    }
    return { url, revoke: () => {} };
  }
  if (id.startsWith(UPLOAD_PREFIX)) {
    const blob = await store.getItem<Blob>(id);
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  return null;
}
