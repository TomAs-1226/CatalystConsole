import { test } from "node:test";
import assert from "node:assert/strict";

import { ARRIVED_S, driverPose, POSED_S, WALK_S } from "./driver3d.js";

test("the figure walks on and arrives on its mark", () => {
  const start = driverPose(0);
  assert.ok(start.x < -2, `starts off stage at ${start.x}`);
  assert.ok(driverPose(WALK_S / 2).x > start.x, "moving");
  assert.ok(Math.abs(driverPose(WALK_S).x) < 1e-9, "on its mark when the walk ends");
  assert.ok(Math.abs(driverPose(POSED_S + 10).x) < 1e-9, "and stays there");
});

test("the feet never slide: the stride is driven by the ground it covers", () => {
  /* A foot that is planted must not move while it is planted. The gait is a function of distance
     travelled rather than of time, so the same distance always gives the same leg angles - which is the
     property that makes it look walked rather than moon-walked. */
  const HZ = 120;
  let worst = 0;
  for (let i = 1; i <= WALK_S * HZ; i++) {
    const a = driverPose((i - 1) / HZ);
    const b = driverPose(i / HZ);
    const dx = b.x - a.x;
    if (dx <= 0) continue;
    /* The hip angle may only change with distance. Same distance, same angle. */
    const rate = Math.abs(b.hip[0] - a.hip[0]) / dx;
    worst = Math.max(worst, rate);
  }
  /* Radians of hip per metre of travel: a stride of 0.68 m swings the hip through about 2 x 0.52 rad,
     so the peak rate is around 4.8 rad/m. Anything far above that is a leg being dragged. */
  assert.ok(worst < 6, `hip swings ${worst.toFixed(2)} rad per metre`);
});

test("the gait stops when the figure does", () => {
  assert.equal(driverPose(WALK_S / 2).walking, 1);
  assert.ok(driverPose(ARRIVED_S).walking < 0.01, "still by the time it is standing");
  for (const t of [ARRIVED_S, POSED_S, POSED_S + 30]) {
    const pose = driverPose(t);
    for (const side of [0, 1]) {
      assert.ok(Math.abs(pose.hip[side]) < 0.02, `hip ${side} at rest`);
      assert.ok(Math.abs(pose.knee[side]) < 0.02, `knee ${side} at rest`);
    }
  }
});

test("the arms fold once, and the elbows lead", () => {
  assert.equal(driverPose(0).folded, 0);
  assert.equal(driverPose(ARRIVED_S).folded, 0);
  assert.equal(driverPose(POSED_S).folded, 1);
  /* Half way through the fold, the elbows are most of the way closed and the arms have barely started
     coming across: the other order takes the hands through each other at the front. */
  const half = driverPose(ARRIVED_S + (POSED_S - ARRIVED_S) / 2);
  const done = driverPose(POSED_S);
  assert.ok(half.elbow[0] / done.elbow[0] > 0.6, `elbow at ${(half.elbow[0] / done.elbow[0]).toFixed(2)} of its fold`);
  assert.ok(Math.abs(half.across[0]) / Math.abs(done.across[0]) < 0.45, "and the arm is not across yet");
});

test("the folded arms cross in front of the chest, not through it", () => {
  /* Worked in the same frame the figure is built in: the shoulder is 310 mm above the elbow when the arm
     hangs, the forearm is 270 mm, and the torso is 170 mm from its centre line at the chest. */
  const UPPER = 0.31;
  const FORE = 0.27;
  const CHEST_X = 0.17;
  const pose = driverPose(POSED_S);
  for (const side of [0, 1]) {
    const swing = pose.shoulder[side] + pose.forward[side];
    const elbowX = UPPER * Math.sin(swing);
    /* The forearm's angle from straight down is the shoulder's plus the elbow's; `across` turns what is
       left of it in front of the body into travel across the body. */
    const fromDown = swing + pose.elbow[side];
    const handX = elbowX + FORE * Math.sin(fromDown) * Math.cos(pose.across[side]);
    assert.ok(handX > CHEST_X + 0.02, `side ${side}: hand ${(handX * 1000).toFixed(0)} mm forward of the shoulder`);
    /* And the hand reaches the middle, which is what makes it a fold rather than a hold. Turning the arm
       about the shoulder's own axis by `across` swings the forearm from in front of the body to across
       it: a rotation about y sends what was along +x to -z by its sine. */
    const shoulderZ = 0.185 * (side === 0 ? -1 : 1);
    const handZ = shoulderZ - FORE * Math.sin(fromDown) * Math.sin(pose.across[side]);
    assert.ok(Math.abs(handZ) < 0.12, `side ${side}: hand ${(handZ * 1000).toFixed(0)} mm off the centre line`);
    assert.ok(Math.sign(handZ - shoulderZ) === -Math.sign(shoulderZ), `side ${side}: the hand comes inward`);
  }
});

test("a pose can be asked for the folded arms without playing the walk", () => {
  const held = driverPose(0, { crossed: true });
  assert.equal(held.folded, 1);
  const never = driverPose(POSED_S + 5, { crossed: false });
  assert.equal(never.folded, 0);
});

test("a time before the start, or no time at all, is the start", () => {
  assert.deepEqual(driverPose(-5).x, driverPose(0).x);
  assert.deepEqual(driverPose(NaN).x, driverPose(0).x);
  assert.deepEqual(driverPose(undefined).x, driverPose(0).x);
});
