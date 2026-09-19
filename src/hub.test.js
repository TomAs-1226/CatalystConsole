import { test } from "node:test";
import assert from "node:assert/strict";

import { activeIn, hubPlan, inactiveFirst, segmentAt, TELEOP_SEGMENTS } from "./hub.js";

const teleop = (t, side, first) => hubPlan({ t, auto: false, enabled: true, side, first });

/* ---- the game data ---- */

test("the game data names the alliance that sits out shift 1, and nothing else counts", () => {
  assert.equal(inactiveFirst("R"), "red");
  assert.equal(inactiveFirst(" b "), "blue");
  assert.equal(inactiveFirst(""), null);
  assert.equal(inactiveFirst(null), null);
  assert.equal(inactiveFirst("X"), null);
});

/* ---- segments ---- */

test("the six teleop segments cover 140 seconds without a gap", () => {
  let from = 140;
  for (const s of TELEOP_SEGMENTS) {
    assert.equal(s.from, from);
    from = s.to;
  }
  assert.equal(from, 0);
});

test("a boundary belongs to the segment it starts, and no clock is no segment", () => {
  assert.equal(segmentAt(135).name, "Transition");
  assert.equal(segmentAt(130).name, "Shift 1");
  assert.equal(segmentAt(30.01).name, "Shift 4");
  assert.equal(segmentAt(0).name, "End game");
  assert.equal(segmentAt(null), null);
  assert.equal(segmentAt(-1), null);
  assert.equal(segmentAt(Number.NaN), null);
});

test("the alliance named by FMS is inactive in shifts 1 and 3, the other in 2 and 4", () => {
  const [transition, s1, s2, s3, s4, end] = TELEOP_SEGMENTS;
  assert.deepEqual([s1, s2, s3, s4].map((s) => activeIn(s, "red", "red")), [false, true, false, true]);
  assert.deepEqual([s1, s2, s3, s4].map((s) => activeIn(s, "blue", "red")), [true, false, true, false]);
  assert.equal(activeIn(transition, "red", null), true);
  assert.equal(activeIn(end, null, null), true);
  assert.equal(activeIn(s2, "red", null), null);
  assert.equal(activeIn(s2, null, "red"), null);
});

/* ---- the plan ---- */

test("no match clock, or a disabled robot, is no plan", () => {
  assert.equal(hubPlan({ t: null, enabled: true }).period, "none");
  assert.equal(hubPlan({ t: 90, enabled: false }).period, "none");
  assert.equal(hubPlan({ t: -1, enabled: true }).active, null);
});

test("auto is active for both alliances with no countdown to invent", () => {
  const p = hubPlan({ t: 15, auto: true, enabled: true, side: "red", first: null });
  assert.equal(p.period, "auto");
  assert.equal(p.active, true);
  assert.equal(p.left, null);
  assert.equal(p.autoDone, 0.25);
});

test("the countdown runs to the change, not to the end of the segment", () => {
  // Blue is active in the transition and in shift 1, so its hub does not change until 1:45.
  const p = teleop(135, "blue", "red");
  assert.equal(p.active, true);
  assert.equal(p.until, "change");
  assert.equal(p.left, 30);
  assert.equal(p.next.name, "Shift 2");
  assert.equal(p.next.active, false);
});

test("an alliance active in shift 4 stays active to the end and is never told it closes", () => {
  const p = teleop(34, "red", "red");
  assert.equal(p.segment.name, "Shift 4");
  assert.equal(p.active, true);
  assert.equal(p.until, "end");
  assert.equal(p.left, 34);
  assert.equal(p.next, null);
});

test("an alliance inactive in shift 4 opens for end game", () => {
  const p = teleop(34, "blue", "red");
  assert.equal(p.active, false);
  assert.equal(p.until, "change");
  assert.equal(p.left, 4);
  assert.equal(p.next.name, "End game");
});

test("before the game data the transition counts to shift 1 without saying which way it goes", () => {
  const p = teleop(137, "red", null);
  assert.equal(p.active, true);
  assert.equal(p.until, "segment");
  assert.equal(p.left, 7);
  assert.equal(p.next.name, "Shift 1");
  assert.equal(p.next.active, null);
});

test("a shift with no game data has no state, only the time until the segment ends", () => {
  const p = teleop(100, "red", null);
  assert.equal(p.active, null);
  assert.equal(p.until, "segment");
  assert.equal(p.left, 20);
});

test("the plan says how much of each segment has run", () => {
  const p = teleop(92.5, "red", "red");
  assert.deepEqual(p.plan.map((s) => s.done), [1, 1, 0.5, 0, 0, 0]);
  assert.deepEqual(p.plan.map((s) => s.active), [true, false, true, false, true, true]);
  assert.equal(p.index, 2);
});

test("a clock past 2:20 is held at the start of teleop rather than falling off the schedule", () => {
  const p = teleop(150, "red", "red");
  assert.equal(p.segment.name, "Transition");
  assert.equal(p.plan[0].done, 0);
  assert.equal(p.left, 20);
});
