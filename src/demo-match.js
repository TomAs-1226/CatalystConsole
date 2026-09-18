/* The REBUILT match Console's demo mode plays.
 *
 * Team 5805's robot on the red alliance, driving a whole match the way a good team drives one. In auto it
 * shoots its preload on the move, drives out over a BUMP, sweeps the FUEL heaped across midfield, comes
 * back over the other BUMP, swings its shooter onto the HUB and shoots on the move. Through teleop it
 * cycles - a different part of the pile each trip, either BUMP, sometimes auto-aligning and shooting from
 * a stop, sometimes strafing and shooting on the move - and it keeps to the HUB schedule: while the red
 * HUB sits out shifts 1 and 3 it fills up, lobs FUEL into its alliance zone for its partners, and is
 * waiting in position, full, the moment the HUB comes back.
 *
 * Pure: demoMatch(t) is the robot `t` seconds into the match, and the same `t` is always the same robot.
 * The match is written as a short script of drives and holds (SCRIPT, below) and played into a 10 ms
 * recording, only as far ahead as anyone has asked - the demo runs in real time, so the recording keeps
 * pace with it rather than costing a stall when demo mode starts:
 *
 *   * a drive is a clamped cubic B-spline through its legs' control points, driven on a trapezoidal speed
 *     profile that slows for curvature, for the BUMPS, for intaking and for shooting;
 *   * the heading is a separate, rate-limited controller - a swerve points its shooter independently of
 *     where it is going - that faces the path, holds a heading across a BUMP, or swings the shooter onto
 *     the HUB's motion-compensated aim point and tracks it;
 *   * the hood, the flywheel and the intake slide chase their goals with the lag the real ones have, and
 *     the robot only shoots when 581's gates would let it: flywheel at speed, hood at its angle, aimed,
 *     inside the alliance zone, and the HUB active for as long as the FUEL is in the air.
 *
 * Queries read the recording, interpolated, so a robot drawn at 60 frames a second glides rather than
 * steps between the 10 ms samples.
 *
 * What the console derives from this agrees with how it derives it. FUEL is counted at the console's
 * rates (mechanisms.js createHopper: 8 a second in while the intake is eating, 16 out while feeding a
 * spinning shooter, 50 held, 8 preloaded), and the intake only eats where the field has FUEL - the pile at
 * midfield and the red DEPOT - which is what its current shows: a few amps spinning over bare carpet,
 * thirty-odd with its mouth full. The HUB schedule is hub.js's. The module states are the inverse
 * kinematics of the chassis speeds. The path band is the part of the recording still ahead of the robot.
 *
 * Field positions are WPILib's, metres from the blue origin. The obstacles and the FUEL were measured off
 * the field CAD and its collision map (scripts/field-collision.mjs) and written down here, because the
 * map is a vendored build product the tests cannot rely on.
 */

import { activeIn, AUTO_S, segmentAt, TELEOP_S } from "./hub.js";

/* ---------------------------------------------------------------- the field */

export const FIELD_LENGTH = 16.54;
export const FIELD_WIDTH = 8.07;
export const MATCH_S = AUTO_S + TELEOP_S;

/** The red HUB's centre. The HUB itself is a 1.2 m square column. */
export const RED_HUB = Object.freeze([11.93, 4.035]);
/** The red alliance zone is everything beyond this x. */
export const RED_ZONE_X = 12.58;

/* The BUMPS either side of the red HUB: 165 mm ramps a robot drives over, between the HUB's side and the
   wall of a TRENCH, whose 560 mm bar this 650 mm robot cannot get under. */
const BUMP_X = [11.3, 12.58];
const LOWER_BUMP_Y = [1.6, 3.435];
const UPPER_BUMP_Y = [4.635, 6.45];
const LOWER_LINE = 2.52;
const UPPER_LINE = 5.54;

/* Where FUEL lies at the start, from the field CAD: 360 balls heaped across midfield in a 12 x 30 grid,
   and 24 in the red DEPOT behind its 29 mm lip at the alliance wall. Each box is the balls' own extent,
   centres plus a radius. Nobody refills the DEPOT during a match. */
const PILE = Object.freeze({ x: [7.365, 9.195], y: [1.715, 6.335] });
const DEPOT = Object.freeze({ x: [15.935, 16.545], y: [1.635, 2.545] });
const DEPOT_FUEL = 24;

/* ---------------------------------------------------------------- the robot */

const INCH = 0.0254;

/** Team 5805's robot, from its CAD (src/vendor/robot.json) and code. Robot frame: x forward, y left. */
export const ROBOT = Object.freeze({
  frameLength: 0.686,
  frameWidth: 0.724,
  bumperLength: 0.851,
  bumperWidth: 0.889,
  heightMeters: 0.65,
  /* WPILib order: front left, front right, back left, back right. */
  modules: Object.freeze([
    Object.freeze([0.2794, 0.2985]),
    Object.freeze([0.2794, -0.2985]),
    Object.freeze([-0.2794, 0.2985]),
    Object.freeze([-0.2794, -0.2985]),
  ]),
  wheelRadius: 0.0508,
  maxSpeed: 4.5,
  /* The intake slides out of the front: its leading edge is this far ahead of the centre with the slide
     at 0 in, and one inch further for every inch of Deploy/LengthInches. */
  intakeEdgeAtZero: 0.344,
  /* Stowed means inside the frame perimeter, which is what a robot has to be to start a match and what
     it drives round like between cycles. The arithmetic: the frame is 28 in long, so its front is
     356 mm ahead of centre and the bumper's is about 432 mm; the intake's edge is at 344 mm with the
     slide at zero and at 471 mm at Deploy's STOW of 5 in - 4 cm proud of the bumper. The demo used STOW
     and drew the intake hanging out of the robot for the whole match. 581's STOW is a real constant, so
     it is measured from a zero this model does not share; the demo draws the robot legal. */
  deployStowInches: 0,
  deployOutInches: 11.8,
});

const MODULE_RADIUS = Math.hypot(ROBOT.modules[0][0], ROBOT.modules[0][1]);

/** The hopper as the console estimates it: mechanisms.js createHopper, with the feed rate app.js gives it. */
export const HOPPER = Object.freeze({ capacity: 50, intakeRate: 8, feedRate: 16, preload: 8 });

/* 581's settings, as 5805's port carries them (ShooterConfig, Hood, Deploy, HopperManager). */
const IDLE_RPM = 750;
const HOOD_IDLE_DEG = 13;
const HOOD_STOP_DEG = 11;
const DEPLOY_POSES = Object.freeze({
  INTAKE: 11.8,
  STOW: 5.0,
  SCORE_COMPACTION_WAITING: 8.3,
  SCORE_COMPACTION: 5.0,
  FEED_COMPACTION: 6.915,
});
/* SCORE and FEED start compacting the hopper this long after they begin. */
const COMPACTION_DELAY_S = 0.7;
/* Roller outputs are volts over 12, as /Catalyst/<Roller>/Speed reports them. */
const VOLTS = (v) => v / 12;

/* ---------------------------------------------------------------- shot tables */

/* 5805's (581's) DISTANCE_TO_SCORE_RPM and DISTANCE_TO_SCORE_TOF and the feeding pair, interpolated and
   clamped at the ends the way Catalyst's InterpolatingTable is. The times of flight are measured, and
   are not monotonic. */
const SCORE_RPM = [[1.42, 1350], [2.79, 1560], [3.46, 1610], [4.92, 1900]];
const SCORE_TOF = [[1.36, 1.017], [2.42, 1.233], [3.54, 1.148], [5.5, 1.348]];
const FEED_RPM = [[6.0, 1500], [8.71, 2500], [13.6, 2500]];
const FEED_TOF = [[6.0, 1.305555556], [8.71, 1.275555556], [13.6, 1.530952381]];

/* The hood has no table in 5805's code yet. This one is written to agree with the RPM table: launched at
   90 degrees less the hood angle and keeping 81% of the flywheel's surface speed (mechanisms.js), a ball
   reaches the HUB's opening on the steep arc at about these angles. A monotone cubic runs through them,
   so the hood moves smoothly as the distance does. */
const SCORE_HOOD = [[1.42, 17], [2.79, 25], [3.46, 28.5], [4.92, 34]];
const FEED_HOOD = [[6.0, 38], [8.71, 42], [13.6, 45]];

