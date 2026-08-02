// Unit spec for Slogaball's pure helpers — run with Node's built-in runner:
//   node --test components/ui/components/features/voice/minigame/slogaballGame.test.ts
// The module has no imports and no module-level DOM access ON PURPOSE, which
// is what lets these run outside a browser. Focus: reflection can't glue the
// ball to a peg, the aim clamp always yields a downward unit vector, and a
// generated field is always playable (in bounds, no overlaps, ≥1 target).
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIELD_H,
  FIELD_W,
  PEG_R,
  clampAim,
  generatePegs,
  reflectVelocity,
} from "./slogaballGame.ts";

/** Deterministic RNG (mulberry32) so a layout failure is reproducible. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("reflection reverses the normal component and keeps the tangential", () => {
  // Straight down onto a floor normal (0,-1): vy flips scaled by e, vx kept.
  const v = reflectVelocity(120, 300, 0, -1, 0.5);
  assert.equal(v.vx, 120);
  assert.ok(Math.abs(v.vy - -150) < 1e-9);
});

test("moving away from the surface is returned unchanged (no glue)", () => {
  // After a positional correction the ball still touches the peg it just
  // left; reflecting again would trap it against the surface.
  const v = reflectVelocity(0, -200, 0, -1, 0.78);
  assert.equal(v.vx, 0);
  assert.equal(v.vy, -200);
});

test("aim clamp always yields a downward unit vector", () => {
  const cases: [number, number][] = [
    [0, 1], // straight down
    [0, -1], // straight UP — must be forced downward
    [1, -0.2], // shallow upward right
    [-500, 3], // hard left, almost level
    [0, 0], // degenerate: pointer exactly on the launcher
  ];
  for (const [dx, dy] of cases) {
    const a = clampAim(dx, dy);
    assert.ok(
      Math.abs(Math.hypot(a.x, a.y) - 1) < 1e-9,
      `unit length for (${dx},${dy})`,
    );
    assert.ok(a.y >= 0.12 - 1e-9, `downward component for (${dx},${dy})`);
  }
});

test("a horizontal lean survives the clamp's direction", () => {
  assert.ok(clampAim(10, -1).x > 0);
  assert.ok(clampAim(-10, -1).x < 0);
});

test("generated fields are playable across many seeds", () => {
  for (let seed = 1; seed <= 50; seed++) {
    const pegs = generatePegs(seeded(seed));
    assert.ok(pegs.length >= 20, `seed ${seed}: enough pegs`);
    const targets = pegs.filter((p) => p.target).length;
    assert.ok(targets >= 1, `seed ${seed}: at least one target`);
    assert.ok(targets <= pegs.length / 2, `seed ${seed}: not mostly targets`);
    for (const p of pegs) {
      assert.ok(
        p.x >= PEG_R && p.x <= FIELD_W - PEG_R,
        `seed ${seed}: peg in x bounds`,
      );
      assert.ok(
        p.y >= PEG_R && p.y <= FIELD_H - PEG_R,
        `seed ${seed}: peg in y bounds`,
      );
      assert.ok(!p.lit && !p.gone, `seed ${seed}: pegs start dark`);
    }
    for (let i = 0; i < pegs.length; i++)
      for (let j = i + 1; j < pegs.length; j++) {
        const d = Math.hypot(pegs[i].x - pegs[j].x, pegs[i].y - pegs[j].y);
        assert.ok(d >= PEG_R * 2, `seed ${seed}: pegs ${i}/${j} overlap`);
      }
  }
});
