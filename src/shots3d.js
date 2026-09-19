/* The robot shooting, drawn.
 *
 * A visualization, not a simulation. The console cannot know where a real ball goes - whether it scored,
 * bounced out or hit the net - and a simulator that guessed would show a miss the robot did not make. So
 * a shot is drawn only as far as it is known: FUEL leaves the shooter, up to four abreast the way the
 * robot's shooter feeds them, each a little differently, on a short arc in the direction the shooter is
 * pointing at the speed the flywheel gives it, and fades out while it is still climbing away. A shot at a
 * HUB never lands and never reaches it.
 *
 * A lob to a feed spot does land, because the robot says where: it flies to the spot the robot aims at,
 * in the time of flight the robot publishes (see lobVelocity in mechanisms.js), comes down on the carpet
 * there and fades. The robot's prediction, drawn - not a flight worked out from the flywheel, which is
 * what used to carry lobs off the field.
 *
 * The balls look like the field's own FUEL - muted yellow, the same flat material under the field's
 * lights - so the robot is visibly shooting the same thing that lies on the carpet, and in the volume a
 * REBUILT shooter moves it.
 */

import * as THREE from "./vendor/three.module.min.js";
import { FUEL_DIAMETER_M, GRAVITY } from "./mechanisms.js";

const RADIUS = FUEL_DIAMETER_M / 2;
/* A shooter four wide at sixteen balls a second keeps twenty-odd in the air: room for more than that. */
const MAX_BALLS = 160;
/* How long a ball is shown: grown out of the shooter over the first few centimetres, carried along its
   arc, and faded out well before it could come down. */
const EMERGE_S = 0.05;
const SHOWN_S = 0.8;
const FADE_S = 0.3;
/* A lob that has landed rests where it came down this long, going as it goes. */
const LANDED_FADE_S = 0.4;

const smooth = (u) => {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
};

/** Returns { root, launch, step, setColour, clear, count, dispose }. `colour` is FUEL's. */
export function createShots({ colour = "#a8913e" } = {}) {
  const geometry = new THREE.IcosahedronGeometry(RADIUS, 2);
  const material = new THREE.MeshLambertMaterial({ color: colour, toneMapped: false });
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

  /**
   * Send a ball from `from` ([x, y, z]) at `velocity` ([vx, vy, vz]), both in the scene's frame. With
   * `landS`, a lob: it is carried the whole way down, lands `landS` seconds on, and fades where it landed;
   * without, it fades out while still climbing.
   */
  function launch(from, velocity, now, { landS = null } = {}) {
    if (balls.length >= MAX_BALLS) balls.shift();
    const across = new THREE.Vector3(velocity[2], 0, -velocity[0]);
    if (across.lengthSq() < 1e-9) across.set(1, 0, 0);
    balls.push({
      from: [from[0], from[1], from[2]],
      velocity: [velocity[0], velocity[1], velocity[2]],
      born: now,
      landS: landS > 0 ? landS : null,
      /* Backspin off the flywheel, turning about the axis across its travel. */
      axis: across.normalize(),
      spin: -Math.hypot(velocity[0], velocity[2]) / RADIUS,
    });
  }

  const lifetime = (ball) => (ball.landS !== null ? ball.landS + LANDED_FADE_S : SHOWN_S + FADE_S);

  /** Move every ball to `now`. Returns true while any is still shown. */
  function step(now) {
    for (let i = balls.length - 1; i >= 0; i--) {
      if ((now - balls[i].born) / 1000 > lifetime(balls[i])) balls.splice(i, 1);
    }
    mesh.count = balls.length;
    balls.forEach((ball, i) => {
      const t = (now - ball.born) / 1000;
      /* A lob stops where it lands, and stops turning. */
      const flown = ball.landS !== null ? Math.min(t, ball.landS) : t;
      place.set(
        ball.from[0] + ball.velocity[0] * flown,
        ball.from[1] + ball.velocity[1] * flown - 0.5 * GRAVITY * flown * flown,
        ball.from[2] + ball.velocity[2] * flown
      );
      turn.setFromAxisAngle(ball.axis, ball.spin * flown);
      const going = ball.landS !== null
        ? smooth((t - ball.landS) / LANDED_FADE_S)
        : smooth((t - SHOWN_S) / FADE_S);
      size.setScalar(smooth(t / EMERGE_S) * (1 - going));
      mesh.setMatrixAt(i, matrix.compose(place, turn, size));
    });
    mesh.instanceMatrix.needsUpdate = true;
    return balls.length > 0;
  }

  return {
    root,
    launch,
    step,
    /** How many balls are being shown. */
    get count() {
      return balls.length;
    },
    /** FUEL's colour, as a THREE.Color or any CSS colour string. */
    setColour(next) {
      if (next) material.color.set(next);
    },
    clear() {
      balls.length = 0;
      mesh.count = 0;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      mesh.dispose();
    },
  };
}
