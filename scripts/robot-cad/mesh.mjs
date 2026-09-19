// CAD meshes as the pipeline needs them: one record per B-rep face, and a welded part mesh.
//
// Onshape writes every B-rep face as its own primitive with its own vertices and exact normals. That is
// a gift for analysis (a cylindrical face says so through its normals) and a problem for simplification
// (faces that do not share vertices cannot be collapsed into each other), so this module keeps both: the
// faces, analysed, and a welded, compacted mesh of the whole part. No dependencies.

import { readAccessor } from "./gltf-read.mjs";
import { cross, dot, faceNormals, fitCircle, normalize, add, scale, symmetricEigen, weldRemap } from "./geometry.mjs";

/**
 * What kind of surface a face is, from its vertex normals.
 *
 * A plane has one normal. A cylinder's normals all lie in the plane perpendicular to its axis, so the
 * scatter of its normals has exactly one zero eigenvalue, whose eigenvector is the axis; the radius and
 * centre then come from a circle through the vertices projected along it. Anything else (a cone, a
 * fillet torus, a spline) is "other".
 */
export function analyzeFace(positions, normals, indices) {
  const { areas } = faceNormals(positions, indices);
  let area = 0;
  for (const a of areas) area += a;
  const n = positions.length / 3;
  const m = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = normals[i * 3], y = normals[i * 3 + 1], z = normals[i * 3 + 2];
    m[0] += x * x; m[1] += x * y; m[2] += x * z; m[3] += y * y; m[4] += y * z; m[5] += z * z;
  }
  const eig = symmetricEigen(m.map((v) => v / Math.max(n, 1)));
  const out = { area, kind: "other" };
  if (n >= 3 && eig[1].value < 1e-6) {
    /* The eigenvector's sign is arbitrary; the exporter's normals say which way the face looks. */
    let sx = 0, sy = 0, sz = 0;
    for (let i = 0; i < n; i++) {
      sx += normals[i * 3]; sy += normals[i * 3 + 1]; sz += normals[i * 3 + 2];
    }
    const e = eig[2].vector;
    const normal = e[0] * sx + e[1] * sy + e[2] * sz < 0 ? [-e[0], -e[1], -e[2]] : e;
    let offset = 0;
    for (let i = 0; i < n; i++) offset += positions[i * 3] * normal[0] + positions[i * 3 + 1] * normal[1] + positions[i * 3 + 2] * normal[2];
    return { ...out, kind: "plane", normal, offset: offset / n };
  }
  if (n >= 6 && eig[0].value < 1e-6 && eig[1].value > 1e-4) {
    const axis = eig[0].vector;
    const helper = Math.abs(axis[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize(cross(axis, helper));
    const v = cross(axis, u);
    const pts = [];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const p = [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]];
      pts.push({ x: dot(p, u), y: dot(p, v) });
      const d = dot(p, axis);
      if (d < lo) lo = d;
      if (d > hi) hi = d;
    }
    const circle = fitCircle(pts);
    if (circle && circle.residual < 0.02) {
      /* How far round the axis the face goes: a full tube reads 360, a fillet a quarter of that. */
      const angles = pts.map((p) => Math.atan2(p.y - circle.y, p.x - circle.x)).sort((a, b) => a - b);
      let gap = angles[0] + 2 * Math.PI - angles[angles.length - 1];
      for (let i = 1; i < angles.length; i++) gap = Math.max(gap, angles[i] - angles[i - 1]);
      const centre = add(add(scale(u, circle.x), scale(v, circle.y)), scale(axis, (lo + hi) / 2));
      return { ...out, kind: "cylinder", axis, centre, radius: circle.r, length: hi - lo, sweep: 360 - (gap * 180) / Math.PI };
    }
  }
  return out;
}

/**
 * Read a glTF mesh as analysed faces. `faces[i]` has the primitive's material index, its local
 * positions, normals and indices, and the analysis from analyzeFace.
 */
export function readMeshFaces(gltf, meshIndex) {
  const mesh = gltf.json.meshes[meshIndex];
  return mesh.primitives.map((primitive) => {
    if ((primitive.mode ?? 4) !== 4) return null;
    const positions = readAccessor(gltf, primitive.attributes.POSITION);
    const normals = primitive.attributes.NORMAL !== undefined ? readAccessor(gltf, primitive.attributes.NORMAL) : null;
    let indices;
    if (primitive.indices !== undefined) indices = Uint32Array.from(readAccessor(gltf, primitive.indices));
    else indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
    const analysis = normals ? analyzeFace(positions, normals, indices) : { area: 0, kind: "other" };
    return { material: primitive.material ?? -1, positions, normals, indices, ...analysis };
  }).filter(Boolean);
}

/**
 * Weld a part's faces into one indexed mesh, vertices shared across faces of the same material and
 * kept apart across materials, so a colour boundary survives simplification as a seam.
 *
 * `select(faceIndex)` may leave faces out; `transform` maps local positions to the frame the result is
 * wanted in.
 *
 * Returns `{ positions, indices, triangleMaterial, triangleFace, flipped }`. Triangles whose winding
 * disagrees with the exporter's normals are flipped, and `flipped` counts them.
 */
