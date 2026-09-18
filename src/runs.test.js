/* The run recorder, held to runs synthesized from Catalyst X1's own output.
 *
 * fixtures/x1-2026-09-17.json is every topic X1 published while it sat disabled on 17 September 2026. A run
 * here is that capture brought to life: the control word enabled, the pose driven, the battery sagging, the
 * aim swinging onto the hub and holding it, the Limelight seeing tags - frame by frame, at the thirty frames a
 * second the backend sends - and everything X1 did not change left exactly as it was captured. So the
 * recorder is tested against the topics, names and shapes a real robot sends, not ones written for the test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  addRun,
  createRunRecorder,
  describeChanges,
  loadRuns,
  modeLabel,
  RUNS_KEPT,
  runCard,
  runClock,
  runCsv,
  runFigures,
  runFileName,
  runWhen,
  SAMPLE_CAPACITY,
  storeRuns,
  traceSegments,
  tunableChanges,
  valueRange,
} from "./runs.js";
import { demoMatch, MATCH_S } from "./demo-match.js";

const capture = JSON.parse(readFileSync(new URL("./fixtures/x1-2026-09-17.json", import.meta.url), "utf8"));

const near = (actual, expected, tolerance, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);

/** A store of `{ t, v }` values and the console's read-only view over it (ntView in app.js), with the same
 *  rules as its readers: a boolean read as a number is 0 or 1, and a number read as a string is its text. */
function store(values) {
  const v = { ...values };
  const get = (k) => v[k];
  return {
    values: v,
    set: (k, t, value) => { v[k] = { t, v: value }; },
    drop: (k) => { delete v[k]; },
    view: {
      raw: get,
      has: (k) => get(k) !== undefined,
      keys: () => Object.keys(v),
      num: (k, f = null) => (get(k)?.t === "num" ? get(k).v : get(k)?.t === "bool" ? (get(k).v ? 1 : 0) : f),
      bool: (k, f = null) => (get(k)?.t === "bool" ? get(k).v : get(k)?.t === "num" ? get(k).v !== 0 : f),
      str: (k, f = null) => (get(k)?.t === "str" ? get(k).v : get(k)?.t === "num" ? String(get(k).v) : f),
      arr: (k) => (["nums", "strs", "bools"].includes(get(k)?.t) ? get(k).v : null),
    },
  };
}

/* The control word as X1 publishes it on /FMSInfo/FMSControlData: the driver station attached, plus the
   enabled bit (and autonomous, test or e-stop when asked). */
const DS = 32;
const word = ({ enabled = false, auto = false, test = false, estop = false } = {}) =>
  DS | (enabled ? 1 : 0) | (auto ? 2 : 0) | (test ? 4 : 0) | (estop ? 8 : 0);

const HZ = 30;
const WALL = Date.UTC(2026, 8, 17, 20, 40, 0);

/**
 * Play frames through a recorder: `script(t, s)` sets the store for time `t` (seconds) and returns the
 * control word, or `{ word, linked }`. Runs from `from` to `to` at HZ and returns every run that finished.
 */
function play(recorder, s, script, { from = -1, to, hz = HZ, wall = WALL } = {}) {
  const runs = [];
  const frames = Math.round((to - from) * hz);
  for (let i = 0; i <= frames; i++) {
    const t = from + i / hz;
    const out = script(t, s);
    const { word: w, linked = true, shots = null } = typeof out === "number" || out === null ? { word: out } : out;
    const done = recorder.frame(t * 1000, s.view, { word: w, linked, wall: wall + t * 1000, shots });
    if (done) runs.push(done);
  }
  return runs;
}

/* Seeded noise, so a noisy run is the same noise every time. */
function uniform(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x + 0x6d2b79f5) >>> 0;
    let t = x;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const [X0, Y0, H0] = capture.values["/Catalyst/Physics/PoseArray"].v;

