import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ballAt,
  createHopper,
  fitKeep,
  hasMechanisms,
  isFeeding,
  isIntaking,
  launchAngleDeg,
  launchSpeed,
  PRELOAD_FUEL,
  readAim,
  readMechanisms,
  shooterReadiness,
  speedToReach,
} from "./mechanisms.js";

const near = (actual, expected, tolerance, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);

/** A fake read-only NetworkTables view over plain values. */
function view(values) {
  const get = (k) => values[k];
  return {
    num: (k, f = null) => (typeof get(k) === "number" ? get(k) : f),
    bool: (k, f = null) => (typeof get(k) === "boolean" ? get(k) : f),
    str: (k, f = null) => (typeof get(k) === "string" ? get(k) : f),
    arr: (k) => (Array.isArray(get(k)) ? get(k) : null),
  };
}

/* ---- reading ---- */

test("the mechanisms are read from the topics the robot publishes, in the views' units", () => {
  const m = readMechanisms(view({
    "/Catalyst/Hood/AngleDegrees": 24.5,
    "/Catalyst/Deploy/LengthInches": 11.8,
    "/Catalyst/Deploy/Homed": true,
    "/Catalyst/Intake/Speed": 1,
    "/Catalyst/ShooterMotor/Velocity": 3,
    "/Catalyst/Shooter/VelocityRPS": 26,
    "/Catalyst/HopperManager/State": "INTAKING",
    "/Catalyst/HopperManager/IsFull": false,
    "/Catalyst/Swerve/ModuleStates": [1.5, 0.2, 1.4, -0.1, 1.5, 0.2, 1.4, -0.1],
  }));
  assert.equal(m.hoodDeg, 24.5);
  near(m.deployM, 0.29972, 1e-9, "deploy in metres");
  assert.equal(m.intake.speed, 1);
  assert.equal(m.conveyor.speed, null);
  assert.equal(m.shooterRps, 26);
  assert.equal(m.hopperState, "INTAKING");
  assert.equal(m.modules.length, 4);
  assert.deepEqual(m.modules[1], { speed: 1.4, angle: -0.1 });
  assert.ok(hasMechanisms(m));
});

test("a deploy that has not homed has no length, and a robot with no mechanisms has nothing to animate", () => {
  const m = readMechanisms(view({ "/Catalyst/Deploy/LengthInches": 3, "/Catalyst/Deploy/Homed": false }));
  assert.equal(m.deployM, null);
  assert.equal(hasMechanisms(readMechanisms(view({}))), false);
});

/* ---- the hopper ---- */

const intaking = { hopperState: "INTAKING", intake: { speed: 1 }, feeder: { speed: 0 }, shooterRps: 12 };
const scoring = { hopperState: "SCORE", intake: { speed: 0.4 }, feeder: { speed: 0.8 }, shooterRps: 26 };
const idle = { hopperState: "IDLE_DEPLOYED", intake: { speed: 0 }, feeder: { speed: 0 }, shooterRps: 12 };

function run(hopper, m, seconds, fps) {
  let launched = 0;
  const frames = Math.round(seconds * fps);
  for (let i = 0; i < frames; i++) launched += hopper.step(1 / fps, m);
  return launched;
}

test("the longer the robot intakes, the fuller the hopper, up to what it holds", () => {
  const hopper = createHopper({ capacity: 40, intakeRate: 5 });
  assert.equal(hopper.fill, PRELOAD_FUEL);
  run(hopper, intaking, 2, 60);
  near(hopper.fill, PRELOAD_FUEL + 10, 1e-6, "after two seconds");
  run(hopper, intaking, 30, 60);
  assert.equal(hopper.fill, 40);
});

test("an intake running on open carpet takes nothing in; a loaded one does", () => {
  const hopper = createHopper({ capacity: 40, intakeRate: 5, preload: 0 });
  run(hopper, { ...intaking, intake: { speed: 1, currentAmps: 3 } }, 2, 60);
  assert.equal(hopper.fill, 0, "rollers spinning free");
  run(hopper, { ...intaking, intake: { speed: 1, currentAmps: 30 } }, 2, 60);
  near(hopper.fill, 10, 1e-6, "rollers eating FUEL");
});

