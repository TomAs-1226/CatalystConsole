// Turn the field CAD into collision geometry.
//
// Hand-placed obstacle boxes never match the real field. Someone measures the hub, forgets the trench,
// approximates the ramp as a wall, and the simulation quietly disagrees with the thing it is meant to
// represent. This reads the actual model and derives collision from it.
//
// The output is a heightmap: the field on a fixed grid, each cell holding the highest surface at that
// point. That representation is chosen because it is the one that gets ramps right. Occupancy grids
// can only say "solid" or "not", so a ramp becomes either a wall you cannot climb or a hole you drive
// through. With height:
//
//   * flat carpet          -> height ~0, drivable
//   * a ramp               -> a gradient, drivable if the slope is gentle enough to climb
//   * a trench floor       -> height below carpet, drivable, with steep walls either side
//   * structure            -> height above what a robot can climb, blocked
//
// so all three fall out of one number per cell and one slope test, rather than three special cases.
//
//   npm run field-collision                              # uses src/vendor/field.glb
//   npm run field-collision -- path/to.glb
//   npm run field-collision -- --also path/to/deploy     # extra destination, repeatable
//
// Writes src/vendor/field-collision.json AND every other place that reads it — by default the
// sibling FrcCatalyst example's deploy directory, which is what the Java simulation and the cockpit
// actually load. Neither of them can see src/vendor at all.
//
// This script used to write one file, and someone hand-copied it to the deploy directory once. That
// copy then rotted: hours stale and a full metre out in y, so every fix made here was invisible to
// the only thing consuming it. All destinations are now written on every run and logged with their
// size. The silent single write is what let the drift go unnoticed, so the logging is part of the fix.

import { NodeIO } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRMeshQuantization } from "@gltf-transform/extensions";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The name every destination gets, whether it was given as a directory or as an explicit file. */
const OUT_NAME = "field-collision.json";

/* Anchored to the repo root, not the cwd: this has to land in the same place whether the script is
   run from the repo, from a parent directory, or by an editor's task runner.

   The version is pinned rather than globbed deliberately. When it bumps, the run warns that the
   directory has gone, which is a loud prompt to change one line here. A FrcCatalyst-v* glob would
   instead pick whichever old checkout still matched and keep writing to it quietly — the same
   silent-drift failure this whole mechanism exists to prevent. */
const SIBLING_DEPLOY = join(root, "..", "FrcCatalyst-v1.1.0", "example", "src", "main", "deploy");

/* A path ending in .json names the file to write; anything else is a directory to drop OUT_NAME in.
   Relative --also paths resolve against the cwd because that is where the person typed them. */
function destinationFile(p) {
  const abs = resolve(p);
  return abs.toLowerCase().endsWith(".json") ? abs : join(abs, OUT_NAME);
}

let sourceArg = null;
const also = [];
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === "--also" || arg.startsWith("--also=")) {
    const value = arg.startsWith("--also=") ? arg.slice("--also=".length) : process.argv[++i];
    if (!value) {
      console.error("--also needs a path: a directory, or a .json file to write");
      process.exit(1);
    }
    also.push(value);
  } else if (arg.startsWith("-")) {
    console.error(`Unknown option ${arg}`);
    process.exit(1);
  } else if (sourceArg === null) {
    sourceArg = arg;
  } else {
    console.error(`Unexpected extra argument ${arg}`);
    process.exit(1);
  }
}

const source = sourceArg || join(root, "src", "vendor", "field.glb");

/* src/vendor first — the one destination that always exists — then the sibling deploy, then whatever
   was asked for on the command line. */
const destinations = [join(root, "src", "vendor", OUT_NAME)];
if (existsSync(SIBLING_DEPLOY)) {
  destinations.push(join(SIBLING_DEPLOY, OUT_NAME));
} else {
  /* Warn rather than fail. A console-only checkout is a legitimate way to work, and refusing to
     produce the file at all would be a worse outcome than producing it in one place and saying so. */
  console.warn(
    `WARNING: no deploy directory at ${SIBLING_DEPLOY}, so nothing was written for the Java ` +
      `simulation or the cockpit — they will keep reading whatever stale copy they already have. ` +
      `If that checkout moved or changed version, update SIBLING_DEPLOY or pass --also <path>.`
  );
}
for (const p of also) destinations.push(destinationFile(p));

