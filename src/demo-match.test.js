import { test } from "node:test";
import assert from "node:assert/strict";

import {
  demoMatch,
  demoMatchSummary,
  HOPPER,
  MATCH_S,
  matchClock,
  RED_HUB,
  ROBOT,
  scoreHoodDegAt,
  scoreRpmAt,
  scoreTimeOfFlightAt,
  START_POSE,
} from "./demo-match.js";
import { AUTO_S, hubPlan } from "./hub.js";
import { createHopper, FEED_RATE } from "./mechanisms.js";

/* ---- the field, written out here rather than taken from demo-match.js ----
 *
 * From the 2026 field CAD's collision map (scripts/field-collision.mjs), so a wrong constant in the
 * script cannot pass its own test. WPILib field metres from the blue origin. The vendored map itself is
 * not read: CI has no vendor files. */

const FIELD = { x: [0, 16.54], y: [0, 8.07] };
const RED_ZONE_X = 12.58;
const HUB_CENTRES = [[4.61, 4.035], [11.93, 4.035]];
/* Everything the robot's outline may never overlap: both HUBS (1.2 m columns), the TRENCHES and their
   walls beside each HUB (a 560 mm bar this 650 mm robot cannot pass under), and both TOWERS. */
const SOLID = [
  { name: "blue HUB", x: [4.01, 5.21], y: [3.435, 4.635] },
  { name: "red HUB", x: [11.33, 12.53], y: [3.435, 4.635] },
  { name: "blue lower TRENCH", x: [3.96, 5.24], y: [0, 1.6] },
  { name: "blue upper TRENCH", x: [3.96, 5.24], y: [6.45, 8.07] },
  { name: "red lower TRENCH", x: [11.3, 12.58], y: [0, 1.6] },
  { name: "red upper TRENCH", x: [11.3, 12.58], y: [6.45, 8.07] },
  { name: "blue TOWER", x: [0, 1.15], y: [3.1, 4.35] },
  { name: "red TOWER", x: [15.4, 16.54], y: [3.7, 4.95] },
];
/* The BUMPS a robot drives over between the red alliance zone and the neutral zone. */
const RED_BUMP_X = [11.3, 12.58];
/* Where FUEL lies: the pile across midfield and the red DEPOT, the balls' own extent. */
const PILE = { x: [7.365, 9.195], y: [1.715, 6.335] };
const DEPOT = { x: [15.935, 16.545], y: [1.635, 2.545] };

const ROBOT_MANAGER_STATES = [
  "IDLE", "PREPARE_FORCE_SCORE", "FORCE_SCORE", "WARMUP_SCORE", "PREPARE_SCORE", "SCORE", "WARMUP_FEED",
  "PREPARE_FEED", "FEED", "PREPARE_FALLBACK_SCORE", "FALLBACK_SCORE", "PREPARE_FALLBACK_FEED", "FALLBACK_FEED", "UNJAM",
];
const HOPPER_MANAGER_STATES = [
  "IDLE_DEPLOYED", "IDLE_STOWED", "IDLE_SAFE_KICKER_STOW", "INTAKING", "EJECTING", "UNJAMMING", "SCORE",
  "SCORE_AND_INTAKE", "FEED", "FEED_AND_INTAKE",
];

/* ---- helpers ---- */

const wrap = (a) => a - 2 * Math.PI * Math.floor((a + Math.PI) / (2 * Math.PI));
const speedOf = (d) => Math.hypot(d.fieldVelocity.vx, d.fieldVelocity.vy);
const within = (v, [lo, hi]) => v >= lo && v <= hi;
const inBox = ([x, y], box) => within(x, box.x) && within(y, box.y);

/** The robot's outline from its CAD: bumpers, and the intake where it slides out past the front bumper. */
function outline(d) {
  const [x, y, theta] = d.pose;
  const front = Math.max(0.851 / 2, 0.344 + d.mechanisms.deployInches * 0.0254);
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return [[front, 0.4445], [-0.4255, 0.4445], [-0.4255, -0.4445], [front, -0.4445]].map(([u, v]) => [x + u * c - v * s, y + u * s + v * c]);
}

