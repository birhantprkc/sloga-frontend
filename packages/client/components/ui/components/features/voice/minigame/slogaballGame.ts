/**
 * Slogaball — the "play while you wait" call minigame (slice 1).
 *
 * A peggle-like: aim from the launcher at the top, the ball falls under
 * gravity and bounces off pegs, clear all the amber TARGET pegs to win, the
 * moving bucket at the bottom refunds the shot. Ten balls, score, per-device
 * best.
 *
 * Deliberately a plain-TS canvas engine with NO imports: no Solid (the module
 * must evaluate under `node --test` for the helper specs below — only
 * `createSlogaball` may touch the DOM), and no image/audio assets (the whole
 * game is this chunk, so there is nothing to stage into a bundled desktop or
 * Android dist).
 *
 * Loaded with `await import()` from MinigameChip so vite splits it out of the
 * main bundle — see transcriptionEngine.ts for the precedent.
 */

/** Logical playfield everything is computed in; the canvas letterboxes it. */
export const FIELD_W = 420;
export const FIELD_H = 560;

export const PEG_R = 9;
const BALL_R = 7;

const GRAVITY = 900;
const PEG_RESTITUTION = 0.78;
const WALL_RESTITUTION = 0.85;
const LAUNCH_SPEED = 540;
/** Speed cap: a lucky peg funnel can pump energy in, and a fast enough ball
 * tunnels between substeps. */
const MAX_SPEED = 1000;
/** Physics substep — collision checks happen at least this often in game
 * time, which keeps the ball from passing through a peg in one frame. */
const FIXED_DT = 1 / 240;
/** Longest frame we integrate; anything above (a background tab waking up)
 * would make the ball leap, so it is simply dropped. */
const MAX_FRAME = 0.05;

const START_BALLS = 10;
const SCORE_PEG = 10;
const SCORE_TARGET = 100;
/** Every unspent ball is worth this on a win. */
const SCORE_BALL_BONUS = 500;

const LAUNCH_X = FIELD_W / 2;
const LAUNCH_Y = 26;
/**
 * The launcher may not point (near-)upward: a ball fired above the field
 * would sail out of the clip region and drain without ever being playable.
 * Minimum downward component of the (unit) aim vector.
 */
const MIN_AIM_DY = 0.12;

const BUCKET_W = 74;
const BUCKET_H = 16;
const BUCKET_Y = FIELD_H - 24;
/** Seconds per full left-right-left sweep. */
const BUCKET_PERIOD = 3.6;
const BUCKET_MARGIN = 8;

/**
 * Target pegs keep a fixed amber rather than a theme token: they are the
 * objective and must read as "the special ones" against ANY theme's primary,
 * including themes whose primary is itself orange-ish (then the regular pegs
 * are the ones that shift hue, which still keeps the two apart... mostly).
 */
const TARGET_COLOR = "#ff8b3d";

/** Sink for per-device best. Deliberately NOT a synced settings key — see the
 * plan doc: no DEFAULT_VALUES double-table to keep in sync, and a per-device
 * high score is fine for a time-killer. */
const HIGH_SCORE_KEY = "sloga:minigame:slogaball:high";

/** Localized copy the engine draws itself; the host passes `t`-macro output
 * at creation time (the canvas can't re-render on locale switch — acceptable
 * for a game session). */
export interface SlogaballStrings {
  outOfBalls: string;
  cleared: string;
  playAgain: string;
  freeBall: string;
}

export interface SlogaballHandle {
  /** Stop simulating and drawing (host parks the game — someone joined, or
   * the overlay closed without quitting). Idempotent. */
  pause(): void;
  /** Start (or continue) the loop; re-reads theme tokens off the canvas so a
   * theme change while parked is picked up. */
  resume(): void;
  /** Tear down listeners and the loop for good. The canvas is the host's. */
  dispose(): void;
}

export interface Peg {
  x: number;
  y: number;
  /** Amber objective peg — clear all of these to win. */
  target: boolean;
  /** Hit this shot; scores once, pops when the ball drains. */
  lit: boolean;
  /** Removed from play (popped at the end of an earlier shot). */
  gone: boolean;
}

