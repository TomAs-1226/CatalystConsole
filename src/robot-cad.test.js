import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cadSpec,
  hoodTurn,
  intakeMouth,
  intakeSlide,
  moduleStates,
  optimizeModule,
  rollerSpin,
  shooterExit,
  turnAbout,
} from "./robot-cad.js";

const near = (actual, expected, tolerance, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);

/* The parts of team 5805's manifest these functions read, as `npm run robot-cad` wrote them. */
const MANIFEST = {
  version: 1,
  bounds: { min: [-0.343, 0, -0.371], max: [0.348, 0.555, 0.371] },
  framePerimeter: { length: 0.6858, width: 0.7239 },
  bumpers: { length: 0.8509, width: 0.889, thickness: 0.0825, bottom: 0.019, height: 0.127 },
  modules: [
    { name: "fl", position: [0.2794, 0, -0.2985] },
    { name: "fr", position: [0.2794, 0, 0.2985] },
    { name: "bl", position: [-0.2794, 0, -0.2985] },
    { name: "br", position: [-0.2794, 0, 0.2985] },
  ],
  hood: { pivot: [-0.2858, 0.4826, 0], axis: [0, 0, 1], cadAngle: 11, stop: 11, min: 13, max: 45, physicalMax: 50.1 },
  intake: { axis: [0.9954, -0.0956, 0], origin: [0.0345, 0.3381, 0], travel: 0.2997, hardStop: 0.3023, restPosition: 0 },
  shooter: {
    exit: {
      point: [-0.1723, 0.5079, 0],
      direction: [-0.2174, 0.9761, 0],
      atHoodAngle: 11,
      elevationAt: { 13: 75.44, 30: 58.44, 45: 43.44 },
      width: 0.5525,
    },
  },
  intakeMouth: { center: [0.6192, 0.075, 0], atIntakeExtension: 0.2997 },
};

const elevation = ([x, y, z]) => (Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI;

test("the hood turns from its modelled pose by the difference in Hood.java's angle, within its travel", () => {
  near(hoodTurn(MANIFEST, 11), 0, 1e-12, "at the modelled pose");
  near(hoodTurn(MANIFEST, 30), (19 * Math.PI) / 180, 1e-12, "at 30");
  near(hoodTurn(MANIFEST, 90), ((50.1 - 11) * Math.PI) / 180, 1e-12, "held at the rack's end");
  near(hoodTurn(MANIFEST, -20), 0, 1e-12, "held at the stop");
  assert.equal(hoodTurn(MANIFEST, null), 0, "no reading, no turn");
});

test("the shot leaves at the elevations the CAD analysis measured for each hood angle", () => {
  for (const [hood, want] of Object.entries(MANIFEST.shooter.exit.elevationAt)) {
    near(elevation(shooterExit(MANIFEST, Number(hood)).direction), want, 0.05, `elevation at hood ${hood}`);
  }
  // The exit rides on the hood, so it stays at the same distance from the pivot as it swings.
  const pivot = MANIFEST.hood.pivot;
  const reach = (p) => Math.hypot(p[0] - pivot[0], p[1] - pivot[1], p[2] - pivot[2]);
  near(reach(shooterExit(MANIFEST, 45).point), reach(MANIFEST.shooter.exit.point), 1e-9, "exit radius");
});

test("the intake slides along its inclined rails by Deploy's length, and its mouth goes with it", () => {
  near(Math.hypot(...intakeSlide(MANIFEST, null)), 0, 1e-12, "no reading: where the CAD rests it");
  const out = intakeSlide(MANIFEST, 0.2997);
  near(Math.hypot(...out), 0.2997, 1e-4, "slide distance");
  assert.ok(out[1] < 0, "the rails run downhill as the intake comes out");
  near(Math.hypot(...intakeSlide(MANIFEST, 2)), 0.3023, 1e-4, "held at the hard stop");
  const mouthOut = intakeMouth(MANIFEST, 0.2997);
  assert.deepEqual(mouthOut, MANIFEST.intakeMouth.center);
  near(intakeMouth(MANIFEST, 0)[0], 0.6192 - 0.9954 * 0.2997, 1e-9, "mouth retracted");
});

test("rollers turn with what drives them, fast but never fast enough to strobe", () => {
  const shooting = { shooterRps: 26.7, feeder: { speed: 0.83 }, conveyor: { speed: 0.83 }, intake: { speed: 0.4 } };
  for (const role of ["shooter-flywheel", "feeder", "conveyor", "intake"]) {
    const spin = rollerSpin(role, shooting);
    assert.ok(spin > 1 && spin <= 4.5, `${role} spins at ${spin}`);
  }
  assert.ok(rollerSpin("shooter-flywheel", { shooterRps: 60 }) > rollerSpin("shooter-flywheel", { shooterRps: 12.5 }), "faster reads faster");
  assert.equal(rollerSpin("intake", { intake: { speed: 0 } }), 0);
  assert.ok(rollerSpin("intake", { intake: { speed: -1 } }) < 0, "ejecting turns them backwards");
});

test("module states follow the robot's motion: straight ahead, sideways, and turning on the spot", () => {
  const positions = cadSpec(MANIFEST).modules;
  for (const m of moduleStates(2, 0, 0, positions)) {
    near(m.speed, 2, 1e-9, "forward speed");
    near(m.angle, 0, 1e-9, "forward angle");
  }
  for (const m of moduleStates(0, 1, 0, positions)) near(m.angle, Math.PI / 2, 1e-9, "left");
  const spin = moduleStates(0, 0, 1, positions);
  // Turning on the spot, every module points square to the line to the centre, all at the same speed.
  for (let i = 0; i < 4; i++) {
    const [x, y] = positions[i];
    near(Math.cos(spin[i].angle) * x + Math.sin(spin[i].angle) * y, 0, 1e-9, "square to the radius");
    near(spin[i].speed, Math.hypot(x, y), 1e-9, "speed");
  }
  const still = moduleStates(0, 0, 0, positions, [0.3, 0.3, 0.3, 0.3]);
  assert.ok(still.every((m) => m.speed === 0 && m.angle === 0.3), "a still module keeps its heading");
});

test("a module never turns more than a quarter turn: it runs its wheel backwards instead", () => {
  const turned = optimizeModule(Math.PI, 0);
  near(turned.angle, 0, 1e-9);
  assert.equal(turned.flip, -1);
  const small = optimizeModule(0.4, 0.1);
  near(small.angle, 0.4, 1e-9);
  assert.equal(small.flip, 1);
});

test("the robot's size comes from the CAD, in WPILib's frame", () => {
  const spec = cadSpec(MANIFEST);
  assert.equal(spec.frameLength, 0.6858);
  assert.equal(spec.bumperWidth, 0.889);
  assert.deepEqual(spec.modules[0], [0.2794, 0.2985], "front left is to the left: +y");
  near(turnAbout([1, 0, 0], [0, 0, 0], [0, 1, 0], Math.PI / 2)[2], -1, 1e-12, "a quarter turn up +y takes +x to -z");
});
