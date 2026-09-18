import { test } from "node:test";
import assert from "node:assert/strict";

import { enterSquare, faceNormal, faceToward, HUBS, hubContaining, nearestTag, TAGS } from "./aim-target.js";

const RED = HUBS.find((h) => h.name === "red");
const BLUE = HUBS.find((h) => h.name === "blue");
const near = (actual, expected, tolerance = 1e-3) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not within ${tolerance} of ${expected}`);

/* ---- the HUBS ---- */

test("the HUBS are the 1.207 m squares round the centres X1 aims at", () => {
  near(RED.min[0], 11.3118);
  near(RED.max[0], 12.5192);
  near(BLUE.min[0], 4.0218);
  near(BLUE.max[0], 5.2292);
  near(RED.min[1], 3.4309);
  near(RED.max[1], 4.6383);
});

test("a target at a HUB's centre, or on its face, is in that HUB; one on the carpet is in neither", () => {
  assert.equal(hubContaining([11.9155, 4.0346]), RED);
  assert.equal(hubContaining([4.6255, 4.0346]), BLUE);
  assert.equal(hubContaining([12.519, 4.035]), RED); // tag 10, on the red HUB's +x face
  assert.equal(hubContaining([8.27, 4.03]), null);
  assert.equal(hubContaining([11.9155, 5.5]), null);
});

/* ---- where the line to the centre meets the HUB ---- */

test("from the blue side, the line to the red HUB's centre enters through its -x face", () => {
  const entry = enterSquare([9.5, 4.0346], [11.9155, 4.0346], RED);
  assert.equal(entry.face, "-x");
  near(entry.point[0], RED.min[0]);
  near(entry.point[1], 4.0346);
  assert.ok(entry.t > 0 && entry.t < 1);
});

test("from each side the line enters through the face on that side", () => {
  assert.equal(enterSquare([14, 4.2], RED.centre, RED).face, "+x");
  assert.equal(enterSquare([11.8, 1.5], RED.centre, RED).face, "-y");
  assert.equal(enterSquare([12.1, 7], RED.centre, RED).face, "+y");
  // Off the diagonal toward y: the line crosses y = max first.
  const entry = enterSquare([10, 6.5], RED.centre, RED);
  assert.equal(entry.face, "+y");
  near(entry.point[1], RED.max[1]);
  assert.ok(entry.point[0] >= RED.min[0] && entry.point[0] <= RED.max[0]);
});

test("a line that starts inside the HUB, or misses it, enters nothing", () => {
  assert.equal(enterSquare([11.9, 4.0], [14, 4.0], RED), null);
  assert.equal(enterSquare([9, 1], [14, 1], RED), null);
  assert.equal(enterSquare([9, 4], [10, 4], RED), null); // stops short of it
});

test("each face faces out of the square", () => {
  assert.deepEqual(faceNormal("-x"), [-1, 0]);
  assert.deepEqual(faceNormal("+y"), [0, 1]);
  assert.equal(faceNormal("nonsense"), null);
});

/* ---- which face is lit ---- */

test("the lit face holds near the diagonal and changes once the robot is clearly round the corner", () => {
  const { centre } = RED;
  // Just past the diagonal toward +y: the line enters +y, a few centimetres from the corner.
  const justPast = [centre[0] - 2, centre[1] + 2.05];
  assert.equal(enterSquare(justPast, centre, RED).face, "+y");
  assert.equal(faceToward(justPast, centre, RED, "-x"), "-x");
  // Well round: the line meets the -x plane far beyond its corner, so the light moves.
  const round = [centre[0] - 0.5, centre[1] + 2.5];
  assert.equal(faceToward(round, centre, RED, "-x"), "+y");
  // With nothing lit yet, it is simply the face the line enters.
  assert.equal(faceToward(justPast, centre, RED, null), "+y");
});

test("a pose inside the HUB keeps whatever face was lit", () => {
  assert.equal(faceToward([11.9, 4.0], RED.centre, RED, "-x"), "-x");
  assert.equal(faceToward([11.9, 4.0], RED.centre, RED, null), null);
});

/* ---- tags ---- */

test("the table is WPILib's 2026 layout: 32 tags at the three heights", () => {
  assert.equal(TAGS.length, 32);
  assert.deepEqual([...new Set(TAGS.map((t) => t.z))].sort(), [0.552, 0.889, 1.124]);
});

test("a target on a tag finds that tag; the HUB's centre finds none", () => {
  assert.equal(nearestTag([12.519, 4.035])?.id, 10);
  assert.equal(nearestTag([12.51, 4.04])?.id, 10);
  const wall = nearestTag([0.008, 4.178]);
  assert.equal(wall.id, 32);
  assert.equal(wall.z, 0.552);
  assert.equal(nearestTag([11.9155, 4.0346]), null);
  assert.equal(nearestTag([8.27, 4.03]), null);
});

test("of the two tags back to back on a trench arm, the one facing the robot wins", () => {
  // Tags 6 (facing -x) and 7 (facing +x) are 7.5 cm apart.
  assert.equal(nearestTag([11.915, 0.644], [9, 1])?.id, 6);
  assert.equal(nearestTag([11.915, 0.644], [14, 1])?.id, 7);
});
