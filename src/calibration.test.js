import { test } from "node:test";
import assert from "node:assert/strict";

import { calibrationNotices, SUSPECT_PERCENT } from "./calibration.js";

// Nobody spins a real robot in place to check these; the states here - a NaN mid-turn, a run stopped
// for a reason, a percent change worth a second look - are the ones worth pinning down without one.

/** A fake read-only NetworkTables view. Values are {t, v}, the shape devices.test.js uses. */
function view(values) {
  const v = values;
  return {
    keys: () => Object.keys(v),
    num: (k, f = null) => (v[k] && v[k].t === "num" ? v[k].v : f),
    str: (k, f = null) => (v[k] && v[k].t === "str" ? v[k].v : f),
  };
}
const str = (s) => ({ t: "str", v: s });
const num = (n) => ({ t: "num", v: n });

const BASE = "/Catalyst/Calibration/WheelRadius/";

/* ---- absent ---- */

test("no calibration published is no capsule", () => {
  assert.deepEqual(calibrationNotices(view({})), []);
});

test("a topic under the base with no Status alongside it is not a calibration", () => {
  assert.deepEqual(calibrationNotices(view({ [`${BASE}Junk`]: str("x") })), []);
});

/* ---- running ---- */

test("running shows the turns so far, one decimal", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("running"),
    [`${BASE}AccumRotations`]: num(1.44),
  }));
  assert.equal(n.length, 1);
  assert.equal(n[0].level, "info");
  assert.equal(n[0].text, "Wheel radius calibration · 1.4 turns");
  assert.equal(n[0].detail, "Calibrating");
});

test("running before AccumRotations has published invents no turns figure", () => {
  const n = calibrationNotices(view({ [`${BASE}Status`]: str("running") }));
  assert.equal(n[0].text, "Wheel radius calibration");
});

test("a NaN AccumRotations is treated the same as absent, not as zero", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("running"),
    [`${BASE}AccumRotations`]: num(NaN),
  }));
  assert.equal(n[0].text, "Wheel radius calibration");
});

/* ---- done ---- */

test("done shows the result: inches and the signed percent change", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}CorrectedRadiusInches`]: num(1.931),
    [`${BASE}CorrectedRadiusMeters`]: num(0.04905),
    [`${BASE}PercentChange`]: num(-3.5),
    [`${BASE}Snippet`]: str("kWheelRadius = 0.04905; // m  (was 0.05080, -3.5%)"),
  }));
  assert.equal(n[0].text, "Wheel radius 1.931 in · −3.5%");
  assert.equal(n[0].metresText, "0.04905 m");
  assert.equal(n[0].snippet, "kWheelRadius = 0.04905; // m  (was 0.05080, -3.5%)");
  assert.equal(n[0].hint, undefined);
});

test("a positive percent change reads with a plus, not a bare number", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}CorrectedRadiusInches`]: num(2.05),
    [`${BASE}PercentChange`]: num(1.2),
  }));
  assert.ok(n[0].text.endsWith("+1.2%"), n[0].text);
});

test("done with nothing published yet invents no numbers", () => {
  const n = calibrationNotices(view({ [`${BASE}Status`]: str("done") }));
  assert.equal(n[0].text, "Wheel radius calibration done");
  assert.equal(n[0].snippet, undefined);
  assert.equal(n[0].metresText, undefined);
  assert.equal(n[0].hint, undefined);
});

test("NaN result fields invent no numbers either", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}CorrectedRadiusInches`]: num(NaN),
    [`${BASE}PercentChange`]: num(NaN),
  }));
  assert.equal(n[0].text, "Wheel radius calibration done");
  assert.equal(n[0].hint, undefined);
});

/* ---- the 15% hint ---- */

test("a swing past the suspect threshold, either direction, adds the gear-ratio hint", () => {
  const over = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}PercentChange`]: num(SUSPECT_PERCENT + 0.1),
  }));
  assert.match(over[0].hint, /gear ratio/);

  const negOver = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}PercentChange`]: num(-(SUSPECT_PERCENT + 5)),
  }));
  assert.match(negOver[0].hint, /gear ratio/);
});

test("exactly the threshold is not yet suspect", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}PercentChange`]: num(SUSPECT_PERCENT),
  }));
  assert.equal(n[0].hint, undefined);
});

