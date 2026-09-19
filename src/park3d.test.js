import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ELEVATION_DEFAULT,
  ELEVATION_MAX,
  ELEVATION_MIN,
  IDLE_AFTER_MS,
  IDLE_RATE,
  RELEASE_WINDOW_MS,
  SPIN_MAX,
  bumperNumber,
  cubicBezier,
  clampElevation,
  closest,
  coastAngle,
  dampVelocity,
  fitDistance,
  flightEase,
  glideShots,
  idleSpin,
  layoutCallouts,
  mixShots,
  normalizeRobot,
  releaseVelocity,
  silhouette,
  turnY,
} from "./park3d.js";

// What is pinned down here is how the park view feels under a hand, not how it looks. The look is
// judged by eye; the feel is arithmetic, and arithmetic that drifts shows up as a stage that coasts
// further on a slow laptop, lurches when the idle turn starts, or flicks off on a finger that had
// already stopped. None of it needs a GPU, so none of it is tested through one.

const near = (actual, expected, tolerance, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);

/** A drag at a constant `pxPerSecond`, sampled every `every` ms for `ms`, starting at t = 0, x = 0. */
const steady = (pxPerSecond, ms, every = 16) => {
  const samples = [];
  for (let t = 0; t <= ms; t += every) samples.push({ t, x: (pxPerSecond * t) / 1000 });
  return samples;
};

// --- the coast ---------------------------------------------------------------

test("one 60 Hz frame of coasting keeps 92 percent of the speed", () => {
  near(dampVelocity(10, 1 / 60), 9.2, 1e-9);
});

test("a coast decays the same however the time is sliced", () => {
  // The view draws at 30 fps and the laptop is also running the Driver Station, so frames arrive
  // unevenly. Thirty small steps and one large one have to land on the same speed.
  let sliced = 5;
  for (let i = 0; i < 30; i++) sliced = dampVelocity(sliced, 0.5 / 30);
  near(sliced, dampVelocity(5, 0.5), 1e-9);
  near(dampVelocity(1, 1 / 30), 0.92 * 0.92, 1e-12);
});

test("decay slows a spin without ever reversing or growing it", () => {
  for (const v of [-6, -0.5, 0.5, 6]) {
    const next = dampVelocity(v, 0.2);
    assert.equal(Math.sign(next), Math.sign(v));
    assert.ok(Math.abs(next) < Math.abs(v));
  }
});

test("no time passing changes nothing, and a broken velocity stops the stage", () => {
  assert.equal(dampVelocity(3, 0), 3);
  assert.equal(dampVelocity(3, -1), 3);
  // A NaN spin would put NaN into the stage's rotation, and a NaN matrix draws nothing at all.
  assert.equal(dampVelocity(NaN, 0.1), 0);
  assert.equal(dampVelocity(Infinity, 0.1), 0);
});

test("a caller's own decay rate is honoured", () => {
  near(dampVelocity(1, 1 / 60, 0.5), 0.5, 1e-12);
});

test("the distance a flick coasts does not depend on the frame rate", () => {
  // The half dampVelocity alone does not give. Stepping the angle by v * dt overshoots by an amount
  // that grows with the frame length, so the same flick would turn the robot further at 30 fps.
  const coast = (fps) => {
    let v = 4;
    let angle = 0;
    for (let i = 0; i < fps * 3; i++) {
      angle += coastAngle(v, 1 / fps);
      v = dampVelocity(v, 1 / fps);
    }
    return angle;
  };
  near(coast(30), coast(144), 1e-9);
  near(coast(30), 4 / (-60 * Math.log(0.92)), 1e-3, "the whole coast, integrated");
});

test("coasting with no damping is plain constant speed, and nonsense goes nowhere", () => {
  near(coastAngle(2, 0.5, 1), 1, 1e-12);
  assert.equal(coastAngle(2, 0), 0);
  assert.equal(coastAngle(NaN, 0.1), 0);
});

// --- elevation ---------------------------------------------------------------

