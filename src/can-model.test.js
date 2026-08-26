import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUSY_DEVICE_COUNT,
  barWidth,
  busKind,
  contentionWarnings,
  controllerGroup,
  hasErrorActivity,
  layout,
  normalizeBus,
  parseDevices,
  parsePreflightCan,
  sharesController,
  utilizationOf,
  utilizationText,
} from "./can-model.js";

// What is being pinned down here is a fact about the hardware, not a formatting preference:
// Systemcore's five CAN buses hang off three SPI controllers, and two buses on one controller
// throttle each other in a way two buses on different controllers do not. Every grouping and every
// warning below follows from that. Get it wrong and the page confidently tells a team that moving a
// motor from can_s0 to can_s1 fixed their problem.

/** A device row in the shape CANRegistry.Entry.serialize() writes: bus|canId|type|name. */
const dev = (bus, id, type, name) => `${bus}|${id}|${type}|${name}`;

/** n devices on one bus, ids from 1, so a count-based rule can be pushed over its threshold. */
const fill = (bus, n, from = 1) =>
  Array.from({ length: n }, (_, i) => dev(bus, from + i, "TalonFX", `${bus}-${from + i}`));

// --- the pairing ------------------------------------------------------------

test("the buses group onto the controllers the hardware actually has", () => {
  // Read out of the Systemcore OS image and encoded in CatalystCANBus.controllerGroup():
  // can_s0 + can_s1 share one SPI host, can_s3 + can_s4 share another, can_s2 sits alone.
  assert.equal(controllerGroup("can_s0"), 0);
  assert.equal(controllerGroup("can_s1"), 0);
  assert.equal(controllerGroup("can_s2"), 1);
  assert.equal(controllerGroup("can_s3"), 2);
  assert.equal(controllerGroup("can_s4"), 2);
});

test("a CANivore belongs to no Systemcore controller", () => {
  // It brings its own. Filing it under one of the three would claim a contention that does not
  // exist, which is the same class of mistake as missing one that does.
  assert.equal(controllerGroup("canivore"), -1);
  assert.equal(controllerGroup("can_d3"), -1);
  assert.equal(controllerGroup(""), -1);
});

test("buses that share a controller are the ones that fight", () => {
  assert.equal(sharesController("can_s0", "can_s1"), true);
  assert.equal(sharesController("can_s3", "can_s4"), true);
  // The whole point of the page: these two look identical on paper to the pair above and are not.
  assert.equal(sharesController("can_s0", "can_s2"), false);
  assert.equal(sharesController("can_s1", "can_s3"), false);
});

test("a bus does not fight itself", () => {
  // "Will loading these two throttle each other" has one answer for one bus, and it is no.
  assert.equal(sharesController("can_s0", "can_s0"), false);
  assert.equal(sharesController("can_s2", "can_s2"), false);
});

// --- bus names --------------------------------------------------------------

test("three spellings of one wire resolve to one bus", () => {
  // The library hit this for real: an elevator on the default bus and an intake on .canBus("can_s0")
  // are on the same wire, and keying on the raw string split them into two half-loaded buses.
  assert.equal(normalizeBus(""), "can_s0");
  assert.equal(normalizeBus(null), "can_s0");
  assert.equal(normalizeBus("0"), "can_s0");
  assert.equal(normalizeBus("can_s0"), "can_s0");
  assert.equal(normalizeBus(" can_s2 "), "can_s2");
});

test("a name that is not an index is a CANivore name, left alone", () => {
  assert.equal(normalizeBus("drivebase"), "drivebase");
  assert.equal(busKind("drivebase"), "canivore");
  assert.equal(busKind("can_s4"), "systemcore");
  assert.equal(busKind("can_d19"), "motioncore");
});

test("an out-of-range index does not take the page down", () => {
  // The library throws here. A console cannot: a nonsense bus name is worth showing a reader, and
  // it is never worth an exception on the paint path.
  assert.equal(normalizeBus("9"), "9");
  assert.equal(busKind("can_s9"), "canivore");
  assert.equal(controllerGroup("can_s9"), -1);
});

