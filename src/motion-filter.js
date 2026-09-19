/* How the robot is moving, for drawing where it is heading, from reports that are noisy.
 *
 * Tesla does not draw its car's path by differentiating positions. It fuses wheel speeds, the IMU and its
 * cameras in filters built on a model of how a car can move, draws the planner's trajectory - smooth by
 * construction - and holds what reaches the screen steady from frame to frame, so a noisy measurement moves
 * the picture a little rather than throwing it about. The same ideas, sized for a dashboard:
 *
 *   * The robot's own chassis velocity, from wheel odometry and the gyro, is used whenever it publishes one
 *     (Catalyst's /Catalyst/Swerve/ChassisVelocities). It is measured rather than differentiated, and a
 *     vision correction to the pose does not jolt it.
 *   * Otherwise velocity comes from an alpha-beta filter on the pose: the steady state of a Kalman filter
 *     for a robot moving at a constant velocity. It averages pose noise away without the lag of a long
 *     window, and a pose that jumps is taken as a jump, not as a burst of speed.
 *   * How fast the direction of travel turns is taken from that velocity and low-passed again, with a
 *     deadband so a straight drive draws straight, and a limit so no single report ties the line in a knot.
 *   * Below a walking pace a robot has no direction of travel worth drawing, so the turn fades to nothing.
 *
 * Coordinates are whatever the caller uses, as long as positions and velocities agree; times are seconds.
 */

/** The shortest signed turn from `a` to `b`, radians. */
function turnBetween(a, b) {
  let d = (b - a) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export function createMotionFilter({
  alpha = 0.4,          // how much of a pose's surprise moves the position
  beta = 0.06,          // ...and the velocity
  measuredSeconds = 0.08, // how quickly a measured velocity is followed
  measuredFreshS = 0.3, // a measured velocity older than this is not used
  turnSeconds = 0.35,   // the low-pass on the turn of the direction of travel
  deadband = 0.12,      // rad/s of turn that are drawn as none
  maxTurn = 2.5,        // rad/s
  minSpeed = 0.25,      // m/s below which there is no direction of travel
  jump = 1.5,           // metres: a pose further than this from the prediction is a reset
} = {}) {
  let at = null;
  let x = 0;
  let y = 0;
  let vx = 0;
  let vy = 0;
  let measuredAt = -Infinity;
  let direction = null;
  let directionAt = null;
  let turn = 0;

  const lowpass = (value, goal, dt, seconds) => goal + (value - goal) * Math.exp(-dt / seconds);

  let turnAt = null;
  /* The turn is measured over at least TURN_WINDOW_S: a direction differenced over one 20 ms report is mostly
     noise, and clipping that noise to the limit would bias the answer toward straight. */
  const TURN_WINDOW_S = 0.1;
  function updateTurn(t) {
    const speed = Math.hypot(vx, vy);
    const since = turnAt === null ? 0 : t - turnAt;
    turnAt = t;
    if (speed < minSpeed) {
      direction = null;
      directionAt = null;
      if (since > 0) turn = lowpass(turn, 0, since, 0.15);
      return;
    }
    const now = Math.atan2(vy, vx);
    if (direction === null) {
      direction = now;
      directionAt = t;
      return;
    }
    const dt = t - directionAt;
    if (dt < TURN_WINDOW_S) return;
    if (dt < 0.6) {
      const raw = Math.max(-maxTurn, Math.min(maxTurn, turnBetween(direction, now) / dt));
      turn = lowpass(turn, raw, dt, turnSeconds);
    }
    direction = now;
    directionAt = t;
  }

  return {
    /** A reported position at time `t`. */
    pose(t, px, py) {
      if (!Number.isFinite(px) || !Number.isFinite(py) || !Number.isFinite(t)) return;
      const dt = at === null ? 0 : t - at;
      if (at === null || dt <= 0 || dt > 0.5) {
        /* First sight, or a gap long enough that nothing carries over. */
        if (at === null || dt > 0.5) {
          x = px;
          y = py;
          if (t - measuredAt > measuredFreshS) {
            vx = 0;
            vy = 0;
          }
          at = t;
          direction = null;
          turn = 0;
        }
        return;
      }
      const predictedX = x + vx * dt;
      const predictedY = y + vy * dt;
      const rx = px - predictedX;
      const ry = py - predictedY;
      at = t;
      if (Math.hypot(rx, ry) > jump) {
        /* A reset, not a movement. */
        x = px;
        y = py;
        vx = 0;
        vy = 0;
        direction = null;
        turn = 0;
        return;
      }
      x = predictedX + alpha * rx;
      y = predictedY + alpha * ry;
      if (t - measuredAt > measuredFreshS) {
        vx += (beta / dt) * rx;
        vy += (beta / dt) * ry;
        updateTurn(t);
      }
    },
    /** A measured velocity at time `t`, in the same frame as the positions. */
    velocity(t, mvx, mvy) {
      if (!Number.isFinite(mvx) || !Number.isFinite(mvy) || !Number.isFinite(t)) return;
      const dt = t - measuredAt;
      if (!(dt > 0) || dt > measuredFreshS) {
        vx = mvx;
        vy = mvy;
      } else {
        vx = lowpass(vx, mvx, dt, measuredSeconds);
        vy = lowpass(vy, mvy, dt, measuredSeconds);
      }
      measuredAt = t;
      updateTurn(t);
    },
    /** The estimate: velocity, speed, and the drawn turn of the direction of travel (rad/s). */
    get vx() {
      return vx;
    },
    get vy() {
      return vy;
    },
    get speed() {
      return Math.hypot(vx, vy);
    },
    get turn() {
      const size = Math.abs(turn) - deadband;
      return size > 0 ? Math.sign(turn) * size : 0;
    },
    /** Whether the velocity is the robot's own measurement rather than estimated from poses. */
    measured(t) {
      return t - measuredAt <= measuredFreshS;
    },
    /** Stop: the robot has stopped reporting movement. */
    stop() {
      vx = 0;
      vy = 0;
      direction = null;
      turn = 0;
    },
    reset() {
      at = null;
      vx = 0;
      vy = 0;
      measuredAt = -Infinity;
      direction = null;
      directionAt = null;
      turnAt = null;
      turn = 0;
    },
  };
}
