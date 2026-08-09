// Unit spec for Slogatron's pure helpers — run with Node's built-in runner:
//   node --test components/ui/components/features/voice/minigame/slogatronGame.test.ts
// The module has no imports and no module-level DOM access ON PURPOSE, which is
// what lets these run outside a browser. Focus: every web in the rotation is
// playable and on-screen, lane arithmetic wraps on closed webs and stops dead
// on open ones, the projection is a real perspective, and the two rules a
// player can actually feel — what a shot connects with, and what the zapper
// takes — behave at their edges.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type Enemy,
  type EnemyKind,
  type Web,
  bulletHits,
  enemyScore,
  FIELD_H,
  FIELD_W,
  laneDelta,
  makeWeb,
  nearestLane,
  perspective,
  projectPoint,
  resolveZap,
  rimPoint,
  stepLane,
  waveSpec,
} from "./slogatronGame.ts";

/** Every distinct web the rotation can produce, plus a couple of repeats. */
const LEVELS = Array.from({ length: 24 }, (_, i) => i + 1);

function firstWebWhere(closed: boolean): Web {
  for (const l of LEVELS) {
    const w = makeWeb(l);
    if (w.closed === closed) return w;
  }
  throw new Error(`no ${closed ? "closed" : "open"} web in the rotation`);
}

test("perspective is a real pinhole: 1 at the rim, monotonic toward the far end", () => {
  assert.equal(perspective(1), 1);
  const far = perspective(0);
  assert.ok(far > 0 && far < 0.3, "the far end is small but not degenerate");
  let prev = -Infinity;
  for (let z = 0; z <= 1.0001; z += 0.05) {
    const s = perspective(z);
    assert.ok(s > prev, `scale grows toward the rim at z=${z}`);
    prev = s;
  }
  // Bunching: the near half of the tube must occupy more screen depth than the
  // far half, or it reads as a flat funnel rather than a well.
  assert.ok(
    perspective(1) - perspective(0.5) > perspective(0.5) - perspective(0),
  );
});

test("every web in the rotation is on-screen and correctly shaped", () => {
  for (const level of LEVELS) {
    const w = makeWeb(level);
    assert.ok(w.lanes >= 6, `level ${level}: enough lanes to move about`);
    assert.equal(
      w.rim.length,
      w.closed ? w.lanes : w.lanes + 1,
      `level ${level}: vertex count matches the lane count`,
    );
    for (const p of w.rim) {
      assert.ok(
        p.x >= 0 && p.x <= FIELD_W,
        `level ${level}: vertex inside the field horizontally`,
      );
      assert.ok(
        p.y >= 0 && p.y <= FIELD_H,
        `level ${level}: vertex inside the field vertically`,
      );
    }
    // No zero-length lane: one would be unaimable and unhittable.
    for (let i = 0; i < w.lanes; i++) {
      const a = w.rim[i % w.rim.length];
      const b = w.rim[(i + 1) % w.rim.length];
      assert.ok(
        Math.hypot(b.x - a.x, b.y - a.y) > 8,
        `level ${level}: lane ${i} has width`,
      );
    }
  }
});

test("the rotation repeats rather than running out", () => {
  assert.deepEqual(makeWeb(1).shape, makeWeb(9).shape);
  assert.deepEqual(makeWeb(1).lanes, makeWeb(9).lanes);
  // And it is a rotation, not one shape forever.
  const shapes = new Set(LEVELS.slice(0, 8).map((l) => makeWeb(l).shape));
  assert.equal(shapes.size, 8);
});

