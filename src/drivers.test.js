import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addDriver,
  captureRobot,
  makeDriver,
  readDrivers,
  readRobotSettings,
  robotPlan,
  ROBOT_MAX,
  setRobotSetting,
  switchDriver,
  writeDrivers,
} from "./drivers.js";

const DEADBAND = "/Catalyst/Tunables/drive.deadband";
const SLEW = "/Catalyst/Tunables/drive.slew";
const ASSIST = "/Catalyst/Tunables/drive.assist";

/** A store of one profile carrying the settings given, the way the panel builds one. */
function one(robot) {
  const driver = makeDriver({ name: "Kit", robot });
  return { store: addDriver({ list: [], active: null }, driver).store, id: driver.id };
}

/* ---- what a profile may carry ---- */

test("a setting is a number or a switch, and nothing else survives the read", () => {
  const kept = readRobotSettings({
    [DEADBAND]: 0.07,
    [SLEW]: 0,
    [ASSIST]: false,
    "/a/string": "0.07",
    "/a/nan": Number.NaN,
    "/an/infinity": Number.POSITIVE_INFINITY,
    "/an/object": { v: 1 },
    "/an/array": [1, 2],
    "/a/null": null,
  });
  /* Zero and false are settings, not absences: a driver who wants no deadband at all has asked for
     something, and testing these for falsiness would throw both of them away. */
  assert.deepEqual(kept, { [DEADBAND]: 0.07, [SLEW]: 0, [ASSIST]: false });
});

test("storage holding anything at all reads as no settings rather than as a refusal", () => {
  for (const raw of [null, undefined, "deadband", 7, [DEADBAND], { }]) {
    assert.deepEqual(readRobotSettings(raw), {});
  }
});

test("a profile out of storage keeps its robot settings and drops the unwritable ones", () => {
  const store = readDrivers(JSON.stringify({
    active: "d1",
    list: [{ id: "d1", name: "Kit", colour: "moss", robot: { [DEADBAND]: 0.07, "/bad": "x" } }],
  }));
  assert.deepEqual(store.list[0].robot, { [DEADBAND]: 0.07 });
});

test("a profile written from a version that had never heard of robot settings still reads", () => {
  const store = readDrivers(JSON.stringify({ active: "d1", list: [{ id: "d1", name: "Kit" }] }));
  assert.deepEqual(store.list[0].robot, {});
});

test("settings survive the round trip to storage and back", () => {
  const { store, id } = one({ [DEADBAND]: 0.07, [ASSIST]: true });
  const back = readDrivers(writeDrivers(store));
  assert.deepEqual(back.list[0].robot, { [DEADBAND]: 0.07, [ASSIST]: true });
  assert.equal(back.list[0].id, id);
});

test("no more settings are read than a profile may carry", () => {
  const raw = {};
  for (let i = 0; i < ROBOT_MAX + 6; i++) raw[`/Catalyst/Tunables/k${i}`] = i;
  assert.equal(Object.keys(readRobotSettings(raw)).length, ROBOT_MAX);
});

/* ---- editing one ---- */

test("a setting is set, replaced and dropped, and the other profiles are left alone", () => {
  const first = makeDriver({ name: "Kit" });
  const second = makeDriver({ name: "Robin" });
  let store = addDriver(addDriver({ list: [], active: null }, first).store, second).store;

  store = setRobotSetting(store, first.id, DEADBAND, 0.07);
  store = setRobotSetting(store, first.id, DEADBAND, 0.12);
  assert.deepEqual(store.list[0].robot, { [DEADBAND]: 0.12 });
  assert.deepEqual(store.list[1].robot, {}, "a driver's deadband is not the operator's");

  store = setRobotSetting(store, first.id, DEADBAND, null);
  assert.deepEqual(store.list[0].robot, {});
});

