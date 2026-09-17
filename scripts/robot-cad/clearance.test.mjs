import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSolids, clearOfSolids, distanceToTriangle, partTriangles } from "./clearance.mjs";
import { IDENTITY } from "./geometry.mjs";

/* A unit triangle in the z = 0 plane: (0,0,0), (1,0,0), (0,1,0). */
const A = [0, 0, 0];
const B = [1, 0, 0];
const C = [0, 1, 0];

test("a point over the face measures its height above the plane", () => {
  assert.ok(Math.abs(distanceToTriangle([0.25, 0.25, 0.4], A, B, C) - 0.4) < 1e-12);
  assert.ok(Math.abs(distanceToTriangle([0.25, 0.25, -1.5], A, B, C) - 1.5) < 1e-12);
  assert.ok(distanceToTriangle([0.2, 0.3, 0], A, B, C) < 1e-12, "a point on the face is on it");
});

test("a point past a corner measures to the corner, and past an edge to the edge", () => {
  assert.ok(Math.abs(distanceToTriangle([-3, -4, 0], A, B, C) - 5) < 1e-12);
  assert.ok(Math.abs(distanceToTriangle([1, -2, 0], A, B, C) - 2) < 1e-12);
  /* Off the hypotenuse, whose nearest point is (0.5, 0.5, 0). */
  assert.ok(Math.abs(distanceToTriangle([1, 1, 0], A, B, C) - Math.SQRT1_2) < 1e-12);
});

test("a ball is clear of a wall it does not reach and not of one it does", () => {
  /* A square wall at x = 0.1, two triangles. */
  const wall = [
    0.1, -1, -1, 0.1, 1, -1, 0.1, 1, 1,
    0.1, -1, -1, 0.1, 1, 1, 0.1, -1, 1,
  ];
  const solids = buildSolids(wall, 0.15);
  assert.equal(clearOfSolids(solids, [0.3, 0, 0], 0.075), true, "200 mm away");
  assert.equal(clearOfSolids(solids, [0.2, 0, 0], 0.075), true, "100 mm away, 75 mm ball");
  assert.equal(clearOfSolids(solids, [0.15, 0, 0], 0.075), false, "50 mm away, 75 mm ball");
  assert.equal(clearOfSolids(solids, [0.1, 0, 0], 0.075), false, "centred on the wall");
});

test("a ball beyond the wall's extent passes it", () => {
  const wall = [0, -0.05, -0.05, 0, 0.05, -0.05, 0, 0.05, 0.05];
  const solids = buildSolids(wall, 0.15);
  assert.equal(clearOfSolids(solids, [0, 0.4, 0], 0.075), true, "well above the small triangle");
  assert.equal(clearOfSolids(solids, [0, 0, 0], 0.075), false, "through it");
});

test("nothing in the way clears everything", () => {
  assert.equal(clearOfSolids(buildSolids([], 0.15), [0, 0, 0], 1), true);
  assert.equal(clearOfSolids(null, [0, 0, 0], 1), true);
});

test("a part's triangles come out in the working frame, translated if asked", () => {
  const part = {
    matrix: IDENTITY,
    faces: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }],
  };
  assert.deepEqual([...partTriangles(part)], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...partTriangles(part, { translate: [0, 2, 0] })], [0, 2, 0, 1, 2, 0, 0, 3, 0]);
  assert.deepEqual([...partTriangles(part, { select: () => false })], []);
});

test("an unindexed face is read as a triangle soup", () => {
  const part = { matrix: IDENTITY, faces: [{ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: null }] };
  assert.equal(partTriangles(part).length, 9);
});
