// Turn the field CAD into collision geometry.
//
// Hand-placed obstacle boxes never match the real field. Someone measures the hub, forgets the trench,
// approximates the ramp as a wall, and the simulation quietly disagrees with the thing it is meant to
// represent. This reads the actual model and derives collision from it.
//
// The output is two grids over a fixed 5 cm lattice. HEIGHT is the drivable floor in each cell — the
// surface a wheel actually rests on. CLEARANCE is the underside of the next thing above it, and only
// when a robot could get under there at all. A heightmap is chosen over an occupancy grid because it
// is the representation that gets ramps right: occupancy can only say "solid" or "not", so a ramp
// becomes either a wall you cannot climb or a hole you drive through. With floor and ceiling:
//
//   * flat carpet          -> height ~0, open sky, drivable
//   * a ramp               -> a gradient, drivable while the slope stays under what wheels can climb
//   * a trench             -> height ~0 with a low ceiling; a short robot fits, a tall one does not
//   * structure            -> height above what a robot can climb, blocked
//
// so all four fall out of two numbers per cell and one slope test, rather than four special cases.
//
// Height is the DRIVABLE FLOOR, not the column maximum. That distinction is the whole reason the
// trench works. Take the maximum and a trench cell reports the top of the bar; pair it with a
// clearance taken as a minimum over the same samples and clearance <= height becomes an arithmetic
// identity, so the one shape the consumer needs — carpet with a bar over it — cannot be expressed.
// The invariant here is the other way round and is asserted before anything is written:
//
//   clearance >= height, always, for every cell.
//
// Loose game pieces are excluded. The CAD models the fuel where a referee sets it, heaped across
// midfield; rasterized as terrain that is a slab nothing can climb. A robot drives through fuel and
// knocks it aside, so it belongs to the 3D view and to SimulatedGamePiece, not to the terrain map.
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

/* Loose game pieces are not terrain.
 *
 * The 2026 field CAD places 456 balls, 408 of them on the carpet and 360 of those heaped across
 * midfield. Rasterized as terrain they are a 2 x 7 m slab 150 mm proud of the floor lying straight
 * across the field, which nothing can climb at a sane step tolerance, and they poison the clearance
 * layer as well because a ball on the carpet reads as something overhead.
 *
 * Identification cannot rely on names. `gltf-transform optimize` in field-cad.mjs flattens, instances
 * and palettizes the model, and that discards them — 110 of 110 meshes in field.glb are unnamed. The
 * name is still tried first so that pointing this script at the raw KOP glb, where the part is
 * "GE-26900_ FUEL", does the obvious thing. Anchored to the leaf part name past SolidWorks' -N
 * instance suffixes: a bare /\bfuel\b/ matches 916 nodes in the raw CAD and would delete the hub's
 * Fuel Counter mechanism along with the fuel. This form matches exactly the 456 balls. */
const GAME_PIECE_NAME =
  /(?:^|\/)[^/]*\b(fuel|game[ _-]?piece|cargo|power[ _-]?cell|boulder)s?(?:[ _-]*\d+)*\s*$/i;

/** Every vertex of one placement, in world space. */
function placementPoints(mesh, matrix) {
  const points = [];
  const p = [0, 0, 0];
  for (const prim of mesh.listPrimitives()) {
    const position = prim.getAttribute("POSITION");
    if (!position) continue;
    for (let i = 0; i < position.getCount(); i++) {
      position.getElement(i, p);
      points.push(apply(matrix, p));
    }
  }
  return points;
}

/** World-space bounding box of a set of points. */
function boundsOf(points) {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let k = 0; k < 3; k++) {
      if (p[k] < lo[k]) lo[k] = p[k];
      if (p[k] > hi[k]) hi[k] = p[k];
    }
  return [lo, hi];
}

/* Measured in WORLD space rather than local: KHR_mesh_quantization scales each axis of the stored
 * mesh independently, so a quantized ball is an ellipsoid until the node matrix is applied.
 *
 * Every threshold is measured against this model rather than guessed:
 *   placements >= 24   the fuel comes as 456; the next-most-placed candidate is 56
 *   50..450 mm         the fuel is 150 mm. Under 50 mm everything is a fastener and could not block a
 *                      robot anyway; over 450 mm nothing is a piece you drive through
 *   aspect <= 1.25     the fuel is 1.03. The roundest non-fuel candidate is 1.22, and that one is
 *                      rejected twice over
 *   cv <= 0.10         every vertex the same distance from the centre. The fuel scores 0.0044 and the
 *                      next-best candidate scores 0.0639, a 14x margin. This is the clause doing the
 *                      work: nothing in a field frame is a sphere.
 *
 * It excludes exactly one node of 110, and no cell stops being structure — it never masks a wall. */