/** Whether a convex polygon overlaps an axis-aligned box: separating axes. */
function overlaps(polygon, box) {
  const xs = polygon.map((p) => p[0]);
  const ys = polygon.map((p) => p[1]);
  if (Math.max(...xs) <= box.x[0] || Math.min(...xs) >= box.x[1] || Math.max(...ys) <= box.y[0] || Math.min(...ys) >= box.y[1]) return false;
  const corners = [[box.x[0], box.y[0]], [box.x[1], box.y[0]], [box.x[1], box.y[1]], [box.x[0], box.y[1]]];
  for (let i = 0; i < polygon.length; i++) {
    const [ax, ay] = polygon[i];
    const [bx, by] = polygon[(i + 1) % polygon.length];
    const nx = by - ay;
    const ny = ax - bx;
    const own = polygon.map(([px, py]) => px * nx + py * ny);
    const other = corners.map(([px, py]) => px * nx + py * ny);
    if (Math.max(...own) <= Math.min(...other) || Math.max(...other) <= Math.min(...own)) return false;
  }
  return true;
}

/** Whether the red HUB scores at match time `t`, by hub.js with FMS naming red. */
function redHubActive(t) {
  if (t < AUTO_S) return true;
  return hubPlan({ t: MATCH_S - t, auto: false, enabled: true, side: "red", first: "red" }).active === true;
}

/* The whole match, sampled every 20 ms: the rate the checks below walk it at. */
const STEP = 0.02;
const samples = [];
for (let k = 0; k * STEP <= MATCH_S + 1e-9; k++) samples.push(demoMatch(Math.min(MATCH_S, k * STEP)));

/** Maximal runs of consecutive samples for which `keep` holds: [{ from, to }] in sample indices. */
function runs(keep) {
  const out = [];
  let from = -1;
  samples.forEach((d, i) => {
    if (keep(d) && from < 0) from = i;
    if (!keep(d) && from >= 0) {
      out.push({ from, to: i - 1 });
      from = -1;
    }
  });
  if (from >= 0) out.push({ from, to: samples.length - 1 });
  return out;
}

/* ---- the script ---- */

test("the script plays out as written, with no shot broken off and no hold left waiting", () => {
  assert.deepEqual(demoMatchSummary().issues, []);
});

test("the same moment of the match is always the same robot, whatever was asked for before it", async () => {
  const fresh = await import("./demo-match.js?another-copy");
  const times = [157.3, 3.21, 88.88, 55, 104.999, 20.005, 0, 160];
  for (const t of times) assert.deepEqual(fresh.demoMatch(t), demoMatch(t), `at ${t} s`);
});

test("the match clock counts down within each period and says whether the red hub is on", () => {
  assert.deepEqual(matchClock(5), { period: "auto", auto: true, enabled: true, timeLeft: 15, hubActive: true });
  assert.equal(matchClock(20).period, "teleop");
  assert.equal(matchClock(20).timeLeft, 140);
  assert.equal(matchClock(40).hubActive, false);
  assert.equal(matchClock(60).hubActive, true);
  assert.equal(matchClock(160).period, "post");
  assert.equal(matchClock(-1).enabled, false);
});

test("a time outside the match is the nearest end of it", () => {
  assert.deepEqual(demoMatch(-5), demoMatch(0));
  assert.deepEqual(demoMatch(500), demoMatch(MATCH_S));
});

/* ---- driving ---- */

test("the robot starts where the auto starts, with its shooter already on the hub", () => {
  const d = demoMatch(0);
  d.pose.forEach((v, i) => assert.ok(Math.abs(v - [START_POSE[0], START_POSE[1], wrap(START_POSE[2])][i]) < 1e-9));
  assert.ok(Math.abs(d.aim.headingErrorDeg) < 0.5, `aim error ${d.aim.headingErrorDeg}`);
  assert.ok(Math.min(...outline(d).map((p) => p[0])) > RED_ZONE_X);
  assert.equal(speedOf(d), 0);
});

