import { test } from "node:test";
import assert from "node:assert/strict";
import { creaseNormals, fitCircle, fitRevolutionAxis, invertRigid, multiply, normalize, principalAxes, symmetricEigen, transformPoint, triangleComponents, weldRemap, dot, cross } from "./geometry.mjs";
import { analyzeFace } from "./mesh.mjs";
import { cylinders, sameLine } from "./mechanisms.mjs";

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);

/** A closed cylinder as separate faces, the way Onshape exports one: two half sides and two caps. */
function cylinderFaces({ axis, centre, radius, length, segments = 48 }) {
  const a = normalize(axis);
  const helper = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(a, helper));
  const v = cross(a, u);
  const at = (angle, along, r = radius) => [0, 1, 2].map((k) => centre[k] + a[k] * along + (u[k] * Math.cos(angle) + v[k] * Math.sin(angle)) * r);
  const half = (from) => {
    const positions = [], normals = [], indices = [];
    for (let i = 0; i <= segments / 2; i++) {
      const angle = from + (Math.PI * i) / (segments / 2);
      const n = [0, 1, 2].map((k) => u[k] * Math.cos(angle) + v[k] * Math.sin(angle));
      positions.push(...at(angle, -length / 2), ...at(angle, length / 2));
      normals.push(...n, ...n);
      if (i > 0) {
        const b = 2 * i;
        indices.push(b - 2, b, b - 1, b - 1, b, b + 1);
      }
    }
    return { positions: Float32Array.from(positions), normals: Float32Array.from(normals), indices: Uint32Array.from(indices) };
  };
  return [half(0), half(Math.PI)];
}

test("symmetricEigen returns sorted eigenpairs of a known matrix", () => {
  const eig = symmetricEigen([2, 0, 0, 3, 0, 1]);
  assert.deepEqual(eig.map((e) => Math.round(e.value)), [1, 2, 3]);
  close(Math.abs(eig[0].vector[2]), 1);
});

test("fitCircle recovers a circle from noisy-free points", () => {
  const pts = Array.from({ length: 30 }, (_, i) => ({ x: 0.3 + 0.05 * Math.cos(i), y: -0.2 + 0.05 * Math.sin(i) }));
  const c = fitCircle(pts);
  close(c.x, 0.3, 1e-9);
  close(c.y, -0.2, 1e-9);
  close(c.r, 0.05, 1e-9);
});

test("a cylindrical face is recognised, with its axis, radius and centre, in any orientation", () => {
  const axis = normalize([0.3, -0.5, 0.8]);
  const [side] = cylinderFaces({ axis, centre: [0.1, 0.2, -0.3], radius: 0.0254, length: 0.5 });
  const face = analyzeFace(side.positions, side.normals, side.indices);
  assert.equal(face.kind, "cylinder");
  close(Math.abs(dot(face.axis, axis)), 1, 1e-9);
  close(face.radius, 0.0254, 1e-6);
  close(face.length, 0.5, 1e-6);
  close(face.sweep, 180, 1e-3);
  for (let k = 0; k < 3; k++) close(face.centre[k], [0.1, 0.2, -0.3][k], 1e-6);
});

test("half-cylinder faces on one axis merge into a full surface", () => {
  const faces = cylinderFaces({ axis: [0, 0, 1], centre: [-0.2857, 0.4826, 0], radius: 0.0508, length: 0.5525 }).map((f) => ({ ...f, ...analyzeFace(f.positions, f.normals, f.indices) }));
  const part = { faces, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] };
  const surfaces = cylinders(part);
  assert.equal(surfaces.length, 1);
  close(surfaces[0].sweep, 360, 1e-3);
  close(surfaces[0].length, 0.5525, 1e-6);
  assert.ok(sameLine(surfaces[0], { axis: [0, 0, -1], centre: [-0.2857, 0.4826, 0.2] }));
  assert.ok(!sameLine(surfaces[0], { axis: [0, 0, 1], centre: [-0.2837, 0.4826, 0] }));
});

test("fitRevolutionAxis finds a tube's axis from its triangles alone", () => {
  const axis = normalize([1, 1, 0]);
  const faces = cylinderFaces({ axis, centre: [0, 0.5, 0], radius: 0.019, length: 0.55 });
  const positions = Float32Array.from([...faces[0].positions, ...faces[1].positions]);
  const offset = faces[0].positions.length / 3;
  const indices = Uint32Array.from([...faces[0].indices, ...faces[1].indices.map((i) => i + offset)]);
  const fit = fitRevolutionAxis(positions, indices);
  close(Math.abs(dot(fit.direction, axis)), 1, 1e-6);
  close(fit.radius, 0.019, 2e-4);
  close(fit.point[1], 0.5, 1e-3);
});

test("principalAxes gives a plate's thickness whatever its orientation", () => {
  const t = 0.003, w = 0.2, h = 0.1;
  const corners = [];
  for (const x of [0, w]) for (const y of [0, h]) for (const z of [0, t]) corners.push([x, y, z]);
  const rot = (p) => [p[0] * 0.8 - p[2] * 0.6, p[1], p[0] * 0.6 + p[2] * 0.8];
  const positions = Float32Array.from(corners.flatMap(rot));
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const indices = Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]));
  const pa = principalAxes(positions, indices);
  close(pa.axes[0].extent, t, 1e-6);
  close(pa.axes[2].extent, w, 1e-6);
});

test("welding joins faces that share edge vertices, and components count separate bodies", () => {
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 5, 5, 5, 6, 5, 5, 5, 6, 5]);
  const remap = weldRemap(positions, 1e-6);
  assert.equal(remap[3], 1);
  assert.equal(remap[5], 2);
  const indices = Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => remap[i]));
  assert.equal(triangleComponents(indices, 9).count, 2);
});

test("crease normals keep a cube's faces flat and a tube's facets smooth", () => {
  const corners = [];
  for (const x of [0, 1]) for (const y of [0, 1]) for (const z of [0, 1]) corners.push(x, y, z);
  const quads = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  const cube = creaseNormals(Float32Array.from(corners), Uint32Array.from(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])), 35);
  assert.equal(cube.positions.length / 3, 24);
  for (let i = 0; i < cube.normals.length; i += 3) {
    const n = [cube.normals[i], cube.normals[i + 1], cube.normals[i + 2]];
    close(Math.max(...n.map(Math.abs)), 1, 1e-9);
  }

  const segments = 24, ring = [];
  for (let i = 0; i < segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    ring.push(Math.cos(a), Math.sin(a), 0, Math.cos(a), Math.sin(a), 1);
  }
  const tri = [];
  for (let i = 0; i < segments; i++) {
    const a = 2 * i, b = 2 * ((i + 1) % segments);
    tri.push(a, b, a + 1, a + 1, b, b + 1);
  }
  const tube = creaseNormals(Float32Array.from(ring), Uint32Array.from(tri), 35);
  assert.equal(tube.positions.length / 3, segments * 2, "15 degree facets share their vertices");
  close(Math.hypot(tube.normals[0], tube.normals[1]), 1, 1e-6);
});

test("rigid matrices invert", () => {
  const m = [0, 0, -1, 0, -1, 0, 0, 0, 0, 1, 0, 0, 0.1, -0.2, 0.3, 1];
  const p = transformPoint(multiply(invertRigid(m), m), [0.4, 0.5, 0.6]);
  [0.4, 0.5, 0.6].forEach((v, k) => close(p[k], v, 1e-12));
});