function linearTable(table) {
  return (x) => {
    if (!(x > table[0][0])) return table[0][1];
    for (let i = 1; i < table.length; i++) {
      if (x <= table[i][0]) {
        const [x0, y0] = table[i - 1];
        const [x1, y1] = table[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return table[table.length - 1][1];
  };
}

/* Fritsch-Carlson: a cubic through every entry that never overshoots between them. */
function monotoneTable(table) {
  const n = table.length;
  const h = [];
  const d = [];
  for (let i = 0; i < n - 1; i++) {
    h.push(table[i + 1][0] - table[i][0]);
    d.push((table[i + 1][1] - table[i][1]) / h[i]);
  }
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (d[i - 1] * d[i] <= 0) m[i] = 0;
    else {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      m[i] = (w1 + w2) / (w1 / d[i - 1] + w2 / d[i]);
    }
  }
  return (x) => {
    if (!(x > table[0][0])) return table[0][1];
    if (x >= table[n - 1][0]) return table[n - 1][1];
    let i = 0;
    while (x > table[i + 1][0]) i++;
    const u = (x - table[i][0]) / h[i];
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * table[i][1] +
      (u3 - 2 * u2 + u) * h[i] * m[i] +
      (-2 * u3 + 3 * u2) * table[i + 1][1] +
      (u3 - u2) * h[i] * m[i + 1]
    );
  };
}

/** Flywheel RPM for a shot into the HUB from `distance` metres (5805's table). */
export const scoreRpmAt = linearTable(SCORE_RPM);
/** Seconds a scored ball is in the air from `distance` metres (581's measurements). */
export const scoreTimeOfFlightAt = linearTable(SCORE_TOF);
/** The hood angle, in Hood.java's degrees, for a shot into the HUB from `distance` metres. */
export const scoreHoodDegAt = monotoneTable(SCORE_HOOD);
const feedRpmAt = linearTable(FEED_RPM);
const feedTimeOfFlightAt = linearTable(FEED_TOF);
const feedHoodDegAt = monotoneTable(FEED_HOOD);

/* ---------------------------------------------------------------- the clock */

/** Whether the red HUB scores `t` seconds into the match: all through auto, then hub.js's schedule with
 *  FMS naming red (the demo's game data), so red sits out shifts 1 and 3. */
export function redHubActive(t) {
  if (!(t >= 0) || t > MATCH_S) return false;
  if (t < AUTO_S) return true;
  return activeIn(segmentAt(MATCH_S - t), "red", "red") === true;
}

/** The match clock `t` seconds into the match, as a robot publishes it: `timeLeft` counts down within auto
 *  (20 to 0) and within teleop (140 to 0). */
export function matchClock(t) {
  const at = Number.isFinite(t) ? t : 0;
  if (at < 0) return { period: "pre", auto: false, enabled: false, timeLeft: AUTO_S, hubActive: false };
  if (at < AUTO_S) return { period: "auto", auto: true, enabled: true, timeLeft: AUTO_S - at, hubActive: true };
  if (at < MATCH_S) {
    return { period: "teleop", auto: false, enabled: true, timeLeft: MATCH_S - at, hubActive: redHubActive(at) };
  }
  return { period: "post", auto: false, enabled: false, timeLeft: 0, hubActive: false };
}

/* ---------------------------------------------------------------- small maths */

const TAU = Math.PI * 2;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const wrap = (a) => a - TAU * Math.floor((a + Math.PI) / TAU);
const inRange = (v, [lo, hi]) => v >= lo && v <= hi;
const inBox = (p, box) => inRange(p[0], box.x) && inRange(p[1], box.y);

/* Deterministic sensor noise in about -1..1: incommensurate sines, so it never visibly repeats. */
function noise(t, seed) {
  return (
    0.5 * Math.sin(t * 23.1 + seed * 1.7) +
    0.3 * Math.sin(t * 57.7 + seed * 2.9 + 1.3) +
    0.2 * Math.sin(t * 131.3 + seed * 0.7 + 2.1)
  );
}

/* ---------------------------------------------------------------- geometry */

/** How far the robot reaches ahead of its centre, in metres, with the intake slide at `deployInches`. */
export function frontReach(deployInches = ROBOT.deployStowInches) {
  return Math.max(ROBOT.bumperLength / 2, ROBOT.intakeEdgeAtZero + deployInches * INCH);
}

/** The robot's outline at `pose` ([x, y, heading]): its bumpers, and the intake where it reaches past
 *  them. Four corners, counter-clockwise from front left. */
export function robotOutline(pose, deployInches = ROBOT.deployStowInches) {
  const [x, y, theta] = pose;
  const front = frontReach(deployInches);
  const back = ROBOT.bumperLength / 2;
  const side = ROBOT.bumperWidth / 2;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [[front, side], [-back, side], [-back, -side], [front, -side]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}

/* How far the bumpers reach behind the robot's centre along field x, at a heading: the back corner. */
function backExtentX(theta) {
  return (ROBOT.bumperLength / 2) * Math.abs(Math.cos(theta)) + (ROBOT.bumperWidth / 2) * Math.abs(Math.sin(theta));
}

/* Points across the intake's mouth, a little inside its leading edge. */
function mouth(x, y, theta, deployInches) {
  const reach = ROBOT.intakeEdgeAtZero + deployInches * INCH - 0.06;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [-0.3, -0.15, 0, 0.15, 0.3].map((v) => [x + reach * c - v * s, y + reach * s + v * c]);
}

/* ---------------------------------------------------------------- driving */

/* Drive limits. The top speed stays under the drivetrain's 4.5 m/s so the modules keep room to turn the
   robot at speed; the BUMP, intake and shooting speeds are what a driver, or 5805's autos, hold to. */
const TOP_SPEED = 3.8;
const ACCEL = 3.0;
const DECEL = 3.0;
const LATERAL = 3.0;
const BUMP_SPEED = 1.5;
const INTAKE_SPEED = 1.3;
const SHOOT_SPEED = 1.5;
const FEED_SPEED = 1.3;

/* The bumpers can touch a BUMP from this far either side of it, whichever way the robot is turned, so
   the robot is at BUMP speed from there. */
const BUMP_REACH = 0.64;

/**
 * A drive along a clamped uniform cubic B-spline through `controls` ([[x, y], ...]), sampled about every
 * centimetre and timed on a trapezoidal speed profile from rest to rest.
 *
 * `caps` is a list of { from, to, speed }, spline parameters between which the speed is limited. A
 * B-spline passes near, not through, its control points: control point i sits at parameter i + 1 (the
 * ends at 0 and n + 1), and five collinear control points make the curve exactly straight from about
 * the second of them to the fourth, which is how the BUMP crossings are kept square.
 */
function makeDrive(controls, caps) {
  const n = controls.length;
  const P = [controls[0], controls[0], ...controls, controls[n - 1], controls[n - 1]];
  const xs = [];
  const ys = [];
  const us = [];
  const kappa = [];
  const tx = [];
  const ty = [];
  for (let k = 0; k < P.length - 3; k++) {
    const polygon =
      Math.hypot(P[k + 1][0] - P[k][0], P[k + 1][1] - P[k][1]) +
      Math.hypot(P[k + 2][0] - P[k + 1][0], P[k + 2][1] - P[k + 1][1]) +
      Math.hypot(P[k + 3][0] - P[k + 2][0], P[k + 3][1] - P[k + 2][1]);
    const steps = Math.max(4, Math.ceil(polygon / 3 / 0.01));
    for (let j = k === 0 ? 0 : 1; j <= steps; j++) {
      const u = j / steps;
      const u2 = u * u;
      const u3 = u2 * u;
      const w = [(1 - u) ** 3 / 6, (3 * u3 - 6 * u2 + 4) / 6, (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, u3 / 6];
      const dw = [-((1 - u) ** 2) / 2, (3 * u2 - 4 * u) / 2, (-3 * u2 + 2 * u + 1) / 2, u2 / 2];
      const ddw = [1 - u, 3 * u - 2, 1 - 3 * u, u];
      let px = 0, py = 0, dx = 0, dy = 0, ddx = 0, ddy = 0;
      for (let q = 0; q < 4; q++) {
        const [cx, cy] = P[k + q];
        px += w[q] * cx;
        py += w[q] * cy;
        dx += dw[q] * cx;
        dy += dw[q] * cy;
        ddx += ddw[q] * cx;
        ddy += ddw[q] * cy;
      }
      const speed = Math.hypot(dx, dy);
      xs.push(px);
      ys.push(py);
      us.push(k + u);
      kappa.push(speed > 1e-6 ? (dx * ddy - dy * ddx) / speed ** 3 : 0);
      tx.push(speed > 1e-9 ? dx / speed : NaN);
      ty.push(speed > 1e-9 ? dy / speed : NaN);
    }
  }
  const count = xs.length;
  /* Where the derivative vanishes, at the clamped ends, the direction comes from the next sample. */
  for (let i = 0; i < count; i++) {
    if (Number.isFinite(tx[i])) continue;
    const j = i + 1 < count ? i + 1 : i - 1;
    const sign = j > i ? 1 : -1;
    const len = Math.hypot(xs[j] - xs[i], ys[j] - ys[i]) || 1;
    tx[i] = (sign * (xs[j] - xs[i])) / len;
    ty[i] = (sign * (ys[j] - ys[i])) / len;
  }
  const s = new Float64Array(count);
  for (let i = 1; i < count; i++) s[i] = s[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);

  const limit = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    let v = TOP_SPEED;
    const k = Math.abs(kappa[i]);
    if (k > 1e-6) v = Math.min(v, Math.sqrt(LATERAL / k));
    const nearBump =
      xs[i] > BUMP_X[0] - BUMP_REACH &&
      xs[i] < BUMP_X[1] + BUMP_REACH &&
      (inRange(ys[i], [LOWER_BUMP_Y[0] - 0.6, LOWER_BUMP_Y[1] + 0.6]) || inRange(ys[i], [UPPER_BUMP_Y[0] - 0.6, UPPER_BUMP_Y[1] + 0.6]));
    if (nearBump) v = Math.min(v, BUMP_SPEED);
    for (const cap of caps) if (us[i] >= cap.from && us[i] <= cap.to) v = Math.min(v, cap.speed);
    limit[i] = v;
  }
  const v = new Float64Array(count);
  for (let i = 1; i < count; i++) v[i] = Math.min(limit[i], Math.sqrt(v[i - 1] ** 2 + 2 * ACCEL * (s[i] - s[i - 1])));
  v[count - 1] = 0;
  for (let i = count - 2; i >= 0; i--) v[i] = Math.min(v[i], Math.sqrt(v[i + 1] ** 2 + 2 * DECEL * (s[i + 1] - s[i])));
  const time = new Float64Array(count);
  for (let i = 1; i < count; i++) {
    const ds = s[i] - s[i - 1];
    time[i] = time[i - 1] + (ds > 0 ? (2 * ds) / Math.max(v[i] + v[i - 1], 1e-9) : 0);
  }

  return {
    duration: time[count - 1],
    /** Where the drive has the robot `tau` seconds in. `turn` is how fast the travel direction turns. */
    at(tau) {
      if (!(tau > 0) || tau >= time[count - 1]) {
        const e = tau > 0 ? count - 1 : 0;
        return { x: xs[e], y: ys[e], vx: 0, vy: 0, speed: 0, dir: Math.atan2(ty[e], tx[e]), u: us[e], turn: 0 };
      }
      let lo = 0;
      let hi = count - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (time[mid] <= tau) lo = mid;
        else hi = mid;
      }
      const ds = s[hi] - s[lo];
      const dt = tau - time[lo];
      const accel = ds > 0 ? (v[hi] ** 2 - v[lo] ** 2) / (2 * ds) : 0;
      const speed = Math.max(0, v[lo] + accel * dt);
      const f = ds > 0 ? Math.min(1, (v[lo] * dt + 0.5 * accel * dt * dt) / ds) : 0;
      const dirX = tx[lo] + (tx[hi] - tx[lo]) * f;
      const dirY = ty[lo] + (ty[hi] - ty[lo]) * f;
      const norm = Math.hypot(dirX, dirY) || 1;
      return {
        x: xs[lo] + (xs[hi] - xs[lo]) * f,
        y: ys[lo] + (ys[hi] - ys[lo]) * f,
        vx: (speed * dirX) / norm,
        vy: (speed * dirY) / norm,
        speed,
        dir: Math.atan2(dirY, dirX),
        u: us[lo] + (us[hi] - us[lo]) * f,
        turn: (kappa[lo] + (kappa[hi] - kappa[lo]) * f) * speed,
      };
    },
  };
}

/* ---------------------------------------------------------------- the script */

/* Who has the robot, for the path band and the Autopilot phase. Auto is always 5805's PathPlanner auto. */
const PLANNED = "pathplanner";
const AUTOPILOT = "autopilot";
const DRIVER = "driver";

/* Points on a BUMP's centre line. A crossing runs through x 13.9 or more, 13.3, 12.0, 10.7 and 10.1 or less:
   five collinear control points keep the spline dead straight from x 13.18 to 10.82, which is everywhere
   the bumpers can touch the BUMP. */
const along = (line, ...xs) => xs.map((x) => [x, line]);

/* Where FUEL is lobbed for partners: open carpet in the red alliance zone, clear of the HUB, the TOWER and
   the DEPOT. */
const FEED_UPPER = Object.freeze([14.9, 6.6]);
const FEED_LOWER = Object.freeze([14.9, 1.2]);

/** Where the robot starts: in the top half of the red alliance zone, its shooter already on the HUB. */
export const START_POSE = Object.freeze([15.35, 6.5, Math.atan2(RED_HUB[1] - 6.5, RED_HUB[0] - 15.35) + Math.PI]);

/* The tower spot: square in front of the red TOWER, 2.42 m from the HUB, one of 581's measured shots. */
const TOWER_SPOT = [14.35, 4.03];

/**
 * The match, in order: drives and holds.
 *
 * A drive is a list of legs. Each leg's `points` continue the control polygon (the drive starts wherever
 * the robot is), and its wants hold from its first point to the next leg's:
 *   heading  "travel" (intake leading, the default) | "reverse" (shooter leading) | "aim" | "feed" |
 *            "hold" | a fixed heading in radians
 *   deploy   "out" | "in" (default)      intake  true: rollers in (they eat only where there is FUEL)
 *   score    true: shoot into the HUB whenever 581's gates allow; implies heading "aim"
 *   still    with score: lining up to shoot from a stop - aim at the HUB itself, and wait for the stop
 *   feed     [x, y]: lob FUEL there from outside the alliance zone; implies heading "feed"
 *   speed    a speed limit (scoring, feeding and intaking have their own)
 *   source   AUTOPILOT, for an Autopilot drive (auto is PathPlanner's and the rest the driver's)
 *   phase    the Autopilot's phase: "Acquire" | "Score"
 *   label    what the robot is doing
 * A hold keeps the robot where it is, with the same wants, `until` a match time, until it has shot
 * everything (`empty`), until the hopper is `full` (or the intake finds nothing more), until it holds no
 * more than `downTo` FUEL, or for `seconds`; the last one, with none of those, lasts the match out.
 *
 * The timings are what make it a match rather than a loop, and they are tight: the unloads at 55 s and
 * 105 s start the moment the HUB turns active, and every other shot is over before the FUEL could land in
 * an inactive HUB. demoMatchSummary() reports anything that did not play out as written.
 */
const SCRIPT = [
  /* ---------------- auto, the transition shift, and shift 1 with the red HUB off ---------------- */
  {
    drive: [
      { label: "Shooting the preload on the move", score: true, speed: 1.4, points: [[14.95, 5.7], [14.5, 4.6]] },
      { label: "Out over the lower bump, shooter first", heading: "reverse", points: [[14.25, 3.5], ...along(LOWER_LINE, 14.3, 13.3, 12.0, 10.7, 10.1)] },
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, points: [[9.45, 2.2]] },
      { label: "Sweeping the bottom of the pile", deploy: "out", intake: true, points: [[8.6, 2.0], [7.95, 2.05], [7.75, 2.8], [7.75, 3.8], [7.75, 4.8], [7.95, 5.6], [8.6, 5.9], [9.0, 5.75]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.3, 5.54]] },
      { label: "Back over the upper bump", points: along(UPPER_LINE, 9.7, 10.1, 10.7, 12.0) },
      { label: "Shooting on the move round the hub", score: true, speed: 1.3, points: [[13.3, 5.54], [14.1, 5.4], [14.5, 4.55], [14.45, 3.5], [14.1, 2.8]] },
      { label: "Out over the lower bump, shooter first", heading: "reverse", points: along(LOWER_LINE, 14.25, 13.3, 12.0, 10.7, 10.1) },
      { label: "Into the middle of the pile", deploy: "out", intake: true, points: [[9.5, 2.85]] },
      { label: "Sweeping the middle of the pile", deploy: "out", intake: true, points: [[8.6, 3.15], [7.7, 3.3], [7.55, 3.9], [8.1, 4.4], [8.9, 4.35]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.45, 3.5]] },
      { label: "Back over the lower bump", source: AUTOPILOT, phase: "Score", points: [[9.7, 2.6], ...along(LOWER_LINE, 10.1, 10.7, 12.0)] },
      { label: "Shooting on the move up the near side of the zone", score: true, speed: 1.3, points: [[13.3, 2.52], [13.7, 2.85], [13.8, 3.8], [13.9, 4.7], [14.15, 5.3]] },
      { label: "Out over the upper bump for more", heading: "reverse", source: AUTOPILOT, phase: "Acquire", points: along(UPPER_LINE, 14.25, 13.3, 12.0, 10.7, 10.1) },
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, source: AUTOPILOT, phase: "Acquire", points: [[9.45, 5.95]] },
      { label: "Filling up across the top of the pile", deploy: "out", intake: true, points: [[8.6, 6.05], [7.75, 6.0], [7.5, 5.6], [8.0, 5.3], [8.85, 5.3], [9.1, 4.85], [8.6, 4.6], [7.75, 4.6], [7.5, 4.2], [8.1, 3.9], [8.9, 3.9]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.6, 3.85]] },
      { label: "Feeding FUEL to the alliance zone", deploy: "out", feed: FEED_UPPER, points: [[9.95, 4.3], [9.95, 5.2], [9.9, 6.1], [9.4, 6.7], [8.4, 6.8], [7.55, 6.75]] },
      { label: "Filling up again down the pile", deploy: "out", intake: true, points: [[7.5, 6.0], [7.55, 5.0], [7.55, 4.0], [7.6, 3.0], [7.8, 2.2], [8.3, 1.95], [8.45, 2.7], [8.45, 3.5], [8.8, 3.85], [9.05, 3.3], [9.0, 2.6]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.45, 2.4]] },
      { label: "Back over the lower bump", source: AUTOPILOT, phase: "Score", points: along(LOWER_LINE, 9.8, 10.1, 10.7, 12.0, 13.3, 13.9) },
      { label: "Lining up to unload", score: true, still: true, source: AUTOPILOT, phase: "Score", points: [[14.4, 2.52]] },
    ],
  },
  { label: "Waiting on the hub", hold: true, score: true, source: AUTOPILOT, phase: "Score", empty: true },

  /* ---------------- shift 2: red active ---------------- */
  {
    drive: [
      { label: "Out over the lower bump, shooter first", heading: "reverse", points: along(LOWER_LINE, 13.9, 13.3, 12.0, 10.7, 10.1) },
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, points: [[9.45, 2.15]] },
      { label: "Sweeping the far side of the pile", deploy: "out", intake: true, points: [[8.6, 1.95], [7.8, 2.0], [7.55, 2.7], [7.55, 3.7], [7.55, 4.7], [7.8, 5.5], [8.45, 5.95], [8.8, 5.4], [8.75, 4.6]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.35, 4.75]] },
      { label: "Back over the upper bump", source: AUTOPILOT, phase: "Score", points: [[9.6, 5.4], ...along(UPPER_LINE, 9.9, 10.1, 10.7, 12.0)] },
      { label: "Shooting on the move down the near side of the zone", score: true, speed: 1.3, points: [[13.3, 5.54], [13.85, 5.2], [13.7, 4.45], [13.7, 3.5], [13.75, 2.5]] },
      { label: "Round the bottom of the zone", heading: 0, points: [[13.95, 1.5], [14.6, 1.15], [15.1, 1.6], [15.0, 2.35]] },
      { label: "Out over the lower bump, shooter first", heading: "reverse", points: along(LOWER_LINE, 14.45, 13.3, 12.0, 10.7, 10.1) },
      /* ---------------- shift 3: red inactive ---------------- */
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, points: [[9.45, 2.85]] },
      { label: "Filling up through the middle of the pile", deploy: "out", intake: true, points: [[8.6, 3.2], [7.75, 3.25], [7.5, 3.75], [8.1, 4.05], [8.95, 4.1], [9.15, 4.6], [8.5, 4.95], [7.7, 4.95], [7.5, 5.45], [8.1, 5.8]] },
      { label: "Feeding FUEL to the alliance zone while intaking", deploy: "out", intake: true, feed: FEED_UPPER, points: [[8.9, 5.85], [9.2, 5.45], [8.6, 5.25], [7.9, 5.3], [7.4, 5.25]] },
      { label: "Feeding FUEL to the alliance zone", deploy: "out", feed: FEED_UPPER, points: [[6.85, 5.0], [6.6, 4.2], [6.6, 3.4], [6.75, 2.75]] },
      { label: "Filling up again along the bottom of the pile", deploy: "out", intake: true, points: [[7.15, 2.45], [7.9, 2.55], [8.6, 2.6], [9.0, 2.1], [8.4, 1.9], [7.75, 2.0], [7.55, 2.6], [8.1, 3.0], [8.95, 3.1], [9.05, 3.6], [8.6, 3.4], [9.0, 2.75]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.5, 2.3]] },
      { label: "Lining up a feed past the trench", deploy: "out", feed: FEED_LOWER, speed: 1.0, points: [[9.9, 1.6], [10.1, 1.35]] },
    ],
  },
  { label: "Feeding FUEL to the alliance zone", hold: true, deploy: "out", feed: FEED_LOWER, downTo: 27 },
  {
    drive: [
      { label: "Back over the lower bump", source: AUTOPILOT, phase: "Acquire", points: [[10.0, 2.2], ...along(LOWER_LINE, 10.1, 10.7, 12.0, 13.3, 13.9)] },
      { label: "Into the depot", deploy: "out", intake: true, source: AUTOPILOT, phase: "Acquire", speed: 1.2, points: [[14.6, 2.3], [15.3, 2.1], [15.8, 2.09]] },
    ],
  },
  { label: "Clearing the depot", hold: true, deploy: "out", intake: true, heading: "hold", full: true },
  { label: "Waiting on the hub at the depot", hold: true, score: true, until: 105 },

  /* ---------------- shift 4: red active ---------------- */
  {
    drive: [
      { label: "Shooting on the move out of the depot", score: true, speed: 1.4, points: [[15.25, 1.65], [14.55, 1.75], [14.1, 2.5], [14.1, 3.5], [14.15, 4.4]] },
      { label: "Out over the upper bump, shooter first", heading: "reverse", points: [[14.3, 5.1], ...along(UPPER_LINE, 14.3, 13.3, 12.0, 10.7, 10.1)] },
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, points: [[9.45, 5.95]] },
      { label: "Sweeping the top corner of the pile", deploy: "out", intake: true, points: [[8.6, 6.05], [7.75, 6.0], [7.55, 5.35], [7.55, 4.5], [7.9, 4.2], [8.3, 4.6], [8.3, 5.3], [8.65, 5.6], [9.0, 5.1], [9.0, 4.4]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.45, 4.9]] },
      { label: "Back over the upper bump", source: AUTOPILOT, phase: "Score", points: along(UPPER_LINE, 9.8, 10.1, 10.7, 12.0, 13.3, 13.9) },
      { label: "Lining up to shoot", score: true, still: true, source: AUTOPILOT, phase: "Score", points: [[14.3, 5.8], [14.5, 6.2]] },
    ],
  },
  { label: "Shooting from a stop", hold: true, score: true, source: AUTOPILOT, phase: "Score", empty: true },
  {
    drive: [
      { label: "Out over the upper bump, shooter first", heading: "reverse", points: [[14.2, 5.75], ...along(UPPER_LINE, 14.1, 13.3, 12.0, 10.7, 10.1)] },
      /* ---------------- end game: both HUBS active ---------------- */
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, points: [[9.45, 5.2]] },
      { label: "Sweeping the red side of the pile", deploy: "out", intake: true, points: [[8.6, 5.0], [7.8, 4.9], [7.6, 4.3], [8.1, 3.9], [8.95, 3.85], [9.1, 3.3], [8.55, 2.95], [7.8, 2.8], [7.65, 2.2], [8.3, 1.95], [9.0, 2.1]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.45, 2.4]] },
      { label: "Back over the lower bump", source: AUTOPILOT, phase: "Score", points: along(LOWER_LINE, 9.8, 10.1, 10.7, 12.0) },
      { label: "Shooting on the move up the far side of the zone", score: true, speed: 1.35, points: [[13.3, 2.52], [14.1, 2.3], [14.6, 2.75], [14.55, 3.6], [14.45, 4.5], [14.2, 5.15]] },
      { label: "Out over the upper bump, shooter first", heading: "reverse", points: along(UPPER_LINE, 14.3, 13.3, 12.0, 10.7, 10.1) },
      { label: "Swinging the intake round to the pile", deploy: "out", intake: true, points: [[9.45, 5.95]] },
      { label: "One last sweep of the pile", deploy: "out", intake: true, points: [[8.6, 6.05], [7.8, 5.95], [7.6, 5.3], [7.6, 4.4], [7.8, 3.6], [8.35, 3.35], [8.7, 3.9], [8.6, 4.7], [8.8, 5.3]] },
      { label: "Out of the pile", deploy: "out", intake: true, points: [[9.3, 5.54]] },
      { label: "Back over the upper bump", source: AUTOPILOT, phase: "Score", points: along(UPPER_LINE, 9.7, 10.1, 10.7, 12.0, 13.3, 13.9) },
      { label: "To the tower", score: true, still: true, source: AUTOPILOT, phase: "Score", points: [[14.3, 5.1], TOWER_SPOT] },
    ],
  },
  { label: "Shooting from a stop at the tower", hold: true, score: true, source: AUTOPILOT, phase: "Score", empty: true },
  { label: "Parked at the tower", hold: true },
];