function isLooseGamePiece(node, mesh, matrix, placements) {
  if (GAME_PIECE_NAME.test(node.getName() || "") || GAME_PIECE_NAME.test(mesh.getName() || ""))
    return true;
  if (placements < 24) return false;

  const points = placementPoints(mesh, matrix);
  if (points.length < 12) return false;

  const [lo, hi] = boundsOf(points);
  const size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
  const largest = Math.max(...size);
  if (largest < 0.05 || largest > 0.45) return false;
  if (largest / Math.max(Math.min(...size), 1e-9) > 1.25) return false;

  const centre = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  let sum = 0;
  let sumSq = 0;
  for (const p of points) {
    const r = Math.hypot(p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]);
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / points.length;
  if (mean <= 0) return false;
  return Math.sqrt(Math.max(sumSq / points.length - mean * mean, 0)) / mean <= 0.1;
}

/** Walk the scene graph accumulating world transforms, and emit every triangle in world space. */
function worldTriangles(document) {
  const out = [];
  let instancedMeshes = 0;
  let placements = 0;
  const dropped = [];

  /* How many nodes share each mesh: the un-instanced equivalent of an instance count, so the shape
     test still has something to weigh if a future pipeline stops emitting EXT_mesh_gpu_instancing. */
  const meshUsers = new Map();
  for (const node of document.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (mesh) meshUsers.set(mesh, (meshUsers.get(mesh) || 0) + 1);
  }

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
      const first = count > 0 ? multiply(matrix, instanceMatrix(batch, 0)) : matrix;
      if (isLooseGamePiece(node, mesh, first, count || meshUsers.get(mesh) || 1)) {
        dropped.push({ node, mesh, count: count || 1, first });
      } else if (count > 0) {
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
  if (dropped.length) {
    let total = 0;
    for (const d of dropped) {
      const [lo, hi] = boundsOf(placementPoints(d.mesh, d.first));
      const mm3 = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]].map((v) => Math.round(v * 1000));
      total += d.count;
      console.log(
        `  excluded ${d.count} placements of a ${mm3.join(" x ")} mm loose game piece` +
          (d.node.getName() ? ` ("${d.node.getName()}")` : " (unnamed — matched by shape)")
      );
    }
    console.log(
      `  ${total} game pieces kept out of the collision map: they are drawn in 3D and simulated by ` +
        `SimulatedGamePiece, but a robot drives through them`
    );
  } else {
    /* Loud, because silence here is indistinguishable from success and costs a season. The 2026 field
       has 456 balls piled at midfield; if a model turns up with none recognised, either the pieces are
       gone or the shape test has stopped matching them, and the map now has a wall down the middle
       that nobody put there. */
    console.warn(
      "WARNING: no loose game pieces were recognised. If this field has any, they are now baked into " +
        "the terrain and will read as an obstacle a robot cannot cross."
    );
  }
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

/* A vertical occupancy column per cell, by proper scan conversion.
 *
 * Sampling vertices and centroids is not enough, and the way it fails is instructive: the carpet is a
 * handful of triangles twenty metres across, so point sampling stamps about seven cells out of a
 * hundred thousand and declares the entire field empty. Every triangle has to be filled.
 *
 * A column rather than a pair of scalars, because a minimum and a maximum cannot describe a trench.
 * Both come from the same set of stamped samples, so the "lowest thing above the carpet" is always at
 * or below the "highest thing anywhere" and clearance <= height is forced — which is exactly what the
 * previous version emitted, for all 9163 of its non-sky cells. That is not a quirk of this field: it
 * was unreachable by construction. Worse, it read every ramp deck as a 7 cm roof over its own driving
 * surface, so a robot refused to climb the floor it was standing on.
 *
 * A column of bits records where material is *absent*, which is the question actually being asked.
 * Floor and ceiling are then read off the gaps, further down.
 *
 * 5 mm bins: half the quantisation of a 1 cm bin, and on a ramp that difference lands straight in the
 * per-cell step the climb limit is judged against. Eight megabytes for a whole field. */