test("the robot never jumps: every 5 ms its position, heading and speed move on no faster than a robot can", () => {
  let prev = demoMatch(0);
  for (let k = 1; k * 0.005 <= MATCH_S + 1e-9; k++) {
    const t = k * 0.005;
    const d = demoMatch(t);
    const moved = Math.hypot(d.pose[0] - prev.pose[0], d.pose[1] - prev.pose[1]);
    assert.ok(moved <= 4.0 * 0.005, `moved ${moved} m in 5 ms at ${t} s`);
    assert.ok(Math.abs(wrap(d.pose[2] - prev.pose[2])) <= 4.5 * 0.005, `turned too fast at ${t} s`);
    assert.ok(speedOf(d) <= 3.8 + 1e-9, `speed ${speedOf(d)} at ${t} s`);
    const accel = Math.hypot(d.fieldVelocity.vx - prev.fieldVelocity.vx, d.fieldVelocity.vy - prev.fieldVelocity.vy) / 0.005;
    assert.ok(accel <= 6, `acceleration ${accel} m/s^2 at ${t} s`);
    assert.ok(Math.abs(d.fieldVelocity.omega - prev.fieldVelocity.omega) / 0.005 <= 15, `angular acceleration at ${t} s`);
    prev = d;
  }
});

test("the field velocity is the rate the pose changes at", () => {
  for (let t = 0.013; t < MATCH_S; t += 0.137) {
    const d = demoMatch(t);
    const a = demoMatch(t - 0.0005);
    const b = demoMatch(t + 0.0005);
    const vx = (b.pose[0] - a.pose[0]) / 0.001;
    const vy = (b.pose[1] - a.pose[1]) / 0.001;
    const omega = wrap(b.pose[2] - a.pose[2]) / 0.001;
    assert.ok(Math.hypot(vx - d.fieldVelocity.vx, vy - d.fieldVelocity.vy) < 0.01, `velocity at ${t} s`);
    assert.ok(Math.abs(omega - d.fieldVelocity.omega) < 0.02, `omega at ${t} s`);
  }
});

test("the module states are the inverse kinematics of the robot-relative chassis speeds, in FL FR BL BR order", () => {
  assert.deepEqual(ROBOT.modules.map(([x, y]) => [Math.sign(x), Math.sign(y)]), [[1, 1], [1, -1], [-1, 1], [-1, -1]]);
  for (const d of samples) {
    assert.equal(d.modules.length, 8);
    const c = Math.cos(d.pose[2]);
    const s = Math.sin(d.pose[2]);
    const vx = d.fieldVelocity.vx * c + d.fieldVelocity.vy * s;
    const vy = -d.fieldVelocity.vx * s + d.fieldVelocity.vy * c;
    ROBOT.modules.forEach(([mx, my], i) => {
      const [speed, angle] = [d.modules[2 * i], d.modules[2 * i + 1]];
      assert.ok(Math.abs(angle) <= Math.PI + 1e-9);
      const ex = speed * Math.cos(angle) - (vx - d.fieldVelocity.omega * my);
      const ey = speed * Math.sin(angle) - (vy + d.fieldVelocity.omega * mx);
      assert.ok(Math.hypot(ex, ey) < 0.005, `module ${i} at ${d.t} s is off by ${Math.hypot(ex, ey)} m/s`);
    });
  }
});

test("a moving module turns its wheel at most a quarter turn between samples, flipping its drive direction instead", () => {
  let flips = 0;
  for (let i = 1; i < samples.length; i++) {
    for (let m = 0; m < 4; m++) {
      const [was, is] = [samples[i - 1].modules[2 * m], samples[i].modules[2 * m]];
      if (Math.abs(was) < 0.2 || Math.abs(is) < 0.2) continue;
      const turned = Math.abs(wrap(samples[i].modules[2 * m + 1] - samples[i - 1].modules[2 * m + 1]));
      assert.ok(turned <= Math.PI / 2 + 1e-6, `module ${m} swung ${turned} rad at ${samples[i].t} s`);
      if (Math.sign(was) !== Math.sign(is)) flips++;
    }
  }
  assert.equal(flips, 0, "a module reversed at speed");
  assert.ok(samples.some((d) => d.modules.some((v, i) => i % 2 === 0 && v < -0.5)), "no module ever drives in reverse");
});