/* ---------------------------------------------------------------- the recording */

const HZ = 100;
const DT = 1 / HZ;
const TICKS = MATCH_S * HZ + 1;

/* Turning. Driving, the heading keeps up with the path as fast as the drive allows. Aiming is a
   proportional controller with the target's motion fed forward: the error falls away at the same rate
   whatever it started at, so a swing onto the HUB settles in well under a second and then tracks it. */
const TURN = Object.freeze({ rate: 4.0, accel: 12, gain: 6 });
const AIM = Object.freeze({ tau: 0.24, rate: 3.5, accel: 10 });
/* Aim tolerances in degrees. The shooter counts as on target once within ALIGNED_DEG and stays on it
   until off by more than AIM_TO_KEEP_DEG; a shot starts only within AIM_TO_SHOOT_DEG. */
const AIM_TO_SHOOT_DEG = 2;
const ALIGNED_DEG = 2.5;
const AIM_TO_KEEP_DEG = 4;
/* The fastest the robot will shoot while moving (581's safe-speed gate), m/s. */
const SHOOT_MAX_SPEED = 2.0;
/* Past this the robot counts as moving for the aim state. */
const MOVING = 0.5;

const ROBOT_STATES = ["IDLE", "WARMUP_SCORE", "PREPARE_SCORE", "SCORE", "PREPARE_FEED", "FEED"];
const HOPPER_STATES = ["IDLE_STOWED", "IDLE_DEPLOYED", "INTAKING", "SCORE", "SCORE_AND_INTAKE", "FEED", "FEED_AND_INTAKE"];
const DEPLOY_POSE_NAMES = Object.keys(DEPLOY_POSES);
const AIM_STATES = ["IDLE", "ALIGNING", "ALIGNED", "SOTF"];
const SOURCES = [DRIVER, PLANNED, AUTOPILOT];
const PHASES = ["DriverControl", "Acquire", "Score"];