const ZBIN = 0.005;
const NBINS = Math.ceil(extent[up] / ZBIN) + 2;
const WORDS = Math.ceil(NBINS / 32);
const occupancy = new Uint32Array(cols * rows * WORDS);

/* The highest SURFACE SAMPLE per cell, alongside the bins — the height of the material where it
   crosses this cell, not the top of the span stamped for it. Bins are deliberately generous: a fill
   marks half a cell's rise either side of the sample so that a steep face leaves no holes for the gap
   test to fall through. Take a peak from that and every sloped cell is overstated by half its own
   gradient, which on a ramp doubles the apparent per-cell step — the exact quantity the climb limit
   is judged against. So the two are kept apart: spans decide where material is, samples decide how
   high it is. */
const peak = new Float32Array(cols * rows).fill(-Infinity);

/* Mark every bin a surface passes through, not just the bin it ends in. Material is continuous, and a
   column punched full of 5 mm holes reads as a stack of passages. */
function stampSpan(cx, cy, zLo, zHi, sample) {
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
  const lo = zLo < zHi ? zLo : zHi;
  const hi = zLo < zHi ? zHi : zLo;
  let b0 = Math.floor(lo / ZBIN);
  let b1 = Math.floor(hi / ZBIN);
  if (b1 < 0 || b0 >= NBINS) return;
  if (b0 < 0) b0 = 0;
  if (b1 >= NBINS) b1 = NBINS - 1;
  const at = cy * cols + cx;
  const base = at * WORDS;
  for (let b = b0; b <= b1; b++) occupancy[base + (b >> 5)] |= 1 << (b & 31);
  if (sample > peak[at]) peak[at] = sample;
}

/** Cell coordinates and height of a world-space vertex. */
function project(v) {
  return [(v[ax] - min[ax]) / CELL, (v[ay] - min[ay]) / CELL, v[up] - min[up]];
}

/* Edges are rasterized as well as fills. A vertical face — every wall, every ramp skirt, every trench
   upright — projects from above to a line with no area, so the barycentric fill covers none of it,
   and walls are exactly what collision cares most about.

   Each step stamps the segment's z SPAN rather than its endpoint. A vertical edge collapses to one
   cell and therefore one step, so stamping endpoints alone would leave every bin between them empty
   and a solid wall would read as a passage its own height — the one mistake that would let a robot
   drive through the perimeter. */
function rasterEdge(a, b) {
  const steps = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1]))) + 1;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const tNext = Math.min(1, (i + 1) / steps);
    const z = a[2] + (b[2] - a[2]) * t;
    const zNext = a[2] + (b[2] - a[2]) * tNext;
    stampSpan(
      Math.floor(a[0] + (b[0] - a[0]) * t),
      Math.floor(a[1] + (b[1] - a[1]) * t),
      z,
      zNext,
      // A wall's top is a surface a robot can end up on, so an edge offers its highest point.
      Math.max(z, zNext)
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

  /* How far the triangle's plane rises across half a cell, so a steep face fills the bins it crosses
     instead of leaving gaps between one cell's sample and the next. Without it a 30 degree ramp deck
     is a ladder of 5 mm rungs with air in between, and the gap test reads the air. The plane's z
     gradient falls straight out of the projected cross product, whose z component is the area. */
  const nx = (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]);
  const ny = (p1[2] - p0[2]) * (p2[0] - p0[0]) - (p1[0] - p0[0]) * (p2[2] - p0[2]);
  const halfRise = (0.5 * (Math.abs(nx) + Math.abs(ny))) / Math.abs(area);
  const triLo = Math.min(p0[2], p1[2], p2[2]);
  const triHi = Math.max(p0[2], p1[2], p2[2]);

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
      const zc = w0 * p0[2] + w1 * p1[2] + w2 * p2[2];
      stampSpan(cx, cy, Math.max(triLo, zc - halfRise), Math.min(triHi, zc + halfRise), zc);
    }
  }
}