// --- the device list --------------------------------------------------------

test("a device row parses into the four things a pit crew asks for", () => {
  assert.deepEqual(parseDevices([dev("can_s0", 12, "Kraken X60", "FrontLeftDrive")]), [
    { bus: "can_s0", id: 12, type: "Kraken X60", name: "FrontLeftDrive" },
  ]);
});

test("a device name containing a pipe survives", () => {
  // The name is a string a team wrote and the separator is not reserved from them. Everything past
  // the third pipe is the name.
  const [d] = parseDevices(["can_s1|4|CANcoder|Arm|Elbow"]);
  assert.equal(d.name, "Arm|Elbow");
  assert.equal(d.id, 4);
});

test("rows that cannot be a device are dropped, not shown with holes", () => {
  assert.deepEqual(parseDevices(["can_s0|3", "", "can_s0|x|TalonFX|Bad", null]), []);
  assert.deepEqual(parseDevices(null), []);
  assert.deepEqual(parseDevices(undefined), []);
});

test("devices come back ordered by bus then id", () => {
  const rows = parseDevices([
    dev("can_s1", 3, "TalonFX", "B"),
    dev("can_s0", 9, "TalonFX", "C"),
    dev("can_s0", 2, "TalonFX", "A"),
  ]);
  assert.deepEqual(rows.map((d) => d.name), ["A", "C", "B"]);
});

test("the registry's own spelling and an older robot's agree after parsing", () => {
  // A 1.x robot publishes the raw bus string it was handed. Both rows are one bus.
  const rows = parseDevices([dev("", 1, "TalonFX", "Old"), dev("can_s0", 2, "TalonFX", "New")]);
  assert.deepEqual([...new Set(rows.map((d) => d.bus))], ["can_s0"]);
});

// --- where a utilisation figure comes from ----------------------------------

test("the OS measurement wins for a Systemcore bus", () => {
  // The Systemcore page draws this same number. Two surfaces of one console disagreeing about one
  // bus is worse than either being a frame stale.
  const os = [0.4, 0, 0, 0, 0];
  assert.deepEqual(utilizationOf("can_s0", os, { utilization: 0.9 }), { value: 0.4, source: "os" });
});

test("Phoenix fills in where the OS array cannot reach", () => {
  // A CANivore has no index in the OS array, and error counters only ever come from Phoenix.
  assert.deepEqual(utilizationOf("drivebase", [0.4, 0, 0, 0, 0], { utilization: 0.22 }),
    { value: 0.22, source: "phoenix" });
  assert.deepEqual(utilizationOf("can_s3", null, { utilization: 0.31 }),
    { value: 0.31, source: "phoenix" });
});

test("no reading is null, and says which source it came from by saying neither", () => {
  assert.deepEqual(utilizationOf("can_s0", null, null), { value: null, source: null });
  assert.deepEqual(utilizationOf("can_s0", [], null), { value: null, source: null });
});

// --- the model the page draws -----------------------------------------------

test("every Systemcore bus is drawn even with no robot at all", () => {
  // An empty bus is the most useful thing on this page — it is where the next mechanism goes — and a
  // view that only lists buses somebody already used cannot show that.
  const m = layout({});
  assert.deepEqual(m.controllers.map((c) => c.name),
    ["Controller 1", "Controller 2", "Controller 3"]);
  assert.deepEqual(m.controllers.flatMap((c) => c.buses.map((b) => b.name)),
    ["can_s0", "can_s1", "can_s2", "can_s3", "can_s4"]);
  assert.equal(m.deviceCount, 0);
  assert.equal(m.busiest, null);
});

test("a bus nobody measured is not an idle bus", () => {
  // The rule the whole page rests on. 0% and no answer render identically as a bar and mean
  // opposite things, and the wrong one of them is reassuring.
  const [c] = layout({}).controllers;
  assert.equal(c.buses[0].utilization, null);
  assert.equal(c.buses[0].idle, false);

  const measured = layout({ osUtilization: [0, 0, 0, 0, 0] }).controllers[0];
  assert.equal(measured.buses[0].utilization, 0);
  assert.equal(measured.buses[0].idle, true);
});