/**
 * Twenty seconds of teleop on X1, scripted so every number the recorder gives has a known answer:
 *
 *   0 - 2 s     standing on the captured pose
 *   2 - 6 s     driving 1.5 m/s towards the red alliance wall: 6 m, with the battery sagging to 11.9 V and
 *               one dip to 11.62 V at 4 s
 *   8 - 8.9 s   turret mode swings onto the hub: ALIGNING, the error falling from 25 degrees to 2
 *   8.9 - 14 s  ALIGNED, the error a 1.5 degree sine at 1.5 Hz; the modules dither 0.05 rad at 2 Hz
 *   14 - 14.3 s it loses the lock for 0.3 s: ALIGNING, 5 degrees off
 *   14.3 - 17 s ALIGNED again, a 1 degree sine
 *   17 s -      IDLE; X1 leaves the error where it was, as AimPublisher does
 *
 * The Limelight's health is OK, with two tags, from 8 s to 17 s and NO_TARGETS otherwise - while its tag
 * count stays at the one it held when it was captured, stale, as it really does. A fix is accepted every
 * frame it sees tags, and the pose confidence is 0.9 then and 0.6 otherwise.
 */
function x1Teleop({ gain = 4, runFor = 20 } = {}) {
  const s = store(capture.values);
  const noise = uniform(11);
  let accepted = capture.values["/Catalyst/Vision/TotalAccepted"].v;
  s.set("/Catalyst/X1/Turret/Gain", "num", gain);
  const script = (t) => {
    const enabled = t >= 0 && t < runFor;
    const driven = Math.min(Math.max(t - 2, 0), 4);
    const x = X0 - 1.5 * driven + (noise() - 0.5) * 0.01;
    const y = Y0 + (noise() - 0.5) * 0.01;
    s.set("/Catalyst/Physics/PoseArray", "nums", [x, y, H0]);
    const moving = t > 2 && t < 6;
    s.set("/Catalyst/Systemcore/BatteryVolts", "num", Math.abs(t - 4) < 1e-6 ? 11.62 : moving ? 11.9 : 12.675);

    let state = "IDLE";
    let error = capture.values["/Catalyst/Aim/HeadingErrorDeg"].v;
    if (enabled && t >= 8 && t < 17) {
      if (t < 8.9) { state = "ALIGNING"; error = 25 - (23 * (t - 8)) / 0.9; }
      else if (t < 14) { state = "ALIGNED"; error = 1.5 * Math.sin(2 * Math.PI * 1.5 * t); }
      else if (t < 14.3) { state = "ALIGNING"; error = 5; }
      else { state = "ALIGNED"; error = 1.0 * Math.sin(2 * Math.PI * 1.5 * t); }
    }
    s.set("/Catalyst/Aim/State", "str", state);
    s.set("/Catalyst/Aim/HeadingErrorDeg", "num", error);
    const dither = state === "IDLE" ? 0 : 0.05 * Math.sin(2 * Math.PI * 2 * t);
    s.set("/Catalyst/Swerve/ModuleStates", "nums", [0, 0.8 + dither, 0, -0.8 + dither, 0, 2.4 + dither, 0, -2.4 + dither]);

    const seeing = enabled && t >= 8 && t < 17;
    s.set("/Catalyst/Vision/Health/limelight-ground/State", "str", seeing ? "OK" : "NO_TARGETS");
    if (seeing) {
      s.set("/Catalyst/Vision/limelight-ground/TagCount", "num", 2);
      accepted += 1;
    } else {
      s.set("/Catalyst/Vision/limelight-ground/TagCount", "num", 1);
    }
    s.set("/Catalyst/Vision/TotalAccepted", "num", accepted);
    s.set("/Catalyst/Physics/Quality/Confidence", "num", seeing ? 0.9 : 0.6);
    return word({ enabled });
  };
  return { s, script };
}

function recordX1(options) {
  const { s, script } = x1Teleop(options);
  const runs = play(createRunRecorder(), s, script, { to: (options?.runFor ?? 20) + 1 });
  assert.equal(runs.length, 1, "one run");
  return runs[0];
}

/* ---- what a run is ---- */