test("the camera is held above the floor and well short of overhead", () => {
  assert.ok(ELEVATION_MIN > 0, "at or below zero the lens is level with the floor or under it");
  assert.ok(ELEVATION_MAX < Math.PI / 2 - 0.2, "straight down, a sideways drag spins the picture in place");
  assert.ok(ELEVATION_DEFAULT > ELEVATION_MIN && ELEVATION_DEFAULT < ELEVATION_MAX);
});

test("an elevation inside the range passes through untouched", () => {
  assert.equal(clampElevation(0.5), 0.5);
  assert.equal(clampElevation(ELEVATION_MIN), ELEVATION_MIN);
  assert.equal(clampElevation(ELEVATION_MAX), ELEVATION_MAX);
});

test("dragging past either end holds at that end", () => {
  assert.equal(clampElevation(-1), ELEVATION_MIN);
  assert.equal(clampElevation(Math.PI / 2), ELEVATION_MAX);
  assert.equal(clampElevation(-Infinity), ELEVATION_MIN);
  assert.equal(clampElevation(Infinity), ELEVATION_MAX);
});

test("garbage puts the camera back at the default angle rather than breaking the view", () => {
  assert.equal(clampElevation(NaN), ELEVATION_DEFAULT);
  assert.equal(clampElevation(undefined), ELEVATION_DEFAULT);
});

// --- release velocity --------------------------------------------------------

test("no drag, or a tap, has no speed", () => {
  assert.equal(releaseVelocity([]), 0);
  assert.equal(releaseVelocity(undefined), 0);
  assert.equal(releaseVelocity([{ t: 0, x: 100 }]), 0);
  assert.equal(releaseVelocity([{ t: 0, x: 100 }, { t: 90, x: 100 }]), 0);
});

/* A milliradian per pixel keeps every speed below in the tests well under SPIN_MAX, so a reading in
   rad/s is the pointer's px/s divided by a thousand. */
const MRAD = 0.001;

test("a steady drag is measured at its own speed, in the units asked for", () => {
  const samples = steady(600, 200);
  near(releaseVelocity(samples, MRAD), 0.6, 1e-9);
  near(releaseVelocity(samples, 0.005), 3, 1e-9);
});

test("the speed is signed the way the pointer moved", () => {
  assert.ok(releaseVelocity(steady(400, 200), 1) > 0);
  assert.ok(releaseVelocity(steady(-400, 200), 1) < 0);
});

test("a swipe that stopped and was held before letting go does not coast", () => {
  const samples = steady(3000, 300);
  const end = samples.at(-1);
  for (let t = end.t + 16; t <= end.t + 160; t += 16) samples.push({ t, x: end.x });
  assert.equal(releaseVelocity(samples, 1), 0);
});

test("a finger that rested without moving events, then lifted, measures zero", () => {
  // A resting finger sends no pointermove at all. The pause is visible only in the time of the
  // release sample, which sits exactly where the last move left the pointer.
  const samples = steady(2000, 150);
  const end = samples.at(-1);
  samples.push({ t: end.t + 400, x: end.x });
  assert.equal(releaseVelocity(samples, 1), 0);
});

test("a flick that sped up at the end is read at its end speed, not its average", () => {
  const samples = [];
  for (let t = 0; t <= 300; t += 10) samples.push({ t, x: t < 200 ? 0.1 * t : 20 + (t - 200) });
  near(releaseVelocity(samples, MRAD), 1, 1e-9, "1000 px/s at the end, 100 px/s before it");
});

test("sparse events on a slow machine still carry a flick", () => {
  // Two events 120 ms apart: the window holds only the last one, and the sample before it is what
  // lets the measurement span the window at all.
  near(releaseVelocity([{ t: 0, x: 0 }, { t: 120, x: 60 }], MRAD), 0.5, 1e-9);
});

test("samples sharing one timestamp do not divide by zero", () => {
  assert.equal(releaseVelocity([{ t: 5, x: 0 }, { t: 5, x: 40 }], 1), 0);
});