/* Deduplicated so a --also naming a destination already on the list is not written twice, and does
   not appear twice in the log. Compared case-insensitively on Windows, where one file has many
   spellings. */
const seenDest = new Set();
const outPaths = destinations.filter((p) => {
  const key = process.platform === "win32" ? p.toLowerCase() : p;
  if (seenDest.has(key)) return false;
  seenDest.add(key);
  return true;
});

/** Grid resolution in metres. 5 cm is finer than a bumper corner and keeps the file small. */
const CELL = 0.05;

if (!existsSync(source)) {
  console.error(`No field model at ${source}`);
  console.error("Run `npm run field-cad` first.");
  process.exit(1);
}

const io = new NodeIO().registerExtensions([EXTMeshGPUInstancing, KHRMeshQuantization]);
const doc = await io.read(source);

// ---------------------------------------------------------------- gather triangles

/** Walk the scene graph accumulating world transforms, and emit every triangle in world space. */
function worldTriangles(document) {
  const out = [];
  let instancedMeshes = 0;
  let placements = 0;

  const emit = (mesh, matrix) => {
    for (const prim of mesh.listPrimitives()) {
      const position = prim.getAttribute("POSITION");
      if (!position) continue;
      const indices = prim.getIndices();
      const count = indices ? indices.getCount() : position.getCount();
      const p = [0, 0, 0];
      const tri = [];
      for (let i = 0; i < count; i++) {
        const index = indices ? indices.getScalar(i) : i;
        position.getElement(index, p);
        tri.push(apply(matrix, p));
        if (tri.length === 3) {
          out.push([tri[0], tri[1], tri[2]]);
          tri.length = 0;
        }
      }
    }
  };

  const visit = (node, parent) => {
    const local = node.getWorldMatrix ? node.getWorldMatrix() : null;
    const matrix = local ?? multiply(parent, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh) {
      /* Almost every field element is placed by EXT_mesh_gpu_instancing rather than by a node of its
         own, so a walker that reads node transforms only ever draws one copy of each part, sitting on
         the base transform. Registering the extension is not reading it: 1727 placements collapsed
         onto 107 meshes piled at the model origin, which is where the phantom solid block at midfield
         came from and why the map came out 85% bare carpet. */
      const batch = node.getExtension("EXT_mesh_gpu_instancing");
      const count = batch ? instanceCount(batch) : 0;
      if (count > 0) {
        instancedMeshes++;
        placements += count;
        for (let i = 0; i < count; i++) emit(mesh, multiply(matrix, instanceMatrix(batch, i)));
      } else {
        emit(mesh, matrix);
      }
    }
    for (const child of node.listChildren()) visit(child, matrix);
  };

  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, identity());
  }
  console.log(`instancing: ${placements} placements across ${instancedMeshes} instanced meshes`);
  return out;
}

/** Instances per batch. Any one of the three attributes fixes the count; the others may be absent. */
function instanceCount(batch) {
  for (const semantic of ["TRANSLATION", "ROTATION", "SCALE"]) {
    const accessor = batch.getAttribute(semantic);
    if (accessor) return accessor.getCount();
  }
  return 0;
}

const instanceT = [0, 0, 0];
const instanceR = [0, 0, 0, 1];
const instanceS = [1, 1, 1];