/* ---------------------------------------------------------------- where the ground is
 *
 * Measured by area, which is to say by how many cells a surface covers, not by how many vertices it
 * has.
 *
 * This used to be the modal height of the model's VERTICES, and it was one part removal away from
 * catastrophe the whole time. The carpet is a handful of enormous triangles, so it carries almost no
 * vertices; it only ever won that vote because 456 balls were sitting on it contributing tens of
 * thousands. Stop rasterizing the fuel and the mode jumps to a shelf a metre up, every column
 * measures its floor from there, and the entire field emits as flat carpet with the real structure
 * recorded as a ceiling hanging over it. The map looked plausible and was meaningless.
 *
 * Counting cells per bin cannot be fooled that way: the carpet is the one surface underneath every
 * cell in the model, so it wins by two orders of magnitude however few triangles it is made of. */
const binCells = new Int32Array(NBINS);
for (let at = 0; at < cols * rows; at++) {
  const base = at * WORDS;
  for (let w = 0; w < WORDS; w++) {
    const bits = occupancy[base + w];
    if (!bits) continue;
    for (let k = 0; k < 32; k++) if ((bits >>> k) & 1) binCells[(w << 5) + k]++;
  }
}
let groundBin = 0;
for (let b = 1; b < NBINS; b++) if (binCells[b] > binCells[groundBin]) groundBin = b;
const carpetHeight = groundBin * ZBIN;
console.log(
  `ground plane at ${carpetHeight.toFixed(3)} m above the model floor, covering ` +
    `${binCells[groundBin]} of ${cols * rows} cells`
);
/* Every height in the file is measured from here, so a wrong answer here is not a wrong detail, it is
   a wrong map — and the failure is silent, because the output still looks like a field. The winner
   should be the carpet, and the carpet is under nearly everything. */
if (binCells[groundBin] < cols * rows * 0.5)
  console.warn(
    `WARNING: the ground plane covers only ` +
      `${((binCells[groundBin] / (cols * rows)) * 100).toFixed(0)}% of the grid. A carpet covers ` +
      `almost all of it, so this is probably not the carpet and every height below is measured from ` +
      `the wrong datum.`
  );

/* ---------------------------------------------------------------- floor and ceiling
 *
 * Read each column once. The drivable floor is the top of the material the carpet leads up to; the
 * ceiling is the underside of the next thing above it, and only when a robot could get under there.
 *
 * The gap test is the whole trick, and it is what tells a ramp from a trench. In the CAD the carpet is
 * one quad running underneath everything, so a ramp is a hollow shell floating over carpet and a
 * trench rail is a bar floating over carpet: structurally the same column. What separates them is how
 * much air is in between. A ramp deck is a 14 mm plate sitting at most 165 mm up, so its underside is
 * a hand's breadth over the carpet — you ride over it, and a rule that stopped at the first gap would
 * drive the robot underneath its own floor. The trench rail is 565 mm up — you duck under it.
 *
 * 300 mm is the dividing line, and it is a physical claim rather than a tuning knob: nothing in FRC
 * fits through a smaller gap, so a smaller gap is not a passage, it is the underside of the slab
 * being stood on. Below it, material is absorbed into the floor and the floor keeps climbing. */
const MIN_PASSAGE = 0.3;
const PASSAGE_BINS = Math.round(MIN_PASSAGE / ZBIN);

const height = new Float32Array(cols * rows).fill(-Infinity);
const ceiling = new Float32Array(cols * rows).fill(Infinity);

const runLo = new Int32Array(NBINS);
const runHi = new Int32Array(NBINS);