test("a wild flick is capped in both directions", () => {
  assert.equal(releaseVelocity(steady(1e6, 100), 1), SPIN_MAX);
  assert.equal(releaseVelocity(steady(-1e6, 100), 1), -SPIN_MAX);
});

test("the window is about the last eighty milliseconds", () => {
  assert.ok(RELEASE_WINDOW_MS >= 60 && RELEASE_WINDOW_MS <= 100);
});

// --- the idle turn -----------------------------------------------------------

test("the stage stays still until the idle delay has passed", () => {
  assert.equal(idleSpin(0), 0);
  assert.equal(idleSpin(IDLE_AFTER_MS - 1), 0);
  // At the threshold itself the turn starts from rest. Starting at cruising speed is the jolt this
  // exists to avoid.
  assert.equal(idleSpin(IDLE_AFTER_MS), 0);
});

test("the delay is about six seconds and the turn six to eight degrees a second", () => {
  assert.ok(IDLE_AFTER_MS >= 5000 && IDLE_AFTER_MS <= 7000);
  const degrees = (IDLE_RATE * 180) / Math.PI;
  assert.ok(degrees >= 6 && degrees <= 8, `${degrees} deg/s`);
});

test("the turn eases in from rest and settles at its cruising speed", () => {
  let previous = 0;
  for (let ms = IDLE_AFTER_MS; ms <= IDLE_AFTER_MS + 5000; ms += 50) {
    const speed = idleSpin(ms);
    assert.ok(speed >= previous, `the turn slowed down at ${ms} ms`);
    assert.ok(speed <= IDLE_RATE + 1e-12, `the turn overshot at ${ms} ms`);
    previous = speed;
  }
  assert.ok(idleSpin(IDLE_AFTER_MS + 100) < IDLE_RATE * 0.05, "a tenth of a second in it is barely moving");
  assert.equal(idleSpin(IDLE_AFTER_MS + 4000), IDLE_RATE);
  assert.equal(idleSpin(IDLE_AFTER_MS + 3_600_000), IDLE_RATE);
});

test("reduced motion never turns the stage", () => {
  for (const ms of [0, IDLE_AFTER_MS, IDLE_AFTER_MS + 1000, 1e9]) assert.equal(idleSpin(ms, true), 0);
});

test("a nonsense idle time does not turn the stage", () => {
  assert.equal(idleSpin(NaN), 0);
  assert.equal(idleSpin(-5), 0);
  assert.equal(idleSpin(undefined), 0);
});

// --- framing -----------------------------------------------------------------

const FOV = (30 * Math.PI) / 180;
/** The default robot's framing parts, near enough: a wide low base and a narrow tall superstructure. */
const ROBOT = [
  { radius: 0.6, bottom: 0, top: 0.21 },
  { radius: 0.25, bottom: 0, top: 0.52 },
];
const LOOK = 0.26;

test("on a wide canvas the robot fills the asked share of the height", () => {
  const d = fitDistance(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9, 0.6, 0.8);
  const seen = silhouette(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9, d);
  near(seen.vertical, 0.6, 1e-6);
  assert.ok(seen.side < 0.8);
});

test("on a narrow canvas the width decides, so the bumpers are never cropped", () => {
  const d = fitDistance(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 0.5, 0.6, 0.8);
  const seen = silhouette(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 0.5, d);
  near(seen.side, 0.8, 1e-6);
  assert.ok(seen.vertical < 0.6);
  assert.ok(d > fitDistance(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9, 0.6, 0.8));
});

test("a canvas wider than the robot needs changes nothing", () => {
  near(fitDistance(ROBOT, LOOK, 0.3, FOV, 2), fitDistance(ROBOT, LOOK, 0.3, FOV, 4), 1e-9);
});

test("every elevation in range is framed to the same height", () => {
  // The camera refits as it tilts, so looking down on the robot does not zoom it out of the frame.
  for (const elevation of [ELEVATION_MIN, ELEVATION_DEFAULT, 0.8, ELEVATION_MAX]) {
    const d = fitDistance(ROBOT, LOOK, elevation, FOV, 16 / 9, 0.6, 0.8);
    near(silhouette(ROBOT, LOOK, elevation, FOV, 16 / 9, d).vertical, 0.6, 1e-6, `at ${elevation} rad`);
  }
});