/* What the shooter must point at for a ball from (x, y), moving at (vx, vy), to land in `target`: the
   target less the robot's velocity over the ball's time of flight, which itself depends on the distance
   to that virtual target. */
function aimSolution(x, y, vx, vy, target, tofAt) {
  let px = target[0];
  let py = target[1];
  let tof = 0;
  let distance = Math.hypot(px - x, py - y);
  for (let k = 0; k < 4; k++) {
    tof = tofAt(distance);
    px = target[0] - vx * tof;
    py = target[1] - vy * tof;
    distance = Math.hypot(px - x, py - y);
  }
  /* The shooter fires out of the back, so the robot faces directly away from the aim point. */
  return { aimPoint: [px, py], distance, tof, heading: Math.atan2(py - y, px - x) + Math.PI };
}

/* A motion-profiled mechanism's lag: reach the goal as fast as `rate` and `accel` allow, and settle
   without overshoot. Returns [position, velocity] a tick later. */
function chase(position, velocity, goal, rate, accel, gain, goalRate = 0) {
  const e = goal - position;
  const toward = clamp(goalRate + Math.sign(e) * Math.min(rate, Math.sqrt(2 * accel * Math.abs(e)) * 0.95, gain * Math.abs(e)), -rate, rate);
  const next = velocity + clamp(toward - velocity, -accel * DT, accel * DT);
  return [position + ((velocity + next) / 2) * DT, next];
}

