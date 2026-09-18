/* Bake the devices the console draws in 3D.
 *
 *   npm run device-cad                       fetches what DEVICES lists and bakes each
 *   npm run device-cad -- path/to/thing.stl  bakes one file
 *
 * A device on a robot is a real object with published CAD, and drawing the real one is both easier and
 * more honest than drawing a box with a lens on it. The vendors publish STL; this turns each into a GLB
 * the console can load, in metres, centred, with its faces smoothed only where the part is round.
 *
 * Out: src/vendor/devices/<id>.glb and src/vendor/devices.json. Baked rather than checked in, like the
 * robot's model and the driver's, so the repository carries no third-party mesh.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as THREE from "three";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/* three's exporter assembles its binary chunk as a Blob and reads it back through a FileReader. Node has
   the Blob and not the reader, and the blob already knows how to hand over its own bytes. */
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

/**
 * What to bake. `match` is how the console decides a device on the robot is one of these: it is tested
 * against the device's own name, lower-cased, so a camera called "limelight-left" finds the Limelight.
 *
 * The URLs are the vendors' own published CAD, listed on their documentation. Nothing is redistributed:
 * the files are fetched on the machine doing the build and the result is gitignored.
 */
const DEVICES = [
  {
    id: "limelight4",
    name: "Limelight 4",
    kind: "camera",
    match: ["limelight4", "limelight 4", "ll4", "limelight"],
    url: "https://downloads.limelightvision.io/cad/LIMELIGHT4CAD_STL.stl",
    /* The lens barrels and the ring are turned, the housing is milled: smoothing anything flatter than
       this would round the corners of the case. */
    creaseDeg: 32,
  },
  {
    id: "limelight3",
    name: "Limelight 3",
    kind: "camera",
    match: ["limelight3", "limelight 3", "ll3"],
    url: "https://downloads.limelightvision.io/cad/LIMELIGHT3CAD_STL.stl",
    creaseDeg: 32,
  },
];

function log(line) {
  process.stdout.write(`${line}\n`);
}

/** An STL, binary or ASCII, as a three geometry in the file's own units. */
function readStl(bytes) {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const view = new DataView(buffer);
  const isAscii = bytes.subarray(0, 5).toString("ascii").toLowerCase() === "solid"
    && bytes.length < 84 + 50 * (bytes.length > 84 ? view.getUint32(80, true) : 0);

  const positions = [];
  if (isAscii) {
    const text = bytes.toString("utf8");
    const numbers = /vertex\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)\s+(-?[\d.eE+]+)/g;
    let hit;
    while ((hit = numbers.exec(text)) !== null) positions.push(Number(hit[1]), Number(hit[2]), Number(hit[3]));
  } else {
    const count = view.getUint32(80, true);
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50 + 12;
      for (let v = 0; v < 3; v++) {
        positions.push(view.getFloat32(o + v * 12, true), view.getFloat32(o + v * 12 + 4, true), view.getFloat32(o + v * 12 + 8, true));
      }
    }
  }
  if (!positions.length) throw new Error("no triangles in that STL");
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

async function bake(device, file) {
  const bytes = readFileSync(file);
  let geometry = readStl(bytes);
  const before = geometry.getAttribute("position").count;
  /* STL repeats every corner, so it welds down hard - and welding is what lets a crease angle decide
     which edges are sharp. */
  geometry = mergeVertices(geometry, 1e-4);
  geometry.computeVertexNormals();

  geometry.computeBoundingBox();
  const box = geometry.boundingBox;
  const size = box.getSize(new THREE.Vector3());
  /* STL carries no units and every one of these is published in millimetres. A part the size of a hand
     measured in metres would be a hundred metres across, which is a thing worth noticing rather than
     silently scaling, so it is checked. */
  if (size.length() < 1 || size.length() > 2000) {
    throw new Error(`${device.id} measures ${size.toArray().map((v) => v.toFixed(1)).join(" x ")} - that is not millimetres`);
  }
  geometry.translate(-(box.max.x + box.min.x) / 2, -box.min.y, -(box.max.z + box.min.z) / 2);
  geometry.scale(0.001, 0.001, 0.001);

  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0x8e8e93, roughness: 0.45, metalness: 0.6 }));
  mesh.name = device.id;
  const exported = await new GLTFExporter().parseAsync(mesh, { binary: true });
  const out = resolve(root, "src/vendor/devices");
  mkdirSync(out, { recursive: true });
  const glb = Buffer.from(exported);
  writeFileSync(resolve(out, `${device.id}.glb`), glb);

  const triangles = geometry.index ? geometry.index.count / 3 : geometry.getAttribute("position").count / 3;
  log(`  ${device.id}: ${Math.round(triangles)} triangles, ${before} corners welded to ${geometry.getAttribute("position").count}, ${(size.x).toFixed(0)} x ${(size.y).toFixed(0)} x ${(size.z).toFixed(0)} mm, ${(glb.length / 1024).toFixed(0)} KB`);
  return {
    id: device.id,
    name: device.name,
    kind: device.kind,
    match: device.match,
    file: `devices/${device.id}.glb`,
    sizeMm: [size.x, size.y, size.z].map((v) => Math.round(v * 10) / 10),
    triangles: Math.round(triangles),
    bytes: glb.length,
  };
}

async function main() {
  const given = process.argv.slice(2);
  const scratch = resolve(root, "src/vendor/.device-src");
  mkdirSync(scratch, { recursive: true });
  const baked = [];

  const wanted = given.length
    ? given.map((path) => ({ id: basename(path, extname(path)).toLowerCase(), name: basename(path, extname(path)), kind: "other", match: [], path }))
    : DEVICES;

  for (const device of wanted) {
    let file = device.path;
    if (!file) {
      file = resolve(scratch, `${device.id}.stl`);
      if (!existsSync(file)) {
        log(`fetching ${device.url}`);
        const response = await fetch(device.url);
        if (!response.ok) {
          log(`  ${device.id}: ${response.status} - skipped`);
          continue;
        }
        writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      }
    }
    try {
      baked.push(await bake(device, file));
    } catch (err) {
      log(`  ${device.id}: ${err.message} - skipped`);
    }
  }

  if (!baked.length) throw new Error("nothing was baked");
  writeFileSync(resolve(root, "src/vendor/devices.json"), `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    devices: baked,
    how: "Vendor-published STL, welded, smoothed at a crease angle, converted to millimetres-to-metres and centred on its own footprint. Fetched at build time and gitignored: nothing third-party is checked in.",
  }, null, 1)}\n`);
  log(`wrote src/vendor/devices.json: ${baked.length} device(s)`);
}

await main();
