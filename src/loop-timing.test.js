import { test } from "node:test";
import assert from "node:assert/strict";
import { readLoopTiming, ROBOT_LOOP_KEY } from "./loop-timing.js";

const root = "/Catalyst/Loop/Robot/";
const num = (v) => ({ t: "num", v });
const bool = (v) => ({ t: "bool", v });
const view = (values, linked = true) => ({ linked, raw: (key) => values[key] });

test("healthy 20 ms period and 1 ms work use measured work without claiming total CPU headroom", () => {
  const timing = readLoopTiming(view({ [ROBOT_LOOP_KEY]: num(20), [`${root}AverageWorkMs`]: num(1), [`${root}OverBudget`]: bool(false) }));
  assert.equal(timing.kind, "work");
  assert.equal(timing.value, 1);
  assert.equal(timing.period, 20);
  assert.equal(timing.state, "ok");
  assert.equal(timing.headroom, null);
});

test("rolling average work is preferred over a single latest work sample", () => {
  const timing = readLoopTiming(view({ [`${root}AverageWorkMs`]: num(2), [`${root}WorkMs`]: num(30) }));
  assert.equal(timing.value, 2);
  assert.equal(timing.state, "ok");
});

test("latest work is used when average work is unavailable and genuine excess is critical", () => {
  const timing = readLoopTiming(view({ [ROBOT_LOOP_KEY]: num(20), [`${root}WorkMs`]: num(21) }));
  assert.equal(timing.kind, "work");
  assert.equal(timing.state, "bad");
  assert.equal(timing.headroom, null);
});

test("period-only scheduled 20 ms is healthy and never claims work or headroom", () => {
  for (const status of [undefined, bool(false)]) {
    const timing = readLoopTiming(view({ [ROBOT_LOOP_KEY]: num(20), [`${root}OverBudget`]: status }));
    assert.equal(timing.kind, "period");
    assert.equal(timing.state, "ok");
    assert.equal(timing.work, null);
    assert.equal(timing.headroom, null);
  }
});

test("period fallback follows the monitor's 24 ms threshold or published over-budget status", () => {
  assert.equal(readLoopTiming(view({ [ROBOT_LOOP_KEY]: num(24) })).state, "ok");
  assert.equal(readLoopTiming(view({ [ROBOT_LOOP_KEY]: num(24.1) })).state, "bad");
  assert.equal(readLoopTiming(view({ [ROBOT_LOOP_KEY]: num(20), [`${root}OverBudget`]: bool(true) })).state, "bad");
});

test("absent, malformed and disconnected data have no invented duration or headroom", () => {
  for (const read of [view({}), view({ [ROBOT_LOOP_KEY]: bool(true), [`${root}WorkMs`]: num(NaN) }), view({ [ROBOT_LOOP_KEY]: num(20), [`${root}WorkMs`]: num(1) }, false)]) {
    const timing = readLoopTiming(read);
    assert.equal(timing.value, null);
    assert.equal(timing.work, null);
    assert.equal(timing.headroom, null);
    assert.equal(timing.state, "");
  }
});

test("custom topics and configured budgets are not replaced by native Robot timings", () => {
  const timing = readLoopTiming(view({ "/Custom/Timing": num(3), [`${root}WorkMs`]: num(50), [ROBOT_LOOP_KEY]: num(20), [`${root}OverBudget`]: bool(true) }), { loopKey: "/Custom/Timing", budget: 4 });
  assert.equal(timing.kind, "configured");
  assert.equal(timing.value, 3);
  assert.equal(timing.period, null);
  assert.equal(timing.state, "ok");
  assert.equal(timing.headroom, .25);
});

test("missing custom topic never borrows native Robot values", () => {
  const timing = readLoopTiming(view({ [`${root}WorkMs`]: num(1) }), { loopKey: "/Custom/Timing", budget: 4 });
  assert.equal(timing.value, null);
  assert.equal(timing.headroom, null);
});
