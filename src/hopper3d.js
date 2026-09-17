/* FUEL inside the robot.
 *
 * The hopper shows as many balls as the hopper estimate says it holds (see mechanisms.js createHopper),
 * packed into the hopper's interior the way balls settle - a layer at a time from the floor up, each
 * layer nestled into the gaps of the one below. A ball the robot takes in rolls in through the intake
 * from the carpet in front of it and drops into its place; a ball fed to the shooter leaves from the top
 * of the pile toward the feeder. Like the shots, it is a picture of what the estimate says, not a
 * simulation of how the balls move.
 *
 * Everything here is in the robot's own frame (x front, y up, z right), inside the robot model, so it
 * travels and turns with the robot in both views.
 */

import * as THREE from "./vendor/three.module.min.js";
import { FUEL_DIAMETER_M } from "./mechanisms.js";

const RADIUS = FUEL_DIAMETER_M / 2;
const ARRIVE_S = 0.42;
const LEAVE_S = 0.18;
/* Arrivals in a burst are staggered, so a big intake reads as a stream rather than a teleport. */
const STAGGER_S = 0.07;

/**
 * Where balls sit in a box, in the order they fill it: `min` and `max` are its corners ([x, y, z]),
 * `radius` the balls'. Close-packed layers from the floor up, alternate layers offset into the gaps, a
 * little jitter so a full hopper is not a crystal. Deterministic: the same box packs the same way.
 */
export function packSlots(min, max, radius = RADIUS) {
  const slots = [];
  const d = radius * 2;
  const rowStep = d * Math.sqrt(3) / 2;
  const layerStep = d * Math.sqrt(2 / 3);
  let seed = 12345;
  const jitter = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return ((seed / 2147483648) - 0.5) * radius * 0.25;
  };
  for (let layer = 0; ; layer++) {
    const y = min[1] + radius + layer * layerStep;
    if (y > max[1] - radius) break;
    const shiftX = layer % 2 ? radius : 0;
    const shiftZ = layer % 2 ? rowStep / 3 : 0;
    const row = [];
    for (let r = 0; ; r++) {
      const z = min[2] + radius + shiftZ + r * rowStep;
      if (z > max[2] - radius) break;
      for (let c = 0; ; c++) {
        const x = min[0] + radius + shiftX + (r % 2 ? radius : 0) + c * d;
        if (x > max[0] - radius) break;
        row.push([x + jitter(), y + Math.abs(jitter()) * 0.3, z + jitter()]);
      }
    }
    slots.push(...row);
  }
  return slots;
}

const smooth = (u) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

/**
 * `box` is the hopper interior ({ min, max } in the robot frame), `mouth` where balls come in from (a
 * point on the carpet just in front of the intake), `feeder` where they leave to, `colour` FUEL's.
 * Returns { root, setCount, step, count, setColour, dispose }.
 */
export function createHopperBalls({ box, mouth, feeder, colour = "#a8913e", material: given = null }) {
  const slots = packSlots(box.min, box.max);
  const geometry = new THREE.IcosahedronGeometry(RADIUS, 2);
  const material = given ?? new THREE.MeshStandardMaterial({ color: colour, roughness: 0.9, metalness: 0 });
  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, slots.length));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.name = "hopper-fuel";
  root.add(mesh);

  /* One entry per slot in use, in fill order: { from, at, since, leaving }. */
  const balls = [];
  let wanted = 0;
  let lastArrival = -Infinity;
  const matrix = new THREE.Matrix4();
  const place = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const size = new THREE.Vector3();

  function setCount(count, now) {
    wanted = Math.max(0, Math.min(slots.length, Math.round(count)));
    /* Arrivals: each from the intake mouth, staggered behind the last. */
    while (balls.filter((b) => !b.leaving).length < wanted) {
      const since = Math.max(now, lastArrival + STAGGER_S * 1000);
      lastArrival = since;
      const index = balls.filter((b) => !b.leaving).length;
      balls.splice(index, 0, { slot: index, since, leaving: false });
    }
    /* Departures: from the top of the pile. */
    let staying = balls.filter((b) => !b.leaving).length;
    for (let i = balls.length - 1; i >= 0 && staying > wanted; i--) {
      if (balls[i].leaving) continue;
      balls[i].leaving = true;
      balls[i].since = now;
      staying--;
    }
  }

  function step(now) {
    let moving = false;
    for (let i = balls.length - 1; i >= 0; i--) {
      if (balls[i].leaving && (now - balls[i].since) / 1000 > LEAVE_S) balls.splice(i, 1);
    }
    mesh.count = balls.length;
    balls.forEach((ball, i) => {
      const slot = slots[Math.min(ball.slot, slots.length - 1)];
      const t = (now - ball.since) / 1000;
      let s = 1;
      if (ball.leaving) {
        const u = smooth(t / LEAVE_S);
        place.set(slot[0] + (feeder[0] - slot[0]) * u, slot[1] + (feeder[1] - slot[1]) * u, slot[2] + (feeder[2] - slot[2]) * u);
        s = 1 - u;
        moving = true;
      } else if (t < 0) {
        s = 0;
        place.set(mouth[0], mouth[1], mouth[2]);
        moving = true;
      } else if (t < ARRIVE_S) {
        /* Up the intake and over into the pile: a quadratic curve through a point above the midway. */
        const u = smooth(t / ARRIVE_S);
        const mid = [(mouth[0] + slot[0]) / 2, Math.max(mouth[1], slot[1]) + 0.12, (mouth[2] + slot[2]) / 2];
        const a = (1 - u) * (1 - u);
        const b = 2 * (1 - u) * u;
        const c = u * u;
        place.set(a * mouth[0] + b * mid[0] + c * slot[0], a * mouth[1] + b * mid[1] + c * slot[1], a * mouth[2] + b * mid[2] + c * slot[2]);
        s = smooth(t / 0.08);
        moving = true;
      } else {
        place.set(slot[0], slot[1], slot[2]);
      }
      turn.set(0, 0, 0, 1);
      size.setScalar(s);
      mesh.setMatrixAt(i, matrix.compose(place, turn, size));
    });
    mesh.instanceMatrix.needsUpdate = true;
    return moving;
  }

  return {
    root,
    setCount,
    step,
    /** How many balls the hopper can show. */
    get capacity() {
      return slots.length;
    },
    get count() {
      return wanted;
    },
    setColour(next) {
      if (next && !given) material.color.set(next);
    },
    dispose() {
      geometry.dispose();
      if (!given) material.dispose();
      mesh.dispose();
    },
  };
}