test("a robot that is never enabled records nothing, and an enable shorter than a second is not a run", () => {
  const s = store(capture.values);
  const recorder = createRunRecorder();
  assert.deepEqual(play(recorder, s, () => word(), { to: 5 }), []);
  const blip = play(recorder, s, (t) => word({ enabled: t >= 1 && t < 1.6 }), { to: 3 });
  assert.deepEqual(blip, []);
  assert.equal(recorder.recording, false);
});

test("X1's run is timed, named and moded from what X1 publishes", () => {
  const run = recordX1();
  near(run.seconds, 20, 1 / HZ + 1e-9, "seconds");
  near(run.modes.teleop, run.seconds, 1e-9, "all of it teleop");
  assert.equal(run.modes.auto, 0);
  assert.equal(modeLabel(run), "Teleop");
  assert.equal(run.robot, "Catalyst X1");
  assert.equal(run.opMode, "X1 Drive");
  assert.equal(run.ended, "disabled");
  assert.equal(run.partial, false, "the console saw X1 disabled first");
  near(run.started, WALL, 1000 / HZ + 1, "stamped with when it began");
});

test("distance and top speed come from the pose, and the pose's standing jitter adds nothing", () => {
  const run = recordX1();
  /* 6 m driven. Anything counted while it stood still - 18 of its 20 s, the pose wandering a centimetre -
     would show up here as extra distance. */
  near(run.distance, 6, 0.1, "metres");
  near(run.topSpeed, 1.5, 0.08, "m/s");
});

test("the battery's lowest is the lowest reading, and where it began is kept beside it", () => {
  const run = recordX1();
  assert.equal(run.voltsMin, 11.62);
  near(run.voltsStart, 12.675, 1e-9, "as captured");
});

test("the aim: time aimed, on target, time to lock, and the error from the first lock on", () => {
  const { aim } = recordX1();
  near(aim.aimedS, 9, 0.07, "aimed");
  near(aim.lockedS, 7.8, 0.07, "locked");
  near(aim.onTarget, 7.8 / 9, 0.01, "on target");
  assert.equal(aim.attempts, 1, "one attempt, the dropout inside it");
  assert.equal(aim.locks, 1);
  near(aim.toLockS, 0.9, 1 / HZ + 1e-9, "time to lock");
  /* The swing onto the hub (25 degrees down to 2) is not in the error; the 0.3 s dropout at 5 degrees is:
     mean square (1.125 * 5.1 + 25 * 0.3 + 0.5 * 2.7) / 8.1. */
  near(aim.rmsDeg, Math.sqrt((1.125 * 5.1 + 25 * 0.3 + 0.5 * 2.7) / 8.1), 0.05, "RMS");
  /* The dropout is 3.7% of the hold, so 95% of it is inside the 1.5 degree sine's peak. */
  near(aim.p95Deg, 1.5, 0.06, "95th percentile");
});

test("the wheels' steering while the aim is held is measured, in degrees a second", () => {
  const { aim } = recordX1();
  /* Each module swings 0.05 rad either way twice a second: 4 x 0.05 x 2 = 0.4 rad of travel a second,
     read here through frames thirty times a second. */
  const travel = (0.4 * 180) / Math.PI;
  assert.ok(aim.steerDegS <= travel && aim.steerDegS > travel * 0.9, `${aim.steerDegS} of ${travel}`);
});

test("vision: tags in view only while the camera's health says it is seeing, never from its stale count", () => {
  const { vision } = recordX1();
  assert.equal(vision.cameras, 1);
  near(vision.seeing, 9 / 20, 0.01, "seeing");
  assert.equal(vision.meanTags, 2, "the stale 1 is never counted");
  near(vision.accepted, 9 * HZ, 2, "fixes accepted");
  near(vision.confidenceMean, (0.6 * 11 + 0.9 * 9) / 20, 0.01, "confidence");
  assert.equal(vision.confidenceMin, 0.6);
});