test("a shared controller carries the total, because the total is what binds", () => {
  const m = layout({ osUtilization: [0.55, 0.5, 0.1, 0, 0] });
  assert.equal(m.controllers[0].shared, true);
  assert.ok(Math.abs(m.controllers[0].utilization - 1.05) < 1e-9);
  // can_s2 is alone, so its group total is its own figure.
  assert.equal(m.controllers[1].shared, false);
  assert.ok(Math.abs(m.controllers[1].utilization - 0.1) < 1e-9);
});

test("a half-measured pair has no total rather than a low one", () => {
  const m = layout({ osUtilization: [0.55, NaN, 0, 0, 0] });
  assert.equal(m.controllers[0].buses[1].utilization, null);
  assert.equal(m.controllers[0].utilization, null);
});

test("a CANivore gets its own group rather than being filed under a controller", () => {
  const m = layout({ devices: parseDevices([dev("drivebase", 1, "TalonFX", "FL")]) });
  assert.equal(m.controllers.length, 4);
  assert.equal(m.controllers[3].group, -1);
  assert.deepEqual(m.controllers[3].buses.map((b) => b.name), ["drivebase"]);
});

test("devices land on the bus they are actually on", () => {
  const m = layout({
    devices: parseDevices([
      dev("can_s0", 1, "Kraken X60", "FL"),
      dev("can_s2", 30, "Pigeon2", "Gyro"),
    ]),
  });
  assert.deepEqual(m.controllers[0].buses[0].devices.map((d) => d.name), ["FL"]);
  assert.deepEqual(m.controllers[1].buses[0].devices.map((d) => d.name), ["Gyro"]);
  assert.equal(m.controllers[0].deviceCount, 1);
  assert.equal(m.deviceCount, 2);
});

// --- contention -------------------------------------------------------------

test("a quiet robot raises nothing", () => {
  const m = layout({
    devices: parseDevices(fill("can_s0", 8)),
    osUtilization: [0.4, 0, 0.1, 0, 0],
  });
  assert.deepEqual(contentionWarnings(m), []);
});

test("everything piled on one bus is worth saying out loud", () => {
  const m = layout({ devices: parseDevices(fill("can_s0", BUSY_DEVICE_COUNT + 1)) });
  const w = contentionWarnings(m);
  assert.equal(w.length, 1);
  assert.match(w[0].text, /can_s0 carries 13 devices/);
  assert.deepEqual(w[0].buses, ["can_s0"]);
});

test("a load split across a shared pair is still a load on one controller", () => {
  // The failure this page exists for. Seven and six devices, neither bus over the count on its own,
  // and on paper they are "on different buses".
  const m = layout({
    devices: parseDevices([...fill("can_s0", 7), ...fill("can_s1", 6, 20)]),
  });
  const w = contentionWarnings(m);
  assert.equal(w.length, 1);
  assert.match(w[0].text, /can_s0 and can_s1 share an SPI controller/);
  assert.deepEqual(w[0].buses, ["can_s0", "can_s1"]);
});

test("the same load split across unpaired buses is fine, and that is the advice", () => {
  const m = layout({
    devices: parseDevices([...fill("can_s0", 7), ...fill("can_s2", 6, 20)]),
  });
  assert.deepEqual(contentionWarnings(m), []);
});

test("a pair over its controller's ceiling is flagged when neither bus looks bad", () => {
  // 55% and 50%: both under the 90% the OS warns at, and together past what one SPI host carries.
  const m = layout({ osUtilization: [0.55, 0.5, 0, 0, 0] });
  const w = contentionWarnings(m);
  assert.equal(w.length, 1);
  assert.equal(w[0].level, "crit");
  assert.match(w[0].text, /together sit at 105%/);
});

test("a single bus past where Systemcore warns is its own finding", () => {
  const m = layout({ osUtilization: [0.94, 0, 0, 0, 0] });
  const w = contentionWarnings(m);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].buses, ["can_s0"]);
  assert.match(w[0].text, /94%/);
});

