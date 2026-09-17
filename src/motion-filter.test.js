import { test } from "node:test";
import assert from "node:assert/strict";

import { createMotionFilter } from "./motion-filter.js";

/* Seeded Gaussian noise, so a noisy test is the same noise every run. */
function noise(seed) {
  let s = seed >>> 0;
  const uniform = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (sigma) => sigma * Math.sqrt(-2 * Math.log(1 - uniform())) * Math.cos(2 * Math.PI * uniform());
}

const HZ = 50;

test("a straight drive through noisy poses reads as the right speed, drawn straight", () => {
  const filter = createMotionFilter();
  const jitter = noise(7);
  let worstTurn = 0;
  let naiveWorst = 0;
  let last = null;
  let lastDirection = null;
  for (let i = 0; i <= 3 * HZ; i++) {
    const t = i / HZ;
    const px = 2 * t + jitter(0.03);
    const py = 1 + jitter(0.03);
    filter.pose(t, px, py);
    if (t > 1) worstTurn = Math.max(worstTurn, Math.abs(filter.turn));
    /* What the view did before: each pose differentiated, and the direction differentiated again. */
    if (last) {
      const direction = Math.atan2(py - last[1], px - last[0]);
      if (lastDirection !== null && t > 1) naiveWorst = Math.max(naiveWorst, Math.abs((direction - lastDirection) * HZ));
      lastDirection = direction;
    }
    last = [px, py];
  }
  assert.ok(Math.abs(filter.speed - 2) < 0.3, `speed ${filter.speed}`);
  assert.ok(worstTurn < 0.4, `worst drawn turn ${worstTurn} rad/s`);
  assert.ok(naiveWorst > 5 * Math.max(worstTurn, 0.1), `differentiating twice was worse: ${naiveWorst}`);
});

test("a steady curve through noisy poses reads as its turn", () => {
  const filter = createMotionFilter();
  const jitter = noise(11);
  const radius = 2;
  const speed = 2;
  for (let i = 0; i <= 4 * HZ; i++) {
    const t = i / HZ;
    const a = (speed / radius) * t;
    filter.pose(t, radius * Math.sin(a) + jitter(0.02), radius - radius * Math.cos(a) + jitter(0.02));
  }
  assert.ok(Math.abs(filter.speed - speed) < 0.35, `speed ${filter.speed}`);
  assert.ok(Math.abs(filter.turn - 1) < 0.35, `turn ${filter.turn}`);
});

test("the robot's own velocity is believed over the poses", () => {
  const filter = createMotionFilter();
  const jitter = noise(3);
  for (let i = 0; i <= HZ; i++) {
    const t = i / HZ;
    filter.velocity(t, 1.5, 0);
    filter.pose(t, 1.5 * t + jitter(0.08), jitter(0.08));
  }
  assert.ok(filter.measured(1));
  assert.ok(Math.abs(filter.vx - 1.5) < 1e-6 && Math.abs(filter.vy) < 1e-6, `${filter.vx}, ${filter.vy}`);
  assert.equal(filter.turn, 0);
});

test("a pose reset is a jump, not a burst of speed", () => {
  const filter = createMotionFilter();
  for (let i = 0; i <= HZ; i++) filter.pose(i / HZ, (i / HZ) * 1, 0);
  filter.pose(1 + 1 / HZ, 9, 5);
  assert.equal(filter.speed, 0);
});

test("a robot slowing to a stop lets its turn go", () => {
  const filter = createMotionFilter();
  for (let i = 0; i <= 2 * HZ; i++) {
    const t = i / HZ;
    filter.velocity(t, 2 * Math.cos(t), 2 * Math.sin(t));
  }
  assert.ok(Math.abs(filter.turn) > 0.5, `turning ${filter.turn}`);
  for (let i = 1; i <= HZ; i++) filter.velocity(2 + i / HZ, 0.05, 0);
  assert.equal(filter.turn, 0);
});