test("X1 exactly as captured - nothing moving, not aiming, no tag in view - reads as that, not as blanks", () => {
  const s = store(capture.values);
  const [run] = play(createRunRecorder(), s, (t) => word({ enabled: t >= 0 && t < 5 }), { to: 6 });
  assert.equal(run.distance, 0);
  assert.equal(run.topSpeed, 0);
  assert.equal(run.voltsMin, capture.values["/Catalyst/Systemcore/BatteryVolts"].v);
  /* It publishes an aim, and never aimed: that is a measurement of zero, with nothing to say about error. */
  assert.equal(run.aim.aimedS, 0);
  assert.equal(run.aim.onTarget, null);
  assert.equal(run.aim.rmsDeg, null);
  assert.equal(run.aim.p95Deg, null);
  assert.equal(run.aim.toLockS, null);
  /* The capture holds no /Catalyst/Swerve/ModuleStates, so there is no steering to measure. */
  assert.equal(run.aim.steerDegS, null);
  assert.equal(run.vision.seeing, 0);
  assert.equal(run.vision.meanTags, null);
  assert.equal(run.vision.accepted, 0);
  near(run.vision.confidenceMean, capture.values["/Catalyst/Physics/Quality/Confidence"].v, 1e-6, "confidence");
});

test("a robot that publishes only its control word gets a length and a mode, and a null for everything else", () => {
  const s = store({});
  const [run] = play(createRunRecorder(), s, (t) => word({ enabled: t >= 0 && t < 3, test: true }), { to: 4 });
  near(run.seconds, 3, 1 / HZ + 1e-9, "seconds");
  assert.equal(modeLabel(run), "Test", "a 2026 word calls it test");
  for (const key of ["distance", "topSpeed", "voltsStart", "voltsMin", "shots", "aim", "vision", "tunables", "robot", "opMode"]) {
    assert.equal(run[key], null, key);
  }
  assert.deepEqual(Object.keys(run.samples.columns), ["t", "mode"]);
  const figures = runFigures(run);
  assert.deepEqual(figures.drive.map(([, value]) => value), ["0:03", "—", "—", "—"]);
  assert.equal(figures.aim, null);
  assert.equal(figures.vision, null);
  assert.deepEqual(runCard(run), { title: "0:03", sub: "Nothing published to measure" });
});

test("a heading error the robot sends as NaN - null on the wire - is absent, not zero", () => {
  const s = store(capture.values);
  const [run] = play(createRunRecorder(), s, (t) => {
    s.set("/Catalyst/Aim/State", "str", t >= 1 ? "ALIGNED" : "IDLE");
    s.set("/Catalyst/Aim/HeadingErrorDeg", "num", t < 2 ? null : 3);
    return word({ enabled: t >= 0 && t < 4 });
  }, { to: 5 });
  near(run.aim.lockedS, 3, 0.05, "locked");
  near(run.aim.rmsDeg, 3, 1e-6, "only the real readings");
  near(run.aim.holdS, 2, 0.05, "the error measured for 2 s of the 3 held");
  const errors = [...run.samples.columns.error];
  assert.ok(errors.some((e) => Number.isNaN(e)) && errors.some((e) => e === 3));
});

/* ---- attempts ---- */

test("an aim that drops to idle for a frame is the same attempt; one that stops is not; a new target is another", () => {
  const s = store(capture.values);
  s.set("/Catalyst/Aim/HeadingErrorDeg", "num", 1);
  const [run] = play(createRunRecorder(), s, (t) => {
    let state = "IDLE";
    let target = [11.93, 4.035];
    if (t >= 1 && t < 3) state = t < 1.5 ? "ALIGNING" : "ALIGNED";
    if (Math.abs(t - 2) < 0.02) state = "IDLE";                 // one frame's flicker
    if (t >= 4 && t < 6) state = t < 4.3 ? "ALIGNING" : "ALIGNED"; // aimed again after a second away
    if (t >= 6 && t < 8) { state = t < 6.2 ? "ALIGNING" : "SOTF"; target = [14.5, 2.0]; } // a feed point
    s.set("/Catalyst/Aim/State", "str", state);
    s.set("/Catalyst/Aim/Target", "nums", target);
    return word({ enabled: t >= 0 && t < 9 });
  }, { to: 10 });
  assert.equal(run.aim.attempts, 3);
  assert.equal(run.aim.locks, 3);
  near(run.aim.toLockS, 0.3, 1 / HZ + 1e-9, "the median of 0.5, 0.3 and 0.2 s");
  near(run.aim.sotfS, 1.8, 0.05, "shooting on the move");
});