let recording = null;

function record() {
  if (recording) return recording;

  const R = {
    x: new Float64Array(TICKS),
    y: new Float64Array(TICKS),
    vx: new Float64Array(TICKS),
    vy: new Float64Array(TICKS),
    theta: new Float64Array(TICKS),
    omega: new Float64Array(TICKS),
    hood: new Float32Array(TICKS),
    hoodGoal: new Float32Array(TICKS),
    deploy: new Float32Array(TICKS),
    deployGoal: new Float32Array(TICKS),
    shooter: new Float32Array(TICKS),
    shooterGoal: new Float32Array(TICKS),
    intake: new Float32Array(TICKS),
    conveyor: new Float32Array(TICKS),
    feeder: new Float32Array(TICKS),
    current: new Float32Array(TICKS),
    fuel: new Float32Array(TICKS),
    robotState: new Uint8Array(TICKS),
    hopperState: new Uint8Array(TICKS),
    deployPose: new Uint8Array(TICKS),
    aimMode: new Uint8Array(TICKS),
    aimState: new Uint8Array(TICKS),
    moduleAngle: new Float32Array(TICKS * 4),
    step: new Int16Array(TICKS),
    feedTarget: new Int8Array(TICKS),
    label: new Int16Array(TICKS),
    source: new Uint8Array(TICKS),
    phase: new Uint8Array(TICKS),
  };
  const labels = [];
  const labelIndex = new Map();
  const intern = (text) => {
    if (!labelIndex.has(text)) {
      labelIndex.set(text, labels.length);
      labels.push(text);
    }
    return labelIndex.get(text);
  };
  const feedTargets = [];
  const issues = [];
  const events = [];

  const w = {
    x: START_POSE[0],
    y: START_POSE[1],
    theta: START_POSE[2],
    omega: 0,
    hood: HOOD_STOP_DEG,
    hoodV: 0,
    deploy: DEPLOY_POSES.STOW,
    deployV: 0,
    shooter: 0,
    current: 0,
    fuel: HOPPER.preload,
    depot: DEPOT_FUEL,
    robotState: "IDLE",
    hopperState: "IDLE_STOWED",
    hopperSince: 0,
    emptyFor: 0,
    lastMode: null,
    lastTarget: null,
    aimState: "IDLE",
    lastAte: -Infinity,
    lastShooterGoal: null,
    lastHoodGoal: null,
    modules: [0, 0, 0, 0],
    shot: null,
  };
  let tick = 0;

  function describe(want, { auto, speed, hubNow, hopper }) {
    const prefix = auto ? "Auto: " : "";
    switch (w.robotState) {
      case "SCORE":
        if (hopper === "SCORE_AND_INTAKE") return `${prefix}Shooting while intaking`;
        return prefix + (speed > MOVING ? "Shooting on the move" : "Shooting from a stop");
      case "PREPARE_SCORE":
        if (w.aimState === "ALIGNING") return `${prefix}Auto-aligning to the hub`;
        if (!hubNow) return `${prefix}Aligned, waiting for the hub to turn active`;
        return `${prefix}Spinning up to shoot`;
      case "FEED":
        return prefix + (hopper === "FEED_AND_INTAKE" ? "Feeding FUEL to the alliance zone while intaking" : "Feeding FUEL to the alliance zone");
      case "PREPARE_FEED":
        return prefix + (w.aimState === "ALIGNING" ? "Lining up a feed to the alliance zone" : "Spinning up to feed");
      case "WARMUP_SCORE":
        return `${prefix}Full hopper, warming up the shooter`;
      default:
        if (hopper === "IDLE_DEPLOYED" && want.intake && w.fuel >= HOPPER.capacity - 1e-6) return `${prefix}Hopper full`;
        if ((want.score || want.feed) && w.fuel <= 0.5) return `${prefix}Hopper empty`;
        return prefix + (want.label || "Driving");
    }
  }

  /* One recorded tick: the robot at `motion`, doing what `want` asks; then everything moves on a tick. */
  function step(stepIndex, motion, want) {
    const t = tick * DT;
    const auto = t < AUTO_S;
    const speed = Math.hypot(motion.vx, motion.vy);
    R.x[tick] = motion.x;
    R.y[tick] = motion.y;
    R.vx[tick] = motion.vx;
    R.vy[tick] = motion.vy;
    R.theta[tick] = w.theta;
    R.omega[tick] = w.omega;
    R.step[tick] = stepIndex;

    /* ---- where the shooter should point, and where the robot is pointing it ---- */
    /* Lining up to shoot from a stop aims at the HUB itself: there is no motion to lead, only a robot
       coming to rest. */
    const lead = want.still ? 0 : 1;
    const hubAim = aimSolution(motion.x, motion.y, motion.vx * lead, motion.vy * lead, RED_HUB, scoreTimeOfFlightAt);
    const feedAim = want.feed ? aimSolution(motion.x, motion.y, motion.vx, motion.vy, want.feed, feedTimeOfFlightAt) : null;
    /* A shot under way keeps the shooter on the HUB until the last ball is out, whatever comes next. */
    let mode = w.robotState === "SCORE" ? "aim" : want.heading ?? (want.score ? "aim" : want.feed ? "feed" : motion.moving ? "travel" : "hold");
    if (mode === "feed" && !feedAim) mode = "hold";
    let target;
    if (mode === "aim") target = hubAim.heading;
    else if (mode === "feed") target = feedAim.heading;
    else if (mode === "travel") target = motion.dir;
    else if (mode === "reverse") target = motion.dir + Math.PI;
    else if (typeof mode === "number") target = mode;
    else target = w.lastMode === "hold" && w.lastTarget !== null ? w.lastTarget : w.theta;
    target = w.theta + wrap(target - w.theta);
    let feedForward = 0;
    if (w.lastMode === mode && w.lastTarget !== null) {
      feedForward = mode === "travel" || mode === "reverse" ? motion.turn : wrap(target - w.lastTarget) / DT;
    }
    w.lastMode = mode;
    w.lastTarget = target;
    const aiming = mode === "aim" || mode === "feed";
    const aim = mode === "feed" ? feedAim : hubAim;
    const aimErrorDeg = (wrap(w.theta - aim.heading) * 180) / Math.PI;
    R.aimMode[tick] = mode === "feed" ? 2 : mode === "aim" ? (want.still ? 3 : 1) : 0;
    if (want.feed) {
      let index = feedTargets.indexOf(want.feed);
      if (index < 0) index = feedTargets.push(want.feed) - 1;
      R.feedTarget[tick] = index;
    } else R.feedTarget[tick] = -1;

    const inZone = motion.x - backExtentX(w.theta) >= RED_ZONE_X;
    const hubNow = redHubActive(t);

    /* ---- the robot manager ---- */
    const scoreRps = scoreRpmAt(hubAim.distance) / 60;
    const scoreHood = scoreHoodDegAt(hubAim.distance);
    const feedRps = feedAim ? feedRpmAt(feedAim.distance) / 60 : 0;
    const feedHood = feedAim ? feedHoodDegAt(feedAim.distance) : HOOD_IDLE_DEG;
    const scoring = w.robotState === "SCORE";
    const feeding = w.robotState === "FEED";
    const scoreGates =
      mode === "aim" &&
      Math.abs(w.shooter - scoreRps) * 60 <= (scoring ? 300 : 50) &&
      Math.abs(w.hood - scoreHood) <= (scoring ? 3 : 1.5) &&
      Math.abs(aimErrorDeg) <= (scoring ? AIM_TO_KEEP_DEG : AIM_TO_SHOOT_DEG) &&
      inZone &&
      hubAim.distance >= 1.5 &&
      hubAim.distance <= 4.8 &&
      speed <= (want.still && !scoring ? 0.05 : SHOOT_MAX_SPEED) &&
      hubNow &&
      /* ...and still active when the ball arrives. */
      redHubActive(t + hubAim.tof + 0.3);
    const feedGates =
      mode === "feed" &&
      Math.abs(w.shooter - feedRps) * 60 <= (feeding ? 500 : 150) &&
      Math.abs(w.hood - feedHood) <= 5 &&
      Math.abs(aimErrorDeg) <= 5 &&
      !inZone &&
      speed <= 2.5;

    let next;
    if (scoring || feeding) {
      next = w.robotState;
      if (w.fuel <= 1e-6) {
        /* A tenth of a second more feeding than the FUEL needs, so an estimate that samples a frame or two
           late still sees the hopper run dry. */
        w.emptyFor += DT;
        if (w.emptyFor >= 0.1 - 1e-9) next = "IDLE";
      } else if (feeding && !want.feed) {
        /* A feed is only ever part of the hopper: it stops where the script stops asking. */
        next = "IDLE";
      } else if (!(scoring ? scoreGates && want.score : feedGates)) {
        issues.push(`${t.toFixed(2)} s: ${w.robotState} broke off with ${w.fuel.toFixed(1)} FUEL left`);
        next = scoring ? (want.score ? "PREPARE_SCORE" : "IDLE") : "PREPARE_FEED";
      }
    } else if (want.score && w.fuel > 0.5) next = scoreGates ? "SCORE" : "PREPARE_SCORE";
    else if (want.feed && w.fuel > 0.5) next = feedGates ? "FEED" : "PREPARE_FEED";
    else if (!auto && w.fuel >= HOPPER.capacity - 1e-6 && inZone && !want.intake) next = "WARMUP_SCORE";
    else next = "IDLE";

    if (next !== w.robotState) {
      if (w.shot) {
        events.push({ ...w.shot, end: t });
        w.shot = null;
      }
      if (next === "SCORE" || next === "FEED") {
        w.shot = { kind: next, start: t, fuel: w.fuel, from: [motion.x, motion.y], minDistance: Infinity, maxDistance: 0, minSpeed: Infinity };
      }
      w.robotState = next;
      w.emptyFor = 0;
    }
    if (w.shot) {
      const d = (w.shot.kind === "FEED" ? feedAim ?? hubAim : hubAim).distance;
      w.shot.minDistance = Math.min(w.shot.minDistance, d);
      w.shot.maxDistance = Math.max(w.shot.maxDistance, d);
      w.shot.minSpeed = Math.min(w.shot.minSpeed, speed);
    }

    /* ---- the hopper manager ---- */
    const full = w.fuel >= HOPPER.capacity - 1e-6;
    let hopper;
    if (w.robotState === "SCORE") hopper = want.intake ? "SCORE_AND_INTAKE" : "SCORE";
    else if (w.robotState === "FEED") hopper = want.intake ? "FEED_AND_INTAKE" : "FEED";
    else if (want.intake && !full) hopper = "INTAKING";
    else if (want.intake || want.deploy === "out") hopper = "IDLE_DEPLOYED";
    else hopper = "IDLE_STOWED";
    if (hopper !== w.hopperState) {
      w.hopperState = hopper;
      w.hopperSince = t;
    }
    const inState = t - w.hopperSince;
    let pose = "STOW";
    let intake = 0;
    let conveyor = 0;
    let feeder = 0;
    switch (hopper) {
      case "IDLE_DEPLOYED":
        pose = "INTAKE";
        /* Ball-filling: creep FUEL up to the shooter until the tower sensor sees it. */
        if (w.fuel > 0.5 && inState < 0.6) conveyor = feeder = VOLTS(1);
        break;
      case "INTAKING":
        pose = "INTAKE";
        intake = VOLTS(12);
        if (inState < 0.5) {
          conveyor = VOLTS(2);
          feeder = VOLTS(-1);
        } else conveyor = feeder = VOLTS(1);
        break;
      case "SCORE":
        pose = inState < COMPACTION_DELAY_S ? "SCORE_COMPACTION_WAITING" : "SCORE_COMPACTION";
        intake = inState < COMPACTION_DELAY_S ? VOLTS(5) : 0;
        conveyor = feeder = VOLTS(10);
        break;
      case "FEED":
        pose = inState < COMPACTION_DELAY_S ? "INTAKE" : "FEED_COMPACTION";
        intake = inState < COMPACTION_DELAY_S ? VOLTS(5) : 0;
        conveyor = feeder = VOLTS(10);
        break;
      case "SCORE_AND_INTAKE":
      case "FEED_AND_INTAKE":
        pose = "INTAKE";
        intake = VOLTS(12);
        conveyor = feeder = VOLTS(10);
        break;
      default:
        break;
    }
    const deployGoal = DEPLOY_POSES[pose];

    /* ---- the intake: eating only with its mouth in FUEL ---- */
    let eating = false;
    let fromDepot = false;
    /* Balls go into an intake that is driven into them, or that sits against them (the DEPOT). */
    const forward = motion.vx * Math.cos(w.theta) + motion.vy * Math.sin(w.theta);
    if (intake > 0.9 && w.deploy > 10.5 && !full && (speed < 0.2 || forward > 0.1)) {
      for (const p of mouth(motion.x, motion.y, w.theta, w.deploy)) {
        if (inBox(p, PILE)) eating = true;
        else if (inBox(p, DEPOT) && w.depot > 0.5) {
          eating = true;
          fromDepot = true;
        }
      }
    }
    const currentGoal = eating ? 33 + 5 * noise(t, 1) : intake > 0.9 ? 3 + 0.7 * noise(t, 2) : intake > 0 ? 1.6 + 0.3 * noise(t, 3) : 0;
    /* The load comes and goes with the balls in a few hundredths of a second; a stopped motor draws nothing. */
    w.current = intake > 0 ? w.current + (currentGoal - w.current) * (1 - Math.exp(-DT / 0.015)) : 0;

    /* ---- goals ---- */
    let shooterGoal = IDLE_RPM / 60;
    let hoodGoal = HOOD_IDLE_DEG;
    if (w.robotState === "WARMUP_SCORE") shooterGoal = scoreRps;
    else if (w.robotState === "PREPARE_SCORE" || w.robotState === "SCORE") {
      shooterGoal = scoreRps;
      hoodGoal = scoreHood;
    } else if (w.robotState === "PREPARE_FEED" || w.robotState === "FEED") {
      shooterGoal = feedRps;
      hoodGoal = feedHood;
    }

    /* ---- what the console reads ---- */
    R.hood[tick] = w.hood;
    R.hoodGoal[tick] = hoodGoal;
    R.deploy[tick] = w.deploy;
    R.deployGoal[tick] = deployGoal;
    R.shooter[tick] = w.shooter;
    R.shooterGoal[tick] = shooterGoal;
    R.intake[tick] = intake;
    R.conveyor[tick] = conveyor;
    R.feeder[tick] = feeder;
    R.current[tick] = w.current;
    R.fuel[tick] = w.fuel;
    R.robotState[tick] = ROBOT_STATES.indexOf(w.robotState);
    R.hopperState[tick] = HOPPER_STATES.indexOf(hopper);
    R.deployPose[tick] = DEPLOY_POSE_NAMES.indexOf(pose);
    const wasOnTarget = w.aimState === "ALIGNED" || w.aimState === "SOTF";
    const onTarget = Math.abs(aimErrorDeg) <= (wasOnTarget ? AIM_TO_KEEP_DEG : ALIGNED_DEG);
    const moving = speed > (w.aimState === "SOTF" ? MOVING * 0.6 : MOVING);
    const aimState = !aiming ? "IDLE" : !onTarget ? "ALIGNING" : moving ? "SOTF" : "ALIGNED";
    w.aimState = aimState;
    R.aimState[tick] = AIM_STATES.indexOf(aimState);
    R.source[tick] = SOURCES.indexOf(auto ? PLANNED : want.source ?? DRIVER);
    R.phase[tick] = auto ? 0 : PHASES.indexOf(want.phase ?? "DriverControl");
    R.label[tick] = intern(describe(want, { auto, speed, hubNow, hopper }));

    /* Where each module's wheel is pointed, kept within a quarter turn of where it was, the way a swerve
       module flips its drive direction rather than spinning its wheel half round. */
    const c = Math.cos(w.theta);
    const s = Math.sin(w.theta);
    const vxr = motion.vx * c + motion.vy * s;
    const vyr = -motion.vx * s + motion.vy * c;
    for (let m = 0; m < 4; m++) {
      const [mx, my] = ROBOT.modules[m];
      const ux = vxr - w.omega * my;
      const uy = vyr + w.omega * mx;
      if (Math.hypot(ux, uy) > 1e-3) {
        let angle = Math.atan2(uy, ux);
        if (Math.abs(wrap(angle - w.modules[m])) > Math.PI / 2) angle = wrap(angle + Math.PI);
        w.modules[m] = angle;
      }
      R.moduleAngle[tick * 4 + m] = w.modules[m];
    }

    /* ---- on to the next tick ---- */
    const launching = (hopper.startsWith("SCORE") || hopper.startsWith("FEED")) && w.shooter >= 8 && feeder > 0.3;
    if (eating) {
      w.lastAte = t;
      const before = w.fuel;
      w.fuel = Math.min(HOPPER.capacity, w.fuel + HOPPER.intakeRate * DT);
      if (fromDepot) w.depot = Math.max(0, w.depot - (w.fuel - before));
    }
    if (launching) w.fuel = Math.max(0, w.fuel - HOPPER.feedRate * DT);

    /* The flywheel winds up at what its current limit allows, settles on its setpoint, and sags a little
       under the load of the balls going through. A setpoint that moves smoothly - the distance changing as
       the robot drives - is fed forward, as a velocity loop's is; a step is not. */
    const smooth = (goal, last, step) => (last !== null && Math.abs(goal - last) < step ? (goal - last) / DT : 0);
    const shooterRate = smooth(shooterGoal, w.lastShooterGoal, 0.2);
    const hoodRate = smooth(hoodGoal, w.lastHoodGoal, 0.3);
    w.lastShooterGoal = shooterGoal;
    w.lastHoodGoal = hoodGoal;
    const wind = clamp((shooterGoal - w.shooter) / 0.12 + shooterRate, -25, 45) - (launching ? 6 : 0);
    w.shooter = Math.max(0, w.shooter + wind * DT);
    [w.hood, w.hoodV] = chase(w.hood, w.hoodV, hoodGoal, 90, 500, 15, hoodRate);
    [w.deploy, w.deployV] = chase(w.deploy, w.deployV, deployGoal, 20, 50, 12);
    /* Neither travels past its stops. */
    w.hood = clamp(w.hood, HOOD_STOP_DEG, 45);
    w.deploy = clamp(w.deploy, DEPLOY_POSES.STOW, DEPLOY_POSES.INTAKE);

    /* The modules' speed is shared between driving and turning. */
    const room = Math.max(0.6, (ROBOT.maxSpeed - speed) / MODULE_RADIUS);
    const e = wrap(target - w.theta);
    let toward;
    let accel;
    if (aiming) {
      /* Proportional, with the target's own motion fed forward: the error falls off at the same rate
         whatever it started at, so any swing onto the target takes about as long to settle. */
      const cap = Math.min(AIM.rate, room);
      const close = Math.sign(e) * Math.min(Math.abs(e) / AIM.tau, Math.sqrt(2 * AIM.accel * Math.abs(e)) * 0.9);
      toward = clamp(clamp(feedForward, -cap, cap) + close, -cap, cap);
      accel = AIM.accel;
    } else {
      /* Time-optimal: turn as fast as the drive allows, and brake so as to arrive without overshoot. */
      const cap = Math.min(TURN.rate, room);
      toward = clamp(
        clamp(feedForward, -cap, cap) + Math.sign(e) * Math.min(Math.sqrt(2 * TURN.accel * Math.abs(e)) * 0.95, TURN.gain * Math.abs(e)),
        -cap,
        cap,
      );
      accel = TURN.accel;
    }
    const omega = w.omega + clamp(toward - w.omega, -accel * DT, accel * DT);
    w.theta += ((w.omega + omega) / 2) * DT;
    w.omega = omega;
    tick++;
  }

  const legWants = (leg) => ({
    heading: leg.heading,
    deploy: leg.deploy ?? "in",
    intake: Boolean(leg.intake),
    score: Boolean(leg.score),
    still: Boolean(leg.still),
    feed: leg.feed ?? null,
    source: leg.source,
    phase: leg.phase,
    label: leg.label,
  });

  /* The script, a tick at a time. */
  function* play() {
    for (let index = 0; index < SCRIPT.length && tick < TICKS; index++) {
      const item = SCRIPT[index];
      if (item.drive) {
        const controls = [[w.x, w.y]];
        const starts = [];
        for (const leg of item.drive) {
          starts.push(controls.length === 1 ? 0 : controls.length);
          controls.push(...leg.points);
        }
        const uOf = (i) => (i <= 0 ? 0 : i >= controls.length - 1 ? controls.length + 1 : i + 1);
        const bounds = item.drive.map((leg, k) => [uOf(starts[k]), k + 1 < starts.length ? uOf(starts[k + 1]) : Infinity]);
        const caps = [];
        item.drive.forEach((leg, k) => {
          const speed = leg.speed ?? (leg.score ? SHOOT_SPEED : leg.feed ? FEED_SPEED : leg.intake ? INTAKE_SPEED : null);
          if (speed) caps.push({ from: bounds[k][0], to: bounds[k][1], speed });
        });
        const drive = makeDrive(controls, caps);
        const wants = item.drive.map(legWants);
        const start = tick;
        let leg = 0;
        for (;;) {
          const tau = (tick - start) * DT;
          const at = drive.at(tau);
          /* The spline parameter only ever grows along a drive, so the leg only ever moves on. */
          while (leg < bounds.length - 1 && at.u >= bounds[leg][1]) leg++;
          at.moving = true;
          step(index, at, wants[leg]);
          w.x = at.x;
          w.y = at.y;
          yield;
          if (tau >= drive.duration || tick >= TICKS) break;
        }
      } else {
        const want = { ...legWants(item), heading: item.heading };
        const at = { x: w.x, y: w.y, vx: 0, vy: 0, speed: 0, dir: w.theta, u: 0, turn: 0, moving: false };
        const start = tick;
        for (;;) {
          step(index, at, want);
          yield;
          const t = tick * DT;
          const elapsed = (tick - start) * DT;
          const done =
            (item.until !== undefined && t >= item.until) ||
            (item.seconds !== undefined && elapsed >= item.seconds) ||
            (item.empty && w.fuel <= 1e-6 && w.robotState === "IDLE") ||
            (item.downTo !== undefined && w.fuel <= item.downTo) ||
            /* Full, or nothing left in reach: the DEPOT holds 24. */
            (item.full && (w.fuel >= HOPPER.capacity - 1e-6 || (elapsed > 0.5 && t - w.lastAte > 0.4)));
          if (done || tick >= TICKS) break;
          if (elapsed > 40) {
            issues.push(`${t.toFixed(2)} s: hold ${index} (${item.label}) never finished`);
            break;
          }
        }
      }
    }
    /* Whatever of the match the script leaves: stay put, stowed. */
    const rest = { x: w.x, y: w.y, vx: 0, vy: 0, speed: 0, dir: w.theta, u: 0, turn: 0, moving: false };
    while (tick < TICKS) {
      step(SCRIPT.length, rest, legWants({ label: "Parked" }));
      yield;
    }
    if (w.shot) events.push({ ...w.shot, end: MATCH_S });
  }

  /* Played only as far as anyone has asked: the demo runs in real time, so the whole match is never
     recorded in one go on the frame demo mode starts. The same tick comes out the same however the
     recording got there. */
  const player = play();
  recording = {
    R,
    labels,
    issues,
    events,
    feedTargets,
    /** How many ticks have been recorded. */
    get recorded() {
      return tick;
    },
    through(last) {
      while (tick <= last && tick < TICKS) player.next();
      if (tick >= TICKS) player.next();
      return this;
    },
  };
  return recording;
}

