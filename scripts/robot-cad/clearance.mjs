/* Does a ball of this size fit here, given the robot's actual geometry?
 *
 * The hopper's interior was described analytically - between the side polycarbonate, under the top
 * polycarbonate, in front of the feeder rollers, above the sloped conveyor floor - and balls were packed
 * inside that description. It is a good description of the volume and a bad description of the robot:
 * there are printed uprights, shooter side plates and brackets standing inside it, and a ball packed
 * against the analytic walls can sit half way through one of them. On a 3D view where the robot fills the
 * screen that reads immediately as a hole in the picture.
 *
 * So the packing is checked against the triangles themselves. Every part that could be in the way goes
 * into a uniform grid of cells the size of a ball; a candidate centre looks only at the cells a ball of
 * that radius could touch, and is rejected if any triangle in them comes within the radius.
 *
 * Distances are exact (closest point on a triangle), so a ball resting against the inside face of a
 * 1/16 in wall is kept while one a millimetre into the wall is not.
 */

import { transformPoint } from "./geometry.mjs";

/**
 * A part's triangles in the working frame, as a flat array of nine numbers each. `translate` moves the
 * part afterwards, which is how the intake's own structure is tested at the position it is in for the
 * packing being checked. `select(faceIndex, face)` may leave faces out.
 */
export function partTriangles(part, { translate = null, select = null } = {}) {
  const out = [];
  const [dx, dy, dz] = translate ?? [0, 0, 0];
  part.faces.forEach((face, index) => {
    if (select && !select(index, face)) return;
    const { positions, indices } = face;
    const count = indices ? indices.length : positions.length / 3;
    for (let i = 0; i < count; i += 3) {
      for (let k = 0; k < 3; k++) {
        const v = indices ? indices[i + k] : i + k;
        const p = transformPoint(part.matrix, [positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]]);
        out.push(p[0] + dx, p[1] + dy, p[2] + dz);
      }
    }
  });
  return out;
}

/**
 * A grid over `triangles` (flat, nine numbers each) for sphere queries. `cell` is the cell's side; a ball
 * diameter is a good choice, because then a sphere query touches at most eight cells.
 */
export function buildSolids(triangles, cell) {
  const size = cell > 0 ? cell : 0.05;
  const cells = new Map();
  const key = (i, j, k) => `${i},${j},${k}`;
  const at = (v) => Math.floor(v / size);
  const count = triangles.length / 9;
  for (let t = 0; t < count; t++) {
    const o = t * 9;
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < 3; v++) {
      const x = triangles[o + v * 3];
      const y = triangles[o + v * 3 + 1];
      const z = triangles[o + v * 3 + 2];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (z < minZ) minZ = z;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      if (z > maxZ) maxZ = z;
    }
    for (let i = at(minX); i <= at(maxX); i++) {
      for (let j = at(minY); j <= at(maxY); j++) {
        for (let k = at(minZ); k <= at(maxZ); k++) {
          const id = key(i, j, k);
          let list = cells.get(id);
          if (!list) cells.set(id, (list = []));
          list.push(o);
        }
      }
    }
  }
  return { triangles, cells, size, count };
}

/**
 * The distance from `p` to the triangle `a b c` - the closest point on it, by Ericson's barycentric
 * regions: the three corners, the three edges, then the interior.
 */
export function distanceToTriangle(p, a, b, c) {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2];
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2];
  const far = (x, y, z) => Math.hypot(p[0] - x, p[1] - y, p[2] - z);

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return far(a[0], a[1], a[2]);

  const bpx = p[0] - b[0], bpy = p[1] - b[1], bpz = p[2] - b[2];
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return far(b[0], b[1], b[2]);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return far(a[0] + abx * v, a[1] + aby * v, a[2] + abz * v);
  }

  const cpx = p[0] - c[0], cpy = p[1] - c[1], cpz = p[2] - c[2];
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return far(c[0], c[1], c[2]);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return far(a[0] + acx * w, a[1] + acy * w, a[2] + acz * w);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return far(b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w);
  }

  const denom = va + vb + vc;
  if (!(denom > 0)) return far(a[0], a[1], a[2]);
  const v = vb / denom;
  const w = vc / denom;
  return far(a[0] + abx * v + acx * w, a[1] + aby * v + acy * w, a[2] + abz * v + acz * w);
}

/** Whether a ball of `radius` centred at `centre` touches nothing in the grid. */
export function clearOfSolids(solids, centre, radius) {
  if (!solids || solids.count === 0) return true;
  const { triangles, cells, size } = solids;
  const lo = (v) => Math.floor((v - radius) / size);
  const hi = (v) => Math.floor((v + radius) / size);
  const a = [0, 0, 0];
  const b = [0, 0, 0];
  const c = [0, 0, 0];
  const seen = new Set();
  for (let i = lo(centre[0]); i <= hi(centre[0]); i++) {
    for (let j = lo(centre[1]); j <= hi(centre[1]); j++) {
      for (let k = lo(centre[2]); k <= hi(centre[2]); k++) {
        const list = cells.get(`${i},${j},${k}`);
        if (!list) continue;
        for (const o of list) {
          if (seen.has(o)) continue;
          seen.add(o);
          a[0] = triangles[o]; a[1] = triangles[o + 1]; a[2] = triangles[o + 2];
          b[0] = triangles[o + 3]; b[1] = triangles[o + 4]; b[2] = triangles[o + 5];
          c[0] = triangles[o + 6]; c[1] = triangles[o + 7]; c[2] = triangles[o + 8];
          if (distanceToTriangle(centre, a, b, c) < radius) return false;
        }
      }
    }
  }
  return true;
}