test("the robot stays on the field and never touches a hub, a trench or a tower", () => {
  for (const d of samples) {
    const shape = outline(d);
    for (const [x, y] of shape) assert.ok(within(x, FIELD.x) && within(y, FIELD.y), `off the field at ${d.t} s`);
    for (const solid of SOLID) assert.ok(!overlaps(shape, solid), `into the ${solid.name} at ${d.t} s`);
    for (const [hx, hy] of HUB_CENTRES) assert.ok(Math.hypot(d.pose[0] - hx, d.pose[1] - hy) >= 1.35, `too close to a hub at ${d.t} s`);
  }
});

test("the robot crosses the bumps slowly, square to them, with its intake pulled in", () => {
  let crossings = 0;
  let wasOn = false;
  for (const d of samples) {
    const xs = outline(d).map((p) => p[0]);
    const on = Math.min(...xs) < RED_BUMP_X[1] && Math.max(...xs) > RED_BUMP_X[0];
    if (on) {
      assert.ok(speedOf(d) <= 1.55, `${speedOf(d)} m/s on a bump at ${d.t} s`);
      assert.ok(d.mechanisms.deployInches <= 6.5, `intake out on a bump at ${d.t} s`);
      const square = Math.min(Math.abs(wrap(d.pose[2])), Math.abs(wrap(d.pose[2] - Math.PI)));
      assert.ok(square <= (20 * Math.PI) / 180, `crossing at ${(square * 180) / Math.PI} degrees at ${d.t} s`);
    }
    if (on && !wasOn) crossings++;
    wasOn = on;
  }
  assert.ok(crossings >= 16, `only ${crossings} bump crossings`);
});

/* ---- shooting ---- */

test("it only shoots from inside the red alliance zone, 1.5 to 4.8 m from the hub, on target", () => {
  const shooting = samples.filter((d) => d.mechanisms.robotState === "SCORE");
  assert.ok(shooting.length > 500);
  for (const d of shooting) {
    assert.ok(Math.min(...outline(d).map((p) => p[0])) >= RED_ZONE_X, `shooting from outside the zone at ${d.t} s`);
    assert.ok(within(d.aim.distanceMeters, [1.5, 4.8]), `shooting from ${d.aim.distanceMeters} m at ${d.t} s`);
    assert.ok(d.aim.state === "ALIGNED" || d.aim.state === "SOTF", `shooting while ${d.aim.state} at ${d.t} s`);
    assert.deepEqual(d.aim.target, [...RED_HUB]);
  }
  for (const d of samples.filter((s) => s.aim.state === "ALIGNED" || s.aim.state === "SOTF")) {
    assert.ok(Math.abs(d.aim.headingErrorDeg) <= 4, `${d.aim.state} ${d.aim.headingErrorDeg} degrees off at ${d.t} s`);
  }
});

test("it never shoots while the red hub is inactive, nor so late that the FUEL lands after it turns off", () => {
  for (const d of samples.filter((s) => s.mechanisms.robotState === "SCORE")) {
    assert.ok(redHubActive(d.t), `SCORE during an inactive shift at ${d.t} s`);
    assert.ok(redHubActive(Math.min(MATCH_S, d.t + d.aim.timeOfFlightSeconds)), `FUEL lands in an inactive hub from ${d.t} s`);
  }
});

test("through shifts 1 and 3 it feeds the alliance zone, and is waiting on target the moment the hub comes back", () => {
  const fed = (from, to) => samples.some((d) => d.t >= from && d.t < to && d.mechanisms.robotState === "FEED");
  assert.ok(fed(30, 55), "no feeding in shift 1");
  assert.ok(fed(80, 105), "no feeding in shift 3");
  for (const shift of [55, 105]) {
    const before = demoMatch(shift - 0.01);
    assert.equal(before.mechanisms.robotState, "PREPARE_SCORE");
    assert.equal(before.aim.state, "ALIGNED");
    assert.ok(before.mechanisms.fuel >= 40, `only ${before.mechanisms.fuel} FUEL waiting for ${shift} s`);
    assert.equal(demoMatch(shift).mechanisms.robotState, "SCORE", `not shooting at ${shift} s`);
  }
});

