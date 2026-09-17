import { test } from "node:test";
import assert from "node:assert/strict";

import {
  clampToField,
  countState,
  deviceSummary,
  limelightFix,
  notices,
  ROBOT_HALF_METERS,
  robotPlacement,
  VISION_FRESH_MS,
} from "./devices.js";

/** A fake read-only NetworkTables view. Values are {t, v} the way app.js stores them. */
function view(values, { linked = true } = {}) {
  const v = values;
  return {
    linked,
    has: (k) => v[k] !== undefined,
    keys: () => Object.keys(v),
    num: (k, f = null) => (v[k] && v[k].t === "num" ? v[k].v : v[k] && v[k].t === "bool" ? (v[k].v ? 1 : 0) : f),
    bool: (k, f = null) => (v[k] && v[k].t === "bool" ? v[k].v : v[k] && v[k].t === "num" ? v[k].v !== 0 : f),
    str: (k, f = null) => (v[k] && v[k].t === "str" ? v[k].v : f),
    arr: (k) => (v[k] && (v[k].t === "strs" || v[k].t === "nums") ? v[k].v : null),
  };
}

/* ---- field clamp ---- */

test("a pose inside the field is unchanged", () => {
  const r = clampToField([8.0, 4.0, 1.0], 16.54, 8.07);
  assert.deepEqual(r, { x: 8.0, y: 4.0, theta: 1.0, clamped: false });
});

test("a pose at the corner is pulled in by half a robot and flagged", () => {
  const r = clampToField([0, 0, 0], 16.54, 8.07);
  assert.equal(r.x, ROBOT_HALF_METERS);
  assert.equal(r.y, ROBOT_HALF_METERS);
  assert.equal(r.clamped, true);
});

test("a pose far outside is held to the far wall", () => {
  const r = clampToField([40, -3, 2], 16.54, 8.07);
  assert.equal(r.x, 16.54 - ROBOT_HALF_METERS);
  assert.equal(r.y, ROBOT_HALF_METERS);
  assert.equal(r.theta, 2);
  assert.equal(r.clamped, true);
});

test("an unusable pose is null, not a guess", () => {
  assert.equal(clampToField(null, 16.54, 8.07), null);
  assert.equal(clampToField([1, NaN, 0], 16.54, 8.07), null);
  assert.equal(clampToField([1, 2], 16.54, 8.07), null);
});

/* ---- device summary ---- */

test("the roster wins when the robot publishes one", () => {
  const r = deviceSummary(view({
    "/Catalyst/Devices/Cameras/Expected": { t: "num", v: 4 },
    "/Catalyst/Devices/Cameras/Connected": { t: "num", v: 3 },
    "/Catalyst/Devices/Cameras/Rows": { t: "strs", v: ["limelight-left|true|Limelight", "limelight-right|false|Limelight"] },
    "/Catalyst/Devices/Motors/Expected": { t: "num", v: 20 },
    "/Catalyst/Devices/Motors/Connected": { t: "num", v: 20 },
    "/Catalyst/Devices/Motors/Rows": { t: "strs", v: ["frontLeft|can_s0|3|true"] },
    "/Catalyst/Devices/Controller/Kind": { t: "str", v: "Systemcore" },
    "/Catalyst/Devices/Controller/Connected": { t: "bool", v: true },
    "/limelight-ground/tv": { t: "num", v: 0 },   // must not double count
  }));
  assert.equal(r.cameras.expected, 4);
  assert.equal(r.cameras.connected, 3);
  assert.equal(r.cameras.source, "roster");
  assert.deepEqual(r.cameras.rows[1], { name: "limelight-right", connected: false, detail: "Limelight" });
  assert.equal(r.motors.connected, 20);
  assert.deepEqual(r.motors.rows[0], { name: "frontLeft", connected: true, detail: "can_s0 · 3" });
  assert.equal(r.controller.kind, "Systemcore");
  assert.equal(r.controller.connected, true);
  assert.equal(r.any, true);
});

test("without a roster, cameras are counted from their tables and say so", () => {
  const r = deviceSummary(view({
    "/limelight-shooter/tv": { t: "num", v: 1 },
    "/limelight-shooter/hb": { t: "num", v: 9 },
    "/limelight-left/tv": { t: "num", v: 0 },
    "/CameraPublisher/limelight-shooter/streams": { t: "strs", v: [] },
  }));
  assert.equal(r.cameras.expected, 2);
  assert.equal(r.cameras.connected, null);
  assert.equal(r.cameras.source, "topics");
  assert.deepEqual(r.cameras.rows.map((x) => x.name), ["limelight-left", "limelight-shooter"]);
});