test("rim coordinates wrap on a closed web and clamp on an open one", () => {
  const closed = firstWebWhere(true);
  const a = rimPoint(closed, 0);
  const wrapped = rimPoint(closed, closed.lanes);
  assert.ok(
    Math.hypot(a.x - wrapped.x, a.y - wrapped.y) < 1e-9,
    "u=lanes is u=0",
  );
  const negative = rimPoint(closed, -0.5);
  const equivalent = rimPoint(closed, closed.lanes - 0.5);
  assert.ok(
    Math.hypot(negative.x - equivalent.x, negative.y - equivalent.y) < 1e-9,
    "negative u wraps round the back",
  );

  const open = firstWebWhere(false);
  const start = rimPoint(open, 0);
  assert.deepEqual(
    rimPoint(open, -3),
    start,
    "past the left end is the left end",
  );
  const end = rimPoint(open, open.lanes);
  assert.deepEqual(
    rimPoint(open, open.lanes + 3),
    end,
    "past the right end is the right end",
  );
});

test("projection: the rim is untouched, depth shrinks toward the vanishing point", () => {
  const web = firstWebWhere(true);
  for (let u = 0; u < web.lanes; u += 0.5) {
    const rim = rimPoint(web, u);
    const atRim = projectPoint(web, u, 1);
    assert.ok(
      Math.hypot(rim.x - atRim.x, rim.y - atRim.y) < 1e-9,
      "z=1 is the rim itself",
    );
  }
  // A far point sits on the segment between the vanishing point and its rim
  // vertex, nearer the former.
  const rim = rimPoint(web, 3);
  const far = projectPoint(web, 3, 0);
  const cx = FIELD_W / 2;
  assert.ok(
    Math.hypot(far.x - cx, far.y - 250) < Math.hypot(rim.x - cx, rim.y - 250),
    "the far end is closer to the vanishing point than the rim is",
  );
  // ...and on the same ray out of it, so lanes render as straight rails.
  const cross = (rim.x - cx) * (far.y - 250) - (rim.y - 250) * (far.x - cx);
  assert.ok(Math.abs(cross) < 1e-6, "far and rim points are radially aligned");
});

test("diving blows the far end up to fill the rim", () => {
  const web = firstWebWhere(true);
  const spread = (camZ: number) => {
    const p = projectPoint(web, 3, 0, camZ);
    return Math.hypot(p.x - FIELD_W / 2, p.y - 250);
  };
  const atRim = Math.hypot(
    rimPoint(web, 3).x - FIELD_W / 2,
    rimPoint(web, 3).y - 250,
  );
  assert.ok(
    spread(1) < atRim * 0.3,
    "seen from the rim, the mouth is far away",
  );
  assert.ok(spread(0.5) > spread(1), "halfway down it has grown");
  assert.ok(
    Math.abs(spread(0) - atRim) < 1e-6,
    "arriving, the mouth IS the rim",
  );
});

test("lane distance takes the short way round a closed web only", () => {
  const closed = firstWebWhere(true);
  const n = closed.lanes;
  assert.equal(laneDelta(closed, 0.5, 1.5), 1);
  assert.equal(laneDelta(closed, 1.5, 0.5), -1);
  // All the way round the back is a single step, not n-1 of them.
  assert.equal(laneDelta(closed, 0.5, n - 0.5), -1);
  assert.ok(Math.abs(laneDelta(closed, 0.5, n / 2 + 0.5)) <= n / 2);

  const open = firstWebWhere(false);
  assert.equal(laneDelta(open, 0.5, open.lanes - 0.5), open.lanes - 1);
});

test("lane stepping wraps on a closed web and stops at the ends of an open one", () => {
  const closed = firstWebWhere(true);
  assert.equal(stepLane(closed, 0, -1), closed.lanes - 1);
  assert.equal(stepLane(closed, closed.lanes - 1, 1), 0);

  const open = firstWebWhere(false);
  assert.equal(stepLane(open, 0, -1), 0, "cannot walk off the left end");
  assert.equal(
    stepLane(open, open.lanes - 1, 1),
    open.lanes - 1,
    "cannot walk off the right end",
  );
  assert.equal(stepLane(open, 3, 1), 4);
});

