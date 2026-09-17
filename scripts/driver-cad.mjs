/* Bake the driver figure the console draws in Settings.
 *
 *   npm run driver-cad -- "path/to/Rigged Humanoid.fbx"
 *
 * The source is a rigged humanoid FBX with a named skeleton (Hips, Spine1..3, Neck, Head, and
 * Left/Right Shoulder, Arm, Forearm, Hand, Hip, Leg, Knee, Foot) and one single-frame clip - a Blender
 * pose library - holding the arms-folded stance the figure stands in. There is no walk in it, so the
 * walk-on is animated by the console (see driver3d.js); what this script has to produce is the mesh,
 * the skeleton, and that one pose, in a form the console can load without shipping an FBX reader.
 *
 * Out: src/vendor/driver.glb and src/vendor/driver.json. Both are baked rather than checked in, like the
 * robot's model, so the repository carries no third-party mesh.
 *
 * Node has no DOM, and three's exporter reaches for a few browser globals when it writes buffers, so the
 * handful it needs are supplied here rather than pulling in a DOM shim for six methods.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* three's glTF exporter puts its binary chunk together as a Blob and reads it back through a FileReader.
   Node has the Blob and not the reader, and a DOM shim for one method is a dependency nobody should have
   to install to build this. The blob already knows how to hand over its own bytes. */