test("the shooter is ready only at speed with a shot asked for, and says so while it shoots", () => {
  const at = (fields, options) => shooterReadiness({ shooterRps: 0, shooterGoalRps: 0, ...fields }, options);
  assert.equal(at({ shooterRps: null }), null, "no flywheel speed");
  assert.equal(at({}).state, "idle");
  assert.equal(at({ shooterRps: 12.4, shooterGoalRps: 12.5, robotState: "IDLE" }).state, "warm", "5805's warm idle");
  const spinning = at({ shooterRps: 30, shooterGoalRps: 41, robotState: "PREPARE_SCORE" });
  assert.deepEqual(spinning, { state: "spinning", ready: false });
  assert.deepEqual(at({ shooterRps: 40.4, shooterGoalRps: 41, robotState: "PREPARE_SCORE" }), { state: "ready", ready: true });
  assert.equal(at({ shooterRps: 30, shooterGoalRps: 41, shooterAtSpeed: true, robotState: "PREPARE_SCORE" }).state, "ready",
    "the robot's own at-speed flag wins");
  const shooting = { shooterRps: 41, shooterGoalRps: 41, feeder: { speed: 0.83 } };
  assert.deepEqual(at({ ...shooting, robotState: "SCORE", hopperState: "SCORE" }), { state: "shooting", ready: true });
  assert.equal(at({ ...shooting, robotState: "FEED", hopperState: "FEED" }).state, "feeding");
  assert.equal(at({ shooterRps: 20, shooterGoalRps: 0 }).state, "spindown");
  assert.deepEqual(at({ ...shooting, robotState: "SCORE" }, { enabled: false }), { state: "spindown", ready: false }, "disabled");
  assert.equal(at({}, { enabled: false }).state, "stopped");
});

test("the full sensor pins the estimate, and ejecting empties it", () => {
  const hopper = createHopper({ capacity: 40 });
  hopper.step(0.02, { ...idle, hopperFull: true });
  assert.equal(hopper.fill, 40);
  run(hopper, { hopperState: "EJECTING", intake: { speed: -1 } }, 100, 30);
  assert.equal(hopper.fill, 0);
});

test("shooting launches whole balls at the feed rate, whatever the frame rate", () => {
  for (const fps of [7, 60, 144]) {
    const hopper = createHopper({ capacity: 40, feedRate: 8, preload: 30 });
    assert.equal(run(hopper, scoring, 1, fps), 8, `at ${fps} fps`);
    near(hopper.fill, 22, 1e-9, `left at ${fps} fps`);
  }
});

test("nothing launches while the flywheel is not spinning or the robot is not feeding", () => {
  const hopper = createHopper({ preload: 20 });
  assert.equal(run(hopper, { ...scoring, shooterRps: 0 }, 2, 60), 0);
  assert.equal(run(hopper, idle, 2, 60), 0);
  assert.ok(!isFeeding(idle));
  assert.ok(isIntaking(intaking));
});

test("an empty hopper stops launching", () => {
  const hopper = createHopper({ preload: 3, feedRate: 10 });
  assert.equal(run(hopper, scoring, 2, 60), 3);
  assert.equal(hopper.fill, 0);
});

/* ---- the shot ---- */

// Team 5805's shot table (ShooterConfig DISTANCE_TO_SCORE_RPM) at the hood's default angle.
const TABLE = [[1.42, 1350], [2.79, 1560], [3.46, 1610], [4.92, 1900]];

test("the robot's own shot table is consistent with launching at the hood angle's complement", () => {
  const fit = fitKeep(TABLE, { hoodDeg: 30, exitHeightM: 0.5, targetHeightM: 1.83, wheelRadiusM: 0.0508 });
  assert.ok(fit, "every entry reachable");
  near(fit.keep, 0.81, 0.03, "share of surface speed kept");
  assert.ok(fit.spread < 0.03, `the entries agree, spread ${fit.spread}`);
  // Read as the launch angle itself, the nearest entry could not reach the opening at all.
  assert.equal(speedToReach(1.42, 30, 0.5, 1.83), null);
  assert.equal(launchAngleDeg(30), 60);
});

test("a ball launched at the speed to reach a target passes through it", () => {
  const v = speedToReach(3.46, 60, 0.5, 1.83);
  const theta = Math.PI / 3;
  const velocity = [v * Math.cos(theta), v * Math.sin(theta), 0];
  const t = 3.46 / velocity[0];
  const at = ballAt([0, 0.5, 0], velocity, t);
  near(at[0], 3.46, 1e-9, "x");
  near(at[1], 1.83, 1e-9, "height at the target");
  near(launchSpeed(1610 / 60, 0.0508, 1), 8.564, 1e-3, "surface speed at 1610 RPM");
});

/* ---- aiming ---- */

test("what the robot is aiming at is read only while it aims, with the lead point it shoots at", () => {
  assert.equal(readAim(view({})), null);
  assert.equal(readAim(view({ "/Catalyst/Aim/State": "IDLE", "/Catalyst/Aim/Target": [11.93, 4.03] })), null);
  const moving = readAim(view({
    "/Catalyst/Aim/State": "sotf",
    "/Catalyst/Aim/Target": [11.93, 4.03],
    "/Catalyst/Aim/AimPoint": [11.6, 4.4],
    "/Catalyst/Aim/HeadingErrorDeg": 1.2,
    "/Catalyst/Aim/DistanceMeters": 3.1,
  }));
  assert.equal(moving.state, "SOTF");
  assert.deepEqual(moving.aimPoint, [11.6, 4.4]);
  assert.equal(moving.distance, 3.1);
  const still = readAim(view({ "/Catalyst/Aim/State": "ALIGNING", "/Catalyst/Aim/Target": [11.93, 4.03] }));
  assert.deepEqual(still.aimPoint, [11.93, 4.03], "no lead published: aimed straight at the target");
  assert.equal(still.headingErrorDeg, null);
});