test("a bigger robot stands the camera further off", () => {
  const bigger = ROBOT.map((part) => ({ ...part, radius: part.radius * 1.5, top: part.top * 1.5 }));
  assert.ok(fitDistance(bigger, LOOK * 1.5, 0.3, FOV, 16 / 9) > fitDistance(ROBOT, LOOK, 0.3, FOV, 16 / 9));
});

test("describing the superstructure on its own frames the robot tighter than one cylinder", () => {
  // One cylinder round the whole robot puts the top of a central tower out at the bumpers' far edge,
  // and the robot comes out smaller than asked. This is the reason framing takes parts at all.
  const oneCylinder = [{ radius: 0.6, bottom: 0, top: 0.52 }];
  assert.ok(fitDistance(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9) < fitDistance(oneCylinder, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9));
});

test("however much fill is asked for, the camera never goes inside the robot", () => {
  const d = fitDistance(ROBOT, LOOK, 0.3, FOV, 16 / 9, 3, 3);
  assert.ok(d >= closest(ROBOT, LOOK));
  assert.ok(closest(ROBOT, LOOK) > Math.hypot(0.6, 0.26));
});

test("a robot looked at from above sits low on the canvas until the lens is shifted", () => {
  // The near bumper is drawn larger than the far one, and the bulk of a robot is low. Both put the
  // middle of the silhouette below the middle of the canvas, which is what placeCamera's lens shift
  // takes back out.
  const d = fitDistance(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9);
  assert.ok(silhouette(ROBOT, LOOK, ELEVATION_DEFAULT, FOV, 16 / 9, d).centre < -0.05);
});

test("a cylinder seen dead level from its own middle is centred exactly", () => {
  const drum = [{ radius: 0.5, bottom: 0, top: 0.6 }];
  near(silhouette(drum, 0.3, 0, FOV, 1, 3).centre, 0, 1e-12);
});

// --- the robot description ---------------------------------------------------

test("an empty description is the default robot", () => {
  for (const spec of [{}, undefined, null, "robot"]) {
    const robot = normalizeRobot(spec);
    assert.equal(robot.frameLength, 0.74);
    assert.equal(robot.frameWidth, 0.74);
    assert.equal(robot.bumperThickness, 0.0762);
    near(robot.bumperLength, 0.74 + 2 * 0.0762, 1e-12);
    near(robot.bumperWidth, 0.74 + 2 * 0.0762, 1e-12);
    assert.equal(robot.height, 0.52);
    assert.equal(robot.modules.length, 4);
  }
});

test("the default modules sit at the frame's corners, inset a tenth of a metre, front-left first", () => {
  const [fl, fr, bl, br] = normalizeRobot({}).modules;
  near(fl[0], 0.27, 1e-12); near(fl[1], 0.27, 1e-12);
  near(fr[0], 0.27, 1e-12); near(fr[1], -0.27, 1e-12);
  near(bl[0], -0.27, 1e-12); near(bl[1], 0.27, 1e-12);
  near(br[0], -0.27, 1e-12); near(br[1], -0.27, 1e-12);
});

test("a small frame pulls the default modules in so opposite corners cannot cross", () => {
  const [[x, y]] = normalizeRobot({ frameLength: 0.3, frameWidth: 0.3 }).modules;
  assert.ok(x > 0 && y > 0);
  near(x, 0.075, 1e-12);
});

test("a bumper size on its own implies the frame inside it", () => {
  const robot = normalizeRobot({ bumperLength: 1.0, bumperWidth: 0.9 });
  near(robot.frameLength, 1.0 - 2 * 0.0762, 1e-12);
  near(robot.frameWidth, 0.9 - 2 * 0.0762, 1e-12);
  assert.equal(robot.bumperLength, 1.0);
});

