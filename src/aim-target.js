/* What the robot is aiming at, as the field view needs to know it: which HUB or AprilTag the published
 * target is, where the line from the robot to it meets that thing's face, and which face that is.
 *
 * Kept apart from field3d.js so the geometry can be tested without a renderer. Everything here is in
 * WPILib field metres, blue origin, the frame /Catalyst/Aim/Target is published in.
 *
 * It exists because a turret or shooting-on-the-move robot aims at the HUB's centre, and the centre is
 * inside the HUB. A view that marks the target where it is ends up marking the inside of a structure, so
 * the marks have to stop at its face: the aim band ends where the line to the centre enters the HUB, and
 * the face it enters through is the one that is lit. */

/* The two HUBS on the 2026 field: 1.207 m squares about their centres (WPILib's 2026 layout puts the tags
   on their faces at these x and y). */
const hub = (name, cx) => {
  const half = 0.6037;
  const cy = 4.0346;
  return Object.freeze({ name, centre: [cx, cy], half, min: [cx - half, cy - half], max: [cx + half, cy + half] });
};
export const HUBS = Object.freeze([hub("blue", 4.6255), hub("red", 11.9155)]);

/* The 2026 AprilTags (WPILib's 2026-rebuilt-welded layout): id, x, y, height of the tag's centre, and the
   way it faces in degrees. The tags on the HUBS are 1.12 m up, the ones on the alliance walls 0.55 m and
   the trench tags 0.89 m. Each tag is 0.165 m square. */
export const TAG_SIZE = 0.1651;
export const TAGS = Object.freeze([
  [1, 11.878, 7.425, 0.889, 180], [2, 11.915, 4.638, 1.124, 90], [3, 11.312, 4.390, 1.124, 180],
  [4, 11.312, 4.035, 1.124, 180], [5, 11.915, 3.431, 1.124, -90], [6, 11.878, 0.644, 0.889, 180],
  [7, 11.953, 0.644, 0.889, 0], [8, 12.271, 3.431, 1.124, -90], [9, 12.519, 3.679, 1.124, 0],
  [10, 12.519, 4.035, 1.124, 0], [11, 12.271, 4.638, 1.124, 90], [12, 11.953, 7.425, 0.889, 0],
  [13, 16.533, 7.403, 0.552, 180], [14, 16.533, 6.972, 0.552, 180], [15, 16.533, 4.324, 0.552, 180],
  [16, 16.533, 3.892, 0.552, 180], [17, 4.663, 0.644, 0.889, 0], [18, 4.626, 3.431, 1.124, -90],
  [19, 5.229, 3.679, 1.124, 0], [20, 5.229, 4.035, 1.124, 0], [21, 4.626, 4.638, 1.124, 90],
  [22, 4.663, 7.425, 0.889, 0], [23, 4.588, 7.425, 0.889, 180], [24, 4.270, 4.638, 1.124, 90],
  [25, 4.022, 4.390, 1.124, 180], [26, 4.022, 4.035, 1.124, 180], [27, 4.270, 3.431, 1.124, -90],
  [28, 4.588, 0.644, 0.889, 180], [29, 0.008, 0.666, 0.552, 0], [30, 0.008, 1.098, 0.552, 0],
  [31, 0.008, 3.746, 0.552, 0], [32, 0.008, 4.178, 0.552, 0],
].map(([id, x, y, z, yawDeg]) => Object.freeze({ id, x, y, z, yaw: (yawDeg * Math.PI) / 180 })));

/* The four faces of a square, by the way each one faces. */
const FACES = Object.freeze({
  "-x": { axis: 0, side: "min", normal: [-1, 0] },
  "+x": { axis: 0, side: "max", normal: [1, 0] },
  "-y": { axis: 1, side: "min", normal: [0, -1] },
  "+y": { axis: 1, side: "max", normal: [0, 1] },
});

/** The outward direction of a square's `face` ("-x", "+x", "-y" or "+y"), as [x, y]. */
export function faceNormal(face) {
  return FACES[face]?.normal ?? null;
}

/** The HUB whose footprint holds field point [x, y], within `slack` metres of it (a tag on a face counts). */
export function hubContaining([x, y], slack = 0.03) {
  return HUBS.find((h) => x >= h.min[0] - slack && x <= h.max[0] + slack && y >= h.min[1] - slack && y <= h.max[1] + slack) ?? null;
}

/**
 * Where the line from `from` to `to` enters `square` ({ min, max }): `{ point, face, t }`, with `t` the
 * share of the way along. Null when the line starts inside the square or never reaches it.
 */
export function enterSquare(from, to, square) {
  let enter = 0;
  let exit = 1;
  let face = null;
  for (const axis of [0, 1]) {
    const start = from[axis];
    const run = to[axis] - start;
    const lo = square.min[axis];
    const hi = square.max[axis];
    if (Math.abs(run) < 1e-12) {
      if (start < lo || start > hi) return null;
      continue;
    }
    const a = (lo - start) / run;
    const b = (hi - start) / run;
    const near = Math.min(a, b);
    if (near > enter) {
      enter = near;
      face = (a < b ? "-" : "+") + (axis === 0 ? "x" : "y");
    }
    exit = Math.min(exit, Math.max(a, b));
    if (enter > exit) return null;
  }
  if (!face) return null;
  return { point: [from[0] + (to[0] - from[0]) * enter, from[1] + (to[1] - from[1]) * enter], face, t: enter };
}

/**
 * The face of `square` to light for a robot at `from` aiming at `to`: the one the line enters through,
 * except that the face already lit (`current`) is kept while the line still meets it within `slack`
 * metres of its corner. A robot sitting near the square's diagonal would otherwise flip the light from
 * one face to the other with every wobble in its pose.
 */
export function faceToward(from, to, square, current = null, slack = 0.15) {
  const entry = enterSquare(from, to, square);
  if (!entry) return current;
  if (!current || current === entry.face || !FACES[current]) return entry.face;
  const { axis, side } = FACES[current];
  const plane = square[side][axis];
  const run = to[axis] - from[axis];
  const outside = side === "min" ? from[axis] < plane : from[axis] > plane;
  if (!outside || Math.abs(run) < 1e-12) return entry.face;
  const t = (plane - from[axis]) / run;
  const other = 1 - axis;
  const across = from[other] + (to[other] - from[other]) * t;
  const keep = t > 0 && across >= square.min[other] - slack && across <= square.max[other] + slack;
  return keep ? current : entry.face;
}

/**
 * The 2026 tag at field point [x, y], if one is within `within` metres of it, or null. Two tags stand back
 * to back on each trench arm, so of the tags in reach the one facing the robot at `from` wins, then the
 * nearest.
 */
export function nearestTag([x, y], from = null, within = 0.25) {
  let best = null;
  let bestScore = Infinity;
  for (const tag of TAGS) {
    const d = Math.hypot(tag.x - x, tag.y - y);
    if (d > within) continue;
    const facing = !from || Math.cos(tag.yaw) * (from[0] - tag.x) + Math.sin(tag.yaw) * (from[1] - tag.y) > 0;
    const score = d + (facing ? 0 : 1);
    if (score < bestScore) {
      best = tag;
      bestScore = score;
    }
  }
  return best;
}
