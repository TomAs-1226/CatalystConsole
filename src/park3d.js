/* The park view.
 *
 * While the robot is disabled the console gives it the whole vehicle area: the robot, lit like a
 * product on a dark studio stage, turned by a finger. It is Tesla's Park screen for an FRC robot, and
 * like that screen it is not a data view. Nothing on the stage moves with telemetry; it shows what the
 * robot is - its size, its alliance, the team number on its bumpers - so a parked robot looks like
 * that team's machine rather than an empty tile, and so the callouts around it have something to point
 * at. The robot itself is robot3d.js's, the same model the field view drives.
 *
 * Going into Drive, the stage hands the robot to the field view the way Tesla's parked car shrinks into
 * its driving visualisation: the camera flies from the showroom angle to the exact shot the field tile
 * has of the robot, so the robot itself travels onto the tile, while the stage's floor and ground fade
 * and the board settles in behind it. Coming back into Park it flies the other way. See `fly`.
 *
 * Cost control, because this shares the laptop with the Driver Station:
 *   * Frames are drawn on demand. A still stage costs nothing: the loop stops the moment nothing is
 *     moving, and wakes for input, for a change of robot or alliance, and when the idle turn is due.
 *   * 30 fps at most on the stage, like the field; a flight, which lasts a second, draws every frame.
 *   * setActive(false) stops the loop outright. Nothing is drawn while the view is off screen.
 *   * No shadow maps and no post-processing. The floor, its grid and the contact shadow are one
 *     shader on one quad, and the studio reflections come from an environment rendered once.
 *   * Everything the scene allocates is released in dispose(), the GL context included.
 */

import * as THREE from "./vendor/three.module.min.js";
import { createRobotModel, studioEnvironment } from "./robot3d.js";

/* The robot's description is the model's business now; these stay exported from here for callers
   and tests that import them from the Park module. */
export { bumperNumber, normalizeRobot } from "./robot3d.js";

/* ---- camera maths ----
 *
 * Every decision about how the camera moves is made in the functions below, and none of them touch
 * THREE or the DOM, so `node --test` can pin the feel down without a GPU. The renderer further on only
 * applies what they return. */

/* How high the camera may look from, in radians above the horizon. The floor limit stays a few degrees
   up because a lens level with the ground sees the floor as a line and the robot as floating on it.
   The ceiling stops well short of straight down: over the top, a sideways drag spins the picture about
   its own centre, and that reads as the view breaking rather than the robot turning. */
export const ELEVATION_MIN = 0.06;
export const ELEVATION_MAX = 1.25;
export const ELEVATION_DEFAULT = 0.32;

/* The idle turn. Six seconds is long enough that it never starts while someone is reading the
   callouts after a drag, and seven degrees a second is a showroom turntable: visibly alive, slow
   enough that a callout can still be read while its part is on show. */
export const IDLE_AFTER_MS = 6000;
export const IDLE_RATE = (7 * Math.PI) / 180;
const IDLE_EASE_MS = 2500;

/* A flick's speed is read from this much of the drag's end. The last event alone reports a finger's
   jitter as speed; much more than this and a flick that slowed before letting go coasts as if it had
   not. */
export const RELEASE_WINDOW_MS = 80;
/* A turn and a half a second. Past that a coast is a blur, not a gesture anyone meant. */
export const SPIN_MAX = 3 * Math.PI;

/* Radians the stage turns for a drag across the canvas's shorter side. At the default framing this is
   about what keeps the near bumper under the finger, so the robot feels held rather than steered, and
   because it is measured against the canvas it feels the same full screen as in a small window. */
const DRAG_TURN = 3.4;
/* Vertical drags tilt at half the rate horizontal ones turn. The elevation range is barely a radian,
   and at full rate the small vertical wobble in any sideways flick would bob the camera. */
const TILT_RATIO = 0.5;

/* The robot fills this much of the canvas height at the default zoom, and never more than this much of
   its width, which is what keeps a narrow canvas from cropping the bumpers. */
const FILL_HEIGHT = 0.64;
const FILL_WIDTH = 0.8;

/**
 * A coasting velocity after `dtSeconds`, decaying by `perFrame60` per 60 Hz frame.
 *
 * Written as a power of the elapsed time rather than a multiply per frame, so a coast lasts as long at
 * the 30 fps this view draws at as it would at 60 or 144.
 */
export function dampVelocity(v, dtSeconds, perFrame60 = 0.92) {
  if (!Number.isFinite(v)) return 0;
  if (!(dtSeconds > 0)) return v;
  return v * Math.pow(perFrame60, dtSeconds * 60);
}

/**
 * How far a coast starting at `v` turns the stage during `dtSeconds`.
 *
 * This is the integral of dampVelocity across the step, not `v * dt`. Stepping position by the
 * velocity at the start of each frame overshoots by an amount that depends on the frame length, so a
 * flick would travel further on a slow laptop than on a fast one.
 */
export function coastAngle(v, dtSeconds, perFrame60 = 0.92) {
  if (!Number.isFinite(v) || !(dtSeconds > 0)) return 0;
  const rate = -60 * Math.log(perFrame60);
  if (!(rate > 0)) return v * dtSeconds;
  return (v * (1 - Math.exp(-rate * dtSeconds))) / rate;
}

/** An elevation held inside the range the camera may use. Garbage comes back as the default view. */
export function clampElevation(radians) {
  if (typeof radians !== "number" || Number.isNaN(radians)) return ELEVATION_DEFAULT;
  return Math.min(ELEVATION_MAX, Math.max(ELEVATION_MIN, radians));
}

/**
 * The angular velocity a drag was turning the stage at when it let go, in rad/s, signed like the
 * pointer's own movement (positive to the right).
 *
 * `samples` are `{ t, x }`: milliseconds and pixels, oldest first, ending with the release itself. The
 * speed is a least-squares slope over the last RELEASE_WINDOW_MS, which is what Compose's tracker and
 * motion.js's do, because the last two points alone report noise as speed. The one sample just before
 * the window is included as well: a slow machine may deliver a single event in 80 ms, and a window
 * holding one point would turn a real flick into no flick. A finger that stopped before lifting shows
 * up as the release sample sitting where the last move left it, so it correctly measures zero.
 */
export function releaseVelocity(samples, radPerPx = DRAG_TURN / 800) {
  if (!Array.isArray(samples) || samples.length < 2) return 0;
  const last = samples[samples.length - 1];
  let first = samples.length - 1;
  while (first > 0 && last.t - samples[first].t < RELEASE_WINDOW_MS) first--;

  const t0 = samples[first].t;
  let n = 0, st = 0, sx = 0, stt = 0, stx = 0;
  for (let i = first; i < samples.length; i++) {
    const t = samples[i].t - t0;
    const x = samples[i].x;
    n++; st += t; sx += x; stt += t * t; stx += t * x;
  }
  const det = n * stt - st * st;
  if (!(det > 0)) return 0;
  const pxPerMs = (n * stx - st * sx) / det;
  const v = pxPerMs * 1000 * radPerPx;
  if (!Number.isFinite(v)) return 0;
  return Math.max(-SPIN_MAX, Math.min(SPIN_MAX, v));
}

/**
 * The idle turn's speed in rad/s after `idleMs` without interaction.
 *
 * Zero until IDLE_AFTER_MS, then eased up to IDLE_RATE along a smoothstep, so the stage starts from
 * rest with no jolt of acceleration: a turntable that was switched on, not one that was already
 * spinning. Always zero under reduced motion.
 */
