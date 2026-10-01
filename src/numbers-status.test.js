import { test } from "node:test";
import assert from "node:assert/strict";

import {
  accelLimitText,
  assistLevelText,
  assistText,
  headingText,
  profileText,
  createLineHold,
  driverLine,
  governorText,
  hasNumbersStatus,
  hubText,
  KEYS,
  locBadge,
  numbersNotices,
  ownerText,
  readNumbersStatus,
  shotsText,
  sinceText,
  stateWords,
  tagModeText,
  winnerText,
} from "./numbers-status.js";

/** A read-only view over `{ key: value }`, typed the way the console's store types NetworkTables. */
function view(values) {
  const get = (k) => values[k];
  return {
    has: (k) => get(k) !== undefined,
    num: (k, f = null) => (typeof get(k) === "number" ? get(k) : typeof get(k) === "boolean" ? (get(k) ? 1 : 0) : f),
    bool: (k, f = null) => (typeof get(k) === "boolean" ? get(k) : typeof get(k) === "number" ? get(k) !== 0 : f),
    str: (k, f = null) => (typeof get(k) === "string" ? get(k) : typeof get(k) === "number" ? String(get(k)) : f),
  };
}

const numbers = (extra = {}) => readNumbersStatus(view({
  [KEYS.blockedBy]: "",
  [KEYS.state]: "PREPARE_SCORE",
  [KEYS.locLevel]: "TRUSTED",
  [KEYS.locWhy]: "",
  [KEYS.locSince]: 0.1,
  [KEYS.owner]: "DRIVER",
  [KEYS.governor]: 1.0,
  [KEYS.winnerSource]: "FMS",
  [KEYS.wonAuto]: "WON",
  [KEYS.hubActive]: true,
  [KEYS.hubLeft]: 11.2,
  [KEYS.assist]: "NONE",
  [KEYS.tagMode]: "ALL_TAGS",
  [KEYS.shots]: 23.4,
  [KEYS.poseFrom]: "VISION",
  ...extra,
}));

/* ---- absent means nothing ---- */

test("a robot that publishes none of it reads as nulls, and draws nothing", () => {
  const st = readNumbersStatus(view({}));
  assert.equal(hasNumbersStatus(st), false);
  assert.equal(driverLine(st), null);
  assert.equal(locBadge(st), null);
  assert.equal(ownerText(st.owner), null);
  assert.equal(governorText(st.governor), null);
  assert.equal(hubText(st), null);
  assert.equal(winnerText(st.winner), null);
  assert.equal(assistText(st.assist), null);
  assert.equal(tagModeText(st.tagMode), null);
  assert.equal(shotsText(st.shots), null);
  assert.equal(st.poseFrom, null);
  assert.deepEqual(numbersNotices(st, { enabled: true, winnerUnknownHeld: true }), []);
});

test("a key of the wrong type is treated as absent, not as a value", () => {
  const st = readNumbersStatus(view({ [KEYS.governor]: "fast", [KEYS.locLevel]: "SOMEWHERE", [KEYS.hubActive]: "yes" }));
  assert.equal(st.governor, null);
  assert.equal(st.loc.level, null);
  assert.equal(st.hub.active, null);
});

/* ---- the driver's line ---- */

test("a blocker the driver can fix is the line, and says so", () => {
  for (const b of ["MOVING TOO FAST", "STEADY THE STICK", "NEAR TRENCH", "OUT OF ZONE", "STOP TO SHOOT (NO POSE)"]) {
    const line = driverLine(numbers({ [KEYS.blockedBy]: b }));
    assert.equal(line.text, b);
    assert.equal(line.kind, "act", b);
  }
});

test("any other blocker means keep holding, and names what the robot is doing", () => {
  for (const b of ["HEADING", "SPIN-UP", "HOOD", "POSE NOT TRUSTED", "HUB OFF", "ROBOT BUMPED", "POSE LOST"]) {
    const line = driverLine(numbers({ [KEYS.blockedBy]: b }));
    assert.equal(line.kind, "hold", b);
  }
  assert.equal(driverLine(numbers({ [KEYS.blockedBy]: "SPIN-UP" })).sub, "Holding the shot · Lining up the shot");
});

