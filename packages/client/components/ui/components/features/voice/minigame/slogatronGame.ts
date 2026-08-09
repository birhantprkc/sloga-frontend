/**
 * Slogatron — the second "play while you wait" call minigame.
 *
 * A tube shooter: you ride the near rim of a segmented well, enemies climb the
 * lanes toward you, you fire down your own lane. Clear the web and you dive
 * through it to the next one, dodging whatever the spikers left behind. Three
 * lives, a superzapper per web, per-device best.
 *
 * A tube shooter IN-HOUSE, not a port — the genre, not anyone's game. Same
 * call as Slogaball vs Peggle: the web shapes, the enemy families and their
 * names are ours.
 *
 * Written under the same two founding rules as slogaballGame.ts, for the same
 * reasons: NO imports (the module must evaluate under `node --test` for the
 * helper specs, so only `createSlogatron` may touch the DOM), and NO image or
 * audio assets (the whole game is this chunk, so there is nothing to stage
 * into a bundled desktop or Android dist — sound is synthesized on WebAudio).
 *
 * Loaded with `await import()` from MinigameChip so vite splits it out of the
 * main bundle.
 */

/** Logical playfield everything is computed in; the canvas letterboxes it. */
export const FIELD_W = 640;
export const FIELD_H = 480;

/** The tube's vanishing point — every depth scales toward this. */
const CX = FIELD_W / 2;
const CY = 250;
/** Rim "radius": every web is normalized so its furthest vertex sits here. */
const RIM_R = 176;

/**
 * How big the far end of the tube is relative to the rim. Drives the whole
 * sense of depth; 0.16 is deep enough to read as a well without shrinking
 * far-end enemies below a couple of pixels.
 */
const FAR_SCALE = 0.16;
/** Pinhole constant derived from FAR_SCALE — see `perspective`. */
const DEPTH_K = 1 / FAR_SCALE - 1;

const START_LIVES = 3;
/** Superzapper charges per web: the first clears the screen, the second takes
 * one enemy. Refilled on every new web. */
const ZAP_CHARGES = 2;

const PLAYER_BULLET_SPEED = 1.7; // depth units per second, rim → far
const ENEMY_BULLET_SPEED = 0.85;
const MAX_PLAYER_BULLETS = 6;
/** Depth tolerance for "the shot and the thing are at the same place". */
const HIT_Z = 0.055;
/** Lane tolerance for the same; a shade over half a lane so a shot down the
 * middle still catches an enemy mid-flip. */
const HIT_U = 0.55;

/** Seconds the rim shooter takes to slide one lane under held input. */
const LANE_REPEAT = 0.075;
const DIVE_SPEED = 0.42; // depth units per second during the descent
/** Tallest a spiker can grow its lane's spike, in depth units from the far
 * end. Deliberately short of 1 — a spike can never reach the rim and kill you
 * where you stand, only on the way down. */
const SPIKE_MAX = 0.82;
/** How much depth one bullet shaves off a spike. */
const SPIKE_CHIP = 0.075;

const SCORE_CRAWLER = 150;
const SCORE_HAULER = 100;
const SCORE_SPIKER = 50;
/** Per web cleared, times the web number. */
const SCORE_WEB = 100;

/** Longest frame we integrate; anything above (a background tab waking up)
 * would teleport everything, so it is simply dropped. */
const MAX_FRAME = 0.05;
/** Fixed simulation step. Bullets cross the tube in well under a second, so
 * at a low frame rate a whole-frame step could carry one straight past an
 * enemy without ever being within HIT_Z of it. */
const FIXED_DT = 1 / 120;

/**
 * The whole field is a fixed palette rather than a themed one — this is a
 * cabinet screen, not app chrome, and it is lit like one: vectors on true
 * black, which is what the genre looks like and what makes thin strokes glow.
 *
 * Every color is drawn from the Sloga mark (same sampling as
 * LoadingProgress.tsx / Slogaball's "O" pegs, from assets/web/sloga-icon.png),
 * each used exactly once so nothing on screen is ambiguous. Pinning them is
 * also the safe choice now the background is pinned: a themed token has no
 * guaranteed contrast against black, and a light theme's `on-surface` would
 * paint the HUD black-on-black.
 *
 * The overlay AROUND the canvas stays themed, so the game reads as a screen
 * set into the app rather than a hole in it.
 */
const FIELD_BG = "#000000";
/** Sloga green, the mark's core — reserved for the player and their shots. */
const PLAYER_COLOR = "#27a163";
/** The rim you ride and the far mouth. */
const WEB_COLOR = "#3bb8ed";
/** Lane rails, deliberately the deepest color in the mark so they recede. */
const RAIL_COLOR = "#2b2bd8";
const CRAWLER_COLOR = "#cf2a27";
const HAULER_COLOR = "#c05fc8";
const SPIKER_COLOR = "#f5870d";
const SPIKE_COLOR = "#e3cf1b";
/** HUD ink. Not a theme token, for the contrast reason above. */
const HUD_INK = "#f1f3f4";
const HUD_DIM = "#8b9198";
/**
 * The title card spells the name in the mark's colors, one per letter. RAIL is
 * left out on purpose: the deepest blue is ~2.4:1 on black, which is exactly
 * what a receding rail wants and no good at all for a letter.
 */
const TITLE_COLORS = [
  PLAYER_COLOR,
  WEB_COLOR,
  SPIKER_COLOR,
  CRAWLER_COLOR,
  SPIKE_COLOR,
  HAULER_COLOR,
];

/** Sinks for per-device state. Deliberately NOT synced settings keys — same
 * reasoning as Slogaball: no DEFAULT_VALUES double-table to keep in sync, and
 * per-device is fine for a time-killer. */
const HIGH_SCORE_KEY = "sloga:minigame:slogatron:high";
const MUTE_KEY = "sloga:minigame:slogatron:muted";

/** Localized copy the engine draws itself; the host passes `t`-macro output at
 * creation time (the canvas can't re-render on locale switch — acceptable for
 * a game session). */
export interface SlogatronStrings {
  gameOver: string;
  playAgain: string;
  webCleared: string;
  zap: string;
  start: string;
  /** A function, not a string: the level changes during a run, and a bare
   * "Web" msgid would be a coin flip for a translator (the web you shoot down
   * vs the World Wide one). With the number in it there is no ambiguity. */
  webLabel: (level: number) => string;
}

/**
 * The engine contract, identical to Slogaball's — MinigameChip holds whichever
 * one is open through this shape and never needs to know which game it has.
 * Declared here rather than imported so this module keeps its no-imports rule;
 * TypeScript is structural, so the two stay interchangeable.
 */
export interface SlogatronHandle {
  /** Stop simulating and drawing (host parks the game). Idempotent. */
  pause(): void;
  /** Start (or continue) the loop. */
  resume(): void;
  /** Tear down listeners and the loop for good. The canvas is the host's. */
  dispose(): void;
  /** Silence (or restore) the sound effects; persisted per device. */
  setMuted(muted: boolean): void;
  isMuted(): boolean;
}