export function idleSpin(idleMs, reduced = false) {
  if (reduced || !(idleMs >= IDLE_AFTER_MS)) return 0;
  const u = Math.min(1, (idleMs - IDLE_AFTER_MS) / IDLE_EASE_MS);
  return IDLE_RATE * u * u * (3 - 2 * u);
}

/**
 * Where a robot lands on screen, in normalised device units (the canvas is 2 across), with the camera
 * `distance` from the point `lookY` metres above the floor at the robot's centre, looking down at
 * `elevation`.
 *
 * The robot is described as `parts`, upright cylinders `{ radius, bottom, top }` in metres above the
 * floor, all centred on the robot. One cylinder round the whole robot is simple and wrong: it puts the
 * top of a central superstructure out at the bumpers' far edge, so the robot comes out smaller than
 * asked, by more the taller and narrower that superstructure is. A wide low cylinder for the bumpers
 * and a narrow tall one for what stands on them is still the same from every side, so the framing
 * holds steady while the stage turns.
 *
 * `vertical` is half the height covered, `side` half the width, and `centre` how far the middle sits
 * above the middle of the canvas. All three are worked out under perspective rather than estimated
 * orthographically: at these distances the near bumper is drawn visibly larger than the far one, and an
 * orthographic centre sits the robot low.
 */
export function silhouette(parts, lookY, elevation, fovY, aspect, distance) {
  const tan = Math.tan(fovY / 2);
  const wide = aspect > 0 ? aspect : 1;
  const c = Math.cos(elevation);
  const s = Math.sin(elevation);
  let top = -Infinity;
  let bottom = Infinity;
  let side = 0;
  for (const { radius, bottom: from, top: to } of parts) {
    for (const y of [from - lookY, to - lookY]) {
      /* In the camera's vertical plane a cylinder is a rectangle, and its extremes on screen are the
         rectangle's corners: u runs toward the camera, y up from the point looked at. */
      for (const u of [-radius, radius]) {
        const depth = distance - (u * c + y * s);
        const ndc = (y * c - u * s) / (depth * tan);
        if (ndc > top) top = ndc;
        if (ndc < bottom) bottom = ndc;
      }
      /* Across the screen, a rim is widest where a sight line grazes it. */
      const rim = distance - y * s;
      const graze = Math.sqrt(Math.max(rim * rim - radius * radius * c * c, 1e-9));
      side = Math.max(side, radius / (graze * tan * wide));
    }
  }
  return { vertical: (top - bottom) / 2, side, centre: (top + bottom) / 2 };
}

/**
 * How far the camera stands from the point it looks at for the robot to fill `fill` of the canvas
 * height without covering more than `fillWidth` of its width.
 *
 * Solved by bisection on silhouette(), which shrinks steadily with distance. A wide canvas is limited
 * by height and a narrow one by width, so the same robot is framed well in a letterbox and in a
 * portrait tile alike.
 */
export function fitDistance(parts, lookY, elevation, fovY, aspect, fill = FILL_HEIGHT, fillWidth = FILL_WIDTH) {
  let near = closest(parts, lookY);
  let far = near + 500;
  for (let i = 0; i < 48; i++) {
    const mid = (near + far) / 2;
    const seen = silhouette(parts, lookY, elevation, fovY, aspect, mid);
    if (seen.vertical > fill || seen.side > fillWidth) near = mid;
    else far = mid;
  }
  return far;
}

/** The nearest the camera may stand to the point it looks at without any part reaching the lens. */
export function closest(parts, lookY) {
  let reach = 0;
  for (const { radius, bottom, top } of parts) {
    reach = Math.max(reach, Math.hypot(radius, Math.max(Math.abs(top - lookY), Math.abs(bottom - lookY))));
  }
  return reach + 0.05;
}

/* ---- callout layout ---- */

/**
 * Where the callouts' labels go and where their hairlines run, in canvas pixels.
 *
 * Tesla labels a parked car beside it, never on it, and here there is a plainer reason too: a white
 * word over a silver frame cannot be read. So a label goes out past the robot's edge on the side its
 * part is on, level with the part, and a hairline joins the two. A part named in `opts.above` - the top
 * of the superstructure - is labelled over the robot instead. Labels on one side keep their order and
 * are pushed apart so they never overlap, and each side keeps to its band of the canvas, clear of
 * whatever else stands in that column. A label with no room on its own side crosses to the other one
 * when there is more room there.
 *
 * `points`  { name: { x, y, visible } }, as anchors() returns them
 * `box`     { left, top, right, bottom }, the robot on screen, as bounds() returns it
 * `sizes`   { name: { w, h } }, each label's size
 * `area`    { w, h, left: [top, bottom], right: [top, bottom], top }: the canvas, the two side bands
 *           and the highest a label over the robot may sit
 *
 * Returns { name: { side, x, y, line: [x1, y1, x2, y2] } } for each label to show: `x` and `y` are the
 * label's top-left corner, and the line runs from beside the label to the part.
 */
export function layoutCallouts(points, box, sizes, area, opts = {}) {
  const out = {};
  if (!points || !box || !sizes || !area || !(area.w > 0) || !(area.h > 0)) return out;
  const gap = opts.gap ?? 44;
  const spacing = opts.spacing ?? 14;
  const margin = opts.margin ?? 24;
  const above = new Set(opts.above ?? ["top"]);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const middle = (box.left + box.right) / 2;
  const sides = { left: [], right: [] };

  for (const [name, p] of Object.entries(points)) {
    const size = sizes[name];
    if (!p || !p.visible || !size || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const { w, h } = size;
    if (above.has(name)) {
      const x = clamp(p.x - w / 2, margin, Math.max(margin, area.w - margin - w));
      const y = Math.max(area.top ?? 0, box.top - gap - h);
      out[name] = { side: "top", x, y, line: [clamp(p.x, x + 6, x + w - 6), y + h + 6, p.x, p.y] };
      continue;
    }
    const room = {
      left: box.left - gap - w - margin,
      right: area.w - margin - (box.right + gap + w),
    };
    let side = p.x < middle ? "left" : "right";
    const other = side === "left" ? "right" : "left";
    if (room[side] < 0 && room[other] > room[side]) side = other;
    sides[side].push({ name, p, w, h, y: p.y - h / 2 });
  }

  for (const side of ["left", "right"]) {
    const list = sides[side].sort((a, b) => a.y - b.y);
    const band = area[side] ?? [0, area.h];
    /* Down the band pushing each label below the one before, then back up it pulling any that ran off
       the bottom. A band too short for every label keeps the top ones where they were asked for. */
    let floor = band[0];
    for (const item of list) {
      item.y = Math.max(item.y, floor);
      floor = item.y + item.h + spacing;
    }
    let ceiling = band[1];
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      item.y = Math.max(band[0], Math.min(item.y, ceiling - item.h));
      ceiling = item.y - spacing;
    }
    for (const item of list) {
      const x = side === "left"
        ? Math.max(margin, box.left - gap - item.w)
        : Math.min(area.w - margin - item.w, box.right + gap);
      const edge = side === "left" ? x + item.w + 10 : x - 10;
      out[item.name] = { side, x, y: item.y, line: [edge, item.y + item.h / 2, item.p.x, item.p.y] };
    }
  }
  return out;
}

/* ---- shots ----
 *
 * A shot is a camera on the robot described in the robot's own frame, so any view can hand one to any
 * other whatever it has done with the robot: `eye` and `look` are [x, y, z] with x toward the robot's
 * front, y up and z toward its right, the floor under its centre at the origin; `fov` is the vertical
 * field of view in degrees; `rect` is the rectangle of the canvas, in CSS pixels, that the shot fills.
 * The Park stage flies between shots to hand the robot to the field view and to take it back. */

