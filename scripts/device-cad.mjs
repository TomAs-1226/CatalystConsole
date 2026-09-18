/* Bake the devices the console draws in 3D.
 *
 *   npm run device-cad                               fetches what DEVICES lists, and reads the
 *                                                    Systemcore out of an OS image if one is found
 *   npm run device-cad -- --image path/to/x.llupdate names the Systemcore OS image to read
 *   npm run device-cad -- path/to/thing.stl          bakes one file
 *
 * A device on a robot is a real object with published CAD, and drawing the real one is both easier and
 * more honest than drawing a box with a lens on it. Limelight publishes STL; this turns each into a GLB
 * the console can load, in metres, centred, with its faces smoothed only where the part is round.
 *
 * The Systemcore has no published CAD. It does draw itself: the IMU page of its own web interface turns
 * a model of the board, and that model ships inside the OS image every team downloads to flash it. So the
 * Systemcore - and a Limelight 4 in its real finishes, which the same interface carries - is read out of
 * that file, the same bytes the board serves, and nowhere else. With no image on this machine the bake
 * says so and the console draws the Limelights alone.
 *
 * Out: src/vendor/devices/<id>.glb and src/vendor/devices.json. Baked rather than checked in, like the
 * robot's model and the driver's, so the repository carries no third-party mesh.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, readSync, closeSync, createReadStream, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createZstdDecompress } from "node:zlib";

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

/* three's FBX loader asks the DOM for an <img> for every texture a file names. The models baked here are
   drawn in their materials' colours and none of them embeds its textures, so an image that never loads
   is exactly what they need. */
globalThis.document ??= {
  createElementNS() {
    const listeners = {};
    return {
      style: {},
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      removeEventListener() {},
      set src(_) {
        setTimeout(() => (listeners.error ?? []).forEach((fn) => fn({})), 0);
      },
    };
  },
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
  {
    id: "limelight3a",
    name: "Limelight 3A",
    kind: "camera",
    match: ["limelight3a", "limelight 3a", "ll3a"],
    url: "https://downloads.limelightvision.io/cad/LIMELIGHT3ACAD_STL.stl",
    creaseDeg: 32,
  },
  {
    id: "limelight3g",
    name: "Limelight 3G",
    kind: "camera",
    match: ["limelight3g", "limelight 3g", "ll3g"],
    url: "https://downloads.limelightvision.io/cad/LIMELIGHT3GCAD_STL.stl",
    creaseDeg: 32,
  },
];

/**
 * What to read out of a Systemcore OS image. `sizeMm` is how each is recognised among the models the image
 * carries: its three extents, largest first, within 3%, in whatever unit the file was drawn in. The
 * Limelight's are its published STL's. The Systemcore's are the model's own - there is no drawing to take
 * them from - and they are what tells it apart from the Limelights beside it.
 */