// ---- geometry -----------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

export type WebShape =
  | "circle"
  | "strip"
  | "square"
  | "trough"
  | "star"
  | "wave"
  | "triangle"
  | "clover";

export interface Web {
  shape: WebShape;
  /** A ring you can wrap around, vs a strip with two ends to bump into. */
  closed: boolean;
  /** Rim vertices in field coordinates, in lane order. */
  rim: Point[];
  /** Lanes between vertices: `rim.length` closed, one fewer open. */
  lanes: number;
}

/**
 * Screen scale of a point at depth `z` (0 = far end, 1 = rim). Pinhole, so the
 * spacing bunches up toward the far end the way a real tube does rather than
 * fading linearly.
 */
export function perspective(z: number): number {
  return 1 / (1 + (1 - z) * DEPTH_K);
}

/** Unit-ish outlines, normalized and scaled by `makeWeb`. Every closed shape
 * is star-shaped about the origin, which is what lets a lane be found from a
 * pointer angle. */
function outline(shape: WebShape, lanes: number): Point[] {
  const pts: Point[] = [];
  const ring = (r: (a: number) => number) => {
    for (let i = 0; i < lanes; i++) {
      const a = -Math.PI / 2 + (i * Math.PI * 2) / lanes;
      pts.push({ x: Math.cos(a) * r(a), y: Math.sin(a) * r(a) });
    }
  };

  switch (shape) {
    case "circle":
      ring(() => 1);
      break;
    case "star":
      // Alternating radii; `lanes` is even in the catalog so the points close.
      for (let i = 0; i < lanes; i++) {
        const a = -Math.PI / 2 + (i * Math.PI * 2) / lanes;
        const r = i % 2 === 0 ? 1 : 0.52;
        pts.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
      }
      break;
    case "clover":
      ring((a) => 1 + 0.26 * Math.cos(4 * a));
      break;
    case "square":
      // Walk the perimeter of a unit square, corners included.
      for (let i = 0; i < lanes; i++) {
        const t = (i / lanes) * 4;
        const side = Math.floor(t);
        const f = t - side;
        const corners: Point[] = [
          { x: -1, y: -1 },
          { x: 1, y: -1 },
          { x: 1, y: 1 },
          { x: -1, y: 1 },
        ];
        const a = corners[side];
        const b = corners[(side + 1) % 4];
        pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
      break;
    case "triangle":
      for (let i = 0; i < lanes; i++) {
        const t = (i / lanes) * 3;
        const side = Math.floor(t);
        const f = t - side;
        const corner = (k: number): Point => {
          const a = -Math.PI / 2 + (k * Math.PI * 2) / 3;
          return { x: Math.cos(a), y: Math.sin(a) };
        };
        const a = corner(side);
        const b = corner((side + 1) % 3);
        pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      }
      break;
    case "strip":
      // Open: a flat run across the lower half, the classic "no wrap" web.
      for (let i = 0; i <= lanes; i++)
        pts.push({ x: -1.3 + (2.6 * i) / lanes, y: 0.62 });
      break;
    case "trough":
      // Open: a V. Ends high, apex low — shots from the middle feel different
      // to shots from the ends, which is the point of an open web.
      for (let i = 0; i <= lanes; i++) {
        const t = i / lanes;
        const x = -1.15 + 2.3 * t;
        pts.push({ x, y: -0.35 + 1.25 * (1 - Math.abs(1 - 2 * t)) });
      }
      break;
    case "wave":
      // A gentle S, NOT a ripple. The radius of curvature has to stay well
      // above a lane's width or the run stops reading as a run: a tighter
      // wave both looks like a scribble and steers badly, because a pointer
      // a thumb's width off a concave arc is genuinely nearest some lane
      // further along it.
      for (let i = 0; i <= lanes; i++) {
        const t = i / lanes;
        const x = -1.25 + 2.5 * t;
        pts.push({ x, y: 0.52 + 0.22 * Math.sin(x * Math.PI * 0.6) });
      }
      break;
  }
  return pts;
}

/** Shape rotation. Deliberately fixed rather than random: a web you have seen
 * before should be the web you remember, and the sequence is the difficulty
 * curve. */
const WEB_CATALOG: { shape: WebShape; closed: boolean; lanes: number }[] = [
  { shape: "circle", closed: true, lanes: 16 },
  { shape: "strip", closed: false, lanes: 12 },
  { shape: "square", closed: true, lanes: 16 },
  { shape: "trough", closed: false, lanes: 12 },
  { shape: "star", closed: true, lanes: 16 },
  { shape: "wave", closed: false, lanes: 14 },
  { shape: "triangle", closed: true, lanes: 15 },
  { shape: "clover", closed: true, lanes: 20 },
];

/**
 * The web for a given level (1-based), cycling through the catalog. Vertices
 * are normalized so the furthest one lands exactly on RIM_R, which is what
 * keeps every shape inside the field however wild its outline is.
 */
export function makeWeb(level: number): Web {
  const spec =
    WEB_CATALOG[(Math.max(1, Math.floor(level)) - 1) % WEB_CATALOG.length];
  const raw = outline(spec.shape, spec.lanes);
  let max = 0;
  for (const p of raw) max = Math.max(max, Math.hypot(p.x, p.y));
  const k = RIM_R / (max || 1);
  return {
    shape: spec.shape,
    closed: spec.closed,
    lanes: spec.lanes,
    rim: raw.map((p) => ({ x: CX + p.x * k, y: CY + p.y * k })),
  };
}

/**
 * A point on the rim at continuous lane coordinate `u` (0 = first vertex, 0.5
 * = middle of lane 0). Wraps on a closed web, clamps on an open one.
 */
export function rimPoint(web: Web, u: number): Point {
  const n = web.rim.length;
  let t = u;
  if (web.closed) {
    t = ((t % web.lanes) + web.lanes) % web.lanes;
  } else {
    t = Math.max(0, Math.min(web.lanes, t));
  }
  const i = Math.min(Math.floor(t), web.lanes - 1);
  const f = t - i;
  const a = web.rim[i % n];
  const b = web.rim[(i + 1) % n];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

/**
 * Project a rim coordinate to the screen at depth `z`, seen from a camera
 * sitting at depth `camZ`. During normal play the camera is at the rim
 * (camZ = 1) and this is just the perspective scale; during the dive camZ
 * falls toward 0 and the far end swells to fill the rim — which is the whole
 * illusion of flying down the tube.
 */
export function projectPoint(web: Web, u: number, z: number, camZ = 1): Point {
  const p = rimPoint(web, u);
  const s = perspective(z) / perspective(camZ);
  return { x: CX + (p.x - CX) * s, y: CY + (p.y - CY) * s };
}

/**
 * Signed lane distance from `a` to `b`, taking the short way round a closed
 * web. Used for aiming, for rim enemies hunting the player, and for picking
 * the zapper's victim.
 */
export function laneDelta(web: Web, a: number, b: number): number {
  let d = b - a;
  if (!web.closed) return d;
  const n = web.lanes;
  d = ((d % n) + n) % n;
  return d > n / 2 ? d - n : d;
}

/** Move `lane` by `dir`, wrapping on a closed web and stopping at the ends of
 * an open one. */
export function stepLane(web: Web, lane: number, dir: number): number {
  const next = lane + dir;
  if (web.closed) return ((next % web.lanes) + web.lanes) % web.lanes;
  return Math.max(0, Math.min(web.lanes - 1, next));
}

/**
 * The lane nearest a point in field coordinates — how a pointer drag steers.
 *
 * Two rules, because the two kinds of web want different ones. A CLOSED web is
 * star-shaped about the vanishing point (`outline` only produces such shapes,
 * and the spec pins it), so its vertex angles run monotonically round the
 * middle and the lane is just the angular sector the pointer falls in. That
 * beats nearest-segment on the concave shapes: 60px outside a star's notch is
 * measurably closer to the neighboring spike than to the lane you are plainly
 * pointing at. An OPEN web has no meaningful angle at all — the strip sits off
 * to one side of the vanishing point — so those fall back to the nearest point
 * on the polyline, which is exactly right for a run you slide along.
 */
export function nearestLane(web: Web, x: number, y: number): number {
  if (web.closed) {
    const base = Math.atan2(web.rim[0].y - CY, web.rim[0].x - CX);
    const fromBase = (a: number) => {
      const t = (a - base) % (Math.PI * 2);
      return t < 0 ? t + Math.PI * 2 : t;
    };
    const d = fromBase(Math.atan2(y - CY, x - CX));
    let lane = 0;
    for (let i = 1; i < web.lanes; i++) {
      if (fromBase(Math.atan2(web.rim[i].y - CY, web.rim[i].x - CX)) > d) break;
      lane = i;
    }
    return lane;
  }

  let bestLane = 0;
  let bestD = Infinity;
  const n = web.rim.length;
  for (let i = 0; i < web.lanes; i++) {
    const a = web.rim[i % n];
    const b = web.rim[(i + 1) % n];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy || 1;
    // Clamped projection of (x,y) onto the segment.
    const t = Math.max(
      0,
      Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / len2),
    );
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = (x - px) ** 2 + (y - py) ** 2;
    if (d < bestD) {
      bestD = d;
      bestLane = i;
    }
  }
  return bestLane;
}

// ---- enemies ------------------------------------------------------------

export type EnemyKind = "crawler" | "hauler" | "spiker";

export interface Enemy {
  kind: EnemyKind;
  /** Continuous lane position — the center of the lane it occupies, or
   * somewhere between two lanes mid-flip. */
  u: number;
  /** Depth: 0 at the far end, 1 at the rim. */
  z: number;
  /** Depth units per second. */
  speed: number;
  /** Seconds until the next lane change is considered. */
  flipIn: number;
  /** In-progress lane change; `t` runs 0 → 1. */
  flip: { from: number; to: number; t: number } | null;
  /** Arrived at the rim and now hunting along it. */
  onRim: boolean;
  /** Seconds until it shoots; Infinity for kinds that never do. */
  fireIn: number;
  /** Spikers only: climbing (+1) or retreating (-1) while extruding. */
  dir: number;
}

/** What a level throws at you. Ramps, then plateaus so the late webs stay
 * playable rather than turning into a wall. */
export function waveSpec(level: number): {
  crawlers: number;
  haulers: number;
  spikers: number;
  speed: number;
  fireRate: number;
} {
  const l = Math.max(1, Math.floor(level));
  return {
    crawlers: Math.min(4 + l, 12),
    haulers: l < 2 ? 0 : Math.min(1 + Math.floor((l - 2) / 2), 5),
    spikers: l < 3 ? 0 : Math.min(1 + Math.floor((l - 3) / 2), 4),
    speed: Math.min(0.08 + l * 0.012, 0.24),
    // Seconds between shots, per enemy, shrinking with depth of level.
    fireRate: Math.max(1.5, 5 - l * 0.25),
  };
}

/** Score for killing one of these. */
export function enemyScore(kind: EnemyKind): number {
  return kind === "crawler"
    ? SCORE_CRAWLER
    : kind === "hauler"
      ? SCORE_HAULER
      : SCORE_SPIKER;
}

/**
 * Does a shot fired down `bulletLane` at depth `bulletZ` connect with `enemy`?
 * Pure so the lane-wrapping edge (a shot in lane 0 catching an enemy mid-flip
 * out of the last lane) is covered by a spec rather than by playtesting.
 */
export function bulletHits(
  web: Web,
  bulletLane: number,
  bulletZ: number,
  enemy: { u: number; z: number },
): boolean {
  return (
    Math.abs(bulletZ - enemy.z) < HIT_Z &&
    Math.abs(laneDelta(web, bulletLane + 0.5, enemy.u)) < HIT_U
  );
}

/**
 * Fire the superzapper. The first charge of a web clears everything; the
 * second takes only the enemy nearest the rim — the one about to reach you.
 * Returns the victims and what they were worth, leaving the caller to do the
 * killing so the visual side (particles, sound) stays out of here.
 */
export function resolveZap(
  enemies: Enemy[],
  charges: number,
): { killed: Enemy[]; score: number; chargesLeft: number } {
  if (charges <= 0 || !enemies.length)
    return { killed: [], score: 0, chargesLeft: charges };

  let killed: Enemy[];
  if (charges >= ZAP_CHARGES) {
    killed = enemies.slice();
  } else {
    let worst = enemies[0];
    for (const e of enemies) if (e.z > worst.z) worst = e;
    killed = [worst];
  }
  return {
    killed,
    score: killed.reduce((s, e) => s + enemyScore(e.kind), 0),
    chargesLeft: charges - 1,
  };
}

// ---- engine -------------------------------------------------------------

export function createSlogatron(
  canvas: HTMLCanvasElement,
  strings: SlogatronStrings,
): SlogatronHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // 2d context refused (nothing sane to do; the overlay just stays blank).
    return {
      pause() {},
      resume() {},
      dispose() {},
      setMuted() {},
      isMuted: () => true,
    };
  }

  // ---- audio ----------------------------------------------------------
  // Synthesized, for the module's founding rules: no assets to stage into a
  // desktop/Android dist, and no module-level DOM (this all lives inside
  // `createSlogatron`, so the helper specs still run under `node --test`).
  let muted = false;
  try {
    muted = localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    /* storage denied — the preference just won't persist */
  }
  let audio: AudioContext | null = null;
  let master: GainNode | null = null;
  /**
   * Unlike Slogaball, this game makes noise on its own — enemies spawn and
   * shoot before the player has touched anything. Autoplay policy would refuse
   * that context anyway, so nothing is allowed to sound until the first real
   * gesture and the context is only allocated then.
   */
  let gestured = false;
  let lastBlip = 0;

  function audioCtx(): AudioContext | null {
    if (muted || !gestured) return null;
    if (!audio) {
      const Ctor =
        window.AudioContext ??
        (window as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!Ctor) return null;
      try {
        audio = new Ctor();
        master = audio.createGain();
        // Effects sit under a call — keep them well below speech level.
        master.gain.value = 0.3;
        master.connect(audio.destination);
      } catch {
        return null;
      }
    }
    if (audio.state === "suspended") void audio.resume().catch(() => {});
    return audio;
  }

  /** One enveloped oscillator note at `when` seconds from now; `glide` slides
   * the pitch to that frequency over the note's length. */
  function note(
    freq: number,
    dur: number,
    type: OscillatorType,
    vol: number,
    when = 0,
    glide?: number,
  ) {
    const c = audioCtx();
    if (!c || !master) return;
    const t0 = c.currentTime + when;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glide !== undefined)
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, glide), t0 + dur);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(vol, t0 + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain);
    gain.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  /** Filtered noise burst — the percussive half of every explosion. */
  function noise(dur: number, from: number, to: number, vol: number) {
    const c = audioCtx();
    if (!c || !master) return;
    const buf = c.createBuffer(1, Math.ceil(c.sampleRate * dur), c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++)
      data[i] = (Math.random() * 2 - 1) * (1 - i / data.length) ** 2;
    const src = c.createBufferSource();
    src.buffer = buf;
    const lp = c.createBiquadFilter();
    lp.type = "lowpass";
    lp.frequency.setValueAtTime(from, c.currentTime);
    lp.frequency.exponentialRampToValueAtTime(to, c.currentTime + dur);
    const gain = c.createGain();
    gain.gain.value = vol;
    src.connect(lp);
    lp.connect(gain);
    gain.connect(master);
    src.start();
    src.onended = () => {
      src.disconnect();
      lp.disconnect();
      gain.disconnect();
    };
  }

  const sfx = {
    /** Rate-limited: holding fire is a legitimate way to play. */
    shoot: () => {
      if (clock - lastBlip < 0.05) return;
      lastBlip = clock;
      note(880, 0.06, "square", 0.16, 0, 300);
    },
    kill: (kind: EnemyKind) => {
      if (kind === "hauler") {
        note(180, 0.22, "sawtooth", 0.32, 0, 60);
        noise(0.18, 2200, 300, 0.3);
      } else if (kind === "spiker") {
        note(1200, 0.1, "square", 0.2, 0, 500);
      } else {
        note(420, 0.12, "triangle", 0.28, 0, 140);
        noise(0.1, 3000, 600, 0.18);
      }
    },
    zap: () => {
      // A descending sweep with noise on top — unmistakably the big button.
      note(1400, 0.5, "sawtooth", 0.3, 0, 60);
      noise(0.45, 6000, 200, 0.35);
    },
    spike: () => note(240, 0.05, "square", 0.12),
    /** Losing a life. */
    death: () => {
      note(300, 0.5, "sawtooth", 0.35, 0, 40);
      noise(0.45, 1800, 80, 0.4);
    },
    cleared: () => {
      const arp = [523, 659, 784, 1047, 1319];
      arp.forEach((f, i) => note(f, 0.16, "triangle", 0.26, i * 0.08));
    },
    dive: () => note(120, 0.6, "sine", 0.22, 0, 420),
    gameOver: () => {
      note(392, 0.22, "triangle", 0.3);
      note(311, 0.24, "triangle", 0.3, 0.2);
      note(233, 0.5, "triangle", 0.3, 0.42);
    },
  };

  // ---- state ----------------------------------------------------------

  type Phase = "ready" | "play" | "dive" | "dying" | "cleared" | "over";
  let phase: Phase = "ready";
  let level = 1;
  let web = makeWeb(level);
  let enemies: Enemy[] = [];
  /** Spike height per lane, in depth units from the far end. */
  let spikes: number[] = new Array(web.lanes).fill(0);
  let playerLane = 0;
  /** Eased lane position, purely visual — the shooter slides rather than
   * teleporting when you drag across half the web. */
  let playerVisU = 0.5;
  /** Camera depth. 1 during play; falls to 0 through the dive. */
  let camZ = 1;
  let lives = START_LIVES;
  let zapCharges = ZAP_CHARGES;
  let score = 0;
  let best = 0;
  try {
    best = Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
  } catch {
    /* storage denied — best just won't persist */
  }

  let bullets: { lane: number; z: number }[] = [];
  let enemyBullets: { u: number; z: number }[] = [];
  // Never reset between levels — a few sparks carrying over a web change is
  // the right amount of continuity.
  const particles: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    ttl: number;
    life: number;
    color: string;
  }[] = [];

  let clock = 0;
  /** Seconds left in the current non-interactive beat (death, cleared). */
  let beat = 0;
  let spawnIn = 0;
  let toSpawn: EnemyKind[] = [];
  /** Held-input lane repeat. */
  let holdDir = 0;
  let holdIn = 0;
  let firing = false;
  let fireCooldown = 0;

  function rand(a: number, b: number) {
    return a + Math.random() * (b - a);
  }

  /**
   * Every point earned goes through here. The per-device best is only ever as
   * good as the last scoring path that remembered to update it, and the
   * web-clear bonus is exactly the kind that gets forgotten — it did, and the
   * best sat one bonus behind the score on screen.
   */
  function addScore(n: number) {
    score += n;
    if (score <= best) return;
    best = score;
    try {
      localStorage.setItem(HIGH_SCORE_KEY, String(best));
    } catch {
      /* storage denied — best just won't persist */
    }
  }

  function laneOf(e: Enemy): number {
    const n = web.lanes;
    return ((Math.floor(e.u) % n) + n) % n;
  }

  function spawnQueue(spec: ReturnType<typeof waveSpec>): EnemyKind[] {
    const q: EnemyKind[] = [];
    for (let i = 0; i < spec.crawlers; i++) q.push("crawler");
    for (let i = 0; i < spec.haulers; i++) q.push("hauler");
    for (let i = 0; i < spec.spikers; i++) q.push("spiker");
    // Shuffle so the wave doesn't arrive sorted by kind.
    for (let i = q.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [q[i], q[j]] = [q[j], q[i]];
    }
    return q;
  }

  function makeEnemy(kind: EnemyKind, lane: number): Enemy {
    const spec = waveSpec(level);
    return {
      kind,
      u: lane + 0.5,
      z: 0,
      speed:
        spec.speed * (kind === "hauler" ? 0.72 : kind === "spiker" ? 0.5 : 1),
      flipIn: rand(0.6, 2.2),
      flip: null,
      onRim: false,
      fireIn: kind === "spiker" ? Infinity : rand(1.5, spec.fireRate * 2),
      dir: 1,
    };
  }

  function startLevel(n: number) {
    level = n;
    web = makeWeb(level);
    spikes = new Array(web.lanes).fill(0);
    enemies = [];
    bullets = [];
    enemyBullets = [];
    toSpawn = spawnQueue(waveSpec(level));
    spawnIn = 0.4;
    zapCharges = ZAP_CHARGES;
    camZ = 1;
    playerLane = Math.min(playerLane, web.lanes - 1);
    playerVisU = playerLane + 0.5;
    phase = "play";
  }

  function newGame() {
    score = 0;
    lives = START_LIVES;
    playerLane = 0;
    startLevel(1);
  }

  function burst(x: number, y: number, color: string, count = 10) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(40, 190);
      const life = rand(0.25, 0.6);
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        ttl: life,
        life,
        color,
      });
    }
  }

  function killEnemy(e: Enemy, credit = true) {
    const i = enemies.indexOf(e);
    if (i < 0) return;
    enemies.splice(i, 1);
    const p = projectPoint(web, e.u, e.z, camZ);
    burst(p.x, p.y, colorOf(e.kind));
    if (credit) addScore(enemyScore(e.kind));
    // A hauler is a delivery mechanism: shooting it releases what it carried
    // into the neighboring lanes, which is what makes it worth less than the
    // crawlers it becomes.
    if (e.kind === "hauler") {
      const lane = laneOf(e);
      for (const dir of [-1, 1]) {
        const child = makeEnemy("crawler", stepLane(web, lane, dir));
        child.z = e.z;
        enemies.push(child);
      }
    }
  }

  function colorOf(kind: EnemyKind): string {
    return kind === "crawler"
      ? CRAWLER_COLOR
      : kind === "hauler"
        ? HAULER_COLOR
        : SPIKER_COLOR;
  }

  function loseLife() {
    if (phase === "dying" || phase === "over") return;
    lives--;
    sfx.death();
    const p = projectPoint(web, playerVisU, camZ, camZ);
    burst(p.x, p.y, PLAYER_COLOR, 22);
    enemyBullets = [];
    if (lives <= 0) {
      phase = "over";
      beat = 0;
      sfx.gameOver();
      return;
    }
    phase = "dying";
    beat = 1.1;
  }

  /** After a death: clear whatever was about to touch you and carry on with
   * the same web, rather than restarting it — losing a life is punishment
   * enough for a game meant to absorb thirty idle seconds. */
  function respawn() {
    if (phase === "dive" || camZ < 1) {
      // Died on the way down: the dive is over, take the next web anyway.
      startLevel(level + 1);
      return;
    }
    enemies = enemies.filter((e) => !e.onRim && e.z < 0.75);
    phase = "play";
  }

  function fire() {
    if (phase !== "play" && phase !== "dive") return;
    if (bullets.length >= MAX_PLAYER_BULLETS) return;
    bullets.push({ lane: playerLane, z: phase === "dive" ? camZ : 1 });
    sfx.shoot();
  }

  function zap() {
    if (phase !== "play" || zapCharges <= 0) return;
    const res = resolveZap(enemies, zapCharges);
    if (!res.killed.length) return;
    zapCharges = res.chargesLeft;
    sfx.zap();
    for (const e of res.killed) {
      // No hauler split on a zap — the whole point of the big button is that
      // it makes things go away.
      const i = enemies.indexOf(e);
      if (i >= 0) enemies.splice(i, 1);
      const p = projectPoint(web, e.u, e.z, camZ);
      burst(p.x, p.y, colorOf(e.kind), 8);
    }
    addScore(res.score);
  }

  // ---- simulation -----------------------------------------------------

  function stepEnemies(dt: number) {
    const spec = waveSpec(level);

    for (const e of enemies) {
      // Lane change in progress: slide across, bulging slightly toward the
      // camera so it reads as going OVER the rail rather than through it.
      if (e.flip) {
        e.flip.t += dt * 2.6;
        if (e.flip.t >= 1) {
          e.u = e.flip.to + 0.5;
          e.flip = null;
        } else {
          const d = laneDelta(web, e.flip.from, e.flip.to);
          e.u = e.flip.from + 0.5 + d * e.flip.t;
        }
      }

      if (e.kind === "spiker") {
        // Climbs and retreats on a loop, leaving its lane's spike as tall as
        // it ever got.
        e.z += e.speed * e.dir * dt;
        const lane = laneOf(e);
        spikes[lane] = Math.min(SPIKE_MAX, Math.max(spikes[lane], e.z));
        if (e.z >= SPIKE_MAX) e.dir = -1;
        if (e.z <= 0.05) e.dir = 1;
        continue;
      }

      if (!e.onRim) {
        e.z += e.speed * dt;
        if (e.z >= 1) {
          e.z = 1;
          e.onRim = true;
        }
      } else {
        // At the rim: hunt the player along it. Contact is a death.
        const d = laneDelta(web, e.u, playerLane + 0.5);
        const sp = 1.6 * dt;
        e.u += Math.max(-sp, Math.min(sp, d));
        if (Math.abs(d) < 0.35 && phase === "play") loseLife();
      }

      // Crawlers wander sideways on the way up; haulers hold their lane so
      // you can see exactly where the split is going to happen.
      if (e.kind === "crawler" && !e.flip) {
        e.flipIn -= dt;
        if (e.flipIn <= 0) {
          e.flipIn = rand(0.7, 2.4);
          const from = laneOf(e);
          const dir = Math.random() < 0.5 ? -1 : 1;
          const to = stepLane(web, from, dir);
          if (to !== from) e.flip = { from, to, t: 0 };
        }
      }

      if (e.fireIn !== Infinity && !e.onRim) {
        e.fireIn -= dt;
        if (e.fireIn <= 0) {
          e.fireIn = rand(spec.fireRate, spec.fireRate * 2.2);
          enemyBullets.push({ u: e.u, z: e.z });
        }
      }
    }
  }

  function stepBullets(dt: number) {
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.z -= PLAYER_BULLET_SPEED * dt;

      let spent = false;
      for (const e of enemies) {
        if (bulletHits(web, b.lane, b.z, e)) {
          sfx.kill(e.kind);
          killEnemy(e);
          spent = true;
          break;
        }
      }

      // Spikes are shootable — that is how you make the dive survivable.
      if (!spent && spikes[b.lane] > 0 && b.z <= spikes[b.lane]) {
        spikes[b.lane] = Math.max(0, spikes[b.lane] - SPIKE_CHIP);
        const p = projectPoint(web, b.lane + 0.5, b.z, camZ);
        burst(p.x, p.y, SPIKE_COLOR, 3);
        sfx.spike();
        spent = true;
      }

      if (spent || b.z <= 0) bullets.splice(i, 1);
    }

    for (let i = enemyBullets.length - 1; i >= 0; i--) {
      const b = enemyBullets[i];
      b.z += ENEMY_BULLET_SPEED * dt;
      if (b.z >= camZ) {
        // Reached the shooter's depth: a hit only if it came up your lane.
        if (
          phase === "play" &&
          Math.abs(laneDelta(web, playerLane + 0.5, b.u)) < 0.6
        )
          loseLife();
        enemyBullets.splice(i, 1);
      }
    }
  }

  function stepPlay(dt: number) {
    if (toSpawn.length) {
      spawnIn -= dt;
      if (spawnIn <= 0) {
        spawnIn = rand(0.35, 1.1);
        const kind = toSpawn.pop()!;
        // Spikers claim a lane that hasn't got one yet, so the dive stays
        // survivable — a web where every lane is spiked is not a puzzle.
        let lane = Math.floor(Math.random() * web.lanes);
        if (kind === "spiker") {
          const free = [];
          for (let i = 0; i < web.lanes; i++) if (!spikes[i]) free.push(i);
          if (free.length) lane = free[Math.floor(Math.random() * free.length)];
        }
        enemies.push(makeEnemy(kind, lane));
      }
    }

    stepEnemies(dt);
    stepBullets(dt);

    if (!enemies.length && !toSpawn.length) {
      phase = "cleared";
      beat = 1.2;
      addScore(SCORE_WEB * level);
      sfx.cleared();
    }
  }

  function stepDive(dt: number) {
    camZ -= DIVE_SPEED * dt;
    stepBullets(dt);
    // The `> 0` is load-bearing: a lane with no spike has height 0, and the
    // dive ends with camZ at or just below 0, so without it every clean
    // descent would kill you on its very last step. Shooting a spike down to
    // nothing during the dive genuinely saves you, by the same test.
    if (spikes[playerLane] > 0 && camZ <= spikes[playerLane]) {
      loseLife();
      return;
    }
    if (camZ <= 0) startLevel(level + 1);
  }

  function step(dt: number) {
    clock += dt;

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.ttl -= dt;
      if (p.ttl <= 0) {
        particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 1.8 * dt;
      p.vy *= 1 - 1.8 * dt;
    }

    // Held movement, and held fire.
    if (holdDir && (phase === "play" || phase === "dive")) {
      holdIn -= dt;
      if (holdIn <= 0) {
        holdIn = LANE_REPEAT;
        playerLane = stepLane(web, playerLane, holdDir);
      }
    }
    if (firing) {
      fireCooldown -= dt;
      if (fireCooldown <= 0) {
        fireCooldown = 0.12;
        fire();
      }
    }

    // Ease the drawn shooter toward its lane, the short way round.
    const target = playerLane + 0.5;
    const d = laneDelta(web, playerVisU, target);
    playerVisU += d * Math.min(1, dt * 18);

    if (phase === "play") stepPlay(dt);
    else if (phase === "dive") stepDive(dt);
    else if (phase === "cleared" || phase === "dying") {
      beat -= dt;
      if (beat <= 0) {
        if (phase === "cleared") {
          phase = "dive";
          sfx.dive();
        } else respawn();
      }
    }
  }

  // ---- rendering ------------------------------------------------------

  let dpr = 1;
  let scale = 1;
  let ox = 0;
  let oy = 0;

  function fitCanvas() {
    dpr = window.devicePixelRatio || 1;
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    if (!cw || !ch) return false;
    const bw = Math.round(cw * dpr);
    const bh = Math.round(ch * dpr);
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    scale = Math.min(cw / FIELD_W, ch / FIELD_H);
    ox = (cw - FIELD_W * scale) / 2;
    oy = (ch - FIELD_H * scale) / 2;
    return true;
  }

  /** Trace a rim ring (or run) at depth `z` without stroking it. */
  function tracePath(c: CanvasRenderingContext2D, z: number) {
    c.beginPath();
    const n = web.rim.length;
    const count = web.closed ? n : web.lanes + 1;
    for (let i = 0; i < count; i++) {
      const p = projectPoint(web, i, z, camZ);
      if (i === 0) c.moveTo(p.x, p.y);
      else c.lineTo(p.x, p.y);
    }
    if (web.closed) c.closePath();
  }

  /**
   * Bloom for a single stroke. Canvas shadows are expensive, and this game
   * runs UNDER A CALL — so only the two strokes that carry the look get one
   * (the rim and the shooter), never the per-enemy or per-particle draws.
   */
  function glow(c: CanvasRenderingContext2D, color: string, amount: number) {
    c.shadowColor = color;
    c.shadowBlur = amount;
  }

  function noGlow(c: CanvasRenderingContext2D) {
    c.shadowBlur = 0;
  }

  function drawWeb(c: CanvasRenderingContext2D) {
    // Lane rails, far end to the camera plane.
    c.lineWidth = 1.4;
    c.strokeStyle = RAIL_COLOR;
    c.globalAlpha = 0.85;
    const count = web.closed ? web.lanes : web.lanes + 1;
    for (let i = 0; i < count; i++) {
      const a = projectPoint(web, i, 0, camZ);
      const b = projectPoint(web, i, camZ, camZ);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
    }
    c.globalAlpha = 1;

    // Far mouth — the same blue as the rim but dimmed, which reads as distance
    // rather than as a different piece of scenery.
    tracePath(c, 0);
    c.strokeStyle = WEB_COLOR;
    c.globalAlpha = 0.5;
    c.lineWidth = 1.6;
    c.stroke();
    c.globalAlpha = 1;

    // The rim you ride, bright and lit.
    tracePath(c, camZ);
    c.strokeStyle = WEB_COLOR;
    c.lineWidth = 3;
    glow(c, WEB_COLOR, 12);
    c.stroke();
    noGlow(c);
  }

  function drawSpikes(c: CanvasRenderingContext2D) {
    c.strokeStyle = SPIKE_COLOR;
    c.lineWidth = 2;
    for (let i = 0; i < web.lanes; i++) {
      const h = spikes[i];
      if (h <= 0) continue;
      const top = Math.min(h, camZ);
      const a = projectPoint(web, i + 0.5, 0, camZ);
      const b = projectPoint(web, i + 0.5, top, camZ);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(b.x, b.y);
      c.stroke();
      // Barbs, so a tall spike reads as tall rather than as a long line.
      const rungs = Math.max(1, Math.round(h * 8));
      for (let k = 1; k <= rungs; k++) {
        const z = (top * k) / (rungs + 1);
        const l = projectPoint(web, i + 0.32, z, camZ);
        const r = projectPoint(web, i + 0.68, z, camZ);
        c.beginPath();
        c.moveTo(l.x, l.y);
        c.lineTo(r.x, r.y);
        c.stroke();
      }
    }
  }

  function drawEnemy(c: CanvasRenderingContext2D, e: Enemy) {
    if (e.z > camZ) return;
    c.strokeStyle = colorOf(e.kind);
    c.lineWidth = 2;
    const L = projectPoint(web, e.u - 0.5, e.z, camZ);
    const R = projectPoint(web, e.u + 0.5, e.z, camZ);
    const near = projectPoint(web, e.u, Math.min(camZ, e.z + 0.05), camZ);
    const far = projectPoint(web, e.u, Math.max(0, e.z - 0.05), camZ);

    if (e.kind === "crawler") {
      // A bowtie spanning the lane — the shape that tells you it can flip.
      c.beginPath();
      c.moveTo(L.x, L.y);
      c.lineTo(R.x, R.y);
      c.moveTo(L.x, L.y);
      c.lineTo(near.x, near.y);
      c.lineTo(R.x, R.y);
      c.lineTo(far.x, far.y);
      c.closePath();
      c.stroke();
    } else if (e.kind === "hauler") {
      // A closed box: nothing gets out until you open it.
      c.beginPath();
      c.moveTo(L.x, L.y);
      c.lineTo(near.x, near.y);
      c.lineTo(R.x, R.y);
      c.lineTo(far.x, far.y);
      c.closePath();
      c.stroke();
      c.beginPath();
      c.moveTo(L.x, L.y);
      c.lineTo(R.x, R.y);
      c.stroke();
    } else {
      // Spiker: a zigzag, drawn as the thing that is extruding the spike.
      c.beginPath();
      for (let k = 0; k <= 4; k++) {
        const p = projectPoint(
          web,
          e.u + (k % 2 === 0 ? -0.28 : 0.28),
          Math.max(0, e.z - 0.03 + k * 0.015),
          camZ,
        );
        if (k === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
      }
      c.stroke();
    }
  }

  function drawPlayer(c: CanvasRenderingContext2D) {
    if (phase === "dying" && Math.floor(clock * 12) % 2 === 0) return;
    const z = camZ;
    const A = projectPoint(web, playerVisU - 0.48, z, camZ);
    const B = projectPoint(web, playerVisU + 0.48, z, camZ);
    const M = projectPoint(web, playerVisU, z, camZ);
    // Outward normal, so the claw sits proud of the rim on any web shape.
    const nx = M.x - CX;
    const ny = M.y - CY;
    const len = Math.hypot(nx, ny) || 1;
    const ux = (nx / len) * 15;
    const uy = (ny / len) * 15;

    c.strokeStyle = PLAYER_COLOR;
    c.lineWidth = 2.5;
    glow(c, PLAYER_COLOR, 10);
    c.beginPath();
    c.moveTo(A.x + ux, A.y + uy);
    c.lineTo(A.x, A.y);
    c.lineTo(M.x + ux * 0.55, M.y + uy * 0.55);
    c.lineTo(B.x, B.y);
    c.lineTo(B.x + ux, B.y + uy);
    c.stroke();
    noGlow(c);
  }

  /** The zapper's on-canvas button — the touch affordance for a control that
   * would otherwise be keyboard-only. */
  const ZAP_BTN = { x: FIELD_W - 92, y: FIELD_H - 40, w: 76, h: 28 };

  function drawHud(c: CanvasRenderingContext2D) {
    c.textAlign = "left";
    c.font = "700 18px system-ui, sans-serif";
    c.fillStyle = HUD_INK;
    c.fillText(String(score), 16, 28);

    c.textAlign = "right";
    c.font = "600 13px system-ui, sans-serif";
    c.fillStyle = HUD_DIM;
    c.fillText(String(best), FIELD_W - 16, 28);

    c.textAlign = "center";
    c.font = "600 13px system-ui, sans-serif";
    c.fillText(strings.webLabel(level), CX, 28);

    // Lives, as little claws.
    c.strokeStyle = PLAYER_COLOR;
    c.lineWidth = 2;
    for (let i = 0; i < lives; i++) {
      const x = 18 + i * 22;
      const y = FIELD_H - 22;
      c.beginPath();
      c.moveTo(x, y - 7);
      c.lineTo(x, y);
      c.lineTo(x + 7, y - 4);
      c.lineTo(x + 14, y);
      c.lineTo(x + 14, y - 7);
      c.stroke();
    }

    // Zapper button — the touch affordance; also the charge indicator.
    if (zapCharges > 0) {
      c.globalAlpha = zapCharges >= ZAP_CHARGES ? 1 : 0.55;
      c.strokeStyle = HUD_INK;
      c.lineWidth = 1.5;
      c.beginPath();
      c.roundRect(ZAP_BTN.x, ZAP_BTN.y, ZAP_BTN.w, ZAP_BTN.h, ZAP_BTN.h / 2);
      c.stroke();
      c.fillStyle = HUD_INK;
      c.font = "700 13px system-ui, sans-serif";
      c.textAlign = "center";
      c.fillText(
        strings.zap,
        ZAP_BTN.x + ZAP_BTN.w / 2,
        ZAP_BTN.y + ZAP_BTN.h / 2 + 4.5,
      );
      c.globalAlpha = 1;
    }
  }

  function drawBanner(c: CanvasRenderingContext2D) {
    if (phase === "play" || phase === "dive" || phase === "dying") return;
    c.fillStyle = "rgba(0, 0, 0, 0.72)";
    c.fillRect(0, 0, FIELD_W, FIELD_H);
    c.textAlign = "center";
    c.fillStyle = HUD_INK;
    c.font = "800 28px system-ui, sans-serif";

    if (phase === "ready") {
      // The title wears the mark: one letter per color, in the order the dots
      // run round the Sloga "O".
      const name = "SLOGATRON";
      const widths = [...name].map((ch) => c.measureText(ch).width);
      const total = widths.reduce((a, b) => a + b, 0);
      let x = CX - total / 2;
      c.textAlign = "left";
      for (let i = 0; i < name.length; i++) {
        c.fillStyle = TITLE_COLORS[i % TITLE_COLORS.length];
        c.fillText(name[i], x, CY - 30);
        x += widths[i];
      }
      c.textAlign = "center";
    } else {
      c.fillText(
        phase === "over" ? strings.gameOver : strings.webCleared,
        CX,
        CY - 30,
      );
    }

    if (phase === "over") {
      c.font = "700 22px system-ui, sans-serif";
      c.fillStyle = HUD_INK;
      c.fillText(String(score), CX, CY + 8);
    }
    if (phase === "ready" || phase === "over") {
      c.font = "600 14px system-ui, sans-serif";
      c.fillStyle = HUD_DIM;
      c.fillText(
        phase === "over" ? strings.playAgain : strings.start,
        CX,
        CY + 44,
      );
    }
  }

  function render() {
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    c.translate(ox, oy);
    c.scale(scale, scale);

    c.save();
    c.beginPath();
    c.roundRect(0, 0, FIELD_W, FIELD_H, 12);
    c.clip();
    c.fillStyle = FIELD_BG;
    c.fillRect(0, 0, FIELD_W, FIELD_H);

    c.lineJoin = "round";
    c.lineCap = "round";

    drawWeb(c);
    drawSpikes(c);

    // Shots.
    c.strokeStyle = PLAYER_COLOR;
    c.lineWidth = 2;
    for (const b of bullets) {
      if (b.z > camZ) continue;
      const a = projectPoint(web, b.lane + 0.5, b.z, camZ);
      const d = projectPoint(web, b.lane + 0.5, Math.max(0, b.z - 0.05), camZ);
      c.beginPath();
      c.moveTo(a.x, a.y);
      c.lineTo(d.x, d.y);
      c.stroke();
    }
    c.strokeStyle = CRAWLER_COLOR;
    for (const b of enemyBullets) {
      if (b.z > camZ) continue;
      const p = projectPoint(web, b.u, b.z, camZ);
      c.beginPath();
      c.arc(p.x, p.y, 3, 0, Math.PI * 2);
      c.stroke();
    }

    for (const e of enemies) drawEnemy(c, e);
    if (phase !== "over" && phase !== "ready") drawPlayer(c);

    for (const p of particles) {
      c.globalAlpha = Math.max(0, p.ttl / p.life);
      c.strokeStyle = p.color;
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(p.x, p.y);
      c.lineTo(p.x - p.vx * 0.03, p.y - p.vy * 0.03);
      c.stroke();
    }
    c.globalAlpha = 1;

    drawHud(c);
    drawBanner(c);
    c.restore();
  }

  // ---- loop + input ---------------------------------------------------

  let rafId = 0;
  let last = 0;
  let acc = 0;
  let userPaused = true; // created parked; the host resumes when hosting
  let hiddenPaused = typeof document !== "undefined" && document.hidden;

  function frame(now: number) {
    rafId = 0;
    if (userPaused || hiddenPaused) return;
    // The `max(0, …)` is not paranoia. A rAF callback is handed the time the
    // FRAME began, which can predate the `performance.now()` that `ensureLoop`
    // sampled a moment earlier — so `now - last` can come out negative. Fed
    // into the accumulator below that is unrecoverable: `acc` is only clamped
    // at the top, so one negative reading pushes it below zero and the `while`
    // never runs again. The game would keep drawing, perfectly still, forever.
    const dt = Math.max(0, Math.min((now - last) / 1000, MAX_FRAME));
    last = now;
    // Fixed steps: a bullet crosses the tube fast enough that one long frame
    // could carry it clean past an enemy without ever being within HIT_Z.
    acc = Math.min(acc + dt, MAX_FRAME * 2);
    while (acc >= FIXED_DT) {
      step(FIXED_DT);
      acc -= FIXED_DT;
    }
    if (fitCanvas()) render();
    rafId = requestAnimationFrame(frame);
  }

  function ensureLoop() {
    if (rafId || userPaused || hiddenPaused) return;
    last = performance.now();
    acc = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function toField(ev: PointerEvent): Point {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - ox) / scale,
      y: (ev.clientY - rect.top - oy) / scale,
    };
  }

  function inZapButton(p: Point) {
    return (
      zapCharges > 0 &&
      p.x >= ZAP_BTN.x &&
      p.x <= ZAP_BTN.x + ZAP_BTN.w &&
      p.y >= ZAP_BTN.y &&
      p.y <= ZAP_BTN.y + ZAP_BTN.h
    );
  }

  const onPointerMove = (ev: PointerEvent) => {
    if (phase !== "play" && phase !== "dive") return;
    const p = toField(ev);
    playerLane = nearestLane(web, p.x, p.y);
  };

  const onPointerDown = (ev: PointerEvent) => {
    gestured = true;
    if (userPaused || hiddenPaused) return;
    // Keyboard play needs focus, and a click is the moment to take it.
    canvas.focus({ preventScroll: true });

    const p = toField(ev);
    if (inZapButton(p)) {
      zap();
      return;
    }
    if (phase === "ready" || phase === "over") {
      newGame();
      return;
    }
    onPointerMove(ev);
    firing = true;
    fire();
    fireCooldown = 0.12;
    canvas.setPointerCapture?.(ev.pointerId);
  };

  const onPointerUp = (ev: PointerEvent) => {
    firing = false;
    canvas.releasePointerCapture?.(ev.pointerId);
  };

  /**
   * Keyboard is an addition, not the contract: it only listens on the canvas
   * (never on document) and only once the player has clicked into the game, so
   * it can never swallow an app shortcut. Anything carrying a modifier is left
   * alone outright — Ctrl+Shift+Alt+Q is the remote-control panic key and must
   * reach the app from every surface, including this one.
   */
  const onKeyDown = (ev: KeyboardEvent) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    gestured = true;
    let handled = true;
    switch (ev.key) {
      case "ArrowLeft":
      case "a":
      case "A":
        holdDir = -1;
        holdIn = 0;
        break;
      case "ArrowRight":
      case "d":
      case "D":
        holdDir = 1;
        holdIn = 0;
        break;
      case " ":
      case "Enter":
        if (phase === "ready" || phase === "over") newGame();
        else if (!ev.repeat) {
          firing = true;
          fireCooldown = 0;
        }
        break;
      case "z":
      case "Z":
        zap();
        break;
      default:
        handled = false;
    }
    if (handled) ev.preventDefault();
  };

  const onKeyUp = (ev: KeyboardEvent) => {
    if (
      ((ev.key === "ArrowLeft" || ev.key === "a" || ev.key === "A") &&
        holdDir === -1) ||
      ((ev.key === "ArrowRight" || ev.key === "d" || ev.key === "D") &&
        holdDir === 1)
    )
      holdDir = 0;
    if (ev.key === " ") firing = false;
  };

  /** Losing focus must not leave a key stuck down. */
  const onBlur = () => {
    holdDir = 0;
    firing = false;
  };

  const onVisibility = () => {
    hiddenPaused = document.hidden;
    if (hiddenPaused) {
      stopLoop();
      // A backgrounded game must not keep making noise.
      void audio?.suspend().catch(() => {});
    } else ensureLoop();
  };

  canvas.tabIndex = 0;
  canvas.style.outline = "none";
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("keydown", onKeyDown);
  canvas.addEventListener("keyup", onKeyUp);
  canvas.addEventListener("blur", onBlur);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    pause() {
      userPaused = true;
      holdDir = 0;
      firing = false;
      stopLoop();
      void audio?.suspend().catch(() => {});
    },
    resume() {
      userPaused = false;
      ensureLoop();
      // Nothing to re-read on resume: the field is a fixed palette, so unlike
      // Slogaball a theme change while parked cannot leave it stale.
      // The audio context stays suspended until the next sound asks for it — a
      // muted (or silent-so-far) game never resumes it here.
    },
    dispose() {
      userPaused = true;
      stopLoop();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("keydown", onKeyDown);
      canvas.removeEventListener("keyup", onKeyUp);
      canvas.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      void audio?.close().catch(() => {});
      audio = null;
      master = null;
    },
    setMuted(m: boolean) {
      muted = m;
      try {
        localStorage.setItem(MUTE_KEY, m ? "1" : "0");
      } catch {
        /* see above */
      }
      // Cut scheduled tails immediately rather than letting them ring out.
      if (m) void audio?.suspend().catch(() => {});
    },
    isMuted: () => muted,
  };
}
