// Write the robot as a quantized GLB a runtime can animate with plain node transforms.
//
// Every named node (robot, static, hood, intake, module-fl, wheel-fl, roller-…) carries only the
// transform a runtime drives: its pivot or origin as a translation, no rotation, no scale. Its geometry
// hangs from a child node "<name>-geometry" that holds the mesh and the dequantization transform.
//
// Positions are 16-bit and normals 8-bit, both normalized, under KHR_mesh_quantization, which three.js
// reads in core. Draco and meshopt compression would each need a decoder shipped with the app; this is
// the choice scripts/field-cad.mjs made for the field for the same reason.

import { createHash } from "node:crypto";
import { Document, NodeIO } from "@gltf-transform/core";
import { KHRMeshQuantization } from "@gltf-transform/extensions";

const srgbToLinear = (c) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

/**
 * `root` is a tree of { name, translation?, children?, primitives?, extras? }, primitives being
 * { material, positions, normals, indices } in the node's frame. `materials` maps a primitive's
 * material key to { name, colour: [r, g, b] bytes, metallic, roughness, alpha?, doubleSided?, extras? }.
 *
 * Returns { bytes, triangles, meshes, sharedMeshes, primitives }.
 */
export async function writeGlb(path, root, materials, { generator = "catalyst-console robot-cad", extras = {} } = {}) {
  const doc = new Document();
  doc.getRoot().getAsset().generator = generator;
  doc.createExtension(KHRMeshQuantization).setRequired(true);
  const buffer = doc.createBuffer();
  const scene = doc.createScene("robot");
  doc.getRoot().setDefaultScene(scene);
  scene.setExtras(extras);

  const materialCache = new Map();
  const materialFor = (key) => {
    if (materialCache.has(key)) return materialCache.get(key);
    const spec = materials.get(key);
    if (!spec) throw new Error(`no material spec for ${key}`);
    const m = doc
      .createMaterial(spec.name)
      .setBaseColorFactor([...spec.colour.map(srgbToLinear), spec.alpha ?? 1])
      .setMetallicFactor(spec.metallic)
      .setRoughnessFactor(spec.roughness)
      .setDoubleSided(!!spec.doubleSided)
      .setExtras(spec.extras ?? {});
    if ((spec.alpha ?? 1) < 1) m.setAlphaMode("BLEND");
    materialCache.set(key, m);
    return m;
  };

  const meshCache = new Map();
  const stats = { triangles: 0, meshes: 0, sharedMeshes: 0, primitives: 0 };

  const build = (spec) => {
    const node = doc.createNode(spec.name);
    if (spec.translation) node.setTranslation(spec.translation.map((v) => Math.fround(v)));
    if (spec.extras) node.setExtras(spec.extras);
    const prims = (spec.primitives || []).filter((p) => p.indices.length);
    if (prims.length) {
      /* One quantization volume for the node's primitives: centred on their box, uniform scale. */
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const p of prims) {
        for (let i = 0; i < p.positions.length; i += 3) {
          for (let k = 0; k < 3; k++) {
            min[k] = Math.min(min[k], p.positions[i + k]);
            max[k] = Math.max(max[k], p.positions[i + k]);
          }
        }
      }
      const centre = min.map((v, k) => (v + max[k]) / 2);
      const half = Math.max(1e-6, ...max.map((v, k) => (v - min[k]) / 2));
      const encoded = prims.map((p) => {
        const count = p.positions.length / 3;
        const q = new Int16Array(count * 3);
        const n = new Int8Array(count * 3);
        for (let i = 0; i < count * 3; i++) {
          const k = i % 3;
          q[i] = Math.max(-32767, Math.min(32767, Math.round(((p.positions[i] - centre[k]) / half) * 32767)));
          n[i] = Math.max(-127, Math.min(127, Math.round(p.normals[i] * 127)));
        }
        const indices = count < 65536 ? Uint16Array.from(p.indices) : Uint32Array.from(p.indices);
        return { material: p.material, q, n, indices };
      });
      const hash = createHash("sha1");
      hash.update(JSON.stringify([centre.map((v) => v.toFixed(6)), half.toFixed(7)]));
      for (const e of encoded) {
        hash.update(String(e.material));
        hash.update(Buffer.from(e.q.buffer));
        hash.update(Buffer.from(e.n.buffer));
        hash.update(Buffer.from(e.indices.buffer));
      }
      const key = hash.digest("hex");
      let mesh = meshCache.get(key);
      if (mesh) stats.sharedMeshes++;
      else {
        mesh = doc.createMesh(spec.name);
        for (const e of encoded) {
          const prim = doc
            .createPrimitive()
            .setAttribute("POSITION", doc.createAccessor().setType("VEC3").setArray(e.q).setNormalized(true).setBuffer(buffer))
            .setAttribute("NORMAL", doc.createAccessor().setType("VEC3").setArray(e.n).setNormalized(true).setBuffer(buffer))
            .setIndices(doc.createAccessor().setType("SCALAR").setArray(e.indices).setBuffer(buffer))
            .setMaterial(materialFor(e.material));
          mesh.addPrimitive(prim);
          stats.primitives++;
        }
        meshCache.set(key, mesh);
        stats.meshes++;
      }
      for (const e of encoded) stats.triangles += e.indices.length / 3;
      const geometry = doc
        .createNode(`${spec.name}-geometry`)
        .setTranslation(centre.map((v) => Math.fround(v)))
        .setScale([half, half, half].map((v) => Math.fround(v)))
        .setMesh(mesh);
      node.addChild(geometry);
    }
    for (const child of spec.children || []) node.addChild(build(child));
    return node;
  };

  scene.addChild(build(root));
  const io = new NodeIO().registerExtensions([KHRMeshQuantization]);
  const bytes = await io.writeBinary(doc);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, bytes);
  return { bytes: bytes.byteLength, ...stats };
}
