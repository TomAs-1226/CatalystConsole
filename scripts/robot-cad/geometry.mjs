// Geometry for the robot CAD pipeline: matrices, boxes, welding, axis and circle fitting, and normals.
//
// Pure functions over plain arrays and typed arrays, with no dependencies, so the tests run without
// node_modules (CI's check job runs `npm test` on a bare checkout).

/* ---- 4×4 matrices, column-major like glTF ---- */

export const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export function multiply(a, b) {
  const o = new Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return o;
}

export function transformPoint(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

export function transformDirection(m, d) {
  return [m[0] * d[0] + m[4] * d[1] + m[8] * d[2], m[1] * d[0] + m[5] * d[1] + m[9] * d[2], m[2] * d[0] + m[6] * d[1] + m[10] * d[2]];
}

/** The inverse of a rotation-plus-translation matrix. */
export function invertRigid(m) {
  const t = [m[12], m[13], m[14]];
  const o = [m[0], m[4], m[8], 0, m[1], m[5], m[9], 0, m[2], m[6], m[10], 0, 0, 0, 0, 1];
  o[12] = -(o[0] * t[0] + o[4] * t[1] + o[8] * t[2]);
  o[13] = -(o[1] * t[0] + o[5] * t[1] + o[9] * t[2]);
  o[14] = -(o[2] * t[0] + o[6] * t[1] + o[10] * t[2]);
  return o;
}

export function translation(x, y, z) {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

export function determinant3(m) {
  return m[0] * (m[5] * m[10] - m[9] * m[6]) - m[4] * (m[1] * m[10] - m[9] * m[2]) + m[8] * (m[1] * m[6] - m[5] * m[2]);
}

/* ---- vectors ---- */

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const length = (a) => Math.hypot(a[0], a[1], a[2]);
export const normalize = (a) => {
  const l = length(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/* ---- boxes ---- */

export function emptyBox() {
  return { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
}

export function growBox(box, p) {
  for (let k = 0; k < 3; k++) {
    if (p[k] < box.min[k]) box.min[k] = p[k];
    if (p[k] > box.max[k]) box.max[k] = p[k];
  }
  return box;
}

export function boxOfPositions(positions, matrix = null) {
  const box = emptyBox();
  for (let i = 0; i < positions.length; i += 3) {
    const p = [positions[i], positions[i + 1], positions[i + 2]];
    growBox(box, matrix ? transformPoint(matrix, p) : p);
  }
  return box;
}

export const boxSize = (b) => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
export const boxCenter = (b) => [(b.max[0] + b.min[0]) / 2, (b.max[1] + b.min[1]) / 2, (b.max[2] + b.min[2]) / 2];
export const boxDiagonal = (b) => length(boxSize(b));

/* ---- welding and topology ---- */

/**
 * Map every vertex to the first vertex at the same position (within `tolerance`), so faces that the
 * exporter wrote with their own copies of shared edge vertices become one connected surface.
 */
export function weldRemap(positions, tolerance = 1e-6) {
  const count = positions.length / 3;
  const remap = new Uint32Array(count);
  const cells = new Map();
  const q = 1 / tolerance;
  for (let i = 0; i < count; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const kx = Math.round(x * q), ky = Math.round(y * q), kz = Math.round(z * q);
    let found = -1;
    /* A point near a cell boundary can round either way, so look in the neighbouring cells too. */
    for (let dx = -1; dx <= 1 && found < 0; dx++) {
      for (let dy = -1; dy <= 1 && found < 0; dy++) {
        for (let dz = -1; dz <= 1 && found < 0; dz++) {
          const list = cells.get(`${kx + dx},${ky + dy},${kz + dz}`);
          if (!list) continue;
          for (const j of list) {
            if (Math.abs(positions[j * 3] - x) <= tolerance && Math.abs(positions[j * 3 + 1] - y) <= tolerance && Math.abs(positions[j * 3 + 2] - z) <= tolerance) {
              found = j;
              break;
            }
          }
        }
      }
    }
    if (found >= 0) remap[i] = found;
    else {
      remap[i] = i;
      const key = `${kx},${ky},${kz}`;
      const list = cells.get(key);
      if (list) list.push(i);
      else cells.set(key, [i]);
    }
  }
  return remap;
}

/** Connected components of a triangle list over (already welded) vertex ids: a component id per triangle. */
export function triangleComponents(indices, vertexCount) {
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) parent[i] = i;
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    a = find(a);
    b = find(b);
    if (a !== b) parent[a] = b;
  };
  for (let t = 0; t < indices.length; t += 3) {
    union(indices[t], indices[t + 1]);
    union(indices[t], indices[t + 2]);
  }
  const ids = new Map();
  const out = new Uint32Array(indices.length / 3);
  for (let t = 0; t < indices.length; t += 3) {
    const root = find(indices[t]);
    if (!ids.has(root)) ids.set(root, ids.size);
    out[t / 3] = ids.get(root);
  }
  return { ids: out, count: ids.size };
}

/* ---- symmetric 3×3 eigen decomposition (Jacobi) ---- */

/**
 * Eigenvalues and unit eigenvectors of a symmetric 3×3 matrix given as [xx, xy, xz, yy, yz, zz],
 * sorted by ascending eigenvalue.
 */
export function symmetricEigen([xx, xy, xz, yy, yz, zz]) {
  const a = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-15 * (Math.abs(a[0][0]) + Math.abs(a[1][1]) + Math.abs(a[2][2]) + 1e-300)) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq;
        a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk;
        a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq;
        v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  const pairs = [0, 1, 2].map((i) => ({ value: a[i][i], vector: normalize([v[0][i], v[1][i], v[2][i]]) }));
  pairs.sort((p, q) => p.value - q.value);
  return pairs;
}

/* ---- fitting ---- */

/**
 * Face normals and areas of a triangle list. `positions` is a flat xyz array; `indices` a flat list of
 * vertex ids (or null for a non-indexed list).
 */
export function faceNormals(positions, indices) {
  const triangles = (indices ? indices.length : positions.length / 3) / 3;
  const normals = new Float64Array(triangles * 3);
  const areas = new Float64Array(triangles);
  const centroids = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    const a = indices ? indices[t * 3] : t * 3;
    const b = indices ? indices[t * 3 + 1] : t * 3 + 1;
    const c = indices ? indices[t * 3 + 2] : t * 3 + 2;
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const ux = positions[b * 3] - ax, uy = positions[b * 3 + 1] - ay, uz = positions[b * 3 + 2] - az;
    const vx = positions[c * 3] - ax, vy = positions[c * 3 + 1] - ay, vz = positions[c * 3 + 2] - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    areas[t] = len / 2;
    if (len > 0) {
      normals[t * 3] = nx / len;
      normals[t * 3 + 1] = ny / len;
      normals[t * 3 + 2] = nz / len;
    }
    centroids[t * 3] = ax + (ux + vx) / 3;
    centroids[t * 3 + 1] = ay + (uy + vy) / 3;
    centroids[t * 3 + 2] = az + (uz + vz) / 3;
  }
  return { normals, areas, centroids, triangles };
}

/**
 * The axis of a surface of revolution (a tube, a roller, a wheel, a shaft) from its geometry.
 *
 * Every face of a cylinder has a normal perpendicular to the axis, so the axis is the direction the
 * area-weighted normals have least of: the smallest eigenvector of their scatter matrix. The end caps
 * (normals along the axis) pull the other way, so faces are only counted when they are near
 * perpendicular to the first estimate, and the estimate is refined once. The point on the axis is
 * the centre of a least-squares circle through the side faces' centroids, projected along the axis.
 *
 * Returns `{ direction, point, radius, residual, sideArea }`: the unit direction (sign arbitrary), the
 * point on the axis nearest the centroid of the side faces, the fitted radius, and the RMS radial
 * residual relative to the radius, which is small for a true surface of revolution.
 */
export function fitRevolutionAxis(positions, indices, { hint = null, minRadius = 0 } = {}) {
  const { normals, areas, centroids, triangles } = faceNormals(positions, indices);
  const scatter = (weightOf) => {
    const m = [0, 0, 0, 0, 0, 0];
    for (let t = 0; t < triangles; t++) {
      const w = weightOf(t);
      if (!w) continue;
      const x = normals[t * 3], y = normals[t * 3 + 1], z = normals[t * 3 + 2];
      m[0] += w * x * x; m[1] += w * x * y; m[2] += w * x * z;
      m[3] += w * y * y; m[4] += w * y * z; m[5] += w * z * z;
    }
    return m;
  };
  let axis = hint ? normalize(hint) : symmetricEigen(scatter((t) => areas[t]))[0].vector;
  let side = null;
  for (let pass = 0; pass < 3; pass++) {
    side = (t) => (Math.abs(normals[t * 3] * axis[0] + normals[t * 3 + 1] * axis[1] + normals[t * 3 + 2] * axis[2]) < 0.2 ? areas[t] : 0);
    if (hint && pass === 0) continue;
    axis = symmetricEigen(scatter(side))[0].vector;
  }
  /* A 2D frame perpendicular to the axis. */
  const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize(cross(axis, helper));
  const v = cross(axis, u);
  const pts = [];
  let along = 0, weight = 0, sideArea = 0;
  for (let t = 0; t < triangles; t++) {
    const w = side(t);
    if (!w) continue;
    const p = [centroids[t * 3], centroids[t * 3 + 1], centroids[t * 3 + 2]];
    pts.push({ x: dot(p, u), y: dot(p, v), w });
    along += dot(p, axis) * w;
    weight += w;
    sideArea += w;
  }
  if (pts.length < 3) return null;
  const circle = fitCircle(pts, minRadius);
  if (!circle) return null;
  const a = along / weight;
  const point = add(add(scale(u, circle.x), scale(v, circle.y)), scale(axis, a));
  return { direction: axis, point, radius: circle.r, residual: circle.residual, sideArea };
}

/**
 * Least-squares circle through weighted 2D points {x, y, w} (Kåsa's algebraic fit, then a few
 * Gauss-Newton steps on the geometric error). Returns { x, y, r, residual } with the residual as RMS
 * radial error over r, or null when the points are degenerate.
 */
export function fitCircle(points, minRadius = 0) {
  let sw = 0, sx = 0, sy = 0;
  for (const p of points) {
    const w = p.w ?? 1;
    sw += w; sx += w * p.x; sy += w * p.y;
  }
  if (!sw) return null;
  const mx = sx / sw, my = sy / sw;
  /* Solve [Suu Suv; Suv Svv][a; b] = [Suuu+Suvv; Svvv+Suuv]/2 in coordinates centred on the mean. */
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of points) {
    const w = p.w ?? 1;
    const u = p.x - mx, v = p.y - my;
    suu += w * u * u; suv += w * u * v; svv += w * v * v;
    suuu += w * u * u * u; svvv += w * v * v * v; suvv += w * u * v * v; svuu += w * v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-24) return null;
  const bu = (suuu + suvv) / 2, bv = (svvv + svuu) / 2;
  let cx = (bu * svv - bv * suv) / det;
  let cy = (suu * bv - suv * bu) / det;
  let r = Math.sqrt(cx * cx + cy * cy + (suu + svv) / sw);
  cx += mx;
  cy += my;
  for (let iter = 0; iter < 20; iter++) {
    /* Gauss-Newton on sum w (|p - c| - r)^2. */
    let j00 = 0, j01 = 0, j02 = 0, j11 = 0, j12 = 0, j22 = 0, g0 = 0, g1 = 0, g2 = 0;
    for (const p of points) {
      const w = p.w ?? 1;
      const dx = cx - p.x, dy = cy - p.y;
      const d = Math.hypot(dx, dy) || 1e-12;
      const res = d - r;
      const a0 = dx / d, a1 = dy / d, a2 = -1;
      j00 += w * a0 * a0; j01 += w * a0 * a1; j02 += w * a0 * a2;
      j11 += w * a1 * a1; j12 += w * a1 * a2; j22 += w * a2 * a2;
      g0 += w * a0 * res; g1 += w * a1 * res; g2 += w * a2 * res;
    }
    const step = solve3([[j00, j01, j02], [j01, j11, j12], [j02, j12, j22]], [-g0, -g1, -g2]);
    if (!step) break;
    cx += step[0]; cy += step[1]; r += step[2];
    if (Math.hypot(step[0], step[1], step[2]) < 1e-12) break;
  }
  if (!(r > minRadius)) return null;
  let err = 0;
  for (const p of points) {
    const w = p.w ?? 1;
    const d = Math.hypot(p.x - cx, p.y - cy) - r;
    err += w * d * d;
  }
  return { x: cx, y: cy, r, residual: Math.sqrt(err / sw) / r };
}