test("a value the console could not write is not stored", () => {
  const { store, id } = one();
  assert.deepEqual(setRobotSetting(store, id, DEADBAND, "0.07").list[0].robot, {});
  assert.deepEqual(setRobotSetting(store, id, DEADBAND, Number.NaN).list[0].robot, {});
  assert.deepEqual(setRobotSetting(store, id, "", 0.07).list[0].robot, {});
});

test("at the cap a new setting is refused, and the ones already carried still move", () => {
  const raw = {};
  for (let i = 0; i < ROBOT_MAX; i++) raw[`/Catalyst/Tunables/k${i}`] = i;
  const { store, id } = one(raw);
  assert.deepEqual(setRobotSetting(store, id, DEADBAND, 0.07).list[0].robot, raw);
  assert.equal(setRobotSetting(store, id, "/Catalyst/Tunables/k0", 99).list[0].robot["/Catalyst/Tunables/k0"], 99);
});

/* ---- taking what the robot has ---- */

test("taking from the robot replaces what is carried and leaves a reading that did not arrive standing", () => {
  const { store, id } = one({ [DEADBAND]: 0.07, [SLEW]: 6.5 });
  const after = captureRobot(store, id, { [DEADBAND]: 0.1, [SLEW]: null });
  assert.deepEqual(after.list[0].robot, { [DEADBAND]: 0.1, [SLEW]: 6.5 });
});

test("taking from the robot can add a setting the profile did not carry", () => {
  const { store, id } = one();
  assert.deepEqual(captureRobot(store, id, { [ASSIST]: false }).list[0].robot, { [ASSIST]: false });
});

/* ---- switching profile ---- */

test("switching hands the incoming profile's settings over to be applied", () => {
  const first = makeDriver({ name: "Kit", robot: { [DEADBAND]: 0.07 } });
  const second = makeDriver({ name: "Robin", robot: { [DEADBAND]: 0.02 } });
  const store = addDriver(addDriver({ list: [], active: null }, first).store, second, null).store;
  const result = switchDriver(store, first.id, { layout: [] });
  assert.deepEqual(result.restore.robot, { [DEADBAND]: 0.07 });
});

test("the profile being put away does not swallow whatever the robot is set to", () => {
  /* The board is captured on the way out, on purpose. The robot's settings are not: what it holds now
     may be something somebody changed in Tune between matches, and a profile that took it would hand it
     back the next time that driver picked up the sticks. */
  const first = makeDriver({ name: "Kit", robot: { [DEADBAND]: 0.07 } });
  const second = makeDriver({ name: "Robin" });
  const store = addDriver(addDriver({ list: [], active: null }, first).store, second, null).store;
  const result = switchDriver(store, first.id, { layout: [{ type: "gauge" }], robot: { [DEADBAND]: 0.2 } });
  const robin = result.store.list.find((d) => d.id === second.id);
  assert.deepEqual(robin.robot, {});
  assert.equal(robin.layout.length, 1, "the board it was left with is remembered");
});

test("switching to a profile that is not there applies nothing", () => {
  const { store } = one({ [DEADBAND]: 0.07 });
  assert.deepEqual(switchDriver(store, "nobody").restore.robot, {});
});

/* ---- what would be written ---- */

const DECLARED = [
  { key: DEADBAND, name: "Deadband", kind: "num", min: 0, max: 0.3, step: 0.005 },
  { key: ASSIST, name: "Bump assist", kind: "bool" },
];