export function weldFaces(faces, { select = null, transform = null, tolerance = 1e-6 } = {}) {
  let vertexCount = 0;
  for (let fi = 0; fi < faces.length; fi++) {
    if (!select || select(fi)) vertexCount += faces[fi].positions.length / 3;
  }
  const raw = new Float32Array(vertexCount * 3);
  const rawMaterial = new Int32Array(vertexCount);
  const tris = [];
  const triMaterial = [];
  const triFace = [];
  let flipped = 0;
  let base = 0;
  faces.forEach((face, fi) => {
    if (select && !select(fi)) return;
    const n = face.positions.length / 3;
    for (let i = 0; i < n; i++) {
      let p = [face.positions[i * 3], face.positions[i * 3 + 1], face.positions[i * 3 + 2]];
      if (transform) p = transform(p);
      raw[(base + i) * 3] = p[0];
      raw[(base + i) * 3 + 1] = p[1];
      raw[(base + i) * 3 + 2] = p[2];
      rawMaterial[base + i] = face.material;
    }
    for (let t = 0; t < face.indices.length; t += 3) {
      let a = face.indices[t], b = face.indices[t + 1], c = face.indices[t + 2];
      if (face.normals) {
        /* The exporter's normals are exact; the triangle's own winding should agree with them. */
        const ux = face.positions[b * 3] - face.positions[a * 3], uy = face.positions[b * 3 + 1] - face.positions[a * 3 + 1], uz = face.positions[b * 3 + 2] - face.positions[a * 3 + 2];
        const vx = face.positions[c * 3] - face.positions[a * 3], vy = face.positions[c * 3 + 1] - face.positions[a * 3 + 1], vz = face.positions[c * 3 + 2] - face.positions[a * 3 + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const sx = face.normals[a * 3] + face.normals[b * 3] + face.normals[c * 3];
        const sy = face.normals[a * 3 + 1] + face.normals[b * 3 + 1] + face.normals[c * 3 + 1];
        const sz = face.normals[a * 3 + 2] + face.normals[b * 3 + 2] + face.normals[c * 3 + 2];
        if (nx * sx + ny * sy + nz * sz < 0) {
          [b, c] = [c, b];
          flipped++;
        }
      }
      tris.push(base + a, base + b, base + c);
      triMaterial.push(face.material);
      triFace.push(fi);
    }
    base += n;
  });

  /* Weld per material: a vertex joins the first vertex at its position that has the same material. */
  const remap = weldRemap(raw, tolerance);
  const firstByMaterial = new Map();
  const key = (i) => `${remap[i]}|${rawMaterial[i]}`;
  const canonical = new Uint32Array(vertexCount);
  for (let i = 0; i < vertexCount; i++) {
    const k = key(i);
    const found = firstByMaterial.get(k);
    if (found === undefined) {
      firstByMaterial.set(k, i);
      canonical[i] = i;
    } else canonical[i] = found;
  }

  /* Compact: only referenced canonical vertices survive, so the simplifier sees no phantom seams. */
  const newIndex = new Int32Array(vertexCount).fill(-1);
  const positions = [];
  const indices = [];
  const triangleMaterial = [];
  const triangleFace = [];
  for (let t = 0; t < tris.length; t += 3) {
    const ids = [canonical[tris[t]], canonical[tris[t + 1]], canonical[tris[t + 2]]];
    if (ids[0] === ids[1] || ids[1] === ids[2] || ids[0] === ids[2]) continue;
    for (const id of ids) {
      if (newIndex[id] < 0) {
        newIndex[id] = positions.length / 3;
        positions.push(raw[id * 3], raw[id * 3 + 1], raw[id * 3 + 2]);
      }
      indices.push(newIndex[id]);
    }
    triangleMaterial.push(triMaterial[t / 3]);
    triangleFace.push(triFace[t / 3]);
  }
  return {
    positions: Float32Array.from(positions),
    indices: Uint32Array.from(indices),
    triangleMaterial: Int32Array.from(triangleMaterial),
    triangleFace: Int32Array.from(triangleFace),
    flipped,
  };
}

/** Vertices of a welded mesh grouped by material: `Map(material → { positions, indices })`, compacted. */
export function splitByMaterial(mesh, materialOf = (m) => m) {
  const groups = new Map();
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const material = materialOf(mesh.triangleMaterial[t]);
    let g = groups.get(material);
    if (!g) {
      g = { positions: [], indices: [], map: new Map() };
      groups.set(material, g);
    }
    for (let k = 0; k < 3; k++) {
      const v = mesh.indices[t * 3 + k];
      let id = g.map.get(v);
      if (id === undefined) {
        id = g.positions.length / 3;
        g.map.set(v, id);
        g.positions.push(mesh.positions[v * 3], mesh.positions[v * 3 + 1], mesh.positions[v * 3 + 2]);
      }
      g.indices.push(id);
    }
  }
  const out = new Map();
  for (const [material, g] of groups) out.set(material, { positions: Float32Array.from(g.positions), indices: Uint32Array.from(g.indices) });
  return out;
}