/* ---- how a run ends ---- */

test("a run says how it ended: disabled, e-stopped, or the link going away", () => {
  const s = store(capture.values);
  const recorder = createRunRecorder();
  const [stopped] = play(recorder, s, (t) => (t < 2 ? word({ enabled: t >= 0 }) : word({ estop: true })), { to: 3 });
  assert.equal(stopped.ended, "estop");
  const [lost] = play(recorder, s, (t) => (t < 6 ? word({ enabled: t >= 4 }) : { word: null, linked: false }), { from: 3, to: 7 });
  assert.equal(lost.ended, "link");
  /* After the link comes back, the robot is enabled already: the console cannot know how long for. */
  const [joined] = play(recorder, s, (t) => word({ enabled: t < 9.5 }), { from: 7.5, to: 10 });
  assert.equal(joined.partial, true);
});

test("a console that starts watching while the robot is already enabled marks the run as joined partway", () => {
  const s = store(capture.values);
  const [run] = play(createRunRecorder(), s, (t) => word({ enabled: t < 3 }), { from: 0, to: 4 });
  assert.equal(run.partial, true);
  const [, , sub, note] = runFigures(run).drive[0];
  assert.equal(sub, "joined partway");
  assert.match(note, /after this run had begun/);
});

test("the FUEL estimate is what it counted during the run, and only for a robot that has one", () => {
  const s = store(capture.values);
  const [run] = play(createRunRecorder(), s, (t) => ({ word: word({ enabled: t >= 0 && t < 3 }), shots: 40 + Math.floor(Math.max(0, t) * 4) }), { to: 4 });
  assert.equal(run.shots, 12);
  assert.equal(recordX1().shots, null);
});

/* ---- memory ---- */

test("a long session keeps at most the columns it allocated, and still covers all of it", () => {
  const s = store(capture.values);
  const [run] = play(createRunRecorder(), s, (t) => {
    s.set("/Catalyst/Physics/PoseArray", "nums", [X0 - 0.5 * Math.sin(t / 10), Y0, H0]);
    return word({ enabled: t >= 0 && t < 600 });
  }, { to: 601 });
  assert.ok(run.samples.rows <= SAMPLE_CAPACITY, `${run.samples.rows} rows`);
  assert.ok(run.samples.rows > SAMPLE_CAPACITY / 4, `${run.samples.rows} rows`);
  const times = run.samples.columns.t;
  assert.equal(times[0], 0);
  near(times[times.length - 1], 600, run.samples.interval + 0.05, "the last row");
  assert.ok(run.samples.interval > 0.05, "it samples more slowly now");
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], "rows in order");
});

/* ---- the traces and the CSV ---- */