test("with nothing blocking, the line is the robot's state in plain words", () => {
  assert.deepEqual(driverLine(numbers()), { text: "Lining up the shot", kind: "state", sub: "" });
  assert.equal(driverLine(numbers({ [KEYS.state]: "SCORE" })).kind, "fire");
  assert.equal(driverLine(numbers({ [KEYS.state]: "FEED" })).text, "Feeding");
  assert.equal(stateWords("IDLE"), "Idle");
  assert.equal(stateWords("SOME_NEW_STATE"), "Some new state");
  assert.equal(stateWords(""), null);
});

test("a blank blocker is no blocker", () => {
  assert.equal(driverLine(numbers({ [KEYS.blockedBy]: "   " })).kind, "state");
});

/* ---- localization ---- */

test("the localization badge carries the level, and the reason only when it is not trusted", () => {
  assert.deepEqual(locBadge(numbers()), { level: "trusted", word: "Pose trusted", detail: "" });
  const lost = locBadge(numbers({ [KEYS.locLevel]: "LOST", [KEYS.locWhy]: "no tags", [KEYS.locSince]: 12.4 }));
  assert.deepEqual(lost, { level: "lost", word: "Pose lost", detail: "no tags · last fix 12 s ago" });
  assert.equal(locBadge(numbers({ [KEYS.locLevel]: "degraded" })).level, "degraded");
});

test("seconds since a fix read the way a person says them, and the 999 cap is not a real figure", () => {
  assert.equal(sinceText(2.34), "last fix 2.3 s ago");
  assert.equal(sinceText(42), "last fix 42 s ago");
  assert.equal(sinceText(185), "last fix 3 min ago");
  assert.equal(sinceText(999), "no fix for 16+ min");
  assert.equal(sinceText(null), null);
  assert.equal(sinceText(Number.NaN), null);
});

test("the tag mode in words", () => {
  assert.equal(tagModeText("HUB_TAGS"), "hub tags only");
  assert.equal(tagModeText("WAITING_FOR_HUB_TAGS"), "waiting for hub tags");
  assert.equal(tagModeText("ALL_TAGS"), "all tags");
});

/* ---- the drive ---- */

test("the operator having the drive is flagged, whatever the aim", () => {
  assert.deepEqual(ownerText("OPERATOR"), { text: "Operator driving", operator: true, auto: false });
  assert.equal(ownerText("OPERATOR_AIMED").operator, true);
  assert.equal(ownerText("DRIVER").operator, false);
  assert.equal(ownerText("DRIVER_AIMED").text, "Driver · auto-aim");
  assert.equal(ownerText("AUTO").auto, true);
});

test("the governor shows only when it limits the driver", () => {
  assert.equal(governorText(1.0), null);
  assert.equal(governorText(0.7), "Driver 70%");
  assert.equal(governorText(0.45), "Driver 45%");
  assert.equal(governorText(null), null);
});

/* ---- the hub and the auto winner ---- */

test("the robot's own hub state with its countdown", () => {
  assert.equal(hubText(numbers({ [KEYS.hubActive]: false, [KEYS.hubLeft]: 11.2 })), "HUB OFF · 12 s");
  assert.equal(hubText(numbers({ [KEYS.hubLeft]: 0 })), "HUB ON");
});

test("who won auto, and on whose word", () => {
  assert.equal(winnerText({ source: "FMS", won: "WON" }), "Won auto (FMS)");
  assert.equal(winnerText({ source: "OPERATOR", won: "LOST" }), "Lost auto (operator)");
  assert.equal(winnerText({ source: "UNKNOWN", won: "?" }), "Auto winner unknown");
});

test("assist, shots", () => {
  assert.equal(assistText("NONE"), null);
  assert.equal(assistText("BUMP"), "Bump assist");
  assert.equal(assistText("TRENCH"), "Trench assist");
  assert.equal(shotsText(23.4), "~23");
  assert.equal(shotsText(-1), null);
});

/* ---- capsules ---- */