function solve3(m, b) {
  const det =
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
    m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
    m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  if (Math.abs(det) < 1e-30) return null;
  const col = (k) => m.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)));
  const d = (n) =>
    n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) - n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0]) + n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0]);
  return [d(col(0)) / det, d(col(1)) / det, d(col(2)) / det];
}

/**
 * The principal axes of a triangle surface, area weighted: `{ center, axes: [{ vector, extent }] }`
 * with the axes sorted from the smallest spread to the largest and `extent` the full size along each.
 * A plate's first axis is its normal and its first extent its thickness, whatever way it was modelled.
 */
export function principalAxes(positions, indices) {
  const { areas, centroids, triangles } = faceNormals(positions, indices);
  let total = 0;
  const c = [0, 0, 0];
  for (let t = 0; t < triangles; t++) {
    total += areas[t];
    for (let k = 0; k < 3; k++) c[k] += areas[t] * centroids[t * 3 + k];
  }
  if (!total) return null;
  for (let k = 0; k < 3; k++) c[k] /= total;
  /* The exact second moment of each triangle's area, (A/12)(Σ vᵢvᵢᵀ + (Σ vᵢ)(Σ vᵢ)ᵀ), so the axes do not
     depend on how a face happens to be triangulated. */
  const m = [0, 0, 0, 0, 0, 0];
  const idx = (t, k) => (indices ? indices[t * 3 + k] : t * 3 + k);
  for (let t = 0; t < triangles; t++) {
    const v = [0, 1, 2].map((k) => {
      const i = idx(t, k);
      return [positions[i * 3] - c[0], positions[i * 3 + 1] - c[1], positions[i * 3 + 2] - c[2]];
    });
    const s = [v[0][0] + v[1][0] + v[2][0], v[0][1] + v[1][1] + v[2][1], v[0][2] + v[1][2] + v[2][2]];
    const w = areas[t] / 12;
    const pairs = [[0, 0], [0, 1], [0, 2], [1, 1], [1, 2], [2, 2]];
    pairs.forEach(([a, b], n) => {
      m[n] += w * (v[0][a] * v[0][b] + v[1][a] * v[1][b] + v[2][a] * v[2][b] + s[a] * s[b]);
    });
  }
  const eig = symmetricEigen(m);
  const axes = eig.map(({ vector }) => {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const d = positions[i] * vector[0] + positions[i + 1] * vector[1] + positions[i + 2] * vector[2];
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    return { vector, extent: hi - lo };
  });
  return { center: c, axes };
}