test("auto shoots the preload on the move, crosses into the neutral zone, collects FUEL and shoots it on the move", () => {
  const auto = samples.filter((d) => d.t < AUTO_S);
  const preload = auto.find((d) => d.mechanisms.robotState === "SCORE");
  assert.ok(preload.t < 1.5 && speedOf(preload) > 1, "the preload is not shot on the move");
  const outThere = auto.findIndex((d) => d.pose[0] < 10.5);
  assert.ok(outThere > 0, "never reaches the neutral zone");
  const collected = auto.slice(outThere).findIndex((d) => d.mechanisms.intakeCurrentAmps > 20);
  assert.ok(collected > 0, "never collects FUEL in auto");
  const second = auto.slice(outThere + collected).find((d) => d.mechanisms.robotState === "SCORE");
  assert.ok(second && second.aim.state === "SOTF", "no second shot on the move in auto");
  assert.equal(new Set(auto.filter((d) => d.path).map((d) => d.path.source)).size, 1);
  assert.ok(auto.every((d) => d.path === null || d.path.source === "pathplanner"));
});

test("it swings onto the hub visibly before a shot, and shoots on the move with a visible lead", () => {
  const swings = runs((d) => d.aim.state === "ALIGNING" && d.aim.target[0] === RED_HUB[0]);
  assert.ok(swings.length >= 8, `only ${swings.length} swings`);
  for (const { from, to } of swings) {
    const seconds = (to - from + 1) * STEP;
    assert.ok(seconds <= 1.3, `aligning for ${seconds} s from ${samples[from].t} s`);
    if (Math.abs(samples[from].aim.headingErrorDeg) >= 20) assert.ok(seconds >= 0.5, `a ${samples[from].aim.headingErrorDeg} degree swing over in ${seconds} s at ${samples[from].t} s`);
  }
  const onTheMove = runs((d) => d.aim.state === "SOTF");
  assert.ok(onTheMove.length >= 6);
  for (const { from, to } of onTheMove) {
    const stretch = samples.slice(from, to + 1);
    assert.ok(stretch.length * STEP >= 2, `a ${stretch.length * STEP} s stretch at ${samples[from].t} s`);
    const fast = stretch.filter((d) => speedOf(d) >= 1.2).length / stretch.length;
    assert.ok(fast >= 0.75, `only ${Math.round(fast * 100)}% of the stretch at ${samples[from].t} s over 1.2 m/s`);
    const lead = Math.max(...stretch.map((d) => Math.hypot(d.aim.aimPoint[0] - d.aim.target[0], d.aim.aimPoint[1] - d.aim.target[1])));
    assert.ok(lead > 1, `lead of only ${lead} m at ${samples[from].t} s`);
  }
  const still = demoMatch(0);
  assert.deepEqual(still.aim.aimPoint, still.aim.target);
});

test("the aim point leads the hub by the robot's velocity over the time of flight", () => {
  for (const d of samples.filter((s) => s.aim.state === "SOTF" && s.mechanisms.robotState === "SCORE")) {
    const { vx, vy } = d.fieldVelocity;
    const t = d.aim.timeOfFlightSeconds;
    assert.ok(Math.abs(d.aim.aimPoint[0] - (d.aim.target[0] - vx * t)) < 1e-6);
    assert.ok(Math.abs(d.aim.aimPoint[1] - (d.aim.target[1] - vy * t)) < 1e-6);
    assert.ok(Math.abs(t - scoreTimeOfFlightAt(d.aim.distanceMeters)) < 0.02);
  }
});

/* ---- FUEL ---- */

/* The console's hopper estimate (mechanisms.js createHopper), fed what the demo publishes at `hz`, starting
   `offset` seconds late. FUEL counts in only while the intake's current says it is eating. */
function estimate(hz, offset) {
  const hopper = createHopper({ feedRate: FEED_RATE });
  const dt = 1 / hz;
  let worst = 0;
  for (let t = offset; t <= MATCH_S; t += dt) {
    const d = demoMatch(t);
    const m = d.mechanisms;
    const eating = m.intakeCurrentAmps > 15;
    const hopperState = eating ? m.hopperState : m.hopperState.replace("_AND_INTAKE", "").replace("INTAKING", "IDLE_DEPLOYED");
    hopper.step(dt, { hopperState, intake: { speed: m.intakeSpeed }, feeder: { speed: m.feederSpeed }, shooterRps: m.shooterRps, hopperFull: m.hopperFull });
    assert.ok(within(hopper.fill, [0, HOPPER.capacity]));
    worst = Math.max(worst, Math.abs(hopper.fill - m.fuel));
  }
  return worst;
}

