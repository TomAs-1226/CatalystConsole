import { test } from "node:test";
import assert from "node:assert/strict";
import { parkIdentity, selectedAutoStart, shotAtFieldPose } from "./park-state.js";

const num = (v) => ({ t: "num", v });
const bool = (v) => ({ t: "bool", v });
const str = (v) => ({ t: "str", v });
const nums = (v) => ({ t: "nums", v });
function view(values, linked = true) {
  return {
    linked,
    raw: (key) => values[key],
    has: (key) => Object.hasOwn(values, key),
    num: (key, fallback = null) => values[key]?.t === "num" ? values[key].v : fallback,
    bool: (key, fallback = null) => values[key]?.t === "bool" ? values[key].v : fallback,
    str: (key, fallback = null) => values[key]?.t === "str" ? values[key].v : fallback,
    arr: (key) => values[key]?.t === "nums" ? values[key].v : null,
  };
}

test("connected disabled Numbers retains configured team and native Blue alliance when Systemcore says zero", () => {
  const read = view({
    "/DriverStation/ControlWord": num(32),
    "/DriverStation/IsRedAlliance": bool(false),
    "/FMSInfo/IsRedAlliance": bool(true),
    "/Catalyst/Systemcore/TeamNumber": num(0),
  });
  assert.deepEqual(parkIdentity(read, { configuredTeam: 5805 }), { team: 5805, alliance: "blue" });
});

test("published team identity takes precedence over saved connection settings", () => {
  assert.equal(parkIdentity(view({ "/Catalyst/Robot/Identity/TeamNumber": num(581) }), { configuredTeam: 5805 }).team, 581);
  assert.equal(parkIdentity(view({ "/Catalyst/Systemcore/TeamNumber": num(1234) }), { configuredTeam: 5805 }).team, 1234);
});

test("unknown or malformed identities never invent a team or alliance", () => {
  const read = view({ "/Catalyst/Systemcore/TeamNumber": bool(true), "/DriverStation/IsRedAlliance": num(0) });
  for (const configuredTeam of [null, 0, NaN, -1, 10000, 5805.5, "5805"]) {
    assert.deepEqual(parkIdentity(read, { configuredTeam }), { team: null, alliance: null });
  }
});

test("disconnected Park uses remembered team only and clears cached alliance", () => {
  const read = view({ "/DriverStation/IsRedAlliance": bool(false), "/Catalyst/Systemcore/TeamNumber": num(5805) }, false);
  assert.deepEqual(parkIdentity(read, { configuredTeam: 5805, rememberedTeam: 581 }), { team: 581, alliance: null });
});

const startData = () => ({
  "/Auto Selector/selected": str("Left shallow"),
  "/Catalyst/Auto/StartCheck/Available": bool(true),
  "/Catalyst/Auto/StartCheck/Expected": nums([2, 3, Math.PI / 2]),
  "/Catalyst/Auto/StartCheck/Current": nums([12, 6, 0]),
  "/Catalyst/Physics/PoseArray": nums([12, 6, 0]),
});

test("auto handover starts at the published selected-auto pose while actual telemetry remains unchanged", () => {
  const values = startData();
  const before = structuredClone(values);
  const start = selectedAutoStart(view(values));
  assert.deepEqual(start, [2, 3, Math.PI / 2]);
  assert.deepEqual(values, before);
  start[0] = 99;
  assert.equal(values["/Catalyst/Auto/StartCheck/Expected"].v[0], 2, "handover cannot mutate NT storage");
});

test("unpublished or unavailable start fades rather than using current, parked or origin coordinates", () => {
  for (const available of [bool(false), num(1), undefined]) {
    assert.equal(selectedAutoStart(view({ ...startData(), "/Catalyst/Auto/StartCheck/Available": available })), null);
  }
  assert.equal(selectedAutoStart(view({ ...startData(), "/Catalyst/Auto/StartCheck/Expected": undefined })), null);
});

test("invalid, off-field, disconnected and unselected starts are refused", () => {
  for (const pose of [[NaN, 3, 0], [2, 3], [-1, 3, 0], [20, 3, 0], [2, 10, 0]]) {
    assert.equal(selectedAutoStart(view({ ...startData(), "/Catalyst/Auto/StartCheck/Expected": nums(pose) })), null);
  }
  assert.equal(selectedAutoStart(view(startData(), false)), null);
  assert.equal(selectedAutoStart(view({ ...startData(), "/Auto Selector/selected": str("") })), null);
});

test("visual shot uses selected start position and heading without moving camera or live pose", () => {
  const shot = { eye: [2, 5, -1], look: [0, 0, -1], fov: 50 };
  const pose = [10, 5, Math.PI / 2]; // scene x=2,z=-1 on a 16x8 field.
  const before = structuredClone(shot);
  const local = shotAtFieldPose(shot, pose, 16, 8);
  assert.ok(Math.abs(local.eye[0]) < 1e-9);
  assert.equal(local.eye[1], 5);
  assert.ok(Math.abs(local.look[2] + 2) < 1e-9);
  assert.equal(local.fov, 50);
  assert.deepEqual(shot, before);
  assert.deepEqual(pose, [10, 5, Math.PI / 2]);
});