test("samples keep a column for what X1 published, and the CSV writes them, blank where there was nothing", () => {
  const run = recordX1();
  assert.deepEqual(Object.keys(run.samples.columns),
    ["t", "x", "y", "heading", "speed", "volts", "aim", "error", "steer", "tags", "confidence", "mode"]);
  near(run.samples.rows, 20 * 20, 3, "twenty rows a second");
  const csv = runCsv(run);
  const lines = csv.trimEnd().split("\r\n");
  assert.equal(lines[0], "t_s,x_m,y_m,heading_deg,speed_mps,battery_v,aim_state,heading_error_deg,steer_deg_per_s,tags_in_view,pose_confidence,mode");
  assert.equal(lines.length, run.samples.rows + 1);
  const header = lines[0].split(",");
  const rows = lines.slice(1).map((l) => Object.fromEntries(l.split(",").map((v, i) => [header[i], v])));
  const aiming = rows.find((r) => Number(r.t_s) > 10 && Number(r.t_s) < 11);
  assert.equal(aiming.aim_state, "ALIGNED");
  assert.equal(aiming.mode, "teleop");
  assert.equal(aiming.tags_in_view, "2");
  assert.ok(Math.abs(Number(aiming.heading_error_deg)) <= 1.5);
  const idle = rows.find((r) => Number(r.t_s) > 18);
  assert.equal(idle.aim_state, "IDLE");
  assert.equal(idle.heading_error_deg, "", "no error while not aiming");
  assert.equal(idle.tags_in_view, "0");
  assert.equal(runCsv({ ...run, samples: null }), null, "a stored run has no samples to write");
  assert.match(runFileName(run), /^catalyst-x1-run-\d{4}-\d{2}-\d{2}-\d{6}\.csv$/);
});

test("a trace is pooled into the box, clipped at its top, and broken where the value was absent", () => {
  const times = Float32Array.from({ length: 101 }, (_, i) => i / 10);
  const values = Float32Array.from({ length: 101 }, (_, i) => (i >= 40 && i < 60 ? NaN : i < 20 ? 50 : 1));
  const segments = traceSegments(times, values, { w: 100, h: 20, span: 10, lo: 0, hi: 5, step: 2, pool: "max" });
  assert.equal(segments.length, 2, "one line either side of the gap");
  for (const line of segments) {
    for (const [x, y] of line) {
      assert.ok(x >= 0 && x <= 100 && y >= 0 && y <= 20, `${x}, ${y}`);
    }
  }
  assert.equal(segments[0][0][1], 4, "50 is past the top, drawn on it");
  /* Pooled by the smallest, a one-sample dip is drawn; pooled by the mean it would be averaged away. */
  const dip = Float32Array.from({ length: 101 }, (_, i) => (i === 50 ? 11 : 12.5));
  const low = (pool) => Math.max(...traceSegments(times, dip, { w: 20, h: 20, span: 10, lo: 11, hi: 13, pool }).flat().map(([, y]) => y));
  assert.ok(low("min") > low("mean") + 5, `${low("min")} against ${low("mean")}`);
  /* A short run drawn wide has pools holding no samples, and those do not break the line. */
  const sparse = traceSegments(Float32Array.of(0, 1, 2), Float32Array.of(1, 2, 3), { w: 300, h: 20, span: 2, lo: 0, hi: 3 });
  assert.equal(sparse.length, 1);
  assert.equal(sparse[0].length, 3);
  assert.deepEqual(valueRange(Float32Array.of(NaN, -3, 2), { magnitude: true }), { lo: 2, hi: 3 });
  assert.equal(valueRange([NaN]), null);
});

/* ---- a whole match ---- */