for (let at = 0; at < cols * rows; at++) {
  const base = at * WORDS;
  let runs = 0;
  for (let w = 0; w < WORDS; w++) {
    const bits = occupancy[base + w];
    if (!bits) continue;   // most of a field is air; skipping empty words is most of the speed
    for (let k = 0; k < 32; k++) {
      if (!((bits >>> k) & 1)) continue;
      const b = (w << 5) + k;
      if (runs > 0 && b === runHi[runs - 1] + 1) runHi[runs - 1] = b;
      else { runLo[runs] = b; runHi[runs] = b; runs++; }
    }
  }
  // No geometry at all: left as -Infinity, which the crop reads as untouched carpet.
  if (runs === 0) continue;

  let floorBin = groundBin;
  let over = 0;
  for (; over < runs; over++) {
    if (runLo[over] > floorBin + PASSAGE_BINS) break;   // real air: everything above is a ceiling
    if (runHi[over] > floorBin) floorBin = runHi[over];
  }

  /* Where the ground run reaches the top of the column — carpet, a ramp deck, the top of a wall,
     which is most of the map — the surface a wheel rests on was measured directly, so use the
     measurement. Only where something is left above it, which is to say under a trench bar, does the
     floor have to fall back to the bin top and carry up to 5 mm of quantisation. */
  height[at] = floorBin === runHi[runs - 1] ? peak[at] : (floorBin + 1) * ZBIN;
  // The bin's bottom, so headroom is understated rather than overstated.
  ceiling[at] = over < runs ? runLo[over] * ZBIN : Infinity;
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

/* Two independent measurements of the same plane: the modal floor here, and the modal occupied bin
   above. They are computed from different quantities and must land within a bin of each other. Every
   height in the file is relative to this number, so getting it wrong does not produce a slightly
   wrong map, it produces a confident and entirely false one — which has happened twice in this
   script's history, once from the instancing bug and once from counting vertices instead of area.
   Two ways of asking is cheap; finding out at an event is not. */
if (Math.abs(datum - carpetHeight) > ZBIN + BIN)
  console.warn(
    `WARNING: the two carpet estimates disagree — modal floor ${datum.toFixed(3)} m against ` +
      `ground plane ${carpetHeight.toFixed(3)} m. One of them is not the carpet, and every height ` +
      `in the output is measured from the first.`
  );

/* Bound the field by its walls, not by its floor. The venue floor outside the perimeter is at exactly
   the same height as the carpet — physically true, and useless for finding the playing surface, which
   is why cropping to the carpet datum returns the whole room. */
/** Above this, relative to the carpet, a cell is a wall rather than something to drive over. */
const WALL_HEIGHT = 0.25;
const FIELD_LENGTH = Number(process.env.FIELD_LENGTH || 16.54);
const FIELD_WIDTH = Number(process.env.FIELD_WIDTH || 8.07);

/* True where a cell has structure standing in it. Cells no triangle touched count as floor.

   Deliberately the column maximum and not the drivable floor. This test exists only to trace the
   perimeter ring so the crop can be centred on it, and "is there a wall here" is a question about
   whether any material stands in the cell, not about whether you could crawl under it. Judged on the
   floor instead, the perimeter reads as bare carpet with something overhead, the fill walks straight
   out through it into the venue, and the crop falls back to wall bounding-box centring — which is
   biased by driver-station structure and is the exact route by which this map once came out a metre
   off across the field width. */
const isWall = (at) => {
  const h = peak[at];
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

/* Nothing overhead, as the file format spells it. A sentinel rather than a real measurement, and one
   the consumer knows by the same number — FieldHeightmap.OPEN_SKY. It once read 9.0 there against
   9.999 here and every comparison against it silently missed, so it is written once and used
   everywhere below. */
const OPEN_SKY_MM = 9999;

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
    // A large finite number rather than infinity, so it survives JSON.
    croppedCeiling[to] = over === Infinity ? OPEN_SKY_MM / 1000 : over - datum;
  }
}

// ---------------------------------------------------------------- emit

/* Millimetres as integers. Sub-millimetre field geometry is not a thing, and it makes the file a
   third the size of the same numbers as floats. */
const mm = Array.from(cropped, (h) => Math.round(h * 1000));
const clearanceMm = Array.from(croppedCeiling, (h) => Math.round(h * 1000));

const stats = { sunken: 0, carpet: 0, low: 0, structure: 0 };
for (const h of mm) {
  if (h < -20) stats.sunken++;
  else if (h <= 20) stats.carpet++;
  else if (h <= 300) stats.low++;
  else stats.structure++;
}

/* A cell you drive under: drivable floor with something over it, far enough over it that getting
   under is a question of robot height rather than a question of whether the geometry is solid. This
   is the shape a height-only map calls solid and refuses to enter. Counting them is how you tell at a
   glance whether the season's field actually has a trench, rather than finding out when a robot will
   not go down it. */
let passages = 0;
let lowestPassage = Infinity;
for (let i = 0; i < clearanceMm.length; i++) {
  if (clearanceMm[i] >= OPEN_SKY_MM) continue;
  passages++;
  if (clearanceMm[i] < lowestPassage) lowestPassage = clearanceMm[i];
}