/**
 * A point turned about the vertical axis by `angle` radians, the way three.js turns an object whose
 * rotation.y is `angle`: the robot's frame to the stage's when `angle` is the stage's turn, and back
 * again when it is minus that.
 */
export function turnY([x, y, z], angle) {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [x * c + z * s, y, -x * s + z * c];
}

/**
 * The CSS-style cubic Bézier timing function through (x1, y1) and (x2, y2), solved for x by Newton's
 * method with a bisection fallback, the way browsers evaluate `cubic-bezier()`.
 */
export function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t) => ((ay * t + by) * t + cy) * t;
  const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (!(x > 0)) return 0;
    if (!(x < 1)) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = slopeX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

/* The flight's timing. It leaves gently, is at full speed a fifth of the way in, and lands softly with
   the last visible movement arriving at the very end, so the view that takes the robot over does so
   the moment the robot comes to rest. A critically damped spring was used first and read badly in both
   ways a spring can: it leaves with a jolt, and it creeps through its last forty percent, so the robot
   seemed to stop and then, a quarter of a second later, to jump as the other view took over. */
const FLIGHT_CURVE = cubicBezier(0.3, 0, 0.12, 1);
export function flightEase(t) {
  if (!(t > 0)) return 0;
  if (!(t < 1)) return 1;
  return FLIGHT_CURVE(t);
}

/** Hermite smoothstep of `x` from `a` to `b`. */
function smooth(a, b, x) {
  const u = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return u * u * (3 - 2 * u);
}

/**
 * The shot `t` of the way from `a` to `b`.
 *
 * The camera does not travel in a straight line. It swings round what it is looking at: the look point
 * moves straight, and the eye keeps to a sphere about it whose radius changes geometrically, whose
 * compass bearing takes the short way round and whose elevation changes evenly. Straight-line motion
 * would cut through the robot on a half turn and change the apparent size unevenly; the swing is what
 * a camera operator does. The field of view and the rectangle interpolate evenly.
 */
export function mixShots(a, b, t) {
  const u = Math.min(1, Math.max(0, t));
  const mix = (p, q) => p + (q - p) * u;
  const look = [mix(a.look[0], b.look[0]), mix(a.look[1], b.look[1]), mix(a.look[2], b.look[2])];
  const polar = (shot) => {
    const dx = shot.eye[0] - shot.look[0];
    const dy = shot.eye[1] - shot.look[1];
    const dz = shot.eye[2] - shot.look[2];
    const r = Math.max(1e-6, Math.hypot(dx, dy, dz));
    return { r, bearing: Math.atan2(dx, dz), elevation: Math.asin(Math.max(-1, Math.min(1, dy / r))) };
  };
  const pa = polar(a);
  const pb = polar(b);
  let turn = (pb.bearing - pa.bearing) % (2 * Math.PI);
  if (turn > Math.PI) turn -= 2 * Math.PI;
  if (turn < -Math.PI) turn += 2 * Math.PI;
  const bearing = pa.bearing + turn * u;
  const elevation = mix(pa.elevation, pb.elevation);
  const r = Math.exp(mix(Math.log(pa.r), Math.log(pb.r)));
  const flat = Math.cos(elevation) * r;
  return {
    eye: [look[0] + Math.sin(bearing) * flat, look[1] + Math.sin(elevation) * r, look[2] + Math.cos(bearing) * flat],
    look,
    fov: mix(a.fov, b.fov),
    rect: { x: mix(a.rect.x, b.rect.x), y: mix(a.rect.y, b.rect.y), w: mix(a.rect.w, b.rect.w), h: mix(a.rect.h, b.rect.h) },
  };
}

/* ---- the glide ----
 *
 * mixShots moves the camera sensibly and the robot badly. Swinging the eye round a look point that is
 * itself travelling - the field view looks three metres ahead of the robot, the stage looks at its
 * middle - sends the robot's image off on a detour: into Drive it first ran away from the field tile it
 * was flying to and then hooked back, and into Park it overshot the middle of the screen and drifted
 * back, with its speed stalling and surging on the way. So a flight is steered by what the eye follows,
 * the robot's image, and the camera is solved for each frame to produce it. */

const wrapAngle = (x) => {
  const y = (x + Math.PI) % (2 * Math.PI);
  return (y < 0 ? y + 2 * Math.PI : y) - Math.PI;
};
const direction = (bearing, elevation) => [
  Math.sin(bearing) * Math.cos(elevation), Math.sin(elevation), Math.cos(bearing) * Math.cos(elevation),
];

/** Where `point` is seen by a camera at `eye` facing `forward` (unit, no roll) with a focal length of
 *  `focal` pixels: pixels right of and below the middle of its frame, and how far in front of it. */
function seenFrom(eye, forward, focal, point) {
  const rx = -forward[2];
  const rz = forward[0];
  const rl = Math.hypot(rx, rz) || 1;
  const right = [rx / rl, 0, rz / rl];
  const up = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const d = [point[0] - eye[0], point[1] - eye[1], point[2] - eye[2]];
  const depth = d[0] * forward[0] + d[1] * forward[1] + d[2] * forward[2];
  return {
    depth,
    x: (focal * (d[0] * right[0] + d[2] * right[2])) / depth,
    y: (-focal * (d[0] * up[0] + d[1] * up[1] + d[2] * up[2])) / depth,
  };
}

/** A shot as the glide reads it: where the camera is round `anchor` and where it points, and where the
 *  anchor lands on the canvas and how large. Null when the anchor is not in front of the camera. */
function describeShot(shot, anchor) {
  const fx = shot.look[0] - shot.eye[0];
  const fy = shot.look[1] - shot.eye[1];
  const fz = shot.look[2] - shot.eye[2];
  const fl = Math.hypot(fx, fy, fz);
  const ex = shot.eye[0] - anchor[0];
  const ey = shot.eye[1] - anchor[1];
  const ez = shot.eye[2] - anchor[2];
  const el = Math.hypot(ex, ey, ez);
  if (!(fl > 1e-9) || !(el > 1e-9)) return null;
  const forward = [fx / fl, fy / fl, fz / fl];
  const focal = shot.rect.h / (2 * Math.tan((shot.fov * Math.PI) / 360));
  const seen = seenFrom(shot.eye, forward, focal, anchor);
  if (!(seen.depth > 1e-3)) return null;
  const bearing = Math.atan2(ex, ez);
  const elevation = Math.asin(Math.max(-1, Math.min(1, ey / el)));
  return {
    bearing,
    elevation,
    /* Where the lens points, as an offset from pointing straight at the anchor. */
    aimBearing: wrapAngle(Math.atan2(forward[0], forward[2]) - (bearing + Math.PI)),
    aimElevation: Math.asin(Math.max(-1, Math.min(1, forward[1]))) + elevation,
    scale: focal / seen.depth,
    x: shot.rect.x + shot.rect.w / 2 + seen.x,
    y: shot.rect.y + shot.rect.h / 2 + seen.y,
  };
}

/**
 * The shot `t` of the way from `a` to `b`, steered by the image of `anchor` - the middle of the robot,
 * in the robot's frame - rather than by the camera.
 *
 * The anchor's image travels in a straight line across the canvas, and its size changes geometrically,
 * so the robot shrinks or grows at an even rate as it goes. The camera comes round it the short way,
 * its elevation changes evenly, and where the lens points relative to the robot eases between the two
 * shots' framings. Every frame's camera is solved from those, so both ends are reproduced exactly. When
 * either shot does not have the anchor in front of it the glide has nothing to steer by, and it falls
 * back to mixShots.
 */
