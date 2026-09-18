import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ballAt,
  createAimDebounce,
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

/* ---- steadying the aim ---- */

const HUB = [11.91, 4.03];
const aimAt = (state, target = HUB, more = {}) => ({
  state, target, aimPoint: target, headingErrorDeg: null, distance: 2, timeOfFlight: null, ...more,
});

test("a new aim shows at once, and the aim going null is bridged until it has been null for dropMs", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  assert.equal(d.next(null, 0), null, "nothing to bridge before the first aim");
  const first = aimAt("ALIGNED");
  assert.equal(d.next(first, 100), first);
  assert.equal(d.next(null, 200), first);
  assert.equal(d.next(null, 799), first, "599 ms of null is still a flicker");
  assert.equal(d.next(null, 800), null, "600 ms of null is the aim ending");
  assert.equal(d.next(null, 900), null);
  const again = aimAt("ALIGNING");
  assert.equal(d.next(again, 1000), again, "an aim after one has ended is new, and shows at once");
});

test("each gap in the aim is timed from its own start", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("SOTF"), 0);
  d.next(null, 100);
  assert.equal(d.next(null, 650)?.state, "SOTF");
  assert.equal(d.next(aimAt("SOTF"), 690)?.state, "SOTF");
  assert.equal(d.next(null, 700)?.state, "SOTF");
  assert.equal(d.next(null, 1299)?.state, "SOTF", "the first gap's 550 ms do not count against the second");
  assert.equal(d.next(null, 1300), null);
});

test("a lock falling back to ALIGNING stays locked until ALIGNING has lasted unlockMs, with the latest numbers", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("ALIGNED", HUB, { distance: 2 }), 0);
  const held = d.next(aimAt("ALIGNING", [11.95, 4.0], { distance: 2.4, headingErrorDeg: 3.5 }), 100);
  assert.equal(held.state, "ALIGNED");
  assert.deepEqual(held.target, [11.95, 4.0], "the target is the latest");
  assert.equal(held.distance, 2.4, "and so are the numbers");
  assert.equal(held.headingErrorDeg, 3.5);
  assert.equal(d.next(aimAt("ALIGNING"), 449).state, "ALIGNED");
  assert.equal(d.next(aimAt("ALIGNING"), 450).state, "ALIGNING", "350 ms of ALIGNING is the lock lost");
  assert.equal(d.next(null, 500).state, "ALIGNING", "and a gap after that bridges what was last drawn");
});

test("a lock that comes back inside the grace never showed as lost, and the next loss is timed afresh", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("SOTF"), 0);
  assert.equal(d.next(aimAt("ALIGNING"), 100).state, "SOTF");
  assert.equal(d.next(aimAt("SOTF"), 300).state, "SOTF", "re-locked");
  assert.equal(d.next(aimAt("ALIGNING"), 400).state, "SOTF");
  assert.equal(d.next(aimAt("ALIGNING"), 749).state, "SOTF", "349 ms since this loss, not 649 since the first");
  assert.equal(d.next(aimAt("ALIGNING"), 750).state, "ALIGNING");
  assert.equal(d.next(aimAt("ALIGNED"), 760).state, "ALIGNED", "a lock is good news, and shows at once");
});

test("a moment of null inside an unlock does not reset it: the gap is ignored, not a fresh start", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("ALIGNED"), 0);
  d.next(aimAt("ALIGNING"), 100);
  assert.equal(d.next(null, 200).state, "ALIGNED");
  assert.equal(d.next(aimAt("ALIGNING"), 450).state, "ALIGNING");
});

test("SOTF and ALIGNED trading places near the speed threshold shows neither flip, and a settled switch does", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("ALIGNED"), 0);
  /* The robot's speed wandering either side of 0.25 m/s: a state change every 200 ms, for two seconds. */
  for (let t = 50; t <= 2000; t += 50) {
    const robot = Math.floor(t / 200) % 2 === 0 ? "ALIGNED" : "SOTF";
    assert.equal(d.next(aimAt(robot), t).state, "ALIGNED", `at ${t} ms, with the robot saying ${robot}`);
  }
  d.next(aimAt("SOTF"), 2100);
  assert.equal(d.next(aimAt("SOTF"), 2449).state, "ALIGNED");
  assert.equal(d.next(aimAt("SOTF"), 2450).state, "SOTF", "SOTF held 350 ms shows");
  assert.equal(d.next(aimAt("ALIGNED"), 2500).state, "SOTF", "and the way back is held the same");
  assert.equal(d.next(aimAt("ALIGNED"), 2850).state, "ALIGNED");
});

test("a new target shows at once, state and all, while the same target wandering a little does not", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("ALIGNED"), 0);
  assert.equal(d.next(aimAt("ALIGNING", [HUB[0] + 0.2, HUB[1]]), 100).state, "ALIGNED", "0.2 m is the same target");
  const other = aimAt("ALIGNING", [4.63, 4.03]);
  assert.equal(d.next(other, 150), other, "the other HUB is a new aim");
  assert.equal(d.next(null, 200), other);
  const place = aimAt("ALIGNED", [2.0, 6.5]);
  assert.equal(d.next(place, 300), place, "and a new target ends a gap at once");
});

test("reset forgets the aim, so a robot that is disabled shows none from that moment", () => {
  const d = createAimDebounce({ dropMs: 600, unlockMs: 350 });
  d.next(aimAt("ALIGNED"), 0);
  d.next(aimAt("ALIGNING"), 100);
  d.reset();
  assert.equal(d.next(null, 110), null);
  const fresh = aimAt("ALIGNING");
  assert.equal(d.next(fresh, 120), fresh, "and the next aim starts clean, not held to the old lock");
});