/** One instance's TRS as a column-major matrix, in the instanced node's own local space. */
function instanceMatrix(batch, index) {
  const translation = batch.getAttribute("TRANSLATION");
  const rotation = batch.getAttribute("ROTATION");
  const scale = batch.getAttribute("SCALE");

  // Any of the three may be absent, in which case that instance takes the identity for it.
  if (translation) translation.getElement(index, instanceT);
  else instanceT.fill(0);
  if (rotation) rotation.getElement(index, instanceR);
  else instanceR.splice(0, 4, 0, 0, 0, 1);
  if (scale) scale.getElement(index, instanceS);
  else instanceS.fill(1);

  /* glTF stores quaternions as (x, y, z, w) — w last, unlike most maths texts. Normalise before
     converting: a quantised ROTATION accessor comes back a hair off unit length, and an
     unnormalised quaternion turns into a matrix that quietly scales the part it rotates. */
  let [x, y, z, w] = instanceR;
  const len = Math.hypot(x, y, z, w);
  if (len > 0) {
    x /= len;
    y /= len;
    z /= len;
    w /= len;
  }

  const [sx, sy, sz] = instanceS;
  const xx = x * x, yy = y * y, zz = z * z;
  const xy = x * y, xz = x * z, yz = y * z;
  const wx = w * x, wy = w * y, wz = w * z;

  // Column-major, to match multiply() and apply(): each basis vector is scaled as a whole column.
  return [
    (1 - 2 * (yy + zz)) * sx, 2 * (xy + wz) * sx, 2 * (xz - wy) * sx, 0,
    2 * (xy - wz) * sy, (1 - 2 * (xx + zz)) * sy, 2 * (yz + wx) * sy, 0,
    2 * (xz + wy) * sz, 2 * (yz - wx) * sz, (1 - 2 * (xx + yy)) * sz, 0,
    instanceT[0], instanceT[1], instanceT[2], 1,
  ];
}

const identity = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let rw = 0; rw < 4; rw++)
      for (let k = 0; k < 4; k++) r[c * 4 + rw] += a[k * 4 + rw] * b[c * 4 + k];
  return r;
}

function apply(m, v) {
  return [
    m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
    m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
    m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
  ];
}

const triangles = worldTriangles(doc);
if (!triangles.length) {
  console.error("No triangles found in the model.");
  process.exit(1);
}

// ---------------------------------------------------------------- orient and bound

/* SolidWorks exports Z-up. Detect it rather than assume: the vertical axis is the one with the
   smallest extent, because a field is much wider than it is tall. */
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (const tri of triangles)
  for (const v of tri)
    for (let i = 0; i < 3; i++) {
      if (v[i] < min[i]) min[i] = v[i];
      if (v[i] > max[i]) max[i] = v[i];
    }

const extent = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
const up = extent.indexOf(Math.min(...extent));
const planar = [0, 1, 2].filter((i) => i !== up);
// Longer planar axis is the field length.
const [ax, ay] = extent[planar[0]] >= extent[planar[1]] ? planar : [planar[1], planar[0]];

const length = extent[ax];
const width = extent[ay];
console.log(
  `model: ${triangles.length} triangles, ${length.toFixed(2)} x ${width.toFixed(2)} m, ` +
    `${extent[up].toFixed(2)} m tall (up axis ${"xyz"[up]})`
);

const cols = Math.ceil(length / CELL);
const rows = Math.ceil(width / CELL);

// ---------------------------------------------------------------- rasterize

/* Highest surface per cell, by proper scan conversion.
 *
 * Sampling vertices and centroids is not enough, and the way it fails is instructive: the carpet is a
 * handful of triangles twenty metres across, so point sampling stamps about seven cells out of a
 * hundred thousand and declares the entire field empty. Every triangle has to be filled.
 *
 * Edges are rasterized separately as well. A vertical face — which is to say every wall — projects
 * from above to a line with no area, so the barycentric fill covers none of it. The walls are exactly
 * what collision cares most about, so they get drawn explicitly. */
const height = new Float32Array(cols * rows).fill(-Infinity);

/* Clearance: the underside of the lowest thing overhead.
 *
 * A max-height map on its own cannot describe a trench, and gets it exactly backwards. An FRC trench
 * is not dug into the floor — the floor is carpet and there is a bar above it you have to fit under.
 * A map that only records the highest surface sees that bar, calls the cell solid, and refuses to let
 * anything through, when in reality a short robot drives straight down it.
 *
 * So a second layer records the lowest geometry standing clear of the carpet. Together the two answer
 * the question properly: a cell is passable if the floor under it is climbable *and* the robot fits
 * beneath whatever is over it. */
const ceiling = new Float32Array(cols * rows).fill(Infinity);

/* The threshold has to be relative to the carpet, so the carpet is found first — from the histogram
   of vertex heights, which is the same modal-height argument used below and cheap enough to do twice.
   The alternative is rasterizing everything a second time once the datum is known. */
