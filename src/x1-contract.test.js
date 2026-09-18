/* Catalyst X1's own output, held to what the console reads from it.
 *
 * fixtures/x1-2026-09-17.json is every topic Catalyst X1 published on 17 September 2026, captured off the
 * live robot while it sat disabled with the driver station attached, in the { t, v } shape the console's
 * store keeps. The other tests build the topics they want; these hold the console to what a real robot
 * actually sends, so a manifest, a spec sheet or a pose the console cannot read shows up here rather than
 * at the field.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CONTROLS_MANIFEST,
  makeDriver,
  readControlBindings,
  readDeclaredTunables,
  readTunables,
  robotPlan,
  TUNABLE_MANIFEST,
} from "./drivers.js";
import { robotPlacement, SYSTEM_CHECK, systemChecks } from "./devices.js";
import { hasMechanisms, readAim, readMechanisms } from "./mechanisms.js";

const capture = JSON.parse(readFileSync(new URL("./fixtures/x1-2026-09-17.json", import.meta.url), "utf8"));

/** The capture as the console's read-only view over its store (ntView in app.js), with the same rules as
 *  its readers there: a boolean read as a number is 0 or 1, and a number read as a string is its text. */
function view(values) {
  const get = (k) => values[k];
  return {
    linked: true,
    raw: get,
    has: (k) => get(k) !== undefined,
    keys: () => Object.keys(values).filter((k) => get(k) !== undefined),
    num: (k, f = null) => (get(k)?.t === "num" ? get(k).v : get(k)?.t === "bool" ? (get(k).v ? 1 : 0) : f),
    bool: (k, f = null) => (get(k)?.t === "bool" ? get(k).v : get(k)?.t === "num" ? get(k).v !== 0 : f),
    str: (k, f = null) => (get(k)?.t === "str" ? get(k).v : get(k)?.t === "num" ? String(get(k).v) : f),
    arr: (k) => (["nums", "strs", "bools"].includes(get(k)?.t) ? get(k).v : null),
  };
}

const x1 = view(capture.values);
/** X1 with some topics changed, or taken away with undefined. */
const x1With = (changes) => view({ ...capture.values, ...changes });