test("the console's hopper estimate agrees with the FUEL the robot holds, however its frames fall", () => {
  /* The estimate launches whole balls on its own frames and the robot's count runs continuously, so
     they can differ by a ball or two after a feed stopped part-way, until a full or empty hopper puts
     them back together. */
  for (const [hz, offset] of [[20, 0], [20, 0.017], [20, 0.033], [60, 0], [10, 0.05]]) {
    const worst = estimate(hz, offset);
    assert.ok(worst <= 2, `estimate ${worst} balls off at ${hz} Hz from ${offset} s`);
  }
});

test("every shot into the hub, and every feed but a deliberate top-up, runs the console's estimate dry", () => {
  const hopper = createHopper({ feedRate: FEED_RATE });
  let wasShooting = false;
  let dryShots = 0;
  for (let t = 0; t <= MATCH_S; t += 0.05) {
    const m = demoMatch(t).mechanisms;
    const eating = m.intakeCurrentAmps > 15;
    const hopperState = eating ? m.hopperState : m.hopperState.replace("_AND_INTAKE", "").replace("INTAKING", "IDLE_DEPLOYED");
    hopper.step(0.05, { hopperState, intake: { speed: m.intakeSpeed }, feeder: { speed: m.feederSpeed }, shooterRps: m.shooterRps, hopperFull: m.hopperFull });
    const shooting = m.robotState === "SCORE";
    if (wasShooting && !shooting) {
      assert.equal(hopper.fill, 0, `the estimate still holds ${hopper.fill} after the shot ending at ${t} s`);
      dryShots++;
    }
    wasShooting = shooting;
  }
  assert.equal(dryShots, demoMatchSummary().events.filter((e) => e.kind === "SCORE").length);
});

test("the hopper never holds more than 50 or less than nothing, starts with the preload and says when it is full", () => {
  assert.equal(demoMatch(0).mechanisms.fuel, HOPPER.preload);
  for (const d of samples) {
    const m = d.mechanisms;
    assert.ok(within(m.fuel, [0, HOPPER.capacity]));
    assert.equal(m.hopperFull, m.fuel >= HOPPER.capacity - 1e-6, `hopperFull wrong at ${d.t} s`);
    if (m.hopperFull) assert.notEqual(m.hopperState, "INTAKING", `intaking into a full hopper at ${d.t} s`);
  }
  assert.ok(samples.some((d) => d.mechanisms.hopperFull));
});

test("a shot lasts as long as the FUEL it has to shoot, and never longer", () => {
  for (const { from, to } of runs((d) => d.mechanisms.robotState === "SCORE")) {
    const seconds = (to - from + 1) * STEP;
    const fuel = samples[from].mechanisms.fuel;
    assert.equal(samples[to].mechanisms.fuel, 0, `a shot from ${samples[from].t} s stops with FUEL left`);
    assert.ok(seconds * HOPPER.feedRate >= fuel - 0.5, `${fuel} FUEL cannot leave in ${seconds} s`);
    assert.ok(seconds * HOPPER.feedRate <= fuel + HOPPER.feedRate * 0.16, `SCORE runs ${seconds} s for ${fuel} FUEL`);
  }
});