const FROM_IMAGE = [
  {
    id: "systemcore",
    name: "Systemcore",
    kind: "controller",
    match: ["systemcore"],
    sizeMm: [135.5, 71.5, 28.1],
    /* Radians about the vertical the stage comes to rest at: the long side with its ports toward the
       lens. */
    rest: 0.6,
  },
  {
    id: "limelight4",
    name: "Limelight 4",
    kind: "camera",
    match: ["limelight4", "limelight 4", "ll4", "limelight"],
    sizeMm: [80.1, 48.1, 32.6],
    /* The lenses face +x in this model; this turns them to the lens, a little off square. */
    rest: -1.05,
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

/* ---- the Systemcore OS image ----
 *
 * An .llupdate is a tar holding the root filesystem as a zstd-compressed ext4 image. Rather than mount
 * ext4, the image is streamed and every binary FBX in it is found by its own header and walked to its own
 * end through its node records: a small file in ext4 is stored in one run of blocks, and a file that was
 * not fails the walk and is passed over rather than read wrong.
 */

const FBX_MAGIC = Buffer.from("Kaydara FBX Binary  \x00\x1a\x00", "latin1");
const FBX_FOOTER = Buffer.from("f85a8c6adef5d97eece90ce3758f290b", "hex");

/** The byte length of the FBX that starts at buf[at], -1 when its records do not chain, or null when
 *  more of the stream is needed to tell. */
function fbxLength(buf, at) {
  if (at + 27 > buf.length) return null;
  const version = buf.readUInt32LE(at + 23);
  const wide = version >= 7500;
  const nullRecord = wide ? 25 : 13;
  let pos = 27;
  for (;;) {
    if (at + pos + nullRecord > buf.length) return null;
    const end = wide ? Number(buf.readBigUInt64LE(at + pos)) : buf.readUInt32LE(at + pos);
    if (end === 0) {
      pos += nullRecord;
      break;
    }
    if (end <= pos || end > 16 << 20) return -1;
    pos = end;
  }
  if (at + pos + 400 > buf.length) return null;
  const footer = buf.indexOf(FBX_FOOTER, at + pos);
  return footer >= 0 && footer - (at + pos) < 400 ? footer + 16 - at : pos + 176;
}

function tarEntries(path) {
  const fd = openSync(path, "r");
  const header = Buffer.alloc(512);
  const entries = [];
  try {
    for (let at = 0; readSync(fd, header, 0, 512, at) === 512; ) {
      if (header.every((b) => b === 0)) break;
      const name = header.toString("utf8", 0, 100).replace(/\0.*$/s, "");
      const size = parseInt(header.toString("latin1", 124, 136).replace(/\0.*$/s, "").trim(), 8);
      if (!Number.isFinite(size)) break;
      entries.push({ name, size, start: at + 512 });
      at += 512 + Math.ceil(size / 512) * 512;
    }
  } finally {
    closeSync(fd);
  }
  return entries;
}

/** Every distinct binary FBX in the image's root filesystem. */
async function fbxInImage(path) {
  const rootfs = tarEntries(path).find((entry) => basename(entry.name) === "rootfs.img.zst");
  if (!rootfs) throw new Error(`${basename(path)} holds no rootfs.img.zst - is it a Systemcore OS image?`);
  const stream = createReadStream(path, { start: rootfs.start, end: rootfs.start + rootfs.size - 1 }).pipe(createZstdDecompress());
  const found = new Map();
  let buf = Buffer.alloc(0);
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let keepFrom = Math.max(0, buf.length - (FBX_MAGIC.length - 1));
    for (let from = 0; ; ) {
      const at = buf.indexOf(FBX_MAGIC, from);
      if (at < 0) break;
      const length = fbxLength(buf, at);
      if (length === null) {
        keepFrom = Math.min(keepFrom, at);
        break;
      }
      if (length > 0) {
        const bytes = Buffer.from(buf.subarray(at, at + length));
        found.set(createHash("sha1").update(bytes).digest("hex"), bytes);
      }
      from = at + 1;
    }
    buf = buf.subarray(keepFrom);
  }
  return [...found.values()];
}

/** The newest Systemcore OS image in Downloads, or null. */
function findImage() {
  const folder = join(homedir(), "Downloads");
  if (!existsSync(folder)) return null;
  const images = readdirSync(folder)
    .filter((name) => /systemcore.*\.llupdate$/i.test(name))
    .map((name) => join(folder, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return images[0] ?? null;
}

/* A modeller names a material for how it looks. The console keeps its colour and gives it the finish the
   name says, under the same ceiling the robot's CAD gets (robot3d.js), so nothing is brighter than paper. */
function finish(source) {
  const name = source.name ?? "";
  const colour = source.color ? source.color.clone() : new THREE.Color(0.5, 0.5, 0.5);
  /* A material named black that is not black took its colour from a texture that is not in the file.
     And black is drawn as the darkest grey that still shows its shape: these are black parts on a black
     stage, and a true black reads as a hole with a highlight round it. */
  if (/black/i.test(name) || colour.getHSL({}).l < 0.03) colour.setRGB(0.05, 0.05, 0.053);
  const lum = 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
  if (lum > 0.62) colour.multiplyScalar(0.62 / lum);
  let metalness = 0.05;
  let roughness = 0.5;
  if (/gunmetal|iron|steel|chrome|alumin|metal/i.test(name)) {
    metalness = 0.85;
    roughness = 0.35;
  } else if (/glossy/i.test(name)) roughness = 0.22;
  else if (/smooth/i.test(name)) roughness = 0.35;
  else if (/velvet|textured|matte|rough/i.test(name)) roughness = 0.62;
  const made = new THREE.MeshStandardMaterial({ color: colour, metalness, roughness });
  made.name = name.replace(/\.\d+$/, "");
  return made;
}

async function bakeFromImage(image) {
  const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
  log(`reading ${basename(image)}`);
  const models = await fbxInImage(image);
  log(`  ${models.length} model(s) in the image`);
  const baked = [];
  for (const bytes of models) {
    let group;
    try {
      group = new FBXLoader().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), "");
    } catch (err) {
      log(`  a model that would not parse: ${err.message}`);
      continue;
    }
    group.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(group).getSize(new THREE.Vector3());
    const extents = size.toArray().sort((a, b) => b - a);
    let device = null;
    let mmPerUnit = 0;
    for (const want of FROM_IMAGE) {
      for (const unit of [1, 10, 1000, 25.4]) {
        if (extents.every((e, i) => Math.abs(e * unit - want.sizeMm[i]) / want.sizeMm[i] < 0.03)) {
          device = want;
          mmPerUnit = unit;
        }
      }
    }
    if (!device) continue;

    /* One mesh per mesh in the file, each in metres with the file's transforms baked in, so the GLB is
       plain geometry at its real size with nothing to undo. */
    const meshes = [];
    const materials = new Map();
    const look = (source) => {
      if (!materials.has(source)) materials.set(source, finish(source));
      return materials.get(source);
    };
    group.traverse((o) => {
      if (!o.isMesh) return;
      const geometry = o.geometry.clone();
      geometry.applyMatrix4(o.matrixWorld);
      for (const name of Object.keys(geometry.attributes)) {
        if (name !== "position" && name !== "normal") geometry.deleteAttribute(name);
      }
      meshes.push(new THREE.Mesh(geometry, Array.isArray(o.material) ? o.material.map(look) : look(o.material)));
    });
    const scene = new THREE.Group();
    scene.name = device.id;
    for (const mesh of meshes) scene.add(mesh);
    const box = new THREE.Box3().setFromObject(scene);
    const scale = mmPerUnit / 1000;
    for (const mesh of meshes) {
      mesh.geometry.translate(-(box.max.x + box.min.x) / 2, -box.min.y, -(box.max.z + box.min.z) / 2);
      mesh.geometry.scale(scale, scale, scale);
    }

    const exported = await new GLTFExporter().parseAsync(scene, { binary: true });
    const out = resolve(root, "src/vendor/devices");
    mkdirSync(out, { recursive: true });
    const glb = Buffer.from(exported);
    writeFileSync(resolve(out, `${device.id}.glb`), glb);
    const mm = size.clone().multiplyScalar(mmPerUnit);
    let triangles = 0;
    for (const mesh of meshes) {
      const g = mesh.geometry;
      triangles += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
    }
    log(`  ${device.id}: ${Math.round(triangles)} triangles, ${mm.x.toFixed(0)} x ${mm.y.toFixed(0)} x ${mm.z.toFixed(0)} mm, ${materials.size} finishes, ${(glb.length / 1024).toFixed(0)} KB`);
    baked.push({
      id: device.id,
      name: device.name,
      kind: device.kind,
      match: device.match,
      file: `devices/${device.id}.glb`,
      finish: "cad",
      source: "systemcore-image",
      rest: device.rest,
      sizeMm: [mm.x, mm.y, mm.z].map((v) => Math.round(v * 10) / 10),
      triangles: Math.round(triangles),
      bytes: glb.length,
    });
  }
  return baked;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--image");
  const image = flag >= 0 ? args[flag + 1] : findImage();
  const given = args.filter((_, i) => flag < 0 || (i !== flag && i !== flag + 1));
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

  /* The image's models replace the STL of the same device: the same part, in its real finishes. */
  if (image && !given.length) {
    try {
      for (const entry of await bakeFromImage(image)) {
        const at = baked.findIndex((b) => b.id === entry.id);
        if (at >= 0) baked[at] = entry;
        else baked.push(entry);
      }
    } catch (err) {
      log(`  ${basename(image)}: ${err.message} - skipped`);
    }
  } else if (!given.length) {
    log("no Systemcore OS image found in Downloads - pass --image <file.llupdate> to draw the Systemcore");
  }

  if (!baked.length) throw new Error("nothing was baked");
  writeFileSync(resolve(root, "src/vendor/devices.json"), `${JSON.stringify({
    version: 1,
    generatedAt: new Date().toISOString(),
    devices: baked,
    how: "Limelight's published STL, welded, smoothed at a crease angle, millimetres to metres, centred on its own footprint; the Systemcore, and a Limelight 4 in its finishes, read out of the Systemcore OS image the board's own web interface draws them from. Made at build time and gitignored: nothing third-party is checked in.",
  }, null, 1)}\n`);
  log(`wrote src/vendor/devices.json: ${baked.length} device(s)`);
}

await main();
