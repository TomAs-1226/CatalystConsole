import { test } from "node:test";
import assert from "node:assert/strict";

import { aimCaption, aimedAt, enterSquare, faceSpan, HUBS, hubContaining, nearestTag, standoffPose, TAGS } from "./aim-target.js";

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

/* ---- what the aim is at ---- */

const TAG = (id) => TAGS.find((t) => t.id === id);

test("a HUB's centre is the HUB, a tag is the tag, and anything else is a place", () => {
  assert.deepEqual(aimedAt(RED.centre), { kind: "hub", hub: RED });
  assert.deepEqual(aimedAt(BLUE.centre, { tagId: 26 }), { kind: "hub", hub: BLUE }, "whatever tag the camera is on");
  const tag = aimedAt([12.519, 4.035]);
  assert.equal(tag.kind, "tag");
  assert.equal(tag.tag.id, 10);
  assert.equal(tag.hub, RED, "and the HUB it is on, which the view keeps whole");
  assert.equal(aimedAt([11.878, 7.425]).hub, null, "a trench tag is on no HUB");
  assert.deepEqual(aimedAt([8.27, 6.5]), { kind: "place" });
  assert.deepEqual(aimedAt(null), { kind: "place" });
});

test("the tag the robot says it sees wins while the target is near it, even beside a closer one", () => {
  // Tags 9 and 10 are 0.356 m apart on the red HUB's +x face. X1 aiming 3 in beside tag 10, toward 9,
  // with its pose a few centimetres out, puts the target nearer tag 9 than tag 10.
  const beside = [12.53, 3.85];
  assert.equal(aimedAt(beside).tag.id, 9, "on geometry alone, the nearer tag");
  assert.equal(aimedAt(beside, { tagId: 10 }).tag.id, 10, "the robot says 10");
  // A tag the robot names that is nowhere near the target - a pose far out, a tag held in a hand - is not
  // taken for it; the target stands for itself.
  assert.deepEqual(aimedAt([14.8, 6.6], { tagId: 10 }), { kind: "place" });
  assert.equal(aimedAt([12.519, 4.035], { tagId: 99 }).tag.id, 10, "an id the field has no tag for is ignored");
});

test("a tag's light stops at its face's edges: a centre tag has the face to both sides, a side one mostly to one", () => {
  const [left10, right10] = faceSpan(TAG(10), RED);
  near(left10, -RED.half, 0.002);
  near(right10, RED.half, 0.002);
  // Tag 9 is 0.356 m toward the red HUB's -y corner; facing +x, that corner is on the left.
  const [left9, right9] = faceSpan(TAG(9), RED);
  near(left9, -0.248);
  near(right9, 0.959);
  // Tag 11 faces +y and sits toward +x, which from in front of it is the left too.
  const [left11] = faceSpan(TAG(11), RED);
  near(left11, -0.248);
  // And the blue HUB's tag 26, facing -x, is its face's centre.
  const [left26, right26] = faceSpan(TAG(26), BLUE);
  near(left26 + right26, 0, 0.002);
});

/* ---- where an align stops ---- */

test("straight in front of the tag, the align stops the standoff out, facing it", () => {
  const tag = TAG(10);
  const stop = standoffPose([15.2, tag.y], [tag.x, tag.y], 1.0);
  near(stop.x, tag.x + 1.0);
  near(stop.y, tag.y);
  near(Math.abs(stop.heading), Math.PI, 1e-9);
});

test("off to one side, it stops on its own line to the tag, not on the tag's normal", () => {
  const tag = [12.519, 4.035];
  const from = [14.7, 4.9];
  const stop = standoffPose(from, tag, 1.0);
  near(Math.hypot(stop.x - tag[0], stop.y - tag[1]), 1.0, 1e-9);
  // On the line from the tag through the robot: no sideways offset from it at all.
  const run = [from[0] - tag[0], from[1] - tag[1]];
  near(run[0] * (stop.y - tag[1]) - run[1] * (stop.x - tag[0]), 0, 1e-9);
  assert.ok(stop.y > tag[1] + 0.3, `${stop.y}: the normal would have put it level with the tag`);
  // Facing the tag.
  near(stop.heading, Math.atan2(tag[1] - stop.y, tag[0] - stop.x), 1e-9);
});

test("closer than the standoff, it stops back out along the same line", () => {
  const tag = [12.519, 4.035];
  const stop = standoffPose([13.1, 4.035], tag, 1.0);
  near(stop.x, 13.519);
  near(Math.abs(stop.heading), Math.PI, 1e-9);
});

test("no standoff, or a robot on the target, has nowhere to stop", () => {
  const tag = [12.519, 4.035];
  assert.equal(standoffPose([14, 4], tag, null), null);
  assert.equal(standoffPose([14, 4], tag, 0), null);
  assert.equal(standoffPose([14, 4], tag, Number.NaN), null);
  assert.equal(standoffPose(tag, tag, 1), null);
  assert.equal(standoffPose(null, tag, 1), null);
});

/* ---- the caption ---- */

const aim = (state, target, distance = null) => ({ state, target, aimPoint: target, headingErrorDeg: null, distance, timeOfFlight: null });

test("aligning to a tag says which tag and how far is left to its standoff, then that it is there", () => {
  const tag10 = [12.52, 4.04];
  assert.equal(aimCaption(aim("ALIGNING", tag10, 1.42), { tagId: 10, standoff: 1.0 }), "Aligning to tag 10 · 0.42 m");
  assert.equal(aimCaption(aim("ALIGNING", tag10, 0.9), { tagId: 10, standoff: 1.0 }), "Aligning to tag 10 · 0.10 m",
    "backing out to it is distance to go as well");
  assert.equal(aimCaption(aim("ALIGNED", tag10, 1.01), { tagId: 10, standoff: 1.0 }), "Aligned");
});

test("what the robot does not publish is a dash, never a guess", () => {
  const tag10 = [12.52, 4.04];
  assert.equal(aimCaption(aim("ALIGNING", tag10, 1.42), { standoff: 1.0 }), "Aligning to tag — · 0.42 m");
  assert.equal(aimCaption(aim("ALIGNING", tag10, 1.42), { tagId: 10 }), "Aligning to tag 10 · — m");
  assert.equal(aimCaption(aim("ALIGNING", tag10, null), { tagId: 10, standoff: 1.0 }), "Aligning to tag 10 · — m");
});

test("a HUB or a place says what the shooter is doing, and a standoff changes nothing about it", () => {
  const align = { tagId: 10, standoff: 1.0 };
  assert.equal(aimCaption(aim("ALIGNING", RED.centre, 1.5), align), "Aligning to the hub");
  assert.equal(aimCaption(aim("ALIGNED", RED.centre, 1.49), align), "Locked on · 1.5 m");
  assert.equal(aimCaption(aim("SOTF", RED.centre, 2.6), align), "Shooting on the move · 2.6 m");
  assert.equal(aimCaption(aim("ALIGNED", RED.centre)), "Locked on");
  assert.equal(aimCaption(aim("ALIGNING", [2.0, 6.5], 3.0)), "Aligning");
  assert.equal(aimCaption(aim("SOTF", [2.0, 6.5], 3.04)), "Shooting on the move · 3.0 m");
  assert.equal(aimCaption(null), "");
});