/* How far past the tick being read the recording must reach, for the path band: longer than any leg. */
const LOOKAHEAD_TICKS = 30 * HZ;

/* ---------------------------------------------------------------- reading the recording */

/* Cubic Hermite between two samples a tick apart: the value and its rate, both continuous. */
function hermite(p0, v0, p1, v1, f) {
  const f2 = f * f;
  const f3 = f2 * f;
  const value = (2 * f3 - 3 * f2 + 1) * p0 + (f3 - 2 * f2 + f) * DT * v0 + (-2 * f3 + 3 * f2) * p1 + (f3 - f2) * DT * v1;
  const rate = ((6 * f2 - 6 * f) * p0 + (3 * f2 - 4 * f + 1) * DT * v0 + (6 * f - 6 * f2) * p1 + (3 * f2 - 2 * f) * DT * v1) / DT;
  return [value, rate];
}

/**
 * The red robot `t` seconds into the match (clamped to 0..MATCH_S):
 *
 *   t               the match time answered for, seconds
 *   pose            [x, y, heading]: metres from the blue origin, radians counter-clockwise from +x in
 *                   (-PI, PI]
 *   fieldVelocity   { vx, vy, omega }: m/s and rad/s, the pose's rates
 *   modules         [speed, angle] for FL, FR, BL, BR, flat: m/s and radians robot-relative, a
 *                   SwerveModuleState[] as /Catalyst/Swerve/ModuleStates carries it (a module drives
 *                   backwards rather than turn its wheel more than a quarter turn)
 *   mechanisms      the values 5805's robot publishes: hoodDeg, hoodGoalDeg (Hood.java's degrees),
 *                   deployInches, deployGoalInches (5 stowed, 11.8 out), deployPose, intakeSpeed,
 *                   conveyorSpeed, feederSpeed (-1..1, volts over 12), intakeCurrentAmps, shooterRps,
 *                   shooterGoalRps, robotState (RobotManager), hopperState (HopperManager), hopperFull,
 *                   and fuel: the FUEL held, which the console's estimate should agree with
 *   aim             { state: "IDLE" | "ALIGNING" | "ALIGNED" | "SOTF", target: [x, y] (the red HUB, or the
 *                   feed point while feeding), aimPoint: [x, y] (the target less the robot's velocity
 *                   over the time of flight), headingErrorDeg (the shooter's pointing error, signed),
 *                   distanceMeters (to the aim point), timeOfFlightSeconds, and turret mode's own three,
 *                   plausible only while state is SOTF: ready (boolean), speedCap (m/s, or NaN off the
 *                   governor), mode ("V8" | "8f9c640" | "stick") }
 *   path            { points: [x, y, heading, ...], source: "pathplanner" | "autopilot", phase } while
 *                   PathPlanner or an Autopilot has the robot, from the robot to the end of the leg;
 *                   null while the driver has it or it is standing still
 *   autopilotPhase  "Acquire" | "Score" | "DriverControl", for /Catalyst/Behavior/Cycle/Phase
 *   phase           what the robot is doing, in words
 */