export function glideShots(a, b, t, anchor = [0, 0, 0]) {
  const u = Math.min(1, Math.max(0, t));
  const from = describeShot(a, anchor);
  const to = describeShot(b, anchor);
  if (!from || !to) return mixShots(a, b, u);
  const mix = (p, q) => p + (q - p) * u;
  const even = (p, q) => Math.exp(mix(Math.log(p), Math.log(q)));

  const bearing = from.bearing + wrapAngle(to.bearing - from.bearing) * u;
  const elevation = mix(from.elevation, to.elevation);
  const out = direction(bearing, elevation);
  const forward = direction(
    bearing + Math.PI + mix(from.aimBearing, to.aimBearing),
    -elevation + mix(from.aimElevation, to.aimElevation)
  );

  const fov = mix(a.fov, b.fov);
  const w = even(a.rect.w, b.rect.w);
  const h = even(a.rect.h, b.rect.h);
  const focal = h / (2 * Math.tan((fov * Math.PI) / 360));
  /* The depth that draws the anchor at this frame's size, and the distance out along the sight line
     that puts it at that depth for where the lens is pointing. */
  const depth = focal / even(from.scale, to.scale);
  const along = Math.max(0.05, -(forward[0] * out[0] + forward[1] * out[1] + forward[2] * out[2]));
  const distance = depth / along;
  const eye = [anchor[0] + out[0] * distance, anchor[1] + out[1] * distance, anchor[2] + out[2] * distance];
  /* The frame is then slid so the anchor lands on its point of the line. */
  const seen = seenFrom(eye, forward, focal, anchor);
  return {
    eye,
    look: [eye[0] + forward[0] * distance, eye[1] + forward[1] * distance, eye[2] + forward[2] * distance],
    fov,
    rect: { x: mix(from.x, to.x) - w / 2 - seen.x, y: mix(from.y, to.y) - h / 2 - seen.y, w, h },
  };
}

/* ---- the scene ---- */

const FRAME_MS = 1000 / 30;

/* A long lens, as a product is photographed. A wide one bulges the near bumper toward the viewer. */
const STAGE_FOV = 30;

/* The stage's floor stops here, metres from the robot's centre. By then its fade has reached nothing,
   so the quad's edge is never seen however low the camera goes. */
const FLOOR_RADIUS = 6;

/* Where the camera starts: off the front-left corner, 38 degrees round from the nose, the angle a car
   is photographed from. The stage turns rather than the camera (see placeCamera), so this is a
   rotation of the stage that puts that corner toward the lens. */
const YAW_DEFAULT = -(Math.PI / 2 + 0.66);
const ZOOM_MIN = 0.62;
const ZOOM_MAX = 1.8;
const ZOOM_EASE_S = 0.09;
const RESET_MS = 700;
/* When a finger lands on a turning stage the idle turn stops within about a third of a second: fast
   enough to feel caught, slow enough not to jolt. */
const SPIN_CATCH_S = 0.1;
const INERTIA_REST = 0.01;
/* How far past edge-on an anchor's surface may turn and still count as visible. Slightly past, so a
   callout does not blink off the instant its face is exactly side-on. */
const FACING_MIN = -0.1;

const FLOOR_VERTEX = /* glsl */ `
  varying vec2 vPlan;
  void main() {
    // The plane lies in its own xy before the mesh turns it flat, so xy here is the floor in metres:
    // x toward the robot's front, y toward its left.
    vPlan = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FLOOR_FRAGMENT = /* glsl */ `
  uniform vec3 uFloor;
  uniform vec3 uGrid;
  uniform float uRadius;
  uniform float uCell;
  uniform float uLine;
  uniform vec2 uFootprint;
  uniform float uCorner;
  uniform float uOpacity;
  varying vec2 vPlan;

  // Grid lines with a constant world width that never alias. Where a line would be thinner than a
  // pixel it is drawn one pixel wide and dimmed to the same coverage, and where the cells themselves
  // shrink below a pixel the grid fades to its average brightness instead of shimmering. This is Ben
  // Golus's construction, and it is what keeps the far floor calm at a grazing camera angle.
  float gridLines(vec2 plan, float pitch, float width) {
    vec2 uv = plan / pitch;
    vec2 ddx = dFdx(uv);
    vec2 ddy = dFdy(uv);
    vec2 footprint = vec2(length(vec2(ddx.x, ddy.x)), length(vec2(ddx.y, ddy.y)));
    vec2 wanted = vec2(width / pitch);
    vec2 drawn = clamp(wanted, footprint, vec2(0.5));
    vec2 aa = footprint * 1.5;
    vec2 fromLine = 1.0 - abs(fract(uv) * 2.0 - 1.0);
    vec2 cover = smoothstep(drawn + aa, drawn - aa, fromLine);
    cover *= clamp(wanted / drawn, 0.0, 1.0);
    cover = mix(cover, wanted, clamp(footprint * 2.0 - 1.0, 0.0, 1.0));
    return mix(cover.x, 1.0, cover.y);
  }

  float roundedRect(vec2 p, vec2 halfSize, float corner) {
    vec2 q = abs(p) - halfSize + corner;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - corner;
  }

  void main() {
    float reach = clamp(length(vPlan) / uRadius, 0.0, 1.0);

    // The pool of light the robot stands in, falling away quickly and then lingering, the way a
    // spotlight's edge does.
    float light = pow(1.0 - reach, 3.5);
    vec3 colour = uFloor * light;

    // The lines are lit by the same pool as the floor, so they fade with it instead of glowing on
    // their own out in the dark, and they give out before the floor does, so they read as markings
    // around the robot rather than a lattice running off to the horizon.
    float grid = max(gridLines(vPlan, uCell, uLine) * 0.5, gridLines(vPlan, uCell * 4.0, uLine * 1.4));
    float gridLight = pow(1.0 - reach, 2.0) * (1.0 - smoothstep(0.05, 0.5, reach));
    colour = mix(colour, uGrid * gridLight, grid * 0.8);

    // The contact shadow: dense right under the bumpers, where no light reaches, and a wide soft
    // skirt around them. It darkens the grid lines too, which is most of what makes the robot sit on
    // the floor instead of hovering over it.
    float d = roundedRect(vPlan, uFootprint, uCorner);
    float shade = max((1.0 - smoothstep(-0.08, 0.06, d)) * 0.95, (1.0 - smoothstep(-0.12, 0.8, d)) * 0.7);
    colour *= 1.0 - shade;

    // uOpacity is the whole floor fading, when a flight hands the robot to a view with its own ground.
    gl_FragColor = vec4(colour, (1.0 - smoothstep(0.35, 0.9, reach)) * uOpacity);
    #include <colorspace_fragment>

    // A dark gradient this wide bands visibly in eight bits. A pixel of noise breaks the bands up and
    // costs nothing.
    float grain = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    gl_FragColor.rgb += (grain - 0.5) / 255.0;
  }