const VERTEX_BIN = 0.005;
const vertexHistogram = new Map();
for (const tri of triangles) {
  for (const v of tri) {
    const bin = Math.round((v[up] - min[up]) / VERTEX_BIN);
    vertexHistogram.set(bin, (vertexHistogram.get(bin) || 0) + 1);
  }
}
let carpetBin = 0;
let carpetVotes = -1;
for (const [bin, count] of vertexHistogram) {
  if (count > carpetVotes) { carpetVotes = count; carpetBin = bin; }
}
const carpetHeight = carpetBin * VERTEX_BIN;
/** Geometry within this of the carpet is the floor, not something to duck under. */
const FLOOR_BAND = 0.06;

function stamp(cx, cy, h) {
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
  const at = cy * cols + cx;
  if (h > height[at]) height[at] = h;
  if (h > carpetHeight + FLOOR_BAND && h < ceiling[at]) ceiling[at] = h;
}

/** Cell coordinates and height of a world-space vertex. */
function project(v) {
  return [(v[ax] - min[ax]) / CELL, (v[ay] - min[ay]) / CELL, v[up] - min[up]];
}

function rasterEdge(a, b) {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    stamp(
      Math.floor(a[0] + (b[0] - a[0]) * t),
      Math.floor(a[1] + (b[1] - a[1]) * t),
      a[2] + (b[2] - a[2]) * t
    );
  }
}

