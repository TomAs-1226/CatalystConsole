/* FUEL in flight.
 *
 * When the robot shoots, the field view launches a ball for every one the hopper estimate says has left
 * (see mechanisms.js), from the shooter's exit, at the speed the flywheel gives it and the angle the hood
 * gives it, carrying the robot's own velocity. From there it is a ball: it arcs under gravity, drops into
 * a HUB if it meets the opening on the way down, and otherwise lands, bounces once the way foam does,
 * rolls to a stop and goes. The balls are one instanced mesh, lit by the robot's studio (they belong to
 * the robot's picture, not the field's), and a ball that leaves shrinks away rather than blinking out.
 */

import * as THREE from "./vendor/three.module.min.js";
import { ballAt, FUEL_DIAMETER_M, GRAVITY } from "./mechanisms.js";

const RADIUS = FUEL_DIAMETER_M / 2;
/* More than a hopper holds, so a long volley never runs out of balls to draw. */
const MAX_BALLS = 72;
/* Foam: the first bounce keeps a third of the fall, and the floor takes most of the run out of it. */
const BOUNCE_KEEP = 0.32;
const SKID_KEEP = 0.55;
const ROLL_S = 0.9;
const ROLL_DRAG_S = 0.45;
const SHRINK_S = 0.3;
/* Into the HUB: the ball keeps falling and shrinks as it goes in. */
const SCORE_S = 0.22;
/* A ball that never lands - off the top of the view - is dropped after this long. */
const LIFETIME_S = 6;

/**
 * `hubs` are the HUB openings in the scene's frame: `[{ x, z }]` centres, with the opening
 * `openingHeight` metres up and `openingRadius` across. Returns { root, launch, step, clear, aim,
 * setEnvironment, dispose }.
 */
export function createShots({ hubs: hubList = [], openingHeight = 1.83, openingRadius = 0.5 } = {}) {
  let hubs = hubList;
  const geometry = new THREE.IcosahedronGeometry(RADIUS, 2);
  const material = new THREE.MeshStandardMaterial({ color: 0xd9d9dc, roughness: 0.82, metalness: 0, dithering: true });
  material.envMapIntensity = 0.35;
  const mesh = new THREE.InstancedMesh(geometry, material, MAX_BALLS);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  const root = new THREE.Group();
  root.name = "shots";
  root.add(mesh);

  const balls = [];
  const matrix = new THREE.Matrix4();
  const place = new THREE.Vector3();
  const turn = new THREE.Quaternion();
  const size = new THREE.Vector3();
  const axis = new THREE.Vector3();

  function launch(from, velocity, now) {
    if (balls.length >= MAX_BALLS) balls.shift();
    const spin = new THREE.Vector3(-velocity[2], 0, velocity[0]);
    if (spin.lengthSq() < 1e-9) spin.set(1, 0, 0);
    balls.push({
      phase: "flight",
      from: [from[0], from[1], from[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      since: now,
      born: now,
      at: [from[0], from[1], from[2]],
      /* Backspin off the flywheel, turning about the horizontal axis across its flight. */
      spinAxis: spin.normalize(),
      spinRate: -Math.hypot(velocity[0], velocity[2]) / RADIUS * 0.6,
      bounces: 0,
      scale: 1,
      turned: 0,
      stepped: now,
    });
  }

  function intoHub(prev, next) {
    if (!(prev[1] > openingHeight && next[1] <= openingHeight)) return false;
    return hubs.some((hub) => Math.hypot(next[0] - hub.x, next[2] - hub.z) < openingRadius);
  }

  function step(now) {
    let alive = 0;
    for (const ball of balls) {
      const t = (now - ball.since) / 1000;
      const age = (now - ball.born) / 1000;
      if (age > LIFETIME_S) ball.phase = "gone";
      if (ball.phase === "flight") {
        const next = ballAt(ball.from, ball.velocity, t);
        if (intoHub(ball.at, next)) {
          ball.phase = "score";
          ball.from = next;
          ball.velocity = [ball.velocity[0] * 0.3, ball.velocity[1] - GRAVITY * t, ball.velocity[2] * 0.3];
          ball.since = now;
        } else if (next[1] <= RADIUS) {
          /* The floor. Where along this step it was reached does not matter at this frame rate. */
          const falling = ball.velocity[1] - GRAVITY * t;
          ball.bounces += 1;
          ball.from = [next[0], RADIUS, next[2]];
          ball.since = now;
          if (ball.bounces >= 2 || Math.abs(falling) < 1) {
            ball.phase = "roll";
            ball.velocity = [ball.velocity[0] * SKID_KEEP, 0, ball.velocity[2] * SKID_KEEP];
          } else {
            ball.velocity = [ball.velocity[0] * SKID_KEEP, Math.abs(falling) * BOUNCE_KEEP, ball.velocity[2] * SKID_KEEP];
          }
          ball.at = ball.from;
        } else {
          ball.at = next;
        }
      } else if (ball.phase === "roll") {
        /* Rolling out: the distance a speed decaying with ROLL_DRAG_S covers, which stops by itself. */
        const k = ROLL_DRAG_S * (1 - Math.exp(-t / ROLL_DRAG_S));
        ball.at = [ball.from[0] + ball.velocity[0] * k, RADIUS, ball.from[2] + ball.velocity[2] * k];
        ball.spinRate = -Math.hypot(ball.velocity[0], ball.velocity[2]) * Math.exp(-t / ROLL_DRAG_S) / RADIUS;
        if (t > ROLL_S) ball.scale = Math.max(0, 1 - (t - ROLL_S) / SHRINK_S);
        if (ball.scale <= 0) ball.phase = "gone";
      } else if (ball.phase === "score") {
        ball.at = ballAt(ball.from, ball.velocity, t);
        ball.scale = Math.max(0, 1 - t / SCORE_S);
        if (ball.scale <= 0) ball.phase = "gone";
      }
      if (ball.phase !== "gone") alive++;
    }
    for (let i = balls.length - 1; i >= 0; i--) if (balls[i].phase === "gone") balls.splice(i, 1);

    mesh.count = balls.length;
    balls.forEach((ball, i) => {
      /* The spin is summed rather than worked out from the ball's age, so it carries on smoothly when a
         bounce or the roll changes its rate. */
      ball.turned += (Math.max(0, now - ball.stepped) / 1000) * ball.spinRate;
      ball.stepped = now;
      axis.copy(ball.spinAxis);
      turn.setFromAxisAngle(axis, ball.turned);
      place.set(ball.at[0], ball.at[1], ball.at[2]);
      const s = ball.scale * ball.scale * (3 - 2 * ball.scale);
      size.set(s, s, s);
      mesh.setMatrixAt(i, matrix.compose(place, turn, size));
    });
    mesh.instanceMatrix.needsUpdate = true;
    return alive > 0;
  }

  return {
    root,
    launch,
    step,
    /** How many balls are in the air or on the floor. */
    get count() {
      return balls.length;
    },
    /** Where the HUB openings are, in the scene's frame: [{ x, z }]. */
    setHubs(next) {
      hubs = Array.isArray(next) ? next : [];
    },
    clear() {
      balls.length = 0;
      mesh.count = 0;
    },
    /** The studio reflections, as the robot's own materials take them (see robot3d.js aim). */
    setEnvironment(texture) {
      material.envMap = texture;
      material.needsUpdate = true;
    },
    aim(yaw) {
      material.envMapRotation.set(0, yaw, 0);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