test("without a roster, motors come from the spec sheet's device tree", () => {
  const r = deviceSummary(view({
    "/Catalyst/Robot/Hardware/Devices": { t: "strs", v: ["can_s0|3|TalonFX", "can_s0|23|Pigeon2", "can_s1|7|Kraken X60"] },
    "/Catalyst/Robot/Identity/Controller": { t: "str", v: "Systemcore" },
  }));
  assert.equal(r.motors.expected, 2);
  assert.equal(r.motors.connected, null);
  assert.equal(r.motors.source, "spec");
  assert.equal(r.controller.kind, "Systemcore");
  assert.equal(r.controller.source, "identity");
});

test("nothing known is nothing shown", () => {
  const r = deviceSummary(view({}, { linked: false }));
  assert.equal(r.any, false);
});

test("count states colour the fraction", () => {
  assert.equal(countState({ expected: 0, connected: null }), "none");
  assert.equal(countState({ expected: 4, connected: null }), "seen");
  assert.equal(countState({ expected: 4, connected: 4 }), "ok");
  assert.equal(countState({ expected: 4, connected: 2 }), "warn");
  assert.equal(countState({ expected: 4, connected: 0 }), "bad");
});

/* ---- notices ---- */

test("a faulting camera becomes a warning with the robot's own detail", () => {
  const n = notices(view({
    "/Catalyst/Vision/Health/Level": { t: "num", v: 1 },
    "/Catalyst/Vision/Health/Summary": { t: "str", v: "3 of 4 cameras healthy: limelight-left disconnected" },
    "/Catalyst/Vision/Health/Rows": { t: "strs", v: [
      "limelight-left|DISCONNECTED|no data from the camera|||false",
      "limelight-shooter|OK|100% accepted|56.0|71.6|true",
      "limelight-right|NO_TARGETS|no usable target|55.0|65.0|true",
    ] },
  }));
  assert.deepEqual(n, [
    { level: "warn", key: "vision:limelight-left", text: "limelight-left: no data from the camera", detail: "" },
  ]);
});

test("blind vision is an error above the camera warnings, and robot errors come first", () => {
  const n = notices(view({
    "/Catalyst/Alerts/Errors": { t: "strs", v: ["[Drive] Front-left motor over temperature"] },
    "/Catalyst/Vision/Health/Level": { t: "num", v: 2 },
    "/Catalyst/Vision/Health/Summary": { t: "str", v: "0 of 2 cameras healthy: a disconnected, b disconnected" },
    "/Catalyst/Vision/Health/Rows": { t: "strs", v: ["a|DISCONNECTED|no data|||false", "b|HOT|91 C, ceiling 80 C||91.0|true"] },
  }));
  assert.deepEqual(n.map((x) => [x.level, x.key]), [
    ["error", "alert:[Drive] Front-left motor over temperature"],
    ["error", "vision:blind"],
    ["warn", "vision:a"],
    ["warn", "vision:b"],
  ]);
  assert.equal(n[3].text, "b: running hot");
  assert.equal(n[3].detail, "91 C, ceiling 80 C", "a detail that adds a number is kept");
});

test("the auto start check speaks only while disabled", () => {
  const values = {
    "/Catalyst/Auto/StartCheck/Available": { t: "bool", v: true },
    "/Catalyst/Auto/StartCheck/Ready": { t: "bool", v: false },
    "/Catalyst/Auto/StartCheck/DistanceMeters": { t: "num", v: 0.4213 },
    "/Catalyst/Auto/StartCheck/HeadingErrorDeg": { t: "num", v: -12.4 },
  };
  const disabled = notices(view(values), { enabled: false });
  assert.deepEqual(disabled, [{ level: "warn", key: "auto:start", text: "Not at the auto's starting pose", detail: "0.42 m, 12° off" }]);
  assert.deepEqual(notices(view(values), { enabled: true }), []);
  values["/Catalyst/Auto/StartCheck/Ready"] = { t: "bool", v: true };
  assert.equal(notices(view(values), { enabled: false })[0].level, "info");
});

test("no health topics means no vision notices, not an error", () => {
  assert.deepEqual(notices(view({})), []);
});

/* ---- where the robot is ---- */

const nums = (v) => ({ t: "nums", v });
/* A MegaTag solve as a Limelight publishes it: x, y, z, roll, pitch, yaw°, latency, tags, span, distance, area. */
const solve = (x, y, yawDeg, tags, distance = 2.5) => nums([x, y, 0, 0, 0, yawDeg, 30, tags, 0.4, distance, 0.3]);
const fresh = () => 0;

test("an estimator pose that has left the origin is the robot's place", () => {
  const read = view({ "/Catalyst/Physics/PoseArray": nums([5.2, 3.1, 0.4]) });
  const place = robotPlacement(read, { age: fresh });
  assert.deepEqual(place.pose, [5.2, 3.1, 0.4]);
  assert.equal(place.source, "estimator");
  assert.equal(place.placed, true);
});

