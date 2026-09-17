import { test } from "node:test";
import assert from "node:assert/strict";

import { compactFigure, spacedLabel } from "./board-format.js";

// --- a large figure written short ---------------------------------------------

test("a motor speed of thousands reads short, with a decimal only where it says something", () => {
  assert.equal(compactFigure(2400), "2.4k");
  assert.equal(compactFigure(2000), "2k");
  assert.equal(compactFigure(3066), "3.1k");
  assert.equal(compactFigure(12340), "12.3k");
});

test("a figure under a thousand is written as it always was", () => {
  assert.equal(compactFigure(950), "950");
  assert.equal(compactFigure(0), "0");
  assert.equal(compactFigure(12.5, 1), "12.5");
  assert.equal(compactFigure(7, 2), "7.00");
});

test("the sign is kept either side of a thousand", () => {
  assert.equal(compactFigure(-2400), "-2.4k");
  assert.equal(compactFigure(-2000), "-2k");
  assert.equal(compactFigure(-950), "-950");
});

test("a thousand is decided after rounding, so 999.6 does not read 1000", () => {
  assert.equal(compactFigure(999.6), "1k");
  assert.equal(compactFigure(999.4), "999");
  assert.equal(compactFigure(999.4, 1), "999.4");
});

test("past a thousand thousands it reads M, and never 1000k", () => {
  assert.equal(compactFigure(1234567), "1.2M");
  assert.equal(compactFigure(999990), "1M");
});

// --- a path segment as a label ---------------------------------------------------

test("CamelCase segments are spaced into sentence case", () => {
  assert.equal(spacedLabel("FrontLeft"), "Front left");
  assert.equal(spacedLabel("frontLeft"), "Front left");
  assert.equal(spacedLabel("BackRight"), "Back right");
  assert.equal(spacedLabel("Module0Angle"), "Module0 angle");
});

test("an acronym stays in capitals", () => {
  assert.equal(spacedLabel("CANBus"), "CAN bus");
  assert.equal(spacedLabel("LL3"), "LL3");
  assert.equal(spacedLabel("PDH"), "PDH");
});

test("a single word only gains its capital, and punctuation is left as published", () => {
  assert.equal(spacedLabel("Velocity"), "Velocity");
  assert.equal(spacedLabel("velocity"), "Velocity");
  assert.equal(spacedLabel("shooter_rpm"), "shooter_rpm");
  assert.equal(spacedLabel("LL-3"), "LL-3");
});