for (const tri of triangles) {
  const p0 = project(tri[0]);
  const p1 = project(tri[1]);
  const p2 = project(tri[2]);

  rasterEdge(p0, p1);
  rasterEdge(p1, p2);
  rasterEdge(p2, p0);

  const area = (p1[0] - p0[0]) * (p2[1] - p0[1]) - (p2[0] - p0[0]) * (p1[1] - p0[1]);
  if (Math.abs(area) < 1e-9) continue;   // edge-on: the edges above already covered it

  const loX = Math.max(0, Math.floor(Math.min(p0[0], p1[0], p2[0])));
  const hiX = Math.min(cols - 1, Math.ceil(Math.max(p0[0], p1[0], p2[0])));
  const loY = Math.max(0, Math.floor(Math.min(p0[1], p1[1], p2[1])));
  const hiY = Math.min(rows - 1, Math.ceil(Math.max(p0[1], p1[1], p2[1])));

  for (let cy = loY; cy <= hiY; cy++) {
    for (let cx = loX; cx <= hiX; cx++) {
      const px = cx + 0.5;
      const py = cy + 0.5;
      // Barycentric coordinates; inside when all three are non-negative.
      const w0 = ((p1[0] - px) * (p2[1] - py) - (p2[0] - px) * (p1[1] - py)) / area;
      const w1 = ((p2[0] - px) * (p0[1] - py) - (p0[0] - px) * (p2[1] - py)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      stamp(cx, cy, w0 * p0[2] + w1 * p1[2] + w2 * p2[2]);
    }
  }
}

/* ---------------------------------------------------------------- find the carpet
 *
 * Heights so far are measured from the lowest point anywhere in the model, which need not be the
 * carpet. Rather than hard-coding an offset, find it: the single most common height across the model
 * is the carpet, because the carpet is by far the largest flat thing in it. Everything is then
 * measured from there.
 *
 * This datum used to come out a metre above the model floor, which looked like structure modelled
 * below the floor line and was in fact the instancing bug — every instanced part drawn at its
 * untransformed origin, a metre under the carpet. Finding the datum rather than assuming it is what
 * kept the map usable at all while that was true, so it stays. */
const BIN = 0.005;
const histogram = new Map();
for (const h of height) {
  if (h === -Infinity) continue;
  const bin = Math.round(h / BIN);
  histogram.set(bin, (histogram.get(bin) || 0) + 1);
}
let datumBin = 0;
let best = -1;
for (const [bin, count] of histogram) {
  if (count > best) { best = count; datumBin = bin; }
}
const datum = datumBin * BIN;

/* Bound the field by its walls, not by its floor. The venue floor outside the perimeter is at exactly
   the same height as the carpet — physically true, and useless for finding the playing surface, which
   is why cropping to the carpet datum returns the whole room. */
/** Above this, relative to the carpet, a cell is a wall rather than something to drive over. */
const WALL_HEIGHT = 0.25;
const FIELD_LENGTH = Number(process.env.FIELD_LENGTH || 16.54);
const FIELD_WIDTH = Number(process.env.FIELD_WIDTH || 8.07);

/** True where a cell is too tall to drive onto. Cells no triangle touched count as floor. */
const isWall = (at) => {
  const h = height[at];
  return h !== -Infinity && h - datum >= WALL_HEIGHT;
};

/* The obvious next step — bounding-box every cell above WALL_HEIGHT and centre on that — is what put
   the map 1.005 m off across the field width. Driver station structure stands outside the carpet, it
   is well over the threshold, and there is more of it on one side than the other, so it drags the
   box and with it the centre: 1.0 m of real field was cropped away on one side and 0.8 m of void
   padded onto the other. Nothing outside the field is symmetric, so nothing outside the field can be
   allowed a vote.

   Flood filling cannot be dragged that way. The perimeter wall is a closed ring of structure, so the
   cells reachable from midfield without stepping over it are exactly the drivable interior, whatever
   happens to be parked outside. */
function seedCell() {
  const cx0 = Math.floor(cols / 2);
  const cy0 = Math.floor(rows / 2);
  if (!isWall(cy0 * cols + cx0)) return cy0 * cols + cx0;
  // Dead centre is not always carpet — a hub or a truss can sit on it — so walk outwards for floor.
  for (let r = 1; r < Math.max(cols, rows); r++) {
    for (let d = -r; d <= r; d++) {
      for (const [cx, cy] of [
        [cx0 + d, cy0 - r], [cx0 + d, cy0 + r], [cx0 - r, cy0 + d], [cx0 + r, cy0 + d],
      ]) {
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
        if (!isWall(cy * cols + cx)) return cy * cols + cx;
      }
    }
  }
  return -1;
}

function floodInterior(seed) {
  const seen = new Uint8Array(cols * rows);
  const stack = new Int32Array(cols * rows);
  let top = 0;
  stack[top++] = seed;
  seen[seed] = 1;
  let loX = cols, hiX = -1, loY = rows, hiY = -1, area = 0;
  while (top > 0) {
    const at = stack[--top];
    const cx = at % cols;
    const cy = (at - cx) / cols;
    area++;
    if (cx < loX) loX = cx;
    if (cx > hiX) hiX = cx;
    if (cy < loY) loY = cy;
    if (cy > hiY) hiY = cy;
    // Four-connected on purpose: a diagonal step squeezes through the corner where two walls meet,
    // and one such leak drains the fill into the whole venue.
    for (const next of [
      cx > 0 ? at - 1 : -1,
      cx < cols - 1 ? at + 1 : -1,
      cy > 0 ? at - cols : -1,
      cy < rows - 1 ? at + cols : -1,
    ]) {
      if (next < 0 || seen[next] || isWall(next)) continue;
      seen[next] = 1;
      stack[top++] = next;
    }
  }
  return { loX, hiX, loY, hiY, area };
}

const targetCols = Math.max(1, Math.round(FIELD_LENGTH / CELL));
const targetRows = Math.max(1, Math.round(FIELD_WIDTH / CELL));

const seed = seedCell();
const interior = seed >= 0 ? floodInterior(seed) : null;
const floodCols = interior ? interior.hiX - interior.loX + 1 : 0;
const floodRows = interior ? interior.hiY - interior.loY + 1 : 0;

/* Two ways the fill can lie. Too small means the seed landed in a closed pocket — under the hub, in
   a chute — rather than on the carpet. Too large means the wall ring has a gap and the fill escaped
   into the venue, at which point its box is the model's box and tells us nothing. */
let failure = null;
if (!interior) failure = "no drivable cell to seed from";
else if (interior.area < (targetCols * targetRows) / 2)
  failure = `only ${interior.area} cells filled, under half the ${targetCols * targetRows} expected`;
else if (floodCols > targetCols * 1.25 || floodRows > targetRows * 1.25)
  failure = `filled ${(floodCols * CELL).toFixed(2)} x ${(floodRows * CELL).toFixed(2)} m, larger ` +
    `than the field — the wall ring probably has a gap and the fill leaked outside`;

let centreX;
let centreY;
if (!failure) {
  centreX = (interior.loX + interior.hiX) / 2;
  centreY = (interior.loY + interior.hiY) / 2;
  console.log(
    `interior flood fill: ${interior.area} cells, ` +
      `${(floodCols * CELL).toFixed(2)} x ${(floodRows * CELL).toFixed(2)} m`
  );
} else {
  let wallLoX = cols, wallHiX = -1, wallLoY = rows, wallHiY = -1;
  for (let at = 0; at < cols * rows; at++) {
    if (!isWall(at)) continue;
    const cx = at % cols;
    const cy = (at - cx) / cols;
    if (cx < wallLoX) wallLoX = cx;
    if (cx > wallHiX) wallHiX = cx;
    if (cy < wallLoY) wallLoY = cy;
    if (cy > wallHiY) wallHiY = cy;
  }
  centreX = (wallLoX + wallHiX) / 2;
  centreY = (wallLoY + wallHiY) / 2;
  console.warn(
    `WARNING: flood fill implausible (${failure}); falling back to wall bounding-box centring, ` +
      `which is biased by driver-station structure and has been off by a metre before`
  );
}

/* Round the window's origin rather than its half-width. Rounding a half-width and doubling it throws
   away up to a whole cell per axis, which is why the emitted map was never quite the field size. */
const wantLoX = Math.round(centreX - (targetCols - 1) / 2);
const wantLoY = Math.round(centreY - (targetRows - 1) / 2);
const outCols = Math.min(targetCols, cols);
const outRows = Math.min(targetRows, rows);
/* Slide the window back inside the model grid instead of trimming its far edge. The old code clamped
   each edge independently, so a window that started off-grid came out narrower with no complaint —
   and every consumer scales its rendering to whatever size this file claims. */
const cropLoX = Math.max(0, Math.min(wantLoX, cols - outCols));
const cropLoY = Math.max(0, Math.min(wantLoY, rows - outRows));

if (outCols !== targetCols || outRows !== targetRows)
  console.warn(
    `WARNING: the ${targetCols} x ${targetRows} cell window does not fit the ${cols} x ${rows} ` +
      `model grid, so the output was SHRUNK to ${outCols} x ${outRows} ` +
      `(${(outCols * CELL).toFixed(2)} x ${(outRows * CELL).toFixed(2)} m). This is not the field.`
  );
if (cropLoX !== wantLoX || cropLoY !== wantLoY)
  console.warn(
    `WARNING: window shifted ${cropLoX - wantLoX}, ${cropLoY - wantLoY} cells to stay inside the ` +
      `model bounds; the crop is no longer centred on the detected field`
  );

console.log(
  `carpet datum ${datum.toFixed(3)} m above the model floor; emitting ` +
    `${outCols} x ${outRows} cells = ${(outCols * CELL).toFixed(2)} x ${(outRows * CELL).toFixed(2)} m`
);

/* Cells no triangle touched are carpet. The alternative — treating them as holes — would punch
   phantom pits wherever the model happens to be sparse. */
let untouched = 0;
const cropped = new Float32Array(outCols * outRows);
const croppedCeiling = new Float32Array(outCols * outRows);
for (let cy = 0; cy < outRows; cy++) {
  for (let cx = 0; cx < outCols; cx++) {
    const from = (cy + cropLoY) * cols + (cx + cropLoX);
    const to = cy * outCols + cx;
    const raw = height[from];
    if (raw === -Infinity) {
      cropped[to] = 0;
      untouched++;
    } else {
      cropped[to] = raw - datum;
    }
    const over = ceiling[from];
    // Open sky is recorded as a large finite number rather than infinity, so it survives JSON.
    croppedCeiling[to] = over === Infinity ? 9.999 : over - datum;
  }
}

// ---------------------------------------------------------------- emit

/* Millimetres as integers. Sub-millimetre field geometry is not a thing, and it makes the file a
   third the size of the same numbers as floats. */
const mm = Array.from(cropped, (h) => Math.round(h * 1000));

const stats = { below: 0, flat: 0, low: 0, tall: 0 };
for (const h of mm) {
  if (h < -20) stats.below++;
  else if (h <= 20) stats.flat++;
  else if (h <= 300) stats.low++;
  else stats.tall++;
}

/* lengthMeters is the emitted grid's size, not the field size we aimed for. Consumers are promised
   lengthMeters === cols * cellMeters exactly and scale their world to it, so if the crop came out a
   cell short the file has to say so rather than claim the nominal figure and misregister everything
   by a cell. Written as the raw product, not rounded: toFixed would hand back a different double for
   most cell sizes and break the equality it was meant to tidy up. */
const payload = JSON.stringify({
  note:
    "Generated by scripts/field-collision.mjs from the field CAD. Do not hand-edit, and do not " +
    "hand-copy between checkouts — re-run the script, which writes every destination at once.",
  cellMeters: CELL,
  cols: outCols,
  rows: outRows,
  lengthMeters: outCols * CELL,
  widthMeters: outRows * CELL,
  heightsMillimetres: mm,
  clearanceMillimetres: Array.from(croppedCeiling, (h) => Math.round(h * 1000)),
});

/* One buffer, every destination, one run. Sizes are read back off disk after writing rather than
   taken from payload.length, so the number in the log is evidence the bytes actually landed. */
const written = outPaths.map((dest) => {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, payload);
  return { dest, bytes: statSync(dest).size };
});