/* ---- normals ---- */

/**
 * Split vertices at creases and give each corner a normal: faces meeting at less than `creaseDeg` share
 * a smooth normal, faces meeting at more keep their own, so a flat face stays flat to its edge while a
 * tube's facets blend into a round.
 *
 * Input is a welded indexed triangle list. Output is `{ positions, normals, indices }` with vertices
 * duplicated only where a crease demands it. Contributions are weighted by the corner angle, which is
 * what keeps a thin fillet sliver from tilting the normal of the big face beside it.
 */
export function creaseNormals(positions, indices, creaseDeg = 35) {
  const triangles = indices.length / 3;
  const vertexCount = positions.length / 3;
  const { normals: fn } = faceNormals(positions, indices);
  const limit = Math.cos((creaseDeg * Math.PI) / 180);
  /* Corner angles. */
  const angle = new Float64Array(triangles * 3);
  for (let t = 0; t < triangles; t++) {
    for (let k = 0; k < 3; k++) {
      const a = indices[t * 3 + k], b = indices[t * 3 + ((k + 1) % 3)], c = indices[t * 3 + ((k + 2) % 3)];
      const ux = positions[b * 3] - positions[a * 3], uy = positions[b * 3 + 1] - positions[a * 3 + 1], uz = positions[b * 3 + 2] - positions[a * 3 + 2];
      const vx = positions[c * 3] - positions[a * 3], vy = positions[c * 3 + 1] - positions[a * 3 + 1], vz = positions[c * 3 + 2] - positions[a * 3 + 2];
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz);
      angle[t * 3 + k] = lu && lv ? Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy + uz * vz) / (lu * lv)))) : 0;
    }
  }
  /* Corners around each vertex. */
  const start = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < indices.length; i++) start[indices[i] + 1]++;
  for (let v = 0; v < vertexCount; v++) start[v + 1] += start[v];
  const fill = start.slice(0, vertexCount);
  const corners = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) corners[fill[indices[i]]++] = i;

  const outPos = [];
  const outNrm = [];
  const outIdx = new Uint32Array(indices.length);
  const key = new Map();
  for (let v = 0; v < vertexCount; v++) {
    key.clear();
    for (let s = start[v]; s < start[v + 1]; s++) {
      const corner = corners[s];
      const t = (corner / 3) | 0;
      let nx = 0, ny = 0, nz = 0;
      for (let s2 = start[v]; s2 < start[v + 1]; s2++) {
        const c2 = corners[s2];
        const t2 = (c2 / 3) | 0;
        const d = fn[t * 3] * fn[t2 * 3] + fn[t * 3 + 1] * fn[t2 * 3 + 1] + fn[t * 3 + 2] * fn[t2 * 3 + 2];
        if (t2 !== t && d < limit) continue;
        const w = angle[c2];
        nx += fn[t2 * 3] * w; ny += fn[t2 * 3 + 1] * w; nz += fn[t2 * 3 + 2] * w;
      }
      let len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-12)) {
        nx = fn[t * 3]; ny = fn[t * 3 + 1]; nz = fn[t * 3 + 2];
        len = Math.hypot(nx, ny, nz) || 1;
      }
      nx /= len; ny /= len; nz /= len;
      /* Corners whose normals agree closely share one output vertex. */
      const k = `${Math.round(nx * 2000)},${Math.round(ny * 2000)},${Math.round(nz * 2000)}`;
      let out = key.get(k);
      if (out === undefined) {
        out = outPos.length / 3;
        key.set(k, out);
        outPos.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
        outNrm.push(nx, ny, nz);
      }
      outIdx[corner] = out;
    }
  }
  return { positions: Float32Array.from(outPos), normals: Float32Array.from(outNrm), indices: outIdx };
}