export function demoMatch(t) {
  const at = clamp(Number.isFinite(t) ? t : 0, 0, MATCH_S);
  const i = Math.min(TICKS - 2, Math.floor(at * HZ + 1e-7));
  const recording = record().through(Math.min(TICKS - 1, i + LOOKAHEAD_TICKS));
  const { R, labels, feedTargets } = recording;
  const j = i + 1;
  const f = clamp(at * HZ - i, 0, 1);
  /* Discrete values belong to the tick at or before `t`. */
  const k = f >= 1 - 1e-9 ? j : i;
  const [x, vx] = hermite(R.x[i], R.vx[i], R.x[j], R.vx[j], f);
  const [y, vy] = hermite(R.y[i], R.vy[i], R.y[j], R.vy[j], f);
  const [theta, omega] = hermite(R.theta[i], R.omega[i], R.theta[j], R.omega[j], f);
  const heading = wrap(theta);
  const lerp = (a) => a[i] + (a[j] - a[i]) * f;

  const c = Math.cos(heading);
  const s = Math.sin(heading);
  const vxr = vx * c + vy * s;
  const vyr = -vx * s + vy * c;
  const modules = [];
  for (let m = 0; m < 4; m++) {
    const [mx, my] = ROBOT.modules[m];
    const ux = vxr - omega * my;
    const uy = vyr + omega * mx;
    const pointed = R.moduleAngle[k * 4 + m];
    let speed = Math.hypot(ux, uy);
    let angle = speed > 1e-3 ? Math.atan2(uy, ux) : pointed;
    if (Math.abs(wrap(angle - pointed)) > Math.PI / 2) {
      angle = wrap(angle + Math.PI);
      speed = -speed;
    }
    modules.push(speed, angle);
  }

  const fuel = lerp(R.fuel);
  const mechanisms = {
    hoodDeg: lerp(R.hood),
    hoodGoalDeg: R.hoodGoal[k],
    deployInches: lerp(R.deploy),
    deployGoalInches: R.deployGoal[k],
    deployPose: DEPLOY_POSE_NAMES[R.deployPose[k]],
    intakeSpeed: R.intake[k],
    conveyorSpeed: R.conveyor[k],
    feederSpeed: R.feeder[k],
    intakeCurrentAmps: Math.max(0, lerp(R.current)),
    shooterRps: lerp(R.shooter),
    shooterGoalRps: R.shooterGoal[k],
    robotState: ROBOT_STATES[R.robotState[k]],
    hopperState: HOPPER_STATES[R.hopperState[k]],
    hopperFull: R.fuel[k] >= HOPPER.capacity - 1e-6,
    fuel,
  };

  const feeding = R.aimMode[k] === 2 && R.feedTarget[k] >= 0;
  const target = feeding ? feedTargets[R.feedTarget[k]] : RED_HUB;
  const lead = R.aimMode[k] === 3 ? 0 : 1;
  const solution = aimSolution(x, y, vx * lead, vy * lead, target, feeding ? feedTimeOfFlightAt : scoreTimeOfFlightAt);
  const aimState = AIM_STATES[R.aimState[k]];
  const headingErrorDeg = (wrap(heading - solution.heading) * 180) / Math.PI;
  /* Turret mode's own three, demo data the same way the rest of this match is: plausible, not measured,
     and only while shooting on the move - a robot that is not in turret mode would not publish them
     either. Ready rides the same heading error the lock band already draws, on a tighter band, so it
     flips within a stretch rather than sitting on one value; the governor caps the translation only once
     the robot is going fast enough on the move to need it (1.2 m/s, the speed this file's own test already
     calls fast); and mode spends most of a stretch on the current controller, some on the one before it,
     and a few seconds of every 30 on "stick", so a demo left running shows the console's own fallback too. */
  const onTheMove = aimState === "SOTF";
  const modeBucket = Math.floor(at / 6) % 5;
  const aim = {
    state: aimState,
    target: [target[0], target[1]],
    aimPoint: solution.aimPoint,
    headingErrorDeg,
    distanceMeters: solution.distance,
    timeOfFlightSeconds: solution.tof,
    ready: onTheMove ? Math.abs(headingErrorDeg) <= 2 : false,
    speedCap: onTheMove && Math.hypot(vx, vy) >= 1.2 ? 2.4 : Number.NaN,
    mode: !onTheMove ? "" : modeBucket === 4 ? "stick" : modeBucket % 2 === 0 ? "V8" : "8f9c640",
  };

  const source = SOURCES[R.source[k]];
  const phaseName = PHASES[R.phase[k]];
  return {
    t: at,
    pose: [x, y, heading],
    fieldVelocity: { vx, vy, omega },
    modules,
    mechanisms,
    aim,
    path: pathAhead(R, k, [x, y, heading], recording.recorded),
    autopilotPhase: source === AUTOPILOT ? phaseName : "DriverControl",
    phase: labels[R.label[k]],
  };
}