test("the demo's scripted match, recorded, agrees with the match itself", () => {
  const s = store({});
  const [run] = play(createRunRecorder(), s, (t) => {
    const enabled = t >= 0 && t < MATCH_S;
    const at = Math.min(MATCH_S, Math.max(0, t));
    const m = demoMatch(at);
    s.set("/Catalyst/Physics/PoseArray", "nums", m.pose);
    s.set("/Catalyst/Aim/State", "str", enabled ? m.aim.state : "IDLE");
    s.set("/Catalyst/Aim/HeadingErrorDeg", "num", m.aim.headingErrorDeg);
    s.set("/Catalyst/Aim/Target", "nums", m.aim.target);
    s.set("/Catalyst/Swerve/ModuleStates", "nums", m.modules);
    return word({ enabled, auto: at < 20 });
  }, { to: MATCH_S + 1 });

  /* The truth, from the script at a hundred points a second. */
  let distance = 0;
  let top = 0;
  const time = { ALIGNING: 0, ALIGNED: 0, SOTF: 0, IDLE: 0 };
  let last = null;
  for (let t = 0; t < MATCH_S; t += 0.01) {
    const m = demoMatch(t);
    if (last) distance += Math.hypot(m.pose[0] - last[0], m.pose[1] - last[1]);
    last = m.pose;
    top = Math.max(top, Math.hypot(m.fieldVelocity.vx, m.fieldVelocity.vy));
    time[m.aim.state] += 0.01;
  }
  near(run.seconds, MATCH_S, 1 / HZ + 1e-9, "seconds");
  near(run.modes.auto, 20, 0.05, "autonomous");
  assert.equal(modeLabel(run), "Autonomous + teleop");
  assert.equal(modeLabel(run, { short: true }), "Auto + teleop");
  near(run.distance, distance, distance * 0.01, "distance");
  /* A quarter-second window reads a moment's peak a little low, and never high. */
  assert.ok(run.topSpeed <= top && run.topSpeed > top * 0.85, `top ${run.topSpeed} of ${top}`);
  const aimed = time.ALIGNING + time.ALIGNED + time.SOTF;
  near(run.aim.aimedS, aimed, aimed * 0.01, "aimed");
  near(run.aim.onTarget, (time.ALIGNED + time.SOTF) / aimed, 0.01, "on target");
  assert.ok(run.aim.attempts >= 5 && run.aim.locks === run.aim.attempts, `${run.aim.locks} of ${run.aim.attempts}`);
  assert.ok(run.aim.rmsDeg > 0 && run.aim.rmsDeg < 5 && run.aim.p95Deg >= run.aim.rmsDeg, `${run.aim.rmsDeg}, ${run.aim.p95Deg}`);
  assert.ok(Number.isFinite(run.aim.steerDegS));
});

/* ---- keeping runs ---- */

test("the last twenty runs are kept newest first, and only real ones are stored, without their samples", () => {
  let runs = [];
  for (let i = 0; i < 25; i++) runs = addRun(runs, { id: `run-${i}`, seconds: 10 + i, demo: i === 24, samples: { rows: 1 } });
  assert.equal(runs.length, RUNS_KEPT);
  assert.equal(runs[0].id, "run-24");
  const stored = JSON.parse(storeRuns(runs));
  assert.equal(stored.length, RUNS_KEPT - 1, "not the demo's");
  assert.equal(stored[0].id, "run-23");
  assert.ok(stored.every((r) => !("samples" in r)));
});

test("a stored run comes back as it was, less its samples", () => {
  const run = recordX1();
  const [back] = loadRuns(storeRuns([run]));
  assert.equal(back.samples, null);
  assert.equal(back.robot, "Catalyst X1");
  assert.equal(back.ended, "disabled");
  near(back.distance, run.distance, 1e-4, "distance");
  near(back.aim.rmsDeg, run.aim.rmsDeg, 1e-4, "RMS");
  near(back.vision.seeing, run.vision.seeing, 1e-4, "seeing");
  assert.deepEqual(back.tunables, run.tunables);
  assert.deepEqual(runFigures(back), runFigures({ ...run, aim: back.aim, vision: back.vision, distance: back.distance,
    topSpeed: back.topSpeed, voltsStart: back.voltsStart, voltsMin: back.voltsMin }));
});

test("storage that is empty, corrupt or foreign reads as no runs, and one bad run does not cost the rest", () => {
  assert.deepEqual(loadRuns(null), []);
  assert.deepEqual(loadRuns(""), []);
  assert.deepEqual(loadRuns("{not json"), []);
  assert.deepEqual(loadRuns('{"runs": []}'), []);
  const runs = loadRuns(JSON.stringify([
    null, 7, "run", [],
    { id: "a", seconds: "12" },
    { id: "b", seconds: 12, distance: "far", topSpeed: 1e400, aim: "yes", tunables: [["k", "n", "x"], ["k2", "n2", 2]] },
    { id: "b", seconds: 99 },
  ]));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "b");
  assert.equal(runs[0].seconds, 12, "the first of two with one id");
  assert.equal(runs[0].distance, null);
  assert.equal(runs[0].topSpeed, null);
  assert.equal(runs[0].aim, null);
  assert.deepEqual(runs[0].tunables, [["k2", "n2", 2]]);
});