test("a frame size on its own implies the bumpers around it", () => {
  const robot = normalizeRobot({ frameLength: 0.8, frameWidth: 0.6, bumperThickness: 0.08 });
  near(robot.bumperLength, 0.96, 1e-12);
  near(robot.bumperWidth, 0.76, 1e-12);
});

test("bumpers smaller than their frame are not believed", () => {
  near(normalizeRobot({ frameLength: 0.8, bumperLength: 0.7 }).bumperLength, 0.8 + 2 * 0.0762, 1e-12);
});

test("values that are not plausible numbers count as missing", () => {
  const robot = normalizeRobot({ frameLength: "0.8", frameWidth: -1, height: NaN, bumperThickness: Infinity });
  assert.equal(robot.frameLength, 0.74);
  assert.equal(robot.frameWidth, 0.74);
  assert.equal(robot.height, 0.52);
  assert.equal(robot.bumperThickness, 0.0762);
});

test("broken module entries are dropped and the rest kept", () => {
  const robot = normalizeRobot({ modules: [[0.3, 0.3], [0.3], ["0.3", 0.1], null, [NaN, 0], [0.3, -0.3]] });
  assert.deepEqual(robot.modules, [[0.3, 0.3], [0.3, -0.3]]);
});

test("no usable modules means the default four, and more than eight are cut to eight", () => {
  assert.equal(normalizeRobot({ modules: [] }).modules.length, 4);
  assert.equal(normalizeRobot({ modules: [[NaN, NaN]] }).modules.length, 4);
  const many = Array.from({ length: 12 }, (_, i) => [i * 0.05, 0.2]);
  assert.equal(normalizeRobot({ modules: many }).modules.length, 8);
});

// --- the team number ---------------------------------------------------------

test("a team number prints as written, from a number or a string", () => {
  assert.equal(bumperNumber(5805), "5805");
  assert.equal(bumperNumber("254"), "254");
  assert.equal(bumperNumber(" 1 "), "1");
});

test("zero, fractions, negatives and garbage print nothing", () => {
  for (const value of [0, -5, 12.5, 100000, NaN, Infinity, "", "  ", "abc", null, undefined, {}, [5805]]) {
    assert.equal(bumperNumber(value), null, `for ${String(value)}`);
  }
});

// --- the callouts ------------------------------------------------------------

/* A 1200 x 700 canvas with the robot in the middle third, and labels of one size. */
const AREA = { w: 1200, h: 700, top: 16, left: [150, 600], right: [80, 640] };
const BOX = { left: 400, top: 180, right: 800, bottom: 520 };
const SIZE = { w: 120, h: 40 };
const sizesFor = (points) => Object.fromEntries(Object.keys(points).map((name) => [name, SIZE]));
const overlaps = (a, b) =>
  a.x < b.x + SIZE.w && b.x < a.x + SIZE.w && a.y < b.y + SIZE.h && b.y < a.y + SIZE.h;

test("a label goes beside the robot on its part's side, never over the robot", () => {
  const points = { battery: { x: 450, y: 400, visible: true }, drivetrain: { x: 760, y: 350, visible: true } };
  const spots = layoutCallouts(points, BOX, sizesFor(points), AREA);
  assert.equal(spots.battery.side, "left");
  assert.ok(spots.battery.x + SIZE.w <= BOX.left, "left label clear of the robot");
  assert.equal(spots.drivetrain.side, "right");
  assert.ok(spots.drivetrain.x >= BOX.right, "right label clear of the robot");
});

test("a label sits level with its part, and its line ends on the part", () => {
  const points = { battery: { x: 450, y: 400, visible: true } };
  const { battery } = layoutCallouts(points, BOX, sizesFor(points), AREA);
  near(battery.y + SIZE.h / 2, 400, 1e-9, "label middle");
  assert.deepEqual(battery.line.slice(2), [450, 400]);
  near(battery.line[1], 400, 1e-9, "line starts level with the label");
  assert.ok(battery.line[0] > battery.x + SIZE.w && battery.line[0] < BOX.left, "line starts between label and robot");
});

