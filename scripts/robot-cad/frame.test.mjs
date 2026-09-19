import { test } from "node:test";
import assert from "node:assert/strict";
import { transformPoint, transformDirection } from "./geometry.mjs";
import { moduleName, robotFrame, wpilibAngleDeg, wpilibOrder } from "./frame.mjs";

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

/* This robot's layout as Onshape exported it: Z up, the intake toward -Y, modules at ±0.2985 (x) and
   ±0.2794 (y), 4 in wheels. */
const cadModules = [[0.2985, -0.2794], [-0.2985, -0.2794], [0.2985, 0.2794], [-0.2985, 0.2794]].map(([x, y]) => ({
  steerPoint: [x, y, 0.1],
  wheelCenter: [x, y, 0.0508 + 0.002],
  wheelRadius: 0.0508,
}));

test("the frame puts the front where the evidence points, up along +y and the floor under the treads", () => {
  const frame = robotFrame({ modules: cadModules, up: [0, 0, 1], forwardHint: [0.05, -0.6, 0.1] });
  const f = transformDirection(frame.matrix, [0, -1, 0]);
  const u = transformDirection(frame.matrix, [0, 0, 1]);
  const r = transformDirection(frame.matrix, [-1, 0, 0]);
  [[f, [1, 0, 0]], [u, [0, 1, 0]], [r, [0, 0, 1]]].forEach(([got, want]) => got.forEach((v, k) => close(v, want[k], 1e-9)));
  const floor = transformPoint(frame.matrix, [0, 0, 0.002]);
  close(floor[1], 0, 1e-9);
  close(frame.spacing.along, 2 * 0.2794, 1e-9);
  close(frame.spacing.across, 2 * 0.2985, 1e-9);
});

test("the frame is right-handed: a CAD left-side part lands on -z", () => {
  const frame = robotFrame({ modules: cadModules, up: [0, 0, 1], forwardHint: [0, -1, 0] });
  const leftModule = transformPoint(frame.matrix, [0.2985, -0.2794, 0.1]);
  assert.equal(moduleName(leftModule), "fl");
  assert.equal(moduleName(transformPoint(frame.matrix, [-0.2985, 0.2794, 0.1])), "br");
});

test("a forward hint off the drivetrain's axes snaps to the nearer side", () => {
  const frame = robotFrame({ modules: cadModules, up: [0, 0, 1], forwardHint: [0.4, -0.5, 0] });
  close(frame.forward[1], -1, 1e-9);
});

test("the origin is the modules' centre even when the CAD is off centre", () => {
  const shifted = cadModules.map((m) => ({ ...m, steerPoint: [m.steerPoint[0] + 1, m.steerPoint[1] + 2, m.steerPoint[2]], wheelCenter: [m.wheelCenter[0] + 1, m.wheelCenter[1] + 2, m.wheelCenter[2]] }));
  const frame = robotFrame({ modules: shifted, up: [0, 0, 1], forwardHint: [0, -1, 0] });
  const centre = transformPoint(frame.matrix, [1, 2, 0.5]);
  close(centre[0], 0, 1e-9);
  close(centre[2], 0, 1e-9);
});

test("WPILib angles and order", () => {
  close(wpilibAngleDeg([1, 0, 0]), 0);
  close(wpilibAngleDeg([0, 0, -1]), 90);
  close(wpilibAngleDeg([0, 0, 1]), -90);
  assert.deepEqual(wpilibOrder([{ name: "br" }, { name: "fl" }, { name: "bl" }, { name: "fr" }]).map((m) => m.name), ["fl", "fr", "bl", "br"]);
});