/* The invariant the consumer is written against: a ceiling is the underside of something with
   drivable floor beneath it, so it cannot sit below the floor it stands over. The previous generator
   could not satisfy this for a single cell — clearance was a minimum and height a maximum over the
   same samples — which quietly made FieldHeightmap's whole trench path dead code. Fail the run rather
   than write a file that lies, so the next person to touch the rasterizer finds out here instead of
   at an event. */
const broken = [];
for (let i = 0; i < clearanceMm.length; i++) {
  if (clearanceMm[i] < mm[i]) broken.push(i);
}
if (broken.length) {
  const worst = broken.reduce((a, i) => (clearanceMm[i] - mm[i] < clearanceMm[a] - mm[a] ? i : a));
  console.error(
    `${broken.length} cells have a ceiling below their own floor — worst at ` +
      `(${worst % outCols}, ${Math.floor(worst / outCols)}), floor ${mm[worst]} mm under a ` +
      `ceiling of ${clearanceMm[worst]} mm. Nothing was written.`
  );
  process.exit(1);
}
if (stats.sunken) {
  console.warn(
    `WARNING: ${stats.sunken} cells sit more than 20 mm below the carpet. Height is the drivable ` +
      `floor, and an FRC field has nothing dug into it, so this is a rasterizer fault, not terrain.`
  );
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
  clearanceMillimetres: clearanceMm,
});

/* One buffer, every destination, one run. Sizes are read back off disk after writing rather than
   taken from payload.length, so the number in the log is evidence the bytes actually landed. */
const written = outPaths.map((dest) => {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, payload);
  return { dest, bytes: statSync(dest).size };
});

console.log(
  passages
    ? `  ${passages} cells are drive-under passages (trench / under-structure), lowest bar ` +
        `${lowestPassage} mm — a robot taller than that is turned away, a shorter one goes through`
    : `  no drive-under passages found: every cell is open sky. If this field has a trench, the ` +
        `${MIN_PASSAGE * 1000} mm passage threshold or the rasterizer is wrong.`
);

/* A picture of what was actually written. The percentages say how much of the map is structure but
   not where any of it is, and "8.1% structure" read as perfectly plausible for the whole time every
   instanced part was stacked in one pile at midfield. Each character is the tallest cell in its
   block, so walls and uprights show up rather than being averaged away; rows are pooled twice as
   hard as columns because terminal characters are about twice as tall as they are wide.

   A passage outranks the floor under it, because a trench reads as bare carpet in the height grid and
   would otherwise be invisible in the one picture anyone actually looks at. */
function occupancyMap() {
  const wide = Math.max(1, Math.round(outCols / 110));
  const tall = wide * 2;
  const lines = [];
  for (let by = 0; by < outRows; by += tall) {
    let line = "  ";
    for (let bx = 0; bx < outCols; bx += wide) {
      let tallest = -Infinity;
      let under = false;
      for (let cy = by; cy < Math.min(by + tall, outRows); cy++)
        for (let cx = bx; cx < Math.min(bx + wide, outCols); cx++) {
          const at = cy * outCols + cx;
          if (mm[at] > tallest) tallest = mm[at];
          if (clearanceMm[at] < OPEN_SKY_MM) under = true;
        }
      line += under ? "~" : tallest > 300 ? "#" : tallest > 20 ? "+" : ".";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

console.log(
  `occupancy (# structure, + low, ~ drive-under, . carpet; origin top-left, +x right, +y down)\n` +
    occupancyMap()
);

/* Every destination, every run, named individually. The whole point of the exercise is that a reader
   can see at a glance that the Java simulation's copy was refreshed too, instead of assuming it. */
console.log(
  `wrote ${written.length} destination${written.length === 1 ? "" : "s"}:\n` +
    written.map((w) => `  ${w.dest}  (${(w.bytes / 1024).toFixed(0)} KB, ${w.bytes} bytes)`).join("\n") +
    "\n" +
    `  ${outCols} x ${outRows} cells at ${CELL * 100} cm\n` +
    `  ${((stats.carpet / mm.length) * 100).toFixed(1)}% carpet, ` +
    `${((stats.low / mm.length) * 100).toFixed(1)}% low (ramps, kickplates, bumper-height), ` +
    `${((stats.structure / mm.length) * 100).toFixed(1)}% structure, ` +
    `${((passages / mm.length) * 100).toFixed(1)}% drive-under\n` +
    `  ${((untouched / mm.length) * 100).toFixed(1)}% of cells had no geometry and were taken as carpet`
);