/* A cell is a trench if the floor is drivable but something hangs low over it — the case a
   height-only map calls solid. Reporting the count is how you tell at a glance whether the season's
   field actually has one, rather than finding out when a robot refuses to enter it. */
let trench = 0;
for (let i = 0; i < croppedCeiling.length; i++) {
  if (cropped[i] <= 0.05 && croppedCeiling[i] < 1.4) trench++;
}
console.log(`  ${trench} cells are floor-with-low-overhead (trench / under-structure passages)`);

/* A picture of what was actually written. The percentages say how much of the map is structure but
   not where any of it is, and "8.1% structure" read as perfectly plausible for the whole time every
   instanced part was stacked in one pile at midfield. Each character is the tallest cell in its
   block, so walls and uprights show up rather than being averaged away; rows are pooled twice as
   hard as columns because terminal characters are about twice as tall as they are wide. */
function occupancyMap() {
  const wide = Math.max(1, Math.round(outCols / 110));
  const tall = wide * 2;
  const lines = [];
  for (let by = 0; by < outRows; by += tall) {
    let line = "  ";
    for (let bx = 0; bx < outCols; bx += wide) {
      let peak = -Infinity;
      for (let cy = by; cy < Math.min(by + tall, outRows); cy++)
        for (let cx = bx; cx < Math.min(bx + wide, outCols); cx++) {
          const h = mm[cy * outCols + cx];
          if (h > peak) peak = h;
        }
      line += peak > 300 ? "#" : peak > 20 ? "+" : peak < -20 ? "v" : ".";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

console.log(
  `occupancy (# structure, + low, . carpet, v below; origin top-left, +x right, +y down)\n` +
    occupancyMap()
);

/* Every destination, every run, named individually. The whole point of the exercise is that a reader
   can see at a glance that the Java simulation's copy was refreshed too, instead of assuming it. */
console.log(
  `wrote ${written.length} destination${written.length === 1 ? "" : "s"}:\n` +
    written.map((w) => `  ${w.dest}  (${(w.bytes / 1024).toFixed(0)} KB, ${w.bytes} bytes)`).join("\n") +
    "\n" +
    `  ${outCols} x ${outRows} cells at ${CELL * 100} cm\n` +
    `  ${((stats.below / mm.length) * 100).toFixed(1)}% below carpet (trench), ` +
    `${((stats.flat / mm.length) * 100).toFixed(1)}% carpet, ` +
    `${((stats.low / mm.length) * 100).toFixed(1)}% low (ramps, trench walls, bumper-height), ` +
    `${((stats.tall / mm.length) * 100).toFixed(1)}% structure\n` +
    `  ${((untouched / mm.length) * 100).toFixed(1)}% of cells had no geometry and were taken as carpet`
);