/**
 * Reflect a velocity about a unit surface normal with restitution `e`.
 * Moving AWAY from the surface is returned unchanged — after a positional
 * correction the ball can still be touching the peg it just left, and
 * re-reflecting would glue it there.
 */
export function reflectVelocity(
  vx: number,
  vy: number,
  nx: number,
  ny: number,
  e: number,
): { vx: number; vy: number } {
  const dot = vx * nx + vy * ny;
  if (dot >= 0) return { vx, vy };
  return { vx: vx - (1 + e) * dot * nx, vy: vy - (1 + e) * dot * ny };
}

/**
 * Turn a pointer offset from the launcher into a unit aim vector, clamped to
 * the downward cone (see MIN_AIM_DY). A zero offset aims straight down.
 */
export function clampAim(dx: number, dy: number): { x: number; y: number } {
  const len = Math.hypot(dx, dy);
  if (!len) return { x: 0, y: 1 };
  let x = dx / len;
  let y = dy / len;
  if (y < MIN_AIM_DY) {
    // Keep the horizontal lean, force the minimum downward component.
    const maxX = Math.sqrt(1 - MIN_AIM_DY * MIN_AIM_DY);
    x = Math.max(-maxX, Math.min(maxX, x || maxX));
    y = Math.sqrt(1 - x * x);
    y = Math.max(y, MIN_AIM_DY);
  }
  return { x, y };
}

/**
 * A fresh field: staggered rows with some pegs knocked out for variety, a
 * quarter of the survivors (at least one) marked as targets. `random` is
 * injectable so the layout spec can run seeded under `node --test`.
 */
export function generatePegs(random: () => number = Math.random): Peg[] {
  const pegs: Peg[] = [];
  const rows = 8;
  const top = 150;
  const bottom = 470;
  const inset = 24;

  for (let r = 0; r < rows; r++) {
    const y = top + (r * (bottom - top)) / (rows - 1);
    const even = r % 2 === 0;
    const cols = even ? 8 : 7;
    const span = FIELD_W - inset * 2;
    const gap = span / 7;
    for (let c = 0; c < cols; c++) {
      // Odd rows sit half a gap in, staggering the lattice.
      const x = inset + (even ? c * gap : gap / 2 + c * gap);
      if (random() < 0.15) continue; // knocked out — keeps fields distinct
      pegs.push({ x, y, target: false, lit: false, gone: false });
    }
  }

  // Fisher-Yates over indices, first quarter become targets.
  const order = pegs.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const targets = Math.max(1, Math.round(pegs.length * 0.25));
  for (let i = 0; i < targets && i < order.length; i++)
    pegs[order[i]].target = true;

  return pegs;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  ttl: number;
  color: string;
}

interface Toast {
  text: string;
  x: number;
  y: number;
  ttl: number;
}