`;

/* ---- the view ---- */

/**
 * Create the park view on `canvas`.
 *
 * It starts inactive and draws nothing until setActive(true). `opts.reducedMotion` switches off the
 * idle turn, the coast after a flick, the animated reset and the flights; when it is not given, the
 * system's prefers-reduced-motion setting decides.
 */
export function createPark(canvas, opts) {
  const reduced =
    typeof opts?.reducedMotion === "boolean"
      ? opts.reducedMotion
      : Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

  /* The floor's two tokens. The robot reads its own (see robot3d.js). */
  const style = getComputedStyle(document.documentElement);
  const token = (name, fallback) => {
    const value = style.getPropertyValue(name).trim();
    if (value) {
      const colour = new THREE.Color(NaN, NaN, NaN).setStyle(value);
      if (Number.isFinite(colour.r) && Number.isFinite(colour.g) && Number.isFinite(colour.b)) return colour;
    }
    return new THREE.Color(fallback);
  };
  const FLOOR = token("--park-floor", "#2c2c2e");
  const GRID = token("--park-grid", "#48484a");

  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  /* Transparent, not painted black: the floor fades out by alpha, so the stage melts into whatever the
     page behind it is instead of ending at the edge of a slightly different black rectangle. It is
     also what lets a flight hand the robot to the field view: once the floor has faded, what shows
     round the robot is the board underneath. */
  renderer.setClearColor(0x000000, 0);
  /* Khronos' neutral curve rather than ACES: it rolls off the softbox highlights on the aluminium
     without pulling alliance red toward orange, which ACES does. */
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(STAGE_FOV, 16 / 9, 0.05, 80);

  const owned = new Set();
  const own = (thing) => {
    owned.add(thing);
    return thing;
  };

  const model = createRobotModel({ maxAnisotropy: renderer.capabilities.getMaxAnisotropy() });
  /* The studio lights come with the model (see robot3d.js), so the field view lights the robot with the
     same rig. On the stage they face the lens, which never moves: the stage turns beneath them. */
  scene.add(model.lights);

  /* The stage: floor and robot together. Everything the viewer turns is under this one node. */
  const stage = new THREE.Group();
  scene.add(stage);

  const floorUniforms = {
    uFloor: { value: FLOOR },
    uGrid: { value: GRID },
    uRadius: { value: FLOOR_RADIUS },
    uCell: { value: 0.25 },
    uLine: { value: 0.004 },
    uFootprint: { value: new THREE.Vector2(0.45, 0.45) },
    uCorner: { value: 0.1 },
    uOpacity: { value: 1 },
  };
  const floor = new THREE.Mesh(
    own(new THREE.PlaneGeometry(FLOOR_RADIUS * 2, FLOOR_RADIUS * 2)),
    own(new THREE.ShaderMaterial({
      uniforms: floorUniforms,
      vertexShader: FLOOR_VERTEX,
      fragmentShader: FLOOR_FRAGMENT,
      transparent: true,
      depthWrite: false,
      /* The floor is a designed gradient, not lit HDR. The neutral curve's toe subtracts nearly all of
         the darkest channel from a dark colour, which would crush this floor to black and blow its
         faintest tint up into navy. Its tokens land on screen as written instead. */
      toneMapped: false,
    }))
  );
  floor.rotation.x = -Math.PI / 2;
  /* First of the see-through things, so the smoked hood always blends over the floor and never under
     it, whichever the depth sort would have put nearer. */
  floor.renderOrder = -1;
  stage.add(floor);
  stage.add(model.root);

  let parts = [];
  let anchorDefs = null;
  let lookY = 0;

  function applyRobot(spec) {
    if (!model.setSpec(spec)) return;
    syncModel();
    requestRender();
  }

  /* Frame and shadow the robot the model is now: after a new spec, and when the team's CAD finishes
     loading and replaces the drawn robot. */
  function syncModel() {
    if (!model.spec) return;
    parts = model.parts;
    anchorDefs = model.anchors;
    /* Looking at the middle of the robot's height. The lens shift does the fine centring, so this only
       has to put the camera's axis through the robot. */
    lookY = Math.max(...parts.map((part) => part.top)) / 2;
    floorUniforms.uFootprint.value.set(model.spec.bumperLength / 2, model.spec.bumperWidth / 2);
    floorUniforms.uCorner.value = model.corner;
  }
  model.onChange(() => {
    syncModel();
    requestRender();
  });

  /* ---- camera state ----
   *
   * On the stage the camera never swings round. The stage turns under a fixed camera and fixed lights,
   * the way a car turns on a showroom turntable, so the key light and the rim stay where they flatter
   * the model from every side instead of ending up behind it half way round.
   *
   * A flight is the exception. It moves the camera itself, through shots described in the robot's own
   * frame (see glideShots), from the stage to wherever another view is looking at the robot or back, with
   * the stage's turn frozen for the length of it. */

  let yaw = YAW_DEFAULT;
  let elevation = ELEVATION_DEFAULT;
  let zoom = 1;
  let zoomTarget = 1;
  let inertia = 0;          // rad/s, left over from a flick
  let spin = 0;             // rad/s, the idle turn
  let lastInteraction = performance.now();
  let resetAnim = null;
  const lookAt = new THREE.Vector3();

  let flight = null;        // { from, to, toStage, floor, start, duration, onProgress, resolve, shot }
  let held = null;          // the shot a flight landed on, kept on screen until the next flight
  let frozenYaw = null;     // the stage's turn while a flight or a held shot is on screen

  /** The stage's own framing at a given turn, tilt and zoom, as a shot in the robot's frame. */
  function stageShot(yawAt, elevationAt, zoomAt) {
    const fovY = THREE.MathUtils.degToRad(STAGE_FOV);
    const aspect = sized.w > 0 && sized.h > 0 ? sized.w / sized.h : camera.aspect;
    const fit = fitDistance(parts, lookY, elevationAt, fovY, aspect);
    /* Zoomed all the way in, never inside the robot. */
    const distance = Math.max(fit * zoomAt, closest(parts, lookY) + 0.2);
    /* Perspective draws the near bumper lower than the far one rises, so a robot the camera looks
       straight at sits below the middle of the canvas. A lens shift of exactly that much re-centres it
       without tilting the camera, which would change the angle the robot is seen from. */
    const { centre } = silhouette(parts, lookY, elevationAt, fovY, aspect, distance);
    return {
      eye: turnY([0, lookY + Math.sin(elevationAt) * distance, Math.cos(elevationAt) * distance], -yawAt),
      look: turnY([0, lookY, 0], -yawAt),
      fov: STAGE_FOV,
      rect: { x: 0, y: (centre * sized.h) / 2, w: sized.w, h: sized.h },
    };
  }

  /** Point the camera along `shot`, with the stage turned to `yawAt`. */
  function applyShot(shot, yawAt) {
    stage.rotation.y = yawAt;
    const w = Math.max(1, shot.rect.w);
    const h = Math.max(1, shot.rect.h);
    camera.fov = shot.fov;
    camera.aspect = w / h;
    const eye = turnY(shot.eye, yawAt);
    const look = turnY(shot.look, yawAt);
    camera.position.set(eye[0], eye[1], eye[2]);
    lookAt.set(look[0], look[1], look[2]);
    camera.lookAt(lookAt);
    /* The studio faces the lens. On the stage that is always the same way; in flight it comes round with
       the camera, as it does behind the field view's, so the two agree on the frame they hand over. */
    model.aim(Math.atan2(eye[0] - look[0], eye[2] - look[2]));
    if (sized.w > 0 && sized.h > 0) {
      /* The shot's rectangle becomes the frame the lens is drawn for, and the canvas a window onto it:
         the robot lands inside the rectangle exactly as a camera that size would have drawn it. */
      camera.setViewOffset(w, h, -shot.rect.x, -shot.rect.y, sized.w, sized.h);
    } else {
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
    stage.updateMatrixWorld();
  }

  function placeCamera() {
    if (flight) applyShot(flight.shot || flight.from, frozenYaw);
    else if (held) applyShot(held, frozenYaw);
    else applyShot(stageShot(yaw, elevation, zoom), yaw);
  }

  function currentShot() {
    if (flight) return flight.shot || flight.from;
    if (held) return held;
    return stageShot(yaw, elevation, zoom);
  }

  /* ---- sizing ---- */

  let sized = { w: 0, h: 0, dpr: 0 };
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    if (w === sized.w && h === sized.h && dpr === sized.dpr) return false;
    sized = { w, h, dpr };
    if (w === 0 || h === 0) return false;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    return true;
  }

  const observer = new ResizeObserver(() => {
    if (resize()) requestRender();
  });
  observer.observe(canvas);

  /* ---- loop ----
   *
   * On demand. requestRender() asks for one frame; a frame that finds something still moving asks for
   * the next, and one that finds nothing moving lets the loop stop. */

  let active = false;
  let disposed = false;
  let raf = 0;
  let wakeTimer = 0;
  let lastFrame = -Infinity;
  let asleep = true;
  let environment = null;
  const frameListeners = new Set();

  function requestRender() {
    if (!active || disposed || raf) return;
    raf = requestAnimationFrame(tick);
  }

  /* While the loop sleeps nothing is drawn, and the idle turn is not a frame anyone requested, so a
     timer wakes the loop when the turn is due. */
  function sleep(now) {
    asleep = true;
    clearTimeout(wakeTimer);
    wakeTimer = 0;
    if (reduced || pointers.size || held) return;
    const due = IDLE_AFTER_MS - (now - lastInteraction);
    if (due > 0) {
      wakeTimer = setTimeout(() => {
        wakeTimer = 0;
        requestRender();
      }, due + 20);
    }
  }

  function tick(now) {
    raf = 0;
    if (!active || disposed) return;
    /* 30 fps on the stage, like the field, with two milliseconds of slack: at 60 Hz the second frame
       lands a hair under 33.3 ms often enough that a strict test drops to 20 fps. A flight draws every
       frame the display offers, whatever its rate: a camera move judders exactly where the eye is
       following it, and capping it at 60 left a 144 Hz display drawing it at an uneven 48. */
    if (!flight && now - lastFrame < FRAME_MS - 2) {
      raf = requestAnimationFrame(tick);
      return;
    }
    /* Waking from sleep, the gap since the last frame is time nothing was moving, so the first step
       is one frame long. Stepping a fresh flick by the whole pause would jump it round. */
    const dt = asleep ? FRAME_MS / 1000 : Math.min(now - lastFrame, 100) / 1000;
    lastFrame = now;
    asleep = false;

    resize();
    if (!sized.w || !sized.h) {
      /* Nothing to draw into. The observer asks again when the canvas has a size. */
      sleep(now);
      return;
    }
    const moving = step(dt, now);
    draw();
    if (moving) raf = requestAnimationFrame(tick);
    else sleep(now);
  }

  function step(dt, now) {
    let moving = false;

    if (flight) {
      if (flight.start === null) flight.start = now;
      /* The view the robot is flying to draws its frame first, in the same animation frame, so the shot
         read from it next is the one on its canvas right now. */
      if (flight.sync) {
        try {
          flight.sync(now);
        } catch (err) {
          console.error("park flight sync failed", err);
        }
      }
      if (flight.target) {
        /* A live destination: the field view's camera keeps following a robot that is driving, so the
           shot to land on is read again every frame rather than once at take-off. */
        let next = null;
        try {
          next = normalizeShot(flight.target());
        } catch (err) {
          console.error("park flight target failed", err);
        }
        if (next) flight.to = next;
      }
      const raw = flight.duration > 0 ? Math.min(1, Math.max(0, (now - flight.start) / flight.duration)) : 1;
      const eased = flightEase(raw);
      flight.shot = glideShots(flight.from, flight.to, eased, [0, lookY, 0]);
      const [from, to] = flight.floor;
      /* The floor goes early on the way out, so the field shows round the robot for most of the move,
         and comes late on the way back, once the robot is clear of the tile. */
      const fade = to < from ? smooth(0, 0.4, eased) : smooth(0.45, 0.95, eased);
      floorUniforms.uOpacity.value = from + (to - from) * fade;
      try {
        flight.onProgress?.(eased, raw, flight.shot);
      } catch (err) {
        console.error("park flight listener failed", err);
      }
      if (raw < 1) moving = true;
      else finishFlight(true);
    } else if (held) {
      /* Holding a landed shot: nothing moves on its own. */
    } else if (resetAnim) {
      const u = Math.min(1, Math.max(0, (now - resetAnim.start) / RESET_MS));
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      yaw = resetAnim.yaw[0] + (resetAnim.yaw[1] - resetAnim.yaw[0]) * e;
      elevation = resetAnim.elevation[0] + (resetAnim.elevation[1] - resetAnim.elevation[0]) * e;
      zoom = zoomTarget = resetAnim.zoom[0] + (resetAnim.zoom[1] - resetAnim.zoom[0]) * e;
      lastInteraction = now;
      if (u < 1) moving = true;
      else resetAnim = null;
    } else {
      if (inertia !== 0) {
        yaw += coastAngle(inertia, dt);
        inertia = dampVelocity(inertia, dt);
        if (Math.abs(inertia) < INERTIA_REST) inertia = 0;
        else moving = true;
      }

      const idle = pointers.size ? 0 : now - lastInteraction;
      const want = idleSpin(idle, reduced);
      /* Up, the turn follows idleSpin's own ease. Down, it is caught: a hand on the stage stops it
         quickly rather than at the pace it wound up. */
      spin = want >= spin ? want : want + (spin - want) * Math.exp(-dt / SPIN_CATCH_S);
      if (spin < 1e-4 && want === 0) spin = 0;
      if (spin > 0) {
        yaw += spin * dt;
        moving = true;
      }
      /* The turn is due but idleSpin starts from zero, so the first frame past the threshold has no
         speed yet. Without this the loop would go back to sleep right on the threshold. */
      if (!reduced && idle >= IDLE_AFTER_MS) moving = true;

      if (zoom !== zoomTarget) {
        zoom += (zoomTarget - zoom) * (1 - Math.exp(-dt / ZOOM_EASE_S));
        if (Math.abs(zoomTarget - zoom) < 1e-4) zoom = zoomTarget;
        else moving = true;
      }
    }

    if (model.step(now)) moving = true;
    return moving;
  }

  function draw() {
    if (!environment) {
      /* Built on the first frame rather than at creation, so a park that is created and never shown
         never costs the GPU anything. */
      environment = studioEnvironment(renderer);
      model.setEnvironment(environment.texture);
    }
    placeCamera();
    renderer.render(scene, camera);
    for (const fn of frameListeners) {
      try {
        fn();
      } catch (err) {
        /* A broken callout must not stop the stage from drawing. */
        console.error("park frame listener failed", err);
      }
    }
  }

  /* ---- flights ---- */

  function finishFlight(completed) {
    const done = flight;
    if (!done) return;
    flight = null;
    if (completed && done.toStage) {
      /* Landed on the stage: it is the stage again, turning where the flight left it. */
      yaw = frozenYaw;
      elevation = ELEVATION_DEFAULT;
      zoom = zoomTarget = 1;
      frozenYaw = null;
      held = null;
      floorUniforms.uOpacity.value = 1;
      lastInteraction = performance.now();
    } else if (completed) {
      held = done.to;
      floorUniforms.uOpacity.value = 0;
    }
    done.resolve(completed);
  }

  /**
   * Fly the camera from one shot to another. See the public `fly` for the options.
   */
  function fly(options = {}) {
    if (disposed) return Promise.resolve(false);
    resize();
    const fromStage = options.from === "stage" || (options.from === "current" && !flight && !held) || options.from === undefined;
    const toStage = options.to === "stage";
    const fromShot = options.from === "stage" ? stageShot(yaw, elevation, zoom)
      : options.from === "current" || options.from === undefined ? currentShot()
      : normalizeShot(options.from);
    if (!fromShot) return Promise.resolve(false);

    /* The turn the stage holds for the flight. Leaving the stage, wherever it had turned to. Arriving
       at it, the photographed three-quarter view, taken the short way round from where the stage was,
       so the robot lands facing the lens the way Park always opens. */
    let yawAt = flight || held ? frozenYaw : yaw;
    if (toStage) {
      const turns = Math.round((yawAt - YAW_DEFAULT) / (2 * Math.PI));
      yawAt = YAW_DEFAULT + turns * 2 * Math.PI;
    }
    const target = typeof options.to === "function" ? options.to : null;
    let toShot = null;
    try {
      toShot = toStage ? stageShot(yawAt, ELEVATION_DEFAULT, 1) : normalizeShot(target ? target() : options.to);
    } catch (err) {
      console.error("park flight target failed", err);
    }
    if (!toShot) return Promise.resolve(false);

    if (flight) finishFlight(false);
    inertia = 0;
    spin = 0;
    resetAnim = null;
    samples = [];
    pinch = null;
    clearTimeout(wakeTimer);
    wakeTimer = 0;

    frozenYaw = yawAt;
    held = null;
    const duration = reduced ? 0 : Math.max(0, Number(options.duration) || 0);
    /* Leaving the stage the floor is all there; starting from another view's shot it is not there at
       all, because that view has its own ground; and picking up a flight that was cut short, it is
       wherever that flight had taken it. */
    const fromShotGiven = options.from !== "stage" && options.from !== "current" && options.from !== undefined;
    const floorFrom = fromStage ? 1 : fromShotGiven ? 0 : floorUniforms.uOpacity.value;
    return new Promise((resolve) => {
      flight = {
        from: fromShot,
        to: toShot,
        toStage,
        floor: [floorFrom, toStage ? 1 : 0],
        start: null,
        duration,
        onProgress: typeof options.onProgress === "function" ? options.onProgress : null,
        sync: typeof options.sync === "function" ? options.sync : null,
        target,
        resolve,
        shot: null,
      };
      if (!active) {
        /* Nothing is being drawn, so there is nothing to animate: land at once. */
        flight.shot = toShot;
        finishFlight(true);
        return;
      }
      requestRender();
    });
  }

  /* ---- input ---- */

  const pointers = new Map();   // pointerId -> { x, y }
  let samples = [];
  let pinch = null;
  const listeners = [];
  const listen = (type, fn, options) => {
    canvas.addEventListener(type, fn, options);
    listeners.push([type, fn, options]);
  };

  const radPerPx = () => DRAG_TURN / Math.max(1, Math.min(sized.w || 800, sized.h || 800));
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  /* The stage is not the viewer's to turn while the camera is flying or holding another view's shot. */
  const handsOff = () => Boolean(flight || held);

  /* Any touch stops everything that was moving on its own: the coast, the idle turn, a reset. The user
     has the stage now. */
  function takeHold() {
    lastInteraction = performance.now();
    inertia = 0;
    resetAnim = null;
    clearTimeout(wakeTimer);
    wakeTimer = 0;
  }

  const previousTouchAction = canvas.style.touchAction;
  const previousCursor = canvas.style.cursor;
  /* The browser would otherwise claim a touch drag as a scroll or a page zoom before it reached us. */
  canvas.style.touchAction = "none";
  canvas.style.cursor = "grab";

  listen("pointerdown", (e) => {
    if (handsOff()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (pointers.size >= 2) return;
    try {
      canvas.setPointerCapture(e.pointerId);
    } catch {
      /* A synthetic or already-finished pointer cannot be captured, and that costs nothing here. */
    }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    takeHold();
    if (pointers.size === 1) {
      samples = [{ t: e.timeStamp, x: e.clientX }];
    } else {
      pinch = { spread: spread(), zoom: zoomTarget };
      samples = [];
    }
    canvas.style.cursor = "grabbing";
    requestRender();
  });

  listen("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    lastInteraction = performance.now();

    if (pointers.size === 1) {
      const k = radPerPx();
      yaw += dx * k;
      elevation = clampElevation(elevation + dy * k * TILT_RATIO);
      samples.push({ t: e.timeStamp, x: e.clientX });
      /* Only the end of the drag is ever read, so the history is trimmed to a few windows' worth. */
      while (samples.length > 2 && e.timeStamp - samples[1].t > RELEASE_WINDOW_MS * 3) samples.shift();
    } else if (pinch) {
      zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (pinch.zoom * pinch.spread) / spread()));
    }
    requestRender();
  });

  function release(e, cancelled) {
    if (!pointers.has(e.pointerId)) return;
    const orbiting = pointers.size === 1;
    pointers.delete(e.pointerId);
    try {
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* Already released by the browser. */
    }

    if (orbiting && !cancelled) {
      samples.push({ t: e.timeStamp, x: e.clientX });
      /* Under reduced motion the stage stops where the finger left it. */
      inertia = reduced ? 0 : releaseVelocity(samples, radPerPx());
    }
    samples = [];
    pinch = null;
    if (pointers.size === 1) {
      /* One finger of a pinch lifted. The other carries on as a drag from where it is, with a fresh
         history, so the pinch's movement is not read as a flick. */
      const [rest] = pointers.values();
      samples = [{ t: e.timeStamp, x: rest.x }];
    }
    if (!pointers.size) canvas.style.cursor = "grab";
    lastInteraction = performance.now();
    requestRender();
  }

  listen("pointerup", (e) => release(e, false));
  listen("pointercancel", (e) => release(e, true));
  listen("lostpointercapture", (e) => release(e, true));

  listen("wheel", (e) => {
    e.preventDefault();
    if (handsOff()) return;
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * (sized.h || 800) : e.deltaY;
    /* Multiplicative, so each notch moves the camera the same proportion of its distance: zooming in
       close feels as controlled as zooming out. */
    zoomTarget = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoomTarget * Math.exp(px * 0.0012)));
    takeHold();
    requestRender();
  }, { passive: false });

  listen("dblclick", (e) => {
    e.preventDefault();
    resetView();
  });

  function resetView() {
    if (disposed || handsOff()) return;
    takeHold();
    spin = 0;
    /* Unwind the long way round the robot may have been turned, so a reset never spins it several times
       to get home. */
    const turns = Math.round((yaw - YAW_DEFAULT) / (2 * Math.PI));
    const home = YAW_DEFAULT + turns * 2 * Math.PI;
    if (reduced || !active) {
      yaw = home;
      elevation = ELEVATION_DEFAULT;
      zoom = zoomTarget = 1;
      requestRender();
      return;
    }
    resetAnim = {
      start: performance.now(),
      yaw: [yaw, home],
      elevation: [elevation, ELEVATION_DEFAULT],
      zoom: [zoom, 1],
    };
    requestRender();
  }

  /* ---- public surface ---- */

  const scratch = { point: new THREE.Vector3(), normal: new THREE.Vector3(), eye: new THREE.Vector3() };
  applyRobot({});

  return {
    /** The robot's dimensions in metres. Any field may be missing; see normalizeRobot. */
    setRobot(spec) {
      if (disposed) return;
      applyRobot(spec);
    },

    /** The team number on the bumpers. Anything bumperNumber() refuses prints none. */
    setTeamNumber(value) {
      if (disposed) return;
      model.setTeamNumber(value);
    },

    /** The robot's mechanism readings and hopper estimate (see robot3d.js setMechanisms). */
    setMechanisms(readings, hopperFill) {
      if (disposed) return;
      if (model.setMechanisms(readings, hopperFill)) requestRender();
    },

    /** "red" or "blue" colours the bumpers; anything else is a robot with no alliance yet. */
    setAlliance(alliance) {
      if (disposed) return;
      if (model.setAlliance(alliance, !reduced && active)) requestRender();
    },

    /** True while the view is on screen. False stops the loop entirely; nothing is drawn until true. */
    setActive(next) {
      if (disposed) return;
      next = Boolean(next);
      if (next === active) return;
      active = next;
      if (active) {
        /* Coming on screen counts as a fresh look: the idle turn waits its full delay from here. */
        lastInteraction = performance.now();
        spin = 0;
        asleep = true;
        resize();
        requestRender();
      } else {
        cancelAnimationFrame(raf);
        raf = 0;
        clearTimeout(wakeTimer);
        wakeTimer = 0;
        finishFlight(false);
        /* Off screen, a held shot has nothing left to hand over. The next time Park is shown it opens on
           the stage, turned the way it was left. */
        if (held) {
          held = null;
          frozenYaw = null;
          floorUniforms.uOpacity.value = 1;
        }
        inertia = 0;
        spin = 0;
        resetAnim = null;
        pointers.clear();
        samples = [];
        pinch = null;
        canvas.style.cursor = "grab";
        model.settle();
      }
    },

    /**
     * Fly the camera between the stage and a shot of the robot from another view, and resolve true when
     * it lands or false if something cut it short (another flight, setActive(false), dispose).
     *
     * `from` and `to` are each "stage" (the stage's own framing; arriving, the default three-quarter
     * view), "current" (whatever is on screen now, `from` only) or a shot `{ eye, look, fov, rect }`:
     * `eye` and `look` are [x, y, z] in the robot's frame (x front, y up, z right, floor under its
     * centre at the origin), `fov` is vertical degrees, and `rect` is the part of this canvas, in CSS
     * pixels, the shot fills. A shot taken from another canvas lands the robot exactly where that
     * canvas draws it when `rect` is that canvas's rectangle measured from this one's top-left corner.
     *
     * `to` may also be a function returning such a shot, read again on every frame: a destination that
     * keeps moving, like a field view whose camera follows a robot that is driving.
     *
     * `duration` is milliseconds (0, or reduced motion, lands at once). `sync(now)` runs first on every
     * frame of the flight, so the view being flown to can draw its own frame before its shot is read.
     * `onProgress(eased, raw, shot)` runs next, before the frame is drawn, for anything that has to move
     * with the flight.
     *
     * The floor fades out on the way to a shot and back in on the way to the stage. A landed shot is
     * held, with the stage out of the viewer's hands, until the next flight or setActive(false).
     */
    fly,

    /** Draw a frame now rather than on the next animation frame: the first frame of a flight that
     *  takes the robot over from another view has to be on screen before that view hides its own. */
    renderNow() {
      if (!active || disposed) return;
      resize();
      if (!sized.w || !sized.h) return;
      const now = performance.now();
      step(0, now);
      draw();
      lastFrame = now;
    },

    /**
     * Do the stage's one-off GPU work now, while nothing is watching: render the studio reflections and
     * compile every shader the stage uses. Otherwise both happen on the first frame Park is shown, which
     * is the first frame of a flight, and the robot hitches as it takes off. Safe to call more than once.
     */
    prepare() {
      if (disposed) return;
      if (!environment) {
        environment = studioEnvironment(renderer);
        model.setEnvironment(environment.texture);
      }
      placeCamera();
      renderer.compile(scene, camera);
    },

    /** True while a flight is under way or a landed shot is being held. */
    get flying() {
      return Boolean(flight || held);
    },

    /**
     * Where the callout targets are on the canvas right now, in CSS pixels from its top-left corner.
     *
     * battery: the outer top edge of the battery. drivetrain: the top of the first module's housing
     * (front-left by WPILib's order). bumper: the middle of the front bumper. top: the top of the
     * superstructure. controller: the top of the controller on the belly pan. `visible` is false when
     * the point is off the canvas or its surface has turned away from the camera, so a callout can
     * step aside rather than point through the robot.
     */
    anchors() {
      const none = () =>
        Object.fromEntries(["battery", "drivetrain", "bumper", "top", "controller"].map((name) => [name, { x: 0, y: 0, visible: false }]));
      if (disposed || !anchorDefs) return none();
      resize();
      if (!sized.w || !sized.h) return none();
      placeCamera();
      const out = {};
      for (const [name, def] of Object.entries(anchorDefs)) {
        const point = scratch.point.copy(def.point).applyMatrix4(model.root.matrixWorld);
        const normal = scratch.normal.copy(def.normal).transformDirection(model.root.matrixWorld);
        const facing = normal.dot(scratch.eye.copy(camera.position).sub(point).normalize());
        point.project(camera);
        const x = ((point.x + 1) / 2) * sized.w;
        const y = ((1 - point.y) / 2) * sized.h;
        out[name] = {
          x,
          y,
          visible: point.z > -1 && point.z < 1 && x >= 0 && x <= sized.w && y >= 0 && y <= sized.h && facing > FACING_MIN,
        };
      }
      return out;
    },

    /**
     * The robot's extent on the canvas right now, in CSS pixels from its top-left corner: the rectangle
     * the corners of the model's box project into. Callouts are set out beside it. Null while there is
     * nothing to measure.
     */
    bounds() {
      const box = model.box;
      if (disposed || !box || box.isEmpty()) return null;
      resize();
      if (!sized.w || !sized.h) return null;
      placeCamera();
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      const { min, max } = box;
      for (let i = 0; i < 8; i++) {
        const p = scratch.point
          .set(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z)
          .applyMatrix4(model.root.matrixWorld)
          .project(camera);
        const x = ((p.x + 1) / 2) * sized.w;
        const y = ((1 - p.y) / 2) * sized.h;
        left = Math.min(left, x);
        right = Math.max(right, x);
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
      return { left, top, right, bottom };
    },

    /** Ease the camera back to the default three-quarter view. */
    resetView,

    /** Run `fn` after every drawn frame. Returns a function that unsubscribes it. */
    onFrame(fn) {
      if (typeof fn !== "function" || disposed) return () => {};
      frameListeners.add(fn);
      return () => frameListeners.delete(fn);
    },

    dispose() {
      if (disposed) return;
      finishFlight(false);
      disposed = true;
      active = false;
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(wakeTimer);
      observer.disconnect();
      for (const [type, fn, options] of listeners) canvas.removeEventListener(type, fn, options);
      for (const id of pointers.keys()) {
        try {
          canvas.releasePointerCapture(id);
        } catch {
          /* Already gone. */
        }
      }
      pointers.clear();
      frameListeners.clear();
      canvas.style.touchAction = previousTouchAction;
      canvas.style.cursor = previousCursor;
      model.dispose();
      for (const thing of owned) thing.dispose();
      environment?.dispose();
      renderer.dispose();
      /* Release the GL context outright, as the field does: browsers cap how many a page may hold. */
      renderer.forceContextLoss?.();
    },
  };
}

/* A shot as a caller handed it over, checked: arrays of three finite numbers, a sane field of view, a
   rectangle with some size. Anything else is refused rather than flown to. */
function normalizeShot(shot) {
  if (!shot || typeof shot !== "object") return null;
  const vec = (v) => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? [v[0], v[1], v[2]] : null);
  const eye = vec(shot.eye);
  const look = vec(shot.look);
  const r = shot.rect;
  if (!eye || !look || !(shot.fov > 1 && shot.fov < 179) || !r) return null;
  if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || !(r.w > 0) || !(r.h > 0)) return null;
  if (Math.hypot(eye[0] - look[0], eye[1] - look[1], eye[2] - look[2]) < 1e-3) return null;
  return { eye, look, fov: shot.fov, rect: { x: r.x, y: r.y, w: r.w, h: r.h } };
}