test("the part named above is labelled over the robot", () => {
  const points = { top: { x: 610, y: 200, visible: true } };
  const { top } = layoutCallouts(points, BOX, sizesFor(points), AREA);
  assert.equal(top.side, "top");
  assert.ok(top.y + SIZE.h <= BOX.top, "label above the robot");
  near(top.x + SIZE.w / 2, 610, 1e-9, "centred on its part");
  assert.deepEqual(top.line.slice(2), [610, 200]);
});

test("labels on one side are pushed apart rather than stacked", () => {
  const points = {
    a: { x: 420, y: 300, visible: true },
    b: { x: 430, y: 310, visible: true },
    c: { x: 440, y: 305, visible: true },
  };
  const spots = layoutCallouts(points, BOX, sizesFor(points), AREA, { spacing: 10 });
  const list = Object.values(spots).sort((p, q) => p.y - q.y);
  assert.equal(list.length, 3);
  for (let i = 1; i < list.length; i++) {
    assert.ok(!overlaps(list[i - 1], list[i]), `labels ${i - 1} and ${i} overlap`);
    assert.ok(list[i].y - list[i - 1].y >= SIZE.h + 10 - 1e-9, "kept the spacing");
  }
});

test("labels keep to their side's band", () => {
  const points = {
    high: { x: 420, y: 60, visible: true },
    low: { x: 430, y: 690, visible: true },
    right: { x: 780, y: 20, visible: true },
  };
  const spots = layoutCallouts(points, BOX, sizesFor(points), AREA);
  assert.ok(spots.high.y >= AREA.left[0]);
  assert.ok(spots.low.y + SIZE.h <= AREA.left[1]);
  assert.ok(spots.right.y >= AREA.right[0]);
});

test("a crowded band still keeps every label inside it and in order", () => {
  const points = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`p${i}`, { x: 410, y: 560 + i, visible: true }])
  );
  const spots = layoutCallouts(points, BOX, sizesFor(points), AREA, { spacing: 10 });
  const list = Object.keys(points).map((name) => spots[name]);
  for (const spot of list) assert.ok(spot.y + SIZE.h <= AREA.left[1] + 1e-9, "inside the band");
  for (let i = 1; i < list.length; i++) assert.ok(list[i].y > list[i - 1].y, "order kept");
});

test("a label with no room on its side crosses to the side that has room", () => {
  const box = { left: 60, top: 180, right: 700, bottom: 520 };
  const points = { battery: { x: 100, y: 400, visible: true } };
  const { battery } = layoutCallouts(points, box, sizesFor(points), AREA);
  assert.equal(battery.side, "right");
  assert.ok(battery.x >= box.right);
});

test("parts turned away, or with no size, get no label", () => {
  const points = {
    shown: { x: 450, y: 400, visible: true },
    turned: { x: 460, y: 300, visible: false },
    unsized: { x: 470, y: 350, visible: true },
    broken: { x: NaN, y: 350, visible: true },
  };
  const spots = layoutCallouts(points, BOX, { shown: SIZE, turned: SIZE, broken: SIZE }, AREA);
  assert.deepEqual(Object.keys(spots), ["shown"]);
});

test("nothing to lay out lays out nothing", () => {
  assert.deepEqual(layoutCallouts(null, BOX, {}, AREA), {});
  assert.deepEqual(layoutCallouts({}, null, {}, AREA), {});
  assert.deepEqual(layoutCallouts({ a: { x: 1, y: 1, visible: true } }, BOX, { a: SIZE }, { w: 0, h: 0 }), {});
});

// --- shots and flights ---------------------------------------------------------

test("turnY turns the way three.js turns an object, and back", () => {
  const turned = turnY([1, 0.5, 0], Math.PI / 2);
  near(turned[0], 0, 1e-12, "x");
  near(turned[1], 0.5, 1e-12, "y");
  near(turned[2], -1, 1e-12, "z: a quarter turn sends the front to -z");
  const back = turnY(turned, -Math.PI / 2);
  near(back[0], 1, 1e-12);
  near(back[2], 0, 1e-12);
});

