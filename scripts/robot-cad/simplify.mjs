// Simplification with meshoptimizer, at an absolute error in metres.
//
// The input is a welded, compacted mesh (see mesh.mjs weldFaces): meshoptimizer treats two vertices at
// one position as a seam it must not collapse across, so a vertex buffer still holding the exporter's
// duplicates would barely simplify at all. Material boundaries are deliberately left as such seams.

import { MeshoptSimplifier } from "meshoptimizer";

export const simplifierReady = MeshoptSimplifier.ready;

/**
 * Simplify `mesh` ({ positions, indices, triangleMaterial }) so no vertex moves further than `error`
 * metres from the surface. Returns a new mesh with the same fields, degenerate triangles removed.
 */
export function simplify(mesh, error) {
  if (!(error > 0) || mesh.indices.length < 36) return mesh;
  const [indices] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, 0, error, ["ErrorAbsolute"]);
  /* meshoptimizer keeps original vertices, so a surviving triangle's material is its first vertex's:
     vertices are never shared across materials. */
  const materialOfVertex = new Int32Array(mesh.positions.length / 3);
  for (let t = 0; t < mesh.indices.length / 3; t++) {
    const m = mesh.triangleMaterial[t];
    materialOfVertex[mesh.indices[t * 3]] = m;
    materialOfVertex[mesh.indices[t * 3 + 1]] = m;
    materialOfVertex[mesh.indices[t * 3 + 2]] = m;
  }
  const kept = [];
  const triangleMaterial = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t], b = indices[t + 1], c = indices[t + 2];
    if (a === b || b === c || a === c) continue;
    kept.push(a, b, c);
    triangleMaterial.push(materialOfVertex[a]);
  }
  return { positions: mesh.positions, indices: Uint32Array.from(kept), triangleMaterial: Int32Array.from(triangleMaterial) };
}