test("a lost pose raises a capsule only while the robot is enabled", () => {
  const st = numbers({ [KEYS.locLevel]: "LOST", [KEYS.locWhy]: "no tags", [KEYS.locSince]: 30 });
  assert.deepEqual(numbersNotices(st, { enabled: false }), []);
  const [n] = numbersNotices(st, { enabled: true });
  assert.equal(n.key, "loc:lost");
  assert.equal(n.level, "warn");
  assert.match(n.detail, /no tags/);
});

test("an unknown auto winner asks the operator, in teleop only, once the caller has held it", () => {
  const st = numbers({ [KEYS.winnerSource]: "UNKNOWN", [KEYS.wonAuto]: "?" });
  assert.deepEqual(numbersNotices(st, { enabled: true, auto: false, winnerUnknownHeld: false }), []);
  assert.deepEqual(numbersNotices(st, { enabled: true, auto: true, winnerUnknownHeld: true }), []);
  const [n] = numbersNotices(st, { enabled: true, auto: false, winnerUnknownHeld: true });
  assert.equal(n.key, "hub:winner");
  assert.match(n.detail, /won or lost/);
});

test("the driver's line holds a new blocker back until it has lasted, and clears at once", () => {
  const hold = createLineHold(250);
  const a = { text: "Lining up the shot", kind: "state", sub: "" };
  const b = { text: "HEADING", kind: "hold", sub: "" };
  assert.equal(hold.next(a, 0), a);
  assert.equal(hold.next(b, 100), a);   // a frame of HEADING is not shown
  assert.equal(hold.next(a, 200), a);
  assert.equal(hold.next(b, 300), a);
  assert.equal(hold.next(b, 500), a);
  assert.equal(hold.next(b, 560), b);   // lasted 260 ms: shown
  assert.equal(hold.next(null, 600), null);
});

/* ---- shared control ---- */

test("the heading's owner is a quiet chip, except the operator, and nothing for the driver or nobody", () => {
  assert.equal(headingText("DRIVER"), null);
  assert.equal(headingText("NONE"), null);
  assert.equal(headingText(null), null);
  assert.deepEqual(headingText("OPERATOR"), { text: "OPERATOR STEERING", operator: true });
  assert.deepEqual(headingText("HOLD"), { text: "Heading: hold", operator: false });
  assert.equal(headingText("AIM").text, "Heading: aim");
  assert.equal(headingText("BUMP").text, "Heading: bump");
});

test("the assist level, with off marked as the one without help", () => {
  assert.deepEqual(assistLevelText("OFF"), { text: "Assist: off", off: true });
  assert.deepEqual(assistLevelText("LIGHT"), { text: "Assist: light", off: false });
  assert.equal(assistLevelText("FULL").text, "Assist: full");
  assert.equal(assistLevelText(null), null);
});

test("the profile and the launch limit in words", () => {
  assert.equal(profileText("NEW_DRIVER"), "Profile: new driver");
  assert.equal(profileText("VETERAN"), "Profile: veteran");
  assert.equal(profileText(null), null);
  assert.equal(accelLimitText(9.24), "Launch limit 9.2 m/s²");
  assert.equal(accelLimitText(-1), null);
  assert.equal(accelLimitText(null), null);
});

test("shadow mode raises its capsule enabled or not, and only from a true boolean", () => {
  const on = numbers({ [KEYS.shadow]: true });
  assert.equal(on.shared.shadow, true);
  const [n] = numbersNotices(on, { enabled: false });
  assert.equal(n.key, "assist:shadow");
  assert.equal(n.text, "Assist shadow mode");
  assert.equal(n.detail, "the robot is only logging");
  assert.deepEqual(numbersNotices(numbers({ [KEYS.shadow]: false }), { enabled: true }), []);
  assert.deepEqual(numbersNotices(numbers(), { enabled: true }), []);
  assert.equal(readNumbersStatus(view({ [KEYS.shadow]: "true" })).shared.shadow, null);
});

test("shared control absent reads as nulls", () => {
  const st = readNumbersStatus(view({}));
  assert.deepEqual(st.shared, { headingOwner: null, reason: null, assistLevel: null, profile: null, shadow: null, accelLimit: null });
});
