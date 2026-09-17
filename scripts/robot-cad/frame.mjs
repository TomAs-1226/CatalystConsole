// The robot frame, found from the swerve modules.
//
// Output coordinates follow src/robot3d.js: x toward the robot's front, y up, z toward its right,
// metres, with the origin on the floor under the centre of the four modules. A WPILib (x, y) is (x, -z)
// here. Pure functions, no dependencies.

import { cross, dot, normalize, scale, sub, add, symmetricEigen } from "./geometry.mjs";

/**
 * Build the CAD→robot transform.
 *
 * `modules` are the swerve modules as the CAD places them: `steerPoint` (any point on the steering
 * axis), `wheelCenter` and `wheelRadius`. `up` is the CAD's up direction (the steering axes' common
 * direction, pointing away from the wheels). `forwardHint` is a CAD direction that points roughly
 * toward the robot's front, from evidence the caller weighs (where the intake deploys, where the
 * shooter fires); it is snapped to the nearer side of the module rectangle, because a robot's front is
 * square to its drivetrain.
 *
 * Returns `{ matrix, origin, up, forward, right, floor, centres, spacing }`, where `matrix` is a
 * column-major 4×4 taking CAD points to robot points, `centres` are the module centres on the floor in
 * CAD coordinates, and `spacing` is `{ along, across }`: the module spacing front-to-back and side-to-side.
 */
export function robotFrame({ modules, up, forwardHint }) {
  if (!modules || modules.length < 3) throw new Error("need at least three swerve modules to find the robot frame");
  const u = normalize(up);
  const floor = Math.min(...modules.map((m) => dot(m.wheelCenter, u) - m.wheelRadius));
  const centres = modules.map((m) => {
    const h = dot(m.steerPoint, u) - floor;
    return sub(m.steerPoint, scale(u, h));
  });
  const origin = scale(centres.reduce((acc, c) => add(acc, c), [0, 0, 0]), 1 / centres.length);

  /* The rectangle's sides: principal axes of the centres in the floor plane. */
  const helper = Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1 = normalize(cross(u, helper));
  const e2 = cross(u, e1);
  let sxx = 0, sxy = 0, syy = 0;
  for (const c of centres) {
    const d = sub(c, origin);
    const a = dot(d, e1), b = dot(d, e2);
    sxx += a * a; sxy += a * b; syy += b * b;
  }
  const eig = symmetricEigen([sxx, sxy, 0, syy, 0, 1e-12]).filter((p) => Math.abs(p.vector[2]) < 0.5);
  let sides = eig.map((p) => normalize(add(scale(e1, p.vector[0]), scale(e2, p.vector[1]))));
  /* A square layout has no preferred axes: fall back to the CAD axes that lie in the floor plane. */
  if (eig.length < 2 || Math.abs(eig[0].value - eig[1].value) < 1e-3 * Math.max(eig[0].value, eig[1].value)) {
    sides = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].filter((a) => Math.abs(dot(a, u)) < 0.5).map((a) => normalize(sub(a, scale(u, dot(a, u)))));
  }
  const hint = normalize(sub(forwardHint, scale(u, dot(forwardHint, u))));
  let forward = sides.reduce((best, s) => (Math.abs(dot(s, hint)) > Math.abs(dot(best, hint)) ? s : best), sides[0]);
  if (dot(forward, hint) < 0) forward = scale(forward, -1);
  forward = normalize(sub(forward, scale(u, dot(forward, u))));
  const right = normalize(cross(forward, u));

  /* p_robot = R (p_cad − origin), where the rows of R are the robot's axes in CAD coordinates and the
     origin already lies on the floor plane. */
  const matrix = [
    forward[0], u[0], right[0], 0,
    forward[1], u[1], right[1], 0,
    forward[2], u[2], right[2], 0,
    -dot(forward, origin), -dot(u, origin), -dot(right, origin), 1,
  ];
  const along = spread(centres, origin, forward);
  const across = spread(centres, origin, right);
  return { matrix, origin, up: u, forward, right, floor, centres, spacing: { along, across }, hintAgreement: dot(forward, hint) };
}

function spread(points, origin, axis) {
  const values = points.map((p) => dot(sub(p, origin), axis));
  return Math.max(...values) - Math.min(...values);
}

/** WPILib's name for a module at robot-frame (x, _, z): front/back by x, left/right by z (left is −z). */
export function moduleName([x, , z]) {
  return `${x >= 0 ? "f" : "b"}${z <= 0 ? "l" : "r"}`;
}

/** A robot-frame horizontal direction as a WPILib angle in degrees: 0 forward, positive toward the left. */
export function wpilibAngleDeg([x, , z]) {
  return (Math.atan2(-z, x) * 180) / Math.PI;
}

/** Order module records the way WPILib does: front-left, front-right, back-left, back-right. */
export function wpilibOrder(records) {
  const rank = { fl: 0, fr: 1, bl: 2, br: 3 };
  return [...records].sort((a, b) => rank[a.name] - rank[b.name]);
}