test("a cubic Bézier timing function runs from 0 to 1, and the linear one is the identity", () => {
  const linear = cubicBezier(0, 0, 1, 1);
  for (const x of [0, 0.1, 0.37, 0.5, 0.9, 1]) near(linear(x), x, 1e-5, `linear at ${x}`);
  const ease = cubicBezier(0.25, 0.1, 0.25, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.equal(ease(-1), 0);
  assert.equal(ease(2), 1);
  // CSS's `ease` at 0.5 is about 0.8024.
  near(ease(0.5), 0.8024, 2e-3, "ease at 0.5");
});

test("the flight's timing never runs backwards, starts from rest and lands softly", () => {
  let last = 0;
  for (let i = 1; i <= 100; i++) {
    const v = flightEase(i / 100);
    assert.ok(v >= last - 1e-9, `monotonic at ${i}`);
    last = v;
  }
  assert.ok(flightEase(0.9) > 0.99, "all but there with a tenth of the time left");
  assert.ok(flightEase(0.01) < 0.01, "starting from rest");
  assert.equal(flightEase(0), 0);
  assert.equal(flightEase(1), 1);
});

const shotA = { eye: [0, 1, 3], look: [0, 0.3, 0], fov: 30, rect: { x: 0, y: 10, w: 1400, h: 800 } };
const shotB = { eye: [-5, 3.5, 0], look: [2.2, 0, 0], fov: 46, rect: { x: 14, y: 0, w: 460, h: 720 } };

test("a flight starts exactly on its first shot and lands exactly on its last", () => {
  const start = mixShots(shotA, shotB, 0);
  const end = mixShots(shotA, shotB, 1);
  for (let i = 0; i < 3; i++) {
    near(start.eye[i], shotA.eye[i], 1e-9, `start eye ${i}`);
    near(start.look[i], shotA.look[i], 1e-9, `start look ${i}`);
    near(end.eye[i], shotB.eye[i], 1e-9, `end eye ${i}`);
    near(end.look[i], shotB.look[i], 1e-9, `end look ${i}`);
  }
  assert.equal(start.fov, 30);
  assert.equal(end.fov, 46);
  assert.deepEqual(end.rect, shotB.rect);
});

test("the camera swings round what it looks at, the short way, rather than cutting across", () => {
  // Two shots at bearings of +170 and -170 degrees: the short way round passes through 180.
  const a = { eye: [Math.sin((170 * Math.PI) / 180) * 4, 0, Math.cos((170 * Math.PI) / 180) * 4], look: [0, 0, 0], fov: 40, rect: { x: 0, y: 0, w: 1, h: 1 } };
  const b = { eye: [Math.sin((-170 * Math.PI) / 180) * 4, 0, Math.cos((-170 * Math.PI) / 180) * 4], look: [0, 0, 0], fov: 40, rect: { x: 0, y: 0, w: 1, h: 1 } };
  const mid = mixShots(a, b, 0.5);
  near(mid.eye[0], 0, 1e-9, "x through the far side");
  near(mid.eye[2], -4, 1e-9, "z at the far side");
  near(Math.hypot(...mid.eye), 4, 1e-9, "on the circle, not inside it");
});

test("halfway, the distance is the geometric mean, so the robot grows evenly on screen", () => {
  const a = { eye: [0, 0, 1], look: [0, 0, 0], fov: 40, rect: { x: 0, y: 0, w: 1, h: 1 } };
  const b = { eye: [0, 0, 16], look: [0, 0, 0], fov: 40, rect: { x: 0, y: 0, w: 1, h: 1 } };
  near(mixShots(a, b, 0.5).eye[2], 4, 1e-9);
});

/* ---- the glide ---- */

/** Where a shot draws a point: canvas pixels, and pixels per metre there. The same camera three.js builds
 *  from eye, look, a vertical field of view and a view offset of the shot rectangle. */
function drawn(shot, point) {
  const f = [shot.look[0] - shot.eye[0], shot.look[1] - shot.eye[1], shot.look[2] - shot.eye[2]];
  const fl = Math.hypot(...f);
  const forward = f.map((v) => v / fl);
  const rl = Math.hypot(forward[2], forward[0]);
  const right = [-forward[2] / rl, 0, forward[0] / rl];
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const d = [point[0] - shot.eye[0], point[1] - shot.eye[1], point[2] - shot.eye[2]];
  const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
  const focal = shot.rect.h / (2 * Math.tan((shot.fov * Math.PI) / 360));
  return {
    x: shot.rect.x + shot.rect.w / 2 + (focal * (d[0] * right[0] + d[2] * right[2])) / depth,
    y: shot.rect.y + shot.rect.h / 2 - (focal * (d[0] * up[0] + d[1] * up[1] + d[2] * up[2])) / depth,
    scale: focal / depth,
  };
}

const middle = [0, 0.3, 0];

test("a glide starts exactly on its first shot and lands exactly on its last", () => {
  for (const [t, want] of [[0, shotA], [1, shotB]]) {
    const got = glideShots(shotA, shotB, t, middle);
    for (let i = 0; i < 3; i++) near(got.eye[i], want.eye[i], 1e-9, `eye ${i} at ${t}`);
    const aim = (s) => {
      const v = [s.look[0] - s.eye[0], s.look[1] - s.eye[1], s.look[2] - s.eye[2]];
      const l = Math.hypot(...v);
      return v.map((c) => c / l);
    };
    for (let i = 0; i < 3; i++) near(aim(got)[i], aim(want)[i], 1e-9, `aim ${i} at ${t}`);
    near(got.fov, want.fov, 1e-9, "fov");
    for (const k of ["x", "y", "w", "h"]) near(got.rect[k], want.rect[k], 1e-7, `rect ${k} at ${t}`);
  }
});

test("the robot glides straight to where it lands, shrinking at an even rate", () => {
  // shotB looks well ahead of the robot, as the field view does: the case where swinging round the look
  // point sent the robot on a detour.
  const from = drawn(shotA, middle);
  const to = drawn(shotB, middle);
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    const at = drawn(glideShots(shotA, shotB, t, middle), middle);
    near(at.x, from.x + (to.x - from.x) * t, 1e-6, `x at ${t}`);
    near(at.y, from.y + (to.y - from.y) * t, 1e-6, `y at ${t}`);
    near(Math.log(at.scale), Math.log(from.scale) + (Math.log(to.scale) - Math.log(from.scale)) * t, 1e-9, `scale at ${t}`);
  }
});