test("steering a closed web follows the pointer's angle at any distance", () => {
  for (const level of LEVELS.slice(0, 8)) {
    const web = makeWeb(level);
    if (!web.closed) continue;
    const angleOf = (p: { x: number; y: number }) =>
      Math.atan2(p.y - 250, p.x - FIELD_W / 2);

    for (let lane = 0; lane < web.lanes; lane++) {
      const a0 = angleOf(web.rim[lane % web.rim.length]);
      const raw = angleOf(web.rim[(lane + 1) % web.rim.length]) - a0;
      const span = ((raw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      const mid = a0 + span / 2;
      // Radius must not matter: deep inside the tube, on the rim, and well
      // off the canvas all mean the same lane.
      for (const r of [40, 120, 200, 900]) {
        assert.equal(
          nearestLane(
            web,
            FIELD_W / 2 + Math.cos(mid) * r,
            250 + Math.sin(mid) * r,
          ),
          lane,
          `level ${level} (${web.shape}): lane ${lane} at radius ${r}`,
        );
      }
    }
  }
});

test("steering an open web finds the run segment nearest the pointer", () => {
  for (const level of LEVELS.slice(0, 8)) {
    const web = makeWeb(level);
    if (web.closed) continue;

    for (let lane = 0; lane < web.lanes; lane++) {
      const mid = rimPoint(web, lane + 0.5);
      assert.equal(
        nearestLane(web, mid.x, mid.y),
        lane,
        `level ${level}: pointer exactly on lane ${lane}`,
      );

      // The offset has to be PERPENDICULAR to the run: pushing radially out
      // from the vanishing point slides ALONG a flat web rather than away
      // from it, onto a genuinely nearer neighbor.
      const a = web.rim[lane];
      const b = web.rim[lane + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      let nx = -(b.y - a.y) / len;
      let ny = (b.x - a.x) / len;
      if ((mid.x - FIELD_W / 2) * nx + (mid.y - 250) * ny < 0) {
        nx = -nx;
        ny = -ny;
      }
      for (const d of [18, 60, -6]) {
        assert.equal(
          nearestLane(web, mid.x + nx * d, mid.y + ny * d),
          lane,
          `level ${level}: pointer ${d}px off lane ${lane}`,
        );
      }
    }
  }
});

test("every closed web is star-shaped about the vanishing point", () => {
  // `nearestLane` steers a closed web by pointer angle, which is only valid
  // while the rim's vertex angles run monotonically round the middle. A new
  // shape that folds back on itself would break steering silently, so the
  // invariant is pinned here rather than left to playtesting.
  for (const level of LEVELS) {
    const web = makeWeb(level);
    if (!web.closed) continue;
    const base = Math.atan2(web.rim[0].y - 250, web.rim[0].x - FIELD_W / 2);
    let prev = 0;
    for (let i = 1; i < web.lanes; i++) {
      const raw =
        Math.atan2(web.rim[i].y - 250, web.rim[i].x - FIELD_W / 2) - base;
      const a = ((raw % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
      assert.ok(
        a > prev,
        `level ${level} (${web.shape}): vertex ${i} turns back on itself`,
      );
      prev = a;
    }
  }
});

test("steering always returns a real lane, wherever the pointer is", () => {
  for (const level of LEVELS.slice(0, 8)) {
    const web = makeWeb(level);
    for (const [x, y] of [
      [FIELD_W / 2, 250], // dead center, equidistant from everything
      [0, 0],
      [FIELD_W, FIELD_H],
      [-500, -500], // dragged clean off the canvas
      [FIELD_W * 3, 250],
    ]) {
      const lane = nearestLane(web, x, y);
      assert.ok(
        Number.isInteger(lane) && lane >= 0 && lane < web.lanes,
        `level ${level}: (${x},${y}) resolves to a lane that exists`,
      );
    }
  }
});

function enemy(u: number, z: number, kind: EnemyKind = "crawler"): Enemy {
  return {
    kind,
    u,
    z,
    speed: 0.1,
    flipIn: 1,
    flip: null,
    onRim: false,
    fireIn: Infinity,
    dir: 1,
  };
}

test("a shot connects down its own lane and nowhere else", () => {
  const web = firstWebWhere(true);
  assert.ok(bulletHits(web, 3, 0.5, enemy(3.5, 0.5)), "dead center");
  assert.ok(
    bulletHits(web, 3, 0.5, enemy(3.9, 0.52)),
    "caught mid-flip, still overlapping",
  );
  assert.ok(
    !bulletHits(web, 3, 0.5, enemy(4.5, 0.5)),
    "the next lane over is safe",
  );
  assert.ok(
    !bulletHits(web, 3, 0.5, enemy(3.5, 0.7)),
    "right lane, wrong depth",
  );
});

test("a shot in the last lane catches something wrapping out of the first", () => {
  const web = firstWebWhere(true);
  const last = web.lanes - 1;
  // u === lanes is u === 0: an enemy exactly on the seam.
  assert.ok(bulletHits(web, last, 0.4, enemy(web.lanes, 0.4)));
  assert.ok(
    !bulletHits(web, last, 0.4, enemy(1.5, 0.4)),
    "two lanes past the seam is a miss",
  );
});

test("the first zapper charge clears the web, the second takes the nearest one", () => {
  const a = enemy(0.5, 0.2);
  const b = enemy(2.5, 0.9, "hauler");
  const c = enemy(4.5, 0.5, "spiker");
  const all = [a, b, c];

  const full = resolveZap(all, 2);
  assert.equal(full.killed.length, 3);
  assert.equal(full.chargesLeft, 1);
  assert.equal(full.score, 150 + 100 + 50);
  assert.equal(all.length, 3, "resolveZap reports, the caller kills");

  const single = resolveZap(all, 1);
  assert.deepEqual(single.killed, [b], "the one about to reach the rim");
  assert.equal(single.chargesLeft, 0);
  assert.equal(single.score, 100);
});

test("a spent zapper and an empty web are both no-ops", () => {
  assert.deepEqual(resolveZap([enemy(0.5, 0.5)], 0), {
    killed: [],
    score: 0,
    chargesLeft: 0,
  });
  assert.deepEqual(resolveZap([], 2), { killed: [], score: 0, chargesLeft: 2 });
});

test("waves ramp, then plateau instead of becoming a wall", () => {
  const first = waveSpec(1);
  assert.ok(first.crawlers > 0, "there is always something to shoot");
  assert.equal(
    first.haulers,
    0,
    "the first web introduces one thing at a time",
  );
  assert.equal(first.spikers, 0);

  let prev = waveSpec(1);
  for (let l = 2; l <= 40; l++) {
    const w = waveSpec(l);
    assert.ok(w.crawlers >= prev.crawlers, `level ${l}: crawlers never drop`);
    assert.ok(w.haulers >= prev.haulers, `level ${l}: haulers never drop`);
    assert.ok(w.spikers >= prev.spikers, `level ${l}: spikers never drop`);
    assert.ok(w.speed >= prev.speed, `level ${l}: speed never drops`);
    assert.ok(w.fireRate <= prev.fireRate, `level ${l}: fire gaps never grow`);
    prev = w;
  }
  const late = waveSpec(40);
  assert.ok(late.crawlers <= 12 && late.haulers <= 5 && late.spikers <= 4);
  assert.ok(late.speed <= 0.24, "an enemy still takes seconds to climb");
  assert.ok(late.fireRate >= 1.5, "shots stay dodgeable");
  // Spikers must never be able to spike every lane of the narrowest web.
  const narrowest = Math.min(...LEVELS.map((l) => makeWeb(l).lanes));
  assert.ok(late.spikers < narrowest, "some lane is always clean to dive down");
});

test("a hauler is worth less than what it splits into", () => {
  assert.ok(enemyScore("hauler") < enemyScore("crawler") * 2);
  assert.ok(enemyScore("spiker") < enemyScore("hauler"));
});
