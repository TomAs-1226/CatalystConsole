/* What the robot is aiming at, as the field view and the field tile's caption need to know it: whether the
 * published target is a HUB or an AprilTag, where the line from the robot to a HUB meets its face, where a
 * robot aligning to a tag will stop, and how the caption says what the aim is doing.
 *
 * Kept apart from field3d.js so the geometry can be tested without a renderer. Everything here is in
 * WPILib field metres, blue origin, the frame /Catalyst/Aim/Target is published in.
 *
 * It exists because the two aims look alike on the wire and mean different things. A turret or
 * shooting-on-the-move robot aims at the HUB's centre, which is inside the HUB, so the band to it has to
 * stop at the HUB's face and the HUB itself is what is lit. A robot aligning to a tag drives to a place in
 * front of it, so that place is drawn as well as the tag. */

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

/* How far a published target may be from the tag the robot says it sees and still be taken for that tag.
   A robot aligning beside a tag (X1 aims up to 3 in to either side of it) places the target through its
   own pose, so it lands a little off the tag; the centre of a HUB, 0.6 m from its nearest tag, must not. */
const SEEN_TAG_REACH = 0.4;

/**
 * What an aim at field point `target` is aimed at: `{ kind: "tag", tag, hub }`, with the HUB the tag is on
 * or null, `{ kind: "hub", hub }` or `{ kind: "place" }` for anything else.
 *
 * A tag is the one the robot says it sees (`tagId`) when the target is within reach of it, and otherwise
 * the tag the target is on (see nearestTag, with the robot at `from`). A target in a HUB's footprint that
 * is not a tag is that HUB: a turret, or a robot shooting on the move, aims at its centre.
 */
export function aimedAt(target, { from = null, tagId = null } = {}) {
  if (!Array.isArray(target) || !Number.isFinite(target[0]) || !Number.isFinite(target[1])) return { kind: "place" };
  const seen = Number.isInteger(tagId) ? TAGS.find((t) => t.id === tagId) : null;
  const tag = seen && Math.hypot(seen.x - target[0], seen.y - target[1]) <= SEEN_TAG_REACH ? seen : nearestTag(target, from);
  if (tag) return { kind: "tag", tag, hub: hubContaining([tag.x, tag.y]) };
  const hub = hubContaining(target);
  return hub ? { kind: "hub", hub } : { kind: "place" };
}

/**
 * How far the face a HUB's `tag` is on runs to either side of the tag, as [left, right] in metres along
 * the face - left negative - seen from in front of the tag, so its light can stop at the face's edges
 * instead of hanging in the air past a corner. Half the HUB's tags are 0.36 m off their face's centre.
 */
export function faceSpan(tag, hub) {
  const nx = Math.cos(tag.yaw);
  const ny = Math.sin(tag.yaw);
  const along = -(tag.x - hub.centre[0]) * ny + (tag.y - hub.centre[1]) * nx;
  return [-hub.half - along, hub.half - along];
}

/**
 * Where a robot at `from` aligning to `target` stops, `standoff` metres from it: `{ x, y, heading }`, facing
 * the target, or null without a standoff or with the robot on the target.
 *
 * On the line from the target through the robot, not on the tag's own normal: Catalyst X1's align turns to
 * face the tag and closes the range along the way it faces, with nothing sideways and no squaring up to
 * the tag's face (see alignToTag in X1.java), so it arrives on the line it started on. A place on the
 * tag's normal would be one the robot never goes to whenever it starts off to one side.
 */
export function standoffPose(from, target, standoff) {
  if (!(standoff > 0) || !Array.isArray(from) || !Array.isArray(target)) return null;
  const dx = from[0] - target[0];
  const dy = from[1] - target[1];
  const run = Math.hypot(dx, dy);
  if (!(run > 1e-6)) return null;
  return {
    x: target[0] + (dx / run) * standoff,
    y: target[1] + (dy / run) * standoff,
    heading: Math.atan2(-dy, -dx),
  };
}

/**
 * The words under the field tile's figures for an aim (see readAim), or "" for none.
 *
 * Aligning to a tag says which tag the robot says it sees and how far it still has to go to its standoff -
 * `tagId` and `standoff` as mechanisms.js readAlign reads them - and "Aligned" once it is there. Neither
 * number is worked out here: the tag and the standoff are the robot's, the distance to go is its published
 * distance less its standoff, and whatever it does not publish is a dash. A HUB, or anything else, says
 * what the shooter is doing and how far off the target is, as it always has. `from` is the robot, for
 * telling apart the two tags back to back on a trench arm.
 */
export function aimCaption(aim, { tagId = null, standoff = null, from = null } = {}) {
  if (!aim) return "";
  const { kind } = aimedAt(aim.target, { from, tagId });
  const locked = aim.state === "ALIGNED" || aim.state === "SOTF";
  const distance = Number.isFinite(aim.distance) ? aim.distance : null;
  if (kind === "tag") {
    if (locked) return "Aligned";
    const toGo = distance !== null && standoff > 0 ? Math.abs(distance - standoff).toFixed(2) : "—";
    return `Aligning to tag ${Number.isInteger(tagId) ? tagId : "—"} · ${toGo} m`;
  }
  const range = distance !== null ? ` · ${distance.toFixed(1)} m` : "";
  if (aim.state === "ALIGNING") return kind === "hub" ? "Aligning to the hub" : "Aligning";
  return aim.state === "ALIGNED" ? `Locked on${range}` : `Shooting on the move${range}`;
}
