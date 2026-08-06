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
//   npm run field-collision                    # uses src/vendor/field.glb
//   npm run field-collision -- path/to.glb
//
// Writes src/vendor/field-collision.json, which both the console and the Java simulation read.

import { NodeIO } from "@gltf-transform/core";
import { EXTMeshGPUInstancing, KHRMeshQuantization } from "@gltf-transform/extensions";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = process.argv[2] || join(root, "src", "vendor", "field.glb");
const outPath = join(root, "src", "vendor", "field-collision.json");

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

  const visit = (node, parent) => {
    const local = node.getWorldMatrix ? node.getWorldMatrix() : null;
    const matrix = local ?? multiply(parent, node.getMatrix());
    const mesh = node.getMesh();
    if (mesh) {
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
    }
    for (const child of node.listChildren()) visit(child, matrix);
  };

  for (const scene of document.getRoot().listScenes()) {
    for (const node of scene.listChildren()) visit(node, identity());
  }
  return out;
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

function stamp(cx, cy, h) {
  if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) return;
  const at = cy * cols + cx;
  if (h > height[at]) height[at] = h;
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
 * Heights so far are measured from the lowest point anywhere in the model, which is not the carpet —
 * the export includes structure below the floor line, so every height is offset by about a metre and
 * the whole field reads as solid. Rather than hard-coding that offset, find it: the single most
 * common height across the model is the carpet, because the carpet is by far the largest flat thing
 * in it. Everything is then measured from there.
 *
 * The same trick gives the field bounds. The model's bounding box includes driver stations and
 * surrounds, so it is 22.6 m long where the carpet is 16.54. The extent of the cells sitting at the
 * carpet datum is the playing surface, which is the coordinate frame robot poses are in. */
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
   is why cropping to the carpet datum returns the whole room. The perimeter is structure, so the
   outermost tall cells are the wall ring and the field is what they enclose. */
const WALL_HEIGHT = 0.25;
let cropLoX = cols, cropHiX = -1, cropLoY = rows, cropHiY = -1;
for (let cy = 0; cy < rows; cy++) {
  for (let cx = 0; cx < cols; cx++) {
    const h = height[cy * cols + cx];
    if (h === -Infinity || h - datum < WALL_HEIGHT) continue;
    if (cx < cropLoX) cropLoX = cx;
    if (cx > cropHiX) cropHiX = cx;
    if (cy < cropLoY) cropLoY = cy;
    if (cy > cropHiY) cropHiY = cy;
  }
}
/* The wall ring alone is not the playing surface either: driver station structure sits outside the
   carpet and is taller than the threshold, so the detected box comes out around 18.0 x 10.4 m against
   a 16.54 x 8.07 carpet. Detection gets us the *centre* reliably — the field is symmetric about it —
   and the carpet size is a published number, so take the centre from the model and the size from the
   drawings. Guessing at either alone is what produced an offset map. */
const FIELD_LENGTH = Number(process.env.FIELD_LENGTH || 16.54);
const FIELD_WIDTH = Number(process.env.FIELD_WIDTH || 8.07);

const centreX = (cropLoX + cropHiX) / 2;
const centreY = (cropLoY + cropHiY) / 2;
const halfCols = Math.round(FIELD_LENGTH / CELL / 2);
const halfRows = Math.round(FIELD_WIDTH / CELL / 2);

cropLoX = Math.max(0, Math.round(centreX - halfCols));
cropHiX = Math.min(cols - 1, cropLoX + halfCols * 2 - 1);
cropLoY = Math.max(0, Math.round(centreY - halfRows));
cropHiY = Math.min(rows - 1, cropLoY + halfRows * 2 - 1);

const outCols = cropHiX - cropLoX + 1;
const outRows = cropHiY - cropLoY + 1;
console.log(
  `carpet datum ${datum.toFixed(3)} m above the model floor; playing surface ` +
    `${(outCols * CELL).toFixed(2)} x ${(outRows * CELL).toFixed(2)} m`
);

/* Cells no triangle touched are carpet. The alternative — treating them as holes — would punch
   phantom pits wherever the model happens to be sparse. */
let untouched = 0;
const cropped = new Float32Array(outCols * outRows);
for (let cy = 0; cy < outRows; cy++) {
  for (let cx = 0; cx < outCols; cx++) {
    const raw = height[(cy + cropLoY) * cols + (cx + cropLoX)];
    if (raw === -Infinity) {
      cropped[cy * outCols + cx] = 0;
      untouched++;
    } else {
      cropped[cy * outCols + cx] = raw - datum;
    }
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

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify({
    note: "Generated by scripts/field-collision.mjs from the field CAD. Do not hand-edit.",
    cellMeters: CELL,
    cols: outCols,
    rows: outRows,
    lengthMeters: +(outCols * CELL).toFixed(4),
    widthMeters: +(outRows * CELL).toFixed(4),
    heightsMillimetres: mm,
  })
);

const kb = (JSON.stringify(mm).length / 1024).toFixed(0);
console.log(
  `wrote ${outPath}\n` +
    `  ${cols} x ${rows} cells at ${CELL * 100} cm  (~${kb} KB)\n` +
    `  ${((stats.below / mm.length) * 100).toFixed(1)}% below carpet (trench), ` +
    `${((stats.flat / mm.length) * 100).toFixed(1)}% carpet, ` +
    `${((stats.low / mm.length) * 100).toFixed(1)}% low (ramps, trench walls, bumper-height), ` +
    `${((stats.tall / mm.length) * 100).toFixed(1)}% structure\n` +
    `  ${((untouched / mm.length) * 100).toFixed(1)}% of cells had no geometry and were taken as carpet`
);
