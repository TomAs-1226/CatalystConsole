// A small glTF 2.0 reader for CAD exports, .gltf (embedded or external buffers) and .glb alike.
//
// gltf-transform reads these files too, but it drops extensions it has no class for, and Onshape's
// PTC_onshape_metadata is the one place the export says which sub-assembly a flattened part came from.
// Reading the file directly also keeps every B-rep face as the primitive Onshape wrote, which the
// pipeline needs in order to weld faces back into a part.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const COMPONENTS = {
  5120: Int8Array,
  5121: Uint8Array,
  5122: Int16Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const WIDTH = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
/* Divisors for normalized integer accessors (glTF 2.0 §3.11). */
const NORMAL_SCALE = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };

/** Parse a .gltf or .glb file into `{ json, buffers }`, with every buffer as a Node Buffer. */
export function readGltfFile(path) {
  const bytes = readFileSync(path);
  let json;
  let glbBin = null;
  if (bytes.length >= 12 && bytes.readUInt32LE(0) === 0x46546c67) {
    /* GLB: a 12-byte header, then chunks of [length, type, data]. */
    let offset = 12;
    while (offset < bytes.length) {
      const length = bytes.readUInt32LE(offset);
      const type = bytes.readUInt32LE(offset + 4);
      const data = bytes.subarray(offset + 8, offset + 8 + length);
      if (type === 0x4e4f534a) json = JSON.parse(data.toString("utf8"));
      else if (type === 0x004e4942) glbBin = data;
      offset += 8 + length;
    }
    if (!json) throw new Error(`${path}: GLB without a JSON chunk`);
  } else {
    json = JSON.parse(bytes.toString("utf8"));
  }

  const buffers = (json.buffers || []).map((buffer, i) => {
    if (buffer.uri === undefined) {
      if (i !== 0 || !glbBin) throw new Error(`${path}: buffer ${i} has no uri and no GLB BIN chunk`);
      return glbBin;
    }
    if (buffer.uri.startsWith("data:")) {
      const comma = buffer.uri.indexOf(",");
      const header = buffer.uri.slice(0, comma);
      if (!header.endsWith(";base64")) throw new Error(`${path}: buffer ${i} is a non-base64 data URI`);
      return Buffer.from(buffer.uri.slice(comma + 1), "base64");
    }
    return readFileSync(join(dirname(path), decodeURIComponent(buffer.uri)));
  });
  return { json, buffers };
}

/**
 * An accessor's data as a typed array of `count * width` elements, copied so it owns its memory.
 * Normalized integers come back as Float32 in [−1, 1] or [0, 1]; everything else keeps its type.
 */
export function readAccessor(gltf, index) {
  const { json, buffers } = gltf;
  const accessor = json.accessors[index];
  if (accessor.sparse) throw new Error(`accessor ${index}: sparse accessors are not supported`);
  const Type = COMPONENTS[accessor.componentType];
  if (!Type) throw new Error(`accessor ${index}: component type ${accessor.componentType}`);
  const width = WIDTH[accessor.type];
  const out = new Type(accessor.count * width);
  if (accessor.bufferView === undefined) return out; // all zeros, per the spec
  const view = json.bufferViews[accessor.bufferView];
  const buffer = buffers[view.buffer];
  const elementBytes = Type.BYTES_PER_ELEMENT;
  const stride = view.byteStride || width * elementBytes;
  const base = buffer.byteOffset + (view.byteOffset || 0) + (accessor.byteOffset || 0);
  if (stride === width * elementBytes && base % elementBytes === 0) {
    out.set(new Type(buffer.buffer, base, accessor.count * width));
  } else {
    readStrided(out, buffer, base, stride, accessor, width, elementBytes);
  }
  if (accessor.normalized && NORMAL_SCALE[accessor.componentType]) {
    const scale = NORMAL_SCALE[accessor.componentType];
    const f = new Float32Array(out.length);
    for (let i = 0; i < out.length; i++) f[i] = Math.max(out[i] / scale, -1);
    return f;
  }
  return out;
}

function readStrided(out, buffer, base, stride, accessor, width, elementBytes) {
  const data = new DataView(buffer.buffer, base, stride * (accessor.count - 1) + width * elementBytes);
  const get = {
    5120: (o) => data.getInt8(o),
    5121: (o) => data.getUint8(o),
    5122: (o) => data.getInt16(o, true),
    5123: (o) => data.getUint16(o, true),
    5125: (o) => data.getUint32(o, true),
    5126: (o) => data.getFloat32(o, true),
  }[accessor.componentType];
  for (let i = 0; i < accessor.count; i++) {
    for (let k = 0; k < width; k++) out[i * width + k] = get(i * stride + k * elementBytes);
  }
}

/** A node's local transform as a column-major 4×4 array. */
export function localMatrix(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale || [1, 1, 1];
  const xx = qx * qx, yy = qy * qy, zz = qz * qz;
  const xy = qx * qy, xz = qx * qz, yz = qy * qz;
  const wx = qw * qx, wy = qw * qy, wz = qw * qz;
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/**
 * Every mesh instance in the default scene, with its world matrix and the chain of node names above
 * it (root first). Onshape wraps each part in an "occurrence of <name>" node inside its sub-assembly.
 */
export function listInstances(gltf, multiply) {
  const { json } = gltf;
  const sceneIndex = json.scene ?? 0;
  const scene = json.scenes?.[sceneIndex];
  const roots = scene ? scene.nodes : json.nodes.map((_, i) => i).filter((i) => !json.nodes.some((n) => n.children?.includes(i)));
  const out = [];
  const walk = (index, parentMatrix, chain) => {
    const node = json.nodes[index];
    const world = multiply(parentMatrix, localMatrix(node));
    const here = [...chain, index];
    if (node.mesh !== undefined) out.push({ node: index, mesh: node.mesh, world, chain: here });
    for (const child of node.children || []) walk(child, world, here);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const root of roots) walk(root, identity, []);
  return out;
}