test("an estimator still at the boot origin is not a place: the robot is unplaced, not in the corner", () => {
  const read = view({ "/Catalyst/Physics/PoseArray": nums([0, 0, 1.2]) });
  const place = robotPlacement(read, { age: fresh });
  assert.equal(place.placed, false);
  assert.equal(place.pose, null);
  assert.equal(place.heading, 1.2, "the gyro's heading is still known");
});

test("a live Limelight fix places a robot the estimator has not, with the estimator's heading", () => {
  const read = view({
    "/Catalyst/Physics/PoseArray": nums([0, 0, 1.2]),
    "/limelight-ground/botpose_orb_wpiblue": solve(3.4, 5.6, 40, 2),
    "/limelight-ground/botpose_orb": solve(-4.87, 1.57, 40, 2),
  });
  const place = robotPlacement(read, { age: fresh });
  assert.equal(place.placed, true);
  assert.equal(place.source, "vision");
  assert.equal(place.camera, "limelight-ground");
  assert.deepEqual(place.pose, [3.4, 5.6, 1.2]);
});

test("with no estimator at all, the fix's own heading is used", () => {
  const read = view({ "/limelight-ground/botpose_wpiblue": solve(2, 2, 90, 1) });
  const place = robotPlacement(read, { age: fresh });
  assert.equal(place.placed, true);
  assert.ok(Math.abs(place.pose[2] - Math.PI / 2) < 1e-9);
});

test("a camera that sees nothing publishes zeros, and zeros place nothing", () => {
  const read = view({ "/limelight-ground/botpose_orb_wpiblue": nums([0, 0, 0, 0, 0, 0, 30, 0, 0, 0, 0]) });
  assert.equal(limelightFix(read, { age: fresh }), null);
});

test("an unplaceable tag reads as the field's centre and is refused by its all-zero centre-origin twin", () => {
  const read = view({
    "/limelight-ground/botpose_orb_wpiblue": solve(8.27, 4.035, 0, 1),
    "/limelight-ground/botpose_orb": nums([0, 0, 0, 0, 0, 0, 30, 1, 0, 0, 0]),
  });
  assert.equal(limelightFix(read, { age: fresh }), null);
});

test("a frozen camera's last solve is not a fix", () => {
  const read = view({ "/limelight-ground/botpose_orb_wpiblue": solve(3, 3, 0, 2) });
  assert.equal(limelightFix(read, { age: () => VISION_FRESH_MS + 1 }), null);
  assert.ok(limelightFix(read, { age: () => VISION_FRESH_MS }));
});

test("a solve off the field is not a fix", () => {
  const read = view({ "/limelight-ground/botpose_wpiblue": solve(22, 3, 0, 2) });
  assert.equal(limelightFix(read, { age: fresh }), null);
});

test("MegaTag2 is preferred to MegaTag1 on the same camera", () => {
  const read = view({
    "/limelight-ground/botpose_orb_wpiblue": solve(3.0, 3.0, 0, 2),
    "/limelight-ground/botpose_wpiblue": solve(3.3, 3.3, 0, 2),
  });
  assert.equal(limelightFix(read, { age: fresh }).megatag, 2);
});

test("MegaTag1 stands in when MegaTag2 has nothing", () => {
  const read = view({
    "/limelight-ground/botpose_orb_wpiblue": nums([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    "/limelight-ground/botpose_wpiblue": solve(3.3, 3.3, 0, 1),
  });
  const fix = limelightFix(read, { age: fresh });
  assert.equal(fix.megatag, 1);
  assert.equal(fix.x, 3.3);
});

test("the camera seeing the most tags wins, then the nearer tags", () => {
  const read = view({
    "/limelight-left/botpose_orb_wpiblue": solve(3.0, 3.0, 0, 1, 1.0),
    "/limelight-right/botpose_orb_wpiblue": solve(3.1, 3.1, 0, 3, 4.0),
    "/limelight-shooter/botpose_orb_wpiblue": solve(3.2, 3.2, 0, 3, 2.0),
  });
  assert.equal(limelightFix(read, { age: fresh }).camera, "limelight-shooter");
});

test("cameras named by Catalyst's vision health are looked in even before their tables are listed", () => {
  const read = view({
    "/Catalyst/Vision/Health/Names": { t: "strs", v: ["limelight-ground"] },
    "/limelight-ground/botpose_orb_wpiblue": solve(4, 4, 0, 2),
  });
  assert.equal(limelightFix(read, { age: fresh }).camera, "limelight-ground");
});