test("only what this robot declared is written, and what it did not is counted, not guessed", () => {
  const driver = makeDriver({ name: "Kit", robot: { [DEADBAND]: 0.07, [SLEW]: 6.5 } });
  const plan = robotPlan(driver, DECLARED);
  assert.deepEqual(plan.ready, [{ key: DEADBAND, value: 0.07 }]);
  assert.equal(plan.missing, 1);
  /* Three rows for two settings and one leftover: everything the robot declares is a row whether or not
     this profile has an opinion about it - the robot is what says which settings exist, and a driver
     should not have to name a tunable to find it - and the profile's own leftover is a row as well. */
  assert.equal(plan.rows.length, 3);
  /* Declared and held. */
  assert.equal(plan.rows[0].key, DEADBAND);
  assert.equal(plan.rows[0].set, true);
  assert.equal(plan.rows[0].writable, true);
  /* Declared and not held: shown, following whatever the robot has, and not written on a switch. */
  assert.equal(plan.rows[1].key, ASSIST);
  assert.equal(plan.rows[1].set, false);
  assert.equal(plan.rows[1].value, null);
  assert.equal(plan.rows[1].writable, false);
  /* Held and no longer declared. The row stays: a profile carrying a setting this robot has no idea
     about is worth seeing as a dash, because the alternative is it quietly disappearing on the one
     robot that lacks it. */
  assert.equal(plan.rows[2].key, SLEW);
  assert.equal(plan.rows[2].entry, null);
  assert.equal(plan.rows[2].writable, false);
  assert.equal(plan.rows[2].set, true);
});

test("a profile that has set nothing still sees every setting the robot has", () => {
  const plan = robotPlan(makeDriver({ name: "New" }), DECLARED);
  assert.equal(plan.rows.length, 2);
  assert.deepEqual(plan.ready, [], "and writes none of them, because it has no opinion about any");
  assert.equal(plan.missing, 0, "nothing is missing: it is simply following the robot");
});

test("a setting whose topic has changed type on the robot is not written", () => {
  const driver = makeDriver({ name: "Kit", robot: { [ASSIST]: 0.4 } });
  const plan = robotPlan(driver, DECLARED);
  assert.deepEqual(plan.ready, []);
  assert.equal(plan.missing, 1);
});

test("a declared key that is neither a number nor a switch on the wire is not written either", () => {
  /* A tunable published as a string, or as an array, is a topic this console has no control for. The
     type has to be named rather than merely not "bool", or every one of them would look like a number. */
  const driver = makeDriver({ name: "Kit", robot: { [SLEW]: 6.5 } });
  assert.deepEqual(robotPlan(driver, [{ key: SLEW, kind: "str" }]).ready, []);
});

test("a key the robot declared but has not published yet is still writable", () => {
  /* The manifest can arrive before the value does. The robot named the key, which is the whole of the
     permission this console needs. */
  const driver = makeDriver({ name: "Kit", robot: { [SLEW]: 6.5 } });
  const plan = robotPlan(driver, [{ key: SLEW, name: "Slew limit", kind: null }]);
  assert.deepEqual(plan.ready, [{ key: SLEW, value: 6.5 }]);
  assert.equal(plan.missing, 0);
});

test("a switch and a zero are written like anything else", () => {
  const driver = makeDriver({ name: "Kit", robot: { [DEADBAND]: 0, [ASSIST]: false } });
  const plan = robotPlan(driver, DECLARED);
  assert.deepEqual(plan.ready, [{ key: DEADBAND, value: 0 }, { key: ASSIST, value: false }]);
});

test("a profile with nothing to apply, and a robot declaring nothing, both plan nothing", () => {
  assert.deepEqual(robotPlan(makeDriver({ name: "Kit" }), DECLARED).ready, []);
  assert.equal(robotPlan(makeDriver({ name: "Kit", robot: { [DEADBAND]: 0.07 } }), []).missing, 1);
  assert.deepEqual(robotPlan(null).rows, [], "no profile at all is no plan, not a throw");
});

test("a manifest with junk entries in it declares nothing extra", () => {
  const driver = makeDriver({ name: "Kit", robot: { [DEADBAND]: 0.07 } });
  const plan = robotPlan(driver, [null, "deadband", { name: "no key" }, { key: "" }, ...DECLARED]);
  assert.deepEqual(plan.ready, [{ key: DEADBAND, value: 0.07 }]);
});
