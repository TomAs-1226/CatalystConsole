import { test } from "node:test";
import assert from "node:assert/strict";
import { readAlliance, readControlWord, readGameData, readMatchField } from "./driver-station.js";

function view(values) {
  return {
    has: (key) => Object.hasOwn(values, key),
    raw: (key) => values[key],
    num: (key, fallback = null) => values[key]?.t === "num" ? values[key].v
      : values[key]?.t === "bool" ? (values[key].v ? 1 : 0) : fallback,
    bool: (key, fallback = null) => values[key]?.t === "bool" ? values[key].v
      : values[key]?.t === "num" ? values[key].v !== 0 : fallback,
    str: (key, fallback = null) => values[key]?.t === "str" ? values[key].v
      : values[key]?.t === "num" ? String(values[key].v) : fallback,
  };
}

test("alpha-7 DriverStation control word takes precedence over stale legacy values", () => {
  const read = view({
    "/DriverStation/ControlWord": { t: "num", v: 33 },
    "/FMSInfo/FMSControlData": { t: "num", v: 0 },
  });
  assert.equal(readControlWord(read), 33);
});

test("an invalid present alpha-7 control word fails closed instead of using stale legacy data", () => {
  const read = view({
    "/DriverStation/ControlWord": { t: "str", v: "bad" },
    "/FMSInfo/FMSControlData": { t: "num", v: 33 },
  });
  assert.equal(readControlWord(read), null);
});

test("a boolean alpha-7 control word is rejected despite the app's numeric convenience coercion", () => {
  const read = view({
    "/DriverStation/ControlWord": { t: "bool", v: false },
    "/FMSInfo/FMSControlData": { t: "num", v: 33 },
  });
  assert.equal(read.num("/DriverStation/ControlWord", null), 0, "the app accessor would coerce it");
  assert.equal(readControlWord(read), null);
});

test("non-finite and out-of-range alpha-7 control words are rejected", () => {
  for (const value of [NaN, Infinity, 64, 1.5]) {
    assert.equal(readControlWord(view({
      "/DriverStation/ControlWord": { t: "num", v: value },
      "/FMSInfo/FMSControlData": { t: "num", v: 33 },
    })), null, `${value}`);
  }
});

test("legacy control word names remain readable when the native topic is absent", () => {
  assert.equal(readControlWord(view({ "/FMSInfo/ControlWord": { t: "num", v: 37 } })), 37);
  assert.equal(readControlWord(view({ "/FMSInfo/FMSControlData": { t: "num", v: 33 } })), 33);
});

test("malformed legacy control words remain unknown and never fall back to stale mode", () => {
  for (const key of ["/FMSInfo/ControlWord", "/FMSInfo/FMSControlData"]) {
    for (const value of [NaN, Infinity, -1, 64, 1.5]) {
      assert.equal(readControlWord(view({ [key]: { t: "num", v: value } })), null);
    }
    assert.equal(readControlWord(view({ [key]: { t: "bool", v: false } })), null);
  }
  assert.equal(readControlWord(view({
    "/FMSInfo/ControlWord": { t: "num", v: NaN },
    "/FMSInfo/FMSControlData": { t: "num", v: 33 },
  })), null);
});

test("alpha-7 alliance and match metadata use DriverStation with absent-only legacy fallback", () => {
  const read = view({
    "/DriverStation/IsRedAlliance": { t: "bool", v: false },
    "/FMSInfo/IsRedAlliance": { t: "bool", v: true },
    "/DriverStation/GameData": { t: "str", v: "B" },
    "/DriverStation/EventName": { t: "str", v: "SoCal" },
    "/DriverStation/MatchNumber": { t: "num", v: 4 },
  });
  assert.equal(readAlliance(read), "blue");
  assert.equal(readGameData(read), "B");
  assert.equal(readMatchField(read, "EventName", "str"), "SoCal");
  assert.equal(readMatchField(read, "MatchNumber", "num"), 4);
});

test("malformed native alliance is unknown, while absent native metadata uses legacy names", () => {
  assert.equal(readAlliance(view({
    "/DriverStation/IsRedAlliance": { t: "str", v: "maybe" },
    "/FMSInfo/IsRedAlliance": { t: "bool", v: true },
  })), null);
  assert.equal(readGameData(view({ "/FMSInfo/GameSpecificMessage": { t: "str", v: "R" } })), "R");
});

test("a numeric alpha-7 alliance is rejected despite the app's boolean convenience coercion", () => {
  const read = view({
    "/DriverStation/IsRedAlliance": { t: "num", v: 1 },
    "/FMSInfo/IsRedAlliance": { t: "bool", v: true },
  });
  assert.equal(read.bool("/DriverStation/IsRedAlliance", null), true, "the app accessor would coerce it");
  assert.equal(readAlliance(read), null);
});