test("a glide comes round the robot the short way", () => {
  const round = (degrees) => {
    const r = (degrees * Math.PI) / 180;
    return { eye: [Math.sin(r) * 4, 0.3, Math.cos(r) * 4], look: [0, 0.3, 0], fov: 40, rect: { x: 0, y: 0, w: 800, h: 600 } };
  };
  const mid = glideShots(round(170), round(-170), 0.5, middle);
  near(mid.eye[0], 0, 1e-9, "x through the far side");
  near(mid.eye[2], -4, 1e-9, "z at the far side");
});

test("a shot with the robot behind the camera falls back to swinging round the look point", () => {
  const behind = { eye: [0, 0.3, -2], look: [0, 0.3, -5], fov: 40, rect: { x: 0, y: 0, w: 800, h: 600 } };
  assert.deepEqual(glideShots(shotA, behind, 0.5, middle), mixShots(shotA, behind, 0.5));
});

test("a robot known to have no superstructure is drawn as its chassis; any other gets the generic one", async () => {
  const { normalizeRobot } = await import("./robot3d.js");
  assert.equal(normalizeRobot({}).superstructure, true);
  assert.equal(normalizeRobot({ superstructure: true }).superstructure, true);
  /* Only an explicit false turns it off: a spec that says nothing about it is an unknown robot. */
  assert.equal(normalizeRobot({ superstructure: undefined }).superstructure, true);
  assert.equal(normalizeRobot({ superstructure: false }).superstructure, false);
});
