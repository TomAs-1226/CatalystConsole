import { test } from "node:test";
import assert from "node:assert/strict";

import { pairPlaces, slotPosition, slotPresence } from "./hopper3d.js";

/* The CAD analysis's own answers for team 5805's hopper, abbreviated: nine places with the intake stowed,
   seventeen with it deployed, lowest first in both. The first three are the same places either way. */
const STOWED = [
  [0.0368, 0.3606, -0.1529],
  [0.0368, 0.3606, 0.0593],
  [0.0368, 0.4667, -0.2589],
];
const DEPLOYED = [
  [0.0368, 0.3606, -0.1529],
  [0.0368, 0.3606, 0.0593],
  [0.355, 0.3606, -0.2589],
  [0.461, 0.3606, -0.1529],
];

test("a place is where the packing measured it at either end of the intake's travel", () => {
  const places = pairPlaces(STOWED, DEPLOYED);
  assert.equal(places.length, 4);
  assert.deepEqual(slotPosition(places[2], 0), STOWED[2]);
  assert.deepEqual(slotPosition(places[2], 1), DEPLOYED[2]);
  /* Half way out is half way between, so a ball is drawn moving rather than jumping. */
  slotPosition(places[2], 0.5).forEach((v, k) => {
    assert.ok(Math.abs(v - (STOWED[2][k] + DEPLOYED[2][k]) / 2) < 1e-12, `axis ${k}: ${v}`);
  });
});

test("a place the robot has either way never moves out from under its ball", () => {
  const places = pairPlaces(STOWED, DEPLOYED);
  for (const u of [0, 0.3, 0.7, 1]) assert.equal(slotPresence(places[0], u), 1);
  assert.deepEqual(slotPosition(places[0], 0.42), STOWED[0]);
});

test("a place that exists only with the intake out takes its ball with it", () => {
  const places = pairPlaces(STOWED, DEPLOYED);
  const tray = places[3];
  assert.equal(tray.at, null);
  assert.equal(slotPresence(tray, 0), 0);
  assert.equal(slotPresence(tray, 1), 1);
  assert.ok(slotPresence(tray, 0.5) < 0.5, "not yet there half way out");
  /* Its position is the only one it has, so a ball on its way out is never drawn inside the robot. */
  assert.deepEqual(slotPosition(tray, 0), DEPLOYED[3]);
});

test("an extension outside the travel is held to it", () => {
  const places = pairPlaces(STOWED, DEPLOYED);
  assert.deepEqual(slotPosition(places[2], -3), STOWED[2]);
  assert.deepEqual(slotPosition(places[2], 12), DEPLOYED[2]);
  assert.equal(slotPresence(places[3], -1), 0);
  assert.equal(slotPresence(places[3], 9), 1);
});

test("the robot's own manifest pairs into places that never leave the hopper", async () => {
  const { readFile } = await import("node:fs/promises");
  let manifest = null;
  try {
    manifest = JSON.parse(await readFile(new URL("./vendor/robot.json", import.meta.url), "utf8"));
  } catch {
    /* vendor/ is baked by `npm run robot-cad`, not checked in: nothing to check on a fresh clone. */
    return;
  }
  const hopper = manifest.hopper;
  const places = pairPlaces(hopper.ballCentres.stowed, hopper.ballCentres.deployed);
  assert.equal(places.length, hopper.ballCentres.deployed.length);
  assert.equal(places.filter((p) => p.at).length, hopper.capacity.stowed);

  /* Every place the robot has stowed sits inside the section the analysis measured, clear of the walls,
     the top, the feeder rollers behind it and the sloped floor. This is the check that would have caught
     the ball drawn inside the shooter. */
  const r = hopper.ball.diameter / 2;
  const s = hopper.section;
  const floorY = (x) => {
    const [x0, y0] = s.floor.through;
    if (x <= s.floor.levelBeyondX) return y0 - (x0 - x) * Math.tan((s.floor.slopeDeg * Math.PI) / 180);
    return y0;
  };
  for (const place of places) {
    if (!place.at) continue;
    const [x, y, z] = place.at;
    assert.ok(x >= s.back + r - 1e-6, `x ${x} clear of the feeder`);
    assert.ok(x <= s.front - r + 1e-6, `x ${x} inside the hopper's front`);
    assert.ok(y <= s.top - r + 1e-6, `y ${y} under the top`);
    assert.ok(Math.abs(z) <= s.halfWidth - r + 1e-6, `z ${z} inside the walls`);
    assert.ok(y >= floorY(x) + r * 0.7, `y ${y} above the floor at x ${x}`);
  }

  /* And no two places hold the same ball. */
  for (let i = 0; i < places.length; i++) {
    for (let j = i + 1; j < places.length; j++) {
      for (const u of [0, 1]) {
        const a = slotPosition(places[i], u);
        const b = slotPosition(places[j], u);
        if (!a || !b) continue;
        if (slotPresence(places[i], u) < 0.5 || slotPresence(places[j], u) < 0.5) continue;
        const gap = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        assert.ok(gap > r * 1.9, `places ${i} and ${j} overlap at ${u}: ${gap.toFixed(4)} m apart`);
      }
    }
  }
});