export function createSlogaball(
  canvas: HTMLCanvasElement,
  strings: SlogaballStrings,
): SlogaballHandle {
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    // 2d context refused (nothing sane to do; the overlay just stays blank).
    return { pause() {}, resume() {}, dispose() {} };
  }

  // ---- theme ----------------------------------------------------------
  // Read off the CANVAS so the game inherits whatever theme scope it is
  // mounted under; fallbacks keep it playable if a token is missing.
  let theme = {
    bg: "#101418",
    ink: "#e2e5e9",
    dim: "#9aa0a6",
    peg: "#8ab4f8",
    bucket: "#7fd0c9",
  };
  function readTheme() {
    const cs = getComputedStyle(canvas);
    const read = (name: string, fallback: string) =>
      cs.getPropertyValue(name).trim() || fallback;
    theme = {
      bg: read("--md-sys-color-surface-container-lowest", theme.bg),
      ink: read("--md-sys-color-on-surface", theme.ink),
      dim: read("--md-sys-color-on-surface-variant", theme.dim),
      peg: read("--md-sys-color-primary", theme.peg),
      bucket: read("--md-sys-color-secondary", theme.bucket),
    };
  }

  // ---- state ----------------------------------------------------------
  type Phase = "aim" | "flight" | "won" | "lost";
  let phase: Phase = "aim";
  let pegs = generatePegs();
  let ballsLeft = START_BALLS;
  let score = 0;
  let best = 0;
  try {
    best = Number(localStorage.getItem(HIGH_SCORE_KEY)) || 0;
  } catch {
    /* storage denied — best just won't persist */
  }
  let ball: { x: number; y: number; vx: number; vy: number } | null = null;
  let caught = false;
  let aim = { x: 0, y: 1 };
  let clock = 0; // drives the bucket sweep
  const particles: Particle[] = [];
  const toasts: Toast[] = [];

  // Letterbox mapping, refreshed every frame (cheaper than an observer and
  // correct through any container resize).
  let scale = 1;
  let ox = 0;
  let oy = 0;
  let dpr = 1;

  function saveBest() {
    if (score <= best) return;
    best = score;
    try {
      localStorage.setItem(HIGH_SCORE_KEY, String(best));
    } catch {
      /* see above */
    }
  }

  function newGame() {
    pegs = generatePegs();
    ballsLeft = START_BALLS;
    score = 0;
    ball = null;
    caught = false;
    phase = "aim";
  }

  function bucketX() {
    const travel = FIELD_W - BUCKET_MARGIN * 2 - BUCKET_W;
    const phi = (clock / BUCKET_PERIOD) * Math.PI * 2;
    return BUCKET_MARGIN + BUCKET_W / 2 + travel * (0.5 + 0.5 * Math.sin(phi));
  }

  function fire() {
    if (phase !== "aim" || ballsLeft <= 0) return;
    ball = {
      x: LAUNCH_X + aim.x * 18,
      y: LAUNCH_Y + aim.y * 18,
      vx: aim.x * LAUNCH_SPEED,
      vy: aim.y * LAUNCH_SPEED,
    };
    caught = false;
    phase = "flight";
  }

  function endShot() {
    for (const p of pegs) {
      if (!p.lit) continue;
      p.lit = false;
      p.gone = true;
      for (let i = 0; i < 6; i++) {
        const a = Math.random() * Math.PI * 2;
        const s = 40 + Math.random() * 90;
        particles.push({
          x: p.x,
          y: p.y,
          vx: Math.cos(a) * s,
          vy: Math.sin(a) * s - 30,
          ttl: 0.5,
          color: p.target ? TARGET_COLOR : theme.peg,
        });
      }
    }
    if (!caught) ballsLeft--;
    caught = false;
    ball = null;

    if (!pegs.some((p) => p.target && !p.gone)) {
      score += ballsLeft * SCORE_BALL_BONUS;
      saveBest();
      phase = "won";
    } else if (ballsLeft <= 0) {
      saveBest();
      phase = "lost";
    } else {
      phase = "aim";
    }
  }

  function stepPhysics(dt: number) {
    if (!ball) return;
    const steps = Math.max(1, Math.ceil(dt / FIXED_DT));
    const h = dt / steps;

    for (let s = 0; s < steps && ball; s++) {
      ball.vy += GRAVITY * h;
      const speed = Math.hypot(ball.vx, ball.vy);
      if (speed > MAX_SPEED) {
        ball.vx = (ball.vx / speed) * MAX_SPEED;
        ball.vy = (ball.vy / speed) * MAX_SPEED;
      }
      ball.x += ball.vx * h;
      ball.y += ball.vy * h;

      // Walls + ceiling. No floor — draining IS the floor.
      if (ball.x < BALL_R) {
        ball.x = BALL_R;
        ball.vx = Math.abs(ball.vx) * WALL_RESTITUTION;
      } else if (ball.x > FIELD_W - BALL_R) {
        ball.x = FIELD_W - BALL_R;
        ball.vx = -Math.abs(ball.vx) * WALL_RESTITUTION;
      }
      if (ball.y < BALL_R) {
        ball.y = BALL_R;
        ball.vy = Math.abs(ball.vy) * WALL_RESTITUTION;
      }

      for (const p of pegs) {
        if (p.gone) continue;
        const dx = ball.x - p.x;
        const dy = ball.y - p.y;
        const d = Math.hypot(dx, dy);
        const min = BALL_R + PEG_R;
        if (d >= min || d === 0) continue;
        const nx = dx / d;
        const ny = dy / d;
        // Positional correction first, so the reflection's away-check works.
        ball.x = p.x + nx * min;
        ball.y = p.y + ny * min;
        const v = reflectVelocity(ball.vx, ball.vy, nx, ny, PEG_RESTITUTION);
        ball.vx = v.vx;
        ball.vy = v.vy;
        if (!p.lit) {
          p.lit = true;
          score += p.target ? SCORE_TARGET : SCORE_PEG;
        }
      }

      // Bucket catch: falling, inside the mouth, at rim height.
      if (
        !caught &&
        ball.vy > 0 &&
        ball.y >= BUCKET_Y - BUCKET_H &&
        ball.y <= BUCKET_Y + BUCKET_H &&
        Math.abs(ball.x - bucketX()) < BUCKET_W / 2 - BALL_R / 2
      ) {
        caught = true;
        toasts.push({
          text: strings.freeBall,
          x: bucketX(),
          y: BUCKET_Y - 26,
          ttl: 1.2,
        });
      }

      if (ball.y > FIELD_H + 40) {
        endShot();
        break;
      }
    }
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
      p.vy += GRAVITY * 0.4 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    for (let i = toasts.length - 1; i >= 0; i--) {
      toasts[i].ttl -= dt;
      if (toasts[i].ttl <= 0) toasts.splice(i, 1);
    }
    if (phase === "flight") stepPhysics(dt);
  }

  // ---- rendering ------------------------------------------------------

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

  function render() {
    const c = ctx!;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    c.translate(ox, oy);
    c.scale(scale, scale);

    // Field
    c.save();
    c.beginPath();
    c.roundRect(0, 0, FIELD_W, FIELD_H, 12);
    c.clip();
    c.fillStyle = theme.bg;
    c.fillRect(0, 0, FIELD_W, FIELD_H);

    // Pegs
    for (const p of pegs) {
      if (p.gone) continue;
      c.beginPath();
      c.arc(p.x, p.y, PEG_R, 0, Math.PI * 2);
      c.fillStyle = p.target ? TARGET_COLOR : theme.peg;
      c.globalAlpha = p.lit ? 1 : 0.85;
      c.fill();
      if (p.lit) {
        c.beginPath();
        c.arc(p.x, p.y, PEG_R + 3, 0, Math.PI * 2);
        c.strokeStyle = theme.ink;
        c.lineWidth = 1.5;
        c.stroke();
      }
      c.globalAlpha = 1;
    }

    // Launcher + aim preview
    c.beginPath();
    c.arc(LAUNCH_X, LAUNCH_Y, 10, 0, Math.PI * 2);
    c.fillStyle = theme.dim;
    c.fill();
    if (phase === "aim" && ballsLeft > 0) {
      let px = LAUNCH_X + aim.x * 18;
      let py = LAUNCH_Y + aim.y * 18;
      const pvx = aim.x * LAUNCH_SPEED;
      let pvy = aim.y * LAUNCH_SPEED;
      c.fillStyle = theme.dim;
      for (let i = 0; i < 22 && py < FIELD_H * 0.55; i++) {
        // Gravity-only preview: honest about the arc, silent about bounces.
        pvy += GRAVITY * 0.02;
        px += pvx * 0.02;
        py += pvy * 0.02;
        if (px < BALL_R || px > FIELD_W - BALL_R) break;
        c.globalAlpha = Math.max(0, 0.7 - i * 0.03);
        c.beginPath();
        c.arc(px, py, 2.2, 0, Math.PI * 2);
        c.fill();
      }
      c.globalAlpha = 1;
    }

    // Ball
    if (ball) {
      c.beginPath();
      c.arc(ball.x, ball.y, BALL_R, 0, Math.PI * 2);
      c.fillStyle = theme.ink;
      c.fill();
    }

    // Bucket
    const bx = bucketX();
    c.fillStyle = theme.bucket;
    c.fillRect(bx - BUCKET_W / 2, BUCKET_Y, BUCKET_W, BUCKET_H);
    c.fillRect(bx - BUCKET_W / 2, BUCKET_Y - 8, 5, 8);
    c.fillRect(bx + BUCKET_W / 2 - 5, BUCKET_Y - 8, 5, 8);

    // Particles
    for (const p of particles) {
      c.globalAlpha = Math.max(0, p.ttl / 0.5);
      c.beginPath();
      c.arc(p.x, p.y, 2.5, 0, Math.PI * 2);
      c.fillStyle = p.color;
      c.fill();
    }
    c.globalAlpha = 1;

    // HUD
    c.fillStyle = theme.ink;
    c.font = "600 14px system-ui, sans-serif";
    c.textAlign = "left";
    c.textBaseline = "top";
    c.fillText(String(score), 12, 10);
    c.textAlign = "right";
    c.fillText(`★ ${best}`, FIELD_W - 12, 10);
    for (let i = 0; i < ballsLeft; i++) {
      c.beginPath();
      c.arc(18 + i * 12, 38, 3.5, 0, Math.PI * 2);
      c.fillStyle = theme.dim;
      c.fill();
    }

    // Toasts
    c.font = "700 15px system-ui, sans-serif";
    c.textAlign = "center";
    for (const tst of toasts) {
      c.globalAlpha = Math.min(1, tst.ttl / 0.3);
      c.fillStyle = theme.ink;
      c.fillText(tst.text, tst.x, tst.y);
    }
    c.globalAlpha = 1;

    // End states
    if (phase === "won" || phase === "lost") {
      c.fillStyle = "rgba(0, 0, 0, 0.55)";
      c.fillRect(0, 0, FIELD_W, FIELD_H);
      c.fillStyle = theme.ink;
      c.textAlign = "center";
      c.font = "800 26px system-ui, sans-serif";
      c.fillText(
        phase === "won" ? strings.cleared : strings.outOfBalls,
        FIELD_W / 2,
        FIELD_H / 2 - 40,
      );
      c.font = "700 20px system-ui, sans-serif";
      c.fillText(String(score), FIELD_W / 2, FIELD_H / 2);
      c.font = "600 14px system-ui, sans-serif";
      c.fillStyle = theme.dim;
      c.fillText(strings.playAgain, FIELD_W / 2, FIELD_H / 2 + 34);
    }

    c.restore();
  }

  // ---- loop + input ---------------------------------------------------

  let rafId = 0;
  let last = 0;
  let userPaused = true; // created parked; the host resumes when hosting
  let hiddenPaused = typeof document !== "undefined" && document.hidden;

  function frame(now: number) {
    rafId = 0;
    if (userPaused || hiddenPaused) return;
    const dt = Math.min((now - last) / 1000, MAX_FRAME);
    last = now;
    step(dt);
    if (fitCanvas()) render();
    rafId = requestAnimationFrame(frame);
  }

  function ensureLoop() {
    if (rafId || userPaused || hiddenPaused) return;
    last = performance.now();
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  function toField(ev: PointerEvent): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (ev.clientX - rect.left - ox) / scale,
      y: (ev.clientY - rect.top - oy) / scale,
    };
  }

  const onPointerMove = (ev: PointerEvent) => {
    const p = toField(ev);
    aim = clampAim(p.x - LAUNCH_X, p.y - LAUNCH_Y);
  };

  const onPointerDown = (ev: PointerEvent) => {
    if (userPaused || hiddenPaused) return;
    if (phase === "won" || phase === "lost") {
      newGame();
      return;
    }
    onPointerMove(ev);
    fire();
  };

  const onVisibility = () => {
    hiddenPaused = document.hidden;
    if (hiddenPaused) stopLoop();
    else ensureLoop();
  };

  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerdown", onPointerDown);
  document.addEventListener("visibilitychange", onVisibility);

  return {
    pause() {
      userPaused = true;
      stopLoop();
    },
    resume() {
      userPaused = false;
      readTheme();
      ensureLoop();
    },
    dispose() {
      userPaused = true;
      stopLoop();
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("visibilitychange", onVisibility);
    },
  };
}