test("a small change under the threshold gets no hint", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    [`${BASE}PercentChange`]: num(-3.5),
  }));
  assert.equal(n[0].hint, undefined);
});

/* ---- the ways a run does not finish ---- */

test("interrupted is a plain grey capsule", () => {
  const n = calibrationNotices(view({ [`${BASE}Status`]: str("interrupted") }));
  assert.equal(n[0].level, "info");
  assert.equal(n[0].text, "Wheel radius calibration");
  assert.equal(n[0].detail, "Interrupted");
});

test("a stopped run shows the robot's own reason verbatim", () => {
  const reason = "the robot is not turning - 12 deg in 3 s. Is it on blocks, or is the gyro dead?";
  const n = calibrationNotices(view({ [`${BASE}Status`]: str(`stopped: ${reason}`) }));
  assert.equal(n[0].detail, reason);
  assert.equal(n[0].level, "info");
});

test("no motion measured says so", () => {
  const n = calibrationNotices(view({ [`${BASE}Status`]: str("no motion measured") }));
  assert.equal(n[0].detail, "No motion measured");
});

/* ---- generic over the calibration's name ---- */

test("a calibration this does not know by name still shows, from Status alone", () => {
  const n = calibrationNotices(view({ "/Catalyst/Calibration/SteerOffset/Status": str("running") }));
  assert.equal(n.length, 1);
  assert.equal(n[0].text, "Steer offset calibration");
  assert.equal(n[0].snippet, undefined);
});

test("two calibrations at once both show, in name order", () => {
  const n = calibrationNotices(view({
    [`${BASE}Status`]: str("done"),
    "/Catalyst/Calibration/ArmZero/Status": str("running"),
  }));
  assert.deepEqual(n.map((x) => x.key.split(":")[1]), ["ArmZero", "WheelRadius"]);
});

/* ---- a differently-shaped calibration (X1's SlipCurrentMeasurement) reads by its own fields,
 *      not by a name Console was written to expect ---- */

const SLIP = "/Catalyst/Calibration/SlipCurrent/";

test("a calibration with Volts/PeakAmps instead of AccumRotations reads its own progress", () => {
  const n = calibrationNotices(view({
    [`${SLIP}Status`]: str("running"),
    [`${SLIP}Volts`]: num(3.2),
    [`${SLIP}PeakAmps`]: num(41.4),
  }));
  assert.equal(n[0].text, "Slip current · 3.2 V · 41 A");
});

test("a calibration that says its own result verbatim is not rewritten", () => {
  const n = calibrationNotices(view({
    [`${SLIP}Status`]: str("done"),
    [`${SLIP}Result`]: str("Wheels slip at 48 A (FrontLeft first): set 45 A"),
    [`${SLIP}Snippet`]: str("kSlipCurrent = Amps.of(45); // measured 48.3 A at the FrontLeft wheel (was 120 A)"),
  }));
  assert.equal(n[0].text, "Wheels slip at 48 A (FrontLeft first): set 45 A");
  assert.equal(n[0].snippet, "kSlipCurrent = Amps.of(45); // measured 48.3 A at the FrontLeft wheel (was 120 A)");
  // Fields that are WheelRadius's alone never leak onto a calibration that never published them.
  assert.equal(n[0].metresText, undefined);
  assert.equal(n[0].hint, undefined);
});

test("a stopped SlipCurrent run reads the same generic way as a stopped WheelRadius run", () => {
  const n = calibrationNotices(view({
    [`${SLIP}Status`]: str("stopped: no slip by 6 V (12 A): is the robot against the wall?"),
  }));
  assert.equal(n[0].detail, "no slip by 6 V (12 A): is the robot against the wall?");
});