const near = (actual, expected, tolerance, what = "") =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${what} expected ${expected} ± ${tolerance}, got ${actual}`);

test("the capture is Catalyst X1's", () => {
  assert.equal(x1.str("/Catalyst/Robot/Identity/Name"), "Catalyst X1");
  assert.ok(x1.keys().length > 100);
});

/* ---- the tunable manifest ---- */

test("every tunable X1 declares parses, and each number's published value sits inside its range, on its step", () => {
  const listed = JSON.parse(x1.str(TUNABLE_MANIFEST));
  const declared = readDeclaredTunables(x1);
  assert.equal(readTunables(x1).length, listed.length);
  assert.equal(declared.length, listed.length, "no entry dropped as malformed");
  const numbers = declared.filter((t) => t.kind === "num");
  assert.ok(numbers.length > 0);
  for (const t of numbers) {
    for (const field of ["min", "max", "step"]) assert.ok(Number.isFinite(t[field]), `${t.key}: ${field} is ${t[field]}`);
    assert.ok(t.min < t.max, `${t.key}: [${t.min}, ${t.max}] is no range`);
    assert.ok(t.step > 0 && t.step <= t.max - t.min, `${t.key}: step ${t.step} does not fit [${t.min}, ${t.max}]`);
    const value = x1.num(t.key);
    assert.ok(value >= t.min && value <= t.max, `${t.key}: published ${value}, outside [${t.min}, ${t.max}]`);
    /* Off the step, the slider's first nudge would move the value to one the robot never had. */
    const steps = (value - t.min) / t.step;
    assert.ok(Math.abs(steps - Math.round(steps)) < 1e-6, `${t.key}: ${value} is off its ${t.step} step`);
  }
});

test("every key X1 declares is published, as the type its control takes: a switch for a boolean, a slider for a number", () => {
  for (const t of readDeclaredTunables(x1)) {
    assert.ok(x1.has(t.key), `${t.key} is declared but not published`);
    assert.ok(t.kind === "num" || t.kind === "bool", `${t.key} is published as ${t.kind}`);
    const slider = t.min !== undefined || t.max !== undefined;
    assert.equal(slider, t.kind === "num", `${t.key}: a ${t.kind} declared ${slider ? "with" : "without"} a range`);
    assert.ok(typeof t.name === "string" && t.name, `${t.key} has no name to show`);
    assert.ok(typeof t.group === "string" && t.group, `${t.key} has no group to file it under`);
  }
});

test("a profile that has set nothing plans one row per tunable X1 declares, and writes nothing", () => {
  const declared = readDeclaredTunables(x1);
  const plan = robotPlan(makeDriver({ name: "Driver" }), declared);
  assert.deepEqual(plan.rows.map((r) => r.key), declared.map((t) => t.key), "one row each, in the robot's order");
  for (const row of plan.rows) {
    assert.equal(row.value, null, row.key);
    assert.equal(row.set, false, row.key);
    assert.equal(row.writable, false, row.key);
    assert.ok(row.entry, row.key);
  }
  assert.deepEqual(plan.ready, []);
  assert.equal(plan.missing, 0);
});

/* ---- the controls manifest ---- */

test("X1's controls manifest parses into bindings, each on a named controller and none bound twice", () => {
  const listed = JSON.parse(x1.str(CONTROLS_MANIFEST));
  const bindings = readControlBindings(x1);
  assert.ok(bindings.length > 0);
  assert.equal(bindings.length, listed.length, "no binding dropped as malformed");
  for (const b of bindings) {
    assert.ok(b.control && b.action, JSON.stringify(b));
    assert.ok(typeof b.controller === "string" && b.controller, JSON.stringify(b));
    assert.equal(typeof b.combo, "boolean");
  }
  assert.deepEqual([...new Set(bindings.map((b) => b.controller))], ["Driver"]);
  assert.equal(new Set(bindings.map((b) => `${b.controller}/${b.control}`)).size, bindings.length);
});

/* ---- where it is ---- */

test("X1 is placed from its own pose estimate, on the field, with the gyro's heading", () => {
  const pose = x1.arr("/Catalyst/Physics/PoseArray");
  const place = robotPlacement(x1, { age: () => 0 });
  assert.equal(place.placed, true);
  assert.equal(place.source, "estimator");
  assert.deepEqual(place.pose, pose.slice(0, 3));
  assert.ok(place.pose[0] > 0 && place.pose[0] < 16.54 && place.pose[1] > 0 && place.pose[1] < 8.07, `${place.pose}`);
  const off = ((((place.heading * 180) / Math.PI - x1.num("/Catalyst/Swerve/HeadingDeg")) % 360) + 540) % 360 - 180;
  near(off, 0, 0.5, "heading against /Catalyst/Swerve/HeadingDeg, degrees");
});

test("without its estimate, X1's Limelight - which sees no tag - does not place it", () => {
  assert.equal(x1.num("/limelight-ground/tv"), 0);
  const place = robotPlacement(x1With({ "/Catalyst/Physics/PoseArray": undefined }), { age: () => 0 });
  assert.equal(place.placed, false);
  assert.equal(place.pose, null);
});

/* ---- its checks and its spec sheet ---- */

test("X1's system checks read as none, or as well-formed checks", () => {
  const checks = systemChecks(x1);
  assert.ok(Array.isArray(checks));
  if (!x1.keys().some((k) => k.startsWith(SYSTEM_CHECK))) assert.deepEqual(checks, []);
  for (const c of checks) {
    assert.ok(typeof c.name === "string" && c.name);
    assert.ok(c.ready === null || typeof c.ready === "boolean");
    for (const t of c.tests) assert.equal(typeof t.pass, "boolean");
  }
});

test("X1's spec sheet gives the garage a frame, bumpers round it, and four modules inside it", () => {
  const n = (k) => x1.num(`/Catalyst/Robot/${k}`);
  const frame = [n("Chassis/FrameLengthMeters"), n("Chassis/FrameWidthMeters")];
  const bumpers = [n("Chassis/BumperLengthMeters"), n("Chassis/BumperWidthMeters")];
  const thickness = n("Chassis/BumperThicknessMeters");
  /* Metres, not inches or millimetres: a robot is somewhere between a foot and two metres across. */
  for (const v of [...frame, ...bumpers]) assert.ok(v > 0.3 && v < 2, `${v}`);
  assert.ok(thickness > 0 && thickness < 0.2, `${thickness}`);
  near(bumpers[0], frame[0] + 2 * thickness, 0.005, "bumper length");
  near(bumpers[1], frame[1] + 2 * thickness, 0.005, "bumper width");

  /* The garage takes ModuleLocations as a flat list of x, y pairs, at least four of them. */
  const flat = x1.arr("/Catalyst/Robot/Drivetrain/ModuleLocations");
  assert.ok(Array.isArray(flat) && flat.length >= 8 && flat.length % 2 === 0, `${flat}`);
  assert.ok(flat.every(Number.isFinite));
  const modules = Array.from({ length: flat.length / 2 }, (_, i) => [flat[i * 2], flat[i * 2 + 1]]);
  assert.equal(modules.length, n("Drivetrain/Modules"));
  for (const [x, y] of modules) assert.ok(Math.abs(x) < frame[0] / 2 && Math.abs(y) < frame[1] / 2, `module at ${x}, ${y}`);
  assert.equal(new Set(modules.map(([x, y]) => `${Math.sign(x)},${Math.sign(y)}`)).size, 4, "one module to a corner");
  const xs = modules.map((m) => m[0]);
  const ys = modules.map((m) => m[1]);
  near(Math.max(...xs) - Math.min(...xs), n("Drivetrain/WheelBaseMeters"), 0.001, "wheelbase");
  near(Math.max(...ys) - Math.min(...ys), n("Drivetrain/TrackWidthMeters"), 0.001, "track width");
});

/* ---- a robot with no shooter ---- */

test("X1 has no mechanisms, which is what makes the console draw it as a drivebase", () => {
  const m = readMechanisms(x1);
  assert.equal(hasMechanisms(m), false);
  assert.equal(m.shooterRps, null);
  assert.equal(m.hoodDeg, null);
});

test("X1's aim reads as none while it is idle, and as an aim at its target once it aims", () => {
  assert.equal(x1.str("/Catalyst/Aim/State"), "IDLE");
  assert.equal(readAim(x1), null);
  const target = x1.arr("/Catalyst/Aim/Target");
  const pose = x1.arr("/Catalyst/Physics/PoseArray");
  for (const state of ["ALIGNING", "ALIGNED", "SOTF"]) {
    const aim = readAim(x1With({ "/Catalyst/Aim/State": { t: "str", v: state } }));
    assert.equal(aim.state, state);
    assert.deepEqual(aim.target, target.slice(0, 2));
    assert.deepEqual(aim.aimPoint, x1.arr("/Catalyst/Aim/AimPoint").slice(0, 2));
    assert.ok(Number.isFinite(aim.headingErrorDeg));
    /* The distance it publishes is from where it is to what it aims at. */
    near(aim.distance, Math.hypot(target[0] - pose[0], target[1] - pose[1]), 0.25, "aim distance");
  }
});

/* ---- the control word ---- */

/** The 2027 ControlWord struct's eight bytes as hex, decoded the way the backend does (control_word in
 *  src-tauri/src/nt4.rs): a little-endian word with enabled at bit 58, e-stop 59, FMS 60, DS 61 and the
 *  mode in 56-57 (1 autonomous, 3 utility), handed on as the legacy FMSControlData bits. */
function controlWord(hex) {
  const bytes = hex.match(/../g).map((h) => parseInt(h, 16));
  if (bytes.length !== 8) return null;
  const word = bytes.reduce((w, b, i) => w | (BigInt(b) << BigInt(8 * i)), 0n);
  const bit = (n) => ((word >> BigInt(n)) & 1n) === 1n;
  const mode = Number((word >> 56n) & 3n);
  return (bit(58) ? 1 : 0) | (mode === 1 ? 2 : 0) | (mode === 3 ? 4 : 0)
    | (bit(59) ? 8 : 0) | (bit(60) ? 16 : 0) | (bit(61) ? 32 : 0);
}

test("X1's ControlWord decodes to the same bits as its FMSControlData: disabled, with the driver station attached", () => {
  /* The mirror first, on words whose meaning is known: the top byte 0x05 is enabled in autonomous, 0x27
     enabled in utility with the DS, 0x08 e-stopped. */
  assert.equal(controlWord("0000000000000005"), 1 | 2);
  assert.equal(controlWord("0000000000000027"), 1 | 4 | 32);
  assert.equal(controlWord("0000000000000008"), 8);

  const word = capture.values["/FMSInfo/ControlWord"];
  assert.equal(word.t, "raw");
  const legacy = controlWord(word.v);
  if (x1.has("/FMSInfo/FMSControlData")) assert.equal(legacy, x1.num("/FMSInfo/FMSControlData"));
  assert.equal(legacy & 1, 0, "disabled");
  assert.equal(legacy & 8, 0, "not e-stopped");
  assert.equal(legacy & 16, 0, "not on a field");
  assert.equal(legacy & 32, 32, "the driver station attached");
});