test("an unpaired bus is never accused of contending with anything", () => {
  // can_s2 alone at 95% is one overloaded bus, not a pair problem, and saying otherwise would send
  // a team looking for a bus that is not there.
  const m = layout({ osUtilization: [0, 0, 0.95, 0, 0] });
  const w = contentionWarnings(m);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].buses, ["can_s2"]);
});

test("a pair with one empty bus is not called a pair problem", () => {
  // Thirteen devices all on can_s0 with can_s1 empty is the concentration finding, which already
  // fired. Repeating it as contention would tell a team to move devices off a bus with none on it.
  const m = layout({ devices: parseDevices(fill("can_s0", 13)) });
  const w = contentionWarnings(m);
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].buses, ["can_s0"]);
});

// --- the robot's own preflight ----------------------------------------------

test("the CAN findings are picked out of a preflight that is mostly about other things", () => {
  const found = parsePreflightCan([
    "[ok]      Commands v3 runtime",
    "[warn]    Storage is filling — 88% used.",
    "[warn]    CAN plan — can_s0 is at an estimated 72% utilisation (target 60%). 14 devices.",
    "[BLOCKER] Battery is below the brownout threshold — 6.40 V against a floor of 6.75 V.",
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].level, "warn");
  assert.match(found[0].text, /^can_s0 is at an estimated 72%/);
});

test("a clean CAN plan is a finding too, and reads as one", () => {
  // "[ok] CAN plan" carries no detail, so the title is the whole message.
  assert.deepEqual(parsePreflightCan(["[ok]      CAN plan"]), [{ level: "ok", text: "CAN plan" }]);
});

test("a detail containing its own em dash is not cut in half", () => {
  const [f] = parsePreflightCan([
    "[warn]    CAN layout — can_s0 and can_s1 share an SPI controller — move some off the pair.",
  ]);
  assert.equal(f.text, "can_s0 and can_s1 share an SPI controller — move some off the pair.");
});

test("no preflight at all is no findings, not an empty verdict", () => {
  assert.deepEqual(parsePreflightCan(null), []);
  assert.deepEqual(parsePreflightCan([]), []);
  assert.deepEqual(parsePreflightCan(["nonsense", ""]), []);
});

// --- how a reading is printed -----------------------------------------------

test("utilisation prints in whole percents", () => {
  // A bus does not hold still to a tenth, and a figure flickering in its last digit reads as
  // instability rather than as precision.
  assert.equal(utilizationText(0.42), "42%");
  assert.equal(utilizationText(0), "0%");
  assert.equal(utilizationText(1.05), "105%");
});

test("no reading prints as nothing, so the caller has to decide what a dash is", () => {
  assert.equal(utilizationText(null), null);
  assert.equal(utilizationText(undefined), null);
  assert.equal(utilizationText(NaN), null);
});

test("a bar never draws past its track", () => {
  // A shared controller's total legitimately exceeds one bus's worth. A bar wider than its track is
  // a layout bug; the number beside it still says 130%.
  assert.equal(barWidth(0.5), 50);
  assert.equal(barWidth(1.3), 100);
  assert.equal(barWidth(-0.2), 0);
  assert.equal(barWidth(null), 0);
});

test("a pair's bar is scaled to what the pair can carry, not to one bus", () => {
  assert.equal(barWidth(0.5, 1), 50);
  assert.equal(barWidth(1.0, 1), 100);
});

// --- error counters ---------------------------------------------------------

test("error counters are read against error-passive, where a controller actually changes state", () => {
  // The leading indicator: counters climb before a bus goes off, which is what turns a loose
  // connector into a pit job instead of an elimination.
  assert.equal(hasErrorActivity({ rec: 0, tec: 0 }), false);
  assert.equal(hasErrorActivity({ rec: 127, tec: 127 }), false);
  assert.equal(hasErrorActivity({ rec: 128, tec: 0 }), true);
  assert.equal(hasErrorActivity({ rec: 0, tec: 200 }), true);
});

test("a bus with no health published has no error activity to report", () => {
  assert.equal(hasErrorActivity(null), false);
  assert.equal(hasErrorActivity({}), false);
});