test("the intake draws current only with its mouth in FUEL, and is running before it gets there", () => {
  /* The intake's mouth, 0.6 m wide at the front of the slide, is in FUEL. */
  const mouthInFuel = (d) => {
    const [x, y, theta] = d.pose;
    const reach = 0.344 + d.mechanisms.deployInches * 0.0254 - 0.06;
    for (let v = -0.3; v <= 0.3 + 1e-9; v += 0.05) {
      const p = [x + reach * Math.cos(theta) - v * Math.sin(theta), y + reach * Math.sin(theta) + v * Math.cos(theta)];
      if (inBox(p, PILE) || inBox(p, DEPOT)) return true;
    }
    return false;
  };
  for (const d of samples) {
    const m = d.mechanisms;
    if (m.intakeCurrentAmps <= 15) continue;
    assert.ok(m.hopperState.includes("INTAK"), `current with the intake not running at ${d.t} s`);
    assert.ok(m.deployInches > 10, `current with the intake in at ${d.t} s`);
    /* The motor's current takes a few hundredths of a second to fall once the mouth leaves the balls. */
    assert.ok([0, 0.02, 0.04].some((ago) => mouthInFuel(demoMatch(Math.max(0, d.t - ago)))), `eating over bare carpet at ${d.t} s`);
    assert.ok(m.intakeCurrentAmps <= 40);
  }
  const bare = samples.filter((d, i) => i > 5 && samples.slice(i - 5, i + 1).every((s) => s.mechanisms.hopperState === "INTAKING" && s.mechanisms.intakeCurrentAmps < 15));
  assert.ok(bare.length > 100);
  for (const d of bare) assert.ok(within(d.mechanisms.intakeCurrentAmps, [2, 4]), `${d.mechanisms.intakeCurrentAmps} A spinning free at ${d.t} s`);
  const meals = runs((d) => d.mechanisms.intakeCurrentAmps > 15);
  assert.ok(meals.length >= 10);
  const leadIns = meals.filter(({ from }) => from > 0 && samples[from - 1].mechanisms.hopperState === "INTAKING").length;
  assert.ok(leadIns / meals.length >= 0.8, "the intake does not start ahead of the FUEL");
});

test("the depot gives up its 24 FUEL once", () => {
  const atDepot = samples.filter((d) => d.mechanisms.intakeCurrentAmps > 15 && d.pose[0] > 15);
  assert.ok(atDepot.length > 0);
  const eaten = atDepot.length * STEP * HOPPER.intakeRate;
  assert.ok(within(eaten, [22, 25]), `${eaten} FUEL from the depot`);
});

/* ---- mechanisms ---- */

test("the mechanisms move with a lag, inside their travel, never jumping", () => {
  let prev = demoMatch(0).mechanisms;
  assert.equal(prev.shooterRps, 0);
  for (let t = 0.005; t <= MATCH_S; t += 0.005) {
    const m = demoMatch(t).mechanisms;
    assert.ok(within(m.hoodDeg, [11, 45]) && within(m.deployInches, [5 - 1e-6, 11.8 + 1e-6]) && within(m.shooterRps, [0, 45]));
    assert.ok(Math.abs(m.hoodDeg - prev.hoodDeg) <= 95 * 0.005, `hood jumps at ${t} s`);
    assert.ok(Math.abs(m.deployInches - prev.deployInches) <= 21 * 0.005, `intake jumps at ${t} s`);
    assert.ok(Math.abs(m.shooterRps - prev.shooterRps) <= 50 * 0.005, `flywheel jumps at ${t} s`);
    for (const roller of ["intakeSpeed", "conveyorSpeed", "feederSpeed"]) assert.ok(within(m[roller], [-1, 1]));
    prev = m;
  }
});

test("the flywheel idles warm, and is at its setpoint when a shot starts", () => {
  const idle = samples.filter((d) => d.t > 2 && d.mechanisms.robotState === "IDLE" && Math.abs(d.mechanisms.shooterRps - 12.5) < 0.1);
  assert.ok(idle.length > 1000);
  assert.ok(samples.filter((d) => d.mechanisms.robotState === "IDLE").every((d) => d.mechanisms.shooterGoalRps === 750 / 60));
  for (const { from } of runs((d) => d.mechanisms.robotState === "SCORE")) {
    const m = samples[from].mechanisms;
    assert.ok(Math.abs(m.shooterRps - m.shooterGoalRps) * 60 <= 60, `shot starts ${(m.shooterRps - m.shooterGoalRps) * 60} RPM off at ${samples[from].t} s`);
    assert.ok(Math.abs(m.hoodDeg - m.hoodGoalDeg) <= 2, `shot starts with the hood off at ${samples[from].t} s`);
  }
});

