import { test } from "node:test";
import assert from "node:assert/strict";

import { bytes, level, preEolState, wearText } from "./core-format.js";

// These decide what turns red on the Systemcore page. The states they describe — a full disk, a
// worn-out eMMC, a pinned core — are exactly the ones nobody can reproduce on a real robot without
// deliberately breaking it, which is why they are worth pinning down here instead.

// --- absent is not zero -----------------------------------------------------

test("no reading has no severity", () => {
  // The rule the whole page rests on. Storage at 0% and no answer from the storage sensor render
  // identically as a number and mean opposite things — and the wrong one of them is reassuring.
  assert.equal(level(null), null);
  assert.equal(level(undefined), null);
  assert.equal(level(NaN), null);
});

test("zero is a real reading and reads as fine", () => {
  assert.equal(level(0), "ok");
});

test("no byte count formats to nothing rather than to 0 B", () => {
  assert.equal(bytes(null), null);
  assert.equal(bytes(undefined), null);
  assert.equal(bytes(Infinity), null);
  assert.equal(bytes(NaN), null);
});

// --- thresholds -------------------------------------------------------------

test("ordinary load does not raise anything", () => {
  // A processor at 80% during an auto routine is doing its job. A page that turns red every match
  // gets ignored by the third one.
  assert.equal(level(60), "ok");
  assert.equal(level(84.9), "ok");
});

test("the boundaries are inclusive", () => {
  assert.equal(level(85), "warn");
  assert.equal(level(95), "crit");
});

test("thresholds can be tightened per reading", () => {
  // Storage warns earlier than the rest: a disk that fills stops logging, then stops the robot
  // program, and nothing about that symptom points at the disk.
  assert.equal(level(88, 85, 93), "warn");
  assert.equal(level(94, 85, 93), "crit");
  // Temperature warns earlier still, below where the SoC starts throttling, so there is still time
  // to open the electronics box.
  assert.equal(level(82, 80, 90), "warn");
});

// --- byte formatting --------------------------------------------------------

test("sizes are reported in the units the kernel counted", () => {
  assert.equal(bytes(0), "0 B");
  assert.equal(bytes(512), "512 B");
  assert.equal(bytes(1024), "1.0 KiB");
  assert.equal(bytes(8 * 1024 ** 3), "8.0 GiB");
});

test("small values keep a decimal and large ones do not", () => {
  // "7.5 GiB" is worth a digit; "512 GiB" is not, and "511.9 GiB" reads as false precision.
  assert.equal(bytes(7.5 * 1024 ** 3), "7.5 GiB");
  assert.equal(bytes(512 * 1024 ** 3), "512 GiB");
});

test("it stops at tebibytes rather than inventing a unit", () => {
  assert.match(bytes(5 * 1024 ** 4), /TiB$/);
  assert.match(bytes(5000 * 1024 ** 4), /TiB$/);
});

// --- eMMC wear --------------------------------------------------------------

test("wear is worded as the band the device actually reported", () => {
  // JEDEC gives a code in ten steps and the library returns the midpoint of the band. Printing
  // "55%" back would be inventing a digit the flash never provided.
  assert.equal(wearText(0.05), "about 0–10% of its rated write life used");
  assert.equal(wearText(0.55), "about 50–60% of its rated write life used");
  assert.equal(wearText(0.95), "about 90–100% of its rated write life used");
});

test("a device past its rated life does not report a band above 100", () => {
  assert.equal(wearText(1.0), "about 90–100% of its rated write life used");
});

test("unreported wear says so instead of showing a bar at zero", () => {
  assert.equal(wearText(null), "wear not reported");
  assert.equal(wearText(undefined), "wear not reported");
});

// --- pre-EOL ----------------------------------------------------------------

test("the device's own verdict maps to plain words", () => {
  assert.deepEqual(preEolState(1), { text: "healthy", level: "ok" });
  assert.deepEqual(preEolState(2), { text: "wearing out", level: "warn" });
  assert.deepEqual(preEolState(3), { text: "replace it", level: "crit" });
});

test("an unreported or unknown code says nothing rather than healthy", () => {
  // 0 is JEDEC's "not defined". Reading it as normal would report a failing card as fine.
  assert.equal(preEolState(null), null);
  assert.equal(preEolState(0), null);
  assert.equal(preEolState(9), null);
});

test("codes arrive as doubles over NetworkTables and still map", () => {
  // Everything on the wire is a double, so 2 arrives as 2.0 and could arrive as 1.9999.
  assert.equal(preEolState(2.0).level, "warn");
  assert.equal(preEolState(2.4).level, "warn");
});