/* The rest of the leg being driven, while PathPlanner or an Autopilot has the robot: the recording from
   here to where that leg ends, a point every 50 ms, starting at the robot itself. */
function pathAhead(R, k, pose, recorded) {
  const source = SOURCES[R.source[k]];
  if (source === DRIVER || !SCRIPT[R.step[k]]?.drive) return null;
  let end = k;
  while (end + 1 < recorded && R.step[end + 1] === R.step[k] && R.source[end + 1] === R.source[k] && R.phase[end + 1] === R.phase[k]) end++;
  if (end - k < 3) return null;
  const points = [pose[0], pose[1], pose[2]];
  for (let q = k + 5; q < end; q += 5) points.push(R.x[q], R.y[q], wrap(R.theta[q]));
  points.push(R.x[end], R.y[end], wrap(R.theta[end]));
  return { points, source, phase: source === PLANNED ? "Auto" : PHASES[R.phase[k]] };
}

/** What the script made of the match: every shot and feed as it happened ({ kind, start, end, fuel, from,
 *  minDistance, maxDistance, minSpeed }), and anything that did not go as written (none, for a sound
 *  script). */
export function demoMatchSummary() {
  const { events, issues } = record().through(TICKS - 1);
  return { events: events.map((e) => ({ ...e })), issues: [...issues] };
}