test("the states are the ones 5805's managers publish", () => {
  for (const d of samples) {
    assert.ok(ROBOT_MANAGER_STATES.includes(d.mechanisms.robotState), d.mechanisms.robotState);
    assert.ok(HOPPER_MANAGER_STATES.includes(d.mechanisms.hopperState), d.mechanisms.hopperState);
    assert.ok(["IDLE", "ALIGNING", "ALIGNED", "SOTF"].includes(d.aim.state));
    assert.ok(["Acquire", "Score", "DriverControl"].includes(d.autopilotPhase));
    assert.equal(typeof d.phase, "string");
  }
  const seen = new Set(samples.map((d) => d.mechanisms.hopperState));
  for (const state of ["IDLE_STOWED", "IDLE_DEPLOYED", "INTAKING", "SCORE", "FEED", "FEED_AND_INTAKE"]) assert.ok(seen.has(state), state);
});

/* ---- the path band ---- */

test("a planned or improvised path starts at the robot and runs on in steps a band can draw", () => {
  const withPath = samples.filter((d) => d.path);
  assert.ok(withPath.length > 1000);
  for (const d of withPath) {
    const p = d.path.points;
    assert.equal(p.length % 3, 0);
    assert.ok(p.length >= 6);
    assert.deepEqual(p.slice(0, 3), d.pose);
    for (let i = 3; i < p.length; i += 3) assert.ok(Math.hypot(p[i] - p[i - 3], p[i + 1] - p[i - 2]) <= 0.25, `gap in the path at ${d.t} s`);
    assert.ok(["pathplanner", "autopilot"].includes(d.path.source));
    if (d.path.source === "autopilot") assert.equal(d.path.phase, d.autopilotPhase);
  }
});

test("the path ahead is where the robot then drives", () => {
  for (const d of samples.filter((s, i) => s.path && i % 25 === 0)) {
    const p = d.path.points;
    const end = [p[p.length - 3], p[p.length - 2]];
    const later = samples.slice(samples.indexOf(d)).find((s) => Math.hypot(s.pose[0] - end[0], s.pose[1] - end[1]) < 0.05);
    assert.ok(later, `the robot never reaches the end of the path shown at ${d.t} s`);
  }
});

test("the driver has the robot through most of teleop, and the Autopilot drives some of its cycles", () => {
  const teleop = samples.filter((d) => d.t >= AUTO_S);
  const driver = teleop.filter((d) => d.autopilotPhase === "DriverControl").length / teleop.length;
  assert.ok(within(driver, [0.5, 0.95]), `driver has it ${Math.round(driver * 100)}% of teleop`);
  const phases = new Set(teleop.map((d) => d.autopilotPhase));
  assert.ok(phases.has("Acquire") && phases.has("Score"));
  assert.ok(teleop.every((d) => d.path === null || d.path.source === "autopilot"));
});

/* ---- the end ---- */

test("it finishes empty, stopped and parked by the tower", () => {
  const d = demoMatch(MATCH_S);
  assert.equal(speedOf(d), 0);
  assert.equal(d.mechanisms.fuel, 0);
  assert.ok(Math.hypot(d.pose[0] - 14.35, d.pose[1] - 4.03) < 0.05);
  assert.ok(samples.some((s) => s.t > 150 && s.mechanisms.robotState === "SCORE"));
});

/* ---- tables ---- */

test("the shot tables are 5805's, clamped at their ends, and the hood rises smoothly with distance", () => {
  assert.equal(scoreRpmAt(1.42), 1350);
  assert.equal(scoreRpmAt(3.46), 1610);
  assert.equal(scoreRpmAt(1), 1350);
  assert.equal(scoreRpmAt(9), 1900);
  assert.equal(scoreTimeOfFlightAt(2.42), 1.233);
  let prev = scoreHoodDegAt(1.3);
  for (let d = 1.35; d <= 5; d += 0.05) {
    const hood = scoreHoodDegAt(d);
    assert.ok(hood >= prev - 1e-9 && hood - prev < 0.5, `hood at ${d} m`);
    prev = hood;
  }
  assert.ok(within(scoreHoodDegAt(1.42), [13, 20]) && within(scoreHoodDegAt(4.92), [30, 40]));
});