/* ---- a tuning change ---- */

test("X1's tunables are recorded with each run, so a change between two runs is named", () => {
  const before = recordX1({ gain: 4 });
  const after = recordX1({ gain: 2.5 });
  assert.ok(before.tunables.length >= 30, `${before.tunables.length} tunables`);
  assert.deepEqual(before.tunables.find(([key]) => key === "/Catalyst/X1/Turret/Gain"), ["/Catalyst/X1/Turret/Gain", "Tracking gain", 4]);
  assert.ok(before.tunables.some(([, , v]) => typeof v === "boolean"), "the rumble switches are kept as switches");
  assert.deepEqual(tunableChanges(before.tunables, after.tunables),
    [{ key: "/Catalyst/X1/Turret/Gain", name: "Tracking gain", from: 4, to: 2.5 }]);
  assert.deepEqual(tunableChanges(before.tunables, before.tunables), []);
  assert.deepEqual(tunableChanges(null, after.tunables), []);
  assert.equal(describeChanges(tunableChanges(before.tunables, after.tunables)), "Tracking gain 4 → 2.5");
  assert.equal(describeChanges([
    { name: "Look-ahead", from: 0.1, to: 0.12000000001 },
    { name: "Buzz on X-brake", from: true, to: false },
    { name: "Tracking gain", from: 4, to: 3 },
  ]), "Look-ahead 0.1 → 0.12 · Buzz on X-brake on → off · 1 more");
  assert.equal(describeChanges([]), "");
});

/* ---- the words ---- */

test("the figures and the card say what was measured, and a dash for what was not", () => {
  const run = recordX1();
  const { drive, aim, vision } = runFigures(run);
  assert.deepEqual(drive.map(([label, value]) => [label, value]), [
    ["Time", "0:20"], ["Distance", `${run.distance.toFixed(1)} m`], ["Top speed", `${run.topSpeed.toFixed(1)} m/s`], ["Lowest battery", "11.6 V"],
  ]);
  const figure = (group, name) => group.find(([label]) => label === name);
  assert.deepEqual(figure(aim, "On target").slice(1, 3), [`${Math.round(run.aim.onTarget * 100)}%`, "of 0:09 aimed"]);
  assert.equal(figure(aim, "Time to lock")[2], "1 of 1 locked");
  assert.equal(figure(drive, "Lowest battery")[2], "from 12.68 V");
  assert.equal(figure(vision, "Tags in view")[1], "45%");
  assert.equal(figure(vision, "Fixes accepted")[2], "0 rejected", "X1 publishes its rejections, and rejected none");
  for (const group of [drive, aim, vision]) {
    for (const [label, value, sub, note] of group) {
      assert.ok(label && value && typeof sub === "string" && note, `${label} is complete`);
    }
  }
  assert.deepEqual(runCard(run), {
    title: `${run.distance.toFixed(1)} m · 0:20`,
    sub: `On target ${Math.round(run.aim.onTarget * 100)}% · ${run.aim.rmsDeg.toFixed(1)}° RMS`,
  });
  assert.deepEqual(runCard(null), { title: "—", sub: "No drive yet" });
  assert.equal(runClock(125.9), "2:05");
  assert.equal(runClock(null), "—");
});

test("a run's time reads as the time today, yesterday, or the date", () => {
  const now = new Date(2026, 8, 17, 21, 0).getTime();
  assert.equal(runWhen(new Date(2026, 8, 17, 14, 32).getTime(), now), "14:32");
  assert.equal(runWhen(new Date(2026, 8, 16, 9, 5).getTime(), now), "Yesterday 09:05");
  assert.equal(runWhen(new Date(2026, 8, 12, 18, 0).getTime(), now), "Sep 12 18:00");
  assert.equal(runWhen(null, now), "—");
});