globalThis.FileReader ??= class {
  readAsArrayBuffer(blob) {
    blob.arrayBuffer().then(
      (buffer) => {
        this.result = buffer;
        this.onloadend?.({ target: this });
      },
      (error) => {
        this.error = error;
        this.onerror?.({ target: this });
      },
    );
  }
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SOURCE = resolve(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads", "Rigged Humanoid.fbx");

/* The figure is drawn at a person's height whatever the source was modelled at. */
const HEIGHT_M = 1.76;

/* Bones the console poses. Everything else in the rig - the IK handles, the pole targets, the switchers
   a Blender rig carries - is left alone: it is skinned to, so it cannot be deleted, but nothing here
   needs to know about it. */
const POSED = {
  hips: "Hips",
  spine: ["Spine1", "Spine2", "Spine3"],
  neck: ["Neck", "Neck001"],
  head: "Head",
  left: { shoulder: "Left_Arm", elbow: "Left_Forearm", hand: "Left_Hand", hip: "Left_Leg", knee: "Left_Knee", foot: "Left_Foot" },
  right: { shoulder: "Right_Arm", elbow: "Right_Forearm", hand: "Right_Hand", hip: "Right_Leg", knee: "Right_Knee", foot: "Right_Foot" },
};

function log(line) {
  process.stdout.write(`${line}\n`);
}

/** The rotation each bone has in `clip` at its first key, as [x, y, z, w] by bone name. */
function poseFromClip(clip) {
  const pose = {};
  for (const track of clip.tracks) {
    const [name, property] = track.name.split(".");
    if (property !== "quaternion") continue;
    const v = track.values;
    if (v.length < 4) continue;
    pose[name] = [round(v[0]), round(v[1]), round(v[2]), round(v[3])];
  }
  return pose;
}

const round = (v) => Math.round(v * 1e5) / 1e5;

async function main() {
  const source = process.argv[2] || DEFAULT_SOURCE;
  log(`reading ${source}`);
  const file = readFileSync(source);
  const group = new FBXLoader().parse(file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength), "");

  /* ---- what came in ---- */
  let triangles = 0;
  let skinned = null;
  const bones = [];
  group.traverse((o) => {
    if (o.isSkinnedMesh && !skinned) skinned = o;
    if (o.isMesh) {
      const g = o.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    }
    if (o.isBone) bones.push(o.name);
  });
  if (!skinned) throw new Error("no skinned mesh in the FBX");
  log(`  ${Math.round(triangles)} triangles, ${bones.length} bones, ${group.animations.length} clip(s)`);

  const missing = [POSED.hips, POSED.head, ...POSED.spine, ...POSED.neck,
    ...Object.values(POSED.left), ...Object.values(POSED.right)].filter((n) => !bones.includes(n));
  if (missing.length) throw new Error(`the rig is missing bones the console poses: ${missing.join(", ")}`);

  /* ---- the stance ---- */
  const poseClip = group.animations.find((a) => /pose/i.test(a.name)) ?? group.animations[0] ?? null;
  const stance = poseClip ? poseFromClip(poseClip) : {};
  log(`  stance from "${poseClip?.name ?? "(none)"}": ${Object.keys(stance).length} bones`);

  /* ---- put it in the console's frame ---- */
  /* The console's frame is x forward, y up, z to the figure's right, at a person's height, standing on
     the floor at the origin. FBX arrives in centimetres and three's loader has already stood it Y-up;
     which way it faces is whatever the modeller had in Blender, and is read off the model rather than
     guessed: a foot points forward, so the toe bone is ahead of the ankle bone. */
  const wrapper = new THREE.Group();
  wrapper.name = "driver";
  const facing = new THREE.Group();
  facing.name = "driver-facing";
  facing.add(group);
  wrapper.add(facing);
  wrapper.updateMatrixWorld(true);

  const boneNamed = (name) => {
    let found = null;
    group.traverse((o) => {
      if (!found && o.isBone && o.name === name) found = o;
    });
    return found;
  };
  const ankle = boneNamed(POSED.left.foot);
  const toe = boneNamed("Left_Foot001") ?? boneNamed("Left_Toe");
  let yaw = 0;
  if (ankle && toe) {
    const ahead = toe.getWorldPosition(new THREE.Vector3()).sub(ankle.getWorldPosition(new THREE.Vector3()));
    ahead.y = 0;
    if (ahead.lengthSq() > 1e-9) yaw = Math.atan2(ahead.z, ahead.normalize().x);
  }
  facing.rotation.y = -yaw;
  wrapper.updateMatrixWorld(true);
  log(`  faces ${((yaw * 180) / Math.PI).toFixed(1)} deg from +x; turned to face it`);

  const box = new THREE.Box3().setFromObject(wrapper);
  const size = box.getSize(new THREE.Vector3());
  const scale = HEIGHT_M / size.y;
  wrapper.scale.setScalar(scale);
  wrapper.updateMatrixWorld(true);
  const scaled = new THREE.Box3().setFromObject(wrapper);
  wrapper.position.set(
    -(scaled.max.x + scaled.min.x) / 2,
    -scaled.min.y,
    -(scaled.max.z + scaled.min.z) / 2,
  );
  wrapper.updateMatrixWorld(true);
  log(`  scaled x${scale.toFixed(4)} to ${HEIGHT_M} m`);

  /* ---- make it small ---- */
  /* An FBX arrives with a vertex per corner of every triangle and a texture coordinate on each, and a
     glTF written straight back out of that is most of a megabyte for a figure with three thousand
     triangles in it. Welding the corners back together and dropping the attributes nothing reads -
     there is no texture on this model - is the difference between a download and a stutter. */
  let before = 0;
  let after = 0;
  group.traverse((o) => {
    if (!o.isMesh) return;
    let g = o.geometry;
    before += g.getAttribute("position").count;
    for (const name of ["uv", "uv1", "uv2", "uv3", "color", "tangent"]) {
      if (g.getAttribute(name)) g.deleteAttribute(name);
    }
    if (!g.index) {
      g = mergeVertices(g, 1e-4);
      o.geometry = g;
    }
    after += g.getAttribute("position").count;
  });
  log(`  ${before} vertices welded to ${after}`);

  /* One material, so the console can colour the figure by setting one colour. Phong out of an FBX is
     replaced by the console at load; what matters here is that there is exactly one. */
  const materials = new Set();
  group.traverse((o) => {
    if (o.isMesh) for (const m of [o.material].flat()) if (m) materials.add(m);
  });
  log(`  ${materials.size} material(s): ${[...materials].map((m) => m.name || "(unnamed)").join(", ")}`);

  /* ---- write ---- */
  const exported = await new GLTFExporter().parseAsync(wrapper, { binary: true, animations: [], onlyVisible: false });
  const out = resolve(root, "src/vendor");
  mkdirSync(out, { recursive: true });
  const glb = Buffer.from(exported);
  writeFileSync(resolve(out, "driver.glb"), glb);

  const manifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    source: source.split(/[\\/]/).pop(),
    model: { file: "driver.glb", bytes: glb.length, triangles: Math.round(triangles), heightM: HEIGHT_M },
    bones: POSED,
    /* Bone rotations for the stance the model was posed in, as [x, y, z, w]. The console blends into
       these at the end of the walk-on rather than inventing a fold of its own. */
    stance,
    how: "FBX read with three's FBXLoader, scaled to 1.76 m and stood on the floor, written as a GLB. The stance is the first key of the FBX's own pose-library clip.",
  };
  writeFileSync(resolve(out, "driver.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  log(`wrote src/vendor/driver.glb: ${(glb.length / 1024).toFixed(0)} KB, and driver.json`);
}

await main();
